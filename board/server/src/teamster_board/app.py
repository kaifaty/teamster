"""REST, WebSocket polling, localhost protection and optional SPA serving."""

import asyncio
import copy
import json
import logging
import os
import re
import shutil
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import anyio
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, PlainTextResponse

from .accounts import Accounts, Reports, probe
from .actions import Actions, action_body, error
from .art import MEDIA_TYPES, art_file, art_index
from .constellations import read_constellations
from .duty import Duty
from .duty_chat import DutyChat
from .logins import Logins
from .machines import Machines
from .research import Research
from .store import LOG_RETENTION_SECONDS, Store, number

REPOSITORY = Path(__file__).resolve().parents[4]
PING_SECONDS = 20
# A new sign-in row in the journal refreshes accounts at once, at most this often.
LOGIN_REFRESH_SECONDS = 5
ACCOUNT_REFRESH_SECONDS = 30
FILE_LIMIT = 256 * 1024
LOCAL_HOST = re.compile(r"(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?", re.I)
LOGGER = logging.getLogger("uvicorn.error")
# The board's files in the worker's data home, by layout. The board never imports the worker.
LAYOUT_FILES = {
    "legacy": {"tasks": "claude-tasks", "board_machines": "board-machines.json", "board_log": "board-server.log",
               "board_art": "board-art", "board_constellations": "board-constellations.json",
               "telemetry": "codex-worker-log.jsonl", "worktrees": "worktrees"},
    "new": {"tasks": "tasks", "board_machines": "board-machines.json", "board_log": "board-server.log",
            "board_art": "board-art", "board_constellations": "board-constellations.json", "telemetry": "log.jsonl",
            "worktrees": "worktrees"},
}


def resolve_data_home(environ=None):
    """(data home, layout) by the worker's rules, first match wins."""
    environ = os.environ if environ is None else environ
    if environ.get("TEAMSTER_HOME"):
        return Path(environ["TEAMSTER_HOME"]).expanduser(), "new"
    if environ.get("CODEX_TASK_HOME"):
        codex = Path(environ["CODEX_TASK_HOME"]).expanduser()
        marker = codex / "teamster-home"
        target = marker.read_text(encoding="utf-8").strip() if marker.is_file() else ""
        return (Path(target).expanduser(), "new") if target else (codex, "legacy")
    home = Path.home()
    data, codex = home / ".teamster", home / ".codex"
    if data.exists():
        return data, "new"
    if ((home / ".teamster.migrating").exists() or (codex / "claude-tasks").exists()
            or (codex / "codex-worker.json").exists()):
        return codex, "legacy"
    return data, "new"


