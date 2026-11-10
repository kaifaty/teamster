"""Board orders for tasks and the science station, through the installed teamster CLI."""

import json
import logging
import re
import shutil
import subprocess
import tempfile
import threading
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from fastapi.responses import JSONResponse

from . import access
from .research import RECORD, STATUSES
from .store import Store, alive, number


BODY_LIMIT = 64 * 1024
COMMAND_TIMEOUT = 120
VERSION_TIMEOUT = 10
# teamster 1.60.0 added `say --queue`: an order to a busy task waits for the end of its cycle.
QUEUE_VERSION = (1, 60, 0)
VERSION = re.compile(r"([0-9]+)\.([0-9]+)\.([0-9]+)")
SAY_KINDS = ("work", "review", "reflect")
NAME = re.compile(r"[A-Za-z0-9._-]{1,100}")
MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
EFFORTS = ("low", "medium", "high", "xhigh", "max", "ultra")
ANGLES = ("correctness", "concurrency", "security", "tests")
OPTION_NAMES = ("model", "effort", "max_minutes", "max_weekly", "fix_rounds", "ci_rounds",
                "reviewer", "review_angles")
LOGGER = logging.getLogger("uvicorn.error")


def error(status, message):
    return JSONResponse({"ok": False, "error": message}, status_code=status)


async def action_body(request):
    headers = request.headers
    origins = headers.getlist("origin")
    try:
        origin = urlsplit(origins[0]) if len(origins) == 1 else None
        target = urlsplit(str(request.url))
        allowed = (origin is not None and origin.scheme == target.scheme
                   and origin.netloc.lower() == target.netloc.lower()
                   and not origin.path and not origin.query and not origin.fragment)
    except ValueError:
        allowed = False
    if (not allowed or headers.getlist("x-teamster-board") != ["1"]
            or len(headers.getlist("content-type")) != 1
            or headers["content-type"].split(";", 1)[0].strip().lower() != "application/json"):
        return error(403, "forbidden")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > BODY_LIMIT:
            return error(413, "Body too large")
        body.extend(chunk)
    try:
        data = json.loads(body)
    except (ValueError, UnicodeError, RecursionError):
        return error(400, "Invalid JSON")
    return data if isinstance(data, dict) else error(400, "Expected a JSON object")


def string(data, name, limit, required=False):
    value = data.get(name, "")
    if not isinstance(value, str):
        raise ValueError(f"Invalid {name}")
    value = value.strip()
    if len(value) > limit or (required and not value):
        raise ValueError(f"Invalid {name}")
    return value


def names(data, name):
    values = data.get(name, [])
    if (not isinstance(values, list) or len(values) > 20
            or any(not isinstance(value, str) or NAME.fullmatch(value) is None for value in values)):
        raise ValueError(f"Invalid {name}")
    return values


def option_flags(options):
    if not isinstance(options, dict) or any(key not in OPTION_NAMES for key in options):
        raise ValueError("Invalid options")
    flags = []
    for name in OPTION_NAMES:
        if name not in options:
            continue
        value = options[name]
        if name == "model":
            valid = isinstance(value, str) and MODEL.fullmatch(value) is not None
        elif name == "effort":
            valid = value in EFFORTS
        elif name in ("max_minutes", "fix_rounds", "ci_rounds"):
            low, high = (5, 600) if name == "max_minutes" else (0, 5)
            valid = type(value) is int and low <= value <= high
        elif name == "max_weekly":
            numeric = number(value)
            valid = numeric is not None and 0.5 <= numeric <= 100
            if valid:
                value = str(int(numeric)) if numeric.is_integer() else str(numeric)
        elif name == "reviewer":
            valid = value in ("codex", "claude")
        else:  # review_angles
            valid = value == "auto" or (isinstance(value, list) and 1 <= len(value) <= 4
                                        and all(angle in ANGLES for angle in value)
                                        and len(set(value)) == len(value))
            if valid and isinstance(value, list):
                value = ",".join(value)
        if not valid:
            raise ValueError(f"Invalid {name}")
        flags.append(f"--{name.replace('_', '-')}={value}")
    return flags


