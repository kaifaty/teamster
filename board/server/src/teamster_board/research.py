"""Read study conversations, reflection lessons, batch reviews and pending material.

The board never imports the worker: the state fields used for signals mirror
src/teamster/task_state.py, review_cycle.py, supervisor.py and result_schema.py.
"""

import configparser
import json
import re
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import access
from .store import Record, Store, alive, cargo, number, objects, text


STAMP = re.compile(r"[0-9]{8}T[0-9]{6}Z")
RECORD = re.compile(r"(.+)-([0-9]{8}T[0-9]{6}Z)")
BATCH = re.compile(r"batch-([0-9]{4}-[0-9]{2}-[0-9]{2})?.*\.md", re.S)
ARCHIVE_FILE = re.compile(r"(?:batch|study)-[^/\\]+\.md")
IMPLEMENTATION = re.compile(r"^Внедрить урок «([^»]+)»")
LESSON_FIELDS = ("title", "lesson", "proposal", "evidence", "caveats")
SEPARATOR = re.compile(r":?-+:?")
STATUSES = ("proposed", "accepted", "applied", "declined")
SIGNALS = ("blocked", "refused", "needs_decision", "escalate", "round_cap",
           "fix_rounds", "check_failed", "ci_repair", "budget_exhausted")
BATCH_LIMIT = 64 * 1024
PENDING_ITEMS = 50
STUDY_LIMIT = 20
STUDY_SECONDS = 30 * 24 * 3600
SCHEDULE_LIMIT = 1024 * 1024
GIT_LIMIT = 64 * 1024


def git_file(directory, name):
    path = Store._file(directory, name)
    if path is None or path.stat().st_size > GIT_LIMIT:
        return None
    with path.open("rb") as stream:
        content = stream.read(GIT_LIMIT + 1)
    return content.decode("utf-8") if len(content) <= GIT_LIMIT else None


def repository(repo):
    """Resolve a worktree to its main repository, requiring a local origin URL."""
    try:
        path = Path(repo).resolve()
        git = path / ".git"
        if git.is_symlink() or not path.is_dir():
            return None
        if not git.is_dir():
            content = git_file(path, ".git")
            if content is None or not content.startswith("gitdir:"):
                return None
            target = content[len("gitdir:"):].strip()
            if not target:
                return None
            gitdir = path / target
            if gitdir.is_symlink() or not gitdir.is_dir():
                return None
            gitdir = gitdir.resolve()
            common = gitdir / "commondir"
            if common.exists() or common.is_symlink():
                target = git_file(gitdir, "commondir")
                if target is None or not target.strip():
                    return None
                git = gitdir / target.strip()
                if git.is_symlink():
                    return None
                git = git.resolve()
            elif gitdir.parent.name == "worktrees" and gitdir.parent.parent.name == ".git":
                git = gitdir.parent.parent
            else:
                return None
            path = git.parent
        content = git_file(git, "config")
        if content is None:
            return None
        config = configparser.ConfigParser(interpolation=None, strict=False, allow_no_value=True,
                                           delimiters=("=",))
        config.read_string(content)
        url = config.get('remote "origin"', "url", fallback=None)
        return path if url and url.strip().strip('"') else None
    except (OSError, ValueError, RuntimeError, configparser.Error):
        return None


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def signature(path):
    metadata = path.stat()
    return metadata.st_mtime_ns, metadata.st_size


def load_messages(path):
    messages = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            row = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(row, dict) or row.get("source") != "lead":
            continue
        at, message = number(row.get("at")), text(row.get("text"))
        if at is not None and message is not None:
            messages.append({"at": at, "from": "lead", "text": message[:4000],
                             "status": None, "questions": [], "lessons": [], "file": None})
    return messages


