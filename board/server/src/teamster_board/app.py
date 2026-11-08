"""REST, WebSocket polling, localhost protection and optional SPA serving."""

import asyncio
import os
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import anyio
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, PlainTextResponse

from .accounts import Accounts, Reports
from .art import MEDIA_TYPES, art_file, art_index
from .machines import Machines
from .research import Research
from .store import LOG_RETENTION_SECONDS, Store, number

REPOSITORY = Path(__file__).resolve().parents[4]
PING_SECONDS = 20
# A new sign-in row in the journal refreshes accounts at once, at most this often.
LOGIN_REFRESH_SECONDS = 5
FILE_LIMIT = 256 * 1024
LOCAL_HOST = re.compile(r"(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?", re.I)
# The board's files in the worker's data home, by layout. The board never imports the worker.
LAYOUT_FILES = {
    "legacy": {"tasks": "claude-tasks", "board_machines": "board-machines.json", "board_log": "board-server.log",
               "board_art": "board-art", "telemetry": "codex-worker-log.jsonl"},
    "new": {"tasks": "tasks", "board_machines": "board-machines.json", "board_log": "board-server.log",
            "board_art": "board-art", "telemetry": "log.jsonl"},
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
                    await PlainTextResponse("Forbidden", status_code=403)(scope, receive, send)
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
                                 settings.research_seconds)
        self.accounts = Accounts(settings.teamster, settings.accounts_seconds)
        self.reports = Reports(settings.teamster)
        self.machines = Machines(settings.machines_file or settings.path("board_machines"),
                                 settings.ssh_command)
        self.lock = asyncio.Lock()
        self.clients = set()
        self.login_seen = asyncio.Event()
        self._forced_at = float("-inf")

    def publish(self, message):
        for queue in self.clients:
            queue.put_nowait(message)

    async def poll(self):
        async with self.lock:
            messages = await asyncio.to_thread(self.store.poll)
            for message in messages:
                self.publish(message)
            if self.store.take_logins():
                self.login_seen.set()

    async def snapshot(self):
        async with self.lock:
            return {"generated_at": time.time(), "tasks": self.store.summaries(),
                    "accounts": self.accounts.value, "machines": self.machines.value}

    async def poll_tasks(self):
        while True:
            await asyncio.sleep(self.settings.poll_seconds)
            await self.poll()

    async def poll_accounts(self):
        forced = False
        while True:
            started = time.monotonic()
            if forced:
                self._forced_at = started
            value = await self.accounts.refresh(force=forced)
            if value is not None:
                self.publish({"type": "accounts", "accounts": value})
            forced = await self._wait_for_login(
                max(0, self.settings.accounts_seconds - (time.monotonic() - started)))

    async def _wait_for_login(self, timeout):
        """Wait for the next periodic refresh; return True when a new sign-in forces one sooner."""
        try:
            await asyncio.wait_for(self.login_seen.wait(), timeout)
        except asyncio.TimeoutError:
            return False
        # Sign-ins during the pause, or during the previous refresh, share one refresh after it.
        await asyncio.sleep(max(0, self._forced_at + LOGIN_REFRESH_SECONDS - time.monotonic()))
        self.login_seen.clear()
        return True

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
        await board.poll()
        jobs = [asyncio.create_task(board.poll_tasks()), asyncio.create_task(board.poll_accounts()),
                asyncio.create_task(board.poll_machines())]
        try:
            yield
        finally:
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
        async with board.lock:
            task = await asyncio.to_thread(board.store.detail, slug)
        if task is None:
            raise HTTPException(404)
        return task

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

    @app.get("/api/research")
    async def research():
        return await asyncio.to_thread(board.research.view)

    @app.get("/api/art")
    async def art():
        return await asyncio.to_thread(art_index, board.settings.path("board_art"))

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
