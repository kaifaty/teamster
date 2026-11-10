import json
import os
import subprocess
import time
from pathlib import Path

import pytest

from teamster_board.store import Store, alive, phase


@pytest.fixture
def pids():
    running = subprocess.Popen(["sleep", "60"])
    finished = subprocess.Popen(["sleep", "0"])
    finished.wait(timeout=5)
    try:
        yield running.pid, finished.pid
    finally:
        running.terminate()
        running.wait(timeout=5)


def write_state(tasks, slug="task", **fields):
    directory = tasks / slug
    directory.mkdir(parents=True, exist_ok=True)
    state = {"slug": slug, "kind": "work", "repo": "/tmp/project", "executor": "codex",
             "account": "main", "outcome": "running", "turns": 2, "created": 10,
             "turn_started": 20, **fields}
    (directory / "state.json").write_text(json.dumps(state))
    return directory


@pytest.mark.parametrize("state,expected", [
    ({"outcome": "running"}, ("turn", 20.0)),
    ({"outcome": "completed", "check_pid": 123}, ("check", None)),
    ({"kind": "review", "reviews": [{"started": 30, "finished": None}]}, ("review", 30.0)),
    ({"rounds": [{}], "outcome": "running"}, ("fix", None)),
    ({"ci": {"outcome": "pending"}}, ("ci", None)),
    ({"outcome": "sleeping", "rotations": [{"event": "sleep", "at": 40}]}, ("sleeping", 40.0)),
    ({"outcome": "completed", "turn_finished": 50}, ("idle", 50.0)),
])
def test_each_phase(state, expected):
    assert phase(dict(turn_started=20, **state), True) == expected
    assert phase(state, False)[0] == "idle"


def test_phase_priorities_and_ci_repair():
    assert phase({"kind": "review", "reviews": 5}, True) == ("review", None)
    assert phase({"kind": "review", "reviews": [{"started": 1}, None]}, True) == ("review", None)
    assert phase({"outcome": "running", "ci": {"outcome": "failed", "rounds": "1"}}, True)[0] == "turn"
    assert phase({"outcome": "running", "ci": {"outcome": "failed", "rounds": 1}}, True)[0] == "fix"
    assert phase({"outcome": "running", "kind": "review", "rounds": [{}]}, True)[0] == "review"
    assert phase({"outcome": "completed", "kind": "review", "check_pid": 1}, True)[0] == "check"
    assert phase({"outcome": "sleeping", "kind": "review", "ci": {"outcome": "pending"}}, True)[0] == "sleeping"


def test_each_column_and_actual_supervisor_liveness(tmp_path, pids):
    live, dead = pids
    tasks = tmp_path / "claude-tasks"
    write_state(tasks, "running", pid=live)
    write_state(tasks, "sleeping", pid=live, outcome="sleeping", sleeping={"until": 100})
    write_state(tasks, "review", pid=dead, outcome="completed", result={"status": "done"})
    write_state(tasks, "attention", pid=dead)
    write_state(tasks / ".archive", "old-123", pid=live, outcome="completed", result={"status": "done"})
    store = Store(tasks)
    store.poll()
    rows = {task["slug"]: task for task in store.summaries()}
    assert {slug: row["column"] for slug, row in rows.items()} == {
        "running": "running", "sleeping": "sleeping", "review": "review_me",
        "attention": "attention", "old-123": "closed"}
    assert rows["running"]["alive"] is True
    assert rows["attention"]["alive"] is False
    assert rows["old-123"]["alive"] is True
    assert rows["sleeping"]["sleeping_until"] == 100.0


@pytest.mark.parametrize("outcome,status", [
    ("sleeping", "done"), ("failed", "done"), ("stopped", "done"),
    ("budget_exhausted", "done"), ("conflict", "done"), ("completed", "partial"),
    ("completed", "needs_decision"), ("completed", "blocked"),
])
def test_dead_tasks_needing_attention(tmp_path, outcome, status):
    write_state(tmp_path, outcome=outcome, result={"status": status})
    store = Store(tmp_path)
    store.poll()
    assert store.summaries()[0]["column"] == "attention"


def test_permission_error_means_alive(monkeypatch):
    def denied(pid, signal):
        assert (pid, signal) == (123, 0)
        raise PermissionError
    monkeypatch.setattr(os, "kill", denied)
    assert alive(123) is True
    assert alive(None) is False
    assert alive(0) is False


def test_bad_state_preserves_cache_then_recovers(tmp_path, monkeypatch):
    directory = write_state(tmp_path, result={"status": "done", "summary": "first line\nsecond"})
    store = Store(tmp_path)
    assert len(store.poll()) == 1
    original = store.summaries()
    state_path = directory / "state.json"
    original_read = Path.read_text
    def no_state_read(path, *args, **kwargs):
        assert path != state_path, "unchanged state should not be read again"
        return original_read(path, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Path, "read_text", no_state_read)
        assert store.poll() == []
    state_path.write_text('{"outcome":')
    assert store.poll() == []
    assert store.summaries() == original
    write_state(tmp_path, outcome="completed", result={"status": "done", "summary": "new"})
    assert store.poll()[0]["task"]["summary"] == "new"


def test_archive_cap_and_removed_message(tmp_path):
    live = write_state(tmp_path)
    for i in range(55):
        directory = write_state(tmp_path / ".archive", f"old-{i:02}")
        os.utime(directory / "state.json", (100 + i, 100 + i))
    store = Store(tmp_path)
    store.poll()
    assert len(store.summaries()) == 51
    newest = write_state(tmp_path / ".archive", "newest-20261105T120000Z")
    os.utime(newest / "state.json", (1, 1))
    store.poll()
    assert len(store.summaries()) == 51
    assert store.detail("newest-20261105T120000Z")["column"] == "closed"
    assert "newest-20261105T120000Z" not in {task["slug"] for task in store.summaries()}
    assert "old-05" in {task["slug"] for task in store.summaries()}
    assert "old-00" not in {task["slug"] for task in store.summaries()}
    old = tmp_path / ".archive" / "old-00"
    (old / "brief.md").write_text("Archived brief")
    assert store.detail("old-00")["column"] == "closed"
    assert store.detail("old-00")["files"] == ["brief"]
    assert store.file_path("old-00", "brief") == old / "brief.md"
    assert len(store.summaries()) == 51
    assert store.detail("old-54")["slug"] == "old-54"
    assert store.detail("old-54")["column"] == "closed"
    (live / "state.json").unlink()
    live.rmdir()
    assert store.poll() == [{"type": "task_removed", "slug": "task"}]