def analyst_message(turn):
    at = number(turn.get("at"))
    if at is None:
        return None
    options = _list(turn, "options")
    questions = []
    for index, question in enumerate(_list(turn, "questions")):
        question = text(question)
        if question is not None:
            choices = options[index] if index < len(options) and isinstance(options[index], list) else []
            questions.append({"text": question, "options": [choice for choice in map(text, choices) if choice]})
    file = text(turn.get("file"))
    lessons = []
    for lesson in objects(turn.get("lessons")):
        lesson_id, cue = text(lesson.get("id")), text(lesson.get("cue"))
        if lesson_id is not None and cue is not None and file is not None:
            scope = lesson.get("scope")
            lessons.append({"id": lesson_id, "cue": cue, "entry": f"{file} {lesson_id}",
                            "scope": scope if scope in ("invariant", "domain") else None,
                            "lesson": lesson["lesson"][:600] if isinstance(lesson.get("lesson"), str) else None,
                            "proposal": lesson["proposal"][:600] if isinstance(lesson.get("proposal"), str) else None})
    status = turn.get("status")
    return {"at": at, "from": "analyst", "text": text(turn.get("summary")),
            "status": status if status in ("done", "needs_decision") else None,
            "questions": questions, "lessons": lessons, "file": file}


def _list(state, key):
    value = state.get(key)
    return value if isinstance(value, list) else []


def signals(state):
    """The signals from reflection.md's When section, in the Signal type's order."""
    result = state.get("result")
    status = result.get("status") if isinstance(result, dict) else None
    stop = state.get("auto_fix_stop")
    stop = stop if isinstance(stop, str) else ""
    ci = state.get("ci")
    ci_rounds = ci.get("rounds") if isinstance(ci, dict) else None
    found = set()
    if status in ("blocked", "needs_decision"):
        found.add(status)
    # The result schema has no refused status; a refusal is the turn outcome.
    if status == "refused" or state.get("outcome") == "refused":
        found.add("refused")
    if stop == "escalate":
        found.add("escalate")
    # auto_fix stops at the round cap with "rounds_exhausted", "check <outcome>" while a check fails,
    # or "base conflict" while the base branch still conflicts.
    if stop in ("rounds_exhausted", "base conflict") or stop.startswith("check "):
        found.add("round_cap")
    if len(_list(state, "rounds")) >= 2:
        found.add("fix_rounds")
    if any(isinstance(check, dict) and type(check.get("exit")) is int and check["exit"] != 0
           for check in _list(state, "checks")):
        found.add("check_failed")
    if type(ci_rounds) is int and ci_rounds > 0:
        found.add("ci_repair")
    if state.get("outcome") == "budget_exhausted" or any(
            isinstance(entry, dict) and entry.get("outcome") == "budget_exhausted"
            for entry in _list(state, "turn_stops")):
        found.add("budget_exhausted")
    return [name for name in SIGNALS if name in found]


def parse_index(content):
    lines = content.splitlines()
    lessons = []
    for number, line in enumerate(lines):
        raw = table_cells(line)
        if raw is None:
            continue
        cells = [cell.strip() for cell in raw]
        if all(SEPARATOR.fullmatch(cell) for cell in cells):
            continue
        following = table_cells(lines[number + 1]) if number + 1 < len(lines) else None
        if following and all(SEPARATOR.fullmatch(cell.strip()) for cell in following):
            continue  # The header row.
        if len(cells) < 5 or not any(cells):
            continue
        date, entry, scope_text, cue = cells[:4]
        status_text = "|".join(raw[4:]).strip()
        scope_words = re.split(r"[\s,]+", scope_text.replace("`", " ").strip())
        scope = scope_words[0].lower().rstrip(":") if scope_words else ""
        status_word = re.match(r"[A-Za-z_]*", status_text.lstrip("`*_")).group().lower()
        lessons.append({
            "date": date, "entry": entry,
            "scope": scope if scope in ("invariant", "domain") else "other",
            "scope_text": scope_text,
            "repos": [word for word in scope_words[1:] if word] if scope == "domain" else [],
            "cue": cue,
            "status": status_word if status_word in STATUSES else "other",
            "status_text": status_text,
        })
    return lessons


def table_cells(line):
    line = line.strip()
    if not line.startswith("|"):
        return None
    line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return line.split("|")


