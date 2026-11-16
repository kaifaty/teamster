"""The duty chat through REST and WebSocket: the conversation view, sending a message and the duty's absence from task views."""

import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from teamster_board import app as board_app, duty_chat as duty_chat_module
from teamster_board.app import Settings, create_app


FAKE_TEAMSTER = '''import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
control_path = Path(os.environ["DUTY_CONTROL"])
control = json.loads(control_path.read_text())
if args == ["--version"]:
    print(control.get("version", "1.86.0"))
    sys.exit(0)
record = {"argv": args, "cwd": os.getcwd(), "stdin": sys.stdin.read()}
if "--file" in args:
    record["file"] = Path(args[args.index("--file") + 1]).read_text()
with Path(os.environ["DUTY_CALLS"]).open("a") as stream:
    stream.write(json.dumps(record) + "\\n")
if control.get("refuse"):
    time.sleep(control.get("refuse_after", 0))
    print(control["refuse"], file=sys.stderr)
    sys.exit(1)
directory = Path(os.environ["TEAMSTER_HOME"]) / "tasks" / "duty"
directory.mkdir(parents=True, exist_ok=True)
state_path = directory / "state.json"
if "--queue" in args and control.get("queue", True):
    queue_path = directory / "queue.json"
    queue = json.loads(queue_path.read_text()) if queue_path.exists() else {"waiting": [], "dropped": []}
    queue["waiting"].append({"at": time.time(), "text": record["file"], "options": {}, "source": "user"})
    queue_path.write_text(json.dumps(queue))
    print("queued for the duty: %d waiting; sent when the current turn ends" % len(queue["waiting"]))
    sys.exit(0)
time.sleep(control.get("start_after", 0))
state = json.loads(state_path.read_text()) if state_path.exists() else {
    "slug": "duty", "kind": "duty", "created": time.time(), "turns": 0, "duty_turns": []}
state.update(turns=state["turns"] + 1, pid=os.getpid(), turn_started=time.time())
state_path.write_text(json.dumps(state))
with (directory / "messages.jsonl").open("a") as stream:
    stream.write(json.dumps({"at": time.time(), "text": record["file"], "source": "user"}) + "\\n")
release = Path(os.environ["DUTY_CALLS"]).with_name("release")
while control.get("hold") and not release.exists():
    time.sleep(0.01)
state["duty_turns"].append({"at": time.time(), "turn": state["turns"], "account": "pool", "status": "answered",
                            "reply": "Done.", "question": "", "options": [], "started": []})
state["pid"] = None
state_path.write_text(json.dumps(state))
if control.get("late_error"):
    print(control["late_error"], file=sys.stderr)
    sys.exit(1)
print("== result: answered")
'''