def test_details_and_file_allowlist(tmp_path):
    directory = write_state(tmp_path, executor="claude", claude_account="pool", task_model="opus",
                            reasoning_effort="high", publish={"pr": "https://example.test/pr/1"},
                            result={"summary": "First line\n\nWhy this change was needed.\n"},
                            rounds=[{}], ci={"outcome": "failed", "rounds": 2}, checks=[{"at": i, "outcome": "passed", "cmd": "x" * 250}
                                               for i in range(250)])
    write_state(tmp_path, "empty")
    for size in (8000, 8001):
        write_state(tmp_path, f"long-{size}", result={"summary": "x" * size})
    (directory / "brief.md").write_text("brief")
    (directory / "last.md").write_text("last")
    (directory / "auth.json").write_text("must never be read")
    (directory / "review.md").symlink_to(directory / "auth.json")
    (tmp_path / "escape").symlink_to(directory, target_is_directory=True)
    store = Store(tmp_path)
    store.poll()
    detail = store.detail("task")
    assert detail["files"] == ["brief", "last"]
    assert len(detail["timeline"]) == 200
    assert all(len(entry["text"]) <= 200 and "\n" not in entry["text"] for entry in detail["timeline"])
    assert detail["account"] == "pool"
    assert detail["model"] == "opus"
    assert detail["effort"] == "high"
    assert detail["repo"] == "project"
    assert detail["fix_round"] == 3
    assert detail["pr"] == "https://example.test/pr/1"
    assert detail["report"] == "First line\n\nWhy this change was needed.\n"
    summary = next(row for row in store.summaries() if row["slug"] == "task")
    assert detail["summary"] == summary["summary"] == "First line"
    assert detail["changes"] is None
    assert store.detail("empty")["report"] is None
    assert store.detail("long-8000")["report"] == "x" * 8000
    assert store.detail("long-8001")["report"] == "x" * 7999 + "…"
    assert store.detail("escape") is None
    assert store.detail("unknown") is None
    for name in ("../state.json", "state.json", "auth.json", "review", "missing"):
        assert store.file_path("task", name) is None
    assert store.file_path("task", "brief") == directory / "brief.md"