def batch_through(content):
    for line in content.splitlines():
        _, marker, rest = line.partition("through:")
        if marker:
            stamp = STAMP.search(rest)
            return stamp.group() if stamp else None
    return None


def lesson_section(content, lesson_id):
    result = dict.fromkeys(LESSON_FIELDS)
    level = None
    field = None
    values = {}
    for line in content.splitlines():
        heading = re.match(r"^(#{1,6})[ \t]+(.*)$", line)
        if level is None:
            if heading is not None and 2 <= len(heading[1]) <= 4:
                title = re.match(re.escape(lesson_id) + r"(?:\.[ \t]*|[ \t]+)(.*)$", heading[2])
                if title is not None:
                    level = len(heading[1])
                    result["title"] = title[1].strip() or None
            continue
        if heading is not None and len(heading[1]) <= level:
            break
        marker = re.match(r"^(cue|lesson|evidence|scope|earlier|caveats|proposal):(.*)$", line)
        if marker is not None:
            field = marker[1]
            values[field] = [marker[2]]
        elif field is not None:
            values[field].append(line)
    for name in LESSON_FIELDS[1:]:
        result[name] = "\n".join(values.get(name, [])).strip()[:2000] or None
    return result


def schedule_timestamp(value):
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.timestamp() if parsed.tzinfo is not None else None
        except (ValueError, OverflowError, OSError):
            pass
    return None


def reflection_schedule(row):
    cron, enabled = row.get("cronExpression"), row.get("enabled")
    if not isinstance(cron, str) or type(enabled) is not bool:
        return None
    name = row.get("displayName")
    return {"source": "desktop", "name": name if isinstance(name, str) else None,
            "cron": cron.strip(), "enabled": enabled,
            "last_run_at": schedule_timestamp(row.get("lastRunAt")),
            "last_scheduled_for": schedule_timestamp(row.get("lastScheduledFor"))}


def cron_field(value, low, high):
    result = set()
    for part in value.split(","):
        match = re.fullmatch(r"(\*|[0-9]+(?:-[0-9]+)?)(?:/([0-9]+))?", part)
        if match is None:
            raise ValueError("Invalid cron field")
        span, step = match.groups()
        if step is not None and span != "*" and "-" not in span:
            raise ValueError("Cron steps require a wildcard or range")
        step = int(step) if step is not None else 1
        if span == "*":
            start, end = low, high
        else:
            bounds = span.split("-")
            start, end = int(bounds[0]), int(bounds[-1])
        if not low <= start <= end <= high or step < 1:
            raise ValueError("Cron field out of range")
        result.update(range(start, end + 1, step))
    return sorted(result)


def next_cron(cron, now):
    fields = cron.split()
    if len(fields) != 5:
        return None
    try:
        minutes, hours, days, months, weekdays = [
            cron_field(value, low, high)
            for value, (low, high) in zip(fields, ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7)))
        ]
    except ValueError:
        return None
    weekdays = {day % 7 for day in weekdays}
    # Vixie cron uses AND when either day field starts with a wildcard, otherwise OR.
    wildcard_day = fields[2].startswith("*") or fields[4].startswith("*")
    deadline = now + 366 * 24 * 3600
    day = datetime.fromtimestamp(now).date()
    last_day = datetime.fromtimestamp(deadline).date()
    while day <= last_day:
        dom, dow = day.day in days, (day.weekday() + 1) % 7 in weekdays
        matches_day = dom and dow if wildcard_day else dom or dow
        if day.month in months and matches_day:
            nearest = None
            for hour in hours:
                for minute in minutes:
                    local = (day.year, day.month, day.day, hour, minute, 0)
                    # Round trips reject DST gaps; both folds can contain the next instant.
                    for is_dst in (-1, 0, 1):
                        at = time.mktime((*local, 0, 0, is_dst))
                        if (now < at <= deadline and time.localtime(at)[:6] == local
                                and (nearest is None or at < nearest)):
                            nearest = at
            if nearest is not None:
                return nearest
        day += timedelta(days=1)
    return None