@dataclass
class Settings:
    task_home: Path  # the worker's data home
    teamster: Path
    poll_seconds: float = 1.0
    accounts_seconds: float = 300
    web_dist: Path = REPOSITORY / "board/web/dist"
    stale_days: float = 7
    claude_desktop_dir: Path | None = None
    claude_home: Path | None = None
    sessions_seconds: float = 5
    session_stale_hours: float = 48
    machines_file: Path | None = None
    machines_seconds: float = 30
    ssh_command: str = "ssh"
    layout: str = "legacy"
    research_seconds: float = 30
    reflection_task: str = "codex-batch-reflection"
    action_teamster: str | None = field(default_factory=lambda: shutil.which("teamster"))
    read_only: bool = False
    no_land: bool = False
    duty_seconds: float = 1800

    def path(self, purpose):
        return self.task_home / LAYOUT_FILES[self.layout][purpose]

    @classmethod
    def from_env(cls):
        task_home, layout = resolve_data_home()
        return cls(
            task_home=task_home, layout=layout,
            teamster=Path(os.environ.get("BOARD_TEAMSTER_COMMAND", os.environ.get(
                "BOARD_CODEX_TASK", str(REPOSITORY / "src/teamster/__main__.py"),
            ))).expanduser(),
            poll_seconds=float(os.environ.get("BOARD_POLL_SECONDS", "1.0")),
            accounts_seconds=float(os.environ.get("BOARD_ACCOUNTS_SECONDS", "300")),
            stale_days=float(os.environ.get("BOARD_STALE_DAYS", "7")),
            claude_desktop_dir=Path(os.environ.get(
                "BOARD_CLAUDE_DESKTOP_DIR", "~/Library/Application Support/Claude",
            )).expanduser(),
            claude_home=Path(os.environ.get("BOARD_CLAUDE_HOME", "~/.claude")).expanduser(),
            sessions_seconds=float(os.environ.get("BOARD_SESSIONS_SECONDS", "5")),
            session_stale_hours=float(os.environ.get("BOARD_SESSION_STALE_HOURS", "48")),
            machines_file=Path(os.environ["BOARD_MACHINES_FILE"]).expanduser()
            if "BOARD_MACHINES_FILE" in os.environ else None,
            machines_seconds=float(os.environ.get("BOARD_MACHINES_SECONDS", "30")),
            research_seconds=float(os.environ.get("BOARD_RESEARCH_SECONDS", "30")),
            reflection_task=os.environ.get("BOARD_REFLECTION_TASK") or "codex-batch-reflection",
            duty_seconds=float(os.environ.get("BOARD_DUTY_SECONDS", "1800")),
        )


def local_origin(value):
    try:
        origin = urlsplit(value)
        return (origin.scheme in ("http", "https") and not origin.path
                and not origin.query and not origin.fragment
                and LOCAL_HOST.fullmatch(origin.netloc) is not None)
    except ValueError:
        return False


class LocalOnly:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            hosts = [value.decode("latin-1") for key, value in scope["headers"] if key == b"host"]
            origins = [value.decode("latin-1") for key, value in scope["headers"] if key == b"origin"]
            allowed = len(hosts) == 1 and LOCAL_HOST.fullmatch(hosts[0]) is not None
            if scope["type"] == "websocket" and origins:
                allowed = allowed and len(origins) == 1 and local_origin(origins[0])
            if not allowed:
                if scope["type"] == "websocket":
                    socket = WebSocket(scope, receive, send)
                    await socket.send_denial_response(PlainTextResponse("Forbidden", status_code=403))
                else:
                    response = (error(403, "forbidden") if scope["path"].startswith("/api/actions/")
                                else PlainTextResponse("Forbidden", status_code=403))
                    await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


