"""Contract checks through the REST and WebSocket interfaces."""

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import anyio
import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse, WebSocketTestSession

from teamster_board import access, actions as actions_module
from teamster_board import app as board_app
from teamster_board.app import Settings, create_app
from teamster_board.research import Research


SUMMARY_FIELDS = {
    "slug", "kind", "repo", "branch", "task_type", "executor", "account", "reviewer",
    "model", "effort", "column", "phase", "phase_started_at", "alive", "turn", "fix_round",
    "outcome", "result_status", "summary", "pr", "ci", "sleeping_until", "created", "updated_at",
    "activity", "title", "link", "scheduled", "check", "review", "findings_left", "stop", "left",
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
    assert set(detail) == SUMMARY_FIELDS | {"timeline", "files", "cargo", "limits", "messages",
                                           "activity_log", "actions"}
    assert detail["actions"] == client.get("/api/research").json()["actions"]
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
        assert set(detail) == SUMMARY_FIELDS | {"timeline", "files", "cargo", "limits", "messages",
                                               "activity_log", "actions"}
        assert detail["limits"] is None
        assert detail["messages"] == detail["activity_log"] == []
        assert detail["actions"] == client.get("/api/research").json()["actions"]
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
        "actions": application.state.board.actions.value}
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
        index.write_text(index.read_text().replace("proposed", args[2]))
    if args[0] == "reflect":
        (tasks / args[1]).mkdir()
    if args[0] == "start":
        directory = tasks / args[1]
        directory.mkdir()
        (directory / "brief.md").write_text(record["brief"])
        (directory / "state.json").write_text(json.dumps({"repo": args[args.index("--repo") + 1],
                                                       "created": time.time()}))
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
        yield client, application, settings, entry, calls, control


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
    assert response.json() == {"ok": True, "output": "finished", "slug": base}
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
        assert response.json() == {"ok": True, "output": "finished", "slug": slug}
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


@pytest.mark.parametrize("status,origin,full", [
    ("proposed", "git@github.com:owner/project.git", True),
    ("accepted", "https://forge.example/owner/project.git", False),
])
def test_station_implement_argv_exact_brief_and_refresh(station, lesson_repo, monkeypatch, caplog,
                                                      status, origin, full):
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
        "entry": f" {entry} ", "repo": str(lesson_repo), "note": "  Keep it focused.  " if full else "  ",
    })
    slug = "lesson-w2-1109"
    assert response.status_code == 200
    assert response.json() == {"ok": True, "output": "Started work", "slug": slug}
    records = [json.loads(line) for line in calls.read_text().splitlines()]
    assert len(records) == (2 if status == "proposed" else 1)
    if status == "proposed":
        assert records[0]["argv"] == ["lesson", entry, "accepted", f"--note=внедряется: {slug}"]
    start = records[-1]
    brief_path = start["argv"][3]
    assert start["argv"] == [
        "start", slug, "--brief", brief_path, "--repo", str(lesson_repo), "--executor", "claude",
        "--sandbox", "off", "--effort", "high", "--task-type", "feature", "--max-minutes", "60",
        "--review", "--fix-rounds", "2", "--parallel", *(["--ci"] if origin and "github.com" in origin else []),
    ]
    expected = ("""Внедрить урок «batch-2026-11-09.md W2»: Keep the latest check.

Зачем: пользователь принял этот урок рефлексии на научной станции и попросил его внедрить. Урок из файла batch-2026-11-09.md в архиве задач.

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

Зачем: пользователь принял этот урок рефлексии на научной станции и попросил его внедрить. Урок из файла batch-2026-11-09.md в архиве задач.

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


@pytest.mark.parametrize("step,count,status", [("lesson", 1, "proposed"), ("start", 2, "accepted")])
def test_station_implement_failed_step_and_accepted_lesson_refresh(station, lesson_repo, step, count, status):
    client, _, _, entry, calls, control = station
    assert client.get("/api/research").json()["lessons"][0]["status"] == "proposed"
    control.write_text(json.dumps({step + "_exit": 7, "stderr": "Failed step"}))
    response = client.post("/api/actions/implement", json={"entry": entry, "repo": str(lesson_repo)})
    assert response.status_code == 422
    assert response.json() == {"ok": False, "error": "Failed step"}
    records = [json.loads(line) for line in calls.read_text().splitlines()]
    assert len(records) == count
    assert records[0]["argv"][0] == "lesson"
    if step == "start":
        assert records[1]["argv"][0] == "start"
        assert not Path(records[1]["argv"][3]).exists()
    assert client.get("/api/research").json()["lessons"][0]["status"] == status


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
    assert response.status_code == 422
    assert response.json() == {"ok": False, "error": "fallback error"}
    control.write_text(json.dumps({"stdout": "  " + "o" * 2100 + "  "}))
    response = client.post("/api/actions/reflect", json={})
    assert response.status_code == 200
    assert response.json()["output"] == "o" * 2000
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
    client, _, _, _, calls, _ = ships
    slug = "work-alive" if route == "stop" else "work-idle"
    caplog.set_level("INFO", logger="uvicorn.error")
    response = client.post(f"/api/actions/{route}", json={"slug": slug, **body})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "output": "finished"}
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
            assert other.get("/api/tasks/work-idle").json()["actions"] == actions
            response = other.post(f"/api/actions/{route}", json={"slug": "work-idle", **body})
            assert response.status_code == 403
            assert response.json() == {"ok": False, "error": reason}
    assert not calls.exists()
