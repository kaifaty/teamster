"""Read reflection lessons, the newest batch review and the records waiting for the next one.

The board never imports the worker: the state fields used for signals mirror
src/teamster/task_state.py, review_cycle.py, supervisor.py and result_schema.py.
"""

import json
import re
import threading
import time
from pathlib import Path

from .store import Store


STAMP = re.compile(r"[0-9]{8}T[0-9]{6}Z")
RECORD = re.compile(r"(.+)-([0-9]{8}T[0-9]{6}Z)")
BATCH = re.compile(r"batch-([0-9]{4}-[0-9]{2}-[0-9]{2})?.*\.md", re.S)
SEPARATOR = re.compile(r":?-+:?")
STATUSES = ("proposed", "applied", "declined")
SIGNALS = ("blocked", "refused", "needs_decision", "escalate", "round_cap",
           "fix_rounds", "check_failed", "ci_repair", "budget_exhausted")
BATCH_LIMIT = 64 * 1024
PENDING_ITEMS = 50


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def signature(path):
    metadata = path.stat()
    return metadata.st_mtime_ns, metadata.st_size


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
                "reflection_task": self.reflection_task}

    def _scan(self):
        archive = self.tasks_path / ".archive"
        if self.tasks_path.is_symlink() or archive.is_symlink():
            return self._empty()
        try:
            names = sorted(path.name for path in archive.iterdir())
        except OSError:
            return self._empty()
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
        wanted = {name for _, stamp, name in records if floor is None or stamp > floor}
        self._records = {name: value for name, value in self._records.items() if name in wanted}
        pending = view["pending"]
        items = []
        for slug, stamp, name in records:
            if name not in wanted:
                continue
            record = self._record(archive / name)
            if record is None:
                continue
            repo, found = record
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
        """(repo, signals) for an archived record, read again only when state.json changes."""
        name = directory.name
        if directory.is_symlink() or not directory.is_dir():
            self._records.pop(name, None)
            return None
        path = Store._file(directory, "state.json")
        if path is None:
            self._records.pop(name, None)
            return None
        try:
            current = signature(path)
        except OSError:
            return None
        cached = self._records.get(name)
        if cached is not None and cached[0] == current:
            return cached[1]
        try:
            state = load_json(path)
        except (OSError, ValueError):
            state = None
        value = None
        if isinstance(state, dict):
            repo = state.get("repo")
            value = (Path(repo).name or "(unknown)" if isinstance(repo, str) and repo else "(unknown)",
                     signals(state))
        self._records[name] = (current, value)
        return value