class Board:
    def __init__(self, settings):
        self.settings = settings
        self.store = Store(
            settings.path("tasks"), stale_days=settings.stale_days,
            claude_desktop_dir=settings.claude_desktop_dir, claude_home=settings.claude_home,
            sessions_seconds=settings.sessions_seconds, session_stale_hours=settings.session_stale_hours,
            telemetry_path=settings.path("telemetry"),
        )
        self.research = Research(settings.path("tasks"), settings.reflection_task,
                                 settings.research_seconds, claude_desktop_dir=settings.claude_desktop_dir)
        self.loop = None
        self.actions = Actions(self.research, self.store, settings.action_teamster, settings.read_only,
                               publish=self.publish_launch, worktrees_path=settings.path("worktrees"),
                               no_land=settings.no_land, publish_research=self.publish_research)
        self.accounts = Accounts(settings.teamster, settings.accounts_seconds)
        self.duty = Duty(self.actions)
        self._duty_reason = self.actions.reason or "old_teamster"
        self._duty_mode = "off"
        self._duty_due = float("inf")
        self._duty_changed = asyncio.Event()
        self._duty_lock = asyncio.Lock()
        self._accounts_lock = asyncio.Lock()
        self._election_error = None
        self.duty_chat = DutyChat(settings.path("tasks"), self.actions, lambda: self.accounts.value)
        self.reports = Reports(settings.teamster)
        self.machines = Machines(settings.machines_file or settings.path("board_machines"),
                                 settings.ssh_command)
        self.lock = asyncio.Lock()
        self.clients = set()
        # A sign-in read from the journal wakes the accounts loop; _login_at is when the latest
        # sign-in no refresh has covered yet was read.
        self.login_seen = asyncio.Event()
        self._login_at = None
        self._forced_at = float("-inf")
        self.logins = Logins(settings.teamster, self.publish, self.request_accounts)
        self.refresh_jobs = {}
        self._refresh_started = float("-inf")

    def publish(self, message):
        for queue in self.clients:
            queue.put_nowait(message)

    def publish_launch(self, launch):
        loop = self.loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self.publish, {"type": "launch", "launch": launch})

    def publish_research(self):
        loop = self.loop
        if loop is not None and not loop.is_closed():
            value = copy.deepcopy({**self.research.view(), "actions": self.actions.value,
                                   "launches": self.actions.launches()})
            loop.call_soon_threadsafe(self.publish, {"type": "research", "research": value})

    async def poll(self):
        async with self.lock:
            messages = await asyncio.to_thread(self.store.poll)
            for message in messages:
                self.publish(message)
            if await asyncio.to_thread(self.duty_chat.changed):
                self.publish({"type": "duty_chat", "at": time.time()})
            if self.store.take_logins():
                self.request_accounts()
            self.actions.landing.poll()

    def request_accounts(self):
        self._login_at = time.monotonic()
        self.login_seen.set()

    @property
    def account_value(self):
        value = {**self.accounts.value, "last_logins": self.store.last_logins()}
        data = value["data"]
        if not isinstance(data, dict) or not any(isinstance(data.get(family), list) for family in ("codex", "claude")):
            return value
        data = copy.deepcopy(data)
        status = self.accounts.duty["data"]
        if self.accounts.duty["error"] is not None and self.accounts.value["error"] is None:
            status = None
        record = status.get("duty") if isinstance(status, dict) else data.get("duty")
        record = record if isinstance(record, dict) else {}
        mode = "pinned" if record.get("pinned") else "auto" if record or (
            isinstance(status, dict) and status.get("unreadable")
        ) else "off"
        data["duty"] = {"account": None, "family": None, "since": None, "checked_at": None,
                        "reason": None, **record, "mode": mode,
                        "pinned_unavailable": record.get("pinned_unavailable"),
                        "choosable": self._duty_reason is None, "reason_disabled": self._duty_reason,
                        "last_election": self._election_error or {
                            "at": record.get("checked_at"), "error": self.accounts.duty["error"]}}
        for family in ("codex", "claude"):
            for row in data.get(family, []):
                if isinstance(row, dict):
                    needs_login = (row.get("status") == "not_logged_in" if family == "codex" else
                                   row.get("needs_login") is True or row.get("token_unavailable") is True)
                    row.update(pinnable=not needs_login, pin_reason="needs_login" if needs_login else None)
        return {**value, "data": data}

    def account_target(self, data):
        family, account = data.get("family"), data.get("account")
        if family not in ("codex", "claude") or not isinstance(account, str) or not account:
            return None, error(400, "Invalid family or account")
        snapshot = self.accounts.value["data"]
        rows = snapshot.get(family, []) if isinstance(snapshot, dict) else []
        if not any(isinstance(row, dict) and row.get("name") == account for row in rows):
            return None, error(404, "Account not found")
        return (family, account), None

    async def refresh_accounts(self):
        async with self._accounts_lock:
            value = await self.accounts.refresh(force=True)
            if value is not None:
                data = value["data"]
                if isinstance(data, dict) and any(isinstance(data.get(family), list) for family in ("codex", "claude")):
                    self._duty_reason = await asyncio.to_thread(self.duty.reason)
                    if self._duty_reason is None:
                        await self.accounts.refresh_duty()
                    mode = self.account_value["data"]["duty"]["mode"]
                    if mode != self._duty_mode:
                        self._duty_mode = mode
                        self._duty_due = time.monotonic() if mode == "auto" else float("inf")
                    self._duty_changed.set()
                async with self.lock:
                    self.publish({"type": "accounts", "accounts": self.account_value})

    async def choose_duty(self, data):
        if self.settings.read_only:
            return error(403, "read_only")
        if self.actions.reason is not None:
            return error(403, self.actions.reason)
        if set(data) == {"account", "family"}:
            target, failure = self.account_target(data)
            if failure is not None:
                return failure
            family, account = target
            arguments = ["set", account, "--family", family]
        elif set(data) == {"mode"} and data["mode"] in ("auto", "off"):
            arguments = ["auto" if data["mode"] == "auto" else "clear"]
        else:
            return error(400, "Expected account and family, or mode auto or off")
        async with self._duty_lock:
            result = await asyncio.to_thread(self.duty.execute, arguments)
            if isinstance(result, dict) and result.get("ok"):
                self._election_error = None
                await self.refresh_accounts()
            return result

    async def poll_duty(self):
        while True:
            self._duty_changed.clear()
            if (self.settings.duty_seconds <= 0 or self.settings.read_only
                    or self._duty_mode != "auto" or self._duty_reason is not None):
                await self._duty_changed.wait()
                continue
            remaining = self._duty_due - time.monotonic()
            if remaining > 0:
                try:
                    await asyncio.wait_for(self._duty_changed.wait(), remaining)
                except asyncio.TimeoutError:
                    pass
                continue
            async with self._duty_lock:
                # A manual selection may have acquired the lock while this tick waited.
                await self.refresh_accounts()
                if self.settings.read_only or self._duty_mode != "auto" or self._duty_reason is not None:
                    continue
                if self.accounts.duty["error"] is not None:
                    self._duty_due = time.monotonic() + self.settings.duty_seconds
                    continue
                result = await asyncio.to_thread(self.duty.execute, ["tick"])
                if isinstance(result, dict) and result.get("ok"):
                    self._election_error = None
                else:
                    detail = json.loads(result.body)["error"]
                    self._election_error = {"at": time.time(), "error": detail}
                    LOGGER.warning("Duty election failed: %s", detail)
                self._duty_due = time.monotonic() + self.settings.duty_seconds
                await self.refresh_accounts()

    def account_refresh(self, family, account):
        key = (family, account)
        if key in self.refresh_jobs:
            return error(409, "Account refresh is already running")
        now = time.monotonic()
        if family == "codex":
            if now - self._refresh_started < ACCOUNT_REFRESH_SECONDS:
                return error(429, "Account refresh is limited to once every 30 seconds")
            self._refresh_started = now
        job = asyncio.create_task(self._account_refresh(family, account))
        self.refresh_jobs[key] = job
        job.add_done_callback(lambda _: self.refresh_jobs.pop(key, None))
        return {"ok": True}

    async def _account_refresh(self, family, account):
        if family == "claude":
            await probe(self.settings.teamster, account)
        await self.refresh_accounts()

    async def snapshot(self):
        async with self.lock:
            return {"generated_at": time.time(), "tasks": self.store.summaries(),
                    "accounts": self.account_value, "machines": self.machines.value,
                    "logins": self.logins.snapshot()}

    async def poll_tasks(self):
        while True:
            await asyncio.sleep(self.settings.poll_seconds)
            await self.poll()

    async def poll_accounts(self):
        due = time.monotonic()
        while True:
            await self._wait_for_refresh(due)
            started = time.monotonic()
            if started < due:
                self._forced_at = started
            # A refresh covers every sign-in read before it started, a periodic one included.
            if self._login_at is not None and self._login_at <= started:
                self._login_at = None
            # This loop schedules the refreshes itself, so it bypasses the throttle in Accounts.
            await self.refresh_accounts()
            due = started + self.settings.accounts_seconds

    async def _wait_for_refresh(self, due):
        """Wait for the periodic deadline, or for a pending sign-in once the forced window is over."""
        while True:
            deadline = due
            if self._login_at is not None:
                deadline = min(deadline, self._forced_at + LOGIN_REFRESH_SECONDS)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            self.login_seen.clear()
            try:
                await asyncio.wait_for(self.login_seen.wait(), remaining)
            except asyncio.TimeoutError:
                pass

    async def poll_machines(self):
        while True:
            started = time.monotonic()
            value = await self.machines.refresh()
            if value is not None:
                self.publish({"type": "machines", "machines": value})
            await asyncio.sleep(max(0, self.settings.machines_seconds - (time.monotonic() - started)))