class Research:
    def __init__(self, tasks_path, reflection_task="codex-batch-reflection", seconds=30,
                 claude_desktop_dir=None):
        self.tasks_path = Path(tasks_path)
        self.claude_desktop_dir = Path(claude_desktop_dir) if claude_desktop_dir is not None else None
        self.reflection_task = reflection_task
        self.seconds = seconds
        self.lock = threading.Lock()
        self._index = (None, [])
        self._batches = {}
        self._records = {}
        self._messages = {}
        self._schedules = {}
        self._view = None
        self._next_scan = 0.0
        self._repo_paths = set()
        self._repos = []
        self._repos_access = "scanning"
        self._repos_thread = None
        self._next_repos_scan = 0.0
        self._store = Store(self.tasks_path)

    def view(self):
        with self.lock:
            now = time.monotonic()
            if self._view is None or now >= self._next_scan:
                self._view = self._scan()
                self._next_scan = time.monotonic() + self.seconds
            if (now >= self._next_repos_scan
                    and (self._repos_thread is None or not self._repos_thread.is_alive())):
                self._repos_thread = threading.Thread(target=self._find_repos,
                                                      args=(self._repo_paths,), daemon=True)
                self._repos_thread.start()
            self._view.update(repos=self._repos, repos_access=self._repos_access)
            return self._view

    def invalidate(self):
        with self.lock:
            self._view = None

    def _empty(self):
        return {"lessons": [], "repos": [], "batch": None,
                "pending": {"records": 0, "signals": 0, "repos": {}, "items": []},
                "studies": [], "reflection_task": self.reflection_task, "schedule": None}

    def _scan(self):
        view = self._empty()
        self._repo_paths = set()
        view["schedule"] = self._schedule()
        archive = self.tasks_path / ".archive"
        if self.tasks_path.is_symlink():
            return view
        try:
            names = [] if archive.is_symlink() else sorted(path.name for path in archive.iterdir())
        except OSError:
            names = []
        self._batches = {name: value for name, value in self._batches.items() if name in names}
        view["lessons"] = self._lessons(archive)
        batches = sorted(self._batch_files(archive, names), key=lambda item: (item[1] or "", item[0]))
        records = [(match.group(1), match.group(2), name)
                   for name in names if not name.startswith(".") and (match := RECORD.fullmatch(name))]
        through = previous = None
        if batches:
            name, through = batches[-1]
            previous = batches[-2][1] if len(batches) > 1 else None
            date = BATCH.fullmatch(name).group(1)
            view["batch"] = {"name": name, "date": date, "through": through, "records": 0, "repos": {}}
        floor = previous if through is not None else None
        cutoff = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(time.time() - STUDY_SECONDS))
        wanted = set()
        study_paths = set()
        pending = view["pending"]
        items = []
        for slug, stamp, name in records:
            material = floor is None or stamp > floor
            recent = stamp >= cutoff
            if not material and not recent:
                continue
            directory = archive / name
            wanted.add(directory)
            state = self._record(directory)
            if state is None:
                continue
            if state.get("kind") == "reflect":
                if recent:
                    study_paths.add(directory)
                    view["studies"].append(self._study(directory, slug, state, archived=True))
                continue
            if not material:
                continue
            repo = text(state.get("repo"))
            repo = Path(repo).name or "(unknown)" if repo else "(unknown)"
            found = signals(state)
            if through is not None and stamp <= through:
                view["batch"]["records"] += 1
                view["batch"]["repos"][repo] = view["batch"]["repos"].get(repo, 0) + 1
                continue
            pending["records"] += 1
            if found:
                pending["signals"] += 1
                pending["repos"][repo] = pending["repos"].get(repo, 0) + 1
                items.append({"slug": slug, "repo": repo, "stamp": stamp, "signals": found})
        pending["items"] = sorted(items, key=lambda item: (item["stamp"], item["slug"]),
                                  reverse=True)[:PENDING_ITEMS]
        repo_paths = set()
        implementations = {}
        directories = [(path, False) for path in Store._directories(self.tasks_path)]
        directories.extend((path, True) for path in Store._directories(archive))
        for directory, archived in directories:
            wanted.add(directory)
            state = self._record(directory)
            if state is None:
                continue
            if state.get("kind") not in ("scout", "reflect"):
                repo = text(state.get("repo"))
                if repo:
                    repo_paths.add(repo)
            match = RECORD.fullmatch(directory.name) if archived else None
            slug = match[1] if match else directory.name
            implementation = self._implementation(directory, slug, state, archived)
            if implementation is not None:
                entry, value = implementation
                if entry not in implementations or value["created"] > implementations[entry]["created"]:
                    implementations[entry] = value
            if not archived and state.get("kind") == "reflect":
                study_paths.add(directory)
                view["studies"].append(self._study(directory, directory.name, state, archived=False))
        self._repo_paths = repo_paths
        for lesson in view["lessons"]:
            lesson["implementation"] = implementations.get(lesson["entry"])
        self._records = {path: value for path, value in self._records.items() if path in wanted}
        self._messages = {path: value for path, value in self._messages.items() if path in study_paths}
        view["studies"] = sorted(view["studies"],
                                 key=lambda study: (study["created"], study["updated_at"], study["slug"]),
                                 reverse=True)[:STUDY_LIMIT]
        return view

    def _find_repos(self, repo_paths):
        repos = set()
        denied = False
        for repo in repo_paths:
            try:
                git = Path(repo) / ".git"
                try:
                    git.stat()
                except FileNotFoundError:
                    continue
                except OSError:
                    pass
                if access.readable(git) is not True:
                    denied = True
                    continue
                path = repository(repo)
                if path is not None and path != (self.tasks_path / ".archive").resolve():
                    repos.add(path)
            except (OSError, ValueError, RuntimeError):
                continue
        found = sorted(({"name": path.name, "path": str(path)} for path in repos),
                       key=lambda repo: (repo["name"], repo["path"]))[:100]
        with self.lock:
            self._repos = found
            self._repos_access = "denied" if denied else "ok"
            self._next_repos_scan = time.monotonic() + self.seconds

    def _implementation(self, directory, slug, state, archived):
        if not slug.startswith("lesson-"):
            return None
        brief = Store._file(directory, "brief.md")
        if brief is None:
            return None
        try:
            with brief.open(encoding="utf-8", errors="replace") as stream:
                match = IMPLEMENTATION.match(stream.readline())
        except OSError:
            return None
        if match is None:
            return None
        updated_at = self._records[directory][0][0] / 1_000_000_000
        record = Record(directory, archived, state, updated_at=updated_at)
        summary = self._store._summary(slug, record)
        value = {key: summary[key] for key in (
            "slug", "alive", "repo", "result_status", "pr", "summary", "updated_at",
        )}
        value.update(archived=archived, questions=cargo(state)["questions"],
                     created=summary["created"] if summary["created"] is not None else updated_at)
        return match[1].strip(), value

    def _schedule(self):
        root = self.claude_desktop_dir
        if root is None or root.is_symlink():
            self._schedules.clear()
            return None
        found = []
        present = set()
        for account in Store._directories(root / "claude-code-sessions"):
            for directory in Store._directories(account):
                path = Store._file(directory, "scheduled-tasks.json")
                if path is None:
                    continue
                try:
                    current = signature(path)
                except OSError:
                    continue
                present.add(path)
                cached = self._schedules.get(path)
                if cached is None or cached[0] != current:
                    values = []
                    if current[1] <= SCHEDULE_LIMIT:
                        try:
                            raw = load_json(path)
                            if isinstance(raw, dict):
                                values = [schedule for row in objects(raw.get("scheduledTasks"))
                                          if row.get("id") == self.reflection_task
                                          and (schedule := reflection_schedule(row)) is not None]
                        except (OSError, ValueError, RecursionError):
                            pass
                    cached = (current, values)
                    self._schedules[path] = cached
                found.extend(cached[1])
        self._schedules = {path: value for path, value in self._schedules.items() if path in present}
        if not found:
            return None
        schedule = max(found, key=lambda row: (row["last_run_at"] if row["last_run_at"] is not None
                                              else float("-inf"), row["enabled"]))
        return {**schedule, "next_at": next_cron(schedule["cron"], time.time()) if schedule["enabled"] else None}

    def _lessons(self, archive):
        path = Store._file(archive, "INDEX.md")
        if path is None:
            return []
        try:
            current = signature(path)
            if current != self._index[0]:
                self._index = (current, parse_index(path.read_text(encoding="utf-8", errors="replace")))
        except OSError:
            return []
        lessons = []
        for row in self._index[1]:
            parts = row["entry"].split()
            fields = dict.fromkeys(LESSON_FIELDS)
            if len(parts) == 2 and ARCHIVE_FILE.fullmatch(parts[0]):
                content = self._archive_file(archive, parts[0])
                if content is not None:
                    fields = lesson_section(content, parts[1])
            lessons.append({**row, **fields})
        return lessons

    def _archive_file(self, archive, name):
        path = Store._file(archive, name)
        if path is None:
            return None
        try:
            current = signature(path)
            cached = self._batches.get(name)
            if cached is None or cached[0] != current:
                with path.open("rb") as stream:
                    content = stream.read(BATCH_LIMIT).decode("utf-8", "replace")
                cached = (current, content)
                self._batches[name] = cached
            return cached[1]
        except OSError:
            return None

    def _batch_files(self, archive, names):
        found = []
        for name in names:
            if BATCH.fullmatch(name) is None:
                continue
            content = self._archive_file(archive, name)
            if content is not None:
                found.append((name, batch_through(content)))
        return found

    def _record(self, directory):
        """A task's state, read again only when state.json's mtime or size changes."""
        if directory.is_symlink() or not directory.is_dir():
            self._records.pop(directory, None)
            return None
        path = Store._file(directory, "state.json")
        if path is None:
            self._records.pop(directory, None)
            return None
        try:
            current = signature(path)
        except OSError:
            return None
        cached = self._records.get(directory)
        if cached is not None and cached[0] == current:
            return cached[1]
        try:
            state = load_json(path)
        except (OSError, ValueError):
            state = None
        value = state if isinstance(state, dict) else None
        self._records[directory] = (current, value)
        return value

    def _study(self, directory, slug, state, archived):
        updated_at = self._records[directory][0][0] / 1_000_000_000
        created = number(state.get("created"))
        if created is None:
            created = updated_at
        messages = []
        path = Store._file(directory, "messages.jsonl")
        if path is not None:
            try:
                current = signature(path)
                cached = self._messages.get(directory)
                if cached is None or cached[0] != current:
                    cached = (current, load_messages(path))
                    self._messages[directory] = cached
                updated_at = max(updated_at, current[0] / 1_000_000_000)
                messages.extend(cached[1])
            except OSError:
                pass
        else:
            self._messages.pop(directory, None)
        messages.extend(message for turn in objects(state.get("reflect_turns"))
                        if (message := analyst_message(turn)) is not None)
        order = text(state.get("reflect_order"))
        messages = [{"at": created, "from": "lead", "text": order[:4000] if order else None,
                     "status": None, "questions": [], "lessons": [], "file": None},
                    *sorted(messages, key=lambda message: message["at"])]
        is_alive = alive(state.get("pid"))
        executor = text(state.get("executor")) or "codex"
        error = text(state.get("error"))
        return {"slug": slug, "archived": archived,
                "mode": "study" if state.get("reflect_mode") == "study" else "batch",
                "alive": is_alive, "outcome": text(state.get("outcome")),
                "error": error[:300] if error else None,
                "executor": executor,
                "account": text(state.get("claude_account") if executor == "claude" else state.get("account")),
                "created": created, "updated_at": updated_at,
                "records": len(_list(state, "reflect_records")), "file": text(state.get("reflect_file")),
                "waiting": not is_alive and messages[-1]["from"] == "analyst"
                and messages[-1]["status"] == "needs_decision",
                "messages": messages}
