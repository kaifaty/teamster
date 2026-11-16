"""The duty chat: the conversation with teamster's duty, read from its task, and the messages the board sends it.

The board never imports the worker: the files and fields mirror src/teamster/duty_chat.py and
src/teamster/docs/duty-chat.md. The conversation is the task `duty` of kind `duty`: `duty_turns` in its
state.json holds the duty's answers, messages.jsonl the user's messages and the task notes, queue.json the
messages accepted while a turn runs and notes.json the notes held by the hourly cap.
"""

import json
import logging
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from .actions import error, string
from .store import Store, alive, number, objects, text


SLUG = "duty"
KIND = "duty"
MESSAGE_LIMIT = 200
TEXT_LIMIT = 8000
# The newest part of messages.jsonl that is read; older messages fall outside the 200 kept anyway.
JOURNAL_BYTES = 2 * 1024 * 1024
STATE_BYTES = 16 * 1024 * 1024
SIDE_BYTES = 1024 * 1024
# A refusal by teamster within this long reaches the sender's answer; a later one goes to last_error.
ACCEPT_SECONDS = 2.0
ACCEPT_POLL_SECONDS = 0.05
STATUSES = ("answered", "needs_decision", "started")
FILES = ("state.json", "messages.jsonl", "queue.json", "notes.json")
# A state.json that cannot be read at the moment: it tells nothing about a new turn.
UNREADABLE = object()
LOGGER = logging.getLogger("uvicorn.error")


