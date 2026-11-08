"""Read study conversations, reflection lessons, batch reviews and pending material.

The board never imports the worker: the state fields used for signals mirror
src/teamster/task_state.py, review_cycle.py, supervisor.py and result_schema.py.
"""

import json
import re
import threading
import time
from pathlib import Path

from .store import Store, alive, number, objects, text


STAMP = re.compile(r"[0-9]{8}T[0-9]{6}Z")
RECORD = re.compile(r"(.+)-([0-9]{8}T[0-9]{6}Z)")
BATCH = re.compile(r"batch-([0-9]{4}-[0-9]{2}-[0-9]{2})?.*\.md", re.S)
SEPARATOR = re.compile(r":?-+:?")
STATUSES = ("proposed", "accepted", "applied", "declined")
SIGNALS = ("blocked", "refused", "needs_decision", "escalate", "round_cap",
           "fix_rounds", "check_failed", "ci_repair", "budget_exhausted")
BATCH_LIMIT = 64 * 1024
PENDING_ITEMS = 50
STUDY_LIMIT = 20
STUDY_SECONDS = 30 * 24 * 3600


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
            lessons.append({"id": lesson_id, "cue": cue, "entry": f"{file} {lesson_id}"})
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


class Research:
    def __init__(self, tasks_path, reflection_task="codex-batch-reflection", seconds=30):
        self.tasks_path = Path(tasks_path)
        self.reflection_task = reflection_task
        self.seconds = seconds
        self.lock = threading.Lock()
        self._index = (None, [])
        self._batches = {}
        self._records = {}
        self._messages = {}
        self._view = None
        self._next_scan = 0.0

    def view(self):
        with self.lock:
            now = time.monotonic()
            if self._view is None or now >= self._next_scan:
                self._view = self._scan()
                self._next_scan = now + self.seconds
            return self._view

    def _empty(self):
        return {"lessons": [], "batch": None,
                "pending": {"records": 0, "signals": 0, "repos": {}, "items": []},
                "studies": [], "reflection_task": self.reflection_task}

    def _scan(self):
        archive = self.tasks_path / ".archive"
        if self.tasks_path.is_symlink():
            return self._empty()
        try:
            names = [] if archive.is_symlink() else sorted(path.name for path in archive.iterdir())
        except OSError:
            names = []
        view = self._empty()
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
        for directory in Store._directories(self.tasks_path):
            wanted.add(directory)
            state = self._record(directory)
            if state is not None and state.get("kind") == "reflect":
                study_paths.add(directory)
                view["studies"].append(self._study(directory, directory.name, state, archived=False))
        self._records = {path: value for path, value in self._records.items() if path in wanted}
        self._messages = {path: value for path, value in self._messages.items() if path in study_paths}
        view["studies"] = sorted(view["studies"],
                                 key=lambda study: (study["created"], study["updated_at"], study["slug"]),
                                 reverse=True)[:STUDY_LIMIT]
        return view

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
        return self._index[1]

    def _batch_files(self, archive, names):
        found = []
        present = set()
        for name in names:
            if BATCH.fullmatch(name) is None:
                continue
            path = Store._file(archive, name)
            if path is None:
                continue
            try:
                current = signature(path)
                cached = self._batches.get(name)
                if cached is None or cached[0] != current:
                    with path.open("rb") as stream:
                        content = stream.read(BATCH_LIMIT).decode("utf-8", "replace")
                    cached = (current, batch_through(content))
                    self._batches[name] = cached
            except OSError:
                continue
            present.add(name)
            found.append((name, cached[1]))
        self._batches = {name: value for name, value in self._batches.items() if name in present}
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