@pytest.fixture
def duty(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    data = home / ".teamster"
    tasks = data / "tasks"
    tasks.mkdir(parents=True)
    monkeypatch.setenv("TEAMSTER_HOME", str(data))
    control, calls = tmp_path / "control.json", tmp_path / "calls.jsonl"
    control.write_text("{}")
    monkeypatch.setenv("DUTY_CONTROL", str(control))
    monkeypatch.setenv("DUTY_CALLS", str(calls))
    fake = tmp_path / "teamster"
    fake.write_text(f"#!{sys.executable}\n" + FAKE_TEAMSTER)
    fake.chmod(0o755)
    accounts = tmp_path / "accounts.py"
    accounts.write_text("print('{}')\n")

    def start(**options):
        options = {"action_teamster": str(fake), **options}
        settings = Settings(data, accounts, layout="new", web_dist=tmp_path / "dist", poll_seconds=0.02, **options)
        return TestClient(create_app(settings), base_url="http://localhost:8787",
                          headers={"Host": "localhost:8787", "Origin": "http://localhost:8787",
                                   "X-Teamster-Board": "1"})

    def configure(**values):
        control.write_text(json.dumps(values))

    def records():
        return [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []

    yield {"start": start, "tasks": tasks, "configure": configure, "records": records, "release": tmp_path / "release"}
    (tmp_path / "release").touch()


def set_duty(client, family="claude", account="pool"):
    """The accounts snapshot names the duty account, as `teamster accounts --json` does."""
    accounts = client.app.state.board.accounts
    deadline = time.monotonic() + 5
    while accounts.value["fetched_at"] is None and time.monotonic() < deadline:
        time.sleep(0.01)
    duty = {"account": account, "family": family, "reason": "most room", "since": 1.0} if family else None
    accounts.value = {"fetched_at": time.time(), "error": None, "data": {"codex": [], "claude": [], "duty": duty}}


def until(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    pytest.fail("timed out")


def write_conversation(tasks, pid=None, turns=None, rows=None):
    directory = tasks / "duty"
    directory.mkdir(exist_ok=True)
    turns = turns if turns is not None else [
        {"at": 110.0, "turn": 1, "account": "pool", "status": "needs_decision", "reply": "Which repository?",
         "question": "Which repository should the fix go to?", "options": ["parser", "billing"], "started": []},
        {"at": 130.0, "turn": 2, "account": "pool", "status": "started", "reply": "Started the fix.",
         "question": "", "options": [], "started": ["fix-parser", "fix-docs"]},
        {"at": 160.0, "turn": 3, "account": "spare", "status": "answered", "reply": "fix-parser is done.",
         "question": "", "options": [], "started": []},
        # An entry that breaks the schema is left out; the ids of the others keep their place.
        {"at": 170.0, "turn": 4, "status": "unknown", "reply": "?"},
    ]
    state = {"slug": "duty", "kind": "duty", "created": 90.0, "turns": 4, "pid": pid, "turn_started": 165.0,
             "duty_turns": turns}
    (directory / "state.json").write_text(json.dumps(state))
    rows = rows if rows is not None else [
        {"at": 100.0, "text": "Fix the parser.", "source": "user"},
        {"at": 120.0, "text": "parser", "source": "user"},
        {"at": 150.0, "text": "Task note: fix-parser ended turn 1 with outcome completed.", "source": "note",
         "queued_at": 140.0},
        {"at": 165.0, "text": "Anything else?", "source": "user"},
        {"at": 166.0, "text": "A lead's order is not part of the chat.", "source": "lead"},
    ]
    with (directory / "messages.jsonl").open("w") as stream:
        for row in rows:
            stream.write(json.dumps(row) + "\n")
        stream.write("not json\n")
    return directory


def test_view_without_conversation_and_each_reason(duty):
    with duty["start"]() as client:
        view = client.get("/api/duty-chat").json()
        assert view == {"actions": {"enabled": True, "reason": None}, "available": False, "reason": "no_duty",
                        "duty": None, "busy": False, "turn_started_at": None, "messages": [], "queued": [],
                        "last_error": None}
        set_duty(client, "codex", "main")
        view = client.get("/api/duty-chat").json()
        assert (view["available"], view["reason"], view["duty"]) == (False, "codex_duty",
                                                                      {"account": "main", "family": "codex"})
        set_duty(client)
        view = client.get("/api/duty-chat").json()
        assert (view["available"], view["reason"], view["duty"]) == (True, None, {"account": "pool", "family": "claude"})
        # A room left by a creation cut short, without state.json, is no conversation yet.
        (duty["tasks"] / "duty" / "room").mkdir(parents=True)
        assert client.get("/api/duty-chat").json()["messages"] == []
    duty["configure"](version="1.85.3")
    with duty["start"]() as client:
        set_duty(client)
        assert client.get("/api/duty-chat").json()["reason"] == "old_teamster"
        response = client.post("/api/actions/duty-chat", json={"text": "Hello"})
        assert (response.status_code, response.json()) == (409, {"ok": False, "error": "old_teamster"})
    with duty["start"](read_only=True) as client:
        assert client.get("/api/duty-chat").json()["reason"] == "read_only"
    with duty["start"](action_teamster=None) as client:
        view = client.get("/api/duty-chat").json()
        assert (view["available"], view["reason"], view["actions"]) == (
            False, "no_teamster", {"enabled": False, "reason": "no_teamster"})
    assert duty["records"]() == []


def test_view_with_conversation(duty):
    write_conversation(duty["tasks"], pid=os.getpid())
    directory = duty["tasks"] / "duty"
    (directory / "queue.json").write_text(json.dumps({"waiting": [
        {"at": 170.0, "text": "And the docs?", "options": {}, "source": "user"},
        {"at": 168.0, "text": "Task note: fix-docs ended turn 1.", "options": {}, "source": "note", "task": "fix-docs"}],
        "dropped": []}))
    (directory / "notes.json").write_text(json.dumps({"held": [
        {"at": 169.0, "text": "Task note: held ended turn 2.", "options": {}, "source": "note", "task": "held"}]}))
    with duty["start"]() as client:
        set_duty(client)
        view = client.get("/api/duty-chat").json()
        assert (view["busy"], view["turn_started_at"]) == (True, 165.0)
        messages = view["messages"]
        assert [(row["from"], row["at"], row["turn"]) for row in messages] == [
            ("user", 100.0, 1), ("duty", 110.0, 1), ("user", 120.0, 2), ("duty", 130.0, 2),
            ("note", 150.0, 3), ("duty", 160.0, 3), ("user", 165.0, 4)]
        assert messages[1] == {"id": "d0", "at": 110.0, "from": "duty", "text": "Which repository?", "turn": 1,
                               "status": "needs_decision", "question": "Which repository should the fix go to?",
                               "options": ["parser", "billing"], "started": [], "account": "pool"}
        assert (messages[3]["status"], messages[3]["started"], messages[3]["question"]) == (
            "started", ["fix-parser", "fix-docs"], None)
        assert messages[5]["account"] == "spare"
        assert messages[4] == {"id": messages[4]["id"], "at": 150.0, "from": "note",
                               "text": "Task note: fix-parser ended turn 1 with outcome completed.", "turn": 3}
        assert len({row["id"] for row in messages}) == len(messages)
        assert view["queued"] == [
            {"at": 168.0, "from": "note", "text": "Task note: fix-docs ended turn 1."},
            {"at": 169.0, "from": "note", "text": "Task note: held ended turn 2."},
            {"at": 170.0, "from": "user", "text": "And the docs?"}]
        # Ids stay between reads, also once more messages arrive.
        with (directory / "messages.jsonl").open("a") as stream:
            stream.write(json.dumps({"at": 171.0, "text": "More.", "source": "user"}) + "\n")
        again = client.get("/api/duty-chat").json()["messages"]
        assert again[:-1] == messages and again[-1]["text"] == "More."
        # A supervisor that died keeps its pid in state.json: no turn runs.
        with subprocess.Popen(["true"]) as finished:
            pass
        state = json.loads((directory / "state.json").read_text())
        (directory / "state.json").write_text(json.dumps(dict(state, pid=finished.pid)))
        view = client.get("/api/duty-chat").json()
        assert (view["busy"], view["turn_started_at"]) == (False, None)


def test_view_keeps_the_last_200_messages(duty):
    rows = [{"at": float(index), "text": f"message {index}", "source": "user"} for index in range(150)]
    turns = [{"at": 150.0 + index, "turn": index + 1, "account": "pool", "status": "answered",
              "reply": f"answer {index}", "question": "", "options": [], "started": []} for index in range(100)]
    write_conversation(duty["tasks"], turns=turns, rows=rows)
    with duty["start"]() as client:
        first = client.get("/api/duty-chat").json()["messages"]
        assert len(first) == 200
        assert first[0]["text"] == "message 50" and first[-1]["text"] == "answer 99"
        assert [row["at"] for row in first] == sorted(row["at"] for row in first)
        assert client.get("/api/duty-chat").json()["messages"] == first
        # The newest 200 hold whole long messages, also past several chunks of the journal read.
        directory = duty["tasks"] / "duty"
        with (directory / "messages.jsonl").open("w", encoding="utf-8") as stream:
            for index in range(100):
                stream.write(json.dumps({"at": index * 10.0, "text": "測" * 8000, "source": "user"},
                                        ensure_ascii=False) + "\n")
        assert (directory / "messages.jsonl").stat().st_size > 2 * duty_chat_module.JOURNAL_CHUNK
        turns = [dict(turn, at=index * 10.0 + 1) for index, turn in enumerate(turns)]
        state = json.loads((directory / "state.json").read_text())
        (directory / "state.json").write_text(json.dumps(dict(state, duty_turns=turns)))
        long = client.get("/api/duty-chat").json()["messages"]
        assert [row["from"] for row in long] == ["user", "duty"] * 100
        assert long[0]["text"] == "測" * 8000


def test_send_argv_queue_text_file_and_limits(duty):
    with duty["start"]() as client:
        set_duty(client)
        response = client.post("/api/actions/duty-chat", json={"text": "  --queue\nFix the parser.  "})
        assert (response.status_code, response.json()) == (200, {"ok": True, "queued": False})
        until(lambda: len(client.get("/api/duty-chat").json()["messages"]) == 2)
        until(lambda: client.app.state.board.duty_chat._job is None)
        first, = duty["records"]()
        assert first["argv"][:3] == ["duty", "chat", "--file"] and len(first["argv"]) == 4
        assert first["file"] == "--queue\nFix the parser."
        assert first["cwd"] == str(Path.home()) and first["stdin"] == ""
        until(lambda: not Path(first["argv"][3]).exists())
        # While a turn runs, the message joins the queue.
        duty["configure"](hold=True)
        assert client.post("/api/actions/duty-chat", json={"text": "Second."}).json() == {"ok": True, "queued": False}
        view = until(lambda: (view := client.get("/api/duty-chat").json())["busy"] and view)
        assert view["turn_started_at"] is not None
        assert client.post("/api/actions/duty-chat", json={"text": "Third."}).json() == {"ok": True, "queued": True}
        records = duty["records"]()
        assert records[2]["argv"][:3] == ["duty", "chat", "--file"] and records[2]["argv"][4:] == ["--queue"]
        assert records[2]["file"] == "Third."
        assert client.get("/api/duty-chat").json()["queued"] == [{"at": pytest.approx(time.time(), abs=30),
                                                                   "from": "user", "text": "Third."}]
        duty["release"].touch()
        until(lambda: not client.get("/api/duty-chat").json()["busy"])
        for body in ({"text": ""}, {"text": "   "}, {"text": "x" * 8001}, {"text": 5}, {}):
            response = client.post("/api/actions/duty-chat", json=body)
            assert (response.status_code, response.json()) == (400, {"ok": False, "error": "Invalid text"})
        assert client.post("/api/actions/duty-chat", json={"text": "x" * 8000}).status_code == 200
        until(lambda: client.app.state.board.duty_chat._job is None)
        # One character is a message: the answer "1" to the duty's options.
        assert client.post("/api/actions/duty-chat", json={"text": " 1 "}).json() == {"ok": True, "queued": False}
        assert duty["records"]()[-1]["file"] == "1"
        for headers in ({"X-Teamster-Board": "0"}, {"Origin": "http://evil.example"},
                        {"Content-Type": "text/plain"}):
            response = client.post("/api/actions/duty-chat", content=json.dumps({"text": "Hi"}), headers={
                "Content-Type": "application/json", **headers})
            assert (response.status_code, response.json()) == (403, {"ok": False, "error": "forbidden"})
        assert client.post("/api/actions/duty-chat", content=b"[1]", headers={
            "Content-Type": "application/json"}).status_code == 400
        assert len(duty["records"]()) == 5
        # The text goes only through the temporary file, never into an argv word.
        assert all(record["argv"][:3] == ["duty", "chat", "--file"] and record["argv"][4:] in ([], ["--queue"])
                   and Path(record["argv"][3]).parent == Path(tempfile.gettempdir()) for record in duty["records"]())
    with duty["start"](read_only=True) as client:
        response = client.post("/api/actions/duty-chat", json={"text": "Hi"})
        assert (response.status_code, response.json()) == (403, {"ok": False, "error": "read_only"})
    assert len(duty["records"]()) == 5


def test_send_refusals_reach_the_page(duty, monkeypatch):
    # A refusal within 2 seconds reaches the answer; the test shortens that window.
    assert duty_chat_module.ACCEPT_SECONDS == 2.0
    monkeypatch.setattr(duty_chat_module, "ACCEPT_SECONDS", 0.5)
    with duty["start"]() as client:
        duty["configure"](refuse="teamster: no duty account (duty.json is absent or names no account)")
        response = client.post("/api/actions/duty-chat", json={"text": "Hello"})
        assert (response.status_code, response.json()) == (
            422, {"ok": False, "error": "teamster: no duty account (duty.json is absent or names no account)"})
        assert client.get("/api/duty-chat").json()["last_error"] is None
        # A refusal after the acceptance window reaches the view instead.
        duty["configure"](refuse="teamster: the duty chat needs a Claude duty account", refuse_after=1.5)
        assert client.post("/api/actions/duty-chat", json={"text": "Hello"}).json() == {"ok": True, "queued": False}
        error = until(lambda: client.get("/api/duty-chat").json()["last_error"])
        assert error == {"at": pytest.approx(time.time(), abs=30),
                         "text": "teamster: the duty chat needs a Claude duty account"}
        # So does a turn that failed after it started; the next accepted message clears it.
        duty["configure"](late_error="teamster: the duty gave no answer (outcome failed)", start_after=1)
        assert client.post("/api/actions/duty-chat", json={"text": "Again"}).json() == {"ok": True, "queued": False}
        assert client.get("/api/duty-chat").json()["last_error"] is None
        error = until(lambda: client.get("/api/duty-chat").json()["last_error"])
        assert error["text"] == "teamster: the duty gave no answer (outcome failed)"
        duty["configure"]()
        assert client.post("/api/actions/duty-chat", json={"text": "Once more"}).json() == {"ok": True, "queued": False}
        assert client.get("/api/duty-chat").json()["last_error"] is None


def test_two_posts_at_once_start_one_conversation(duty, monkeypatch):
    # The first command creates the conversation only after its answer: the second still finds no state.json.
    monkeypatch.setattr(duty_chat_module, "ACCEPT_SECONDS", 0.5)
    duty["configure"](hold=True, start_after=1.0)
    with duty["start"]() as client:
        set_duty(client)
        with ThreadPoolExecutor(2) as pool:
            answers = list(pool.map(lambda text: client.post("/api/actions/duty-chat", json={"text": text}).json(),
                                    ("One.", "Two.")))
        assert sorted(answer["queued"] for answer in answers) == [False, True]
        records = duty["records"]()
        assert sorted("--queue" in record["argv"] for record in records) == [False, True]
        view = until(lambda: (view := client.get("/api/duty-chat").json())["messages"] and view)
        assert [row["from"] for row in view["messages"]] == ["user"]
        assert [row["text"] for row in view["queued"]] == [records[1]["file"]]
        duty["release"].touch()


def test_websocket_announces_changes_of_the_conversation(duty, monkeypatch):
    monkeypatch.setattr(board_app, "PING_SECONDS", 0.05)
    with duty["start"]() as client:
        with client.websocket_connect("/ws") as socket:
            assert socket.receive_json()["type"] == "snapshot"
            directory = write_conversation(duty["tasks"])

            def next_duty_chat():
                for _ in range(500):
                    message = socket.receive_json()
                    assert message["type"] != "task" or message["task"]["slug"] != "duty"
                    if message["type"] == "duty_chat":
                        return message
                pytest.fail("no duty_chat message")

            def drain():
                """Read until the queue is empty: the server pings only then."""
                time.sleep(0.2)
                while socket.receive_json()["type"] != "ping":
                    pass

            assert set(next_duty_chat()) == {"type", "at"}
            drain()
            # An answer changes only state.json.
            state = json.loads((directory / "state.json").read_text())
            state["duty_turns"].append({"at": 175.0, "turn": 5, "status": "answered", "reply": "Fine."})
            (directory / "state.json").write_text(json.dumps(state))
            next_duty_chat()
            drain()
            (directory / "notes.json").write_text(json.dumps({"held": [{"at": 1.0, "text": "Held.", "source": "note"}]}))
            next_duty_chat()
            (directory / "queue.json").write_text(json.dumps({"waiting": [{"at": 2.0, "text": "Q", "source": "user"}]}))
            next_duty_chat()
            with (directory / "messages.jsonl").open("a") as stream:
                stream.write(json.dumps({"at": 3.0, "text": "New.", "source": "user"}) + "\n")
            next_duty_chat()
            set_duty(client)
            next_duty_chat()


def test_duty_kind_is_absent_from_task_views(duty):
    write_conversation(duty["tasks"], pid=os.getpid())
    archive = duty["tasks"] / ".archive" / "duty-20261110T000000Z"
    archive.mkdir(parents=True)
    (archive / "state.json").write_text(json.dumps({"slug": "duty", "kind": "duty", "repo": "/rooms/duty/room"}))
    started = duty["tasks"] / "fix-parser"
    started.mkdir()
    (started / "state.json").write_text(json.dumps({"slug": "fix-parser", "kind": "work", "repo": "/repos/parser",
                                                    "started_by": "duty", "created": 1.0}))
    (duty["tasks"] / "duty" / "claude-events.jsonl").write_text("")
    with duty["start"]() as client:
        with client.websocket_connect("/ws") as socket:
            tasks = socket.receive_json()["snapshot"]["tasks"]
        assert [(task["slug"], task["started_by"]) for task in tasks] == [("fix-parser", "duty")]
        research = client.get("/api/research").json()
        assert research["pending"]["records"] == 0
        assert research["studies"] == []
        # The running turn's activity stays readable through the task feed.
        assert client.get("/api/tasks/duty/feed").status_code == 200


def test_duty_choice_warnings_timeout_and_shared_capability_probe(tmp_path, monkeypatch):
    from teamster_board import actions as actions_module, duty as duty_module
    from teamster_board.duty import Duty

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    control, calls = tmp_path / "control", tmp_path / "calls"
    control.write_text("{}")
    command = tmp_path / "teamster"
    command.write_text(
        f"#!{sys.executable}\nimport json,os,sys,time\nfrom pathlib import Path\n"
        f"control=json.loads(Path({str(control)!r}).read_text())\n"
        f"with Path({str(calls)!r}).open('a') as stream:\n"
        "    stream.write(json.dumps({'argv':sys.argv[1:],'cwd':os.getcwd(),'stdin':sys.stdin.read()})+'\\n')\n"
        "if sys.argv[1:] == ['--version']:\n    print('teamster 1.87.0')\n    sys.exit(0)\n"
        "time.sleep(control.get('sleep',0))\n"
        "print(control.get('stdout','duty changed'))\n"
        "print(control.get('stderr',''),file=sys.stderr)\n"
        "sys.exit(control.get('code',0))\n"
    )
    command.chmod(0o755)
    settings = Settings(tmp_path, tmp_path / "unused.py", action_teamster=str(command))
    actions = create_app(settings).state.board.actions
    chooser = Duty(actions)
    assert chooser.execute(["set", "pool", "--family", "claude"]) == {"ok": True, "warning": None}
    assert actions.queue() and actions.duty_chat() and actions.duty_choose()
    assert len(calls.read_text().splitlines()) == 2  # The same probe serves all three capabilities.
    control.write_text(json.dumps({"stdout": "duty pinned\nwarning: no weekly room", "stderr": "quota unavailable"}))
    assert chooser.execute(["set", "pool", "--family", "claude"])["warning"] == (
        "warning: no weekly room\nquota unavailable")
    control.write_text(json.dumps({"sleep": 30}))
    monkeypatch.setattr(actions_module, "COMMAND_TIMEOUT", 0.05)
    run = duty_module.subprocess.run
    timeouts = []

    def record_timeout(*args, **kwargs):
        timeouts.append(kwargs["timeout"])
        return run(*args, **kwargs)

    monkeypatch.setattr(duty_module.subprocess, "run", record_timeout)
    timeout = chooser.execute(["tick"])
    assert timeouts == [actions_module.COMMAND_TIMEOUT]
    assert timeout.status_code == 504 and json.loads(timeout.body)["error"] == "timeout"