def read_object(path, limit):
    """A JSON object from a regular file of at most limit bytes, or None."""
    if path is None:
        return None
    try:
        with path.open("rb") as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            return None
        value = json.loads(raw.decode("utf-8", errors="replace"))
    except (OSError, ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def journal(path):
    """(byte offset, at, source, text) of each user message and task note in messages.jsonl's newest part."""
    rows = []
    if path is None:
        return rows
    try:
        with path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            start = max(0, stream.tell() - JOURNAL_BYTES)
            stream.seek(start)
            raw = stream.read(JOURNAL_BYTES)
    except OSError:
        return rows
    offset = start
    lines = raw.split(b"\n")
    if start:
        # The first line may be cut: it starts before the window.
        offset += len(lines[0]) + 1
        lines = lines[1:]
    for line in lines:
        position, offset = offset, offset + len(line) + 1
        try:
            row = json.loads(line)
        except (ValueError, UnicodeDecodeError, RecursionError):
            continue
        if not isinstance(row, dict) or row.get("source") not in ("user", "note"):
            continue
        at, message = number(row.get("at")), row.get("text")
        if at is not None and isinstance(message, str):
            rows.append((position, at, row["source"], message[:TEXT_LIMIT]))
    return rows


def strings(value):
    return [item[:200] for item in value if isinstance(item, str) and item] if isinstance(value, list) else []


def duty_message(index, turn):
    """The duty's answer at index in duty_turns; its id is that index, as duty_turns only grows."""
    at, turn_number = number(turn.get("at")), turn.get("turn")
    reply, status = turn.get("reply"), turn.get("status")
    if at is None or type(turn_number) is not int or not isinstance(reply, str) or status not in STATUSES:
        return None
    question = text(turn.get("question"))
    return {"id": f"d{index}", "at": at, "from": "duty", "text": reply[:TEXT_LIMIT], "turn": turn_number,
            "status": status, "question": question[:TEXT_LIMIT] if question else None,
            "options": strings(turn.get("options")), "started": strings(turn.get("started")),
            "account": text(turn.get("account"))}


def carrying_turn(at, state, answers):
    """The turn a message went out with: the current one when it started since, else the first answer after it."""
    started = number(state.get("turn_started"))
    turns = state.get("turns")
    if started is not None and at >= started and type(turns) is int:
        return turns
    return next((answer["turn"] for answer in answers if answer["at"] >= at), turns if type(turns) is int else None)


def conversation(directory):
    """(state or None, messages, queued) of the conversation in directory."""
    state = read_object(Store._file(directory, "state.json"), STATE_BYTES)
    if state is None or state.get("kind") != KIND:
        return None, [], []
    raw = state.get("duty_turns")
    answers = [message for index, turn in enumerate(raw if isinstance(raw, list) else [])
               if isinstance(turn, dict) and (message := duty_message(index, turn)) is not None]
    by_time = sorted(answers, key=lambda message: message["at"])
    incoming = [{"id": f"m{offset}", "at": at, "from": source, "text": message,
                 "turn": carrying_turn(at, state, by_time)}
                for offset, at, source, message in journal(Store._file(directory, "messages.jsonl"))]
    # A message goes out before the answer of its turn, also when both carry the same second.
    messages = sorted([*incoming, *answers], key=lambda message: (message["at"], message["from"] == "duty"))
    queued = []
    queue = read_object(Store._file(directory, "queue.json"), SIDE_BYTES) or {}
    notes = read_object(Store._file(directory, "notes.json"), SIDE_BYTES) or {}
    for row in [*objects(queue.get("waiting")), *objects(notes.get("held"))]:
        at, message = number(row.get("at")), row.get("text")
        if at is not None and isinstance(message, str):
            queued.append({"at": at, "from": "note" if row.get("source") == "note" else "user",
                           "text": message[:TEXT_LIMIT]})
    return state, messages[-MESSAGE_LIMIT:], sorted(queued, key=lambda row: row["at"])


def duty_account(accounts):
    """{account, family} of the duty account in the accounts snapshot, or None."""
    data = accounts.get("data") if isinstance(accounts, dict) else None
    duty = data.get("duty") if isinstance(data, dict) else None
    if (not isinstance(duty, dict) or not isinstance(duty.get("account"), str) or not duty["account"]
            or duty.get("family") not in ("codex", "claude")):
        return None
    return {"account": duty["account"], "family": duty["family"]}


class DutyChat:
    def __init__(self, tasks_path, actions, accounts=None):
        self.directory = Path(tasks_path) / SLUG
        self.actions = actions
        self.accounts = accounts or (lambda: None)
        # One send at a time, through its acceptance: two posts never start two conversations.
        self.lock = threading.Lock()
        # Guards the running command, last_error and the revision.
        self.state_lock = threading.Lock()
        self._job = None
        self._error = None
        self._revision = 0
        self._signature = None
        self._state_file = (None, None)  # (state.json's signature, the pid it names)

    def _reason(self):
        if self.actions.reason is not None:
            return self.actions.reason
        if not self.actions.duty_chat():
            return "old_teamster"
        duty = duty_account(self.accounts())
        if duty is None:
            return "no_duty"
        return "codex_duty" if duty["family"] != "claude" else None

    def view(self):
        state, messages, queued = conversation(self.directory)
        busy = state is not None and alive(state.get("pid"))
        reason = self._reason()
        with self.state_lock:
            last_error = dict(self._error) if self._error else None
        return {"actions": self.actions.value, "available": reason is None, "reason": reason,
                "duty": duty_account(self.accounts()), "busy": busy,
                "turn_started_at": number(state.get("turn_started")) if busy else None,
                "messages": messages, "queued": queued, "last_error": last_error}

    def changed(self):
        """Whether the conversation, its queue, its held notes, the duty or the board's own sends changed since the last call."""
        files = []
        for name in FILES:
            path = Store._file(self.directory, name)
            try:
                metadata = path.stat() if path is not None else None
            except OSError:
                metadata = None
            files.append(None if metadata is None else (metadata.st_ino, metadata.st_mtime_ns, metadata.st_size))
        if files[0] != self._state_file[0]:
            state = read_object(Store._file(self.directory, "state.json"), STATE_BYTES) if files[0] else None
            self._state_file = (files[0], state.get("pid") if state else None)
        with self.state_lock:
            revision = self._revision
        signature = (tuple(files), alive(self._state_file[1]), revision,
                     json.dumps(duty_account(self.accounts()), sort_keys=True))
        changed = signature != self._signature
        self._signature = signature
        return changed

    def _turn(self):
        """(created, turns) of the conversation, None before it exists, or UNREADABLE."""
        path = Store._file(self.directory, "state.json")
        if path is None:
            return None
        state = read_object(path, STATE_BYTES)
        if state is None:
            return UNREADABLE
        return (state.get("created"), state.get("turns")) if state.get("kind") == KIND else None

    def _bump(self):
        self._revision += 1

    def send(self, data):
        if self.actions.reason is not None:
            return error(403, self.actions.reason)
        try:
            message = string(data, "text", TEXT_LIMIT, required=True)
        except ValueError as exc:
            return error(400, str(exc))
        if not self.actions.duty_chat():
            return error(409, "old_teamster")
        with self.lock:
            with self.state_lock:
                running = self._job is not None
            state = read_object(Store._file(self.directory, "state.json"), STATE_BYTES)
            # The board's own command still waits for a turn it sent, or a turn runs: the message joins the queue.
            busy = running or (state is not None and alive(state.get("pid")))
            before = self._turn()
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as stream:
                path = Path(stream.name)
                stream.write(message)
            argv = [self.actions.command, "duty", "chat", "--file", str(path), *(["--queue"] if busy else [])]
            job = {"done": threading.Event(), "accepted": False, "returncode": None, "output": ""}
            try:
                process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, encoding="utf-8", errors="replace",
                                           cwd=Path.home())
            except OSError as exc:
                path.unlink()
                LOGGER.info("/api/actions/duty-chat argv=%s exit=unavailable", json.dumps(argv))
                return error(422, str(exc)[-2000:])
            threading.Thread(target=self._wait, args=(job, process, argv, path), daemon=True).start()
            deadline = time.monotonic() + ACCEPT_SECONDS
            while True:
                job["done"].wait(ACCEPT_POLL_SECONDS)
                current = self._turn()
                started = current is not UNREADABLE and current != before
                with self.state_lock:
                    if job["returncode"] is not None:
                        self._bump()
                        if job["returncode"]:
                            # teamster refused at once: no duty, a Codex duty, a busy turn, an empty message.
                            return error(422, job["output"] or f"teamster exited with {job['returncode']}")
                        self._error = None
                        return {"ok": True, "queued": busy and not started}
                    if started or time.monotonic() >= deadline:
                        job["accepted"] = True
                        self._job = job
                        self._error = None
                        self._bump()
                        return {"ok": True, "queued": busy and not started}

    def _wait(self, job, process, argv, path):
        """Wait for the command, which returns when the duty's turn ends; a failure after acceptance goes to last_error."""
        try:
            stdout, stderr = process.communicate()
        finally:
            path.unlink(missing_ok=True)
        LOGGER.info("/api/actions/duty-chat argv=%s exit=%s", json.dumps(argv), process.returncode)
        with self.state_lock:
            job["returncode"] = process.returncode
            job["output"] = (stderr.strip() or stdout.strip())[-2000:]
            if job["accepted"]:
                if self._job is job:
                    self._job = None
                if process.returncode:
                    self._error = {"at": time.time(),
                                   "text": job["output"] or f"teamster exited with {process.returncode}"}
                self._bump()
        job["done"].set()