def implementation_brief(lesson, note):
    entry = lesson["entry"]
    paragraphs = [
        f"Внедрить урок «{entry}»: {lesson['title'] or lesson['cue']}.",
        "Зачем: пользователь принял этот урок рефлексии на научной станции и попросил его внедрить. "
        f"Урок из файла {entry.split()[0]} в архиве задач.",
    ]
    details = []
    for field, label in (("cue", "Признак"), ("lesson", "Что делать"), ("proposal", "Предложение"),
                         ("evidence", "Доказательства"), ("caveats", "Оговорки")):
        if lesson[field]:
            separator = "\n" if field == "evidence" else " "
            details.append(f"{label}:{separator}{lesson[field]}")
    if details:
        paragraphs.append("\n".join(details))
    if note:
        paragraphs.append(f"Уточнение пользователя: {note}")
    paragraphs.append("""Готово, когда:
- предложение урока внедрено в этом репозитории в той форме, которую оно называет; если эта форма не подходит к коду — в ближайшей, которая даёт тот же результат, предпочитая проверку или защиту в коде правилу в тексте;
- изменённое поведение закреплено тестом;
- документация репозитория, которую задевает изменение, обновлена;
- части предложения для другого репозитория или для файлов вне репозитория (например ~/.codex/AGENTS.md или ~/.claude/…) не сделаны, а перечислены в отчёте в remaining.

Проверки: тесты и проверки, которые требуют AGENTS.md и README этого репозитория.
Не трогать: ничего, что не нужно для этого урока; записи задач и INDEX.md в архиве teamster.
Если предложение неясно или для него нужен выбор пользователя — закончи ход со статусом needs_decision и задай вопросы.
""")
    return "\n\n".join(paragraphs)