def test_detail_branch_changes(tmp_path, monkeypatch):
    def git(*args):
        return subprocess.run(
            ["git", "-c", "user.name=Test", "-c", "user.email=test@example.test",
             "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
            cwd=tmp_path, stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=5,
        )

    repo, worktree, tasks = tmp_path / "repository", tmp_path / "branch", tmp_path / "tasks"
    git("init", "--quiet", str(repo))
    (repo / "modified.txt").write_text("before\nremoved\n")
    git("-C", str(repo), "add", ".")
    git("-C", str(repo), "commit", "--quiet", "-m", "Base")
    git("-C", str(repo), "branch", "base")
    git("-C", str(repo), "worktree", "add", "--quiet", "-b", "task", str(worktree), "base")
    (worktree / "modified.txt").write_text("after\n")
    (worktree / "added.txt").write_text("new\n")
    git("-C", str(worktree), "add", ".")
    git("-C", str(worktree), "commit", "--quiet", "-m", "Change files")
    (worktree / "pending.txt").write_text("pending\n")
    write_state(tasks, worktree=str(worktree), base="base")
    write_state(tasks, "unchanged", worktree=str(repo), base="base")
    write_state(tasks, "missing", repo=str(repo), worktree=str(tmp_path / "gone"), base="base")
    write_state(tasks, "not-git", worktree=str(tmp_path), base="base")
    write_state(tasks, "unknown-base", worktree=str(worktree), base="missing-ref")
    store = Store(tasks)
    store.poll()
    assert store.detail("task")["changes"] == {
        "commits": 1, "files": 2, "insertions": 2, "deletions": 2, "uncommitted": 1}
    assert store.detail("unchanged")["changes"] == {
        "commits": 0, "files": 0, "insertions": 0, "deletions": 0, "uncommitted": 0}
    for slug in ("missing", "not-git", "unknown-base"):
        assert store.detail(slug)["changes"] is None

    def no_git(*args, **kwargs):
        pytest.fail("Invalid base refs must not start git")

    monkeypatch.setattr(subprocess, "run", no_git)
    for base in ("-base", "base name", "base..HEAD"):
        write_state(tasks, worktree=str(worktree), base=base)
        store.poll()
        assert store.detail("task")["changes"] is None


def test_detail_limits_from_state_and_invalid_fields(tmp_path):
    rotations = [{"at": at, "from": "a\n b", "to": "x" * 250, "reason": "quota\n reached"}
                 for at in reversed(range(25))]
    rotations += [None, {"at": True}, {"at": float("inf")}, {"at": "30"}, {"reason": "missing at"}]
    write_state(tmp_path, "full", max_turn_minutes=90, weekly_used_percent=4.5,
                max_task_weekly_percent=20, fix_rounds=2, rounds=[{}, {}], ci_rounds=3,
                ci_enabled=True, review_angles=["correctness", "tests"], check="uv run\n pytest",
                rotations=rotations)
    write_state(tmp_path, "old")
    write_state(tmp_path, "broken", max_turn_minutes=True, weekly_used_percent=float("nan"),
                max_task_weekly_percent="20", fix_rounds=False, rounds=None, ci_rounds=float("inf"),
                ci_enabled="yes", ci_command=7, review_angles=["tests", None], check=[], rotations=5)
    store = Store(tmp_path)
    store.poll()
    assert store.detail("full")["limits"] == {
        "max_turn_minutes": 90, "weekly_used_percent": 4.5, "max_weekly_percent": 20,
        "fix_rounds": 2, "review_rounds": 2, "ci_rounds": 3, "ci_enabled": True,
        "review_angles": ["correctness", "tests"], "check": "uv run pytest",
        "rotations": [{"at": at, "from": "a b", "to": "x" * 200, "reason": "quota reached"}
                      for at in range(5, 25)],
    }
    empty = {"max_turn_minutes": None, "weekly_used_percent": None, "max_weekly_percent": None,
             "fix_rounds": None, "review_rounds": 0, "ci_rounds": None, "ci_enabled": False,
             "review_angles": [], "check": None, "rotations": []}
    assert store.detail("old")["limits"] == store.detail("broken")["limits"] == empty
    write_state(tmp_path, "command", ci_enabled=False, ci_command="make ci", review_angles="auto",
                check="c" * 250, rotations=[{"at": 2, "from": False, "to": {}, "reason": " "}])
    store.poll()
    assert store.detail("command")["limits"] == {
        **empty, "ci_enabled": True, "check": "c" * 200,
        "rotations": [{"at": 2, "from": None, "to": None, "reason": None}],
    }


@pytest.mark.parametrize("archived", [False, True])
def test_detail_messages_sources_invalid_rows_and_limit(tmp_path, archived):
    root = tmp_path / ".archive" if archived else tmp_path
    slug = "task-20261110T000000Z" if archived else "task"
    directory = write_state(root, slug)
    store = Store(tmp_path)
    store.poll()
    assert store.detail(slug)["messages"] == []
    sources = ["lead", "review", "ci", "claude", None, "other"]
    rows = [{"at": at, "source": sources[at % len(sources)], "text": "t" * 4100,
             **({"queued_at": at - 0.5} if at % 2 else {"queued_at": "bad"} if at % 4 else {})}
            for at in reversed(range(60))]
    rows += [[], None, {"text": "missing at"}, {"at": "61", "text": "bad at"},
             {"at": True, "text": "bool"}, {"at": float("nan"), "text": "nan"},
             {"at": float("inf"), "text": "inf"}, {"at": 61}, {"at": 62, "text": []}]
    path = directory / "messages.jsonl"
    path.write_text("{bad json}\n" + "".join(json.dumps(row) + "\n" for row in rows))
    expected = [
        {"at": at, "source": sources[at % 6] if sources[at % 6] in ("review", "ci") else "lead",
         "text": "t" * 4000, "queued_at": at - 0.5 if at % 2 else None} for at in range(10, 60)
    ]
    assert store.detail(slug)["messages"] == expected
    path.write_bytes(b'{"at": 1001, "text": "before tail"}\n' + b" " * (256 * 1024)
                     + b'{"at": 1000, "text": "cut first line"}\n' + path.read_bytes())
    assert store.detail(slug)["messages"] == expected
    path.write_text('{"at": 1, "text": ""}\n')
    assert store.detail(slug)["messages"] == [{"at": 1, "source": "lead", "text": "", "queued_at": None}]
    outside = tmp_path / "private.jsonl"
    path.rename(outside)
    path.symlink_to(outside)
    assert store.detail(slug)["messages"] == []


def test_detail_queue_waiting_dropped_and_broken_files(tmp_path):
    directory = write_state(tmp_path, "task")
    store = Store(tmp_path)
    store.poll()
    empty = {"waiting": [], "dropped": []}
    assert store.detail("task")["queue"] == empty
    path = directory / "queue.json"
    for broken in ("{bad json", "[]", '{"waiting": {}, "dropped": 3}'):
        path.write_text(broken)
        assert store.detail("task")["queue"] == empty
    path.write_text(json.dumps({
        "waiting": [{"at": 5, "text": "Then merge main", "options": {"effort": "low"}},
                    {"at": True, "text": "bool"}, {"at": 6}, None],
        "dropped": [{"at": 1, "text": "x" * 4100, "options": {}, "dropped_at": 3, "outcome": "stopped"},
                    {"at": 2, "text": "no outcome"}],
    }))
    assert store.detail("task")["queue"] == {
        "waiting": [{"at": 5, "text": "Then merge main"}],
        "dropped": [{"at": 1, "text": "x" * 4000, "dropped_at": 3, "outcome": "stopped"},
                    {"at": 2, "text": "no outcome", "dropped_at": None, "outcome": None}],
    }
    path.write_text(json.dumps({"waiting": [{"at": 7, "text": "Only waiting"}]}))
    assert store.detail("task")["queue"] == {"waiting": [{"at": 7, "text": "Only waiting"}], "dropped": []}


def test_detail_activity_log_retains_all_new_lines_across_polls(tmp_path, pids):
    directory = write_state(tmp_path, pid=pids[0])
    codex = directory / "events.jsonl"
    claude = directory / "claude-events.jsonl"
    store = Store(tmp_path)
    for batch in (range(1, 5), range(5, 15)):
        for at in batch:
            path = codex if at % 2 else claude
            event = ({"type": "item.completed", "item": {"type": "agent_message", "text": str(at)}}
                     if at % 2 else {"type": "assistant", "message": {"content": [{"type": "text", "text": str(at)}]}})
            with path.open("a") as stream:
                stream.write(json.dumps({**event, "timestamp": at}) + "\n")
        messages = store.poll()
        latest = {"at": batch[-1], "kind": "message", "text": str(batch[-1])}
        assert store.detail("task")["activity"] == latest
        assert [m for m in messages if m["type"] == "activity"] == [
            {"type": "activity", "slug": "task", "activity": latest}]
        assert store.detail("task")["activity_log"] == [
            {"at": at, "kind": "message", "text": str(at)}
            for at in range(batch[-1], max(0, batch[-1] - 10), -1)
        ]
        assert store.poll() == []
    with codex.open("a") as stream:
        for label in ("first", "last"):
            stream.write(json.dumps({"type": "item.completed", "timestamp": 15,
                                     "item": {"type": "agent_message", "text": label}}) + "\n")
    store.poll()
    assert [item["text"] for item in store.detail("task")["activity_log"]] == [
        "last", "first", *map(str, range(14, 6, -1))]
    write_state(tmp_path, pid=pids[1])
    store.poll()
    assert store.detail("task")["activity_log"] == []


FULL_CARGO = {
    "checks": [{"cmd": "old", "exit": 1, "seconds": 2, "at": 5, "outcome": "failed"},
               {"cmd": "make test\nfast", "exit": 0, "seconds": 5.1, "at": 1794116947.6, "outcome": "passed"}],
    "check_start": 1,
    "review_result": {"verdict": "defects", "summary": "Three defects", "findings": [
        {"id": "F1", "severity": "P1", "title": "Crash", "file": "a.ts", "line": 12, "detail": "d", "verify": "v"},
        {"id": "F2", "severity": "P3", "title": "Name", "file": "b.ts", "line": 3},
        {"id": "F3", "severity": "P3", "title": "Doc"}]},
    "reviews": [{}, {}],
    "auto_fix_stop": "rounds_exhausted",
    "ci": {"sha": "abc", "outcome": "failed", "seconds": 540, "rounds": 1, "reason": "build failed",
           "checks": [{"name": "build", "bucket": "fail"}, {"name": "lint", "bucket": "pass"},
                      {"name": "test", "bucket": "pass"}]},
    "base_merges": [{"base": "origin/old", "outcome": "merged", "files": []},
                    {"base": "origin/main", "outcome": "conflict", "files": ["docs/e2e.md", "a.ts"]}],
    "result": {"status": "done", "remaining": ["one", "two"], "questions": ["why?"],
               "checks": [{"command": "pytest", "outcome": "passed", "details": "12 passed\n0 failed"}],
               "findings": [{"id": "F1", "decision": "fixed"}, {"id": "F2", "decision": "rejected"}]},
}
CARGO_SUMMARY = ("check", "review", "findings_left", "stop", "left")


def test_cargo_summary_and_detail(tmp_path):
    write_state(tmp_path, "full", **FULL_CARGO)
    write_state(tmp_path, "old")
    write_state(tmp_path, "all", checks=FULL_CARGO["checks"][::-1])
    write_state(tmp_path, "past", checks=FULL_CARGO["checks"], check_start=2)
    write_state(tmp_path, "bad-last", checks=[{"outcome": "passed"}, None],
                base_merges=[{"base": "origin/main", "outcome": "merged"}, None])
    write_state(tmp_path, "limits", review_result={"findings": [{"id": str(i)} for i in range(40)]},
                auto_fix_stop="x" * 500, result={"remaining": [f"r{i}" for i in range(25)]})
    write_state(tmp_path, "wrong", check_start="1", checks=["passed"], review_result=5, ci=5,
                base_merges="origin/main", reviews="x", auto_fix_stop=3,
                result={"remaining": "one", "questions": [1, None], "checks": ["x"], "findings": "F1"})
    write_state(tmp_path, "wrong-nested", review_result={"verdict": "ok", "findings": "F1"},
                ci={"checks": "build", "rounds": "1"}, base_merges=[{"base": 1, "files": "a.ts"}], result=[])
    store = Store(tmp_path)
    store.poll()
    rows = {row["slug"]: row for row in store.summaries()}
    assert {key: rows["full"][key] for key in CARGO_SUMMARY} == {
        "check": "passed", "review": "defects", "findings_left": 3, "stop": "rounds_exhausted", "left": 3}
    for slug in ("old", "wrong", "wrong-nested"):
        assert {key: rows[slug][key] for key in CARGO_SUMMARY} == {
            "check": None, "review": None, "findings_left": 0, "stop": None, "left": 0}, slug
    assert rows["all"]["check"] == "failed"
    assert rows["past"]["check"] is None
    assert rows["bad-last"]["check"] is None
    assert store.detail("bad-last")["cargo"]["check"] is store.detail("bad-last")["cargo"]["base"] is None
    assert store.detail("full")["cargo"] == {
        "check": {"command": "make test fast", "outcome": "passed", "exit": 0, "seconds": 5.1,
                  "at": 1794116947.6},
        "claims": [{"command": "pytest", "outcome": "passed", "details": "12 passed 0 failed"}],
        "review": {"verdict": "defects", "summary": "Three defects", "reviews": 2, "findings": [
            {"id": "F1", "severity": "P1", "title": "Crash", "file": "a.ts", "line": 12},
            {"id": "F2", "severity": "P3", "title": "Name", "file": "b.ts", "line": 3},
            {"id": "F3", "severity": "P3", "title": "Doc", "file": None, "line": None}]},
        "stop": "rounds_exhausted",
        "ci": {"outcome": "failed", "passed": 2, "failed": 1, "total": 3, "failing": ["build"],
               "seconds": 540.0, "rounds": 1, "reason": "build failed"},
        "base": {"base": "origin/main", "outcome": "conflict", "files": ["docs/e2e.md", "a.ts"]},
        "remaining": ["one", "two"],
        "questions": ["why?"],
        "decisions": {"fixed": 1, "rejected": 1},
    }
    empty = {"check": None, "claims": [], "review": None, "stop": None, "ci": None, "base": None,
             "remaining": [], "questions": [], "decisions": {"fixed": 0, "rejected": 0}}
    assert store.detail("old")["cargo"] == store.detail("wrong")["cargo"] == empty
    assert store.detail("wrong-nested")["cargo"] == dict(
        empty, review={"verdict": None, "summary": None, "findings": [], "reviews": 0},
        ci={"outcome": None, "passed": 0, "failed": 0, "total": 0, "failing": [], "seconds": None,
            "rounds": 0, "reason": None},
        base={"base": "", "outcome": "", "files": []})
    limits = store.detail("limits")
    assert limits["findings_left"] == 40 and len(limits["cargo"]["review"]["findings"]) == 30
    assert limits["left"] == 25 and limits["cargo"]["remaining"] == [f"r{i}" for i in range(20)]
    assert limits["stop"] == limits["cargo"]["stop"] == "x" * 200


def test_finished_scouts_are_closed_for_success_failure_and_abandoned_work(tmp_path, pids):
    live, dead = pids
    for outcome in ("completed", "failed", "running", "sleeping"):
        write_state(tmp_path, outcome, kind="scout", pid=dead, outcome=outcome)
    write_state(tmp_path, "alive-scout", kind="scout", pid=live)
    store = Store(tmp_path)
    store.poll()
    rows = {task["slug"]: task for task in store.summaries()}
    assert {slug: row["column"] for slug, row in rows.items()} == {
        "completed": "closed", "failed": "closed", "running": "closed", "sleeping": "closed",
        "alive-scout": "running",
    }


def test_stale_tasks_close_by_state_mtime_with_live_exemption_and_configurable_threshold(tmp_path, pids, monkeypatch):
    now = 20 * 86400.0
    monkeypatch.setattr("teamster_board.store.time.time", lambda: now)
    live, dead = pids
    for slug, pid, age in (("stale", dead, 7 * 86400 + 1), ("boundary", dead, 7 * 86400),
                           ("recent", dead, 2 * 86400), ("alive", live, 8 * 86400)):
        directory = write_state(tmp_path, slug, pid=pid, outcome="completed", result={"status": "done"})
        os.utime(directory / "state.json", (now - age, now - age))
    store = Store(tmp_path)
    store.poll()
    assert {task["slug"]: task["column"] for task in store.summaries()} == {
        "stale": "closed", "boundary": "review_me", "recent": "review_me", "alive": "running",
    }
    custom = Store(tmp_path, stale_days=1)
    custom.poll()
    assert custom.detail("recent")["column"] == "closed"
    assert custom.detail("alive")["column"] == "running"


def test_snapshot_closed_limit_combines_archive_and_live_folders_by_updated_at(tmp_path, pids, monkeypatch):
    now = 20 * 86400.0
    monkeypatch.setattr("teamster_board.store.time.time", lambda: now)
    live, dead = pids
    for i in range(30):
        archived = write_state(tmp_path / ".archive", f"archived-{i:02}", pid=dead)
        archived_at = now - 1000 + i
        os.utime(archived / "state.json", (archived_at, archived_at))
        scout = write_state(tmp_path, f"scout-{i:02}", kind="scout", pid=dead)
        scout_at = now - 970 + i
        os.utime(scout / "state.json", (scout_at, scout_at))
    stale = write_state(tmp_path, "stale-work", pid=dead)
    os.utime(stale / "state.json", (now - 8 * 86400, now - 8 * 86400))
    running = write_state(tmp_path, "running", pid=live)
    os.utime(running / "state.json", (now - 8 * 86400, now - 8 * 86400))
    attention = write_state(tmp_path, "attention", pid=dead)
    os.utime(attention / "state.json", (now, now))
    store = Store(tmp_path)
    store.poll()
    rows = store.summaries()
    closed = [task for task in rows if task["column"] == "closed"]
    assert len(rows) == 52
    assert len(closed) == 50
    assert {task["slug"] for task in closed} == (
        {f"archived-{i:02}" for i in range(10, 30)} | {f"scout-{i:02}" for i in range(30)}
    )
    assert {task["slug"] for task in rows if task["column"] != "closed"} == {"running", "attention"}
    assert store.detail("stale-work")["column"] == "closed"
    assert store.detail("archived-00")["column"] == "closed"


@pytest.mark.parametrize("executor,task_model,cursor_model,expected", [
    ("codex", "gpt-6.1-sol", "claude-opus-5-5", "gpt-6.1-sol"),
    ("codex", None, "claude-opus-5-5", None),
    ("claude", "claude-opus-5-5", "gpt-6.1-sol", "claude-opus-5-5"),
    ("claude", None, "claude-opus-5-5", "claude-opus-5-5"),
])
def test_model_always_belongs_to_executor_including_during_review(tmp_path, pids, executor, task_model, cursor_model, expected):
    live, _ = pids
    for kind in ("work", "review"):
        write_state(tmp_path, kind, kind=kind, pid=live, executor=executor,
                    task_model=task_model, model=cursor_model, review_model="reviewer-only-model",
                    reviews=[{"started": 30, "finished": None}])
    store = Store(tmp_path)
    store.poll()
    assert store.detail("work")["model"] == expected
    assert store.detail("review")["model"] == expected
    assert store.detail("review")["phase"] == "review"


@pytest.mark.parametrize("fields,expected_phase", [
    ({"outcome": "completed", "check_pid": 123}, "check"),
    ({"ci": {"outcome": "pending"}}, "ci"),
    ({"rounds": [{}]}, "fix"),
])
def test_phase_observation_timer_preserves_unknown_start_and_resets_on_phase_change(tmp_path, pids, monkeypatch, fields, expected_phase):
    now = [1000.0]
    monkeypatch.setattr("teamster_board.store.time.time", lambda: now[0])
    live, _ = pids
    write_state(tmp_path, pid=live, **fields)
    store = Store(tmp_path)
    store.poll()
    assert store.detail("task")["phase"] == expected_phase
    assert store.detail("task")["phase_started_at"] is None
    now[0] = 1010.0
    store.poll()
    assert store.detail("task")["phase_started_at"] is None

    write_state(tmp_path, pid=live)
    store.poll()
    assert store.detail("task")["phase"] == "turn"
    assert store.detail("task")["phase_started_at"] == 20.0
    now[0] = 1020.0
    write_state(tmp_path, pid=live, **fields)
    store.poll()
    assert store.detail("task")["phase_started_at"] == 1020.0
    now[0] = 1030.0
    store.poll()
    assert store.detail("task")["phase_started_at"] == 1020.0

    write_state(tmp_path, pid=live)
    store.poll()
    now[0] = 1040.0
    write_state(tmp_path, pid=live, **fields)
    store.poll()
    assert store.detail("task")["phase_started_at"] == 1040.0
    write_state(tmp_path, pid=live, kind="review", reviews=[{"started": 900.0, "finished": None}])
    store.poll()
    assert store.detail("task")["phase_started_at"] == 900.0


def test_phase_observation_timer_starts_for_task_appearing_after_first_poll(tmp_path, pids, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr("teamster_board.store.time.time", lambda: now[0])
    live, _ = pids
    store = Store(tmp_path)
    store.poll()
    now[0] = 1010.0
    write_state(tmp_path, pid=live, ci={"outcome": "pending"})
    store.poll()
    assert store.detail("task")["phase"] == "ci"
    assert store.detail("task")["phase_started_at"] == 1010.0


def write_session(desktop, slug="local_example", **fields):
    directory = desktop / "claude-code-sessions" / "account" / "device"
    directory.mkdir(parents=True, exist_ok=True)
    state = {"sessionId": slug, "cliSessionId": "cli-" + slug, "title": "Session title",
             "cwd": "/tmp/project", "model": "claude-model", "effort": "high",
             "isArchived": False, "createdAt": 1000, "lastActivityAt": time.time() * 1000,
             "completedTurns": 3, "interruptedAwaitingPerson": None, "prs": [], **fields}
    path = directory / (slug + ".json")
    path.write_text(json.dumps(state))
    return path


def write_live(home, pid, session="cli-local_example", **fields):
    directory = home / "sessions"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{pid}.json"
    path.write_text(json.dumps({"pid": pid, "sessionId": session, "cwd": "/tmp/project",
                                "status": "busy", "statusUpdatedAt": 2000,
                                "entrypoint": "desktop", **fields}))
    return path


def session_store(tmp_path, **options):
    return Store(tmp_path / "tasks", claude_desktop_dir=tmp_path / "desktop",
                 claude_home=tmp_path / "home", sessions_seconds=0, **options)


@pytest.mark.parametrize("fields,busy,expected", [
    ({"isArchived": True, "interruptedAwaitingPerson": {}}, True, None),
    ({"interruptedAwaitingPerson": {}, "lastActivityAt": 1,
      "prs": [{"state": "MERGED"}]}, True, "running"),
    ({"interruptedAwaitingPerson": False, "lastActivityAt": 1,
      "prs": [{"state": "CLOSED"}]}, False, "attention"),
    ({"prs": [{"state": "MERGED"}, {"state": "CLOSED"}]}, False, "closed"),
    ({"prs": [{"state": "MERGED"}, {"state": "OPEN"}]}, False, "review_me"),
    ({"lastActivityAt": 1}, False, "closed"),
    ({"lastActivityAt": (300000 - 48 * 3600) * 1000}, False, "review_me"),
    ({}, False, "review_me"),
])
def test_session_column_precedence(tmp_path, pids, monkeypatch, fields, busy, expected):
    monkeypatch.setattr("teamster_board.store.time.time", lambda: 300000)
    write_session(tmp_path / "desktop", **fields)
    if busy:
        write_live(tmp_path / "home", pids[0])
    store = session_store(tmp_path)
    store.poll()
    rows = store.summaries()
    if expected is None:
        assert rows == []
        assert store.detail("local_example") is None
    else:
        assert len(rows) == 1
        assert rows[0]["column"] == expected
        assert rows[0]["alive"] is busy
        assert rows[0]["phase"] == ("turn" if busy else "idle")
        assert rows[0]["activity"] is None


@pytest.mark.parametrize("cwd,origin,expected", [
    ("/tmp/project/.claude/worktrees/topic", None, "project"),
    ("/tmp/project", None, "project"),
    ("/tmp/elsewhere/.claude/worktrees/topic", "/tmp/original", "original"),
    (None, None, "(no folder)"),
])
def test_session_repo_and_allowlisted_summary(tmp_path, cwd, origin, expected):
    desktop = tmp_path / "desktop"
    write_session(desktop, cwd=cwd or str(desktop / "sessions" / "scratch"), originCwd=origin,
                  createdAt=1000, lastActivityAt=2000,
                  secret="private metadata must not escape",
                  prs=[{"url": "https://example.test/pr/1", "state": "OPEN", "branch": "own-first", "own": True},
                       {"url": "https://example.test/pr/2", "state": "OPEN", "branch": "own-last", "own": True,
                        "secret": "private PR metadata"},
                       {"url": "https://example.test/pr/3", "state": "OPEN", "branch": "foreign", "own": False}])
    store = session_store(tmp_path)
    store.poll()
    detail = store.detail("local_example")
    assert detail["repo"] == expected
    assert detail["kind"] == "session"
    assert detail["title"] == "Session title"
    assert detail["link"] == "claude://claude.ai/epitaxy/local_example"
    assert detail["executor"] == "claude"
    assert detail["model"] == "claude-model"
    assert detail["effort"] == "high"
    assert detail["turn"] == 3
    assert detail["fix_round"] == 0
    assert detail["branch"] == "own-last"
    assert detail["pr"] == "https://example.test/pr/2"
    assert detail["created"] == 1.0
    assert detail["updated_at"] == detail["phase_started_at"] == 2.0
    assert all(detail[key] is None for key in (
        "reviewer", "account", "task_type", "ci", "outcome", "result_status", "summary", "sleeping_until",
        "report", "changes"))
    assert {key: detail[key] for key in ("check", "review", "findings_left", "stop", "left", "cargo")} == {
        "check": None, "review": None, "findings_left": 0, "stop": None, "left": 0, "cargo": None}
    assert detail["files"] == []
    assert detail["limits"] is None
    assert detail["messages"] == detail["activity_log"] == []
    assert detail["timeline"] == [{"at": 1.0, "text": "Session created"},
                                    {"at": 2.0, "text": "Last activity"}]
    assert "private" not in json.dumps(detail)
    assert not {"cwd", "originCwd", "cliSessionId", "prs", "secret"} & detail.keys()
    assert store.file_path("local_example", "brief") is None
    write_session(desktop, prs=[{"url": "https://example.test/pr/3", "state": "OPEN", "branch": "foreign"}])
    store.poll()
    assert store.detail("local_example")["pr"] == "https://example.test/pr/3"
    assert store.detail("local_example")["branch"] is None
    assert detail["scheduled"] is None
    write_session(desktop, scheduledTaskId="codex-batch-reflection")
    store.poll()
    assert store.summaries()[0]["scheduled"] == "codex-batch-reflection"
    assert store.detail("local_example")["scheduled"] == "codex-batch-reflection"


def test_session_live_state_only_opens_numeric_json_and_checks_pid(tmp_path, pids, monkeypatch):
    import builtins
    import io

    live, dead = pids
    write_session(tmp_path / "desktop")
    home = tmp_path / "home"
    write_live(home, dead)
    key = home / "sessions" / f"{live}.hash.key"
    key.write_text("never read this key")
    foreign = home / "sessions" / "not-a-pid.json"
    foreign.write_text(json.dumps({"pid": live, "sessionId": "cli-local_example", "status": "busy"}))
    blocked = {key, foreign}

    def guarded(original):
        def open_checked(path, *args, **kwargs):
            if not isinstance(path, int):
                assert Path(path) not in blocked, "non-state file must never be opened"
            return original(path, *args, **kwargs)
        return open_checked

    monkeypatch.setattr(builtins, "open", guarded(builtins.open))
    monkeypatch.setattr(io, "open", guarded(io.open))
    monkeypatch.setattr(os, "open", guarded(os.open))
    store = session_store(tmp_path)
    store.poll()
    assert store.detail("local_example")["alive"] is False
    write_live(home, live, status="idle")
    store.poll()
    assert store.detail("local_example")["alive"] is False
    write_live(home, live)
    store.poll()
    assert store.detail("local_example")["alive"] is True
    assert store.detail("local_example")["phase_started_at"] == 2.0


def test_session_bad_files_keep_previous_state_and_missing_sources_are_optional(tmp_path, pids, monkeypatch):
    store = session_store(tmp_path)
    assert store.poll() == []
    assert store.summaries() == []
    metadata = write_session(tmp_path / "desktop")
    live = write_live(tmp_path / "home", pids[0])
    store.poll()
    previous = store.summaries()
    metadata.write_text('{"sessionId":')
    live.write_text('{"pid":')
    assert store.poll() == []
    assert store.summaries() == previous
    original_read = Path.read_text

    def no_unchanged_metadata_read(path, *args, **kwargs):
        assert path != metadata, "unchanged malformed metadata should not be read again"
        return original_read(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "read_text", no_unchanged_metadata_read)
        assert store.poll() == []
    write_live(tmp_path / "home", pids[0], status="idle")
    assert store.poll()[0]["task"]["column"] == "review_me"
    write_session(tmp_path / "desktop", isArchived=True)
    assert store.poll() == [{"type": "task_removed", "slug": "local_example"}]
    assert store.detail("local_example") is None
    write_session(tmp_path / "desktop")
    store.poll()
    metadata.unlink()
    assert store.poll() == [{"type": "task_removed", "slug": "local_example"}]
    assert store.detail("local_example") is None


def test_session_metadata_scan_cadence_cache_and_archived_memory(tmp_path, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("teamster_board.store.time.monotonic", lambda: clock[0])
    desktop = tmp_path / "desktop"
    metadata = write_session(desktop)
    archived = write_session(desktop, "local_archived", isArchived=True, title="archived payload")
    read = []
    original = json.loads

    def track_loads(raw, *args, **kwargs):
        state = original(raw, *args, **kwargs)
        if isinstance(state, dict) and "sessionId" in state:
            read.append(state["sessionId"])
        return state

    monkeypatch.setattr(json, "loads", track_loads)
    store = Store(tmp_path / "tasks", claude_desktop_dir=desktop,
                  claude_home=tmp_path / "home", sessions_seconds=5)
    store.poll()
    assert sorted(read) == ["local_archived", "local_example"]
    assert "local_archived" not in store.session_records
    assert store._session_signatures[archived] == (archived.stat().st_mtime_ns, archived.stat().st_size)
    clock[0] = 106.0
    store.poll()
    assert len(read) == 2
    metadata.write_text(metadata.read_text().replace("Session title", "Changed title"))
    clock[0] = 107.0
    store.poll()
    assert store.detail("local_example")["title"] == "Session title"
    clock[0] = 112.0
    store.poll()
    assert store.detail("local_example")["title"] == "Changed title"
    assert read.count("local_example") == 2
    assert read.count("local_archived") == 1
    assert archived.is_file()


def test_session_moved_transcript_search_is_cached_and_only_busy_sessions_read(tmp_path, pids, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("teamster_board.store.time.monotonic", lambda: clock[0])
    write_session(tmp_path / "desktop")
    home = tmp_path / "home"
    write_live(home, pids[0], status="idle")
    moved = home / "projects" / "old-folder" / "cli-local_example.jsonl"
    moved.parent.mkdir(parents=True)
    event = {"type": "assistant", "timestamp": "2026-11-05T10:00:00Z",
             "message": {"content": [{"type": "text", "text": "First update"}]}}
    directories = Store._directories
    searches = []

    def count_searches(root):
        if root == home / "projects":
            searches.append(root)
        return directories(root)

    monkeypatch.setattr(Store, "_directories", staticmethod(count_searches))
    store = session_store(tmp_path)
    store.poll()
    assert searches == []
    assert store.detail("local_example")["activity"] is None
    write_live(home, pids[0])
    store.poll()
    assert len(searches) == 1
    assert store.detail("local_example")["activity"] is None
    moved.write_text(json.dumps(event) + "\n")
    clock[0] = 159.0
    store.poll()
    assert len(searches) == 1
    assert store.detail("local_example")["activity"] is None
    clock[0] = 160.0
    store.poll()
    assert len(searches) == 2
    first = store.detail("local_example")["activity"]
    assert first["text"] == "First update"
    assert first["at"] == 1793872800.0
    event["message"]["content"][0]["text"] = "Second update"
    with moved.open("a") as stream:
        stream.write(json.dumps(event) + "\n")
    clock[0] = 220.0
    messages = store.poll()
    assert len(searches) == 2
    assert any(message["type"] == "activity" and message["activity"]["text"] == "Second update"
               for message in messages)
    store.poll()
    assert len(searches) == 2
    write_live(home, pids[0], status="idle")
    store.poll()
    assert store.detail("local_example")["activity"] is None


@pytest.mark.parametrize("initially_exists", [True, False])
def test_session_transcript_direct_path_uses_ascii_and_retries_until_created(tmp_path, pids, monkeypatch,
                                                                         initially_exists):
    write_session(tmp_path / "desktop", cwd="/tmp/ЯA2")
    home = tmp_path / "home"
    write_live(home, pids[0], cwd="/tmp/ЯA2")
    transcript = home / "projects" / "-tmp--A2" / "cli-local_example.jsonl"
    transcript.parent.mkdir(parents=True)
    event = json.dumps({"type": "assistant", "timestamp": "2026-11-05T10:00:00Z",
                        "message": {"content": [{"type": "text", "text": "Current update"}]}}) + "\n"
    if initially_exists:
        transcript.write_text(event)
    directories = Store._directories
    searches = []

    def count_searches(root):
        if root == home / "projects":
            searches.append(root)
        return directories(root)

    monkeypatch.setattr(Store, "_directories", staticmethod(count_searches))
    store = session_store(tmp_path)
    store.poll()
    assert len(searches) == (0 if initially_exists else 1)
    if not initially_exists:
        assert store.detail("local_example")["activity"] is None
        transcript.write_text(event)
        store.poll()
        assert len(searches) == 1
    assert store.detail("local_example")["activity"]["text"] == "Current update"


def test_session_activity_cannot_carry_over_between_busy_turns_or_server_start(tmp_path, pids):
    write_session(tmp_path / "desktop")
    home = tmp_path / "home"
    write_live(home, pids[0], statusUpdatedAt=1793872800000)
    transcript = home / "projects" / "-tmp-project" / "cli-local_example.jsonl"
    transcript.parent.mkdir(parents=True)
    event = {"type": "assistant", "timestamp": "2026-11-05T10:00:00Z",
             "message": {"content": [{"type": "text", "text": "Previous turn"}]}}
    transcript.write_text(json.dumps(event) + "\n")
    store = session_store(tmp_path)
    assert any(message["type"] == "activity" for message in store.poll())
    assert store.detail("local_example")["activity"]["text"] == "Previous turn"
    write_live(home, pids[0], status="idle", statusUpdatedAt=1793872801000)
    store.poll()
    assert store.session_records["local_example"].activity is None
    user = {"type": "user", "timestamp": "2026-11-05T10:00:02Z",
            "message": {"content": "Next request"}}
    with transcript.open("a") as stream:
        stream.write(json.dumps(user) + "\n")
    write_live(home, pids[0], statusUpdatedAt=1793872802000)
    messages = store.poll()
    assert store.detail("local_example")["activity"] is None
    assert not any(message["type"] == "activity" for message in messages)
    event["timestamp"] = "2026-11-05T10:00:03Z"
    event["message"]["content"][0]["text"] = "Current turn"
    with transcript.open("a") as stream:
        stream.write(json.dumps(event) + "\n")
    messages = store.poll()
    assert store.detail("local_example")["activity"]["text"] == "Current turn"
    assert any(message["type"] == "activity" and message["activity"]["text"] == "Current turn"
               for message in messages)
    write_live(home, pids[0], statusUpdatedAt=1793872804000)
    messages = store.poll()
    assert store.detail("local_example")["activity"] is None
    assert not any(message["type"] == "activity" for message in messages)
    restarted = session_store(tmp_path)
    messages = restarted.poll()
    assert restarted.detail("local_example")["alive"] is True
    assert restarted.detail("local_example")["activity"] is None
    assert not any(message["type"] == "activity" for message in messages)


def test_session_symlinks_and_invalid_slug_are_not_read(tmp_path, pids):
    desktop = tmp_path / "desktop"
    metadata = write_session(desktop)
    home = tmp_path / "home"
    live = write_live(home, pids[0])
    live.rename(home / "live.json")
    live.symlink_to(home / "live.json")
    alias = metadata.with_name("local_alias.json")
    alias.symlink_to(metadata)
    write_session(desktop, "local_invalid", sessionId="../x")
    store = session_store(tmp_path)
    store.poll()
    assert len(store.summaries()) == 1
    assert store.detail("local_example")["alive"] is False
    for slug in ("../x", "local_alias", "local_invalid"):
        assert store.detail(slug) is None
    live.unlink()
    write_live(home, pids[0])
    transcript = home / "projects" / "-tmp-project" / "cli-local_example.jsonl"
    transcript.parent.mkdir(parents=True)
    outside = home / "transcript.jsonl"
    outside.write_text(json.dumps({"type": "assistant", "message": {
        "content": [{"type": "text", "text": "Must not be read"}]}}) + "\n")
    transcript.symlink_to(outside)
    store.poll()
    assert store.detail("local_example")["alive"] is True
    assert store.detail("local_example")["activity"] is None
    transcript.unlink()
    project = transcript.parent
    project.rename(home / "outside-project")
    (home / "outside-project" / transcript.name).write_text(outside.read_text())
    project.symlink_to(home / "outside-project", target_is_directory=True)
    store.poll()
    assert store.detail("local_example")["activity"] is None
    metadata.rename(desktop / "metadata.json")
    metadata.symlink_to(desktop / "metadata.json")
    store.poll()
    assert store.summaries() == []


def test_session_closed_limit_is_shared_with_tasks_and_custom_staleness(tmp_path, monkeypatch):
    now = 300000.0
    monkeypatch.setattr("teamster_board.store.time.time", lambda: now)
    desktop = tmp_path / "desktop"
    for index in range(30):
        task = write_state(tmp_path / "tasks" / ".archive", f"archived-{index:02}")
        os.utime(task / "state.json", (100 + index, 100 + index))
        write_session(desktop, f"local_closed-{index:02}", lastActivityAt=(200 + index) * 1000)
    write_session(desktop, "local_recent", lastActivityAt=(now - 3600) * 1000)
    store = session_store(tmp_path)
    store.poll()
    rows = store.summaries()
    assert len(rows) == 51
    closed = {row["slug"] for row in rows if row["column"] == "closed"}
    assert closed == ({f"archived-{index:02}" for index in range(10, 30)} |
                      {f"local_closed-{index:02}" for index in range(30)})
    assert store.detail("local_recent")["column"] == "review_me"
    custom = session_store(tmp_path, session_stale_hours=0.5)
    custom.poll()
    assert custom.detail("local_recent")["column"] == "closed"


def test_log_events_allowlist_and_invalid_rows(tmp_path, monkeypatch):
    monkeypatch.setattr("teamster_board.store.time.time", lambda: 5000000)
    path = tmp_path / "log.jsonl"
    row = {"at": 4999999, "started": 4999990, "slug": "demo", "repo": "project",
           "kind": "review", "phase": "review", "turn": 2, "round": 1,
           "outcome": "completed", "result_status": "done", "verdict": "request_changes",
           "findings": 3, "severe_findings": 1, "angle": "correctness", "account": "main",
           "reviewer": "claude", "provider": "anthropic", "model": "model",
           "task_type": "feature", "ci": {"outcome": "passed", "secret": "private"},
           "note": "only verdict notes are exposed", "tokens": {"input": 123}, "usage": [{}],
           "thread": "private", "session_id": "private", "cost_usd": 1, "weekly_spent": 2}
    verdict = {"at": 5000000, "kind": "verdict", "note": " Long\n\t" + "note " * 100,
               "started": True, "turn": "2", "round": float("inf"), "findings": float("nan"),
               "severe_findings": {}, "model": [], "ci": "passed"}
    rows = [row, verdict, [], {"kind": "work"}, {"kind": "work", "at": True},
            {"kind": "work", "at": "5000000"}, {"kind": "work", "at": float("nan")},
            {"kind": "work", "at": float("inf")}, {"kind": "unknown", "at": 5000000}]
    path.write_bytes(b"broken json\n\xff\n" + b"[" * 100000 + b"\n" + b"".join(
        json.dumps(item).encode() + b"\n" for item in rows))
    store = Store(tmp_path / "tasks", telemetry_path=path)
    messages = store.poll()
    events = store.events(4999990, 5000000)["events"]
    assert len(events) == 2
    fields = {"at", "started", "slug", "repo", "kind", "phase", "turn", "round", "outcome",
              "result_status", "verdict", "findings", "severe_findings", "angle", "account",
              "reviewer", "provider", "model", "task_type", "ci", "note"}
    assert all(set(event) == fields for event in events)
    assert events[0] == {**{key: row[key] for key in fields - {"ci", "note"}},
                         "ci": "passed", "note": None}
    assert events[1]["note"] == " ".join(verdict["note"].split())[:200]
    assert len(events[1]["note"]) == 200
    assert all(events[1][key] is None for key in (
        "started", "turn", "round", "findings", "severe_findings", "model", "ci", "phase"))
    assert messages == [{"type": "event", "event": event} for event in events]
    assert store.poll() == []


def test_log_incremental_append_waits_for_complete_line(tmp_path, monkeypatch):
    monkeypatch.setattr("teamster_board.store.time.time", lambda: 1000)
    path = tmp_path / "log.jsonl"
    first = {"at": 998, "kind": "work", "phase": "work"}
    second = {"at": 999, "kind": "scout", "phase": "scout"}
    path.write_text(json.dumps(first) + "\n")
    parsed = []
    original = json.loads

    def tracked_loads(raw):
        parsed.append(raw)
        return original(raw)

    monkeypatch.setattr(json, "loads", tracked_loads)
    store = Store(tmp_path / "tasks", telemetry_path=path)
    assert len(store.poll()) == 1
    assert store.poll() == []
    with path.open("a") as stream:
        stream.write(json.dumps(second))
    assert store.poll() == []
    assert len(store.events(0, 1000)["events"]) == 1
    with path.open("a") as stream:
        stream.write("\n")
    assert [message["event"]["at"] for message in store.poll()] == [999]
    assert [original(raw) for raw in parsed] == [first, second]
    assert [event["at"] for event in store.events(0, 1000)["events"]] == [998, 999]
    assert store.poll() == []


def test_log_truncation_and_inode_replacement_reset_history(tmp_path, monkeypatch):
    monkeypatch.setattr("teamster_board.store.time.time", lambda: 1000)
    path = tmp_path / "log.jsonl"
    first = {"at": 997, "kind": "work"}
    second = {"at": 998, "kind": "scout"}
    third = {"at": 999, "kind": "work"}
    path.write_text("".join(json.dumps(row) + "\n" for row in (first, second)))
    store = Store(tmp_path / "tasks", telemetry_path=path)
    assert [message["event"]["at"] for message in store.poll()] == [997, 998]
    replacement = tmp_path / "replacement.jsonl"
    replacement.write_text("".join(json.dumps(row, sort_keys=True) + "\n"
                                   for row in (first, second, third)))
    replacement.replace(path)
    assert [message["event"]["at"] for message in store.poll()] == [999]
    assert [event["at"] for event in store.events(0, 1000)["events"]] == [997, 998, 999]
    path.write_text("".join(json.dumps(row) + "\n" for row in (first, third)))
    assert store.poll() == []
    assert [event["at"] for event in store.events(0, 1000)["events"]] == [997, 999]
    metadata = path.stat()
    fourth = {"at": 996, "kind": "work"}
    path.write_text("".join(json.dumps(row) + "\n" for row in (first, fourth)))
    assert path.stat().st_size == metadata.st_size
    os.utime(path, ns=(metadata.st_atime_ns, metadata.st_mtime_ns + 1000000))
    assert [message["event"]["at"] for message in store.poll()] == [996]
    assert [event["at"] for event in store.events(0, 1000)["events"]] == [996, 997]
    replacement.write_text("".join(json.dumps(row) + "\n"
                                   for row in (first, second, third, fourth)))
    replacement.replace(path)
    assert store.poll() == []
    assert [event["at"] for event in store.events(0, 1000)["events"]] == [996, 997, 998, 999]


def test_log_missing_symlinks_and_retention(tmp_path, monkeypatch):
    now = [5000000]
    monkeypatch.setattr("teamster_board.store.time.time", lambda: now[0])
    path = tmp_path / "log.jsonl"
    store = Store(tmp_path / "tasks", telemetry_path=path)
    assert store.poll() == []
    assert store.events(0, now[0])["events"] == []
    boundary = now[0] - 31 * 24 * 3600
    path.write_text("".join(json.dumps({"at": at, "kind": "work"}) + "\n"
                            for at in (boundary - 1, boundary, now[0])))
    assert len(store.poll()) == 2
    now[0] += 1
    assert store.poll() == []
    assert [event["at"] for event in store.events(0, now[0])["events"]] == [5000000]
    outside = tmp_path / "outside.jsonl"
    path.rename(outside)
    assert store.poll() == []
    assert store.events(0, now[0])["events"] == []
    path.symlink_to(outside)
    original_open = os.open

    def guarded_open(target, *args, **kwargs):
        assert target != path, "a symlinked telemetry file must never be opened"
        return original_open(target, *args, **kwargs)

    monkeypatch.setattr(os, "open", guarded_open)
    assert store.poll() == []
    assert store.events(0, now[0])["events"] == []
