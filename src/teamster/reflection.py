"""Batch reflection: archive records, the reading room and the recorded batch review."""
import fcntl
import json
import os
import re
import shutil
import stat
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

from . import clock, config, procs


RECORD_NAME = re.compile(r"(.+)-([0-9]{8}T[0-9]{6}Z)")
BATCH_NAME = re.compile(r"batch-([0-9]{4}-[0-9]{2}-[0-9]{2})?.*\.md", re.S)
THROUGH_STAMP = re.compile(r"[0-9]{8}T[0-9]{6}Z")
ROOM_FILE_LIMIT = 2 * 1024 * 1024
ROOM_FILE_TAIL = 256 * 1024
INDEX_HEADER = ("# Reflection index\n\n| date | entry | scope | cue | status |\n"
                "|---|---|---|---|---|\n")


def batch_names(archive):
    """Batch review files in the archive, regular files only."""
    if not archive.is_dir():
        return []
    return sorted(path.name for path in archive.iterdir()
                  if BATCH_NAME.fullmatch(path.name) and path.is_file() and not path.is_symlink())


def batch_through(path):
    with path.open("rb") as stream:
        content = stream.read(64 * 1024).decode("utf-8", "replace")
    for line in content.splitlines():
        _, marker, rest = line.partition("through:")
        if marker:
            stamp = THROUGH_STAMP.search(rest)
            return stamp.group() if stamp else None
    return None


def record_kind(directory):
    try:
        state = json.loads((directory / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return state.get("kind") if isinstance(state, dict) else None


def pending_records(archive):
    """Record names archived after the newest batch's through: stamp, oldest first, and their newest stamp."""
    if not archive.is_dir():
        return [], None
    stamps = [batch_through(archive / name) for name in batch_names(archive)]
    through = max((stamp for stamp in stamps if stamp), default=None)
    records = []
    for path in archive.iterdir():
        match = RECORD_NAME.fullmatch(path.name)
        if match is None or path.name.startswith(".") or path.is_symlink() or not path.is_dir():
            continue
        if through is not None and match.group(2) <= through:
            continue
        if record_kind(path) == "reflect":
            continue
        records.append((match.group(2), path.name))
    records.sort()
    return [name for _, name in records], (records[-1][0] if records else None)


def copy_room_file(source, target):
    size = source.stat().st_size
    if size <= ROOM_FILE_LIMIT:
        shutil.copyfile(source, target)
        return
    with source.open("rb") as stream:
        stream.seek(size - ROOM_FILE_TAIL)
        tail = stream.read(ROOM_FILE_TAIL)
    target.write_bytes(f"[truncated: last {ROOM_FILE_TAIL} of {size} bytes]\n".encode() + tail)


def build_room(room, archive, records):
    """Copy the index, batch reviews and the taken records into a new one-commit repository."""
    room.mkdir()
    for name in ["INDEX.md"] + batch_names(archive):
        source = archive / name
        if source.is_file() and not source.is_symlink():
            copy_room_file(source, room / name)
    for name in records:
        base = archive / name
        for directory, subdirectories, files in os.walk(base):
            subdirectories[:] = [entry for entry in subdirectories
                                 if not os.path.islink(os.path.join(directory, entry))]
            target = room / "records" / name / os.path.relpath(directory, base)
            for entry in files:
                source = Path(directory) / entry
                if not stat.S_ISREG(os.lstat(source).st_mode):
                    continue
                target.mkdir(parents=True, exist_ok=True)
                copy_room_file(source, target / entry)
    git = config.GIT + ["-c", "core.excludesFile=/dev/null", "-c", "commit.gpgsign=false",
                        "-c", "user.name=teamster", "-c", "user.email=teamster@localhost"]
    procs.sh(git + ["init", "-q"], cwd=room)
    procs.sh(git + ["add", "-A", "-f", "."], cwd=room)
    procs.sh(git + ["commit", "-q", "--allow-empty", "-m", "Reading room"], cwd=room)


@contextmanager
def index_lock(archive):
    with (archive / "INDEX.md.lock").open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def replace_archive_file(path, text):
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def index_cell(value):
    return re.sub(r"\r\n|\r|\n", " ", value).replace("|", "/").strip()


def index_row_cells(line):
    line = line.strip()
    if not line.startswith("|"):
        return None
    line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return line.split("|")


def update_index(archive, date, name, lessons):
    """Add or replace proposed lesson rows; rows with another status stay as written."""
    path = archive / "INDEX.md"
    text = path.read_text(encoding="utf-8") if path.exists() else INDEX_HEADER
    lines = text.splitlines()
    for lesson in lessons:
        entry = index_cell(f"{name} {lesson['id']}")
        scope = lesson["scope"] + (" " + ", ".join(lesson["repos"]) if lesson["repos"] else "")
        row = "| " + " | ".join(index_cell(cell) for cell in (date, entry, scope, lesson["cue"], "proposed")) + " |"
        found = None
        for number, line in enumerate(lines):
            cells = index_row_cells(line)
            if cells is not None and len(cells) >= 5 and cells[1].strip() == entry:
                found = number, "|".join(cells[4:]).strip()
                break
        if found is not None:
            status = re.match(r"[A-Za-z_]*", found[1].lstrip("`*_")).group().lower()
            if status == "proposed":
                lines[found[0]] = row
            continue
        table = [number for number, line in enumerate(lines) if line.strip().startswith("|")]
        if table:
            lines.insert(table[-1] + 1, row)
        else:
            if lines and lines[-1].strip():
                lines.append("")
            lines += INDEX_HEADER.splitlines()[2:] + [row]
    replace_archive_file(path, "\n".join(lines) + "\n")


def record_batch(st, stopped):
    """Write the batch review of a valid reflect result and its proposed lessons in INDEX.md."""
    result = st["result"]
    archive = Path(st["repo"])
    with index_lock(archive):
        # A stop may arrive while another writer holds the lock.
        if stopped():
            return
        name = st.get("reflect_file")
        if not name:
            today = time.strftime("%Y-%m-%d", time.gmtime(clock.CLOCK.time()))
            name = next((candidate for candidate in
                         [f"batch-{today}.md"] + [f"batch-{today}{chr(letter)}.md" for letter in range(ord("b"), ord("z") + 1)]
                         if not os.path.lexists(archive / candidate)), None)
            if name is None:
                raise RuntimeError(f"no free batch file name for {today}")
        date = BATCH_NAME.fullmatch(name).group(1)
        replace_archive_file(archive / name, f"# Batch reflection {date}\n\nthrough: {st['reflect_through']}\n\n"
                                     f"task: {st['slug']}\n\n{result['report'].strip()}\n")
        st["reflect_file"] = name
        update_index(archive, date, name, result["lessons"])
