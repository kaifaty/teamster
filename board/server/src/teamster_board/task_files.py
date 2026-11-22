"""Read Board task files and expose the values shared by record readers."""

import json
import math
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path

from .activity import TAIL_BYTES


# A larger queue.json reads as an empty queue.
QUEUE_BYTES = 1024 * 1024
# An archived record's folder ends in its archive time; the journal knows the task by the slug before it.
ARCHIVED = re.compile(r"(.+)-([0-9]{8}T[0-9]{6}Z)")


def number(value):
    try:
        return float(value) if type(value) in (int, float) and math.isfinite(value) else None
    except OverflowError:
        return None


def text(value):
    return value if isinstance(value, str) and value else None


def one_line(value):
    return " ".join(str(value).split())[:200]


def objects(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def line(value):
    """A nonempty task string as one line of at most 200 characters, else None."""
    return one_line(value) or None if isinstance(value, str) else None


def lines(value):
    return [item for item in map(line, value) if item] if isinstance(value, list) else []


def alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, OverflowError):
        return False
    except PermissionError:
        return True
    return True


@dataclass
class Record:
    path: Path
    archived: bool
    state: dict = field(default_factory=dict)
    signature: tuple | None = None
    updated_at: float = 0
    summary: dict = field(default_factory=dict)
    tails: dict = field(default_factory=dict)
    activity: dict | None = None
    observed_phase: str | None = None
    phase_started_at: float | None = None


def task_file(directory, name, *, strict=False):
    path = directory / name
    try:
        if not directory.is_symlink() and stat.S_ISREG(path.lstat().st_mode):
            return path
    except FileNotFoundError:
        pass
    except OSError:
        if strict:
            raise
    return None


def directories(root, *, strict=False):
    if root.is_symlink():
        if strict:
            raise OSError(f"Task directory is a symlink: {root}")
        return []
    try:
        if strict:
            return [path for path in root.iterdir()
                    if not path.name.startswith(".") and not path.is_symlink() and path.is_dir()]
        with os.scandir(root) as entries:
            return [Path(entry.path) for entry in entries
                    if not entry.name.startswith(".") and entry.is_dir(follow_symlinks=False)]
    except FileNotFoundError:
        return []
    except OSError:
        if strict:
            raise
        return []


def task_paths(tasks_path, *, strict=False, older_archives=None):
    paths = [(path, False) for path in directories(tasks_path, strict=strict)]
    archived = []
    if not tasks_path.is_symlink():
        for path in directories(tasks_path / ".archive", strict=strict):
            try:
                if strict:
                    state = task_file(path, "state.json", strict=True)
                    if state is None:
                        continue
                    metadata = state.stat()
                else:
                    metadata = (path / "state.json").lstat()
                    if not stat.S_ISREG(metadata.st_mode):
                        continue
            except FileNotFoundError:
                continue
            except OSError:
                if strict:
                    raise
                continue
            archived.append((metadata.st_mtime_ns, path.name, path, metadata.st_size))
    archived.sort(reverse=True)
    paths.extend((path, True) for _, _, path, _ in archived[:50])
    if older_archives is not None:
        # Keep addresses from this directory scan. Only explicitly linked older states need to be opened.
        older_archives.clear()
        for mtime, name, _, size in archived[50:]:
            match = ARCHIVED.fullmatch(name)
            if match:
                older_archives.setdefault(match[1], {})[name] = (mtime, size)
    return paths


def read_state(record, *, strict=False):
    state_path = task_file(record.path, "state.json", strict=strict)
    if state_path is not None:
        try:
            stat = state_path.stat()
            signature = (stat.st_mtime_ns, stat.st_size)
            if signature != record.signature:
                state = json.loads(state_path.read_text(encoding="utf-8"))
                if isinstance(state, dict):
                    record.state = state
                    record.signature = signature
                    record.updated_at = stat.st_mtime
        except (FileNotFoundError, ValueError):
            pass
        except OSError:
            if strict:
                raise


def safe_slug(value):
    return (isinstance(value, str) and bool(value) and not value.startswith(".")
            and Path(value).name == value and "\\" not in value and "\0" not in value)


def source_file(root, path):
    # Check every component inside the configured source, including its root.
    if not path.is_relative_to(root):
        return None
    current = path
    while True:
        if current.is_symlink():
            return None
        if current == root:
            break
        current = current.parent
    try:
        return path if path.is_file() else None
    except OSError:
        return None


def task_messages(path):
    messages = []
    if path is None:
        return messages
    try:
        with path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            start = max(0, stream.tell() - TAIL_BYTES)
            stream.seek(start)
            rows = stream.read(TAIL_BYTES).decode("utf-8", errors="replace").split("\n")
            if start:
                rows = rows[1:]
            for raw in rows:
                try:
                    row = json.loads(raw)
                except (ValueError, RecursionError):
                    continue
                if not isinstance(row, dict):
                    continue
                at = number(row.get("at"))
                message = row.get("text")
                if at is not None and isinstance(message, str):
                    source = row.get("source")
                    messages.append({"at": at, "source": source if source in ("review", "ci") else "lead",
                                     "text": message[:4000], "queued_at": number(row.get("queued_at"))})
    except OSError:
        pass
    return sorted(messages, key=lambda item: item["at"])[-50:]


def task_queue(path):
    """The say --queue orders from queue.json: waiting ones and dropped ones with their outcome, options left out."""
    queue = {"waiting": [], "dropped": []}
    if path is None:
        return queue
    try:
        with path.open("rb") as stream:
            data = json.loads(stream.read(QUEUE_BYTES + 1)[:QUEUE_BYTES].decode("utf-8", errors="replace"))
    except (OSError, ValueError, RecursionError):
        return queue
    if not isinstance(data, dict):
        return queue
    for section in ("waiting", "dropped"):
        for row in objects(data.get(section)):
            at, message = number(row.get("at")), row.get("text")
            if at is None or not isinstance(message, str):
                continue
            order = {"at": at, "text": message[:4000]}
            if section == "dropped":
                order.update(dropped_at=number(row.get("dropped_at")), outcome=line(row.get("outcome")))
            queue[section].append(order)
        queue[section] = queue[section][-50:]
    return queue
