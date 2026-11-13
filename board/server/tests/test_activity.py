import json
import os

import pytest

from teamster_board.activity import EventTail, TAIL_BYTES


@pytest.mark.parametrize("event_type", ["item.started", "item.completed"])
@pytest.mark.parametrize("item,kind,text", [
    ({"type": "command_execution", "command": "python3\n check.py"}, "command", "python3 check.py"),
    ({"type": "file_change", "changes": [{"path": "src/main.py", "kind": "update"}]}, "edit", "src/main.py"),
    ({"type": "agent_message", "text": "A" * 250}, "message", "A" * 200),
    ({"type": "reasoning", "text": "Checking\n the state"}, "thinking", "Checking the state"),
    ({"type": "collab_tool_call", "tool": "spawn_agent", "prompt": "Inspect tests"}, "tool", "spawn_agent Inspect tests"),
])
def test_codex_activity(tmp_path, event_type, item, kind, text):
    path = tmp_path / "events.jsonl"
    path.write_text(json.dumps({"type": event_type, "item": item, "timestamp": 123.5}) + "\n")
    assert EventTail(path).read() == {"at": 123.5, "kind": kind, "text": text}


@pytest.mark.parametrize("block,kind,text", [
    ({"type": "tool_use", "name": "Bash", "input": {"command": "git\n status"}}, "command", "git status"),
    ({"type": "tool_use", "name": "Edit", "input": {"file_path": "a.py"}}, "edit", "a.py"),
    ({"type": "tool_use", "name": "Write", "input": {"file_path": "b.py"}}, "edit", "b.py"),
    ({"type": "tool_use", "name": "Read", "input": {"file_path": "c.py"}}, "tool", "Read"),
    ({"type": "text", "text": "Ready\n for review"}, "message", "Ready for review"),
    ({"type": "thinking", "thinking": "Consider\n the result"}, "thinking", "Consider the result"),
])
def test_claude_activity(tmp_path, block, kind, text):
    path = tmp_path / "claude-events.jsonl"
    path.write_text(json.dumps({"type": "assistant", "message": {"content": [block]},
                               "timestamp": "1970-01-01T00:02:03.500Z"}) + "\n")
    assert EventTail(path).read() == {"at": 123.5, "kind": kind, "text": text}


def test_incremental_tail_ignores_bad_json_and_defers_partial_line(tmp_path, monkeypatch):
    path = tmp_path / "events.jsonl"
    first = json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "First"}}).encode() + b"\n"
    second = json.dumps({"type": "item.completed", "item": {"type": "reasoning", "text": "Second"}}).encode() + b"\n"
    path.write_bytes(b"x" * (450 * 1024) + b"\n" + first + b"{broken json}\n" + second[:30])
    os.utime(path, (100, 100))
    tail = EventTail(path)
    assert tail.read() == {"at": 100.0, "kind": "message", "text": "First"}
    old_offset = tail.offset
    assert old_offset == path.stat().st_size
    assert tail.read() is None

    # The old prefix must never be decoded again after the file grows.
    parsed = []
    original_loads = json.loads

    def capture_loads(value):
        parsed.append(value)
        return original_loads(value)

    monkeypatch.setattr("teamster_board.activity.json.loads", capture_loads)
    with path.open("ab") as stream:
        stream.write(second[30:])
    os.utime(path, (200, 200))
    assert tail.read() == {"at": 200.0, "kind": "thinking", "text": "Second"}
    assert parsed == [second.rstrip(b"\n")]
    assert tail.offset - old_offset == len(second) - 30
    assert tail.read() is None


def test_tail_bounds_initial_read_and_resets_after_replacement_and_truncation(tmp_path, monkeypatch):
    path = tmp_path / "events.jsonl"
    event = json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "Latest"}}).encode() + b"\n"
    path.write_bytes(b"z" * (TAIL_BYTES * 2) + b"\n" + event)
    tail = EventTail(path)
    reads = []
    original_fdopen = __import__("os").fdopen

    class TrackedStream:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.stream.close()

        def __getattr__(self, name):
            return getattr(self.stream, name)

        def read(self, count):
            start = self.stream.tell()
            data = self.stream.read(count)
            reads.append((start, len(data)))
            return data

    monkeypatch.setattr("teamster_board.activity.os.fdopen", lambda *args: TrackedStream(original_fdopen(*args)))
    assert tail.read()["text"] == "Latest"
    assert reads == [(path.stat().st_size - TAIL_BYTES, TAIL_BYTES)]
    path.write_bytes(event)
    assert tail.read()["text"] == "Latest"
    replacement = tmp_path / "replacement"
    replacement.write_bytes(event.replace(b"Latest", b"Replaced"))
    replacement.replace(path)
    assert tail.read()["text"] == "Replaced"
    missing = EventTail(tmp_path / "missing.jsonl")
    assert missing.read() is None


