"""Local v1 API for an operator outside the Board UI."""
import asyncio
import fcntl
import hmac
import ipaddress
import json
import logging
import os
import re
import sqlite3
import stat
import subprocess
import time
import uuid
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from . import duty_events, duty_tasks
from .actions import COMMAND_TIMEOUT, OPENCODE_MODEL, json_body

LOGGER = logging.getLogger("uvicorn.error")
REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,100}")
TOKEN = re.compile(r"[A-Za-z0-9._~-]{32,256}")
FIELDS = {
    "start": {"request_id", "repository", "goal", "done_when"},
    "say": {"request_id", "version", "message"},
    "stop": {"request_id", "version"},
}


@dataclass(frozen=True)
class ExternalDutyConfig:
    actor: str
    token: str = field(repr=False)
    repositories: tuple[str, ...]
    max_parallel: int
    task_timeout_seconds: int
    observer_token: str | None = field(default=None, repr=False)

    @classmethod
    def load(cls, path):
        data = json.loads(path.expanduser().read_text(encoding="utf-8"))
        if (not isinstance(data, dict)
                or data.keys() - {"observer_token"} != cls.__dataclass_fields__.keys() - {"observer_token"}):
            raise ValueError("Invalid external duty config fields")
        repos = data["repositories"]
        observer = data.get("observer_token")
        if (not valid_text(data["actor"], 100)
                or not isinstance(data["token"], str) or not TOKEN.fullmatch(data["token"])
                or (observer is not None and (not isinstance(observer, str) or not TOKEN.fullmatch(observer)
                                              or hmac.compare_digest(observer, data["token"])))
                or not isinstance(repos, list) or not repos
                or any(not valid_text(repo, 4096) or not Path(repo).is_absolute()
                       or str(Path(repo).resolve()) != repo for repo in repos)
                or type(data["max_parallel"]) is not int or not 1 <= data["max_parallel"] <= 32
                or type(data["task_timeout_seconds"]) is not int or not 1 <= data["task_timeout_seconds"] <= 86400):
            raise ValueError("Invalid external duty config values")
        return cls(**{**data, "repositories": tuple(repos)})


def valid_text(value, limit):
    return (isinstance(value, str) and 0 < len(value) <= limit and bool(value.strip())
            and "\0" not in value and not any(0xD800 <= ord(char) <= 0xDFFF for char in value))


def validate(route, data):
    fields = FIELDS[route]
    if route == "start" and "executor" in data:
        model = data.get("model")
        if data["executor"] != "opencode" or not isinstance(model, str) or not OPENCODE_MODEL.fullmatch(model):
            return False
        fields = fields | {"executor", "model"}
    if data.keys() != fields:
        return False
    key = data["request_id"]
    if not isinstance(key, str) or not REQUEST_ID.fullmatch(key):
        return False
    if route == "start":
        criteria = data["done_when"]
        return (valid_text(data["repository"], 4096) and valid_text(data["goal"], 12000)
                and isinstance(criteria, list) and 1 <= len(criteria) <= 20
                and all(valid_text(item, 1000) for item in criteria))
    return valid_text(data["version"], 128) and (route != "say" or valid_text(data["message"], 4000))


def failure(status, code, **fields):
    return status, {"ok": False, "error": {"code": code}, **fields}


def success(status, card):
    return status, {"ok": True, "task": card}


def response(status, body):
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


