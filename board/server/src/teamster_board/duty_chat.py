"""The duty chat: the conversation with teamster's duty, read from its task, and the messages the board sends it.

The board never imports the worker: the files and fields mirror src/teamster/duty_chat.py and
src/teamster/docs/duty-chat.md. The conversation is the task `duty` of kind `duty`: `duty_turns` in its
state.json holds the duty's answers, messages.jsonl the user's messages and the task notes, queue.json the
messages accepted while a turn runs and notes.json the notes held by the hourly cap.
"""

import json
import logging
import os
import re
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
# messages.jsonl is read backwards by chunks of this size.
JOURNAL_CHUNK = 1024 * 1024
STATE_BYTES = 16 * 1024 * 1024
SIDE_BYTES = 1024 * 1024
# A refusal by teamster within this long reaches the sender's answer; a later one goes to last_error.
ACCEPT_SECONDS = 2.0
ACCEPT_POLL_SECONDS = 0.05
PLAN_ADMISSION_TIMEOUT = 10.0
STATUSES = ("answered", "needs_decision", "started")
PLAN_ID = re.compile(r"[0-9a-f]{32}")
PLAN_FIELDS = {"repo": 400, "title": 120, "goal": 600}
PLAN_REFUSALS = {"invalid_plan_reply": 400, "stale_plan": 409, "plan_already_answered": 409,
                 "plan_unavailable": 409}
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


def journal_row(position, line, receipts):
    """A chat line and its admitted turn, if it was submitted through a plan."""
    try:
        row = json.loads(line)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return None
    if not isinstance(row, dict) or row.get("source") not in ("user", "note"):
        return None
    at, message = number(row.get("at")), row.get("text")
    if at is None or not isinstance(message, str):
        return None
    turn = None
    if "plan_attempt_id" in row:
        attempt = row["plan_attempt_id"]
        turn = receipts.get(attempt) if isinstance(attempt, str) else None
        if turn is None:
            return None
    return position, at, row["source"], message[:TEXT_LIMIT], turn


def journal(path, receipts):
    """The newest 200 visible user messages and task notes in messages.jsonl, in file order.

    The file is read backwards by chunks until it gave 200 of them or ended: however long they are, the newest 200
    messages of the conversation are among them.
    """
    rows = []
    if path is None:
        return rows
    try:
        with path.open("rb") as stream:
            position = stream.seek(0, os.SEEK_END)
            tail = b""
            while position > 0 and len(rows) < MESSAGE_LIMIT:
                start = max(0, position - JOURNAL_CHUNK)
                stream.seek(start)
                lines = (stream.read(position - start) + tail).split(b"\n")
                # Unless the chunk starts the file, its first piece belongs to a line that starts before it.
                tail = lines.pop(0) if start else b""
                offset = start + (len(tail) + 1 if start else 0)
                found = []
                for line in lines:
                    row = journal_row(offset, line, receipts)
                    if row is not None:
                        found.append(row)
                    offset += len(line) + 1
                rows = found + rows
                position = start
    except OSError:
        return rows
    return rows[-MESSAGE_LIMIT:]


def strings(value):
    return [item[:200] for item in value if isinstance(item, str) and item] if isinstance(value, list) else []


def valid_plan_text(value, limit):
    if not isinstance(value, str) or "\0" in value or len(value) > limit or not value.strip():
        return False
    try:
        value.encode("utf-8")
    except UnicodeError:
        return False
    return True


def valid_criteria(value):
    return isinstance(value, list) and 1 <= len(value) <= 3 and all(valid_plan_text(item, 200) for item in value)


def plan_receipt(turn):
    plan = turn.get("task_plan")
    receipt = plan.get("receipt") if isinstance(plan, dict) else None
    if isinstance(receipt, dict):
        attempt, admitted, proposed = receipt.get("attempt_id"), receipt.get("turn"), turn.get("turn")
        if (isinstance(attempt, str) and attempt and type(admitted) is int
                and type(proposed) is int and admitted == proposed + 1):
            return attempt, admitted
    return None


def duty_plan(turn):
    raw = turn.get("task_plan")
    if not isinstance(raw, dict) or not isinstance(raw.get("id"), str) or not PLAN_ID.fullmatch(raw["id"]):
        return None
    tasks = raw.get("tasks")
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= 3:
        return None
    projected = []
    for task in tasks:
        if (not isinstance(task, dict) or task.keys() != PLAN_FIELDS.keys() | {"done_when"}
                or not all(valid_plan_text(task[key], limit) for key, limit in PLAN_FIELDS.items())
                or not valid_criteria(task["done_when"])):
            return None
        projected.append({**{key: task[key].strip() for key in PLAN_FIELDS},
                          "done_when": [item.strip() for item in task["done_when"]]})
    plan = {"id": raw["id"], "tasks": projected, "actionable": False}
    if (receipt := plan_receipt(turn)) is not None:
        plan["accepted_turn"] = receipt[1]
    return plan