@pytest.mark.parametrize("executor", ["codex", "claude"])
def test_message_summary_and_file_timestamp_fallback(tmp_path, executor):
    path = tmp_path / ("events.jsonl" if executor == "codex" else "claude-events.jsonl")
    summary = "Finished\n" + "x" * 250
    message = json.dumps({"status": "done", "summary": summary})
    if executor == "codex":
        event = {"type": "item.completed", "item": {"type": "agent_message", "text": message}}
    else:
        event = {"type": "assistant", "message": {"content": [{"type": "text", "text": message}]}}
    line = json.dumps(event) + "\n"
    path.write_text(line)
    os.utime(path, (123, 123))
    tail = EventTail(path)
    expected_text = ("Finished " + "x" * 250)[:200]
    assert tail.read() == {"at": 123.0, "kind": "message", "text": expected_text}
    assert tail.read() is None
    with path.open("a") as stream:
        stream.write(line)
    os.utime(path, (456, 456))
    assert tail.read() == {"at": 456.0, "kind": "message", "text": expected_text}
    event["timestamp"] = 0
    with path.open("a") as stream:
        stream.write(json.dumps(event) + "\n")
    os.utime(path, (789, 789))
    assert tail.read() == {"at": 0.0, "kind": "message", "text": expected_text}


def test_feed_preserves_each_block_details_and_limits():
    from teamster_board.activity import feed_items

    content = [
        {"type": "text", "text": "  First\n\nparagraph  "},
        {"type": "text", "text": json.dumps({"summary": "  Summary\nline  "})},
        {"type": "thinking", "thinking": " " + "x" * 4001 + " "},
        {"type": "text", "text": " \n "},
        {"type": "tool_use", "name": "Bash", "input": {"command": "git\n " + "x" * 600}},
        {"type": "tool_use", "name": "Edit", "input": {"file_path": "a" * 600}},
        {"type": "tool_use", "name": "Read", "input": {"file_path": "src/main.py"}},
        {"type": "tool_use", "name": "Grep", "input": {"pattern": "find\n me"}},
        {"type": "tool_use", "name": "Glob", "input": {"pattern": "**/*.py"}},
        {"type": "tool_use", "name": "Agent", "input": {"description": "Check\n tests"}},
        {"type": "tool_use", "name": "Task", "input": {"description": "x" * 300}},
    ]
    items = feed_items({"type": "assistant", "timestamp": 123,
                        "message": {"content": content}})
    assert [item["kind"] for item in items] == [
        "message", "message", "thinking", "command", "edit", "tool", "tool", "tool", "tool", "tool"]
    assert [item["text"] for item in items] == [
        "First\n\nparagraph", "Summary\nline", "x" * 3999 + "…", ("git " + "x" * 600)[:500],
        "a" * 500, "Read src/main.py", "Grep find me", "Glob **/*.py", "Agent Check tests",
        "Task " + "x" * 195]
    assert all(item["at"] == 123 for item in items)
    assert feed_items({"type": "item.completed", "timestamp": 10 ** 400,
                       "item": {"type": "agent_message", "text": "Large timestamp"}})[0]["at"] is None
    for item, kind, text in [
        ({"type": "command_execution", "command": "python\n check.py"}, "command", "python check.py"),
        ({"type": "file_change", "changes": [{"path": "a.py"}, {"path": "b.py"}]}, "edit", "a.py, b.py"),
        ({"type": "agent_message", "text": "Hello\n there"}, "message", "Hello\n there"),
        ({"type": "reasoning", "text": "Thinking\n through"}, "thinking", "Thinking\n through"),
        ({"type": "collab_tool_call", "tool": "spawn_agent", "prompt": "Check\n tests"}, "tool", "spawn_agent Check tests"),
    ]:
        assert feed_items({"type": "item.completed", "item": item, "at": 12}) == [
            {"at": 12, "kind": kind, "text": text}]


def test_feed_cursor_merge_partial_lines_and_timestamp_carry(tmp_path):
    from teamster_board.activity import task_feed

    def event(text, at=None):
        value = {"type": "item.completed", "item": {"type": "agent_message", "text": text}}
        if at is not None:
            value["timestamp"] = at
        return json.dumps(value).encode() + b"\n"

    codex, claude = tmp_path / "events.jsonl", tmp_path / "claude-events.jsonl"
    codex.write_bytes(event("fallback") + event("later", 20) + event("earlier", 10))
    os.utime(codex, (5, 5))
    claude.write_text(json.dumps({"type": "assistant", "timestamp": 15,
                                  "message": {"content": [{"type": "text", "text": "other"},
                                                           {"type": "thinking", "thinking": "same event"}]}}) + "\n")
    paths = {"events.jsonl": codex, "claude-events.jsonl": claude}
    first = task_feed(paths, "task")
    assert [(item["at"], item["text"]) for item in first["items"]] == [
        (5, "fallback"), (15, "other"), (15, "same event"), (20, "later"), (10, "earlier")]
    assert first["reset"] is False and first["truncated"] is False
    assert task_feed(paths, "task", first["cursor"])["items"] == []
    pending = event("continued")
    with codex.open("ab") as stream:
        stream.write(b"broken json\n" + pending[:-1])
    partial = task_feed(paths, "task", first["cursor"])
    assert partial["items"] == [] and partial["reset"] is False
    assert task_feed(paths, "task", partial["cursor"])["items"] == []
    with codex.open("ab") as stream:
        stream.write(b"\n" + event("next", 30))
    os.utime(codex, (99, 99))
    completed = task_feed(paths, "task", partial["cursor"])
    assert [(item["at"], item["text"]) for item in completed["items"]] == [(10, "continued"), (30, "next")]
    assert task_feed(paths, "task", completed["cursor"])["items"] == []


