"""The science station's sole write access, through the installed teamster CLI."""

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

from .research import STATUSES


BODY_LIMIT = 64 * 1024
COMMAND_TIMEOUT = 120
NAME = re.compile(r"[A-Za-z0-9._-]{1,100}")
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
    def __init__(self, research, command, read_only=False):
        self.research = research
        command = shutil.which(str(command)) if command else None
        self.command = str(Path(command).absolute()) if command else None
        self.reason = "read_only" if read_only else "no_teamster" if not command else None
        self.lock = threading.Lock()

    @property
    def value(self):
        return {"enabled": self.reason is None, "reason": self.reason}

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
        elif route == "say":
            slug = string(data, "slug", 100, required=True)
            file_text = string(data, "text", 8000, required=True)
            view = self.research.view()
            candidates = [*view["studies"], *(row["implementation"] for row in view["lessons"]
                                             if row["implementation"] is not None)]
            study = next((row for row in candidates if row["slug"] == slug), None)
            if study is None:
                return error(404, "Unknown study")
            if study["alive"] or study["archived"]:
                return error(409, "Study is alive or archived")
            argv.append(slug)
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