def duty_message(index, turn):
    """The duty's answer at index in duty_turns; its id is that index, as duty_turns only grows."""
    at, turn_number = number(turn.get("at")), turn.get("turn")
    reply, status = turn.get("reply"), turn.get("status")
    if at is None or type(turn_number) is not int or not isinstance(reply, str) or status not in STATUSES:
        return None
    question = text(turn.get("question"))
    message = {"id": f"d{index}", "at": at, "from": "duty", "text": reply[:TEXT_LIMIT], "turn": turn_number,
               "status": status, "question": question[:TEXT_LIMIT] if question else None,
               "options": strings(turn.get("options")), "started": strings(turn.get("started")),
               "account": text(turn.get("account"))}
    if (status == "needs_decision" and question and question.strip()
            and not message["started"] and (plan := duty_plan(turn)) is not None):
        message["task_plan"] = plan
    return message


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
    receipts = dict(receipt for turn in objects(raw) if (receipt := plan_receipt(turn)) is not None)
    by_time = sorted(answers, key=lambda message: message["at"])
    incoming = [{"id": f"m{offset}", "at": at, "from": source, "text": message,
                 "turn": turn if turn is not None else carrying_turn(at, state, by_time)}
                for offset, at, source, message, turn in journal(Store._file(directory, "messages.jsonl"), receipts)]
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
        if duty["family"] != "claude" and not self.actions.duty_codex_chat():
            return "codex_duty"
        return None

    def view(self):
        state, messages, queued = conversation(self.directory)
        busy = state is not None and alive(state.get("pid"))
        reason = self._reason()
        with self.state_lock:
            last_error = dict(self._error) if self._error else None
            sending = self._job is not None
        plan_messages = [message for message in messages if "task_plan" in message]
        if plan_messages and self.actions.duty_plan_reply():
            current_turn = state.get("turns")
            can_reply = reason is None and not busy and not sending and not any(row["from"] == "user" for row in queued)
            for message in plan_messages:
                plan = message["task_plan"]
                accepted = plan.get("accepted_turn")
                plan["actionable"] = can_reply and message["turn"] == current_turn and accepted is None
                if accepted is not None and accepted == current_turn and not busy and state.get("outcome") != "completed":
                    plan["error"] = (text(state.get("error")) or "Duty turn ended without an answer")[:2000]
        else:
            for message in plan_messages:
                del message["task_plan"]
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
        if "plan_id" in data or "selected" in data:
            return self.send_plan(data)
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

    def send_plan(self, data):
        plan_id, selected = data.get("plan_id"), data.get("selected")
        if (set(data) != {"plan_id", "selected"} or not isinstance(plan_id, str) or not PLAN_ID.fullmatch(plan_id)
                or not isinstance(selected, list) or not 1 <= len(selected) <= 3):
            return error(400, "invalid_plan_reply")
        indices = set()
        for item in selected:
            if (not isinstance(item, dict) or set(item) != {"index", "done_when"}
                    or type(item["index"]) is not int or not 0 <= item["index"] < 3 or item["index"] in indices
                    or not valid_criteria(item["done_when"])):
                return error(400, "invalid_plan_reply")
            indices.add(item["index"])
        if self._reason() is not None or not self.actions.duty_plan_reply():
            return error(409, "plan_unavailable")
        with self.lock, tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as stream:
            json.dump(data, stream)
            stream.flush()
            argv = [self.actions.command, "duty", "chat", "--reply-plan-file", stream.name]
            try:
                proc = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, encoding="utf-8",
                                      errors="replace", timeout=PLAN_ADMISSION_TIMEOUT, cwd=Path.home())
                reply = json.loads(proc.stdout)
            except (OSError, subprocess.TimeoutExpired, ValueError, RecursionError) as exc:
                LOGGER.info("duty plan admission did not return a receipt: %s", type(exc).__name__)
                return error(503, "plan_submission_unknown")
            if isinstance(reply, dict):
                turn = reply.get("turn")
                if proc.returncode == 0 and reply.get("ok") is True and type(turn) is int and turn > 0:
                    with self.state_lock:
                        self._error = None
                        self._bump()
                    return {"ok": True, "turn": turn}
                code = reply.get("error")
                if reply.get("ok") is False and isinstance(code, str) and code in PLAN_REFUSALS:
                    return error(PLAN_REFUSALS[code], code)
            return error(503, "plan_submission_unknown")

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