class ExternalDuty:
    def __init__(self, board):
        self.board = board
        self.store = duty_tasks.read_store(board.store)
        self.config = board.settings.external_duty
        self.home = board.settings.task_home.resolve()
        self.ledger = self.home / "external-duty"
        self.event_path = self.home / "external-duty-events.jsonl"
        self.repos = self.config.repositories
        self.environment = dict(os.environ)
        if board.settings.layout == "legacy":
            self.environment.pop("TEAMSTER_HOME", None)
            self.environment["CODEX_TASK_HOME"] = str(self.home)
        else:
            self.environment["TEAMSTER_HOME"] = str(self.home)

    def authorized(self, request, *, operator_write=False):
        if request.client is None:
            return False
        try:
            if not ipaddress.ip_address(request.client.host).is_loopback:
                return False
        except ValueError:
            return False
        values = request.headers.getlist("authorization")
        if len(values) != 1:
            return False
        presented = values[0].encode("latin-1")
        if hmac.compare_digest(presented, ("Bearer " + self.config.token).encode("ascii")):
            return True
        if request.method != "GET" and not (operator_write and request.method == "POST"):
            return False
        return self.config.observer_token is not None and hmac.compare_digest(
            presented, ("Bearer " + self.config.observer_token).encode("ascii"),
        )

    def tasks(self):
        return duty_tasks.tasks(self.store, self.repos)

    def task(self, task_id):
        return duty_tasks.task(self.store, self.repos, task_id)

    def initialize_events(self):
        self.home.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(self.event_path, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise OSError("External duty event journal is not a regular file")
        finally:
            os.close(descriptor)

    def events(self, after, limit):
        return duty_events.events(self.event_path, self.repos, after, limit)

    def operation(self, route, task_id, data):
        if not validate(route, data):
            return failure(400, "invalid_request")
        if self.board.settings.read_only:
            return failure(403, "read_only")
        key = (self.config.actor, data["request_id"])
        intent = json.dumps([route, task_id, data], sort_keys=True)
        self.ledger.mkdir(mode=0o700, parents=True, exist_ok=True)
        # The Board's normal say/stop/review/clean actions and the version check
        # share a lock. flock also serializes API callers across Board processes.
        with self.board.actions.lock, (self.ledger / "commands.lock").open("ab") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with closing(sqlite3.connect(self.ledger / "commands.sqlite3")) as db:
                db.row_factory = sqlite3.Row
                db.execute("""CREATE TABLE IF NOT EXISTS commands (
                    actor TEXT NOT NULL, request_id TEXT NOT NULL, intent TEXT NOT NULL,
                    received_at REAL NOT NULL, slug TEXT, repository TEXT, target TEXT,
                    status INTEGER, result TEXT, finished_at REAL,
                    PRIMARY KEY (actor, request_id)
                )""")
                prior = db.execute("SELECT * FROM commands WHERE actor=? AND request_id=?", key).fetchone()
                if prior is not None:
                    if prior["intent"] != intent:
                        return failure(409, "idempotency_conflict")
                    if prior["repository"] is not None and prior["repository"] not in self.repos:
                        return failure(403, "repository_not_allowed")
                    if prior["status"] is not None:
                        return prior["status"], json.loads(prior["result"])
                    # Only start has an operation-specific receipt in Teamster
                    # (the reserved slug). A later manual stop is not our receipt.
                    if route == "start":
                        recovered = self.started(prior["slug"], prior["repository"])
                        if recovered is not None:
                            return self.record(db, key, recovered)
                    return failure(503, "operation_unknown")

                slug = "duty-" + uuid.uuid4().hex if route == "start" else None
                repo = data.get("repository")
                current = self.task(task_id) if task_id is not None else None
                if current is not None:
                    slug, repo = current["slug"], current["repository"]
                now = time.time()
                denied = self.preflight(db, route, slug, repo, current, data)
                status, body = denied if denied is not None else (None, None)
                with db:
                    db.execute("""INSERT INTO commands
                        (actor, request_id, intent, received_at, slug, repository, target, status, result, finished_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                               (*key, intent, now, slug, repo, task_id, status,
                                json.dumps(body) if denied is not None else None,
                                time.time() if denied is not None else None))
                if denied is not None:
                    return denied
                result = self.execute(route, slug, repo, current, data, lock.fileno())
                if result is None:
                    return failure(503, "operation_unknown")
                return self.record(db, key, result)

    def record(self, db, key, reply):
        status, body = reply
        target = body["task"]["id"] if status == 201 else None
        with db:
            db.execute("""UPDATE commands SET status=?, result=?, finished_at=?, target=COALESCE(target, ?)
                          WHERE actor=? AND request_id=?""",
                       (status, json.dumps(body), time.time(), target, *key))
        return reply

    def started(self, slug, repo):
        # The generated slug is reserved before dispatch. A state file by itself
        # may be from an incomplete start; only a claimed turn proves launch.
        card = duty_tasks.task_by_slug(self.store, self.repos, slug, include_archive=True)
        if (card is not None and card["repository"] == repo and card["no_push"]
                and card["deadline_at"] is not None and card["turn"] > 0):
            return success(201, card)
        return None

    def preflight(self, db, route, slug, repo, current, data):
        if route != "start":
            if current is None:
                return failure(404, "task_not_found")
            if current["version"] != data["version"]:
                return failure(409, "version_conflict", task=current)
            if current["archived"] or current["stop_requested"] or (
                    route == "stop" and not (current["alive"] or current.get("can_stop"))):
                return failure(409, "task_not_actionable", task=current)
            if route == "say":
                # Only resume tasks launched through this interface, under its
                # persisted deadline and no-push policy.
                started = db.execute("""SELECT 1 FROM commands
                    WHERE slug=? AND repository=? AND status=201 AND target=?""",
                                     (slug, repo, current["id"])).fetchone()
                if not started or not current["no_push"] or current["deadline_at"] is None:
                    return failure(403, "task_not_managed")
                if current["deadline_at"] <= time.time():
                    return failure(409, "deadline_exceeded", task=current)
        elif repo not in self.repos:
            return failure(403, "repository_not_allowed")
        elif not self.main_checkout(repo):
            return failure(409, "repository_unavailable")

        if self.board.actions.command is None:
            return failure(503, "no_teamster")
        if (route == "start" or (route == "say" and not current["alive"])) and (
                sum(card["alive"] for card in self.tasks()) >= self.config.max_parallel):
            return failure(409, "parallel_limit")
        if route == "start":
            self.initialize_events()
        return None

    def execute(self, route, slug, repo, current, data, lock_fd):
        if route == "start":
            args = ["start", slug, "--brief", "-", "--repo", repo, "--parallel", "--no-push",
                    "--task-timeout", str(self.config.task_timeout_seconds)]
            if "executor" in data:
                args.extend(["--executor", data["executor"], "--model", data["model"]])
            stdin = data["goal"].rstrip() + "\n\n## Done when\n\n" + "\n".join(
                "- " + item.strip().replace("\n", "\n  ") for item in data["done_when"]) + "\n"
        elif route == "say":
            args = ["say", slug, "--queue", "--file", "/dev/stdin"]
            stdin = data["message"]
        else:
            args, stdin = ["stop", slug], ""
        try:
            # If Board dies mid-command, the launcher retains the lock until
            # it exits. Teamster's detached supervisor does not inherit it.
            process = subprocess.run([self.board.actions.command, *args], input=stdin.encode("utf-8"), capture_output=True,
                                     env=self.environment, cwd=self.home, timeout=COMMAND_TIMEOUT,
                                     pass_fds=(lock_fd,))
        except subprocess.TimeoutExpired:
            LOGGER.warning("External duty %s for %s timed out", route, slug)
            return self.started(slug, repo) if route == "start" else None
        except OSError:
            LOGGER.exception("External duty could not invoke Teamster %s for %s", route, slug)
            return failure(503, "no_teamster")
        if route == "start":
            confirmed = self.started(slug, repo)
            if confirmed is not None or process.returncode <= 0:
                return confirmed
        elif process.returncode == 0:
            if route == "stop" and process.stdout.strip() == b"not running":
                return failure(409, "task_not_actionable", task=self.task(current["id"]) or current)
            # The action was accepted. Keep the previous card if it vanished
            # during the CLI call; it still identifies the affected task.
            return success(200, self.task(current["id"]) or current)
        if process.returncode < 0:
            return None
        LOGGER.warning("External duty %s for %s exited %s", route, slug, process.returncode)
        latest = self.task(current["id"]) if current is not None else None
        return failure(409, "teamster_rejected", **({"task": latest} if latest else {}))

    def main_checkout(self, repo):
        # teamster start resolves linked worktrees to their main checkout. Do
        # not allow a linked checkout to redirect a request outside the list.
        try:
            root = Path(repo)
            dotgit = root / ".git"
            if root.resolve(strict=True) != root or dotgit.is_symlink() or not dotgit.is_dir():
                return False
            result = subprocess.run(["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                    stdin=subprocess.DEVNULL, capture_output=True, timeout=10,
                                    env=self.environment)
            return result.returncode == 0 and os.fsdecode(result.stdout.rstrip(b"\n")) == str(dotgit)
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            return False


def register(app, board, operator_chat=None, operator_resolution=None):
    if board.settings.external_duty is None:
        return
    api = ExternalDuty(board)
    router = APIRouter(prefix="/api/external-duty/v1")
    try:
        api.initialize_events()
    except OSError:
        LOGGER.exception("External duty could not initialize the event journal")

    async def call(request, handler, *args, operator_write=False):
        if not api.authorized(request, operator_write=operator_write):
            return response(*failure(403, "forbidden"))
        try:
            return response(*await asyncio.to_thread(handler, *args))
        except (OSError, sqlite3.Error):
            LOGGER.exception("External duty data is unavailable")
            return response(*failure(503, "host_unreachable"))

    @router.get("/tasks")
    async def tasks(request: Request):
        return await call(request, lambda: (200, {"tasks": api.tasks()}))

    @router.get("/tasks/{task_id}")
    async def task(request: Request, task_id: str):
        def read():
            card = api.task(task_id)
            return (200, {"task": card}) if card is not None else failure(404, "task_not_found")

        return await call(request, read)

    @router.get("/chat/{identity}/evidence")
    async def chat_evidence(request: Request, identity: str, view: str, query: str = Query("", max_length=160),
                            project: str = Query("", max_length=255), status: str = Query("", max_length=60),
                            offset: int = Query(0, ge=0), kind: str = "", card_id: str = Query("", max_length=255)):
        if operator_chat is None or board.settings.read_only:
            return response(*failure(404, "chat_unavailable"))
        return await call(request, operator_chat.read, identity, view, query, project, status, offset, kind, card_id)

    @router.get("/resolutions")
    async def resolutions(request: Request):
        if operator_resolution is None:
            return response(*failure(404, "resolution_unavailable"))
        return await call(request, lambda: (200, operator_resolution.view()))

    @router.post("/resolutions/poll")
    async def poll_resolutions(request: Request):
        if not api.authorized(request, operator_write=True):
            return response(*failure(403, "forbidden"))
        if operator_resolution is None or board.settings.read_only:
            return response(*failure(403, "read_only"))
        result = await call(request, lambda: (200, operator_resolution.poll()), operator_write=True)
        if result.status_code == 200 and json.loads(result.body)["card"] is not None:
            board.publish({"type": "project_tasks_changed"})
        return result

    @router.get("/events")
    async def events(request: Request, after: str = "0", limit: str = "100"):
        def read():
            try:
                return 200, api.events(int(after), int(limit))
            except ValueError:
                return failure(400, "invalid_cursor")

        return await call(request, read)

    @router.get("/project-titles")
    async def project_titles(request: Request):
        return await call(request, lambda: (200, {"tasks": [] if board.settings.read_only
                                                    else board.project_tasks.title_candidates(api.repos)}))

    @router.post("/project-titles/{task_id}")
    async def update_project_title(request: Request, task_id: str):
        if not api.authorized(request, operator_write=True):
            return response(*failure(403, "forbidden"))
        if board.settings.read_only:
            return response(*failure(403, "read_only"))
        data = await json_body(request)
        if not isinstance(data, dict) or data.keys() != {"revision", "title"}:
            return response(*failure(400, "invalid_request"))
        title, revision = data["title"], data["revision"]
        if (not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{64}", revision)
                or title is not None and (not valid_text(title, 90) or not title.isprintable())):
            return response(*failure(400, "invalid_request"))

        def write():
            if board.project_tasks.update_title(task_id, revision, title.strip() if title else None, api.repos):
                return 200, {"ok": True}
            return failure(409, "title_conflict")

        result = await call(request, write, operator_write=True)
        if result.status_code == 200 and title is not None:
            board.publish({"type": "project_tasks_changed"})
        return result

    async def mutate(request, route, task_id=None):
        if not api.authorized(request):
            return response(*failure(403, "forbidden"))
        content_types = request.headers.getlist("content-type")
        if len(content_types) != 1 or content_types[0].split(";", 1)[0].strip().lower() != "application/json":
            return response(*failure(400, "invalid_request"))
        data = await json_body(request)
        if not isinstance(data, dict):
            return response(*failure(data.status_code, "invalid_request"))
        return await call(request, api.operation, route, task_id, data)

    @router.post("/tasks")
    async def start(request: Request):
        return await mutate(request, "start")

    @router.post("/tasks/{task_id}/say")
    async def say(request: Request, task_id: str):
        return await mutate(request, "say", task_id)

    @router.post("/tasks/{task_id}/stop")
    async def stop(request: Request, task_id: str):
        return await mutate(request, "stop", task_id)

    app.include_router(router)
