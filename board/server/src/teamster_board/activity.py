"""Read the latest activity from bounded, incremental executor JSONL tails."""

import base64
import json
import math
import os
import stat
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path


TAIL_BYTES = 256 * 1024


def _line(value: str) -> str:
    return " ".join(value.split())[:200]


def _timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return float(value) if math.isfinite(value) else None
        except OverflowError:
            return None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.timestamp() if parsed.tzinfo is not None else None
        except (ValueError, OverflowError):
            pass
    return None


def _relative_path(value, worktree):
    if (not isinstance(value, str) or not isinstance(worktree, str)
            or not os.path.isabs(value) or not os.path.isabs(worktree)):
        return value
    path, root = os.path.normpath(value), os.path.normpath(worktree)
    return os.path.relpath(path, root) if os.path.commonpath((path, root)) == root else value


def _contents(event, details=False, worktree=None):
    """Yield every recognized content block in executor order."""
    if not isinstance(event, dict):
        return
    if event.get("type") in ("item.started", "item.completed"):
        item = event.get("item")
        if not isinstance(item, dict):
            return
        item_type = item.get("type")
        if item_type == "command_execution":
            yield "command", item.get("command", "")
        elif item_type == "file_change":
            changes = item.get("changes")
            changes = changes if isinstance(changes, list) else []
            yield "edit", ", ".join(_relative_path(change["path"], worktree) for change in changes
                                   if isinstance(change, dict) and isinstance(change.get("path"), str))
        elif item_type in ("agent_message", "reasoning"):
            yield "message" if item_type == "agent_message" else "thinking", item.get("text", "")
        elif item_type == "collab_tool_call":
            yield "tool", " ".join(value for value in (item.get("tool"), item.get("prompt"))
                                    if isinstance(value, str))
    elif event.get("type") == "assistant":
        message = event.get("message")
        content = message.get("content", []) if isinstance(message, dict) else []
        if not isinstance(content, list):
            return
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "tool_use":
                name = block.get("name", "")
                inputs = block.get("input")
                inputs = inputs if isinstance(inputs, dict) else {}
                if name == "Bash":
                    yield "command", inputs.get("command", "")
                elif name in ("Edit", "Write"):
                    yield "edit", _relative_path(inputs.get("file_path", ""), worktree)
                else:
                    field = {"Read": "file_path", "Grep": "pattern", "Glob": "pattern",
                             "Agent": "description", "Task": "description"}.get(name) if isinstance(name, str) else None
                    detail = inputs.get(field) if details and field else None
                    if name == "Read":
                        detail = _relative_path(detail, worktree)
                    yield "tool", " ".join(value for value in (name, detail) if isinstance(value, str))
            elif block_type == "text":
                yield "message", block.get("text", "")
            elif block_type == "thinking":
                yield "thinking", block.get("thinking", "")


def _message(text):
    if isinstance(text, str):
        try:
            result = json.loads(text)
        except (ValueError, RecursionError):
            result = None
        if isinstance(result, dict) and isinstance(result.get("summary"), str):
            return result["summary"]
        return text
    return ""


def _activity(event):
    latest = None
    for kind, text in _contents(event):
        text = _message(text) if kind == "message" else text
        latest = {"at": _timestamp(event.get("timestamp", event.get("at"))), "kind": kind,
                  "text": _line(text if isinstance(text, str) else "")}
    return latest


def feed_items(event, worktree=None):
    """Preserve message paragraphs while bounding the content shown by the board."""
    if isinstance(event, dict) and event.get("type") in ("item.started", "item.completed"):
        item = event.get("item")
        if isinstance(item, dict):
            expected = "item.completed" if item.get("type") in ("agent_message", "reasoning") else "item.started"
            if event["type"] != expected:
                return []
    items = []
    for kind, text in _contents(event, details=True, worktree=worktree):
        text = _message(text) if kind == "message" else text
        if not isinstance(text, str):
            continue
        if kind in ("message", "thinking"):
            text = text.strip()
            if len(text) > 4000:
                text = text[:3999] + "…"
        else:
            limit = 200 if kind == "tool" else 500
            text = " ".join(text.split())[:limit]
        if text:
            items.append({"at": _timestamp(event.get("timestamp", event.get("at"))),
                          "kind": kind, "text": text})
    return items


FEED_FILES = ("events.jsonl", "claude-events.jsonl")
FEED_ITEMS = 400


def _cursor(after, slug):
    if after is None:
        return None
    try:
        if len(after) > 4096:
            return None
        value = json.loads(base64.urlsafe_b64decode(after.encode("ascii")))
        if not isinstance(value, dict):
            return None
        files = value["files"]
        if not isinstance(files, dict):
            return None
        if value["slug"] != slug or value["v"] != 1 or set(files) != set(FEED_FILES):
            return None
        for position in files.values():
            if position is None:
                continue
            if (not isinstance(position, dict) or set(position) != {"id", "size", "offset", "at", "mtime", "skipping"}
                    or not isinstance(position["id"], list) or len(position["id"]) != 2
                    or any(type(value) is not int or value < 0 for value in position["id"])
                    or type(position["size"]) is not int or type(position["offset"]) is not int
                    or not 0 <= position["offset"] <= position["size"]
                    or type(position["mtime"]) is not int or type(position["skipping"]) is not bool
                    or (position["at"] is not None
                        and (type(position["at"]) not in (int, float) or _timestamp(position["at"]) is None))):
                return None
        return files
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
        return None