def read_tail(path):
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        stream.seek(max(0, stream.tell() - FILE_LIMIT))
        raw = stream.read(FILE_LIMIT)
    # Ignore a split multibyte character at the start of the byte-limited tail.
    return raw.decode("utf-8", "ignore")


def create_app(settings=None):
    board = Board(settings or Settings.from_env())

    @asynccontextmanager
    async def lifespan(app):
        board.loop = asyncio.get_running_loop()
        await board.poll()
        jobs = [asyncio.create_task(board.poll_tasks()), asyncio.create_task(board.poll_accounts()),
                asyncio.create_task(board.poll_duty()),
                asyncio.create_task(board.poll_machines()),
                asyncio.create_task(asyncio.to_thread(board.research.view))]
        try:
            yield
        finally:
            board.loop = None
            await board.logins.close()
            jobs.extend(list(board.refresh_jobs.values()))
            for job in jobs:
                job.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(LocalOnly)
    app.state.board = board

    @app.get("/api/snapshot")
    async def snapshot():
        return await board.snapshot()

    @app.get("/api/events")
    async def events(since: float | None = None, until: float | None = None):
        until = time.time() if until is None else until
        since = until - 24 * 3600 if since is None else since
        if (number(since) is None or number(until) is None
                or since > until or until - since > LOG_RETENTION_SECONDS):
            raise HTTPException(422, "Event window must be ordered and at most 31 days")
        async with board.lock:
            return await asyncio.to_thread(board.store.events, since, until)

    @app.get("/api/report")
    async def report(since: str, by: str | None = None):
        try:
            return await board.reports.get(since, by)
        except ValueError as exc:
            raise HTTPException(422, str(exc))

    @app.get("/api/tasks/{slug}")
    async def detail(slug: str):
        task = await asyncio.to_thread(board.store.detail, slug)
        if task is None:
            raise HTTPException(404)
        queue = await asyncio.to_thread(board.actions.queue)
        return {**task, "actions": {**board.actions.value, "queue": queue}}

    @app.get("/api/tasks/{slug}/files/{name}")
    async def task_file(slug: str, name: str):
        async with board.lock:
            path = await asyncio.to_thread(board.store.file_path, slug, name)
            if path is None:
                raise HTTPException(404)
            try:
                content = await asyncio.to_thread(read_tail, path)
            except OSError:
                raise HTTPException(404)
        return PlainTextResponse(content)

    @app.get("/api/tasks/{slug}/feed")
    async def task_feed(slug: str, after: str | None = None):
        feed = await asyncio.to_thread(board.store.feed, slug, after)
        if feed is None:
            raise HTTPException(404)
        return feed

    @app.get("/api/research")
    async def research():
        return {**await asyncio.to_thread(board.research.view), "actions": board.actions.value,
                "launches": await asyncio.to_thread(board.actions.launches)}

    @app.get("/api/duty-chat")
    async def duty_chat():
        return await asyncio.to_thread(board.duty_chat.view)

    @app.post("/api/actions/duty-chat")
    async def duty_chat_action(request: Request):
        data = await action_body(request)
        if not isinstance(data, dict):
            return data
        return await asyncio.to_thread(board.duty_chat.send, data)

    @app.post("/api/actions/duty")
    async def duty_action(request: Request):
        data = await action_body(request)
        if not isinstance(data, dict):
            return data
        return await board.choose_duty(data)

    @app.post("/api/actions/lesson")
    @app.post("/api/actions/implement")
    @app.post("/api/actions/say")
    @app.post("/api/actions/reflect")
    @app.post("/api/actions/verdict")
    @app.post("/api/actions/review")
    @app.post("/api/actions/stop")
    @app.post("/api/actions/clean")
    async def action(request: Request):
        data = await action_body(request)
        if not isinstance(data, dict):
            return data
        route = request.url.path.rsplit("/", 1)[-1]
        result = await asyncio.to_thread(board.actions.run, route, data)
        if route == "verdict" and isinstance(result, dict) and result.get("ok"):
            # The journal row is read at once: the answer and the socket carry the task with its verdict.
            await board.poll()
            task = await asyncio.to_thread(board.store.summary, data["slug"])
            if task is not None:
                result = {**result, "task": task}
        return result

    @app.post("/api/actions/login")
    @app.post("/api/actions/login/input")
    @app.post("/api/actions/login/cancel")
    @app.post("/api/actions/account-refresh")
    async def account_action(request: Request):
        data = await action_body(request)
        if not isinstance(data, dict):
            return data
        if board.settings.read_only:
            return error(403, "read_only")
        route = request.url.path
        if route == "/api/actions/login/input":
            return await board.logins.input(data)
        if route == "/api/actions/login/cancel":
            return board.logins.cancel(data)
        target, failure = board.account_target(data)
        if failure is not None:
            return failure
        if route == "/api/actions/login":
            return board.logins.start(*target)
        return board.account_refresh(*target)

    @app.get("/api/art")
    async def art():
        return await asyncio.to_thread(art_index, board.settings.path("board_art"))

    @app.get("/api/constellations")
    async def constellations():
        return await asyncio.to_thread(read_constellations, board.settings.path("board_constellations"))

    @app.get("/api/art/{repo}/{name}")
    async def art_picture(repo: str, name: str):
        path = await asyncio.to_thread(art_file, board.settings.path("board_art"), repo, name)
        if path is None:
            raise HTTPException(404)
        return FileResponse(path, media_type=MEDIA_TYPES[name])

    @app.websocket("/ws")
    async def websocket(socket: WebSocket):
        await socket.accept()
        queue = asyncio.Queue()
        board.clients.add(queue)

        async def send_updates():
            next_ping = time.monotonic() + PING_SECONDS
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), max(0, next_ping - time.monotonic()))
                except asyncio.TimeoutError:
                    message = {"type": "ping", "at": time.time()}
                    next_ping = time.monotonic() + PING_SECONDS
                await socket.send_json(message)

        async def ignore_messages():
            while True:
                message = await socket.receive()
                if message["type"] == "websocket.disconnect":
                    return

        try:
            await socket.send_json({"type": "snapshot", "snapshot": await board.snapshot()})
            async with anyio.create_task_group() as group:
                async def writer():
                    try:
                        await send_updates()
                    except WebSocketDisconnect:
                        group.cancel_scope.cancel()

                group.start_soon(writer)
                try:
                    await ignore_messages()
                finally:
                    group.cancel_scope.cancel()
        finally:
            board.clients.discard(queue)

    @app.get("/{path:path}")
    async def web(path: str):
        if path == "api" or path.startswith("api/") or path == "ws":
            raise HTTPException(404)
        dist = board.settings.web_dist.resolve()
        if not dist.is_dir():
            if path:
                raise HTTPException(404)
            return PlainTextResponse("Build the web app in board/web to serve the task board.\n")
        candidate = (dist / path).resolve()
        if not candidate.is_relative_to(dist):
            raise HTTPException(404)
        if candidate.is_file():
            return FileResponse(candidate)
        index = (dist / "index.html").resolve()
        if not index.is_relative_to(dist) or not index.is_file():
            raise HTTPException(404)
        return FileResponse(index)

    return app
