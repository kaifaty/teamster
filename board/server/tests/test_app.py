"""Contract checks through the REST and WebSocket interfaces."""

import asyncio
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import anyio
import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse, WebSocketTestSession

from teamster_board import access, actions as actions_module
from teamster_board import landing as landing_module
from teamster_board import app as board_app
from teamster_board import store as store_module
from teamster_board import accounts as accounts_module, logins as logins_module
from teamster_board.app import Settings, create_app
from teamster_board.duty_tasks import task_id
from teamster_board.external_duty import ExternalDutyConfig
from teamster_board.research import Research


SUMMARY_FIELDS = {
    "slug", "kind", "repo", "branch", "task_type", "executor", "account", "reviewer",
    "model", "effort", "column", "phase", "phase_started_at", "alive", "turn", "fix_round",
    "outcome", "result_status", "summary", "pr", "ci", "sleeping_until", "created", "updated_at",
    "activity", "title", "link", "scheduled", "check", "review", "findings_left", "stop", "left",
    "lead_verdict", "lead_verdict_at", "started_by",
}


@pytest.fixture(autouse=True)
def websocket_receive_timeout(monkeypatch):
    def receive(socket):
        async def read():
            with anyio.fail_after(5):
                return await socket._send_rx.receive()
        return socket.portal.call(read)

    monkeypatch.setattr(WebSocketTestSession, "receive", receive)


