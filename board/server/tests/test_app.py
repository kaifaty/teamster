"""Contract checks through the REST and WebSocket interfaces."""

import asyncio
import json
import os
import subprocess
import threading
from contextlib import contextmanager
from pathlib import Path

import anyio
import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse, WebSocketTestSession

from teamster_board import app as board_app
from teamster_board.app import Settings, create_app


SUMMARY_FIELDS = {
    "slug", "kind", "repo", "branch", "task_type", "executor", "account", "reviewer",
    "model", "effort", "column", "phase", "phase_started_at", "alive", "turn", "fix_round",
    "outcome", "result_status", "summary", "pr", "ci", "sleeping_until", "created", "updated_at",
    "activity", "title", "link", "scheduled",
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
            "slug": "demo", "kind": "work", "repo": "/tmp/repository", "branch": "demo-branch",
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


def test_stale_days_environment_reaches_store(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_TASK_HOME", str(tmp_path))
    monkeypatch.setenv("BOARD_CODEX_TASK", str(tmp_path / "fake_accounts.py"))
    monkeypatch.delenv("BOARD_STALE_DAYS", raising=False)
    assert Settings.from_env().stale_days == 7
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


def test_rest_contract_files_and_unknown_paths(board):
    client, _, directory, _, _ = board
    snapshot = client.get("/api/snapshot").json()
    assert set(snapshot) == {"generated_at", "tasks", "accounts", "machines"}
    assert snapshot["machines"] == {"config_error": None, "items": []}
    assert isinstance(snapshot["generated_at"], float)
    assert len(snapshot["tasks"]) == 1
    assert set(snapshot["tasks"][0]) == SUMMARY_FIELDS
    assert snapshot["tasks"][0]["title"] is None
    assert snapshot["tasks"][0]["link"] is None
    assert snapshot["tasks"][0]["scheduled"] is None
    assert set(snapshot["accounts"]) == {"fetched_at", "error", "data"}
    for name, filename in (("brief", "brief.md"), ("last", "last.md"),
                           ("review", "review.md"), ("check", "check.log")):
        content = "discard this prefix" + "x" * (256 * 1024)
        (directory / filename).write_text(content)
        response = client.get(f"/api/tasks/demo/files/{name}")
        assert response.status_code == 200
        assert response.headers["content-type"] == "text/plain; charset=utf-8"
        assert response.content == b"x" * (256 * 1024)
    detail = client.get("/api/tasks/demo").json()
    assert set(detail) == SUMMARY_FIELDS | {"timeline", "files"}
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
        detail = client.get("/api/tasks/local_example").json()
        assert set(detail) == SUMMARY_FIELDS | {"timeline", "files"}
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
    client, _, _, _, settings = board
    assert client.get("/api/research").json() == {
        "lessons": [], "batch": None,
        "pending": {"records": 0, "signals": 0, "repos": {}, "items": []},
        "reflection_task": "codex-batch-reflection"}
    assert client.post("/api/research").status_code == 405
    assert client.delete("/api/research").status_code == 405
    assert client.get("/api/research", headers={"Host": "evil.example"}).status_code == 403
    for name in ("BOARD_RESEARCH_SECONDS", "BOARD_REFLECTION_TASK"):
        monkeypatch.delenv(name, raising=False)
    defaults = Settings.from_env()
    assert (defaults.research_seconds, defaults.reflection_task) == (30, "codex-batch-reflection")
    monkeypatch.setenv("BOARD_RESEARCH_SECONDS", "5")
    monkeypatch.setenv("BOARD_REFLECTION_TASK", "weekly-review")
    research = create_app(Settings.from_env()).state.board.research
    assert (research.seconds, research.reflection_task) == (5, "weekly-review")
    assert research.tasks_path == tmp_path / "claude-tasks"
