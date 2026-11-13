"""Board orders for tasks and the science station, through the installed teamster CLI."""

import copy
import json
import logging
import re
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from fastapi.responses import JSONResponse

from . import access
from .research import RECORD, STATUSES
from .store import Store, alive, number


BODY_LIMIT = 64 * 1024
COMMAND_TIMEOUT = 120
LAUNCH_TIMEOUT = 300
LAUNCH_RETENTION = 600
LAUNCH_LIMIT = 4
LAUNCH_POLL_SECONDS = 0.05
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


def implementation_brief(lesson, note, started, lesson_id):
    entry = lesson["entry"]
    paragraphs = [
        f"Внедрить урок «{entry}»: {lesson['title'] or lesson['cue']}.",
        "Зачем: пользователь принял этот урок рефлексии на доске и попросил его внедрить. "
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
    if lesson["outside"]:
        paragraphs.append(
            "Файлы вне репозитория: пользователь разрешил этой задаче менять только эти файлы вне репозитория:\n"
            + "\n".join(f"- {path}" for path in lesson["outside"])
            + "\nПеред первой правкой существующего файла сохрани его копию рядом: "
            f"<файл>.bak-{started:%Y-%m-%d}-{lesson_id}. Проверь изменённое поведение на копии файла "
            "во временном каталоге, не на живых задачах и системах. Если в репозитории менять нечего, "
            "не коммить и не пушь ветку.")
        paragraphs.append("""Готово, когда:
- предложение урока внедрено в той форме, которую оно называет, в этом репозитории и в разрешённых файлах вне него; если эта форма не подходит к коду — в ближайшей, которая даёт тот же результат, предпочитая проверку или защиту в коде правилу в тексте;
- изменённое поведение закреплено тестом в репозитории, а для файла вне репозитория — проверкой на копии, записанной в checks;
- документация репозитория, которую задевает изменение, обновлена;
- в summary перечислены изменённые файлы вне репозитория, их копии .bak и команда `diff -u <копия> <файл>` для каждого;
- части предложения для других файлов вне репозитория и для других репозиториев не сделаны, а перечислены в remaining.""")
    else:
        paragraphs.append("""Готово, когда:
- предложение урока внедрено в этом репозитории в той форме, которую оно называет; если эта форма не подходит к коду — в ближайшей, которая даёт тот же результат, предпочитая проверку или защиту в коде правилу в тексте;
- изменённое поведение закреплено тестом;
- документация репозитория, которую задевает изменение, обновлена;
- части предложения для другого репозитория или для файлов вне репозитория (например ~/.codex/AGENTS.md или ~/.claude/…) не сделаны, а перечислены в отчёте в remaining.""")
    paragraphs.append("""Проверки: тесты и проверки, которые требуют AGENTS.md и README этого репозитория.
Не трогать: ничего, что не нужно для этого урока; записи задач и INDEX.md в архиве teamster.
Если предложение неясно или для него нужен выбор пользователя — закончи ход со статусом needs_decision и задай вопросы.
""")
    return "\n\n".join(paragraphs)


class Actions:
    def __init__(self, research, store, command, read_only=False, publish=None, worktrees_path=None):
        self.research = research
        self.store = store
        command = shutil.which(str(command)) if command else None
        self.command = str(Path(command).absolute()) if command else None
        self.reason = "read_only" if read_only else "no_teamster" if not command else None
        self.lock = threading.Lock()
        self.version_lock = threading.Lock()
        self._queue = None
        self.publish = publish or (lambda launch: None)
        self.worktrees_path = worktrees_path or research.tasks_path.parent / "worktrees"
        self.launch_lock = threading.RLock()
        self._launches = {}
        self._finished = {}

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

    def launches(self):
        with self.launch_lock:
            self._prune_launches()
            return copy.deepcopy(sorted(self._launches.values(), key=lambda launch: launch["started_at"]))

    def _prune_launches(self):
        for slug, finished in list(self._finished.items()):
            if finished < time.time() - LAUNCH_RETENTION:
                self._launches.pop(slug, None)
                self._finished.pop(slug)

    def _slug(self, base):
        slug, suffix = base, 2
        while (self.research.tasks_path / slug).exists() or slug in self._launches:
            slug = f"{base}-{suffix}"
            suffix += 1
        return slug

    def _launch(self, slug, kind, entry, repo, stage, target, *args):
        if sum(row["stage"] not in ("done", "failed") for row in self._launches.values()) >= LAUNCH_LIMIT:
            return error(409, "Слишком много запусков: подожди, пока начнутся предыдущие")
        if entry is not None:
            for previous, row in list(self._launches.items()):
                if row["entry"] == entry and row["stage"] in ("done", "failed"):
                    self._launches.pop(previous)
                    self._finished.pop(previous, None)
        now = time.time()
        launch = {"slug": slug, "kind": kind, "entry": entry, "repo": repo, "stage": stage,
                  "steps": [{"stage": stage, "at": now}], "error": None, "started_at": now}
        self._launches[slug] = launch
        initial = copy.deepcopy(launch)
        self.publish(initial)
        threading.Thread(target=self._launch_worker, args=(launch, target, args), daemon=True).start()
        return {"ok": True, "output": "", "slug": slug, "launch": initial}

    def _launch_worker(self, launch, target, args):
        try:
            failure = target(launch, *args)
        except Exception as exc:
            LOGGER.exception("/api/actions/%s launch=%s failed", launch["kind"], launch["slug"])
            failure = str(exc)[-2000:]
        self._stage(launch, "failed" if failure is not None else "done", failure)

    def _stage(self, launch, stage, failure=None):
        with self.launch_lock:
            if launch["stage"] == stage:
                return
            launch["stage"] = stage
            launch["steps"].append({"stage": stage, "at": time.time()})
            launch["error"] = failure
            if stage in ("done", "failed"):
                self._finished[launch["slug"]] = time.time()
            current = copy.deepcopy(launch)
        if stage in ("starting", "done", "failed"):
            self.research.invalidate()
        self.publish(current)

    def run(self, route, data):
        lock = self.launch_lock if route in ("implement", "reflect") else self.lock
        with lock:
            if self.reason is not None:
                return error(403, self.reason)
            try:
                if route in ("implement", "reflect"):
                    self._prune_launches()
                return self._run(route, data)
            except ValueError as exc:
                return error(400, str(exc))

    def _run(self, route, data):
        if route == "implement":
            return self._implement(data)
        if route == "reflect":
            return self._reflect(data)
        if route in ("say", "verdict", "review", "stop", "clean"):
            return self._task(route, data)
        entry = string(data, "entry", 200, required=True)
        status = data.get("status")
        note = string(data, "note", 1000)
        if status not in STATUSES:
            raise ValueError("Invalid status")
        if not any(row["entry"] == entry for row in self.research.view()["lessons"]):
            return error(404, "Unknown lesson")
        argv = [self.command, "lesson", entry, status]
        if note:
            argv.append(f"--note={note}")
        return self._execute(route, argv)

    def _reflect(self, data):
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
        slug = self._slug(datetime.now(timezone.utc).strftime("reflect-%m%d-%H%M%S"))
        argv = [self.command, "reflect", slug]
        for task in tasks:
            argv.extend(["--task", task])
        if since is not None:
            argv.extend(["--since", since])
        for repo in repos:
            argv.extend(["--repo", repo])
        return self._launch(slug, "reflect", None, None, "preparing", self._reflect_worker, argv, file_text)

    def _reflect_worker(self, launch, argv, file_text):
        path = None
        try:
            if file_text:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as stream:
                    path = Path(stream.name)
                    stream.write(file_text)
                argv.extend(["--file", str(path)])
            return self._execute_launch(launch, argv)
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
        for launch in self._launches.values():
            if launch["entry"] == entry and launch["stage"] not in ("done", "failed"):
                return error(409, f"Урок уже запускается: {launch['slug']}")
        implementation = lesson["implementation"]
        failed = (implementation is not None and any(
            row["entry"] == entry and row["slug"] == implementation["slug"] and row["stage"] == "failed"
            for row in self._launches.values()))
        if implementation is not None and not implementation["archived"] and not failed:
            return error(409, f"Урок уже внедряется: {implementation['slug']}")
        if access.readable(Path(repo) / ".git") is not True:
            return error(503, "Нет доступа к диску с репозиторием. Разреши Python доски доступ к файлам "
                         "на съёмных томах: Системные настройки → Конфиденциальность и безопасность → "
                         "Файлы и папки или Полный доступ к диску.")
        lesson_id = re.sub(r"[^a-z0-9]", "-", entry.split()[-1].lower())
        started = datetime.now(timezone.utc)
        base = f"lesson-{lesson_id}-{started:%m%d}"
        slug = self._slug(base)
        if re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", slug) is None:
            raise ValueError("Invalid slug")
        stage = "accepting" if lesson["status"] == "proposed" else "fetching"
        return self._launch(slug, "implement", entry, Path(repo).name, stage, self._implement_worker,
                            lesson, note, started, lesson_id, repo)

    def _implement_worker(self, launch, lesson, note, started, lesson_id, repo):
        path = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as stream:
                path = Path(stream.name)
                stream.write(implementation_brief(lesson, note, started, lesson_id))
            with self.lock:
                current = next((row for row in self.research.view()["lessons"]
                                if row["entry"] == lesson["entry"]), None)
                if current is None:
                    return "Unknown lesson"
                if current["status"] != lesson["status"]:
                    return f"Lesson status changed: {current['status']}"
                if current["status"] == "proposed":
                    failure = self._execute_launch(launch, [self.command, "lesson", lesson["entry"], "accepted",
                                                           f"--note=внедряется: {launch['slug']}"], observe=False)
                    if failure is not None:
                        return failure
                    self.research.invalidate()
            if lesson["status"] == "proposed":
                self._stage(launch, "fetching")
            argv = [self.command, "start", launch["slug"], "--brief", str(path), "--repo", repo,
                    "--executor", "claude", "--sandbox", "off", "--effort", "high", "--task-type", "feature",
                    "--max-minutes", "60", "--review", "--fix-rounds", "2", "--parallel"]
            try:
                origin = subprocess.run(["git", "-C", repo, "remote", "get-url", "origin"],
                                        stdin=subprocess.DEVNULL, capture_output=True, encoding="utf-8",
                                        errors="replace", timeout=10)
                if origin.returncode == 0 and "github.com" in origin.stdout:
                    argv.append("--ci")
            except (OSError, subprocess.TimeoutExpired):
                pass
            return self._execute_launch(launch, argv)
        finally:
            if path is not None:
                path.unlink()

    def _observe_launch(self, launch):
        if launch["kind"] == "implement" and launch["stage"] == "fetching":
            if (self.worktrees_path / f"claude-{launch['slug']}").is_dir():
                self._stage(launch, "worktree")
        if launch["stage"] in ("fetching", "worktree", "preparing"):
            if (self.research.tasks_path / launch["slug"] / "state.json").is_file():
                self._stage(launch, "starting")

    def _execute_launch(self, launch, argv, observe=True):
        route = launch["kind"]
        try:
            with subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, encoding="utf-8", errors="replace",
                                  cwd=Path.home()) as process:
                deadline = time.monotonic() + LAUNCH_TIMEOUT
                timed_out = False
                try:
                    while True:
                        if observe:
                            self._observe_launch(launch)
                        remaining = deadline - time.monotonic()
                        try:
                            stdout, stderr = process.communicate(timeout=max(0, min(LAUNCH_POLL_SECONDS, remaining)))
                            break
                        except subprocess.TimeoutExpired:
                            if remaining <= 0:
                                process.kill()
                                stdout, stderr = process.communicate()
                                timed_out = True
                                break
                    if observe:
                        self._observe_launch(launch)
                except Exception:
                    process.kill()
                    process.communicate()
                    raise
        except OSError as exc:
            LOGGER.info("/api/actions/%s argv=%s exit=unavailable", route, json.dumps(argv))
            return str(exc)[-2000:]
        LOGGER.info("/api/actions/%s argv=%s exit=%s", route, json.dumps(argv), process.returncode)
        if timed_out:
            return "timeout"
        if process.returncode:
            return (stderr.strip() or stdout.strip())[-2000:]
        return None

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