class Actions:
    def __init__(self, research, store, command, read_only=False):
        self.research = research
        self.store = store
        command = shutil.which(str(command)) if command else None
        self.command = str(Path(command).absolute()) if command else None
        self.reason = "read_only" if read_only else "no_teamster" if not command else None
        self.lock = threading.Lock()
        self.version_lock = threading.Lock()
        self._queue = None

    @property
    def value(self):
        return {"enabled": self.reason is None, "reason": self.reason}

    def queue(self):
        """Whether the installed teamster queues orders to a busy task; its version is asked once, when first needed."""
        if self.reason is not None:
            return False
        with self.version_lock:
            if self._queue is None:
                self._queue = self._queue_version()
            return self._queue

    def _queue_version(self):
        try:
            result = subprocess.run([self.command, "--version"], stdin=subprocess.DEVNULL, capture_output=True,
                                    encoding="utf-8", errors="replace", timeout=VERSION_TIMEOUT, cwd=Path.home())
        except (OSError, subprocess.TimeoutExpired) as exc:
            LOGGER.info("teamster --version failed: %s", exc)
            return False
        match = VERSION.search(result.stdout) if result.returncode == 0 else None
        LOGGER.info("teamster --version: %s", match.group(0) if match else f"exit={result.returncode}, no version")
        return match is not None and tuple(int(part) for part in match.groups()) >= QUEUE_VERSION

    def run(self, route, data):
        with self.lock:
            if self.reason is not None:
                return error(403, self.reason)
            try:
                return self._run(route, data)
            except ValueError as exc:
                return error(400, str(exc))

    def _run(self, route, data):
        if route == "implement":
            return self._implement(data)
        if route in ("say", "verdict", "review", "stop", "clean"):
            return self._task(route, data)
        argv = [self.command, route]
        file_text = ""
        slug = None
        if route == "lesson":
            entry = string(data, "entry", 200, required=True)
            status = data.get("status")
            note = string(data, "note", 1000)
            if status not in STATUSES:
                raise ValueError("Invalid status")
            if not any(row["entry"] == entry for row in self.research.view()["lessons"]):
                return error(404, "Unknown lesson")
            argv.extend([entry, status])
            if note:
                argv.append(f"--note={note}")
        else:  # reflect; only the registered endpoints call this method.
            tasks, repos = names(data, "tasks"), names(data, "repos")
            since = data.get("since")
            file_text = string(data, "order", 8000)
            if tasks and (since is not None or repos):
                raise ValueError("tasks cannot be combined with since or repos")
            if "since" in data:
                if not isinstance(since, str):
                    raise ValueError("Invalid since")
                if re.fullmatch(r"[0-9]{1,3}d", since) is None:
                    if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", since) is None:
                        raise ValueError("Invalid since")
                    date.fromisoformat(since)
            base = datetime.now(timezone.utc).strftime("reflect-%m%d-%H%M%S")
            slug = base
            suffix = 2
            while (self.research.tasks_path / slug).exists():
                slug = f"{base}-{suffix}"
                suffix += 1
            argv.append(slug)
            for task in tasks:
                argv.extend(["--task", task])
            if since is not None:
                argv.extend(["--since", since])
            for repo in repos:
                argv.extend(["--repo", repo])
        path = None
        try:
            if file_text:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as stream:
                    path = Path(stream.name)
                    stream.write(file_text)
                argv.extend(["--file", str(path)])
            result = self._execute(route, argv)
            if route == "reflect" and isinstance(result, dict):
                result["slug"] = slug
            return result
        finally:
            if path is not None:
                path.unlink()

    def _task(self, route, data):
        slug = data.get("slug")
        if not Store._safe_slug(slug):
            raise ValueError("Invalid slug")
        file_text = ""
        flags = []
        queued = False
        if route == "say":
            file_text = string(data, "text", 8000, required=True)
            flags = option_flags(data.get("options", {}))
        elif route == "verdict":
            verdict = data.get("verdict")
            if verdict not in ("accepted", "revised", "redone", "dropped"):
                raise ValueError("Invalid verdict")
            note = string(data, "note", 200)
            flags = [verdict] + ([f"--note={note}"] if note else [])
        elif route == "review":
            flags = option_flags({key: data[key] for key in ("effort", "reviewer", "review_angles")
                                  if key in data})
        elif route == "clean":
            keep_branch = data.get("keep_branch", True)
            if type(keep_branch) is not bool:
                raise ValueError("Invalid keep_branch")
            flags = ["--keep-branch"] if keep_branch else []
        with self.store.lock:
            if slug in self.store.session_records:
                return error(409, "not running" if route == "stop" else "Not a task")
            record = self.store._record(slug)
            if record is not None:
                self.store._read_state(record)
                archived = record.archived
                running = alive(record.state.get("pid"))
                kind = record.state.get("kind", "work")
        if record is None:
            # The station also addresses archived studies and implementations by their base slug.
            if route == "say":
                view = self.research.view()
                candidates = [*view["studies"], *(row["implementation"] for row in view["lessons"]
                                                 if row["implementation"] is not None)]
                if any(row["slug"] == slug and row["archived"] for row in candidates):
                    return error(409, "Study is alive or archived")
            return error(404, "Unknown task")
        if route == "stop":
            if archived or not running:
                return error(409, "not running")
        elif route == "clean":
            if archived or running:
                return error(409, "Task is alive or archived")
        elif route == "verdict":
            if kind not in ("work", "review"):
                return error(409, "Task kind does not support verdicts")
        elif route == "say" and running and not archived and kind in SAY_KINDS and self.queue():
            # A busy task takes the order into its queue, sent when its cycle completes.
            queued = True
        elif archived or running or kind not in (SAY_KINDS if route == "say" else ("work", "review")):
            return error(409, "Task is alive, archived or has an unsupported kind")
        match = RECORD.fullmatch(slug) if archived else None
        command_slug = match.group(1) if match else slug
        argv = [self.command, route, command_slug, *flags]
        path = None
        try:
            if file_text:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as stream:
                    path = Path(stream.name)
                    stream.write(file_text)
                argv.extend(["--file", str(path)])
            if queued:
                argv.append("--queue")
            return self._execute(route, argv)
        finally:
            if path is not None:
                path.unlink()

    def _implement(self, data):
        entry = string(data, "entry", 200, required=True)
        note = string(data, "note", 4000)
        view = self.research.view()
        lesson = next((row for row in view["lessons"] if row["entry"] == entry), None)
        if lesson is None:
            return error(404, "Unknown lesson")
        if lesson["status"] not in ("proposed", "accepted"):
            return error(409, "Урок уже внедрён или отклонён")
        repo = data.get("repo")
        if not any(row["path"] == repo for row in view["repos"]):
            raise ValueError("Unknown repository")
        implementation = lesson["implementation"]
        if implementation is not None and not implementation["archived"]:
            return error(409, f"Урок уже внедряется: {implementation['slug']}")
        if access.readable(Path(repo) / ".git") is not True:
            return error(503, "Нет доступа к диску с репозиторием. Разреши Python доски доступ к файлам "
                         "на съёмных томах: Системные настройки → Конфиденциальность и безопасность → "
                         "Файлы и папки или Полный доступ к диску.")
        lesson_id = re.sub(r"[^a-z0-9]", "-", entry.split()[-1].lower())
        base = f"lesson-{lesson_id}-{datetime.now(timezone.utc):%m%d}"
        slug, suffix = base, 2
        while (self.research.tasks_path / slug).exists():
            slug = f"{base}-{suffix}"
            suffix += 1
        if re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", slug) is None:
            raise ValueError("Invalid slug")
        argv = [self.command, "start", slug]
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as stream:
            path = Path(stream.name)
            stream.write(implementation_brief(lesson, note))
        try:
            argv.extend(["--brief", str(path), "--repo", repo, "--executor", "claude", "--sandbox", "off",
                         "--effort", "high", "--task-type", "feature", "--max-minutes", "60",
                         "--review", "--fix-rounds", "2", "--parallel"])
            try:
                origin = subprocess.run(["git", "-C", repo, "remote", "get-url", "origin"],
                                        stdin=subprocess.DEVNULL, capture_output=True, encoding="utf-8",
                                        errors="replace", timeout=10)
                if origin.returncode == 0 and "github.com" in origin.stdout:
                    argv.append("--ci")
            except (OSError, subprocess.TimeoutExpired):
                pass
            if lesson["status"] == "proposed":
                result = self._execute("implement", [self.command, "lesson", entry, "accepted",
                                                     f"--note=внедряется: {slug}"])
                if not isinstance(result, dict):
                    return result
            result = self._execute("implement", argv)
            if isinstance(result, dict):
                result["slug"] = slug
            return result
        finally:
            path.unlink()

    def _execute(self, route, argv):
        try:
            with subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, encoding="utf-8", errors="replace",
                                  cwd=Path.home()) as process:
                timed_out = False
                try:
                    stdout, stderr = process.communicate(timeout=COMMAND_TIMEOUT)
                except subprocess.TimeoutExpired:
                    process.kill()
                    stdout, stderr = process.communicate()
                    timed_out = True
        except OSError as exc:
            LOGGER.info("/api/actions/%s argv=%s exit=unavailable", route, json.dumps(argv))
            return error(422, str(exc)[-2000:])
        LOGGER.info("/api/actions/%s argv=%s exit=%s", route, json.dumps(argv), process.returncode)
        if timed_out:
            return error(504, "timeout")
        if process.returncode:
            return error(422, (stderr.strip() or stdout.strip())[-2000:])
        self.research.invalidate()
        return {"ok": True, "output": stdout.strip()[-2000:]}