def _feed_source(path, stack):
    if path is None:
        return None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        stream = stack.enter_context(os.fdopen(descriptor, "rb"))
        metadata = os.fstat(stream.fileno())
        return (stream, metadata) if stat.S_ISREG(metadata.st_mode) else None
    except OSError:
        return None


def _feed_position(source, position):
    """Validate both sources before either is consumed, so a reset never reads twice."""
    if position is None:
        return True
    if source is None:
        return False
    _, metadata = source
    return ([metadata.st_dev, metadata.st_ino] == position["id"]
            and metadata.st_size >= position["size"]
            and (metadata.st_size != position["size"] or metadata.st_mtime_ns == position["mtime"]))


def _feed_file(source, position, initial, worktree):
    """Wait for short partial lines; skip oversized ones across bounded reads."""
    if source is None:
        return [], None, False
    stream, metadata = source
    offset = 0 if position is None or initial else position["offset"]
    previous_at = None if position is None or initial else position["at"]
    skipping = False if position is None or initial else position["skipping"]
    truncated = initial and metadata.st_size > TAIL_BYTES
    if truncated:
        offset = metadata.st_size - TAIL_BYTES
    stream.seek(offset)
    chunk = stream.read(max(0, min(TAIL_BYTES, metadata.st_size - offset)))
    # The first byte is the boundary probe inside the bounded initial tail window.
    if truncated:
        offset += 1
        boundary, chunk = chunk[:1], chunk[1:]
        skipping = boundary != b"\n"
    if skipping:
        truncated = True
        end = chunk.find(b"\n")
        skipped = len(chunk) if end < 0 else end + 1
        offset += skipped
        chunk = chunk[skipped:]
        skipping = end < 0
    if len(chunk) == TAIL_BYTES and b"\n" not in chunk:
        offset += len(chunk)
        chunk = b""
        skipping = truncated = True
    complete = chunk.rfind(b"\n") + 1
    data = chunk[:complete]
    next_offset = offset + complete
    items = []
    for line in data.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError, RecursionError):
            continue
        for item in feed_items(event, worktree):
            if item["at"] is None:
                item["at"] = metadata.st_mtime if previous_at is None else previous_at
            previous_at = item["at"]
            items.append(item)
    state = {"id": [metadata.st_dev, metadata.st_ino], "size": metadata.st_size, "offset": next_offset,
             "at": previous_at, "mtime": metadata.st_mtime_ns, "skipping": skipping}
    return items, state, truncated


def task_feed(paths, slug, after=None, worktree=None):
    """Merge two bounded file tails with a self-contained cursor, without server state."""
    positions = _cursor(after, slug)
    reset = after is not None and positions is None
    initial = positions is None
    with ExitStack() as stack:
        sources = [_feed_source(paths.get(name), stack) for name in FEED_FILES]
        checks = [_feed_position(source, None if positions is None else positions[name])
                  for name, source in zip(FEED_FILES, sources)]
        if not initial and not all(checks):
            reset = initial = True
        results = [_feed_file(source, None if positions is None else positions[name], initial, worktree)
                   for name, source in zip(FEED_FILES, sources)]
    left, right = (result[0] for result in results)
    items = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i]["at"] <= right[j]["at"]:
            items.append(left[i])
            i += 1
        else:
            items.append(right[j])
            j += 1
    items.extend(left[i:])
    items.extend(right[j:])
    truncated = any(result[2] for result in results) or (initial and len(items) > FEED_ITEMS)
    if initial:
        items = items[-FEED_ITEMS:]
    value = {"v": 1, "slug": slug, "files": {name: result[1] for name, result in zip(FEED_FILES, results)}}
    cursor = base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode()
    return {"items": items, "cursor": cursor, "reset": reset, "truncated": truncated}


class EventTail:
    """Keep a byte cursor and ten activities; read at most 256 KiB after a reset or large append.

    An unterminated last line is retained until its newline arrives. A malformed
    complete line is discarded. Inode replacement and truncation reset the cursor.
    """

    def __init__(self, path: Path):
        self.path = path
        self.offset = 0
        self.signature = None
        self._pending = b""
        self.activities = []

    def read(self):
        try:
            metadata = self.path.lstat()
            signature = (metadata.st_dev, metadata.st_ino, metadata.st_mtime_ns, metadata.st_size)
            if not stat.S_ISREG(metadata.st_mode) or signature == self.signature:
                return None
            descriptor = os.open(self.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if not stat.S_ISREG(metadata.st_mode):
                    return None
                signature = (metadata.st_dev, metadata.st_ino, metadata.st_mtime_ns, metadata.st_size)
                reset = (self.signature is None or signature[:2] != self.signature[:2]
                         or metadata.st_size < self.offset
                         or (metadata.st_size == self.offset and signature[2] != self.signature[2]))
                if reset:
                    self.offset = 0
                    self._pending = b""
                skip_first = metadata.st_size - self.offset > TAIL_BYTES
                if skip_first:
                    self.offset = metadata.st_size - TAIL_BYTES
                    self._pending = b""
                stream.seek(self.offset)
                chunk = stream.read(TAIL_BYTES)
                self.offset = stream.tell()
                self.signature = signature
        except OSError:
            return None

        lines = (self._pending + chunk).split(b"\n")
        self._pending = lines.pop()
        if skip_first and lines:
            lines.pop(0)
        latest = None
        activities = []
        for line in lines:
            try:
                event = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            activity = _activity(event)
            if activity is not None:
                if activity["at"] is None:
                    activity["at"] = metadata.st_mtime
                latest = activity
                activities.append(activity)
        self.activities = sorted(self.activities + activities, key=lambda item: item["at"])[-10:]
        return latest