def test_feed_resets_replaced_truncated_rewritten_and_invalid_cursor(tmp_path):
    from teamster_board.activity import task_feed

    def content(text):
        return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n"

    path = tmp_path / "events.jsonl"
    path.write_text(content("First") + content("Other"))
    paths = {"events.jsonl": path}
    previous = task_feed(paths, "task")
    path.write_text(content("Short"))
    truncated = task_feed(paths, "task", previous["cursor"])
    assert truncated["reset"] is True
    assert [item["text"] for item in truncated["items"]] == ["Short"]
    path.write_text(content("Equal"))
    rewritten = task_feed(paths, "task", truncated["cursor"])
    assert rewritten["reset"] is True
    assert [item["text"] for item in rewritten["items"]] == ["Equal"]
    replacement = tmp_path / "replacement"
    replacement.write_text(content("Replaced"))
    replacement.replace(path)
    replaced = task_feed(paths, "task", rewritten["cursor"])
    assert replaced["reset"] is True
    assert [item["text"] for item in replaced["items"]] == ["Replaced"]
    for cursor in ("invalid", "e30=", "W10=", task_feed(paths, "other")["cursor"]):
        reset = task_feed(paths, "task", cursor)
        assert reset["reset"] is True and reset["items"] == replaced["items"]


def test_feed_initial_tail_item_limit_and_bounded_increment(tmp_path, monkeypatch):
    from teamster_board.activity import task_feed

    path = tmp_path / "events.jsonl"
    def content(index):
        return json.dumps({"type": "item.completed", "timestamp": index,
                           "item": {"type": "agent_message", "text": str(index) + "x" * 600}}).encode() + b"\n"
    path.write_bytes(b"".join(content(index) for index in range(1000)))
    reads = []
    original_fdopen = os.fdopen

    class TrackedStream:
        def __init__(self, stream):
            self.stream = stream
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.stream.close()
        def __getattr__(self, name):
            return getattr(self.stream, name)
        def read(self, count):
            data = self.stream.read(count)
            reads.append(len(data))
            return data

    monkeypatch.setattr("teamster_board.activity.os.fdopen", lambda *args: TrackedStream(original_fdopen(*args)))
    first = task_feed({"events.jsonl": path}, "task")
    assert first["truncated"] is True and first["reset"] is False
    assert len(first["items"]) <= 400 and first["items"][-1]["at"] == 999
    assert sum(reads) <= TAIL_BYTES
    reads.clear()
    with path.open("ab") as stream:
        stream.write(b"".join(content(index) for index in range(1000, 2000)))
    cursor, found = first["cursor"], []
    for _ in range(4):
        reads.clear()
        result = task_feed({"events.jsonl": path}, "task", cursor)
        assert sum(reads) <= TAIL_BYTES
        assert result["reset"] is False
        found.extend(item["at"] for item in result["items"])
        cursor = result["cursor"]
    assert found == list(range(1000, 2000))
    path.write_bytes(b"".join(json.dumps({"type": "item.completed", "timestamp": index,
                                        "item": {"type": "agent_message", "text": str(index)}}).encode() + b"\n"
                               for index in range(450)))
    capped = task_feed({"events.jsonl": path}, "task")
    assert capped["truncated"] is True
    assert [item["at"] for item in capped["items"]] == list(range(50, 450))



def test_feed_reset_validates_both_sources_before_reading_tails(tmp_path, monkeypatch):
    from teamster_board.activity import task_feed

    def row(text):
        return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}).encode() + b"\n"

    codex, claude = tmp_path / "events.jsonl", tmp_path / "claude-events.jsonl"
    codex.write_bytes(row("first"))
    claude.write_bytes(row("other"))
    paths = {"events.jsonl": codex, "claude-events.jsonl": claude}
    previous = task_feed(paths, "task")
    with codex.open("ab") as stream:
        stream.write(b"".join(row(str(index) + "x" * 600) for index in range(1000)))
    replacement = tmp_path / "replacement"
    replacement.write_bytes(row("replaced"))
    replacement.replace(claude)
    reads = []
    original_fdopen = os.fdopen

    class TrackedStream:
        def __init__(self, stream):
            self.stream = stream
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.stream.close()
        def __getattr__(self, name):
            return getattr(self.stream, name)
        def read(self, count):
            data = self.stream.read(count)
            reads.append((os.fstat(self.stream.fileno()).st_ino, len(data)))
            return data

    monkeypatch.setattr("teamster_board.activity.os.fdopen", lambda *args: TrackedStream(original_fdopen(*args)))
    reset = task_feed(paths, "task", previous["cursor"])
    assert reset["reset"] is True and reset["truncated"] is True
    for path in (codex, claude):
        assert sum(count for inode, count in reads if inode == path.stat().st_ino) <= TAIL_BYTES