@pytest.fixture
def board(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_TASK_HOME", str(tmp_path))
    monkeypatch.setattr(board_app, "PING_SECONDS", 0.05)
    fake = tmp_path / "accounts.py"
    fake.write_text(
        "import sys\nassert sys.flags.isolated\n"
        "assert sys.argv[1:] == ['accounts', '--json']\nprint('{\"accounts\": []}')\n"
    )
    settings = Settings(tmp_path, fake, poll_seconds=0.01, web_dist=tmp_path / "dist")
    with subprocess.Popen(["sleep", "30"], stdin=subprocess.DEVNULL) as process:
        directory = tmp_path / "claude-tasks" / "demo"
        directory.mkdir(parents=True)
        state = {
            "slug": "demo", "kind": "work", "repo": str(tmp_path / "repository"), "branch": "demo-branch",
            "executor": "codex", "account": "main", "reviewer": "claude", "pid": process.pid,
            "outcome": "running", "turns": 1, "turn_started": 10.0, "created": 1.0,
        }
        (directory / "state.json").write_text(json.dumps(state))
        application = create_app(settings)
        try:
            with TestClient(application, base_url="http://localhost", headers={"Host": "localhost"}) as client:
                yield client, application, directory, state, settings
        finally:
            process.terminate()


def receive_until(socket, wanted):
    for _ in range(50):
        message = socket.receive_json()
        if message["type"] == wanted:
            return message
    pytest.fail(f"No {wanted} message received")


def test_operator_history_and_live_focus_on_read_only_board(board):
    client, _, directory, state, settings = board
    assert "operator" not in client.get("/api/snapshot").json()
    archive_name = "demo-20261121T120000Z"
    archive = directory.parent / ".archive" / archive_name
    archive.mkdir(parents=True)
    archived = {**state, "created": 0.5, "pid": None, "outcome": "completed"}
    (archive / "state.json").write_text(json.dumps(archived))
    old_id = task_id("demo", archived["created"])
    current_id = task_id("demo", state["created"])
    outside = directory.parent / "other"
    outside.mkdir()
    (outside / "state.json").write_text(json.dumps({
        **state, "slug": "other", "repo": str(settings.task_home / "outside"),
    }))
    path = settings.task_home / "operator.sqlite"
    with closing(sqlite3.connect(path)) as db:
        db.execute("""CREATE TABLE recommendations (
            event_id TEXT, task_id TEXT, turn INTEGER, started_at INTEGER, source TEXT, recommendation TEXT)""")
        db.executemany("INSERT INTO recommendations VALUES (?, ?, ?, ?, ?, ?)", [
            ("old", old_id, 1, 1_000, "mini", f"{old_id}: Review the saved result."),
            ("current", current_id, 2, 2_000, None, None),
            ("outside", task_id("other", state["created"]), 1, 3_000, "mini", "Outside the configured cards."),
        ])
        db.commit()
        read_only = create_app(replace(settings, read_only=True, operator_state=path,
                                       external_duty=ExternalDutyConfig("mini", "test", (state["repo"],), 1, 60)))
        with (TestClient(read_only, base_url="http://localhost", headers={"Host": "localhost"}) as client,
              client.websocket_connect("/ws") as ws):
            activity = ws.receive_json()["snapshot"]["operator"]
            assert activity == {"available": True, "current": None, "history": [
                {"event_id": "old", "task_id": old_id, "slug": archive_name, "title": "demo",
                 "turn": 1, "started_at": 1.0, "source": "mini", "recommendation": "Review the saved result."},
            ]}
            assert client.get(f"/api/tasks/{archive_name}").status_code == 200
            assert client.get("/api/snapshot").json()["operator"] == activity
            with db:
                db.execute("CREATE TABLE reviewing (event_id TEXT, expires_at INTEGER)")
                db.execute("INSERT INTO reviewing VALUES ('current', ?)", (int(time.time() * 1000) + 6_000,))
            active = receive_until(ws, "operator")["operator"]
            assert active["current"] == {"task_id": current_id, "slug": "demo", "title": "demo"}
            with db:
                db.execute("UPDATE reviewing SET expires_at = 0")
            assert receive_until(ws, "operator")["operator"] == activity


def test_stale_days_environment_reaches_store(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_TASK_HOME", str(tmp_path))
    monkeypatch.setenv("BOARD_CODEX_TASK", str(tmp_path / "fake_accounts.py"))
    monkeypatch.delenv("BOARD_STALE_DAYS", raising=False)
    assert Settings.from_env().stale_days == 7
    assert Settings.from_env().duty_seconds == 1800
    monkeypatch.setenv("BOARD_DUTY_SECONDS", "0")
    assert Settings.from_env().duty_seconds == 0
    assert Settings.from_env().teamster == tmp_path / "fake_accounts.py"
    monkeypatch.setenv("BOARD_TEAMSTER_COMMAND", str(tmp_path / "new_accounts.py"))
    assert Settings.from_env().teamster == tmp_path / "new_accounts.py"
    monkeypatch.delenv("BOARD_TEAMSTER_COMMAND")
    monkeypatch.delenv("BOARD_CODEX_TASK")
    assert Settings.from_env().teamster == board_app.REPOSITORY / "src/teamster/__main__.py"
    monkeypatch.setenv("BOARD_STALE_DAYS", "2.5")
    settings = Settings.from_env()
    assert settings.stale_days == 2.5
    assert create_app(settings).state.board.store.stale_days == 2.5


def test_task_feed_rest_cursor_and_unavailable_tasks(board):
    client, _, directory, state, settings = board
    state["pid"] = None
    (directory / "state.json").write_text(json.dumps(state))
    first = client.get("/api/tasks/demo/feed")
    assert first.status_code == 200
    assert first.json()["items"] == []
    path = directory / "events.jsonl"
    event = {"type": "item.completed", "timestamp": 123,
             "item": {"type": "agent_message", "text": "First\nparagraph"}}
    path.write_text(json.dumps(event) + "\n")
    feed = client.get("/api/tasks/demo/feed", params={"after": first.json()["cursor"]}).json()
    assert feed["items"] == [{"at": 123, "kind": "message", "text": "First\nparagraph"}]
    assert feed["reset"] is False and feed["truncated"] is False
    assert client.get("/api/tasks/demo/feed", params={"after": feed["cursor"]}).json()["items"] == []
    assert client.get("/api/tasks/demo/feed", params={"after": "invalid"}).json()["reset"] is True
    archived = settings.path("tasks") / ".archive" / "archived-20261113T000000Z"
    archived.mkdir(parents=True)
    (archived / "state.json").write_text(json.dumps(state))
    for slug in ("unknown", archived.name, "archived"):
        assert client.get(f"/api/tasks/{slug}/feed").status_code == 404


def test_rest_contract_files_and_unknown_paths(board):
    client, application, directory, state, _ = board
    state["result"] = {"summary": "Change completed.\nThis preserves the reason for the change."}
    (directory / "state.json").write_text(json.dumps(state))
    client.portal.call(application.state.board.poll)
    snapshot = client.get("/api/snapshot").json()
    assert set(snapshot) == {"generated_at", "tasks", "accounts", "machines", "logins"}
    assert snapshot["machines"] == {"config_error": None, "items": []}
    assert isinstance(snapshot["generated_at"], float)
    assert len(snapshot["tasks"]) == 1
    assert set(snapshot["tasks"][0]) == SUMMARY_FIELDS
    assert snapshot["tasks"][0]["title"] is None
    assert snapshot["tasks"][0]["link"] is None
    assert snapshot["tasks"][0]["scheduled"] is None
    assert snapshot["tasks"][0]["summary"] == "Change completed."
    assert set(snapshot["accounts"]) == {"fetched_at", "error", "data", "last_logins"}
    for name, filename in (("brief", "brief.md"), ("last", "last.md"),
                           ("review", "review.md"), ("check", "check.log")):
        content = "discard this prefix" + "x" * (256 * 1024)
        (directory / filename).write_text(content)
        response = client.get(f"/api/tasks/demo/files/{name}")
        assert response.status_code == 200
        assert response.headers["content-type"] == "text/plain; charset=utf-8"
        assert response.content == b"x" * (256 * 1024)
    detail = client.get("/api/tasks/demo").json()
    assert set(detail) == SUMMARY_FIELDS | {"timeline", "files", "cargo", "limits", "messages",
                                           "activity_log", "actions", "queue", "report", "changes"}
    assert detail["report"] == state["result"]["summary"]
    assert detail["summary"] == "Change completed."
    assert detail["changes"] is None
    assert detail["actions"] == {**client.get("/api/research").json()["actions"], "queue": False}
    assert detail["queue"] == {"waiting": [], "dropped": []}
    assert set(detail["files"]) == {"brief", "last", "review", "check"}
    assert detail["scheduled"] is None
    assert len(detail["timeline"]) <= 200
    (directory / "last.md").unlink()
    for path in (
        "/api/tasks/unknown", "/api/tasks/unknown/files/brief", "/api/tasks/demo/files/last",
        "/api/tasks/demo/files/state.json", "/api/tasks/demo/files/auth.json",
        "/api/tasks/demo/files/../state.json", "/api/tasks/demo/files/%2e%2e%2fstate.json",
        "/api/tasks/%2e%2e%2fstate.json", "/api/tasks/demo/files/brief/other",
    ):
        assert client.get(path).status_code == 404, path


def test_detail_git_does_not_block_board_polling(board, monkeypatch):
    client, application, directory, state, _ = board
    state.update(worktree=str(directory), base="origin/main")
    (directory / "state.json").write_text(json.dumps(state))
    client.portal.call(application.state.board.poll)
    entered, release = threading.Event(), threading.Event()
    original_run = subprocess.run

    def git(argv, **kwargs):
        if argv[0] != "git":
            return original_run(argv, **kwargs)
        assert argv[:3] == ["git", "-C", str(directory)]
        assert kwargs["stdin"] == subprocess.DEVNULL
        assert kwargs["timeout"] == 5
        entered.set()
        assert release.wait(5)
        output = {"rev-parse": "true\n", "rev-list": "0\n", "diff": "", "status": ""}
        return subprocess.CompletedProcess(argv, 0, stdout=output[argv[3]])

    async def poll_and_snapshot():
        with anyio.fail_after(2):
            await application.state.board.poll()
            return await application.state.board.snapshot()

    monkeypatch.setattr(store_module.subprocess, "run", git)
    with ThreadPoolExecutor(max_workers=1) as executor:
        detail = executor.submit(client.get, "/api/tasks/demo")
        try:
            assert entered.wait(5)
            assert client.portal.call(poll_and_snapshot)["tasks"][0]["slug"] == "demo"
        finally:
            release.set()
        assert detail.result(timeout=5).json()["changes"] == {
            "commits": 0, "files": 0, "insertions": 0, "deletions": 0, "uncommitted": 0}


def test_events_window_limit_and_websocket(board):
    client, application, _, _, settings = board
    now = board_app.time.time()
    since = now - 10000
    rows = [{"at": since + index, "kind": "work", "slug": f"task-{index}", "phase": "turn",
             "tokens": {"total": 123}, "usage": [{"thread": "private"}], "thread": "private"}
            for index in range(5002)]
    rows += [{"at": since - 1, "kind": "work"}, {"at": now + 60, "kind": "scout"}]
    path = settings.path("telemetry")
    # Input order must not determine which events survive the response limit.
    path.write_text("".join(json.dumps(row) + "\n" for row in reversed(rows)))
    client.portal.call(application.state.board.poll)
    result = client.get("/api/events", params={"since": since, "until": since + 5001}).json()
    assert set(result) == {"since", "until", "events", "truncated"}
    assert (result["since"], result["until"], result["truncated"]) == (since, since + 5001, True)
    assert [event["at"] for event in result["events"]] == [since + index for index in range(2, 5002)]
    assert all(not {"tokens", "usage", "thread"} & event.keys() for event in result["events"])
    window = client.get("/api/events", params={"since": since, "until": since + 1}).json()
    assert [event["at"] for event in window["events"]] == [since, since + 1]
    assert "truncated" not in window
    default = client.get("/api/events").json()
    assert default["until"] >= now
    assert default["until"] - default["since"] == 24 * 3600
    assert client.get("/api/events", params={"until": now}).json()["since"] == now - 24 * 3600
    assert client.get("/api/events", params={"since": now - 31 * 86400, "until": now}).status_code == 200
    for params in ({"since": "bad"}, {"since": "nan"}, {"until": "inf"},
                   {"since": now, "until": now - 1}, {"since": now - 31 * 86400 - 1, "until": now}):
        assert client.get("/api/events", params=params).status_code == 422
    with client.websocket_connect("/ws") as socket:
        assert socket.receive_json()["type"] == "snapshot"
        with path.open("a") as stream:
            stream.write(json.dumps({"at": now, "kind": "verdict", "slug": "demo",
                                     "verdict": "accepted", "note": "Ready\nfor review"}) + "\n")
        message = receive_until(socket, "event")
        assert set(message) == {"type", "event"}
        assert message["event"]["at"] == now
        assert message["event"]["slug"] == "demo"
        assert message["event"]["note"] == "Ready for review"


@contextmanager
def login_board(tmp_path, monkeypatch, **options):
    """A started board whose accounts calls are recorded and whose second call can be held."""
    monkeypatch.setenv("CODEX_TASK_HOME", str(tmp_path))
    calls = tmp_path / "accounts-calls"
    fake = tmp_path / "accounts.py"
    fake.write_text(
        "import json\n"
        f"with open({str(calls)!r}, 'a') as stream:\n    stream.write('call\\n')\n"
        f"print(json.dumps({{'calls': len(open({str(calls)!r}).readlines())}}))\n"
    )
    settings = Settings(tmp_path, fake, poll_seconds=0.01, web_dist=tmp_path / "dist", **options)
    journal = settings.path("telemetry")
    now = board_app.time.time()
    journal.write_text(json.dumps({"v": 1, "event": "account_login", "at": now - 60, "family": "codex",
                                   "account": "old", "status": "available"}) + "\n")
    application = create_app(settings)
    board = application.state.board
    starts, release = [], threading.Event()
    refresh = board.accounts.refresh

    async def recorded(force=False):
        starts.append(board_app.time.monotonic())
        if len(starts) == 2:
            while not release.is_set():
                await asyncio.sleep(0.01)
        return await refresh(force=force)

    board.accounts.refresh = recorded

    def login(account):
        with journal.open("a") as stream:
            stream.write(json.dumps({"v": 1, "event": "account_login", "at": board_app.time.time(),
                                     "family": "codex", "account": account, "status": "available"}) + "\n")
        client.portal.call(board.poll)

    def until(predicate):
        deadline = board_app.time.monotonic() + 30
        while not predicate():
            assert board_app.time.monotonic() < deadline
            board_app.time.sleep(0.01)

    try:
        with TestClient(application, base_url="http://localhost", headers={"Host": "localhost"}) as client:
            until(lambda: board.accounts.value["data"] is not None)
            client.portal.call(board.poll)
            # Only the startup refresh: the row already in the journal forces none.
            assert (len(starts), board._login_at) == (1, None)
            yield client, board, login, starts, release, until
    finally:
        release.set()
    assert client.get("/api/events", params={"since": now - 120}).json()["events"] == []


def test_new_login_rows_refresh_accounts_once_per_window(tmp_path, monkeypatch):
    monkeypatch.setattr(board_app, "LOGIN_REFRESH_SECONDS", 1.0)
    with login_board(tmp_path, monkeypatch) as (client, board, login, starts, release, until):
        with client.websocket_connect("/ws") as socket:
            assert socket.receive_json()["snapshot"]["accounts"]["data"] == {"calls": 1}
            login("second")
            # The 300 s throttle does not hold the forced refresh back; it is held here instead.
            until(lambda: len(starts) == 2)
            login("third")
            login("fourth")
            release.set()
            assert receive_until(socket, "accounts")["accounts"]["data"] == {"calls": 2}
            # Both rows were read after the second refresh started; they share one more refresh.
            assert receive_until(socket, "accounts")["accounts"]["data"] == {"calls": 3}
            assert board._login_at is None
            assert len(starts) == 3
            assert starts[2] - starts[1] >= 1.0


def test_a_pending_login_does_not_delay_the_periodic_refresh(tmp_path, monkeypatch):
    with login_board(tmp_path, monkeypatch, accounts_seconds=1) as (client, board, login, starts, release, until):
        release.set()
        login("second")
        until(lambda: len(starts) == 2)
        login("third")
        assert board._login_at > starts[1]
        until(lambda: len(starts) == 3)
        # The periodic refresh comes on time and covers the sign-in read before it started.
        assert 0.9 <= starts[2] - starts[1] < board_app.LOGIN_REFRESH_SECONDS
        assert board._login_at is None


def test_report_arguments_and_cached_envelope(board, tmp_path):
    client, _, _, _, settings = board
    marker = tmp_path / "report-calls"
    settings.teamster.write_text(
        "import sys, json\nfrom pathlib import Path\nassert sys.flags.isolated\n"
        "if sys.argv[1] == 'accounts':\n    print('{}')\nelse:\n"
        "    assert sys.argv[1:] == ['report', '--json', '--since', '2026-11-01', '--by', 'model,executor']\n"
        f"    Path({str(marker)!r}).open('a').write('call\\n')\n"
        "    print(json.dumps({'tasks': 3}))\n"
    )
    params = {"since": "2026-11-01", "by": "model,executor"}
    response = client.get("/api/report", params=params)
    assert response.status_code == 200
    result = response.json()
    assert set(result) == {"fetched_at", "error", "data"}
    assert isinstance(result["fetched_at"], float)
    assert result["error"] is None
    assert result["data"] == {"tasks": 3}
    assert client.get("/api/report", params=params).json() == result
    for invalid in ({}, {"since": "2026-11-01;echo unsafe"},
                    {"since": "2026-11-01", "by": "model,--refresh"}):
        assert client.get("/api/report", params=invalid).status_code == 422
    assert marker.read_text().splitlines() == ["call"]


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1:4321", "[::1]:8787"])
def test_local_hosts_and_origins_are_allowed(board, host):
    client, _, _, _, _ = board
    assert client.get("/api/snapshot", headers={"Host": host}).status_code == 200
    with client.websocket_connect("/ws", headers={"Host": host, "Origin": f"http://{host}"}) as socket:
        assert socket.receive_json()["type"] == "snapshot"


@pytest.mark.parametrize("host", ["evil.example", "localhost.evil", "127.0.0.1.evil:8787"])
def test_foreign_hosts_are_forbidden(board, host):
    client, _, _, _, _ = board
    assert client.get("/api/snapshot", headers={"Host": host}).status_code == 403
    with pytest.raises(WebSocketDenialResponse) as rejected:
        with client.websocket_connect("/ws", headers={"Host": host}):
            pass
    assert rejected.value.status_code == 403


@pytest.mark.parametrize("origin", ["http://evil.example", "http://localhost.evil", "null"])
def test_foreign_websocket_origins_are_forbidden(board, origin):
    client, _, _, _, _ = board
    with pytest.raises(WebSocketDenialResponse) as rejected:
        with client.websocket_connect("/ws", headers={"Origin": origin}):
            pass
    assert rejected.value.status_code == 403


def test_task_chat_requires_board_write_access(board):
    client, _, _, _, settings = board
    for origin, protocols, read_only in (
        ("http://localhost", [], False),
        (None, ["teamster-board-chat"], False),
        ("http://localhost:9000", ["teamster-board-chat"], False),
        ("http://localhost", ["teamster-board-chat"], True),
    ):
        settings.read_only = read_only
        headers = {"Origin": origin} if origin else {}
        if read_only:
            client = TestClient(create_app(settings), base_url="http://localhost", headers={"Host": "localhost"})
        with pytest.raises(WebSocketDenialResponse) as rejected:
            with client.websocket_connect("/ws/tasks/demo/chat", headers=headers, subprotocols=protocols):
                pass
        assert rejected.value.status_code == 403


@pytest.fixture
def fake_opencode(tmp_path):
    agent = tmp_path / "opencode"
    agent.write_text(f"#!{sys.executable}\n" + '''import json, os, sys, time
from pathlib import Path

def send(**message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)

def chunk(text):
    send(method="session/update", params={"sessionId": session, "update": {
         "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}})

root = Path.home()
with (root / "opencode-calls").open("a") as calls:
    print(json.dumps(sys.argv[1:]), file=calls)
if sys.argv[1:] == ["auth", "list", "--format", "json"]:
    print((root / "providers").read_text())
    sys.exit()
if sys.argv[1:] == ["models"]:
    print((root / "models").read_text())
    sys.exit()
assert sys.argv[1:] == (["acp"] if Path(sys.argv[0]).name == "opencode" else [])
session = str(os.getpid())
Path("agent.pid").write_text(session)
owner = Path("task-slug").read_text()
turns = 0
for line in sys.stdin:
    req = json.loads(line)
    method, params = req["method"], req["params"]
    with Path("agent.requests").open("a") as stream:
        stream.write(line)
    if method == "initialize":
        result = {"protocolVersion": 1}
    elif method == "session/new":
        assert params["cwd"] == str(Path.cwd())
        result = {"sessionId": session}
        if (root / "models").exists():
            config = {"id": "model", "category": "model", "name": "Model", "type": "select",
                      "currentValue": "opencode-go/global-model", "options": [
                          {"value": m, "name": m} for m in (root / "models").read_text().splitlines()]}
            result["configOptions"] = [config]
    elif method == "session/set_config_option":
        assert params["sessionId"] == session and params["configId"] == "model"
        if not (root / "keep-default").exists():
            config["currentValue"] = params["value"]
        result = {"configOptions": [config]}
    else:
        assert method == "session/prompt" and params["sessionId"] == session
        turns += 1
        text = params["prompt"][0]["text"]
        chunk(f"{owner} turn {turns}")
        if text == "wait":
            time.sleep(60)
        if text == "ask":
            send(id="permission", method="session/request_permission", params={
                 "sessionId": session, "toolCall": {"toolCallId": "read-1", "title": "Read a file"},
                 "options": [{"optionId": "no", "name": "Deny", "kind": "reject_once"},
                             {"optionId": "yes", "name": "Allow", "kind": "allow_once"}]})
            answer = json.loads(input())
            assert answer["id"] == "permission"
            text = answer["result"]["outcome"]["optionId"]
        chunk(text)
        result = {"stopReason": "end_turn"}
    send(id=req["id"], result=result)
''')
    agent.chmod(0o755)
    return agent


@pytest.fixture
def task_chat_board(tmp_path, monkeypatch, fake_opencode):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CODEX_TASK_HOME", str(tmp_path))
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "git").symlink_to(shutil.which("git"))
    (bin_dir / "python3").symlink_to(sys.executable)
    command = bin_dir / "teamster"
    script = board_app.REPOSITORY / "src/teamster/__main__.py"
    command.write_text(f"#!{sys.executable}\nimport os, sys\nos.execv(sys.executable, "
                       f"[sys.executable, '-I', {str(script)!r}, *sys.argv[1:]])\n")
    command.chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_dir))
    agent = bin_dir / "opencode"
    agent.symlink_to(fake_opencode)

    def git(*args):
        subprocess.run(["git", *args], check=True, capture_output=True)

    accounts = tmp_path / "accounts.py"
    accounts.write_text("print('{}')\n")
    settings = Settings(tmp_path, accounts, action_teamster=str(command), duty_seconds=0)
    repo = tmp_path / "repository"
    git("init", str(repo))
    git("-C", str(repo), "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "commit", "--allow-empty", "-m", "Initial commit")
    for slug, executor in (("demo", "codex"), ("second", "opencode")):
        worktree = settings.path("worktrees") / f"claude-{slug}" / repo.name
        git("-C", str(repo), "worktree", "add", "-b", slug, str(worktree))
        (worktree / "task-slug").write_text(slug)
        task_dir = settings.path("tasks") / slug
        task_dir.mkdir(parents=True)
        (task_dir / "state.json").write_text(json.dumps({
            "slug": slug, "kind": "work", "repo": str(repo), "worktree": str(worktree), "branch": slug,
            "executor": executor, "thread": "existing-worker-thread"}))
    with TestClient(create_app(settings), base_url="http://localhost", headers={"Host": "localhost"}) as client:
        def chat(slug, params=None):
            return client.websocket_connect(f"/ws/tasks/{slug}/chat", headers={"Origin": "http://localhost"},
                                            subprotocols=["teamster-board-chat"], params=params)
        yield chat, settings, agent, client


def test_task_chat_streams_turns_and_reaps_disconnected_agents(task_chat_board):
    chat, settings, agent, _ = task_chat_board
    for slug, executor in (("demo", "codex"), ("second", "opencode")):
        worktree = settings.path("worktrees") / f"claude-{slug}" / "repository"
        with chat(slug) as socket:
            assert socket.receive_json() == {"type": "ready", "executor": executor, "agent": "opencode acp"}
            pid = int((worktree / "agent.pid").read_text())
            socket.send_json({"type": "prompt", "text": "ask"})
            assert socket.receive_json() == {"type": "chunk", "text": f"{slug} turn 1"}
            permission = socket.receive_json()
            assert permission["type"] == "permission" and permission["toolCall"]["title"] == "Read a file"
            assert [option["optionId"] for option in permission["options"]] == ["no", "yes"]
            if slug == "demo":
                socket.send_json({"type": "permission", "id": permission["id"], "optionId": "no"})
                assert socket.receive_json() == {"type": "chunk", "text": "no"}
                assert socket.receive_json() == {"type": "done", "stopReason": "end_turn"}
                socket.send_json({"type": "prompt", "text": "again"})
                assert socket.receive_json() == {"type": "chunk", "text": "demo turn 2"}
                assert socket.receive_json() == {"type": "chunk", "text": "again"}
                assert socket.receive_json() == {"type": "done", "stopReason": "end_turn"}
                socket.send_json({"type": "prompt", "text": "wait"})
                assert socket.receive_json() == {"type": "chunk", "text": "demo turn 3"}
            else:
                os.kill(pid, signal.SIGTERM)
                failure = socket.receive_json()
                assert failure["type"] == "error" and failure["message"]
                assert socket.receive()["type"] == "websocket.close"
        deadline = time.monotonic() + 5
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            assert time.monotonic() < deadline, f"ACP agent {pid} survived closing the chat"
            time.sleep(0.01)

    adapter = agent.with_name("codex-acp")
    adapter.symlink_to(agent)
    with chat("demo") as socket:
        assert socket.receive_json() == {"type": "ready", "executor": "codex", "agent": "codex-acp"}
        socket.send_json({"type": "prompt", "text": "hello", "cwd": str(worktree), "command": "other"})
        assert socket.receive_json()["type"] == "error"
    adapter.unlink()
    agent.unlink()
    with chat("second") as socket:
        failure = socket.receive_json()
        assert failure["type"] == "error" and "install" in failure["message"].lower()
    path = settings.path("tasks") / "demo" / "state.json"
    state = json.loads(path.read_text())
    state["worktree"] = str(worktree)  # Another task's checkout may still exist.
    path.write_text(json.dumps(state))
    with chat("demo") as socket:
        failure = socket.receive_json()
        assert failure["type"] == "error" and "worktree" in failure["message"].lower()


def test_websocket_snapshot_then_task_activity_and_archive(board):
    client, _, directory, state, _ = board
    with client.websocket_connect("/ws") as socket:
        first = socket.receive_json()
        assert first["type"] == "snapshot"
        assert first["snapshot"]["tasks"][0]["slug"] == "demo"
        state["turns"] = 2
        (directory / "state.json").write_text(json.dumps(state))
        changed = receive_until(socket, "task")
        assert changed["task"]["turn"] == 2
        event = {"type": "item.started", "item": {"type": "command_execution", "command": "git status"}}
        events = directory / "events.jsonl"
        events.write_text(json.dumps(event) + "\n")
        activity = receive_until(socket, "activity")
        assert activity == {"type": "activity", "slug": "demo",
                            "activity": {"at": events.stat().st_mtime, "kind": "command", "text": "git status"}}
        snapshot = client.get("/api/snapshot").json()
        assert snapshot["tasks"][0]["activity"] == activity["activity"]
        archived = directory.parent / ".archive" / "demo-20261105"
        archived.parent.mkdir()
        directory.rename(archived)
        removed = receive_until(socket, "task_removed")
        assert removed == {"type": "task_removed", "slug": "demo"}
        closed = receive_until(socket, "task")
        assert closed["task"]["slug"] == archived.name
        assert closed["task"]["column"] == "closed"
        assert client.get(f"/api/tasks/{archived.name}").status_code == 200


def test_websocket_ignores_messages_and_sends_only_changes(board):
    client, _, _, _, _ = board
    with client.websocket_connect("/ws") as socket:
        assert socket.receive_json()["type"] == "snapshot"
        socket.send_text("ignored client input")
        message = socket.receive_json()
        if message["type"] == "accounts":
            assert message["accounts"]["data"] == {"accounts": []}
            message = socket.receive_json()
        assert message["type"] == "ping"
        assert isinstance(message["at"], float)


def test_static_app_and_spa_fallback_use_temporary_dist(board):
    client, _, _, _, settings = board
    assert "build" in client.get("/").text.lower()
    settings.web_dist.mkdir()
    (settings.web_dist / "index.html").write_text("<main>Temporary board</main>")
    (settings.web_dist / "app.js").write_text("console.log('temporary');")
    assert client.get("/").text == "<main>Temporary board</main>"
    assert client.get("/tasks/demo").text == "<main>Temporary board</main>"
    assert client.get("/app.js").text == "console.log('temporary');"
    assert client.get("/api/not-a-route").status_code == 404


def test_symlinks_do_not_expose_other_files(board, tmp_path):
    client, application, directory, _, _ = board
    outside = tmp_path / "unrelated.txt"
    outside.write_text("not a task document")
    (directory / "brief.md").symlink_to(outside)
    assert client.get("/api/tasks/demo/files/brief").status_code == 404
    alias = directory.parent / "alias"
    alias.symlink_to(directory, target_is_directory=True)
    client.portal.call(application.state.board.poll)
    assert client.get("/api/tasks/alias").status_code == 404


def test_session_environment_defaults_and_store_overrides(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_TASK_HOME", str(tmp_path / "tasks"))
    monkeypatch.setenv("BOARD_CODEX_TASK", str(tmp_path / "accounts.py"))
    for name in ("BOARD_CLAUDE_DESKTOP_DIR", "BOARD_CLAUDE_HOME", "BOARD_SESSIONS_SECONDS",
                 "BOARD_SESSION_STALE_HOURS"):
        monkeypatch.delenv(name, raising=False)
    defaults = Settings.from_env()
    assert defaults.claude_desktop_dir == Path.home() / "Library/Application Support/Claude"
    assert defaults.claude_home == Path.home() / ".claude"
    assert defaults.sessions_seconds == 5
    assert defaults.session_stale_hours == 48
    monkeypatch.setenv("BOARD_CLAUDE_DESKTOP_DIR", str(tmp_path / "desktop"))
    monkeypatch.setenv("BOARD_CLAUDE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("BOARD_SESSIONS_SECONDS", "2.5")
    monkeypatch.setenv("BOARD_SESSION_STALE_HOURS", "12")
    settings = Settings.from_env()
    assert settings.claude_desktop_dir == tmp_path / "desktop"
    assert settings.claude_home == tmp_path / "home"
    store = create_app(settings).state.board.store
    assert store.sessions_seconds == 2.5
    assert store.session_stale_hours == 12


def test_machine_environment_and_websocket(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_TASK_HOME", str(tmp_path))
    monkeypatch.delenv("BOARD_MACHINES_FILE", raising=False)
    monkeypatch.delenv("BOARD_MACHINES_SECONDS", raising=False)
    defaults = Settings.from_env()
    assert defaults.machines_seconds == 30
    assert create_app(defaults).state.board.machines.path == tmp_path / "board-machines.json"
    config = tmp_path / "machines.json"
    target = "private-target.example"
    config.write_text(json.dumps({"machines": [{"id": "worker", "name": "Worker", "ssh": target}]}))
    fake = tmp_path / "fake-ssh"
    fake.write_text("#!/usr/bin/env python3\nimport sys\nsys.stdin.read()\n"
                    f"print({target!r}, file=sys.stderr)\nsys.exit(255)\n")
    fake.chmod(0o700)
    accounts = tmp_path / "accounts.py"
    accounts.write_text("print('{}')\n")
    monkeypatch.setenv("BOARD_CODEX_TASK", str(accounts))
    monkeypatch.setenv("BOARD_CLAUDE_HOME", str(tmp_path / "claude"))
    monkeypatch.setenv("BOARD_CLAUDE_DESKTOP_DIR", str(tmp_path / "desktop"))
    monkeypatch.setenv("BOARD_MACHINES_FILE", str(config))
    monkeypatch.setenv("BOARD_MACHINES_SECONDS", "0.05")
    settings = Settings.from_env()
    settings.ssh_command = str(fake)
    assert settings.machines_file == config
    assert settings.machines_seconds == 0.05
    application = create_app(settings)
    with TestClient(application, base_url="http://localhost", headers={"Host": "localhost"}) as client:
        with client.websocket_connect("/ws") as socket:
            first = socket.receive_json()
            assert "machines" in first["snapshot"]
            # A config error changes the payload even if the first probe already completed.
            config.write_text('{"machines": [')
            for _ in range(50):
                message = receive_until(socket, "machines")
                if message["machines"]["config_error"] is not None:
                    break
            else:
                pytest.fail("No machine config error received")
            item = message["machines"]["items"][0]
            assert item["error"] == "unreachable"
            assert item["status"] == "offline"
        response = client.get("/api/snapshot")
        assert target not in response.text
        assert target not in json.dumps(message)
        assert response.json()["machines"]["items"][0]["metrics"] is None


def test_session_rest_websocket_status_activity_and_removal(tmp_path):
    desktop = tmp_path / "desktop"
    home = tmp_path / "home"
    directory = desktop / "claude-code-sessions" / "account" / "device"
    directory.mkdir(parents=True)
    metadata = directory / "local_example.json"
    state = {"sessionId": "local_example", "cliSessionId": "cli-example", "title": "Example session",
             "cwd": "/tmp/project", "originCwd": "/tmp/project", "model": "claude-model",
             "effort": "high", "isArchived": False, "createdAt": 1000,
             "lastActivityAt": 1793872800000, "completedTurns": 1,
             "interruptedAwaitingPerson": None, "prs": [], "private": "metadata secret"}
    metadata.write_text(json.dumps(state))
    live_dir = home / "sessions"
    live_dir.mkdir(parents=True)
    live_path = live_dir / f"{os.getpid()}.json"
    live = {"pid": os.getpid(), "sessionId": "cli-example", "cwd": "/tmp/project",
            "status": "idle", "statusUpdatedAt": 1793872801000, "entrypoint": "desktop",
            "private": "live state secret"}
    live_path.write_text(json.dumps(live))
    transcript = home / "projects" / "-tmp-project" / "cli-example.jsonl"
    transcript.parent.mkdir(parents=True)
    fake = tmp_path / "accounts.py"
    fake.write_text("print('{}')\n")
    settings = Settings(tmp_path / "tasks", fake, poll_seconds=3600,
                        claude_desktop_dir=desktop, claude_home=home, sessions_seconds=0)
    application = create_app(settings)
    with TestClient(application, base_url="http://localhost", headers={"Host": "localhost"}) as client:
        snapshot = client.get("/api/snapshot").json()
        assert len(snapshot["tasks"]) == 1
        task = snapshot["tasks"][0]
        assert set(task) == SUMMARY_FIELDS
        assert task["kind"] == "session"
        assert task["alive"] is False
        assert client.get("/api/project-tasks").json()["tasks"] == []
        card = client.post("/api/actions/project-task", json={
            "project": "project", "title": "Ship the update", "sessions": ["local_example"],
        }, headers={"Origin": "http://localhost", "X-Teamster-Board": "1"}).json()["task"]
        assert card["session_slugs"] == {"local_example": "local_example"}
        detail = client.get("/api/tasks/local_example").json()
        assert set(detail) == SUMMARY_FIELDS | {"timeline", "files", "cargo", "limits", "messages",
                                               "activity_log", "actions", "queue", "report", "changes"}
        assert detail["report"] is detail["changes"] is None
        assert detail["limits"] is None
        assert detail["messages"] == detail["activity_log"] == []
        assert detail["queue"] == {"waiting": [], "dropped": []}
        assert detail["actions"] == {**client.get("/api/research").json()["actions"], "queue": False}
        assert detail["files"] == []
        assert len(detail["timeline"]) == 2
        assert "secret" not in json.dumps(detail)
        for path in ("/api/tasks/local_example/files/brief", "/api/tasks/local_example/files/state.json",
                     "/api/tasks/%2e%2e%2fx", "/api/tasks/%2e%2e%2fx/files/brief"):
            assert client.get(path).status_code == 404
        with client.websocket_connect("/ws") as socket:
            assert socket.receive_json()["type"] == "snapshot"
            live["status"] = "busy"
            live_path.write_text(json.dumps(live))
            client.portal.call(application.state.board.poll)
            changed = receive_until(socket, "task")
            assert changed["task"]["slug"] == "local_example"
            assert changed["task"]["alive"] is True
            assert changed["task"]["column"] == "running"
            event = {"type": "assistant", "timestamp": "2026-11-05T10:00:02Z",
                     "message": {"content": [{"type": "text", "text": "First update"}]}}
            transcript.write_text(json.dumps(event) + "\n")
            client.portal.call(application.state.board.poll)
            activity = receive_until(socket, "activity")
            assert activity == {"type": "activity", "slug": "local_example",
                                "activity": {"at": 1793872802.0, "kind": "message", "text": "First update"}}
            detail = client.get("/api/tasks/local_example").json()
            assert detail["limits"] is None
            assert detail["messages"] == detail["activity_log"] == []
            event["message"]["content"][0]["text"] = "Appended update"
            with transcript.open("a") as stream:
                stream.write(json.dumps(event) + "\n")
            client.portal.call(application.state.board.poll)
            assert receive_until(socket, "activity")["activity"]["text"] == "Appended update"
            state["isArchived"] = True
            metadata.write_text(json.dumps(state))
            client.portal.call(application.state.board.poll)
            assert receive_until(socket, "task_removed") == {"type": "task_removed", "slug": "local_example"}
            assert client.get("/api/tasks/local_example").status_code == 404
            assert card["sessions"] == ["local_example"]
            assert client.get("/api/project-tasks").json()["tasks"] == [dict(card, session_slugs={})]
            state["isArchived"] = False
            metadata.write_text(json.dumps(state))
            client.portal.call(application.state.board.poll)
            assert receive_until(socket, "task")["task"]["slug"] == "local_example"
            metadata.unlink()
            client.portal.call(application.state.board.poll)
            assert receive_until(socket, "task_removed")["slug"] == "local_example"


@pytest.mark.parametrize("layout", ["legacy", "new", "marker", "teamster"])
def test_data_home_layouts(tmp_path, monkeypatch, layout):
    home = tmp_path / "user"
    monkeypatch.setenv("HOME", str(home))
    for name in ("TEAMSTER_HOME", "CODEX_TASK_HOME", "BOARD_MACHINES_FILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BOARD_CODEX_TASK", str(tmp_path / "accounts.py"))
    codex = home / ".codex"
    data = codex if layout == "legacy" else tmp_path / "data" if layout != "new" else home / ".teamster"
    data.mkdir(parents=True)
    codex.mkdir(parents=True, exist_ok=True)
    if layout == "marker":
        (codex / "teamster-home").write_text(f"{data}\n")
        monkeypatch.setenv("CODEX_TASK_HOME", str(codex))
    elif layout == "teamster":
        monkeypatch.setenv("TEAMSTER_HOME", str(data))
    directory = data / ("claude-tasks" if layout == "legacy" else "tasks") / "demo"
    directory.mkdir(parents=True)
    (directory / "state.json").write_text(json.dumps({
        "slug": "demo", "kind": "work", "repo": "/tmp/repository", "branch": "demo-branch",
        "executor": "codex", "account": "main", "pid": None, "outcome": "idle", "turns": 1, "created": 1.0}))
    settings = Settings.from_env()
    assert (settings.task_home, settings.layout) == (data, "legacy" if layout == "legacy" else "new")
    board = create_app(settings).state.board
    assert board.machines.path == data / "board-machines.json"
    log = data / ("codex-worker-log.jsonl" if layout == "legacy" else "log.jsonl")
    assert board.store.telemetry_path == log
    now = board_app.time.time()
    log.write_text(json.dumps({"at": now, "kind": "work", "slug": "demo", "phase": "turn"}) + "\n")
    board.store.poll()
    assert [task["slug"] for task in board.store.summaries()] == ["demo"]
    assert board.store.events(now, now)["events"][0]["slug"] == "demo"


def write_art(settings, repo="alpha", pictures=None):
    directory = settings.task_home / "board-art" / repo
    directory.mkdir(parents=True)
    for name, content in (pictures or {"sky.jpg": b"sky", "planet.png": b"planet", "emblem.png": b"emblem"}).items():
        (directory / name).write_bytes(content)
    return directory


def test_art_index_is_empty_without_the_directory(board):
    client, _, _, _, _ = board
    assert client.get("/api/art").json() == {}


def test_art_index_lists_only_pictures_that_exist(board):
    client, _, _, _, settings = board
    directory = write_art(settings)
    write_art(settings, "only emblem", {"emblem.png": b"emblem"})
    (settings.task_home / "board-art" / "empty").mkdir()
    (settings.task_home / "board-art" / ".hidden").mkdir()
    (settings.task_home / "board-art" / "loose.png").write_bytes(b"file")
    (directory / "notes.txt").write_text("not art")

    index = client.get("/api/art").json()

    assert sorted(index) == ["alpha", "only emblem"]
    assert sorted(index["alpha"]) == ["emblem", "planet", "sky"]
    version = (directory / "sky.jpg").stat().st_mtime_ns
    assert index["alpha"]["sky"] == f"/api/art/alpha/sky.jpg?v={version}"
    assert list(index["only emblem"]) == ["emblem"]
    assert index["only emblem"]["emblem"].startswith("/api/art/only%20emblem/emblem.png?v=")
    assert client.get(index["only emblem"]["emblem"]).content == b"emblem"


def test_art_url_changes_with_the_file(board):
    client, _, _, _, settings = board
    directory = write_art(settings, pictures={"planet.png": b"old"})
    before = client.get("/api/art").json()["alpha"]["planet"]
    os.utime(directory / "planet.png", ns=(1, 1))
    assert client.get("/api/art").json()["alpha"]["planet"] != before


@pytest.mark.parametrize("name, kind, content", [
    ("sky.jpg", "image/jpeg", b"sky"), ("planet.png", "image/png", b"planet"), ("emblem.png", "image/png", b"emblem"),
])
def test_art_is_served_with_its_fixed_type(board, name, kind, content):
    client, _, _, _, settings = board
    write_art(settings)
    response = client.get(f"/api/art/alpha/{name}")
    assert response.status_code == 200
    assert response.headers["content-type"] == kind
    assert response.content == content


def test_art_reads_from_a_new_layout_data_home(board, tmp_path):
    _, _, _, _, settings = board
    home = tmp_path / "home"
    new = Settings(home, settings.teamster, web_dist=tmp_path / "dist", layout="new")
    write_art(new)
    with TestClient(create_app(new), base_url="http://localhost", headers={"Host": "localhost"}) as client:
        assert client.get("/api/art/alpha/planet.png").content == b"planet"


def test_art_route_is_read_only(board):
    client, _, _, _, settings = board
    write_art(settings)
    assert client.put("/api/art/alpha/sky.jpg", content=b"x").status_code == 405
    assert client.delete("/api/art/alpha/sky.jpg").status_code == 405


@pytest.mark.parametrize("path", [
    "/api/art/alpha/notes.txt",
    "/api/art/alpha/planet.jpg",
    "/api/art/missing/sky.jpg",
    "/api/art/.hidden/sky.jpg",
    "/api/art/%2e%2e/sky.jpg",
    "/api/art/..%2f..%2fclaude-tasks/sky.jpg",
    "/api/art/alpha/..%2fsecret.png",
    "/api/art/alpha%5c..%5c/sky.jpg",
])
def test_art_refuses_other_paths(board, path):
    client, _, _, _, settings = board
    directory = write_art(settings)
    (directory / "notes.txt").write_text("not art")
    (directory.parent / ".hidden").mkdir()
    (directory.parent / ".hidden" / "sky.jpg").write_bytes(b"hidden")
    (settings.task_home / "sky.jpg").write_bytes(b"outside")
    (directory.parent / "secret.png").write_bytes(b"outside")
    assert client.get(path).status_code == 404


def test_art_follows_no_symbolic_links(board, tmp_path):
    client, _, _, _, settings = board
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "sky.jpg").write_bytes(b"outside")
    directory = write_art(settings, pictures={"planet.png": b"planet"})
    (directory / "sky.jpg").symlink_to(outside / "sky.jpg")
    (directory.parent / "linked").symlink_to(outside, target_is_directory=True)

    assert client.get("/api/art/alpha/sky.jpg").status_code == 404
    assert client.get("/api/art/linked/sky.jpg").status_code == 404
    assert client.get("/api/art").json().keys() == {"alpha"}
    assert client.get("/api/art").json()["alpha"].keys() == {"planet"}


def test_art_root_may_not_be_a_symbolic_link(board, tmp_path):
    client, _, _, _, settings = board
    outside = tmp_path / "outside"
    (outside / "alpha").mkdir(parents=True)
    (outside / "alpha" / "sky.jpg").write_bytes(b"outside")
    (settings.task_home / "board-art").symlink_to(outside, target_is_directory=True)

    assert client.get("/api/art").json() == {}
    assert client.get("/api/art/alpha/sky.jpg").status_code == 404


def test_art_needs_a_localhost_host_header(board):
    client, _, _, _, settings = board
    write_art(settings)
    assert client.get("/api/art", headers={"Host": "example.com"}).status_code == 403
    assert client.get("/api/art/alpha/sky.jpg", headers={"Host": "example.com"}).status_code == 403


def test_research_route_defaults_environment_and_safety(board, tmp_path, monkeypatch):
    client, application, _, _, settings = board
    research = application.state.board.research
    research.view()
    research._repos_thread.join(5)
    assert client.get("/api/research").json() == {
        "lessons": [], "repos": [], "repos_access": "ok", "batch": None,
        "pending": {"records": 0, "signals": 0, "repos": {}, "items": []},
        "studies": [], "reflection_task": "codex-batch-reflection", "schedule": None,
        "actions": application.state.board.actions.value, "launches": []}
    assert client.post("/api/research").status_code == 405
    assert client.delete("/api/research").status_code == 405
    assert client.get("/api/research", headers={"Host": "evil.example"}).status_code == 403
    for name in ("BOARD_RESEARCH_SECONDS", "BOARD_REFLECTION_TASK"):
        monkeypatch.delenv(name, raising=False)
    defaults = Settings.from_env()
    assert (defaults.research_seconds, defaults.reflection_task) == (30, "codex-batch-reflection")
    monkeypatch.setenv("BOARD_RESEARCH_SECONDS", "5")
    monkeypatch.setenv("BOARD_REFLECTION_TASK", "weekly-review")
    monkeypatch.setenv("BOARD_CLAUDE_DESKTOP_DIR", str(tmp_path / "desktop"))
    research = create_app(Settings.from_env()).state.board.research
    assert (research.seconds, research.reflection_task) == (5, "weekly-review")
    assert research.tasks_path == tmp_path / "claude-tasks"
    assert research.claude_desktop_dir == tmp_path / "desktop"


def test_research_startup_warms_once_and_first_request_waits(tmp_path, monkeypatch):
    started, requested, finish = threading.Event(), threading.Event(), threading.Event()
    calls, scans = [], []
    original_view, original_scan = Research.view, Research._scan

    def view(self):
        calls.append(threading.get_ident())
        if len(calls) == 2:
            requested.set()
        return original_view(self)

    def scan(self):
        scans.append(threading.get_ident())
        started.set()
        assert finish.wait(5)
        return original_scan(self)

    monkeypatch.setattr(Research, "view", view)
    monkeypatch.setattr(Research, "_scan", scan)
    fake = tmp_path / "accounts.py"
    fake.write_text("print('{}')\n")
    application = create_app(Settings(tmp_path, fake, web_dist=tmp_path / "dist"))
    with TestClient(application, base_url="http://localhost") as client:
        try:
            assert started.wait(5)
            assert len(calls) == len(scans) == 1
            assert scans[0] != client.portal.call(threading.get_ident)
            assert client.get("/api/snapshot").status_code == 200
            with ThreadPoolExecutor(max_workers=1) as pool:
                response = pool.submit(client.get, "/api/research")
                try:
                    assert requested.wait(5)
                    assert len(calls) == 2 and len(scans) == 1
                    assert not response.done()
                finally:
                    finish.set()
                assert response.result(timeout=5).status_code == 200
            assert client.get("/api/research").status_code == 200
            assert len(calls) == 3 and len(scans) == 1
        finally:
            finish.set()


def test_research_startup_and_requests_do_not_wait_for_repository_disk(tmp_path, monkeypatch):
    started, release = threading.Event(), threading.Event()
    repo = tmp_path / "repository"
    (repo / ".git").mkdir(parents=True)
    (repo / ".git" / "config").write_text('[remote "origin"]\nurl = https://example.com/repo\n')
    fake = tmp_path / "accounts.py"
    fake.write_text("print('{}')\n")
    settings = Settings(tmp_path / "data", fake, layout="new", research_seconds=3600,
                        web_dist=tmp_path / "dist")
    directory = settings.path("tasks") / "known-repo"
    directory.mkdir(parents=True)
    (directory / "state.json").write_text(json.dumps({"repo": str(repo)}))
    original = os.open
    probes = []

    def probe(path, flags, *args, **kwargs):
        if path == repo / ".git":
            probes.append(path)
            started.set()
            release.wait()
        return original(path, flags, *args, **kwargs)

    monkeypatch.setattr(access.os, "open", probe)
    application = create_app(settings)
    research = application.state.board.research
    with TestClient(application, base_url="http://localhost") as client:
        with ThreadPoolExecutor(max_workers=1) as pool:
            try:
                assert started.wait(5)
                worker = research._repos_thread
                assert worker.daemon
                for _ in range(3):
                    research.invalidate()
                    before = time.monotonic()
                    response = pool.submit(client.get, "/api/research").result(timeout=1)
                    assert time.monotonic() - before < 1
                    assert response.status_code == 200
                    assert response.json()["repos"] == []
                    assert response.json()["repos_access"] == "scanning"
                    assert research._repos_thread is worker
                assert probes == [repo / ".git"]
            finally:
                release.set()
                if research._repos_thread is not None:
                    research._repos_thread.join(5)
        assert not worker.is_alive()
        ready = client.get("/api/research").json()
        assert ready["repos"] == [{"name": repo.name, "path": str(repo)}]
        assert ready["repos_access"] == "ok"
        research.invalidate()
        assert client.get("/api/research").json()["repos"] == ready["repos"]
        assert research._repos_thread is worker
        started.clear()
        release.clear()
        research._next_repos_scan = 0
        with ThreadPoolExecutor(max_workers=1) as pool:
            try:
                response = pool.submit(client.get, "/api/research").result(timeout=1)
                assert started.wait(5)
                assert response.json()["repos"] == ready["repos"]
                assert response.json()["repos_access"] == "ok"
                assert research._repos_thread is not worker
            finally:
                release.set()
                research._repos_thread.join(5)


def test_constellations_come_from_the_data_home(board):
    client, _, _, _, settings = board
    assert client.get("/api/constellations").json() == {"constellations": [], "error": None}
    (settings.task_home / "board-constellations.json").write_text(
        json.dumps({"constellations": [{"name": "MyWallet", "repos": ["mytonwallet-*"]}]}))
    assert client.get("/api/constellations").json() == {
        "constellations": [{"name": "MyWallet", "repos": ["mytonwallet-*"]}], "error": None}
    assert client.put("/api/constellations", content=b"{}").status_code == 405


def test_project_tasks_follow_managed_work_and_survive_restart(board):
    client, app, directory, state, settings = board
    read, write = "/api/project-tasks", "/api/actions/project-task"
    client.headers.update({"Origin": "http://localhost", "X-Teamster-Board": "1"})
    github = {"provider": "github", "url": "https://github.com/team/repo/pull/7"}
    forgejo = {"provider": "forgejo", "url": "http://forge.internal:3000/team/repo/pulls/19"}
    for slug, kind, pid in (("survey", "scout", state["pid"]), ("finished-survey", "scout", None),
                            ("study", "reflect", state["pid"]), ("duty", "duty", state["pid"])):
        other = directory.parent / slug
        other.mkdir()
        other_state = dict(state, slug=slug, kind=kind, pid=pid, outcome="completed" if pid is None else "running")
        (other / "state.json").write_text(json.dumps(other_state))
    state.update(pid=None, outcome="completed", result={"status": "done"}, publish={"pr": github["url"]})
    (directory / "state.json").write_text(json.dumps(state))
    os.utime(directory / "state.json", (1, 1))
    biome = write_art(settings, "repository", {"biome.txt": b"tundra\n"}) / "biome.txt"
    (write_art(settings, "other") / "biome.txt").symlink_to(biome)
    client.portal.call(app.state.board.poll)
    assert client.get("/api/tasks/demo").json()["column"] == "closed"
    view = client.get(read).json()
    assert view["writable"] and view["biomes"] == {"repository": "tundra"}
    sources = {row["source_slug"]: row for row in view["tasks"]}
    assert {slug: row["status"] for slug, row in sources.items()} == {"demo": "ready", "survey": "active"}
    demo = sources["demo"]
    assert demo["pull_requests"] == [github]
    assert not (settings.task_home / "board-project-tasks.sqlite3").exists()

    refs = demo["sessions"] + sources["survey"]["sessions"]
    card = client.post(write, json={"project": "repository", "title": "Ship the feature",
                                    "sessions": ["demo", "survey", "demo"],
                                    "pull_requests": [forgejo, forgejo]}).json()["task"]
    assert card["sessions"] == refs and card["source_slug"] == "demo"
    assert card["session_slugs"] == {demo["id"]: "demo", sources["survey"]["id"]: "survey"}
    assert card["pull_requests"] == [forgejo, github] and card["status"] == "active"
    assert client.get(read).json()["tasks"] == [card]
    # Pin the published link too, then archive the work with a different publication.
    card = client.post(write, json={"id": card["id"], "pull_requests": [github, forgejo],
                                    "status": "ready"}).json()["task"]
    later = dict(github, url=github["url"] + "1")
    state["publish"]["pr"] = later["url"]
    (directory / "state.json").write_text(json.dumps(state))
    archive = directory.parent / ".archive"
    archive.mkdir(exist_ok=True)
    for slug in ("demo", "survey"):
        (directory.parent / slug).rename(archive / (slug + "-20261120T000000Z"))
    # Push both linked records beyond the ordinary Board's 50-record archive window.
    for index in range(50):
        newer = archive / f"recent-{index}-20261121T000000Z"
        newer.mkdir()
        (newer / "state.json").write_text("{}")
    settings.action_teamster = None
    with TestClient(create_app(settings), base_url="http://localhost", headers=dict(client.headers)) as restarted:
        archives = {ref: slug + "-20261120T000000Z" for ref, slug in card["session_slugs"].items()}
        saved = dict(card, source_slug=None, session_slugs=archives, pull_requests=[github, forgejo, later])
        assert restarted.get(read).json() == {"tasks": [saved], "writable": True, "biomes": view["biomes"]}
        directory.mkdir()
        (directory / "state.json").write_text(json.dumps(dict(state, created=100)))
        restarted.portal.call(restarted.app.state.board.poll)
        rows = restarted.get(read).json()["tasks"]
        assert saved in rows
        new, = [row for row in rows if row["source_slug"] == "demo"]
        assert new["id"] != demo["id"] and new["sessions"][0] not in refs
        settings.path("telemetry").write_text(json.dumps({
            "kind": "verdict", "repo": "repository", "slug": "demo", "created": 100, "at": 200, "verdict": "accepted",
        }) + "\n")
        restarted.portal.call(restarted.app.state.board.poll)
        assert restarted.get(read).json()["tasks"] == [saved]
        cleared = restarted.post(write, json={"id": card["id"], "sessions": [], "pull_requests": []}).json()["task"]
        assert cleared == dict(saved, sessions=[], session_slugs={}, pull_requests=[])
        linked = restarted.post(write, json={"id": card["id"],
                                             "sessions": [archives[demo["id"]], "demo"]}).json()["task"]
        assert linked["sessions"] == [demo["id"], new["id"]]
        assert linked["session_slugs"] == {demo["id"]: archives[demo["id"]], new["id"]: "demo"}
        assert [restarted.get("/api/tasks/" + linked["session_slugs"][ref]).json()["created"]
                for ref in linked["sessions"]] == [state["created"], 100]


def test_project_task_links_and_write_protection(board):
    client, app, directory, state, settings = board
    read, write = "/api/project-tasks", "/api/actions/project-task"
    client.headers.update({"Origin": "http://localhost", "X-Teamster-Board": "1"})
    state.update(pid=None, outcome="completed", result={"status": "needs_decision", "questions": ["Which release?"]})
    (directory / "state.json").write_text(json.dumps(state))
    os.utime(directory / "state.json", (1, 1))
    client.portal.call(app.state.board.poll)
    decision, = client.get(read).json()["tasks"]
    assert decision["status"] == "needs_input"
    state["result"] = {"status": "done"}
    (directory / "state.json").write_text(json.dumps(state))
    client.portal.call(app.state.board.poll)
    work, = client.get(read).json()["tasks"]
    assert work["status"] == "ready" and work["id"] == decision["id"]
    child = work["id"]
    with client.websocket_connect("/ws") as socket:
        assert socket.receive_json()["type"] == "snapshot"
        parent = client.post(write, json={"project": "repository", "title": "Release notes",
                                          "depends_on": [child, child]}).json()["task"]["id"]
        assert receive_until(socket, "project_tasks_changed") == {"type": "project_tasks_changed"}
    # Opposite edges in different graphs are valid. Save independent edits through concurrent connections.
    with ThreadPoolExecutor(2) as pool:
        replies = list(pool.map(lambda body: client.post(write, json=body), [
            {"id": child, "parent_id": parent}, {"id": parent, "title": "Publish release notes"},
        ]))
    assert [reply.status_code for reply in replies] == [200, 200]
    for at, verdict, status in ((200, "accepted", "done"), (300, "dropped", "cancelled")):
        with settings.path("telemetry").open("a") as journal:
            journal.write(json.dumps({"kind": "verdict", "repo": "repository", "slug": "demo",
                                      "created": state["created"], "at": at, "verdict": verdict}) + "\n")
        client.portal.call(app.state.board.poll)
        rows = {row["id"]: row for row in client.get(read).json()["tasks"]}
        assert rows[parent]["depends_on"] == [child] and rows[parent]["title"] == "Publish release notes"
        assert (rows[child]["parent_id"], rows[child]["status"]) == (parent, status)
    for change in ({"id": parent, "parent_id": child}, {"id": child, "depends_on": [parent]},
                   {"id": child, "parent_id": child}, {"id": child, "depends_on": ["missing"]},
                   {"id": child, "sessions": ["missing"]},
                   {"id": child, "pull_requests": [{"provider": "github", "url": "javascript:alert(1)"}]}):
        assert client.post(write, json=change).status_code == 400
    assert client.post(write, json={"id": "missing", "title": "Update"}).status_code == 404
    for headers in ({"Origin": "http://foreign.test"}, {"Content-Type": "text/plain"}, {"X-Teamster-Board": "0"}):
        assert client.post(write, json={"id": child, "status": "active"}, headers=headers).status_code == 403
    rows[child] = client.post(write, json={"id": child, "status": "blocked"}).json()["task"]
    assert rows[child]["status"] == "blocked"
    settings.read_only = True
    with TestClient(create_app(settings), base_url="http://localhost", headers=dict(client.headers)) as locked:
        denied = locked.post(write, json={"id": child, "status": "active"})
        assert denied.status_code == 403 and denied.json()["error"] == "read_only"
        view = locked.get(read).json()
        assert not view["writable"] and {row["id"]: row for row in view["tasks"]} == rows


@pytest.fixture
def station(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    data = home / ".teamster"
    monkeypatch.setenv("TEAMSTER_HOME", str(data))
    tasks = data / "tasks"
    archive = tasks / ".archive"
    archive.mkdir(parents=True)
    entry = "batch-2026-11-09.md W2"
    (archive / "INDEX.md").write_text(f"| 2026-11-09 | {entry} | invariant | CI | proposed |\n")
    for slug, parent, pid in (("waiting", tasks, None), ("running", tasks, os.getpid()),
                              ("archived", archive, None)):
        if parent == archive:
            slug += datetime.now(timezone.utc).strftime("-%Y%m%dT%H%M%SZ")
        directory = parent / slug
        directory.mkdir()
        (directory / "state.json").write_text(json.dumps({"kind": "reflect", "pid": pid}))
    control, calls = tmp_path / "control.json", tmp_path / "calls.jsonl"
    control.write_text("{}")
    monkeypatch.setenv("STATION_CONTROL", str(control))
    monkeypatch.setenv("STATION_CALLS", str(calls))
    fake = tmp_path / "teamster"
    fake.write_text(f"#!{sys.executable}\n" + '''import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
control = json.loads(Path(os.environ["STATION_CONTROL"]).read_text())
if args == ["--version"]:
    with (Path(os.environ["STATION_CALLS"]).parent / "versions.log").open("a") as stream:
        stream.write("asked\\n")
    print(control.get("version", "1.59.2"))
    sys.exit(control.get("version_exit", 0))
record = {"argv": args, "cwd": os.getcwd(), "stdin": sys.stdin.read(), "pid": os.getpid()}
if "--file" in args:
    record["file"] = Path(args[args.index("--file") + 1]).read_text()
if "--brief" in args:
    record["brief"] = Path(args[args.index("--brief") + 1]).read_text()
    (Path(os.environ["STATION_CALLS"]).parent / (args[1] + ".brief.md")).write_text(record["brief"])
with Path(os.environ["STATION_CALLS"]).open("a") as stream:
    stream.write(json.dumps(record) + "\\n")
time.sleep(control.get("sleep", 0))
tasks = Path(os.environ["TEAMSTER_HOME"]) / "tasks"
exit_code = control.get(args[0] + "_exit", control.get("exit", 0))
if not exit_code:
    if args[0] == "lesson":
        index = tasks / ".archive" / "INDEX.md"
        rows = index.read_text().splitlines(keepends=True)
        for position, row in enumerate(rows):
            columns = row.split("|")
            if len(columns) > 5 and columns[2].strip() == args[1]:
                columns[5] = f" {args[2]} "
                rows[position] = "|".join(columns)
        index.write_text("".join(rows))
    def wait(step):
        if control.get("stages"):
            marker = Path(os.environ["STATION_CALLS"]).parent / (args[1] + "." + step)
            while not marker.exists():
                time.sleep(0.01)
    if args[0] == "start":
        if control.get("stages"):
            wait("worktree")
            (tasks.parent / "worktrees" / ("claude-" + args[1])).mkdir(parents=True)
            wait("starting")
    if args[0] == "reflect":
        wait("starting")
        directory = tasks / args[1]
        directory.mkdir()
        (directory / "state.json").write_text(json.dumps({"kind": "reflect"}))
        wait("done")
    if args[0] == "start":
        directory = tasks / args[1]
        directory.mkdir()
        (directory / "brief.md").write_text(record["brief"])
        (directory / "state.json").write_text(json.dumps({"repo": args[args.index("--repo") + 1],
                                                       "created": time.time()}))
        wait("done")
if args[0] in ("start", "reflect"):
    exit_code = control.get("late_exit", exit_code)
print(control.get(args[0] + "_stdout", control.get("stdout", "  finished  ")))
print(control.get("stderr", ""), file=sys.stderr)
sys.exit(exit_code)
''')
    fake.chmod(0o755)
    accounts = tmp_path / "accounts.py"
    accounts.write_text("print('{}')\n")
    settings = Settings(data, accounts, layout="new", action_teamster=str(fake),
                        web_dist=tmp_path / "dist", research_seconds=3600)
    application = create_app(settings)
    with TestClient(application, base_url="http://localhost:8787",
                    headers={"Origin": "http://localhost:8787", "X-Teamster-Board": "1"}) as client:
        try:
            yield client, application, settings, entry, calls, control
        finally:
            for launch in application.state.board.actions.launches():
                for stage in ("worktree", "starting", "done"):
                    (calls.parent / (launch["slug"] + "." + stage)).touch()
            deadline = time.monotonic() + 5
            while any(row["stage"] not in ("done", "failed")
                      for row in application.state.board.actions.launches()) and time.monotonic() < deadline:
                time.sleep(0.01)


def wait_launch(station, slug, expected="done"):
    client = station[0]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        launch = next(row for row in client.get("/api/research").json()["launches"] if row["slug"] == slug)
        if launch["stage"] in ("done", "failed"):
            assert launch["stage"] == expected, launch
            return launch
        time.sleep(0.01)
    pytest.fail(f"Launch {slug} did not finish")


def assert_launch_response(response, slug, kind):
    assert response.status_code == 200
    result = response.json()
    assert result == {"ok": True, "output": "", "slug": slug, "launch": result["launch"]}
    launch = result["launch"]
    assert launch["slug"] == slug
    assert launch["kind"] == kind
    assert launch["error"] is None
    assert launch["steps"] == [{"stage": launch["stage"], "at": launch["started_at"]}]
    return launch


@pytest.mark.parametrize("note", ["  AGENTS.md  ", "--force applied"])
def test_station_action_argv_files_and_immediate_lesson_refresh(station, caplog, note):
    client, application, _, entry, calls, _ = station
    caplog.set_level("INFO", logger="uvicorn.error")
    assert client.get("/api/research").json()["actions"] == {"enabled": True, "reason": None}
    assert client.get("/api/research").json()["lessons"][0]["status"] == "proposed"
    response = client.post("/api/actions/lesson", json={"entry": f" {entry} ", "status": "accepted", "note": "  "})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "output": "finished"}
    # The configured interval is one hour, and the preceding GET primed the view.
    assert application.state.board.research.seconds == 3600
    assert client.get("/api/research").json()["lessons"][0]["status"] == "accepted"
    response = client.post("/api/actions/lesson", json={"entry": entry, "status": "applied", "note": note})
    assert response.status_code == 200
    response = client.post("/api/actions/say", json={"slug": "waiting", "text": "  --answer\nKeep the check.  "})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "output": "finished"}
    records = [json.loads(line) for line in calls.read_text().splitlines()]
    assert records[0]["argv"] == ["lesson", entry, "accepted"]
    assert records[1]["argv"] == ["lesson", entry, "applied", f"--note={note.strip()}"]
    assert records[2]["argv"][:3] == ["say", "waiting", "--file"]
    assert len(records[2]["argv"]) == 4
    assert records[2]["file"] == "--answer\nKeep the check."
    assert not Path(records[2]["argv"][3]).exists()
    assert all(row["cwd"] == str(Path.home()) and row["stdin"] == "" for row in records)
    logs = [row.message for row in caplog.records if row.message.startswith("/api/actions/")]
    assert len(logs) == 3
    assert all("argv=" in row and "exit=0" in row for row in logs)
    assert "--answer" not in "\n".join(logs)


def test_station_reflect_argv_utc_slug_and_collisions(station, monkeypatch, caplog):
    client, _, settings, _, calls, _ = station
    caplog.set_level("INFO", logger="uvicorn.error")

    class FixedDatetime(datetime):
        @classmethod
        def now(cls, zone):
            assert zone is timezone.utc
            return cls(2026, 11, 9, 23, 4, 5, tzinfo=zone)

    monkeypatch.setattr(actions_module, "datetime", FixedDatetime)
    base = "reflect-1109-230405"
    response = client.post("/api/actions/reflect", json={})
    assert response.status_code == 200
    assert_launch_response(response, base, "reflect")
    wait_launch(station, base)
    (settings.path("tasks") / (base + "-2")).mkdir()
    bodies = [
        {"tasks": ["task-a", "Task_2.0"], "order": "  --inspect\nCheck both.  "},
        {"since": "14d", "repos": ["gothic", "teamster"]},
        {"since": "2026-11-09"},
        {"order": "  "},
    ]
    slugs = []
    for index, body in enumerate(bodies, 3):
        response = client.post("/api/actions/reflect", json=body)
        assert response.status_code == 200
        slug = f"{base}-{index}"
        assert_launch_response(response, slug, "reflect")
        wait_launch(station, slug)
        slugs.append(slug)
    records = [json.loads(line) for line in calls.read_text().splitlines()]
    assert records[0]["argv"] == ["reflect", base]
    records = records[1:]
    assert records[0]["argv"][:-1] == ["reflect", slugs[0], "--task", "task-a", "--task", "Task_2.0", "--file"]
    assert records[0]["file"] == "--inspect\nCheck both."
    assert not Path(records[0]["argv"][-1]).exists()
    assert records[1]["argv"] == ["reflect", slugs[1], "--since", "14d", "--repo", "gothic", "--repo", "teamster"]
    assert records[2]["argv"] == ["reflect", slugs[2], "--since", "2026-11-09"]
    assert records[3]["argv"] == ["reflect", slugs[3]]
    assert "--inspect" not in caplog.text


@pytest.fixture
def lesson_repo(station):
    _, application, settings, _, _, _ = station
    repo = settings.task_home.parent / "repository"
    subprocess.run(["git", "init", "--quiet", str(repo)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "remote", "add", "origin", "https://forge.example/repo.git"],
                   check=True, capture_output=True)
    directory = settings.path("tasks") / "known-repository"
    directory.mkdir()
    (directory / "state.json").write_text(json.dumps({"repo": str(repo)}))
    research = application.state.board.research
    research.view()
    research._repos_thread.join(5)
    research.invalidate()
    research._next_repos_scan = 0
    research.view()
    research._repos_thread.join(5)
    assert not research._repos_thread.is_alive()
    research.invalidate()
    return repo


@pytest.mark.parametrize("status,origin,full,worker", [
    ("proposed", "git@github.com:owner/project.git", True, {}),
    ("accepted", "https://forge.example/owner/project.git", False, {}),
    ("accepted", "https://forge.example/owner/project.git", False, {"executor": "opencode", "model": "local/test"}),
])
def test_station_implement_argv_exact_brief_and_refresh(station, lesson_repo, monkeypatch, caplog,
                                                      status, origin, full, worker):
    client, application, settings, entry, calls, control = station
    caplog.set_level("INFO", logger="uvicorn.error")

    class FixedDatetime(datetime):
        @classmethod
        def now(cls, zone):
            assert zone is timezone.utc
            return cls(2026, 11, 9, 23, 4, 5, tzinfo=zone)

    monkeypatch.setattr(actions_module, "datetime", FixedDatetime)
    archive = settings.path("tasks") / ".archive"
    index = archive / "INDEX.md"
    index.write_text(index.read_text().replace("proposed", status))
    (archive / "batch-2026-11-09.md").write_text(
        ("## W2. Keep the latest check\n" if full else "## W2. \n") +
        "lesson: Wait for the current commit.\nKeep its run id.\nproposal: Add a guard in the waiter.\n" +
        ("evidence:\n- task one, round 2\n- task two, finding R1\ncaveats: Only CI waits.\n" if full else ""))
    subprocess.run(["git", "-C", str(lesson_repo), "remote", "set-url", "origin", origin],
                   check=True, capture_output=True)
    control.write_text(json.dumps({"lesson_stdout": "Accepted the lesson", "start_stdout": "  Started work  "}))
    before = client.get("/api/research").json()
    assert before["repos"] == [{"name": lesson_repo.name, "path": str(lesson_repo)}]
    assert before["lessons"][0]["implementation"] is None
    response = client.post("/api/actions/implement", json={
        "entry": f" {entry} ", "repo": str(lesson_repo), "note": "  Keep it focused.  " if full else "  ", **worker,
    })
    slug = "lesson-w2-1109"
    assert response.status_code == 200
    launch = assert_launch_response(response, slug, "implement")
    assert launch["entry"] == entry and launch["repo"] == lesson_repo.name
    assert launch["stage"] == ("accepting" if status == "proposed" else "fetching")
    wait_launch(station, slug)
    records = [json.loads(line) for line in calls.read_text().splitlines()]
    assert len(records) == (2 if status == "proposed" else 1)
    if status == "proposed":
        assert records[0]["argv"] == ["lesson", entry, "accepted", f"--note=внедряется: {slug}"]
    start = records[-1]
    brief_path = start["argv"][3]
    assert start["argv"] == [
        "start", slug, "--brief", brief_path, "--repo", str(lesson_repo), "--executor", worker.get("executor", "claude"),
        *(["--model", worker["model"]] if worker else ["--sandbox", "off", "--effort", "high"]),
        "--task-type", "feature", "--max-minutes", "60",
        "--review", "--fix-rounds", "2", "--parallel", *(["--ci"] if origin and "github.com" in origin else []),
    ]
    expected = ("""Внедрить урок «batch-2026-11-09.md W2»: Keep the latest check.

Зачем: пользователь принял этот урок рефлексии на доске и попросил его внедрить. Урок из файла batch-2026-11-09.md в архиве задач.

Признак: CI
Что делать: Wait for the current commit.
Keep its run id.
Предложение: Add a guard in the waiter.
Доказательства:
- task one, round 2
- task two, finding R1
Оговорки: Only CI waits.

Уточнение пользователя: Keep it focused.

""" if full else """Внедрить урок «batch-2026-11-09.md W2»: CI.

Зачем: пользователь принял этот урок рефлексии на доске и попросил его внедрить. Урок из файла batch-2026-11-09.md в архиве задач.

Признак: CI
Что делать: Wait for the current commit.
Keep its run id.
Предложение: Add a guard in the waiter.

""") + """Готово, когда:
- предложение урока внедрено в этом репозитории в той форме, которую оно называет; если эта форма не подходит к коду — в ближайшей, которая даёт тот же результат, предпочитая проверку или защиту в коде правилу в тексте;
- изменённое поведение закреплено тестом;
- документация репозитория, которую задевает изменение, обновлена;
- части предложения для другого репозитория или для файлов вне репозитория (например ~/.codex/AGENTS.md или ~/.claude/…) не сделаны, а перечислены в отчёте в remaining.

Проверки: тесты и проверки, которые требуют AGENTS.md и README этого репозитория.
Не трогать: ничего, что не нужно для этого урока; записи задач и INDEX.md в архиве teamster.
Если предложение неясно или для него нужен выбор пользователя — закончи ход со статусом needs_decision и задай вопросы.
"""
    assert start["brief"] == expected
    assert (calls.parent / f"{slug}.brief.md").read_text() == expected
    assert not Path(brief_path).exists()
    assert all(row["cwd"] == str(Path.home()) and row["stdin"] == "" for row in records)
    after = client.get("/api/research").json()["lessons"][0]
    assert application.state.board.research.seconds == 3600
    assert after["status"] == "accepted"
    assert after["implementation"]["slug"] == slug
    logs = [row.message for row in caplog.records if row.message.startswith("/api/actions/implement")]
    assert len(logs) == len(records)
    assert all("argv=" in row and "exit=0" in row for row in logs)
    assert "Keep it focused" not in caplog.text


def test_station_implement_outside_brief_from_research(station, lesson_repo, monkeypatch):
    client, application, settings, _, calls, _ = station

    class FixedDatetime(datetime):
        calls = 0

        @classmethod
        def now(cls, zone):
            assert zone is timezone.utc
            cls.calls += 1
            assert cls.calls == 1
            return cls(2026, 11, 10, 23, 4, 5, tzinfo=zone)

    monkeypatch.setattr(actions_module, "datetime", FixedDatetime)
    script = Path.home() / ".codex" / "checks" / "home-infra" / "ci_wait.py"
    script.parent.mkdir(parents=True)
    script.write_text("raise SystemExit(0)\n")
    entry = "batch-2026-11-10.md X4"
    archive = settings.path("tasks") / ".archive"
    (archive / "INDEX.md").write_text(
        f"| 2026-11-10 | {entry} | domain home-infra | CI | proposed |\n")
    (archive / "batch-2026-11-10.md").write_text(
        "## X4. Wait for a run\nproposal: ci_wait.py: when no run exists, exit 75.\n"
        "target: ~/.codex/checks/home-infra/ci_wait.py, home-infra\n")
    application.state.board.research.invalidate()
    before = client.get("/api/research").json()["lessons"][0]
    assert before["outside"] == ["~/.codex/checks/home-infra/ci_wait.py"]
    assert before["target"] == ["~/.codex/checks/home-infra/ci_wait.py", "home-infra"]
    assert before["status"] == "proposed"
    response = client.post("/api/actions/implement", json={
        "entry": entry, "repo": str(lesson_repo), "outside": ["~/.claude/settings.json"],
    })
    slug = "lesson-x4-1110"
    assert response.status_code == 200
    assert_launch_response(response, slug, "implement")
    wait_launch(station, slug)
    records = [json.loads(line) for line in calls.read_text().splitlines()]
    assert len(records) == 2
    assert records[0]["argv"] == ["lesson", entry, "accepted", f"--note=внедряется: {slug}"]
    start = records[1]
    brief_path = start["argv"][3]
    assert start["argv"] == [
        "start", slug, "--brief", brief_path, "--repo", str(lesson_repo), "--executor", "claude",
        "--sandbox", "off", "--effort", "high", "--task-type", "feature", "--max-minutes", "60",
        "--review", "--fix-rounds", "2", "--parallel",
    ]
    expected = """Внедрить урок «batch-2026-11-10.md X4»: Wait for a run.

Зачем: пользователь принял этот урок рефлексии на доске и попросил его внедрить. Урок из файла batch-2026-11-10.md в архиве задач.

Признак: CI
Предложение: ci_wait.py: when no run exists, exit 75.
Где менять: ~/.codex/checks/home-infra/ci_wait.py, home-infra

Файлы вне репозитория: пользователь разрешил этой задаче менять только эти файлы вне репозитория:
- ~/.codex/checks/home-infra/ci_wait.py
Перед первой правкой существующего файла сохрани его копию рядом: <файл>.bak-2026-11-10-x4. Проверь изменённое поведение на копии файла во временном каталоге, не на живых задачах и системах. Если в репозитории менять нечего, не коммить и не пушь ветку.

Готово, когда:
- предложение урока внедрено в той форме, которую оно называет, в этом репозитории и в разрешённых файлах вне него; если эта форма не подходит к коду — в ближайшей, которая даёт тот же результат, предпочитая проверку или защиту в коде правилу в тексте;
- изменённое поведение закреплено тестом в репозитории, а для файла вне репозитория — проверкой на копии, записанной в checks;
- документация репозитория, которую задевает изменение, обновлена;
- в summary перечислены изменённые файлы вне репозитория, их копии .bak и команда `diff -u <копия> <файл>` для каждого;
- части предложения для других файлов вне репозитория и для других репозиториев не сделаны, а перечислены в remaining.

Проверки: тесты и проверки, которые требуют AGENTS.md и README этого репозитория.
Не трогать: ничего, что не нужно для этого урока; записи задач и INDEX.md в архиве teamster.
Если предложение неясно или для него нужен выбор пользователя — закончи ход со статусом needs_decision и задай вопросы.
"""
    assert start["brief"] == expected
    assert (calls.parent / f"{slug}.brief.md").read_text() == expected
    assert not Path(brief_path).exists()
    assert all(row["cwd"] == str(Path.home()) and row["stdin"] == "" for row in records)
    after = client.get("/api/research").json()["lessons"][0]
    assert after["status"] == "accepted"
    assert after["implementation"]["slug"] == slug
    assert FixedDatetime.calls == 1


@pytest.mark.parametrize("lesson_id,expected", [("W2", "w2"), ("W_Ä.2", "w---2")])
def test_station_implement_slug_characters_and_collisions(station, lesson_repo, lesson_id, expected):
    client, application, settings, entry, _, _ = station
    entry = entry.rsplit(" ", 1)[0] + " " + lesson_id
    index = settings.path("tasks") / ".archive" / "INDEX.md"
    index.write_text(f"| 2026-11-09 | {entry} | invariant | CI | accepted |\n")
    base = f"lesson-{expected}-{datetime.now(timezone.utc):%m%d}"
    for slug in (base, base + "-2"):
        (settings.path("tasks") / slug).mkdir()
    application.state.board.research.invalidate()
    response = client.post("/api/actions/implement", json={"entry": entry, "repo": str(lesson_repo)})
    assert response.status_code == 200
    assert response.json()["slug"] == base + "-3"
    wait_launch(station, base + "-3")


@pytest.mark.parametrize("case,status,message", [
    ("unknown", 404, "Unknown lesson"),
    ("applied", 409, "Урок уже внедрён или отклонён"),
    ("declined", 409, "Урок уже внедрён или отклонён"),
    ("repo", 400, "Unknown repository"),
    ("note", 400, "Invalid note"),
    ("implementation", 409, "Урок уже внедряется: lesson-existing"),
    ("slug", 400, "Invalid slug"),
    ("disk denied", 503, "Нет доступа к диску с репозиторием. Разреши Python доски доступ к файлам "
     "на съёмных томах: Системные настройки → Конфиденциальность и безопасность → "
     "Файлы и папки или Полный доступ к диску."),
    ("disk timeout", 503, "Нет доступа к диску с репозиторием. Разреши Python доски доступ к файлам "
     "на съёмных томах: Системные настройки → Конфиденциальность и безопасность → "
     "Файлы и папки или Полный доступ к диску."),
])
def test_station_implement_rejections(station, lesson_repo, monkeypatch, case, status, message):
    client, application, settings, entry, calls, _ = station
    body = {"entry": entry, "repo": str(lesson_repo)}
    index = settings.path("tasks") / ".archive" / "INDEX.md"
    if case == "unknown":
        body["entry"] = "unknown"
    elif case in ("applied", "declined"):
        index.write_text(index.read_text().replace("proposed", case))
    elif case == "repo":
        body["repo"] = str(lesson_repo.parent)
    elif case == "note":
        body["note"] = "  " + "n" * 4001 + "  "
    elif case == "implementation":
        directory = settings.path("tasks") / "lesson-existing"
        directory.mkdir()
        (directory / "brief.md").write_text(f"Внедрить урок «{entry}»: CI.\n")
        (directory / "state.json").write_text(json.dumps({"repo": str(lesson_repo), "created": 10}))
    elif case == "slug":
        body["entry"] = entry.rsplit(" ", 1)[0] + " " + "W" * 40
        index.write_text(index.read_text().replace(entry, body["entry"]))
    elif case.startswith("disk"):
        def probe(path):
            assert path == lesson_repo / ".git"
            return False if case == "disk denied" else None

        def execute(*args, **kwargs):
            pytest.fail("An inaccessible repository must not run commands")

        monkeypatch.setattr(access, "readable", probe)
        monkeypatch.setattr(actions_module.subprocess, "run", execute)
    application.state.board.research.invalidate()
    response = client.post("/api/actions/implement", json=body)
    assert response.status_code == status
    assert response.json() == {"ok": False, "error": message}
    assert not calls.exists()


@pytest.mark.parametrize("step,count,status", [
    ("lesson", 1, "proposed"), ("start", 2, "accepted"), ("late_start", 2, "accepted"),
])
def test_station_implement_failed_step_and_accepted_lesson_refresh(station, lesson_repo, step, count, status):
    client, _, _, entry, calls, control = station
    assert client.get("/api/research").json()["lessons"][0]["status"] == "proposed"
    control.write_text(json.dumps({"late_exit" if step == "late_start" else step + "_exit": 7,
                                   "stderr": "Failed step"}))
    with client.websocket_connect("/ws", headers={"Host": "localhost:8787"}) as socket:
        assert socket.receive_json()["type"] == "snapshot"
        response = client.post("/api/actions/implement", json={"entry": entry, "repo": str(lesson_repo)})
        slug = response.json()["slug"]
        assert_launch_response(response, slug, "implement")
        failed = wait_launch(station, slug, "failed")
        assert failed["error"] == "Failed step"
        received = []
        while not received or received[-1] != "failed":
            message = socket.receive_json()
            if message["type"] == "launch" and message["launch"]["slug"] == slug:
                received.append(message["launch"]["stage"])
                assert [row["stage"] for row in message["launch"]["steps"]] == received
        assert message["launch"] == failed
    records = [json.loads(line) for line in calls.read_text().splitlines()]
    assert len(records) == count
    assert records[0]["argv"][0] == "lesson"
    if step in ("start", "late_start"):
        assert records[1]["argv"][0] == "start"
        assert not Path(records[1]["argv"][3]).exists()
    assert client.get("/api/research").json()["lessons"][0]["status"] == status
    control.write_text("{}")
    retry = client.post("/api/actions/implement", json={"entry": entry, "repo": str(lesson_repo)})
    assert retry.status_code == 200
    replacement = retry.json()["slug"]
    assert replacement != slug
    wait_launch(station, replacement)
    launches = client.get("/api/research").json()["launches"]
    assert [row["slug"] for row in launches] == [replacement]


@pytest.mark.parametrize("kind", ["implement", "reflect"])
def test_station_launch_response_stages_websocket_and_starting_refresh(station, lesson_repo, kind):
    client, _, _, entry, calls, control = station
    control.write_text(json.dumps({"stages": True}))
    body = {"entry": entry, "repo": str(lesson_repo)} if kind == "implement" else {}
    expected = (["accepting", "fetching", "worktree", "starting", "done"]
                if kind == "implement" else ["preparing", "starting", "done"])
    with client.websocket_connect("/ws", headers={"Host": "localhost:8787"}) as socket:
        assert socket.receive_json()["type"] == "snapshot"
        response = client.post(f"/api/actions/{kind}", json=body)
        slug = response.json()["slug"]
        initial = assert_launch_response(response, slug, kind)
        assert initial["stage"] == expected[0]
        assert not (calls.parent / (slug + ".done")).exists()
        received = []
        for stage in expected:
            if stage in ("worktree", "starting", "done"):
                (calls.parent / (slug + "." + stage)).touch()
            while True:
                message = socket.receive_json()
                if message["type"] == "launch" and message["launch"]["slug"] == slug:
                    break
            launch = message["launch"]
            received.append(stage)
            assert launch["stage"] == stage
            assert [step["stage"] for step in launch["steps"]] == received
            assert [step["at"] for step in launch["steps"]] == sorted(step["at"] for step in launch["steps"])
            if stage == "starting" and kind == "implement":
                lesson = client.get("/api/research").json()["lessons"][0]
                assert lesson["implementation"]["slug"] == slug
                assert not (calls.parent / (slug + ".done")).exists()
        assert wait_launch(station, slug)["steps"] == launch["steps"]


def test_station_validation_does_not_block_the_event_loop(station, lesson_repo, monkeypatch):
    client, application, _, entry, _, _ = station
    actions = application.state.board.actions
    checking, reading, release = threading.Event(), threading.Event(), threading.Event()
    original_launches = actions.launches

    def readable(path):
        assert path == lesson_repo / ".git"
        checking.set()
        assert release.wait(5)
        return True

    def launches():
        reading.set()
        return original_launches()

    monkeypatch.setattr(actions_module.access, "readable", readable)
    monkeypatch.setattr(actions, "launches", launches)
    with ThreadPoolExecutor(max_workers=3) as pool:
        try:
            implementation = pool.submit(client.post, "/api/actions/implement",
                                         json={"entry": entry, "repo": str(lesson_repo)})
            assert checking.wait(5)
            research = pool.submit(client.get, "/api/research")
            assert reading.wait(5)
            assert pool.submit(client.get, "/api/art").result(timeout=1).status_code == 200
        finally:
            release.set()
        response = implementation.result(timeout=5)
        assert response.status_code == 200
        assert research.result(timeout=5).status_code == 200
    wait_launch(station, response.json()["slug"])


@pytest.mark.parametrize("status", ["proposed", "accepted"])
def test_station_implementation_preserves_a_later_lesson_decision(station, lesson_repo, monkeypatch, status):
    client, application, settings, entry, calls, _ = station
    index = settings.path("tasks") / ".archive" / "INDEX.md"
    index.write_text(index.read_text().replace("proposed", status))
    application.state.board.research.invalidate()
    preparing, release = threading.Event(), threading.Event()
    original_brief = actions_module.implementation_brief

    def brief(*args):
        preparing.set()
        assert release.wait(5)
        return original_brief(*args)

    monkeypatch.setattr(actions_module, "implementation_brief", brief)
    try:
        with client.websocket_connect("/ws", headers={"Host": "localhost:8787"}) as socket:
            assert socket.receive_json()["type"] == "snapshot"
            response = client.post("/api/actions/implement", json={"entry": entry, "repo": str(lesson_repo)})
            assert response.status_code == 200
            assert preparing.wait(5)
            decision = client.post("/api/actions/lesson", json={"entry": entry, "status": "declined"})
            assert decision.status_code == 200
            release.set()
            failed = wait_launch(station, response.json()["slug"], "failed")
            assert failed["error"] == "Lesson status changed: declined"
            while True:
                message = socket.receive_json()
                if message["type"] == "launch" and message["launch"]["stage"] == "failed":
                    assert message["launch"] == failed
                    break
    finally:
        release.set()
    assert client.get("/api/research").json()["lessons"][0]["status"] == "declined"
    assert [json.loads(line)["argv"] for line in calls.read_text().splitlines()] == [
        ["lesson", entry, "declined"]]


def test_station_launch_duplicate_reservations_limit_and_other_actions(station, lesson_repo):
    client, application, settings, entry, calls, control = station
    entries = [entry, "batch-2026-11-13.md W2", "batch-2026-11-13.md A3",
               "batch-2026-11-13.md A4", "batch-2026-11-13.md A5"]
    index = settings.path("tasks") / ".archive" / "INDEX.md"
    index.write_text("".join(f"| 2026-11-13 | {value} | invariant | CI | accepted |\n" for value in entries))
    application.state.board.research.invalidate()
    control.write_text(json.dumps({"stages": True}))
    first = client.post("/api/actions/implement", json={"entry": entry, "repo": str(lesson_repo)})
    slug = first.json()["slug"]
    assert first.status_code == 200
    duplicate = client.post("/api/actions/implement", json={"entry": entry, "repo": str(lesson_repo)})
    assert duplicate.status_code == 409
    assert duplicate.json() == {"ok": False, "error": f"Урок уже запускается: {slug}"}
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        records = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
        if any(row["argv"][:2] == ["start", slug] for row in records):
            break
        time.sleep(0.01)
    else:
        pytest.fail("The first start command did not reach its worktree gate")
    assert client.get("/api/research").json()["launches"][0]["stage"] == "fetching"
    # start is held before worktree creation; a lesson command takes the common action lock.
    with ThreadPoolExecutor(max_workers=1) as pool:
        request = pool.submit(client.post, "/api/actions/lesson", json={"entry": entries[-1], "status": "accepted"})
        try:
            other = request.result(timeout=5)
        finally:
            if not request.done():
                for stage in ("worktree", "starting", "done"):
                    (calls.parent / (slug + "." + stage)).touch()
    assert other.status_code == 200
    assert not (settings.path("tasks") / slug).exists()
    slugs = [slug]
    for value in entries[1:4]:
        response = client.post("/api/actions/implement", json={"entry": value, "repo": str(lesson_repo)})
        assert response.status_code == 200
        slugs.append(response.json()["slug"])
    assert len(set(slugs)) == 4
    assert slugs[1] == slugs[0] + "-2"
    assert all(not (settings.path("tasks") / value).exists() for value in slugs)
    fifth = client.post("/api/actions/implement", json={"entry": entries[-1], "repo": str(lesson_repo)})
    assert fifth.status_code == 409
    assert fifth.json() == {"ok": False, "error": "Слишком много запусков: подожди, пока начнутся предыдущие"}
    for value in slugs:
        for stage in ("worktree", "starting", "done"):
            (calls.parent / (value + "." + stage)).touch()
    for value in slugs:
        wait_launch(station, value)
    records = [json.loads(line) for line in calls.read_text().splitlines()]
    assert len([row for row in records if row["argv"][0] == "start"]) == 4


@pytest.mark.parametrize("kind", ["implement", "reflect"])
def test_station_launch_timeout_kills_and_waits(station, lesson_repo, monkeypatch, kind):
    client, _, _, entry, calls, control = station
    control.write_text(json.dumps({"sleep": 30}))
    monkeypatch.setattr(actions_module, "LAUNCH_TIMEOUT", 1)
    body = {"entry": entry, "repo": str(lesson_repo)} if kind == "implement" else {"order": "Inspect"}
    response = client.post(f"/api/actions/{kind}", json=body)
    assert response.status_code == 200
    launch = wait_launch(station, response.json()["slug"], "failed")
    assert launch["error"] == "timeout"
    records = [json.loads(line) for line in calls.read_text().splitlines()]
    assert len(records) == 1
    with pytest.raises(ProcessLookupError):
        os.kill(records[0]["pid"], 0)
    file_flag = "--brief" if kind == "implement" else "--file"
    if file_flag in records[0]["argv"]:
        assert not Path(records[0]["argv"][records[0]["argv"].index(file_flag) + 1]).exists()


@pytest.mark.parametrize("kind", ["implement", "reflect"])
@pytest.mark.parametrize("fault", ["preparing", "cleanup", "running"])
def test_station_launch_unexpected_exception_fails_and_frees_capacity(station, lesson_repo, monkeypatch,
                                                                     caplog, kind, fault):
    client, application, _, entry, calls, control = station
    monkeypatch.setattr(actions_module, "LAUNCH_LIMIT", 1)
    message = "Unexpected launch error: " + "x" * 2100
    created = []
    original_temporary = actions_module.tempfile.NamedTemporaryFile
    original_unlink = Path.unlink

    def temporary(*args, **kwargs):
        if fault == "preparing":
            raise RuntimeError(message)
        stream = original_temporary(*args, **kwargs)
        created.append(Path(stream.name))
        return stream

    def unlink(path, *args, **kwargs):
        if path in created:
            raise RuntimeError(message)
        return original_unlink(path, *args, **kwargs)

    def observe(launch):
        records = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
        if any(row["argv"][:2] == ["start" if kind == "implement" else "reflect", launch["slug"]]
               for row in records):
            raise RuntimeError(message)

    body = {"entry": entry, "repo": str(lesson_repo)} if kind == "implement" else {"order": "Inspect"}
    if fault == "running":
        control.write_text(json.dumps({"stages": True}))
    try:
        with monkeypatch.context() as faults:
            faults.setattr(actions_module.tempfile, "NamedTemporaryFile", temporary)
            if fault == "cleanup":
                faults.setattr(Path, "unlink", unlink)
            if fault == "running":
                faults.setattr(application.state.board.actions, "_observe_launch", observe)
            with client.websocket_connect("/ws", headers={"Host": "localhost:8787"}) as socket:
                assert socket.receive_json()["type"] == "snapshot"
                response = client.post(f"/api/actions/{kind}", json=body)
                slug = response.json()["slug"]
                assert_launch_response(response, slug, kind)
                failed = wait_launch(station, slug, "failed")
                assert failed["error"] == message[-2000:]
                assert "done" not in [step["stage"] for step in failed["steps"]]
                stages = []
                while not stages or stages[-1] != "failed":
                    event = socket.receive_json()
                    if event["type"] == "launch" and event["launch"]["slug"] == slug:
                        stages.append(event["launch"]["stage"])
                assert event["launch"] == failed
                assert stages == [step["stage"] for step in failed["steps"]]
    finally:
        for path in created:
            original_unlink(path, missing_ok=True)
    if fault == "running":
        record = json.loads(calls.read_text().splitlines()[-1])
        with pytest.raises(ProcessLookupError):
            os.kill(record["pid"], 0)
    errors = [row for row in caplog.records if row.exc_info]
    assert len(errors) == 1
    assert errors[0].exc_info[0] is RuntimeError
    assert slug in errors[0].message and str(errors[0].exc_info[1]) == message
    # A failed worker releases the only launch slot, including after a cleanup error.
    control.write_text("{}")
    replacement = client.post("/api/actions/reflect", json={})
    assert replacement.status_code == 200
    wait_launch(station, replacement.json()["slug"])


def test_station_research_launch_retention_and_order(station, monkeypatch):
    client, application, _, _, calls, control = station
    first = client.post("/api/actions/reflect", json={}).json()["slug"]
    wait_launch(station, first)
    second = client.post("/api/actions/reflect", json={}).json()["slug"]
    wait_launch(station, second)
    control.write_text(json.dumps({"stages": True}))
    active = client.post("/api/actions/reflect", json={}).json()["slug"]
    launches = client.get("/api/research").json()["launches"]
    assert [row["slug"] for row in launches] == [first, second, active]
    assert [row["started_at"] for row in launches] == sorted(row["started_at"] for row in launches)
    actions = application.state.board.actions
    actions._finished[first] = time.time() - 601
    actions._finished[second] = time.time() - 599
    launches = client.get("/api/research").json()["launches"]
    assert [row["slug"] for row in launches] == [second, active]
    assert launches[-1]["stage"] == "preparing"
    for stage in ("starting", "done"):
        (calls.parent / (active + "." + stage)).touch()
    wait_launch(station, active)


@pytest.mark.parametrize("alive,archived,status", [(False, False, 200), (True, False, 409), (False, True, 409)])
def test_station_say_to_implementation(station, lesson_repo, alive, archived, status):
    client, application, settings, entry, calls, _ = station
    slug = "lesson-existing"
    directory = settings.path("tasks")
    if archived:
        directory /= ".archive"
    directory /= slug + ("-20200101T000000Z" if archived else "")
    directory.mkdir()
    (directory / "state.json").write_text(json.dumps({"repo": str(lesson_repo), "created": 10,
                                                     "pid": os.getpid() if alive else None}))
    (directory / "brief.md").write_text(f"Внедрить урок «{entry}»: CI.\n")
    application.state.board.research.invalidate()
    response = client.post("/api/actions/say", json={"slug": slug, "text": "  Keep the check.  "})
    assert response.status_code == status
    if status == 200:
        assert response.json() == {"ok": True, "output": "finished"}
        record = json.loads(calls.read_text())
        assert record["argv"][:3] == ["say", slug, "--file"]
        assert len(record["argv"]) == 4
        assert record["file"] == "Keep the check."
        assert not Path(record["argv"][3]).exists()
    else:
        assert response.json()["ok"] is False
        assert not calls.exists()


@pytest.mark.parametrize("headers,body,status", [
    ({"Origin": None}, {}, 403),
    ({"Origin": "http://evil.example:8787"}, {}, 403),
    ({"Origin": "http://localhost:8788"}, {}, 403),
    ({"Origin": "https://localhost:8787"}, {}, 403),
    ({"Origin": "http://127.0.0.1:8787"}, {}, 403),
    ({"Host": "evil.example"}, {}, 403),
    ({"X-Teamster-Board": None}, {}, 403),
    ({"Content-Type": "text/plain"}, {}, 403),
    ({}, b" " * (64 * 1024 + 1), 413),
])
def test_station_request_protection(station, headers, body, status):
    client, _, _, _, calls, _ = station
    request = client.build_request("POST", "/api/actions/reflect", json=body if isinstance(body, dict) else None,
                                   content=body if isinstance(body, bytes) else None)
    request.headers["Content-Type"] = "application/json"
    for name, value in headers.items():
        if value is None:
            del request.headers[name]
        else:
            request.headers[name] = value
    response = client.send(request)
    assert response.status_code == status
    assert response.json() == {"ok": False, "error": "forbidden" if status == 403 else "Body too large"}
    assert not any(name.startswith("access-control-") for name in response.headers)
    assert not calls.exists()


@pytest.mark.parametrize("read_only,command,reason", [(True, "fake", "read_only"), (False, None, "no_teamster")])
def test_station_disabled_actions(station, read_only, command, reason):
    client, _, settings, _, calls, _ = station
    settings.read_only = read_only
    settings.action_teamster = settings.action_teamster if command else None
    disabled = create_app(settings)
    with TestClient(disabled, base_url=str(client.base_url), headers=dict(client.headers)) as other:
        assert other.get("/api/research").json()["actions"] == {"enabled": False, "reason": reason}
        response = other.post("/api/actions/reflect", json={})
        assert response.status_code == 403
        assert response.json() == {"ok": False, "error": reason}
    assert not calls.exists()


@pytest.mark.parametrize("route,body,status", [
    ("lesson", {"entry": "unknown", "status": "accepted"}, 404),
    ("say", {"slug": "unknown", "text": "Answer"}, 404),
    ("say", {"slug": "running", "text": "Answer"}, 409),
    ("say", {"slug": "archived", "text": "Answer"}, 409),
    ("reflect", {"tasks": ["one"], "since": "14d"}, 400),
    ("reflect", {"tasks": ["one"], "repos": ["repo"]}, 400),
    ("reflect", {"since": "2026-02-30"}, 400),
    ("reflect", {"since": "1000d"}, 400),
    ("reflect", {"since": "yesterday"}, 400),
    ("reflect", {"tasks": ["bad/name"]}, 400),
    ("reflect", {"repos": ["r"] * 21}, 400),
    ("reflect", {"order": "x" * 8001}, 400),
    ("lesson", {"entry": "x" * 201, "status": "accepted"}, 400),
    ("lesson", {"entry": "batch-2026-11-09.md W2", "status": "accepted", "note": "n" * 1001}, 400),
    ("say", {"slug": "waiting", "text": " "}, 400),
    ("say", {"slug": "waiting", "text": "x" * 8001}, 400),
])
def test_station_rejects_invalid_actions(station, route, body, status):
    client, _, _, _, calls, _ = station
    response = client.post(f"/api/actions/{route}", json=body)
    assert response.status_code == status
    assert response.json()["ok"] is False
    assert set(response.json()) == {"ok", "error"}
    assert not calls.exists()


def test_station_nonzero_output_limits_and_timeout_cleanup(station, monkeypatch):
    client, _, _, entry, calls, control = station
    control.write_text(json.dumps({"exit": 7, "stderr": "  problem " + "x" * 2100 + "  "}))
    response = client.post("/api/actions/lesson", json={"entry": entry, "status": "accepted"})
    assert response.status_code == 422
    assert response.json() == {"ok": False, "error": "x" * 2000}
    control.write_text(json.dumps({"exit": 7, "stdout": "  fallback error  "}))
    response = client.post("/api/actions/reflect", json={})
    assert response.status_code == 200
    assert wait_launch(station, response.json()["slug"], "failed")["error"] == "fallback error"
    control.write_text(json.dumps({"stdout": "  " + "o" * 2100 + "  "}))
    response = client.post("/api/actions/reflect", json={})
    assert response.status_code == 200
    assert response.json()["output"] == ""
    wait_launch(station, response.json()["slug"])
    control.write_text(json.dumps({"sleep": 30}))
    monkeypatch.setattr(actions_module, "COMMAND_TIMEOUT", 1)
    response = client.post("/api/actions/say", json={"slug": "waiting", "text": "--wait"})
    assert response.status_code == 504
    assert response.json() == {"ok": False, "error": "timeout"}
    last = json.loads(calls.read_text().splitlines()[-1])
    assert last["argv"][:3] == ["say", "waiting", "--file"]
    assert not Path(last["argv"][3]).exists()
    with pytest.raises(ProcessLookupError):
        os.kill(last["pid"], 0)


@pytest.fixture
def ships(station):
    _, application, settings, _, _, _ = station
    tasks = settings.path("tasks")
    for kind in ("work", "review", "reflect", "scout"):
        for state in ("idle", "alive", "archived"):
            slug = f"{kind}-{state}"
            root = tasks / ".archive" if state == "archived" else tasks
            if state == "archived":
                slug += "-20261110T000000Z"
            directory = root / slug
            directory.mkdir()
            (directory / "state.json").write_text(json.dumps({
                "kind": kind, "pid": os.getpid() if state == "alive" else None,
            }))
    desktop = settings.task_home / "desktop"
    directory = desktop / "claude-code-sessions" / "account" / "device"
    directory.mkdir(parents=True)
    (directory / "local_ship.json").write_text(json.dumps({
        "sessionId": "local_ship", "createdAt": 1000, "lastActivityAt": 2000,
    }))
    application.state.board.store.claude_desktop_dir = desktop
    application.state.board.store.poll()
    return station


@pytest.mark.parametrize("route,body,expected", [
    ("say", {"text": "  --private\nContinue.  ", "options": {
        "review_angles": ["tests", "security"], "reviewer": "claude", "ci_rounds": 5,
        "fix_rounds": 0, "max_weekly": 10.0, "max_minutes": 600, "effort": "ultra", "model": "gpt-5.2",
    }}, ["--model=gpt-5.2", "--effort=ultra", "--max-minutes=600", "--max-weekly=10",
         "--fix-rounds=0", "--ci-rounds=5", "--reviewer=claude", "--review-angles=tests,security"]),
    ("say", {"text": "Continue", "options": {"max_weekly": 0.5, "review_angles": "auto"}},
     ["--max-weekly=0.5", "--review-angles=auto"]),
    ("verdict", {"verdict": "accepted", "note": "  --keep this  "}, ["accepted", "--note=--keep this"]),
    ("verdict", {"verdict": "revised", "note": "  "}, ["revised"]),
    ("verdict", {"verdict": "redone"}, ["redone"]),
    ("verdict", {"verdict": "dropped"}, ["dropped"]),
    ("review", {"review_angles": ["concurrency", "correctness"], "reviewer": "codex", "effort": "xhigh"},
     ["--effort=xhigh", "--reviewer=codex", "--review-angles=concurrency,correctness"]),
    ("review", {"review_angles": "auto"}, ["--review-angles=auto"]),
    ("review", {}, []),
    ("stop", {}, []),
    ("clean", {}, ["--keep-branch"]),
    ("clean", {"keep_branch": True}, ["--keep-branch"]),
    ("clean", {"keep_branch": False}, []),
])
def test_ship_action_argv(ships, caplog, route, body, expected):
    client, application, settings, _, calls, _ = ships
    slug = "work-idle"
    if route == "stop":
        # Only the fake CLI handles the stop request for this PID.
        path = settings.path("tasks") / slug / "state.json"
        path.write_text(json.dumps({"executor": "opencode", "pid": None, "opencode_pid": os.getpid()}))
        application.state.board.store.poll()
        task = client.get(f"/api/tasks/{slug}").json()
        assert task["alive"] is False and task["can_stop"] is True
    caplog.set_level("INFO", logger="uvicorn.error")
    response = client.post(f"/api/actions/{route}", json={"slug": slug, **body})
    assert response.status_code == 200
    answer = response.json()
    if route == "verdict":
        assert answer.pop("task")["slug"] == slug
    assert answer == {"ok": True, "output": "finished"}
    record = json.loads(calls.read_text())
    argv = [route, slug, *expected]
    if route == "say":
        argv.extend(["--file", record["argv"][-1]])
        assert record["file"] == body["text"].strip()
        assert not Path(argv[-1]).exists()
    assert record["argv"] == argv
    logs = [row.message for row in caplog.records if row.message.startswith("/api/actions/")]
    assert len(logs) == 1 and f"/api/actions/{route} argv=" in logs[0] and "exit=0" in logs[0]
    assert "--private" not in logs[0]


def test_ship_verdict_answer_and_socket_carry_the_verdict(ships):
    client, application, settings, _, _, _ = ships
    directory = settings.path("tasks") / "accepted"
    directory.mkdir()
    (directory / "state.json").write_text(json.dumps({
        "kind": "work", "repo": "/src/project", "created": 100, "turn_finished": 200,
        "outcome": "completed", "result": {"status": "done"}}))
    board = application.state.board
    board.store.poll()

    class Client:
        messages = []
        put_nowait = messages.append

    board.clients.add(Client)
    # teamster verdict appends its journal row; the board reads it before it answers.
    settings.path("telemetry").write_text(json.dumps({
        "v": 1, "kind": "verdict", "at": 300, "slug": "accepted", "repo": "project",
        "created": 100, "verdict": "accepted", "note": None}) + "\n")
    response = client.post("/api/actions/verdict", json={"slug": "accepted", "verdict": "accepted"})
    board.clients.discard(Client)
    task = response.json()["task"]
    assert (task["column"], task["lead_verdict"], task["lead_verdict_at"]) == ("review_me", "accepted", 300)
    assert {"type": "task", "task": task} in Client.messages


@pytest.mark.parametrize("route,body,allowed", [
    ("say", {"text": "Continue"}, {"work-idle", "review-idle", "reflect-idle"}),
    ("verdict", {"verdict": "accepted"}, {"work-idle", "work-alive", "work-archived",
                                         "review-idle", "review-alive", "review-archived"}),
    ("review", {}, {"work-idle", "review-idle"}),
    ("stop", {}, {"work-alive", "review-alive", "reflect-alive", "scout-alive"}),
    ("clean", {}, {"work-idle", "review-idle", "reflect-idle", "scout-idle"}),
])
def test_ship_action_states_kinds_and_unknown_tasks(ships, route, body, allowed):
    client, _, _, _, calls, _ = ships
    for kind in ("work", "review", "reflect", "scout"):
        for state in ("idle", "alive", "archived"):
            base = f"{kind}-{state}"
            slug = base + ("-20261110T000000Z" if state == "archived" else "")
            before = calls.read_text() if calls.exists() else ""
            response = client.post(f"/api/actions/{route}", json={"slug": slug, **body})
            assert response.status_code == (200 if base in allowed else 409), (route, slug, response.text)
            if base in allowed:
                record = json.loads(calls.read_text().splitlines()[-1])
                assert record["argv"][:2] == [route, base]
            else:
                assert (calls.read_text() if calls.exists() else "") == before
                if route == "stop":
                    assert response.json() == {"ok": False, "error": "not running"}
    for slug, status in (("unknown", 404), ("local_ship", 409)):
        response = client.post(f"/api/actions/{route}", json={"slug": slug, **body})
        assert response.status_code == status
        if route == "stop" and status == 409:
            assert response.json() == {"ok": False, "error": "not running"}


@pytest.mark.parametrize("version,exit_code,queue", [
    ("1.60.0", 0, True), ("teamster 2.0.1", 0, True), ("1.59.9", 0, False), ("1.60.0", 1, False),
    ("unknown", 0, False),
])
def test_ship_say_queues_to_a_live_ship_from_teamster_1_60(ships, version, exit_code, queue):
    client, _, _, _, calls, control = ships
    control.write_text(json.dumps({"version": version, "version_exit": exit_code}))
    for _ in range(2):
        assert client.get("/api/tasks/work-alive").json()["actions"] == {"enabled": True, "reason": None,
                                                                        "queue": queue}
    response = client.post("/api/actions/say", json={"slug": "work-alive", "text": " Next ",
                                                      "options": {"effort": "low"}})
    if queue:
        assert response.json() == {"ok": True, "output": "finished"}
        record = json.loads(calls.read_text())
        assert record["argv"] == ["say", "work-alive", "--effort=low", "--file", record["argv"][4], "--queue"]
        assert record["file"] == "Next"
    else:
        assert response.status_code == 409
        assert not calls.exists()
    # An idle ship takes the order at once; an archived ship and a scout refuse it as before.
    assert client.post("/api/actions/say", json={"slug": "work-idle", "text": "Now"}).status_code == 200
    assert len(json.loads(calls.read_text().splitlines()[-1])["argv"]) == 4
    for slug in ("scout-alive", "work-archived-20261110T000000Z"):
        assert client.post("/api/actions/say", json={"slug": slug, "text": "Now"}).status_code == 409
    assert (calls.parent / "versions.log").read_text() == "asked\n"


@pytest.mark.parametrize("options", [
    None, [], {"unknown": "x"}, {"model": "-flag"}, {"model": "x" * 65}, {"model": True},
    {"effort": "extreme"}, {"max_minutes": 4}, {"max_minutes": 601}, {"max_minutes": 5.5},
    {"max_minutes": True}, {"max_weekly": 0.4}, {"max_weekly": 101}, {"max_weekly": True},
    {"max_weekly": "10"}, {"fix_rounds": -1}, {"fix_rounds": 6}, {"fix_rounds": 1.5},
    {"ci_rounds": -1}, {"ci_rounds": 6}, {"ci_rounds": False}, {"reviewer": "other"},
    {"review_angles": "security"}, {"review_angles": []}, {"review_angles": ["security", "security"]},
    {"review_angles": ["other"]}, {"review_angles": ["correctness", "concurrency", "security", "tests", "tests"]},
])
def test_ship_say_invalid_options(ships, options):
    client, _, _, _, calls, _ = ships
    response = client.post("/api/actions/say", json={"slug": "work-idle", "text": "Continue", "options": options})
    assert response.status_code == 400
    assert response.json()["ok"] is False
    assert not calls.exists()


@pytest.mark.parametrize("route,body", [
    ("say", {}), ("say", {"text": None}), ("say", {"text": " "}), ("say", {"text": "x" * 8001}),
    ("verdict", {}), ("verdict", {"verdict": "other"}),
    ("verdict", {"verdict": "accepted", "note": "x" * 201}),
    ("verdict", {"verdict": "accepted", "note": False}),
    ("review", {"reviewer": "other"}), ("review", {"effort": "other"}),
    ("review", {"review_angles": ["tests", "tests"]}), ("clean", {"keep_branch": 1}),
])
def test_ship_invalid_action_fields(ships, route, body):
    client, _, _, _, calls, _ = ships
    response = client.post(f"/api/actions/{route}", json={"slug": "work-idle", **body})
    assert response.status_code == 400
    assert response.json()["ok"] is False
    assert not calls.exists()


@pytest.mark.parametrize("route", ["say", "verdict", "review", "stop", "clean"])
def test_ship_action_slug_and_request_protection(ships, route):
    client, _, settings, _, calls, _ = ships
    body = {"text": "Continue", "verdict": "accepted"}
    for slug in (None, "", "..", "../work-idle", ".hidden", "work\\idle", "bad\0name"):
        response = client.post(f"/api/actions/{route}", json={"slug": slug, **body})
        assert response.status_code == 400
    for headers in ({"Origin": None}, {"Origin": "http://evil.example"},
                    {"Host": "evil.example"}, {"X-Teamster-Board": None},
                    {"Content-Type": "text/plain"}, {"Origin": ["http://localhost:8787"] * 2}):
        request = client.build_request("POST", f"/api/actions/{route}", json={"slug": "work-idle", **body})
        for name, value in headers.items():
            del request.headers[name]
            if isinstance(value, list):
                for item in value:
                    request.headers = request.headers.__class__([*request.headers.multi_items(), (name, item)])
            elif value is not None:
                request.headers[name] = value
        response = client.send(request)
        assert response.status_code == 403
        assert response.json() == {"ok": False, "error": "forbidden"}
    for read_only, command, reason in ((True, settings.action_teamster, "read_only"),
                                       (False, None, "no_teamster")):
        settings.read_only, settings.action_teamster = read_only, command
        disabled = create_app(settings)
        with TestClient(disabled, base_url=str(client.base_url), headers=dict(client.headers)) as other:
            actions = other.get("/api/research").json()["actions"]
            assert actions == {"enabled": False, "reason": reason}
            assert other.get("/api/tasks/work-idle").json()["actions"] == {**actions, "queue": False}
            response = other.post(f"/api/actions/{route}", json={"slug": "work-idle", **body})
            assert response.status_code == 403
            assert response.json() == {"ok": False, "error": reason}
    assert not calls.exists()


def wait_for_account(predicate, seconds=8):
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, "Account operation did not finish"
        time.sleep(0.01)


def assert_no_accounts(socket):
    async def receive():
        with anyio.move_on_after(0.1):
            while True:
                message = await socket._send_rx.receive()
                assert json.loads(message["text"])["type"] != "accounts"
    socket.portal.call(receive)


@pytest.fixture
def account_actions(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(board_app, "PING_SECONDS", 0.05)
    script = tmp_path / "teamster.py"
    journal = tmp_path / "log.jsonl"
    old = time.time() - 40 * 86400
    journal.write_text("".join(json.dumps(row) + "\n" for row in [
        {"event": "account_login", "family": "codex", "account": "c1", "at": old, "status": "available"},
        {"event": "account_login", "family": "claude", "account": "cl1", "at": old, "status": "expired"},
        {"event": "account_login", "family": "claude", "account": "cl1", "at": old + 1, "status": "available"},
    ]))
    script.write_text('''import json, os, signal, subprocess, sys, time
from pathlib import Path
assert sys.flags.isolated
root = Path(__file__).parent
args = sys.argv[1:]
with (root / 'calls').open('a') as stream:
    stream.write(json.dumps(args) + '\\n')
def hold(name):
    while (root / name).exists():
        time.sleep(0.01)
def emit(event, **fields):
    print(json.dumps(dict(event=event, **fields)), flush=True)
if args == ['accounts', '--json']:
    assert sys.stdin.read() == ''
    hold('accounts-block')
    if (root / 'accounts-fail').exists():
        sys.exit('accounts unavailable')
    if (root / 'first-account.json').exists():
        print((root / 'first-account.json').read_text())
        sys.exit(0)
    names = {'codex': ['c1', 'c2', 'c3', 'fail', 'no-result', 'ignore', 'child-result', 'child-no-result'],
             'claude': ['cl1', '-second']}
    rows = {family: [{'name': n} for n in group if not (root / f'{family}.{n}.removed').exists()]
            for family, group in names.items()}
    print(json.dumps(dict(rows, login_harnesses=['codex', 'claude'])))
elif args[0] in ('account-remove', 'claude-remove'):
    command, separator, account = args
    assert separator == '--' and Path.cwd() == root and sys.stdin.read() == ''
    if account == 'fail':
        sys.exit('cannot remove the last account')
    family = 'codex' if command == 'account-remove' else 'claude'
    (root / f'{family}.{account}.removed').touch()
elif args == ['claude-probe', 'cl1']:
    assert Path.cwd() == root
    assert sys.stdin.read() == ''
    assert os.getsid(0) == os.getpid()
    (root / 'probe-ready').touch()
    hold('probe-block')
else:
    assert Path.cwd() == root
    command, account = args[:2]
    assert args == ['claude-login' if account.startswith('cl') else 'login', account, '--events'] + (
        ['--new'] if account in ('fresh', 'cl-fresh') else [])
    assert os.getsid(0) == os.getpid()
    if account in ('child-result', 'child-no-result'):
        if account == 'child-result':
            emit('result', ok=True, status='available', message='Signed in')
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = subprocess.Popen(['sleep', '30'])
        (root / (account + '-pid')).write_text(str(child.pid))
        sys.exit(0)
    if account == 'ignore':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        emit('open', url='https://example.test/ignore')
        while True:
            time.sleep(1)
    if account == 'no-result':
        sys.exit(7)
    if account == 'fail':
        sys.stderr.write('x' * 2300 + ' failure tail')
        sys.stderr.flush()
        emit('result', ok=False, status='expired', message='Sign-in refused')
        sys.exit(1)
    print('not json\\n[]\\n{"event":"unknown"}\\n{"event":"open","url":3}', flush=True)
    print('x' * 70000, flush=True)
    for index in range(42):
        emit('output', text=str(index) + ':' + 'x' * 400)
    emit('open', url='https://example.test/login')
    if command == 'claude-login':
        emit('prompt')
        emit('output', text='received:' + sys.stdin.readline().rstrip('\\n'))
    else:
        emit('code', code='ONE-TIME', expires_at=1900000000)
        while not (root / (account + '-release')).exists():
            time.sleep(0.01)
    emit('stage', stage='saving')
    emit('stage', stage='checking')
    with (root / 'log.jsonl').open('a') as stream:
        stream.write(json.dumps({'event': 'account_login', 'family': 'claude' if command == 'claude-login' else 'codex',
                                 'account': account, 'at': time.time(), 'status': 'available'}) + '\\n')
    emit('result', ok=True, status='available', message='Signed in')
''')
    calls, expected_commands = [], []
    execute = asyncio.create_subprocess_exec

    def requested(response):
        route = response.request.url.path
        if response.status_code != 200 or route not in ("/api/actions/login", "/api/actions/account-add",
                                                         "/api/actions/account-refresh"):
            return
        data = json.loads(response.request.content)
        if route == "/api/actions/account-add":
            response.read()
            if response.json()["login"]["stage"] == "starting":
                command = "claude-login" if data["family"] == "claude" else "login"
                expected_commands.append([command, data["account"], "--events", "--new"])
        elif route == "/api/actions/login":
            command = "login" if data["family"] == "codex" else "claude-login"
            expected_commands.append([command, data["account"], "--events"])
        elif data["family"] == "claude":
            expected_commands.append(["claude-probe", data["account"]])

    async def recorded(*args, **options):
        calls.append((list(args), options))
        return await execute(*args, **options)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", recorded)
    settings = Settings(tmp_path, script, layout="new", poll_seconds=0.01, action_teamster=None,
                        web_dist=tmp_path / "dist")
    application = create_app(settings)
    board = application.state.board
    with TestClient(application, base_url="http://localhost", headers={
        "Host": "localhost", "Origin": "http://localhost", "X-Teamster-Board": "1",
    }) as client:
        client.event_hooks["response"].append(requested)
        wait_for_account(lambda: board.accounts.value["data"] is not None)
        yield client, board, tmp_path, calls
    for argv, options in calls:
        expected = ["accounts", "--json"] if argv[3] == "accounts" else expected_commands.pop(0)
        assert argv == ["python3", "-I", str(script), *expected]
        if expected[0] != "accounts":
            assert options["start_new_session"] is True
            assert options["cwd"] == tmp_path
            assert options["stdout"] == options["stderr"] == asyncio.subprocess.PIPE
            assert options["stdin"] == (asyncio.subprocess.DEVNULL if expected[0] == "claude-probe"
                                         else asyncio.subprocess.PIPE)
    assert not expected_commands


@pytest.fixture
def duty_actions(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CODEX_TASK_HOME", str(tmp_path))
    script = tmp_path / "teamster"
    script.write_text(f"#!{sys.executable}\n" + '''import json, os, sys, time
from pathlib import Path
root = Path(__file__).parent
args = sys.argv[1:]
with (root / 'duty-calls').open('a') as stream:
    stream.write(json.dumps({'args': args, 'cwd': os.getcwd(), 'stdin': sys.stdin.read()}) + '\\n')
record_path = root / 'record'
record = json.loads(record_path.read_text()) if record_path.exists() else None
if args == ['--version']:
    print((root / 'version').read_text() if (root / 'version').exists() else '1.87.0')
elif args == ['accounts', '--json']:
    print(json.dumps({'codex': [{'name': 'c1', 'status': 'available'},
                               {'name': 'logged-out', 'status': 'not_logged_in'},
                               {'name': 'duplicate', 'status': 'duplicate'}],
                      'claude': [{'name': 'cl1'}, {'name': 'no-token', 'token_unavailable': True},
                                 {'name': 'expired', 'needs_login': True}], 'duty': record}))
elif args == ['duty', 'status', '--json']:
    if (root / 'status-fail').exists():
        sys.exit(4)
    print(json.dumps({'duty': record, 'unreadable': False, 'stale': False}))
else:
    assert args[:1] == ['duty']
    assert Path.cwd() == root
    if (root / 'refuse').exists():
        print('sign in before pinning; nothing changed', file=sys.stderr)
        sys.exit(2)
    if args[1] == 'tick':
        # An exclusive marker makes overlapping ticks fail, even from separate subprocesses.
        with (root / 'running').open('x'):
            (root / 'tick-started').touch()
            while (root / 'tick-block').exists():
                time.sleep(0.01)
        (root / 'running').unlink()
        if (root / 'fail-tick').exists():
            (root / 'fail-tick').unlink()
            print('election temporarily failed', file=sys.stderr)
            sys.exit(3)
    if args[1] == 'clear':
        record_path.unlink(missing_ok=True)
    else:
        pinned = args[1] == 'set'
        record = {'account': args[2] if pinned else 'cl1', 'family': args[4] if pinned else 'claude',
                  'pinned': pinned, 'pinned_unavailable': 'exhausted' if pinned else None,
                  'checked_at': time.time(), 'since': 1, 'reason': 'manual' if pinned else 'elected'}
        record_path.write_text(json.dumps(record))
        if pinned:
            print('warning: account exhausted; it stays pinned')
''')
    script.chmod(0o755)

    def start(**options):
        settings = Settings(tmp_path, script, web_dist=tmp_path / "dist", poll_seconds=0.02,
                            **{"action_teamster": str(script), "duty_seconds": 0, **options})
        return TestClient(create_app(settings), base_url="http://localhost", headers={
            "Host": "localhost", "Origin": "http://localhost", "X-Teamster-Board": "1"})

    def calls():
        path = tmp_path / "duty-calls"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    return start, calls, tmp_path


@pytest.fixture
def opencode_cli(duty_actions, monkeypatch, fake_opencode):
    start, _, root = duty_actions
    monkeypatch.setenv("PATH", str(fake_opencode.parent) + os.pathsep + os.environ["PATH"])
    provider = "alibaba-token-plan"
    name = "Alibaba Token Plan"
    model = provider + "/qwen4-max"
    (root / "providers").write_text(json.dumps([{"id": provider, "name": name, "connections": [
        {"type": "credential", "id": "cred_private", "label": "private label", "method": "key"}]}]))
    (root / "models").write_text(f"opencode-go/global-model\n{provider}/other\n{model}\n")
    return start, root, {"provider": provider, "name": name, "model": model}


def test_task_chat_applies_bound_model_before_prompt(opencode_cli, task_chat_board):
    _, root, row = opencode_cli
    chat, settings, agent, client = task_chat_board
    provider, = client.get("/api/opencode/providers").json()["providers"]
    assert row["model"] in provider["models"]
    selection = {"provider": provider["id"], "model": row["model"]}
    headers = {"Origin": "http://localhost", "X-Teamster-Board": "1"}
    assert client.post("/api/actions/opencode-add", headers=headers, json=selection).json() == {"ok": True}
    worktree = settings.path("worktrees") / "claude-demo" / "repository"
    log = worktree / "agent.requests"
    agent.with_name("codex-acp").symlink_to(agent)
    with chat("demo") as socket:
        assert socket.receive_json() == {"type": "ready", "executor": "codex", "agent": "codex-acp"}
    assert [json.loads(line)["method"] for line in log.read_text().splitlines()] == ["initialize", "session/new"]
    log.unlink()
    with chat("demo", selection) as socket:
        ready = socket.receive_json()
        assert ready["type"] == "ready" and ready["agent"] == "opencode acp"
        assert (ready["provider"], ready["model"]) == (row["provider"], row["model"])
        socket.send_json({"type": "prompt", "text": "hello"})
        assert socket.receive_json() == {"type": "chunk", "text": "demo turn 1"}
        assert socket.receive_json() == {"type": "chunk", "text": "hello"}
        assert socket.receive_json()["type"] == "done"
    requests = [json.loads(line) for line in log.read_text().splitlines()]
    assert [r["method"] for r in requests] == ["initialize", "session/new", "session/set_config_option", "session/prompt"]
    assert requests[2]["params"] == {"sessionId": requests[3]["params"]["sessionId"], "configId": "model",
                                     "value": row["model"]}

    def refuses(requested):
        with chat("demo", requested) as socket:
            answer = socket.receive_json()
            assert answer["type"] == "error" and answer["message"]

    log.unlink()
    refuses({**selection, "model": row["provider"] + "/other"})
    assert not log.exists()
    (root / "keep-default").touch()
    refuses(selection)
    assert [json.loads(line)["method"] for line in log.read_text().splitlines()] == [
        "initialize", "session/new", "session/set_config_option"]
    log.unlink()
    auth = (root / "providers").read_bytes()
    (root / "providers").write_text("[]")
    refuses(selection)
    assert not log.exists()
    (root / "providers").write_bytes(auth)
    assert client.post("/api/actions/opencode-remove", headers=headers, json={"provider": row["provider"]}).json()["ok"]
    refuses(selection)
    assert not log.exists()


def test_opencode_bind_restart_and_detach(opencode_cli):
    start, root, row = opencode_cli
    auth = (root / "providers").read_bytes()
    body = {"provider": row["provider"], "model": row["model"]}
    add = "/api/actions/opencode-add"
    remove = "/api/actions/opencode-remove"
    with start() as client:
        catalog = client.get("/api/opencode/providers").json()
        assert catalog == {"status": "ok", "providers": [
            {"id": row["provider"], "name": row["name"], "models": [row["provider"] + "/other", row["model"]]}]}
        assert client.post(add, json={**body, "command": "opencode auth export"}).status_code == 400
        wait_for_account(lambda: client.app.state.board.accounts.duty["fetched_at"] is not None)
        with client.websocket_connect("/ws") as socket:
            native = socket.receive_json()["snapshot"]["accounts"]["data"]
            assert client.post(add, json=body).json() == {"ok": True}
            published = receive_until(socket, "accounts")["accounts"]
            assert published["opencode"] == [row]
            assert published["data"] == native
        assert client.post(add, json=body).json() == {"ok": True}
        assert client.get("/api/snapshot").json()["accounts"]["opencode"] == [row]
        assert client.post(add, json={**body, "model": "opencode-go/global-model"}).status_code >= 400
        (root / "models").write_text("opencode-go/global-model\n")
        assert client.post(add, json=body).status_code >= 400

    with start() as restarted:
        assert restarted.get("/api/snapshot").json()["accounts"]["opencode"] == [row]
        for url, fields in ((add, body), (remove, {"provider": row["provider"]})):
            assert restarted.post(url, json=fields, headers={"Origin": "https://example.test"}).status_code == 403
        assert restarted.post(remove, json={"provider": row["provider"]}).json() == {"ok": True}
        assert not restarted.get("/api/snapshot").json()["accounts"].get("opencode")
        assert (root / "providers").read_bytes() == auth
        assert all(json.loads(line) in (["auth", "list", "--format", "json"], ["models"])
                   for line in (root / "opencode-calls").read_text().splitlines())
    with start(read_only=True) as locked:
        assert not locked.get("/api/snapshot").json()["accounts"].get("opencode")
        for url, fields in ((add, body), (remove, {"provider": row["provider"]})):
            assert locked.post(url, json=fields).json() == {"ok": False, "error": "read_only"}

    saved = root / "board-opencode.json"
    (root / "models").write_text(row["model"] + "\n")
    for damaged in (b'{"version":', b'{"version":2,"bindings":[]}', b'{"version":1,"bindings":{}}'):
        saved.write_bytes(damaged)
        with start() as restarted:
            wait_for_account(lambda: restarted.app.state.board.accounts.duty["fetched_at"] is not None)
            assert restarted.get("/api/snapshot").json()["accounts"]["data"]["codex"] == native["codex"]
            for url, fields in ((add, body), (remove, {"provider": row["provider"]})):
                refused = restarted.post(url, json=fields)
                assert refused.status_code == 503 and refused.json()["error"] == "opencode_bindings_unavailable"
                assert saved.read_bytes() == damaged


def test_opencode_discovery_empty_broken_and_missing(opencode_cli, monkeypatch):
    start, root, row = opencode_cli
    with start() as client:
        providers = root / "providers"
        providers.write_text("[]")
        discover = "/api/opencode/providers"
        assert client.get(discover).json() == {"status": "ok", "providers": []}
        providers.write_text("private diagnostic")
        assert client.get(discover).json() == {"status": "error", "providers": []}
        (root / "opencode").unlink()
        # Restrict lookup to the temporary home even on machines with a real OpenCode.
        (root / "python3").symlink_to(sys.executable)
        monkeypatch.setenv("PATH", str(root))
        assert client.get(discover).json() == {"status": "unavailable", "providers": []}
        refused = client.post("/api/actions/opencode-add", json={"provider": row["provider"], "model": row["model"]})
        assert refused.status_code >= 400 and refused.json()["ok"] is False


def test_duty_action_shapes_data_and_accounts_publication(duty_actions):
    start, calls, root = duty_actions
    with start() as client:
        board = client.app.state.board
        wait_for_account(lambda: board.accounts.duty["fetched_at"] is not None)
        data = client.get("/api/snapshot").json()["accounts"]["data"]
        assert data["duty"]["mode"] == "off" and data["duty"]["choosable"] is True
        assert [(row["pinnable"], row["pin_reason"]) for row in data["codex"]] == [
            (True, None), (False, "needs_login"), (True, None)]
        assert [row["pinnable"] for row in data["claude"]] == [True, False, False]
        with client.websocket_connect("/ws") as socket:
            socket.receive_json()
            for family, account in (("codex", "c1"), ("claude", "cl1")):
                response = client.post("/api/actions/duty", json={"account": account, "family": family})
                assert response.json() == {"ok": True, "warning": "warning: account exhausted; it stays pinned"}
                duty = receive_until(socket, "accounts")["accounts"]["data"]["duty"]
                assert (duty["mode"], duty["account"], duty["family"]) == ("pinned", account, family)
                assert duty["pinned_unavailable"] == "exhausted"
            for mode in ("auto", "off"):
                assert client.post("/api/actions/duty", json={"mode": mode}).json() == {"ok": True, "warning": None}
                duty = receive_until(socket, "accounts")["accounts"]["data"]["duty"]
                assert duty["mode"] == mode
                assert duty["account"] == ("cl1" if mode == "auto" else None)
                assert duty["last_election"]["error"] is None
                assert (duty["last_election"]["at"] is not None) == (mode == "auto")
        commands = [row for row in calls() if row["args"][0] == "duty" and row["args"][1] != "status"]
        assert [row["args"] for row in commands] == [
            ["duty", "set", "c1", "--family", "codex"], ["duty", "set", "cl1", "--family", "claude"],
            ["duty", "auto"], ["duty", "clear"]]
        assert all(row["cwd"] == str(root) and row["stdin"] == "" for row in commands)
        assert sum(row["args"] == ["--version"] for row in calls()) == 1


def test_duty_action_validation_protection_and_refusal(duty_actions):
    start, calls, root = duty_actions
    with start() as client:
        wait_for_account(lambda: client.app.state.board.accounts.duty["fetched_at"] is not None)
        url = "/api/actions/duty"
        body = {"account": "c1", "family": "codex"}
        for invalid in ({}, {"mode": "pinned"}, {"mode": []}, {"account": "c1"}, {"family": "codex"},
                        {**body, "mode": "auto"}, {**body, "extra": True}, {"mode": "auto", "extra": True},
                        {"account": [], "family": "codex"}, {"account": "c1", "family": "other"}):
            assert client.post(url, json=invalid).status_code == 400
        assert client.post(url, json={**body, "account": "unknown"}).status_code == 404
        for header, value in (("Origin", None), ("Origin", "http://evil.example"), ("Host", "evil.example"),
                              ("X-Teamster-Board", None), ("Content-Type", "text/plain")):
            request = client.build_request("POST", url, json=body)
            del request.headers[header]
            if value is not None:
                request.headers[header] = value
            assert client.send(request).status_code == 403
        assert client.post(url, content="{", headers={"Content-Type": "application/json"}).status_code == 400
        assert client.post(url, json=[]).status_code == 400
        assert client.post(url, content="x" * 65537, headers={"Content-Type": "application/json"}).status_code == 413
        assert not any(row["args"][:2] == ["duty", "set"] for row in calls())
        (root / "refuse").touch()
        response = client.post(url, json=body)
        assert response.status_code == 422
        assert response.json() == {"ok": False, "error": "sign in before pinning; nothing changed"}


@pytest.mark.parametrize("reason,options,status", [
    ("old_teamster", {}, 409), ("read_only", {"read_only": True}, 403),
    ("no_teamster", {"action_teamster": None}, 403),
])
def test_duty_disabled_never_elects(duty_actions, reason, options, status):
    start, calls, root = duty_actions
    (root / "version").write_text("1.86.0")
    (root / "record").write_text(json.dumps({"account": "cl1", "family": "claude", "pinned": False}))
    with start(duty_seconds=0.01, **options) as client:
        board = client.app.state.board
        wait_for_account(lambda: board._duty_mode == "auto")
        duty = client.get("/api/snapshot").json()["accounts"]["data"]["duty"]
        assert duty["choosable"] is False and duty["reason_disabled"] == reason
        response = client.post("/api/actions/duty", json={"mode": "auto"})
        assert response.status_code == status and response.json()["error"] == reason
        time.sleep(0.05)
        assert not any(row["args"][0] == "duty" for row in calls())
        if reason != "old_teamster":
            assert not any(row["args"] == ["--version"] for row in calls())


def test_duty_timer_enters_auto_serializes_and_survives_failure(duty_actions, caplog):
    start, calls, root = duty_actions
    with start(duty_seconds=30) as client:
        board = client.app.state.board
        wait_for_account(lambda: board.accounts.duty["fetched_at"] is not None)
        ticks = lambda: [row for row in calls() if row["args"] == ["duty", "tick"]]
        time.sleep(0.25)
        assert not ticks()  # Off has no timer.
        (root / "tick-block").touch()
        (root / "fail-tick").touch()
        entered_auto = time.monotonic()
        assert client.post("/api/actions/duty", json={"mode": "auto"}).status_code == 200
        wait_for_account(lambda: (root / "tick-started").exists())
        assert time.monotonic() - entered_auto < board.settings.duty_seconds
        board.settings.duty_seconds = 0.2
        # The first tick runs immediately; multiple elapsed intervals cannot overlap it.
        time.sleep(0.25)
        assert len(ticks()) == 1
        (root / "tick-block").unlink()
        wait_for_account(lambda: board._election_error is not None)
        last = client.get("/api/snapshot").json()["accounts"]["data"]["duty"]["last_election"]
        assert last["error"] == "election temporarily failed" and isinstance(last["at"], float)
        assert "Duty election failed: election temporarily failed" in caplog.text
        wait_for_account(lambda: len(ticks()) >= 2 and board._election_error is None)
        for body, mode in (({"account": "c1", "family": "codex"}, "pinned"), ({"mode": "off"}, "off")):
            if mode == "off":
                (root / "status-fail").touch()
            assert client.post("/api/actions/duty", json=body).status_code == 200
            assert board._duty_mode == mode
            before = len(ticks())
            time.sleep(0.25)
            assert len(ticks()) == before
        (root / "status-fail").unlink()
        # A duty pinned outside the board is detected by an accounts refresh too.
        (root / "record").write_text(json.dumps({"account": None, "family": None, "pinned": False}))
        client.portal.call(board.refresh_accounts)
        wait_for_account(lambda: len(ticks()) > before)
        # A CLI clear between polls must stop the timer rather than recreate the duty.
        client.portal.call(board._duty_lock.acquire)
        try:
            (root / "record").unlink()
            before = len(ticks())
        finally:
            client.portal.call(board._duty_lock.release)
        wait_for_account(lambda: board._duty_mode == "off")
        assert not (root / "record").exists()
        assert len(ticks()) == before


def test_account_login_events_snapshot_and_last_logins(account_actions):
    client, board, root, _ = account_actions
    snapshot = client.get("/api/snapshot").json()
    assert snapshot["logins"] == []
    historical = snapshot["accounts"]["last_logins"]
    assert [(row["family"], row["account"], row["status"]) for row in historical] == [
        ("claude", "cl1", "available"), ("codex", "c1", "available")]
    assert all(row["at"] < time.time() - 31 * 86400 for row in historical)
    with client.websocket_connect("/ws") as socket:
        assert socket.receive_json()["snapshot"]["logins"] == []
        response = client.post("/api/actions/login", json={"family": "codex", "account": "c1"})
        assert response.status_code == 200
        initial = response.json()["login"]
        assert initial == {"id": initial["id"], "family": "codex", "account": "c1", "stage": "starting",
                           "started_at": initial["started_at"], "finished_at": None, "url": None,
                           "code": None, "code_expires_at": None, "prompt": False, "output": [],
                           "status": None, "ok": None, "message": None, "error": None}
        changes = [receive_until(socket, "login")["login"] for _ in range(45)]
        assert changes[0] == initial
        assert [row["output"][-1].split(":")[0] for row in changes[1:43]] == [str(i) for i in range(42)]
        waiting = changes[-1]
        assert waiting["stage"] == "waiting" and waiting["code"] == "ONE-TIME"
        assert waiting["url"] == "https://example.test/login" and waiting["code_expires_at"] == 1900000000
        assert len(waiting["output"]) == 40 and all(len(line) == 300 for line in waiting["output"])
        assert client.get("/api/snapshot").json()["logins"] == [waiting]
        finished_after = time.monotonic()
        (root / "c1-release").touch()
        ending = [receive_until(socket, "login")["login"] for _ in range(3)]
        assert [row["stage"] for row in ending] == ["saving", "checking", "done"]
        done = ending[-1]
        assert done["ok"] is True and done["status"] == "available"
        assert done["message"] == "Signed in" and done["error"] is None
        assert done["finished_at"] >= done["started_at"]
        accounts = receive_until(socket, "accounts")["accounts"]
        assert time.monotonic() - finished_after < 5
        # The direct success wakeup and the journal tail may coalesce or produce a second refresh.
        wait_for_account(lambda: any(row["account"] == "c1" and row["at"] > historical[-1]["at"]
                                     for row in board.account_value["last_logins"]))
        assert "last_logins" in accounts
        assert client.get("/api/snapshot").json()["logins"] == [done]
        for route in ("input", "cancel"):
            assert client.post(f"/api/actions/login/{route}", json={"id": done["id"], "text": "code"}).status_code == 409
        wait_for_account(lambda: not board.logins.jobs)
        async def expire():
            board.logins.rows[done["id"]]["finished_at"] = time.time() - 599
        client.portal.call(expire)
        assert len(client.get("/api/snapshot").json()["logins"]) == 1
        async def expired():
            board.logins.rows[done["id"]]["finished_at"] = time.time() - 601
        client.portal.call(expired)
        assert client.get("/api/snapshot").json()["logins"] == []


def test_account_login_claude_input(account_actions):
    client, _, _, _ = account_actions
    with client.websocket_connect("/ws") as socket:
        socket.receive_json()
        identifier = client.post("/api/actions/login", json={"family": "claude", "account": "cl1"}).json()["login"]["id"]
        while not receive_until(socket, "login")["login"]["prompt"]:
            pass
        for text in ("", "  ", "x" * 513, "a\nb", "a\x00b", "a\x7fb", 5):
            assert client.post("/api/actions/login/input", json={"id": identifier, "text": text}).status_code == 400
        response = client.post("/api/actions/login/input", json={"id": identifier, "text": "  page code  "})
        assert response.json() == {"ok": True}
        changed = receive_until(socket, "login")["login"]
        assert changed["prompt"] is False
        received = receive_until(socket, "login")["login"]
        assert received["output"][-1] == "received:page code"
        assert [receive_until(socket, "login")["login"]["stage"] for _ in range(3)] == ["saving", "checking", "done"]


@pytest.mark.parametrize("account", ["fail", "no-result", "spawn-error"])
def test_account_login_failure(account_actions, monkeypatch, account):
    client, board, _, calls = account_actions
    if account == "spawn-error":
        execute = asyncio.create_subprocess_exec
        async def fail(*args, **options):
            if args[3] == "login":
                calls.append((list(args), options))
                raise OSError("Cannot start sign-in")
            return await execute(*args, **options)
        monkeypatch.setattr(asyncio, "create_subprocess_exec", fail)
    response = client.post("/api/actions/login", json={"family": "codex", "account": "c1" if account == "spawn-error" else account})
    identifier = response.json()["login"]["id"]
    wait_for_account(lambda: board.logins.rows[identifier]["stage"] == "failed")
    row = client.get("/api/snapshot").json()["logins"][0]
    assert row["ok"] is False and row["finished_at"] is not None
    if account == "fail":
        assert row["status"] == "expired" and row["message"] == "Sign-in refused"
        assert row["error"] == "x" * (2048 - len(" failure tail")) + " failure tail"
    elif account == "no-result":
        assert row["error"] == "Sign-in exited without a result"
    else:
        assert row["error"] == "Cannot start sign-in"


@pytest.mark.parametrize("account", ["child-result", "child-no-result"])
def test_account_login_finishes_before_descendant_closes_pipes(account_actions, monkeypatch, account):
    client, board, root, _ = account_actions
    monkeypatch.setattr(logins_module, "LOGIN_TIMEOUT", 3)
    finished, refreshed = [], []
    publish, refresh = board.logins.publish, board.logins.refresh

    def record_finish(message):
        if message["login"]["stage"] in logins_module.FINISHED:
            proc = board.logins.processes[message["login"]["id"]]
            finished.append((proc.returncode, proc.stdout.at_eof()))
        publish(message)

    def record_refresh():
        refreshed.append(True)
        refresh()

    monkeypatch.setattr(board.logins, "publish", record_finish)
    monkeypatch.setattr(board.logins, "refresh", record_refresh)
    identifier = client.post("/api/actions/login", json={"family": "codex", "account": account}).json()["login"]["id"]
    wait_for_account(lambda: board.logins.rows[identifier]["stage"] in logins_module.FINISHED)
    row = board.logins.rows[identifier]
    success = account == "child-result"
    assert row["stage"] == ("done" if success else "failed")
    assert row["ok"] is success
    assert row["error"] == (None if success else "Sign-in exited without a result")
    assert finished == [(0, False)]
    assert refreshed == ([True] if success else [])
    child_pid = int((root / (account + "-pid")).read_text())
    wait_for_account(lambda: not board.logins.jobs)

    def child_stopped():
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            return True
        return False

    wait_for_account(child_stopped)


def test_account_login_cancel_releases_admission_before_process_exits(account_actions):
    client, board, _, _ = account_actions
    body = {"family": "codex", "account": "ignore"}
    first = client.post("/api/actions/login", json=body).json()["login"]["id"]
    other = client.post("/api/actions/login", json={**body, "account": "c1"}).json()["login"]["id"]
    wait_for_account(lambda: board.logins.rows[first]["stage"] == "waiting")
    proc = board.logins.processes[first]
    assert client.post("/api/actions/login/cancel", json={"id": first}).status_code == 200
    response = client.post("/api/actions/login", json=body)
    assert response.status_code == 200
    replacement = response.json()["login"]["id"]
    assert replacement != first
    assert first in board.logins.jobs and proc.returncode is None
    assert client.post("/api/actions/login", json={**body, "account": "c2"}).status_code == 429
    wait_for_account(lambda: board.logins.rows[replacement]["stage"] == "waiting")
    for identifier in (replacement, other):
        assert client.post("/api/actions/login/cancel", json={"id": identifier}).status_code == 200
    wait_for_account(lambda: not board.logins.jobs)


def test_account_login_and_probe_do_not_signal_finished_groups(account_actions, monkeypatch):
    client, board, root, _ = account_actions
    signals = []
    killpg = logins_module.os.killpg

    def record_signal(pid, sig):
        signals.append((pid, sig))
        return killpg(pid, sig)

    monkeypatch.setattr(logins_module.os, "killpg", record_signal)
    (root / "c1-release").touch()
    identifier = client.post("/api/actions/login", json={"family": "codex", "account": "c1"}).json()["login"]["id"]
    wait_for_account(lambda: not board.logins.jobs)
    assert board.logins.rows[identifier]["stage"] == "done"
    assert client.post("/api/actions/account-refresh", json={"family": "claude", "account": "cl1"}).status_code == 200
    wait_for_account(lambda: not board.refresh_jobs)
    assert (root / "probe-ready").exists()
    assert signals == []


@pytest.mark.parametrize("operation", ["cancel", "timeout"])
def test_account_login_termination_kills_after_grace(account_actions, monkeypatch, operation):
    client, board, _, _ = account_actions
    signals = []
    killpg = logins_module.os.killpg

    def record_signal(pid, sig):
        signals.append((pid, sig))
        return killpg(pid, sig)

    monkeypatch.setattr(logins_module.os, "killpg", record_signal)
    assert logins_module.KILL_SECONDS == 3
    assert logins_module.LOGIN_TIMEOUT == 16 * 60
    if operation == "timeout":
        monkeypatch.setattr(logins_module, "LOGIN_TIMEOUT", 0.5)
        monkeypatch.setattr(logins_module, "KILL_SECONDS", 0.05)
    with client.websocket_connect("/ws") as socket:
        socket.receive_json()
        identifier = client.post("/api/actions/login", json={"family": "codex", "account": "ignore"}).json()["login"]["id"]
        assert receive_until(socket, "login")["login"]["stage"] == "starting"
        assert receive_until(socket, "login")["login"]["stage"] == "waiting"
        proc = board.logins.processes[identifier]
        started = time.monotonic()
        if operation == "cancel":
            assert client.post("/api/actions/login/cancel", json={"id": identifier}).json() == {"ok": True}
        row = receive_until(socket, "login")["login"]
        assert row["stage"] == ("cancelled" if operation == "cancel" else "failed")
        if operation == "timeout":
            assert row["error"] == "Время на вход вышло"
        wait_for_account(lambda: not board.logins.jobs)
        assert proc.returncode == -9
        assert signals == [(proc.pid, signal.SIGTERM), (proc.pid, signal.SIGKILL)]
        if operation == "cancel":
            assert time.monotonic() - started >= 3


def test_account_login_admission_and_removal(account_actions):
    client, board, root, _ = account_actions
    for family, account in (("codex", "c1 "), ("claude", "c1"), ("codex", "unknown")):
        assert client.post("/api/actions/login", json={"family": family, "account": account}).status_code == 404
    for body in ({}, {"family": "other", "account": "c1"}, {"family": "codex", "account": 2}):
        assert client.post("/api/actions/login", json=body).status_code == 400
    first = client.post("/api/actions/login", json={"family": "codex", "account": "c1"}).json()["login"]
    remove = "/api/actions/account-remove"
    assert client.post(remove, json={"family": "codex", "account": "c1"}).status_code == 409
    response = client.post("/api/actions/login", json={"family": "codex", "account": "c1"})
    assert response.status_code == 409 and response.json()["error"] == "Вход уже идёт"
    assert client.post("/api/actions/login/input", json={"id": first["id"], "text": "code"}).status_code == 409
    second = client.post("/api/actions/login", json={"family": "claude", "account": "cl1"}).json()["login"]
    assert client.post("/api/actions/login", json={"family": "codex", "account": "c2"}).status_code == 429
    assert len(client.get("/api/snapshot").json()["logins"]) == 2
    for row in (first, second):
        assert client.post("/api/actions/login/cancel", json={"id": row["id"]}).status_code == 200
    wait_for_account(lambda: not board.logins.jobs)
    add = "/api/actions/account-add"
    new = {"family": "codex", "account": "fresh"}
    for invalid in ({**new, "account": "../outside"}, {**new, "family": "claude", "account": "-flag"},
                    {**new, "home": "/another"}, {**new, "family": "opencode"}):
        assert client.post(add, json=invalid).status_code == 400
    assert client.post(add, json={**new, "account": "c1"}).status_code == 409
    inventory = root / "first-account.json"
    for data, expected in (({"codex": [{"name": "existing"}]}, 503), ({"login_harnesses": ["codex"]}, 503),
                           ({"codex": [], "login_harnesses": []}, 422)):
        inventory.write_text(json.dumps(data))
        client.portal.call(board.refresh_accounts)
        assert client.post(add, json=new).status_code == expected
    inventory.write_text(json.dumps({"codex": [], "claude": [], "login_harnesses": ["codex", "claude"]}))
    client.portal.call(board.refresh_accounts)
    for target in (new, {"family": "claude", "account": "cl-fresh"}):
        initial = client.post(add, json=target).json()["login"]
        wait_for_account(lambda: board.logins.rows[initial["id"]]["stage"] == "waiting")
        assert client.post(add, json=target).json()["login"]["id"] == initial["id"]
        assert client.post("/api/actions/login", json=target).status_code == 404
        assert client.post("/api/actions/login/cancel", json={"id": initial["id"]}).json() == {"ok": True}
    wait_for_account(lambda: not board.logins.jobs)
    inventory.unlink()
    client.portal.call(board.refresh_accounts)
    refused = client.post(remove, json={"family": "codex", "account": "fail"})
    assert refused.status_code == 422 and refused.json()["error"] == "cannot remove the last account"
    with client.websocket_connect("/ws") as socket:
        socket.receive_json()
        for family, name in (("codex", "c1"), ("claude", "-second")):
            if family == "claude":
                (root / "accounts-fail").touch()
            body = {"family": family, "account": name}
            assert client.post(remove, json=body).json() == {"ok": True}
            assert (root / f"{family}.{name}.removed").exists()
            snapshot = receive_until(socket, "accounts")["accounts"]
            assert all(row["name"] != name for row in snapshot["data"][family])
            assert client.post("/api/actions/login", json=body).status_code == 404
        assert client.post(add, json=new).status_code == 503  # Failed read kept the previous rows.


@pytest.mark.parametrize("route", ["login", "login/input", "login/cancel", "account-refresh", "account-remove", "account-add"])
def test_account_action_validation_protection_and_read_only(account_actions, route):
    client, board, _, calls = account_actions
    url = f"/api/actions/{route}"
    body = {"family": "codex", "account": "unknown", "id": "unknown", "text": "code"}
    assert client.post(url, json=body).status_code == (400 if route == "account-add" else 404)
    assert client.post(url, json={}).status_code == 400
    for headers in ({"Origin": None}, {"Origin": "http://evil.example"}, {"Host": "evil.example"},
                    {"X-Teamster-Board": None}, {"Content-Type": "text/plain"}):
        request = client.build_request("POST", url, json=body)
        for name, value in headers.items():
            del request.headers[name]
            if value is not None:
                request.headers[name] = value
        assert client.send(request).status_code == 403
    assert client.post(url, content="{", headers={"Content-Type": "application/json"}).status_code == 400
    assert client.post(url, json=[]).status_code == 400
    assert client.post(url, content="x" * (64 * 1024 + 1), headers={"Content-Type": "application/json"}).status_code == 413
    board.settings.read_only = True
    assert client.post(url, json=body).json() == {"ok": False, "error": "read_only"}
    assert client.post(url, json=body).status_code == 403
    assert len(calls) == 1  # Only the startup accounts snapshot.


def test_account_refresh_codex_throttle_and_claude_probe(account_actions):
    client, board, root, calls = account_actions
    with client.websocket_connect("/ws") as socket:
        socket.receive_json()
        (root / "accounts-block").touch()
        body = {"family": "codex", "account": "c1"}
        assert client.post("/api/actions/account-refresh", json=body).json() == {"ok": True}
        assert client.post("/api/actions/account-refresh", json=body).status_code == 409
        assert client.post("/api/actions/account-refresh", json={**body, "account": "c2"}).status_code == 429
        (root / "accounts-block").unlink()
        assert receive_until(socket, "accounts")["accounts"]["error"] is None
        wait_for_account(lambda: not board.refresh_jobs)
        assert client.post("/api/actions/account-refresh", json=body).status_code == 429
        board._refresh_started -= 30
        assert client.post("/api/actions/account-refresh", json=body).status_code == 200
        receive_until(socket, "accounts")
        wait_for_account(lambda: not board.refresh_jobs)
        before_probe = len(calls)
        (root / "probe-block").touch()
        body = {"family": "claude", "account": "cl1"}
        assert client.post("/api/actions/account-refresh", json=body).json() == {"ok": True}
        wait_for_account(lambda: (root / "probe-ready").exists())
        assert client.post("/api/actions/account-refresh", json=body).status_code == 409
        assert_no_accounts(socket)
        assert [argv[3:] for argv, _ in calls[before_probe:]] == [["claude-probe", "cl1"]]
        (root / "probe-block").unlink()
        assert receive_until(socket, "accounts")["accounts"]["error"] is None
        wait_for_account(lambda: not board.refresh_jobs)
        assert [argv[3:] for argv, _ in calls[before_probe:]] == [["claude-probe", "cl1"], ["accounts", "--json"]]


def test_account_refresh_probe_timeout_still_refreshes(account_actions, monkeypatch):
    client, board, root, calls = account_actions
    assert accounts_module.PROBE_TIMEOUT == 90
    monkeypatch.setattr(accounts_module, "PROBE_TIMEOUT", 2)
    before_probe = len(calls)
    (root / "probe-block").touch()
    with client.websocket_connect("/ws") as socket:
        socket.receive_json()
        assert client.post("/api/actions/account-refresh", json={"family": "claude", "account": "cl1"}).status_code == 200
        wait_for_account(lambda: (root / "probe-ready").exists())
        assert_no_accounts(socket)
        assert [argv[3:] for argv, _ in calls[before_probe:]] == [["claude-probe", "cl1"]]
        assert receive_until(socket, "accounts")["accounts"]["error"] is None
        wait_for_account(lambda: not board.refresh_jobs)
        assert [argv[3:] for argv, _ in calls[before_probe:]] == [["claude-probe", "cl1"], ["accounts", "--json"]]


@pytest.fixture
def landing_task(tmp_path, monkeypatch):
    """A lesson task with local git and executable fakes for every service write."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    data = home / ".teamster"
    tasks = data / "tasks"
    archive = tasks / ".archive"
    archive.mkdir(parents=True)
    monkeypatch.setenv("TEAMSTER_HOME", str(data))
    repo = home / "project"
    subprocess.run(["git", "init", "--quiet", str(repo)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "remote", "add", "origin",
                    "https://github.com/kaifaty/project.git"], check=True, capture_output=True)
    worktree = home / "lesson-worktree"
    subprocess.run(["git", "init", "--quiet", "-b", "lesson-branch", str(worktree)],
                   check=True, capture_output=True)
    subprocess.run(["git", "-C", str(worktree), "remote", "add", "origin",
                    "https://github.com/kaifaty/project.git"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(worktree), "-c", "user.name=Test", "-c", "user.email=test@example.com",
                    "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Baseline"],
                   check=True, capture_output=True)
    subprocess.run(["git", "-C", str(worktree), "update-ref", "refs/remotes/origin/main", "HEAD"],
                   check=True, capture_output=True)
    sha = subprocess.run(["git", "-C", str(worktree), "rev-parse", "HEAD"], check=True,
                         capture_output=True, text=True).stdout.strip()
    entry, slug = "batch-2026-11-16.md W1", "lesson-w1-1116"
    (archive / "INDEX.md").write_text(f"| 2026-11-16 | {entry} | invariant | check | accepted |\n")
    (archive / "batch-2026-11-16.md").write_text("## W1. Keep the check\nproposal: Add the check.\n")
    directory = tasks / slug
    directory.mkdir()
    (directory / "brief.md").write_text(f"Внедрить урок «{entry}»: Keep the check.\n")
    pr = "https://github.com/kaifaty/project/pull/42"
    state = {"created": 1, "turns": 1, "turn_finished": 2, "repo": str(repo),
             "worktree": str(worktree), "branch": "lesson-branch", "base": "origin/main",
             "outcome": "completed", "result": {"status": "done", "summary": "Implemented"},
             "publish": {"pr": pr, "sha": sha, "pushed": True}, "checks": [{"outcome": "passed"}],
             "review_result": {"verdict": "clean", "findings": []},
             "ci": {"outcome": "passed", "sha": sha}}
    control, calls = tmp_path / "landing-control.json", tmp_path / "landing-calls.jsonl"
    control.write_text(json.dumps({"pr": {"state": "OPEN", "mergeable": "MERGEABLE",
        "mergeStateStatus": "CLEAN", "baseRefName": "main", "headRefOid": sha,
        "headRefName": "lesson-branch", "mergeCommit": None, "files": [{"path": "app.py"}], "url": pr, "number": 42},
        "checks": [{"bucket": "pass"}, {"bucket": "skipping"}], "branch_checked_out": True}))
    monkeypatch.setenv("LANDING_CONTROL", str(control))
    monkeypatch.setenv("LANDING_CALLS", str(calls))
    monkeypatch.setenv("LANDING_TASK", str(directory))
    bin_path = tmp_path / "landing-bin"
    bin_path.mkdir()
    script = f"#!{sys.executable}\n" + '''import json, os, sys, time
from pathlib import Path
name, args = Path(sys.argv[0]).name, sys.argv[1:]
control_path = Path(os.environ["LANDING_CONTROL"])
control = json.loads(control_path.read_text())
with Path(os.environ["LANDING_CALLS"]).open("a") as stream:
    stream.write(json.dumps({"command": name, "argv": args, "cwd": os.getcwd()}) + "\\n")
if control.get("sleep_command") == name:
    Path(str(control_path) + ".ready").touch()
    while Path(str(control_path) + ".block").exists():
        time.sleep(0.01)
if name == "gh":
    if control.pop("gh_error_once", False):
        control_path.write_text(json.dumps(control))
        print("GitHub is temporarily unavailable", file=sys.stderr)
        sys.exit(1)
    if args[:2] == ["pr", "view"]:
        print(json.dumps(control["pr"]))
    elif args[:2] == ["pr", "checks"]:
        print(json.dumps(control["checks"]))
        sys.exit(control.get("checks_exit", 0))
    elif args[:2] == ["pr", "merge"]:
        expected = args[args.index("--match-head-commit") + 1]
        actual = control.get("head_at_merge", control["pr"]["headRefOid"])
        if expected != actual:
            print("PR head changed", file=sys.stderr)
            sys.exit(1)
        control["pr"]["state"] = "MERGED"
        control["pr"]["mergeCommit"] = {"oid": "b" * 40}
        control_path.write_text(json.dumps(control))
        if "--delete-branch" in args and control["branch_checked_out"]:
            print("Cannot delete a branch checked out in the task worktree", file=sys.stderr)
            sys.exit(1)
    elif args[:3] == ["api", "--method", "DELETE"]:
        assert args[3] == f"repos/kaifaty/{control.get('github_repo', 'project')}/git/refs/heads/lesson-branch"
        if control["branch_checked_out"]:
            raise SystemExit("The task worktree must be cleaned before deleting its branch")
        status = control.pop("delete_status_once", 0)
        control_path.write_text(json.dumps(control))
        if status:
            print(f"gh: Remote reference deletion failed (HTTP {status})", file=sys.stderr)
            sys.exit(1)
    else:
        raise SystemExit("Unexpected gh command")
elif name == "tea":
    assert args[:3] == ["api", "--login", "forgejo"]
    path = next(arg for arg in args if arg.startswith("/repos/"))
    method = args[args.index("-X") + 1] if "-X" in args else "GET"
    body = None
    if "-d" in args:
        value = args[args.index("-d") + 1]
        body = json.loads(sys.stdin.read() if value == "@-" else value)
        method = "POST" if "-X" not in args else method
    pull = control["forgejo_pr"]
    assert path.startswith("/repos/kaifaty/infra/pulls")
    if method == "GET" and path.split("?")[0].endswith("/pulls"):
        pulls = [control["forgejo_old_pr"]] if control.get("forgejo_old_pr") else []
        print(json.dumps(pulls + ([pull] if control.get("forgejo_exists") else [])))
    elif method == "GET" and path.endswith("/42"):
        print(json.dumps(pull))
    elif method == "POST" and path.endswith("/pulls"):
        assert body == {"head": "lesson-branch", "base": "main", "title": control["title"],
                        "body": control["body"]}
        control["forgejo_exists"] = True
        print(json.dumps(pull))
    elif method == "POST" and path.endswith("/42/merge"):
        assert body["Do"] == "merge" and body["delete_branch_after_merge"] is True
        assert body["head_commit_id"] == pull["head"]["sha"]
        if body["head_commit_id"] != control.get("head_at_merge", pull["head"]["sha"]):
            print("PR head changed", file=sys.stderr)
            sys.exit(1)
        pull.update(merged=True, state="closed", merge_commit_sha="b" * 40)
        print(json.dumps({"merged": True}))
    else:
        raise SystemExit("Unexpected tea command")
    if method == "POST":
        control_path.write_text(json.dumps(control))
elif name in ("land.py", "ci_wait.py", "pr_ci.py"):
    result = control.get("script_results", [{"code": 0, "output": "CI passed"}])[0]
    if name == "land.py":
        assert args[0].startswith("Merge ")
        assert args == [control["title"], control["body"]]
        control["forgejo_exists"] = True
        control_path.write_text(json.dumps(control))
        print("pull request #42: " + control["forgejo_pr"]["html_url"], flush=True)
    if control.get("block_script"):
        Path(str(control_path) + ".ready").touch()
        while Path(str(control_path) + ".block").exists():
            time.sleep(0.01)
        control = json.loads(control_path.read_text())
    if control.get("script_results"):
        control["script_results"].pop(0)
    if name == "land.py" and result["code"] == 0:
        control["forgejo_exists"] = True
        control["forgejo_pr"].update(merged=True, state="closed", merge_commit_sha="b" * 40)
    control_path.write_text(json.dumps(control))
    print(result["output"], flush=True)
    sys.exit(result["code"])
elif name == "teamster":
    if control.get("fail_once") == args[0]:
        control.pop("fail_once")
        control_path.write_text(json.dumps(control))
        print("command unavailable", file=sys.stderr)
        sys.exit(1)
    task = Path(os.environ["LANDING_TASK"])
    if args[0] == "lesson":
        index = task.parent / ".archive" / "INDEX.md"
        index.write_text("\\n".join(line.replace("accepted", args[2]) if args[1] in line else line
                                   for line in index.read_text().split("\\n")))
    elif args[0] == "say":
        state = json.loads((task / "state.json").read_text())
        state["outcome"] = "running"
        (task / "state.json").write_text(json.dumps(state))
    elif args[0] == "clean":
        task = task.parent / args[1]
        task.rename(task.parent / ".archive" / (task.name + "-20261116T000000Z"))
        control["branch_checked_out"] = False
        control_path.write_text(json.dumps(control))
    elif args[0] != "verdict":
        raise SystemExit("Unexpected teamster command")
else:
    raise SystemExit("Unexpected service command")
'''
    for name in ("gh", "tea", "teamster", "uv"):
        command = bin_path / name
        command.write_text(script)
        command.chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_path) + os.pathsep + os.environ["PATH"])

    def make_actions(**kwargs):
        research = Research(tasks, seconds=0)
        store = store_module.Store(tasks)
        return actions_module.Actions(research, store, bin_path / "teamster", **kwargs)

    def write_state():
        (directory / "state.json").write_text(json.dumps(state))

    def configure(**values):
        current = json.loads(control.read_text())
        current.update(values)
        control.write_text(json.dumps(current))

    def records(name=None):
        rows = [json.loads(row) for row in calls.read_text().splitlines()] if calls.exists() else []
        return [row["argv"] for row in rows if name is None or row["command"] == name]

    def lesson(actions):
        actions.research.invalidate()
        return actions.research.view()["lessons"][0]

    write_state()
    return {"make": make_actions, "state": state, "write": write_state, "configure": configure,
            "records": records, "lesson": lesson, "repo": repo, "entry": entry, "slug": slug,
            "pr": pr, "directory": directory, "archive": archive, "control": control,
            "worktree": worktree, "sha": sha}


def test_landing_merges_verified_pr_and_finishes_lesson(landing_task):
    task = landing_task
    stages = []
    actions = task["make"](publish_research=lambda: stages.append(
        task["lesson"](actions)["implementation"]["landing"]["stage"]))
    actions.landing.run_once()
    assert [row for row in task["records"]("gh") if row[:2] == ["pr", "merge"]] == [
        ["pr", "merge", task["pr"], "--merge", "--match-head-commit", task["sha"]]]
    assert task["records"]("teamster") == [
        ["lesson", task["entry"], "applied", "--note", task["pr"]],
        ["verdict", task["slug"], "accepted", "--note", "landed by the board"],
        ["clean", task["slug"]],
    ]
    records = task["records"]()
    deletion = ["api", "--method", "DELETE", "repos/kaifaty/project/git/refs/heads/lesson-branch"]
    assert records.index(["clean", task["slug"]]) < records.index(deletion)
    assert "failed" not in stages
    lesson = task["lesson"](actions)
    assert lesson["status"] == "applied"
    assert lesson["implementation"]["landing"] == {
        "stage": "landed", "text": "Внедрено: PR #42 слит", "pr": task["pr"], "version": None}
    actions.landing.run_once()
    assert len(task["records"]("teamster")) == 3


@pytest.mark.parametrize("gate", [
    "running", "outcome", "partial", "blocked", "needs_decision", "check", "review",
    "no review", "ci", "no ci", "closed", "merge state", "live checks", "pending checks",
    "empty checks", "ci sha", "head race",
])
def test_landing_requires_every_merge_gate(landing_task, gate):
    task, state = landing_task, landing_task["state"]
    if gate == "running":
        state["pid"] = os.getpid()
    elif gate == "outcome":
        state["outcome"] = "stopped"
    elif gate in ("partial", "blocked", "needs_decision"):
        state["result"]["status"] = gate
    elif gate == "check":
        state["checks"][-1]["outcome"] = "failed"
    elif gate == "review":
        state["review_result"] = {"verdict": "defects", "findings": [{"severity": "P1"}]}
    elif gate == "no review":
        state.pop("review_result")
    elif gate == "ci":
        state["ci"] = {"outcome": "failed", "rounds": 0}
    elif gate == "no ci":
        state.pop("ci")
    elif gate in ("closed", "merge state"):
        control = json.loads(task["control"].read_text())
        control["pr"]["state" if gate == "closed" else "mergeStateStatus"] = (
            "CLOSED" if gate == "closed" else "BLOCKED")
        task["configure"](**control)
    elif gate in ("live checks", "pending checks", "empty checks"):
        checks = ([{"bucket": "pass"}, {"bucket": "fail" if gate == "live checks" else "pending"}]
                  if gate != "empty checks" else [])
        task["configure"](checks=checks, checks_exit=0)
    elif gate == "ci sha":
        state["ci"]["sha"] = "c" * 40
    elif gate == "head race":
        task["configure"](head_at_merge="c" * 40)
    task["write"]()
    actions = task["make"]()
    actions.landing.run_once()
    merge_calls = [row for row in task["records"]("gh") if row[:2] == ["pr", "merge"]]
    assert len(merge_calls) == (1 if gate == "head race" else 0)
    assert json.loads(task["control"].read_text())["pr"]["state"] != "MERGED"
    assert task["records"]("teamster") == []
    landing = task["lesson"](actions)["implementation"]["landing"]
    if gate not in ("running",):
        assert landing["stage"] in (("waiting", "failed") if gate in ("pending checks", "merge state") else ("failed",))
        assert landing["text"]
    reasons = {"partial": "Агент не закончил: итог partial", "blocked": "Агент остановился: итог blocked",
               "check": "Проверка не прошла", "review": "Ревью нашло замечания P1", "ci": "CI не прошёл"}
    if gate in reasons:
        assert reasons[gate] == landing["text"]


@pytest.mark.parametrize("stop", ["clean", "only P3"])
def test_landing_accepts_clean_cycle_stop_and_ignores_previous_turn_check(landing_task, stop):
    task = landing_task
    task["state"].pop("review_result")
    task["state"].update(auto_fix_stop=stop, checks=[{"outcome": "failed"}], check_start=1)
    task["write"]()
    actions = task["make"]()
    actions.landing.run_once()
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "landed"


def test_landing_keeps_unanswered_questions_visible(landing_task):
    task = landing_task
    task["state"]["result"].update(status="needs_decision", questions=["Which behavior should change?"])
    task["write"]()
    actions = task["make"]()
    actions.landing.run_once()
    implementation = task["lesson"](actions)["implementation"]
    assert implementation["landing"] is None
    assert implementation["questions"] == ["Which behavior should change?"]
    assert task["records"]() == []


@pytest.mark.parametrize("origin,text,has_pr", [
    ("git@github.com:mytonwallet-org/project.git",
     "В MyWallet PR сливаешь ты: там свои правила и боты ревью", True),
    ("https://github.com/someone/project.git",
     "В этом репозитории PR сливаешь ты: доска сливает сама только в своих репозиториях", True),
    ("https://forge.example/kaifaty/project.git",
     "В этом репозитории PR сливаешь ты: доска сливает сама только в своих репозиториях", True),
    ("https://github.com.evil.example/kaifaty/project.git",
     "В этом репозитории PR сливаешь ты: доска сливает сама только в своих репозиториях", True),
    ("ssh://git@192.168.1.150:2222/someone/project.git",
     "В этом репозитории PR сливаешь ты: доска сливает сама только в своих репозиториях", True),
    ("ssh://git@192.168.1.150:2222/someone/project.git",
     "В этом репозитории PR сливаешь ты: доска сливает сама только в своих репозиториях", False),
])
def test_landing_leaves_other_owners_and_hosts_to_person(landing_task, origin, text, has_pr):
    task = landing_task
    if not has_pr:
        task["state"].pop("publish")
        task["write"]()
    subprocess.run(["git", "-C", str(task["repo"]), "remote", "set-url", "origin", origin],
                   check=True, capture_output=True)
    actions = task["make"]()
    actions.landing.run_once()
    assert task["lesson"](actions)["implementation"]["landing"] == {
        "stage": "manual", "text": text, "pr": task["pr"] if has_pr else None, "version": None}
    assert task["records"]("gh") == task["records"]("tea") == task["records"]("teamster") == []


@pytest.mark.parametrize("conflicting_again,initial_ci", [
    (False, "passed"), (True, "passed"), ("dispatch-failed", "passed"),
    (False, "none"), (False, "skipped"),
])
def test_landing_repairs_base_conflict_once_then_retries(landing_task, conflicting_again, initial_ci):
    task = landing_task
    if initial_ci != "passed":
        task["state"]["ci"] = {"outcome": initial_ci}
    task["write"]()
    control = json.loads(task["control"].read_text())
    control["pr"].update(mergeable="CONFLICTING", mergeStateStatus="DIRTY")
    if conflicting_again == "dispatch-failed":
        control["fail_once"] = "say"
    task["configure"](**control)
    actions = task["make"]()
    actions.landing.run_once()
    says = task["records"]("teamster")
    assert len(says) == 1
    assert says[0][:2] == ["say", task["slug"]]
    assert "origin/main" in says[0][2]
    assert says[0][3:] == ["--max-minutes", "30", "--review", "--fix-rounds", "1", "--ci"]
    if conflicting_again == "dispatch-failed":
        actions = task["make"]()
        actions.landing.run_once()
        assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "failed"
        assert task["records"]("teamster") == says
        return
    actions.landing.run_once()
    assert task["records"]("teamster") == says
    task["state"].update(turns=2, turn_finished=3)
    task["state"]["ci"] = {"outcome": "passed", "sha": task["sha"]}
    task["write"]()
    if not conflicting_again:
        control["pr"].update(mergeable="MERGEABLE", mergeStateStatus="CLEAN")
        task["configure"](**control)
    actions = task["make"]()
    actions.landing.run_once()
    landing = task["lesson"](actions)["implementation"]["landing"]
    assert landing["stage"] == ("failed" if conflicting_again else "landed")
    assert len([row for row in task["records"]("teamster") if row[0] == "say"]) == 1
    assert len([row for row in task["records"]("gh") if row[:2] == ["pr", "merge"]]) == (
        0 if conflicting_again else 1)


@pytest.mark.parametrize("pr", [None, "\n", '""'])
def test_landing_applies_outside_only_change_without_pr(landing_task, pr):
    task = landing_task
    task["state"]["no_push"] = True
    task["state"].pop("publish")
    task["state"]["result"]["pr"] = pr
    task["state"].pop("ci")
    task["state"].pop("review_result")
    task["write"]()
    (task["archive"] / "batch-2026-11-16.md").write_text(
        "## W1. Keep the check\nproposal: Update the check.\ntarget: ~/.config/lesson-check.py\n")
    actions = task["make"]()
    actions.landing.run_once()
    assert task["records"]("gh") == []
    records = task["records"]("teamster")
    assert records[0][:4] == ["lesson", task["entry"], "applied", "--note"]
    assert "~/.config/lesson-check.py" in records[0][4]
    assert records[1:] == [["verdict", task["slug"], "accepted", "--note", "landed by the board"],
                           ["clean", task["slug"]]]
    assert task["lesson"](actions)["status"] == "applied"
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "landed"


@pytest.mark.parametrize("outside", [False, True])
@pytest.mark.parametrize("resume", ["restart", "retry"])
def test_landing_resumes_finalization_without_repeating_finished_steps(landing_task, landing_clock, outside, resume):
    task = landing_task
    if outside:
        task["state"].pop("publish")
        task["write"]()
        (task["archive"] / "batch-2026-11-16.md").write_text(
            "## W1. Keep the check\nproposal: Update the check.\ntarget: ~/.config/lesson-check.py\n")
    task["configure"](fail_once="clean")
    actions = task["make"]()
    actions.landing.run_once()
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "failed"
    if resume == "restart":
        actions = task["make"]()
    else:
        actions.landing.run_once()
        assert [row[0] for row in task["records"]("teamster")] == ["lesson", "verdict", "clean"]
        landing_clock[0] += 31
    actions.landing.run_once()
    assert len([row for row in task["records"]("gh") if row[:2] == ["pr", "merge"]]) == (0 if outside else 1)
    records = task["records"]("teamster")
    assert [row[0] for row in records] == ["lesson", "verdict", "clean", "clean"]
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "landed"


@pytest.mark.parametrize("options", [{"no_land": True}, {"read_only": True}])
def test_landing_is_disabled_explicitly_or_on_read_only_board(landing_task, options):
    task = landing_task
    actions = task["make"](**options)
    actions.landing.run_once()
    assert task["records"]() == []
    assert task["lesson"](actions)["implementation"]["landing"] is None


@pytest.mark.parametrize("slug,brief", [
    ("regular-task", "Внедрить урок «batch-2026-11-16.md W1»: Keep the check.\n"),
    ("lesson-w1-1116", "Do another task.\n"),
])
def test_landing_only_handles_lesson_implementation_briefs(landing_task, slug, brief):
    task = landing_task
    directory = task["directory"]
    (directory / "brief.md").write_text(brief)
    if slug != directory.name:
        directory.rename(directory.with_name(slug))
    actions = task["make"]()
    actions.landing.run_once()
    assert task["records"]() == []


def test_landing_runs_in_background_and_publishes_research_contract(landing_task):
    task = landing_task
    task["configure"](sleep_command="gh")
    marker = Path(str(task["control"]) + ".block")
    ready = Path(str(task["control"]) + ".ready")
    marker.touch()
    accounts = task["control"].with_name("landing-accounts.py")
    accounts.write_text("print('{}')\n")
    settings = Settings(task["directory"].parent.parent, accounts, layout="new", poll_seconds=0.01,
                        research_seconds=0, action_teamster=str(task["control"].parent / "landing-bin/teamster"))
    application = create_app(settings)

    def request(method, route, **kwargs):
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(method, route, **kwargs)
            try:
                return pending.result(timeout=1)
            finally:
                if not pending.done():
                    marker.unlink(missing_ok=True)

    try:
        with TestClient(application, base_url="http://localhost:8787") as client:
            wait_for_account(ready.exists)
            response = request(client.get, "/api/research")
            assert response.status_code == 200
            landing = response.json()["lessons"][0]["implementation"]["landing"]
            if landing is not None:
                assert set(landing) == {"stage", "text", "pr", "version"}
                assert landing["pr"] == task["pr"]
            response = request(client.post, "/api/actions/lesson",
                json={"entry": task["entry"], "status": "accepted"},
                headers={"Origin": "http://localhost:8787", "X-Teamster-Board": "1"})
            assert response.status_code == 200
            # Polls while the first command waits must not admit a second landing worker.
            application.state.board.actions.landing.poll()
            application.state.board.actions.landing.poll()
            assert len(task["records"]("gh")) == 1
            with client.websocket_connect("/ws", headers={"Host": "localhost:8787"}) as socket:
                socket.receive_json()
                marker.unlink()
                messages = []
                while True:
                    message = socket.receive_json()
                    messages.append(message)
                    if message["type"] == "research":
                        value = message["research"]["lessons"][0]["implementation"]["landing"]
                        assert set(value) == {"stage", "text", "pr", "version"}
                        if value["stage"] == "landed":
                            break
                assert messages
    finally:
        marker.unlink(missing_ok=True)


def test_landing_recovers_merge_completed_before_receipt_was_saved(landing_task):
    task = landing_task
    control = json.loads(task["control"].read_text())
    control["pr"].update(state="MERGED", mergeCommit={"oid": "b" * 40})
    task["configure"](**control)
    actions = task["make"]()
    actions.landing.run_once()
    assert not [row for row in task["records"]("gh") if row[:2] == ["pr", "merge"]]
    assert [row[0] for row in task["records"]("teamster")] == ["lesson", "verdict", "clean"]
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "landed"


def test_landing_polls_after_launch_invalidates_research_without_an_api_request(landing_task):
    task = landing_task
    actions = task["make"]()
    actions.research.view()
    actions.research.invalidate()
    actions.landing.poll()
    assert actions.landing.thread is not None
    actions.landing.thread.join(5)
    assert not actions.landing.thread.is_alive()
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "landed"


@pytest.fixture
def landing_clock(monkeypatch):
    from types import SimpleNamespace

    clock = [100.0]
    monkeypatch.setattr(landing_module, "time", SimpleNamespace(monotonic=lambda: clock[0],
                                                              time=time.time, sleep=time.sleep))
    return clock


@pytest.mark.parametrize("transient", ["gh error", "merge state", "pending checks"])
def test_landing_retries_transient_conditions_without_restarting(landing_task, landing_clock, transient):
    task = landing_task
    control = json.loads(task["control"].read_text())
    if transient == "gh error":
        control["gh_error_once"] = True
    elif transient == "merge state":
        control["pr"]["mergeStateStatus"] = "UNKNOWN"
    else:
        control["checks"] = [{"bucket": "pending"}]
        control["checks_exit"] = 8
    task["configure"](**control)
    actions = task["make"]()
    actions.landing.run_once()
    assert task["records"]("teamster") == []
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] in ("waiting", "failed")
    before = task["records"]("gh")
    control = json.loads(task["control"].read_text())
    control["pr"]["mergeStateStatus"] = "CLEAN"
    control["checks"] = [{"bucket": "pass"}, {"bucket": "skip"}]
    control["checks_exit"] = 0
    task["configure"](**control)
    actions.landing.run_once()
    assert task["records"]("gh") == before
    landing_clock[0] += 31
    actions.landing.run_once()
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "landed"
    assert len([row for row in task["records"]("gh") if row[:2] == ["pr", "merge"]]) == 1


@pytest.mark.parametrize("gate", ["check", "review", "failed ci"])
def test_landing_does_not_dispatch_conflict_repair_when_other_gates_fail(landing_task, gate):
    task = landing_task
    control = json.loads(task["control"].read_text())
    control["pr"].update(mergeable="CONFLICTING", mergeStateStatus="DIRTY")
    task["configure"](**control)
    if gate == "check":
        task["state"]["checks"][-1]["outcome"] = "failed"
    elif gate == "review":
        task["state"]["review_result"] = {"verdict": "defects", "findings": [{"severity": "P1"}]}
    else:
        task["state"]["ci"]["outcome"] = "failed"
    task["write"]()
    actions = task["make"]()
    actions.landing.run_once()
    assert task["records"]("teamster") == []
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "failed"


@pytest.mark.parametrize("failure", ["upgrade", "clean"])
def test_landing_wires_release_upgrade_and_version_before_finalization(landing_task, landing_clock,
                                                                      monkeypatch, failure):
    task = landing_task
    subprocess.run(["git", "-C", str(task["repo"]), "remote", "set-url", "origin",
                    "https://github.com/kaifaty/teamster.git"], check=True, capture_output=True)
    task["pr"] = "https://github.com/kaifaty/teamster/pull/42"
    task["state"]["publish"]["pr"] = task["pr"]
    task["write"]()
    task["configure"](github_repo="teamster")
    version = "1.80.0"
    script = task["repo"] / "scripts/bump_version.py"
    script.parent.mkdir()
    script.write_text("# The release helper is replaced in this integration test.\n")
    stages, releases, upgrades = [], [], []

    def release(repo, sha, files, receipt, save):
        assert (repo, sha, files) == (task["repo"], "b" * 40, ["app.py"])
        if not receipt.get("released"):
            releases.append(sha)
            receipt.update(released=True, release_version=version)
            save()
        return version

    def upgrade():
        upgrades.append("teamster")
        if failure == "upgrade" and len(upgrades) == 1:
            raise ValueError("Upgrade temporarily unavailable")

    monkeypatch.setattr(landing_module.landing_release, "release", release)
    monkeypatch.setattr(landing_module.landing_release, "upgrade", upgrade)
    if failure == "clean":
        task["configure"](fail_once="clean")
    actions = task["make"](publish_research=lambda: stages.append(
        task["lesson"](actions)["implementation"]["landing"]["stage"]))
    actions.landing.run_once()
    landing = task["lesson"](actions)["implementation"]["landing"]
    assert landing["stage"] == "failed"
    assert "releasing" in stages
    assert landing["version"] == version
    assert stages.index("releasing") < stages.index("upgrading")
    assert upgrades == ["teamster"]
    if failure == "upgrade":
        assert task["records"]("teamster") == []
        landing_clock[0] += 31
    else:
        actions = task["make"]()
    actions.landing.run_once()
    assert releases == ["b" * 40]
    assert len(upgrades) == (2 if failure == "upgrade" else 1)
    assert task["lesson"](actions)["implementation"]["landing"] == {
        "stage": "landed", "text": "Внедрено: PR #42 слит, teamster 1.80.0", "pr": task["pr"], "version": version}
    actions = task["make"]()
    actions.landing.run_once()
    assert releases == ["b" * 40]
    assert len(upgrades) == (2 if failure == "upgrade" else 1)


@pytest.mark.parametrize("condition", ["manual", "review", "ci"])
def test_landing_does_not_publish_unchanged_terminal_stage_on_retry(landing_task, landing_clock, condition):
    task = landing_task
    if condition == "manual":
        subprocess.run(["git", "-C", str(task["repo"]), "remote", "set-url", "origin",
                        "https://github.com/mytonwallet-org/project.git"], check=True, capture_output=True)
    elif condition == "review":
        task["state"]["review_result"] = {"verdict": "defects", "findings": [{"severity": "P1"}]}
    else:
        task["state"]["ci"]["outcome"] = "failed"
    task["write"]()
    publications = []
    actions = task["make"](publish_research=lambda: publications.append(
        task["lesson"](actions)["implementation"]["landing"]))
    actions.landing.run_once()
    before = list(publications)
    assert before[-1]["stage"] == ("manual" if condition == "manual" else "failed")
    landing_clock[0] += 31
    actions.landing.run_once()
    assert publications == before
    assert task["records"]("teamster") == []


@pytest.mark.parametrize("status", [404, 422, 503])
def test_landing_deletes_remote_branch_after_clean_and_retries_transient_errors(landing_task, landing_clock, status):
    task = landing_task
    task["configure"](delete_status_once=status)
    actions = task["make"]()
    actions.landing.run_once()
    landing = task["lesson"](actions)["implementation"]["landing"]
    if status == 503:
        assert landing["stage"] == "failed"
        landing_clock[0] += 31
        actions.landing.run_once()
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "landed"
    assert len([row for row in task["records"]("gh") if row[:2] == ["pr", "merge"]]) == 1
    assert len([row for row in task["records"]("teamster") if row[0] == "clean"]) == 1
    deletes = [row for row in task["records"]("gh") if row[0] == "api"]
    assert deletes == [["api", "--method", "DELETE",
                        "repos/kaifaty/project/git/refs/heads/lesson-branch"]] * (2 if status == 503 else 1)


def test_landing_verdict_lookup_preserves_pending_board_events_and_logins(landing_task):
    task = landing_task
    actions = task["make"]()
    journal = task["control"].with_name("landing-journal.jsonl")
    journal.write_text("")
    actions.store.telemetry_path = journal
    actions.store.poll()
    now = time.time()
    rows = [
        {"kind": "work", "at": now, "slug": task["slug"], "repo": "project"},
        {"kind": "verdict", "at": now + 1, "slug": task["slug"], "repo": "project",
         "created": 1, "verdict": "accepted"},
        {"event": "account_login", "at": now + 2, "family": "codex", "account": "test"},
    ]
    with journal.open("a") as stream:
        for row in rows:
            stream.write(json.dumps(row) + "\n")
    cursor = actions.store._journal._log_offset
    actions.landing.run_once()
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "landed"
    assert [row[0] for row in task["records"]("teamster")] == ["lesson", "clean"]
    assert actions.store._journal._log_offset == cursor
    assert actions.store.take_logins() == 0
    messages = actions.store.poll()
    assert [(row["event"]["kind"], row["event"]["at"]) for row in messages if row["type"] == "event"] == [
        ("work", now), ("verdict", now + 1)]
    assert actions.store.take_logins() == 1


@pytest.mark.parametrize("gate", ["check", "review", "ci"])
def test_landing_waits_for_state_change_after_state_only_failure(landing_task, landing_clock, gate):
    task, state = landing_task, landing_task["state"]
    if gate == "check":
        state["checks"][-1]["outcome"] = "failed"
    elif gate == "review":
        state["review_result"] = {"verdict": "defects", "findings": [{"severity": "P1"}]}
    else:
        state["ci"]["outcome"] = "failed"
    task["write"]()
    actions = task["make"]()
    actions.landing.run_once()
    before = task["records"]("gh")
    landing_clock[0] += 31
    actions.landing.run_once()
    assert task["records"]("gh") == before
    assert task["records"]("tea") == []
    # The same receipt resumes as soon as the saved task result is repaired.
    state["checks"][-1]["outcome"] = "passed"
    state["review_result"] = {"verdict": "clean", "findings": []}
    state["ci"]["outcome"] = "passed"
    task["write"]()
    landing_clock[0] += 31
    actions.landing.run_once()
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "landed"


@pytest.mark.parametrize("host", ["github", "forgejo-land", "forgejo-api"])
def test_landing_does_not_publish_no_push_tasks(request, host):
    task = request.getfixturevalue("landing_task" if host == "github" else "forgejo_landing")
    if host == "forgejo-land":
        task["script"]("land.py")
    task["state"]["no_push"] = True
    task["write"]()
    actions = task["make"]()
    actions.landing.run_once()
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] in ("failed", "manual")
    assert not [row for row in task["records"]("gh") if row[:2] == ["pr", "merge"]]
    assert not [row for row in task["records"]("tea") if "-X" in row or "-d" in row]
    assert task["records"]("land.py") == task["records"]("teamster") == []
    assert not any(row.get("forgejo_job") or row.get("merged") for row in actions.landing.receipts.values())


@pytest.mark.parametrize("host", ["github", "forgejo"])
@pytest.mark.parametrize("publication", ["head behind", "publish sha", "not pushed", "old merged"])
def test_landing_refuses_unpublished_or_stale_pr(request, host, publication):
    task = request.getfixturevalue("landing_task" if host == "github" else "forgejo_landing")
    task["state"]["publish"]["pr"] = task["pr"]
    control = json.loads(task["control"].read_text())
    if publication in ("head behind", "old merged"):
        if host == "github":
            control["pr"]["headRefOid"] = "c" * 40
        else:
            control["forgejo_pr"]["head"]["sha"] = "c" * 40
        if publication == "head behind":
            task["state"]["publish"]["sha"] = "c" * 40
            task["state"]["ci"]["sha"] = "c" * 40
    elif publication == "publish sha":
        task["state"]["publish"]["sha"] = "c" * 40
    else:
        task["state"]["publish"]["pushed"] = False
    if publication == "old merged":
        if host == "github":
            control["pr"].update(state="MERGED", mergeCommit={"oid": "b" * 40})
        else:
            control["forgejo_pr"].update(state="closed", merged=True, merge_commit_sha="b" * 40)
    task["configure"](**control)
    task["write"]()
    actions = task["make"]()
    actions.landing.run_once()
    value = task["lesson"](actions)["implementation"]["landing"]
    assert value["stage"] == "failed"
    if publication in ("head behind", "not pushed"):
        assert value["text"] == "Ветка задачи не запушена: PR #42 отстаёт от проверенного коммита"
    assert not [row for row in task["records"]("gh") if row[:2] == ["pr", "merge"]]
    assert not [row for row in task["records"]("tea") if "-X" in row or "-d" in row]
    assert task["records"]("teamster") == []
    assert not any(row.get("merged") for row in actions.landing.receipts.values())


@pytest.fixture
def forgejo_landing(landing_task, landing_clock):
    task = landing_task
    repo = task["repo"].with_name("chromvoid-infra")
    task["repo"].rename(repo)
    task["repo"] = repo
    origin = "ssh://git@192.168.1.150:2222/kaifaty/infra.git"
    subprocess.run(["git", "-C", str(repo), "remote", "set-url", "origin", origin],
                   check=True, capture_output=True)
    worktree = task["worktree"]
    subprocess.run(["git", "-C", str(worktree), "remote", "set-url", "origin", origin],
                   check=True, capture_output=True)
    task["pr"] = "https://kaifaty.ru/kaifaty/infra/pulls/42"
    task["state"].update(repo=str(repo), worktree=str(worktree), branch="lesson-branch", base="origin/main",
                         publish={"sha": task["sha"], "pushed": True}, ci={"outcome": "none"})
    title, body = "Merge the lesson", "Keep the saved check."
    task["state"]["result"].update(pr_title=title, pr_body=body)
    task["write"]()
    task["configure"](forgejo_pr={"number": 42, "html_url": task["pr"], "state": "open", "merged": False,
                                  "head": {"ref": "lesson-branch", "sha": task["sha"]},
                                  "base": {"ref": "main"}, "merge_commit_sha": None},
                       forgejo_exists=False, title=title, body=body)
    checks = repo.parent / ".codex/checks" / repo.name
    checks.mkdir(parents=True)
    template = task["control"].parent / "landing-bin/tea"

    def script(name):
        path = checks / name
        path.write_text(template.read_text())
        return path

    def drive(actions, predicate):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            landing_clock[0] += 31
            actions.landing.run_once()
            if predicate():
                return
            time.sleep(0.02)
        pytest.fail("Forgejo landing did not reach its expected state")

    task.update(worktree=worktree, checks=checks, script=script, drive=drive)
    return task


@pytest.mark.parametrize("gate,script", [("check", "land.py"), ("review", "pr_ci.py")])
def test_landing_forgejo_requires_saved_check_and_review_before_services(forgejo_landing, gate, script):
    task = forgejo_landing
    task["script"](script)
    if gate == "check":
        task["state"]["checks"][-1]["outcome"] = "failed"
    else:
        task["state"]["review_result"] = {"verdict": "defects", "findings": [{"severity": "P1"}]}
    task["write"]()
    actions = task["make"]()
    actions.landing.run_once()
    assert task["lesson"](actions)["implementation"]["landing"]["stage"] == "failed"
    assert task["records"]("tea") == task["records"]("land.py") == task["records"]("pr_ci.py") == []
    assert task["records"]("teamster") == []
    assert not any(row.get("forgejo_job") for row in actions.landing.receipts.values())


@pytest.mark.parametrize("title", [None, "Board: keep check", "Merge the lesson"])
def test_landing_forgejo_land_script_merges_and_finishes_in_task_worktree(forgejo_landing, title):
    task = forgejo_landing
    task["script"]("land.py")
    if title is None:
        task["state"]["result"].pop("pr_title")
    else:
        task["state"]["result"]["pr_title"] = title
    expected_title = title or f"Merge {task['slug']}"
    if not expected_title.startswith("Merge "):
        expected_title = f"Merge {expected_title}"
    task["configure"](title=expected_title)
    task["write"]()
    if title == "Board: keep check":
        (task["archive"] / "batch-2026-11-16.md").write_text(
            "## W1. Keep the check\nproposal: Add the check.\ntarget: ~/.config/lesson-check.py\n")
        subprocess.run(["git", "-C", str(task["worktree"]), "-c", "user.name=Test",
                        "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit",
                        "--quiet", "--allow-empty", "-m", "Implement lesson"], check=True, capture_output=True)
        task["sha"] = subprocess.run(["git", "-C", str(task["worktree"]), "rev-parse", "HEAD"], check=True,
                                     capture_output=True, text=True).stdout.strip()
        task["state"]["publish"]["sha"] = task["sha"]
        control = json.loads(task["control"].read_text())
        control["forgejo_pr"]["head"]["sha"] = task["sha"]
        task["configure"](**control)
        task["write"]()
    actions = task["make"]()
    actions.landing.run_once()
    task["drive"](actions, lambda: task["lesson"](actions)["implementation"]["landing"]["stage"] == "landed")
    rows = [json.loads(row) for row in task["control"].with_name("landing-calls.jsonl").read_text().splitlines()]
    scripts = [row for row in rows if row["command"] == "land.py"]
    assert len(scripts) == 1
    assert scripts[0]["cwd"] == str(task["worktree"])
    assert scripts[0]["argv"] == [expected_title, task["state"]["result"]["pr_body"]]
    assert task["records"]("gh") == []
    assert [row[0] for row in task["records"]("teamster")] == ["lesson", "verdict", "clean"]
    assert task["records"]("teamster")[0][-1] == task["pr"]
    assert task["lesson"](actions)["implementation"]["landing"]["pr"] == task["pr"]


@pytest.mark.parametrize("failure,second_failure", [("conflict", False), ("ci", False), ("ci", True)])
def test_landing_forgejo_land_script_repairs_once_and_retries(forgejo_landing, failure, second_failure):
    task = forgejo_landing
    task["script"]("land.py")
    diagnostic = ("land.py: main moved while CI ran: merge it in, rerun the checks and land again (#42)"
                  if failure == "conflict" else "job lint failed\nland.py: CI did not pass (exit 1), #42 is left open")
    output = "CI LOG BEGIN\n" + "build output\n" * 120 + diagnostic
    task["configure"](script_results=[{"code": 1, "output": output},
                                      {"code": int(second_failure), "output": output if second_failure else "merged #42"}])
    actions = task["make"]()
    actions.landing.run_once()
    task["drive"](actions, lambda: bool(task["records"]("teamster")))
    says = task["records"]("teamster")
    assert len(says) == 1 and says[0][:2] == ["say", task["slug"]]
    if failure == "conflict":
        assert says[0][2] == "Merge origin/main, resolve conflicts, run checks and push."
    else:
        assert says[0][2].startswith("CI failed: ")
        assert diagnostic in says[0][2]
        assert "CI LOG BEGIN" not in says[0][2]
        assert says[0][2].endswith(". Fix it, run checks and push.")
    assert len(task["records"]("land.py")) == 1
    task["state"].update(turns=2, turn_finished=3)
    task["write"]()
    actions = task["make"]()
    expected = "failed" if second_failure else "landed"
    task["drive"](actions, lambda: task["lesson"](actions)["implementation"]["landing"]["stage"] == expected)
    assert len(task["records"]("land.py")) == 2
    assert len([row for row in task["records"]("teamster") if row[0] == "say"]) == 1
    if second_failure:
        text = task["lesson"](actions)["implementation"]["landing"]["text"]
        assert diagnostic in text
        assert "CI LOG BEGIN" not in text


@pytest.mark.parametrize("unavailable", [False, True])
def test_landing_forgejo_land_script_reports_other_errors(forgejo_landing, landing_clock, unavailable):
    task = forgejo_landing
    task["script"]("land.py")
    diagnostic = ("land.py: CI did not pass (exit 75), #42 is left open" if unavailable
                  else "fatal: push was rejected")
    output = "CI LOG BEGIN\n" + "build output\n" * 120 + diagnostic
    task["configure"](script_results=[{"code": 1, "output": output}, {"code": 0, "output": "merged #42"}])
    actions = task["make"]()
    task["drive"](actions, lambda: task["lesson"](actions)["implementation"]["landing"]["stage"] == "failed")
    text = task["lesson"](actions)["implementation"]["landing"]["text"]
    assert diagnostic in text
    assert "CI LOG BEGIN" not in text
    assert task["records"]("teamster") == []
    assert len(task["records"]("land.py")) == 1
    if unavailable:
        assert "CI не читается:" in task["lesson"](actions)["implementation"]["landing"]["text"]
        assert not any(row.get("forgejo_job") for row in actions.landing.receipts.values())
        actions.landing.run_once()
        assert len(task["records"]("land.py")) == 1
        landing_clock[0] += 31
        actions.landing.run_once()
        task["drive"](actions, lambda: task["lesson"](actions)["implementation"]["landing"]["stage"] == "landed")
        assert len(task["records"]("land.py")) == 2
        assert not [row for row in task["records"]("teamster") if row[0] == "say"]
        assert task["lesson"](actions)["status"] == "applied"


@pytest.mark.parametrize("waiter,code,existing,second_failure,head_race", [
    ("ci_wait.py", 0, False, False, False), ("pr_ci.py", 0, True, False, False),
    ("ci_wait.py", 1, False, False, False), ("ci_wait.py", 1, False, True, False),
    ("pr_ci.py", 75, False, False, False), ("ci_wait.py", 0, False, False, True),
])
def test_landing_forgejo_opens_pr_waits_and_merges(forgejo_landing, landing_clock, waiter, code,
                                               existing, second_failure, head_race):
    task = forgejo_landing
    task["script"](waiter)
    if existing:
        task["script"]("ci_wait.py")
    log_prefix = "CI LOG BEGIN\n" + "build output\n" * 120
    diagnostic = "CI unavailable" if code == 75 else "job lint failed"
    task["configure"](forgejo_exists=existing,
                       script_results=[{"code": code, "output": log_prefix + diagnostic},
                                       {"code": int(second_failure),
                                        "output": log_prefix + "job lint failed again" if second_failure else "CI passed"}])
    if code == 0:
        old = dict(json.loads(task["control"].read_text())["forgejo_pr"])
        old.update(number=41, html_url=task["pr"].replace("/42", "/41"), state="closed", merged=True,
                   merge_commit_sha="b" * 40, head={"ref": "lesson-branch", "sha": "c" * 40})
        task["configure"](forgejo_old_pr=old)
    if head_race:
        task["configure"](head_at_merge="c" * 40)
    saved_state = (task["directory"] / "state.json").read_bytes()
    actions = task["make"]()
    actions.landing.run_once()
    if code == 1:
        task["drive"](actions, lambda: bool(task["records"]("teamster")))
        order = task["records"]("teamster")[0]
        assert order[:2] == ["say", task["slug"]]
        assert order[2].startswith("CI failed: ")
        assert diagnostic in order[2]
        assert "CI LOG BEGIN" not in order[2]
        assert order[2].endswith(". Fix it, run checks and push.")
        task["state"].update(turns=2, turn_finished=3)
        task["write"]()
        actions = task["make"]()
    if code == 75:
        task["drive"](actions, lambda: task["lesson"](actions)["implementation"]["landing"]["stage"] == "failed")
        text = task["lesson"](actions)["implementation"]["landing"]["text"]
        assert "CI не читается:" in text
        assert diagnostic in text
        assert "CI LOG BEGIN" not in text
        assert task["records"]("teamster") == []
        assert len(task["records"](waiter)) == 1
        assert (task["directory"] / "state.json").read_bytes() == saved_state
        actions.landing.run_once()
        assert len(task["records"](waiter)) == 1
        landing_clock[0] += 31
        actions.landing.run_once()
        actions = task["make"]()
    expected = "failed" if second_failure or head_race else "landed"
    task["drive"](actions, lambda: task["lesson"](actions)["implementation"]["landing"]["stage"] == expected)
    calls = task["records"]("tea")
    creates = [row for row in calls if "/repos/kaifaty/infra/pulls" in row and "-d" in row]
    assert len(creates) == (0 if existing else 1)
    merges = [row for row in calls if "/repos/kaifaty/infra/pulls/42/merge" in row]
    assert len(merges) == (0 if second_failure else 1)
    assert len(task["records"](waiter)) == (2 if code in (1, 75) else 1)
    rows = [json.loads(row) for row in task["control"].with_name("landing-calls.jsonl").read_text().splitlines()]
    assert all(row["cwd"] == str(task["worktree"]) for row in rows if row["command"] == waiter)
    assert len([row for row in task["records"]("teamster") if row[0] == "say"]) == (1 if code == 1 else 0)
    assert task["records"]("gh") == []
    if existing:
        assert task["records"]("ci_wait.py") == []
    if head_race:
        assert "PR head changed" in task["lesson"](actions)["implementation"]["landing"]["text"]
        assert json.loads(task["control"].read_text())["forgejo_pr"]["merged"] is False
        assert task["records"]("teamster") == []
    if second_failure:
        text = task["lesson"](actions)["implementation"]["landing"]["text"]
        assert "job lint failed again" in text
        assert "CI LOG BEGIN" not in text


def test_landing_forgejo_rejects_waiter_result_for_previous_commit(forgejo_landing):
    task = forgejo_landing
    task["script"]("ci_wait.py")
    task["configure"](block_script=True)
    marker = Path(str(task["control"]) + ".block")
    ready = Path(str(task["control"]) + ".ready")
    marker.touch()
    actions = task["make"]()
    try:
        actions.landing.run_once()
        wait_for_account(ready.exists)
        job = next(row["forgejo_job"] for row in actions.landing.receipts.values() if row.get("forgejo_job"))
        assert job["sha"] == task["sha"]
        result_path = Path(job["result"])
        subprocess.run(["git", "-C", str(task["worktree"]), "-c", "user.name=Test",
                        "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit",
                        "--quiet", "--allow-empty", "-m", "Update lesson"], check=True, capture_output=True)
        current = subprocess.run(["git", "-C", str(task["worktree"]), "rev-parse", "HEAD"],
                                 check=True, capture_output=True, text=True).stdout.strip()
        assert current != task["sha"]
        task["state"].update(turns=2, turn_finished=3, ci={"outcome": "passed", "sha": current})
        task["state"]["publish"].update(sha=current, pushed=True)
        task["write"]()
        control = json.loads(task["control"].read_text())
        control["forgejo_pr"]["head"]["sha"] = current
        task["configure"](**control)
        marker.unlink()
        wait_for_account(result_path.exists)
        actual = subprocess.run(["git", "-C", str(task["worktree"]), "rev-parse", "HEAD"],
                                check=True, capture_output=True, text=True).stdout.strip()
        assert actual == task["state"]["publish"]["sha"] == (
            json.loads(task["control"].read_text())["forgejo_pr"]["head"]["sha"]) == current
        task["drive"](actions, lambda: task["lesson"](actions)["implementation"]["landing"]["stage"] == "failed")
        assert task["lesson"](actions)["implementation"]["landing"]["text"] == (
            "HEAD PR #42 изменился после запуска ожидания CI")
        assert len(task["records"]("ci_wait.py")) == 1
        assert not [row for row in task["records"]("tea") if "/repos/kaifaty/infra/pulls/42/merge" in row]
        assert task["records"]("teamster") == []
    finally:
        marker.unlink(missing_ok=True)


def test_landing_forgejo_reads_result_written_before_runner_unlocks(landing_task, monkeypatch):
    task = landing_task
    log = task["control"].with_suffix(".log")
    result = task["control"].with_name("runner-result.json")
    log.write_text("CI passed\n")
    receipt = {"forgejo_job": {"log": str(log), "result": str(result), "kind": "waiter"}}
    exists = Path.exists
    raced = []

    def result_arrives(path):
        if path == result and not raced:
            raced.append(True)
            result.write_text(json.dumps({"returncode": 0}))
            return False
        return exists(path)

    monkeypatch.setattr(Path, "exists", result_arrives)
    assert task["make"]().landing._job_result(receipt) == (0, "CI passed\n")
    assert raced == [True]


@pytest.mark.parametrize("timed_out", [False, True])
def test_landing_runner_allows_two_hours_for_ci(tmp_path, monkeypatch, timed_out):
    from types import SimpleNamespace

    result = tmp_path / "runner-result.json"
    waits, kills = [], []

    def wait(timeout=None):
        waits.append(timeout)
        # Model CI that takes ten minutes without delaying the test.
        if timeout is not None and (timed_out or timeout < 600):
            raise subprocess.TimeoutExpired("ci_wait.py", timeout)
        if timeout is None:
            assert kills == [(12345, signal.SIGKILL)]
        return 0

    def start(argv, **kwargs):
        assert argv == ["python3", "ci_wait.py"]
        assert kwargs == {"start_new_session": True}
        return SimpleNamespace(pid=12345, wait=wait)

    monkeypatch.setattr(subprocess, "Popen", start)
    monkeypatch.setattr(os, "killpg", lambda pid, sig: kills.append((pid, sig)))
    monkeypatch.setattr(sys, "argv", ["runner", str(result), "python3", "ci_wait.py"])
    exec(landing_module.RUNNER, {})
    assert waits == ([7200, None] if timed_out else [7200])
    assert kills == ([(12345, signal.SIGKILL)] if timed_out else [])
    assert json.loads(result.read_text()) == {"returncode": 124 if timed_out else 0}


@pytest.mark.parametrize("saved_log", [None, "", "Runner stopped before saving its result\n"])
def test_landing_forgejo_recovers_receipt_saved_before_spawn(forgejo_landing, saved_log):
    task = forgejo_landing
    task["script"]("land.py")
    actions = task["make"]()
    log = task["control"].with_name("orphan-runner.log")
    if saved_log is not None:
        log.write_text(saved_log)
    implementation = task["lesson"](actions)["implementation"]
    key = actions.landing._key(implementation["slug"], implementation["created"])
    actions.landing.receipts[key] = {"pr": None, "version": None, "forgejo": True,
        "stage": "waiting", "text": "Жду CI PR на Forgejo", "forgejo_job": {
            "log": str(log), "result": str(log.with_suffix(".json")), "kind": "land"}}
    actions.landing._save()
    actions = task["make"]()
    expected = "failed" if saved_log else "landed"
    task["drive"](actions, lambda: task["lesson"](actions)["implementation"]["landing"]["stage"] == expected)
    assert len(task["records"]("land.py")) == (0 if saved_log else 1)
    if saved_log:
        assert "Runner stopped before saving its result" in (
            task["lesson"](actions)["implementation"]["landing"]["text"])


@pytest.mark.parametrize("workflows", [False, True])
def test_landing_forgejo_without_waiter_only_merges_without_workflows(forgejo_landing, workflows):
    task = forgejo_landing
    if workflows:
        directory = task["worktree"] / ".forgejo/workflows"
        directory.mkdir(parents=True)
        (directory / "checks.yml").write_text("name: Checks\n")
    actions = task["make"]()
    actions.landing.run_once()
    expected = "failed" if workflows else "landed"
    task["drive"](actions, lambda: task["lesson"](actions)["implementation"]["landing"]["stage"] == expected)
    merges = [row for row in task["records"]("tea") if "/repos/kaifaty/infra/pulls/42/merge" in row]
    assert len(merges) == (0 if workflows else 1)
    if workflows:
        assert "Нет скрипта ожидания CI в ~/.codex/checks/chromvoid-infra/" in (
            task["lesson"](actions)["implementation"]["landing"]["text"])


@pytest.mark.parametrize("script", ["land.py", "ci_wait.py"])
def test_landing_forgejo_resumes_running_process_without_blocking_other_lessons(forgejo_landing, script):
    task = forgejo_landing
    task["script"](script)
    task["configure"](block_script=True)
    marker = Path(str(task["control"]) + ".block")
    ready = Path(str(task["control"]) + ".ready")
    marker.touch()
    actions = task["make"]()
    try:
        actions.landing.run_once()
        wait_for_account(ready.exists)
        # Reconstruct Landing while the subprocess is still waiting on CI.
        actions = task["make"]()
        actions.landing.run_once()
        task["drive"](actions, lambda: task["lesson"](actions)["implementation"]["landing"]["text"] ==
                      "Жду CI PR #42 на Forgejo")
        job = next(row["forgejo_job"] for row in actions.landing.receipts.values() if row.get("forgejo_job"))
        result_path = Path(job["result"])
        assert len(task["records"](script)) == 1
        entry, slug = "batch-2026-11-16.md W2", "lesson-w2-1116"
        index = task["archive"] / "INDEX.md"
        index.write_text(index.read_text() + f"| 2026-11-16 | {entry} | invariant | check | accepted |\n")
        batch = task["archive"] / "batch-2026-11-16.md"
        batch.write_text(batch.read_text() + "\n## W2. Save outside\nproposal: Update check.\ntarget: ~/.config/check.py\n")
        directory = task["directory"].parent / slug
        directory.mkdir()
        (directory / "brief.md").write_text(f"Внедрить урок «{entry}»: Save outside.\n")
        state = dict(task["state"], created=2, result={"status": "done"}, no_push=True)
        (directory / "state.json").write_text(json.dumps(state))
        actions.landing.run_once()
        actions.research.invalidate()
        lesson = next(row for row in actions.research.view()["lessons"] if row["entry"] == entry)
        assert lesson["implementation"]["landing"]["stage"] == "landed"
        assert len(task["records"](script)) == 1
    finally:
        marker.unlink(missing_ok=True)
    # The completed result is recovered by another server instance as well.
    wait_for_account(result_path.exists)
    actions = task["make"]()
    task["drive"](actions, lambda: next(row for row in actions.research.view()["lessons"]
                                      if row["entry"] == task["entry"])["implementation"]["landing"]["stage"] == "landed")
    assert len(task["records"](script)) == 1



@pytest.fixture
def external_duty_worker(monkeypatch):
    """The real CLI against the rotation suite's local Git origin and fake Codex."""
    monkeypatch.syspath_prepend(str(board_app.REPOSITORY / "tests"))
    from rotation_support import RotationTestCase, SCRIPT

    worker = RotationTestCase()
    worker.setUp()
    try:
        with monkeypatch.context() as env:
            home = worker.root / "home"
            home.mkdir()
            env.setenv("HOME", str(home))
            for key in os.environ.copy():
                if key.startswith("TEAMSTER_") or key == "CODEX_TASK_CLOCK_FILE":
                    env.delenv(key)
            for key, value in worker.env.items():
                if not key.startswith("TEAMSTER_") and key != "CODEX_TASK_CLOCK_FILE" and value != os.environ.get(key):
                    env.setenv(key, value)
            for name in ("claude", "security"):
                fake = worker.root / name
                fake.write_text("#!/bin/sh\nexit 99\n")
                fake.chmod(0o700)
            env.setenv("CODEX_TASK_CLAUDE", str(worker.root / "claude"))
            command = worker.root / "teamster"
            command.write_text(
                f"#!{sys.executable}\nimport os, sys\n"
                f"os.execv(sys.executable, [sys.executable, '-I', {str(SCRIPT)!r}, *sys.argv[1:]])\n"
            )
            command.chmod(0o700)
            accounts = worker.root / "accounts.py"
            accounts.write_text("print('{\"codex\": [], \"claude\": []}')\n")
            worker.configure(language="en")
            yield worker, command, accounts
    finally:
        worker.tearDown()


def test_external_duty_lifecycle(external_duty_worker, monkeypatch):
    from teamster_board.external_duty import ExternalDuty, ExternalDutyConfig

    worker, command, accounts = external_duty_worker
    release = worker.root / "release-first-turn"
    release_followup = worker.root / "release-followup"
    question = "Which label should the new file contain?"
    check = {"command": "verify labels", "outcome": "passed", "details": "1 check passed"}
    worker.account(worker.home, "A", worker.reset, runs=[
        {"mode": "complete", "delay_gate": str(release),
         "reply": worker.work_result("needs_decision", questions=[question], checks=[])},
        {"mode": "complete", "delay_gate": str(release_followup),
         "write_files": {"label.txt": "blue\n"}, "commit_files": ["label.txt"],
         "reply": worker.work_result(checks=[check], summary="Added the blue label.",
                                     commit_message="Add blue label")},
        {"mode": "hold"},
    ])
    repository = str(worker.repo)
    token = "external-duty-test-token-with-enough-characters"
    settings = Settings(worker.home, accounts, action_teamster=str(command), duty_seconds=0,
                        no_land=True, poll_seconds=0.02, web_dist=worker.root / "dist",
                        external_duty=ExternalDutyConfig("fixture", token, (repository,), 1, 300))
    base = "/api/external-duty/v1"
    headers = {"Authorization": f"Bearer {token}"}
    start = {"request_id": "start-001", "repository": repository, "goal": "Add a label file.",
             "done_when": ["Verify the contents of the file."]}

    def server(host="127.0.0.1"):
        return TestClient(create_app(settings), base_url="http://127.0.0.1:8787",
                          client=(host, 54321), headers=headers)

    def card(client, task_id):
        response = client.get(f"{base}/tasks/{task_id}")
        assert response.status_code == 200, response.text
        return response.json()["task"]

    def wait_for(client, task_id, status):
        deadline = time.monotonic() + 30
        while True:
            current = card(client, task_id)
            if current["status"] == status:
                return current
            assert time.monotonic() < deadline, current
            time.sleep(0.02)

    with server("192.0.2.1") as remote:
        assert remote.get(f"{base}/tasks").status_code == 403
    with server() as client:
        assert client.get(f"{base}/tasks", headers={"Authorization": "Bearer wrong"}).status_code == 403
        assert client.get(f"{base}/tasks").json()["tasks"] == []
        forbidden = client.post(f"{base}/tasks",
                                json=dict(start, request_id="foreign-001", repository=str(worker.root)))
        assert forbidden.status_code == 403, forbidden.text
        assert forbidden.json()["error"]["code"] == "repository_not_allowed"
        opencode_start = dict(start, request_id="opencode-001", executor="opencode", model="offline/model")
        for model in ("default", "offline/model#high"):
            invalid = client.post(f"{base}/tasks", json=dict(opencode_start, model=model))
            assert invalid.status_code == 400 and invalid.json()["error"]["code"] == "invalid_request"
        created = client.post(f"{base}/tasks", json=start)
        assert created.status_code == 201, created.text
        initial = created.json()["task"]
        task_id = initial["id"]
        active = wait_for(client, task_id, "running")
        assert active["goal"] == start["goal"]
        assert active["executor"] == "codex"
        assert active["repository"] == repository
        assert active["no_push"] is True and active["pr"] is None
        assert worker.state(active["slug"])["no_push"] is True
        assert client.get(f"{base}/tasks").json()["tasks"][0]["id"] == task_id
        at_capacity = client.post(f"{base}/tasks", json=dict(start, request_id="capacity-001"))
        assert at_capacity.status_code == 409, at_capacity.text
        assert at_capacity.json()["error"]["code"] == "parallel_limit"
        assert client.get(f"{base}/events").json()["events"] == []
        release.touch()
        decision = wait_for(client, task_id, "needs_decision")
        assert decision["question"] == question
        event_page = client.get(f"{base}/events").json()
        event, = event_page["events"]
        assert event["type"] == "needs_decision"
        assert event["question"] == question and event["task_id"] == task_id

    with server() as client:
        replay = client.post(f"{base}/tasks", json=start)
        assert replay.status_code == 201, replay.text
        assert replay.json() == created.json()
        reused = client.post(f"{base}/tasks", json=dict(start, goal="Different work"))
        assert reused.status_code == 409, reused.text
        assert reused.json()["error"]["code"] == "idempotency_conflict"
        assert len(worker.invocations()) == 1
        assert client.get(f"{base}/events").json() == event_page
        assert client.get(f"{base}/events", params={"after": event_page["next_cursor"]}).json()["events"] == []
        decision = card(client, task_id)
        answer = {"request_id": "say-001", "version": decision["version"],
                  "message": "Use the blue label."}
        sent = client.post(f"{base}/tasks/{task_id}/say", json=answer)
        assert sent.status_code == 200, sent.text
    # Finish while there is no client polling, then retrieve the missed event
    # with the same cursor from a fresh Board instance.
    release_followup.touch()
    worker.until(lambda: worker.state(active["slug"]).get("pid") is None, timeout=30)

    with server() as client:
        replay = client.post(f"{base}/tasks/{task_id}/say", json=answer)
        assert replay.status_code == 200 and replay.json() == sent.json(), replay.text
        finished = wait_for(client, task_id, "succeeded")
        assert finished["checks"]["reported"] == [check] and finished["pr"] is None
        assert "activity_log" not in finished and "messages" not in finished
        first, second = worker.invocations()
        assert start["done_when"][0] in first["prompt"]
        assert answer["message"] in second["prompt"]
        worker.assert_resumed_same_thread(first, second, worker.home)
        branch = worker.state(active["slug"])["branch"]
        assert worker.git("show", f"{branch}:label.txt") == "blue"
        assert not worker.gh_invocations()
        assert worker.git("--git-dir", str(worker.root / "origin.git"), "for-each-ref",
                          "--format=%(refname)", "refs/heads") == "refs/heads/main"
        events = client.get(f"{base}/events", params={"after": event_page["next_cursor"]}).json()
        end, = events["events"]
        assert end["type"] == "task_finished" and end["task_id"] == task_id
        assert end["id"] != event["id"] and end["checks"]["reported"] == [check]
        assert client.get(f"{base}/events", params={"after": events["next_cursor"]}).json()["events"] == []

        next_start = dict(start, request_id="start-002")

        def lose_receipt(self, db, key, reply):
            assert reply[0] == 201, reply
            raise RuntimeError("Board stopped before saving the receipt")

        with monkeypatch.context() as crash:
            crash.setattr(ExternalDuty, "record", lose_receipt)
            with pytest.raises(RuntimeError, match="before saving the receipt"):
                client.post(f"{base}/tasks", json=next_start)
        existing = {task["id"] for task in client.get(f"{base}/tasks").json()["tasks"]}
        assert task_id in existing and len(existing) == 2

    with server() as client:
        next_task = client.post(f"{base}/tasks", json=next_start)
        assert next_task.status_code == 201, next_task.text
        running = wait_for(client, next_task.json()["task"]["id"], "running")
        assert existing == {task_id, running["id"]}
        assert len(worker.invocations()) == 3
        stopped = client.post("/api/actions/stop", json={"slug": running["slug"]},
                              headers={"Origin": "http://127.0.0.1:8787", "X-Teamster-Board": "1"})
        assert stopped.status_code == 200, stopped.text
        stale = client.post(f"{base}/tasks/{running['id']}/stop",
                            json={"request_id": "stale-001", "version": running["version"]})
        assert stale.status_code == 409, stale.text
        assert stale.json()["error"]["code"] == "version_conflict"
        assert stale.json()["task"]["status"] == "stopped"
        assert stale.json()["task"]["version"] != running["version"]
        stop_page = client.get(f"{base}/events", params={"after": events["next_cursor"]}).json()
        stop_event, = stop_page["events"]
        assert (stop_event["type"], stop_event["task_id"], stop_event["status"]) == (
            "task_finished", running["id"], "stopped",
        )

        fake = worker.root / "opencode"
        fake.write_text("#!" + sys.executable + """
import os, sys, time
from pathlib import Path
if sys.argv[1] == "api":
    print('{"data":{"id":"ses_board"}}')
else:
    assert sys.argv[1] == "acp"
    Path("acp-started").write_text(str(os.getpid()))
    time.sleep(60)
""")
        fake.chmod(0o700)
        last = client.post(f"{base}/tasks", json=opencode_start)
        assert last.status_code == 201, last.text
        assert last.json()["task"]["executor"] == "opencode"
        slug = last.json()["task"]["slug"]
        assert worker.state(slug)["task_model"] == opencode_start["model"]
        marker = Path(worker.state(slug)["worktree"]) / "acp-started"
        worker.until(lambda: marker.is_file() and marker.read_text() == str(worker.state(slug).get("opencode_pid")))
        state = worker.state(slug)
        worker.extra_pids.update((state["pid"], state["opencode_pid"]))
        os.kill(state["pid"], signal.SIGKILL)
        worker.until(lambda: not worker.process_is_live(state["pid"]))
        last_id = last.json()["task"]["id"]
        for attempt in range(5):
            current = card(client, last_id)
            assert current["alive"] is False and current["can_stop"] is True
            accepted = client.post(f"{base}/tasks/{last_id}/stop",
                                   json={"request_id": f"stop-{attempt}", "version": current["version"]})
            if accepted.status_code != 409 or accepted.json()["error"]["code"] != "version_conflict":
                break
        assert accepted.status_code == 200, accepted.text
        assert not worker.process_is_live(state["opencode_pid"])
        assert "can_stop" not in card(client, last_id)
