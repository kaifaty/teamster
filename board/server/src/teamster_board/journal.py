"""Keep the telemetry journal cursor, board events, sign-ins and lead verdicts."""

import json
import os
import stat
import time

from .task_files import ARCHIVED, number, one_line, source_file, text


LOG_RETENTION_SECONDS = 31 * 24 * 3600
LOG_LIMIT = 5000
LEAD_VERDICTS = ("accepted", "revised", "redone", "dropped")


def log_event(row):
    if not isinstance(row, dict) or row.get("kind") not in ("work", "review", "scout", "verdict"):
        return None
    at = number(row.get("at"))
    if at is None:
        return None
    event = {key: text(row.get(key)) for key in (
        "slug", "repo", "kind", "phase", "outcome", "result_status", "verdict", "angle",
        "account", "reviewer", "provider", "model", "task_type",
    )}
    event.update({key: number(row.get(key)) for key in (
        "started", "turn", "round", "findings", "severe_findings",
    )})
    ci = row.get("ci")
    note = text(row.get("note")) if event["kind"] == "verdict" else None
    event.update(at=at, ci=text(ci.get("outcome")) if isinstance(ci, dict) else None,
                 note=one_line(note) if note else None)
    return event


def verdict_key(row):
    """A lead verdict journal row as ((repo, slug, created), (at, verdict)), or None."""
    if not isinstance(row, dict) or row.get("kind") != "verdict" or row.get("verdict") not in LEAD_VERDICTS:
        return None
    at, repo, slug = number(row.get("at")), text(row.get("repo")), text(row.get("slug"))
    if at is None or repo is None or slug is None:
        return None
    return (repo, slug, number(row.get("created"))), (at, row["verdict"])


def login_key(row):
    """A sign-in journal row from `teamster login` or `claude-login`, or None."""
    if not isinstance(row, dict) or row.get("event") != "account_login":
        return None
    at = number(row.get("at"))
    return None if at is None else (at, text(row.get("family")), text(row.get("account")))


class Journal:
    def __init__(self):
        self._log_events = []
        self._log_seen = {}
        self._log_signature = None
        self._log_offset = 0
        # The latest lead verdict per (repo, slug, created): kept past the log window while the server runs.
        self._verdicts = {}
        self._login_seen = {}
        self._last_logins = {}
        self._new_logins = 0

    def events(self, since, until):
        events = sorted((event for event in self._log_events if since <= event["at"] <= until),
                        key=lambda event: event["at"])
        result = {"since": since, "until": until, "events": events[-LOG_LIMIT:]}
        if len(events) > LOG_LIMIT:
            result["truncated"] = True
        return result

    def take_logins(self):
        """Count sign-in rows appended since the last call; rows present at startup do not count."""
        count, self._new_logins = self._new_logins, 0
        return count

    def last_logins(self):
        return [dict(row) for _, row in sorted(self._last_logins.items())]

    def lead_verdict(self, slug, record, repo, *, current=True):
        """The task's latest lead verdict and its time, or (None, None).

        A verdict belongs to the task with the same repository, slug and birth (`created`); a legacy verdict without
        a birth belongs to a task born before it. It counts only when written after the task's last turn began
        and ended: a new turn makes it void.
        """
        state = record.state
        match = ARCHIVED.fullmatch(slug) if record.archived else None
        slug = match.group(1) if match else slug
        created = number(state.get("created"))
        found = [self._verdicts.get((repo, slug, created))]
        legacy = self._verdicts.get((repo, slug, None)) if created is not None else None
        if legacy is not None and legacy[0] >= created:
            found.append(legacy)
        found = max((item for item in found if item is not None), default=None)
        turn = [at for at in (number(state.get("turn_started")), number(state.get("turn_finished"))) if at is not None]
        if found is None or (current and turn and found[0] <= max(turn)):
            return None, None
        return found[1], found[0]

    def poll(self, path, *, initial_poll):
        cutoff = time.time() - LOG_RETENTION_SECONDS
        self._log_events = [event for event in self._log_events if event["at"] >= cutoff]
        self._log_seen = {key: at for key, at in self._log_seen.items() if at >= cutoff}
        self._login_seen = {key: at for key, at in self._login_seen.items() if at >= cutoff}
        if path is None:
            return []
        if source_file(path.parent, path) is None:
            self._log_events = []
            self._log_signature = None
            self._log_offset = 0
            return []
        added = []
        try:
            metadata = path.lstat()
            signature = (metadata.st_dev, metadata.st_ino, metadata.st_mtime_ns, metadata.st_size)
            if signature == self._log_signature:
                return []
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if not stat.S_ISREG(metadata.st_mode):
                    return []
                signature = (metadata.st_dev, metadata.st_ino, metadata.st_mtime_ns, metadata.st_size)
                previous = self._log_signature
                reset = (previous is None or signature[:2] != previous[:2]
                         or signature[3] < previous[3]
                         or (signature[3] == previous[3] and signature[2] != previous[2]))
                if reset:
                    self._log_offset = 0
                    self._log_events = []
                stream.seek(self._log_offset)
                while True:
                    line = stream.readline()
                    if not line.endswith(b"\n"):
                        break
                    self._log_offset = stream.tell()
                    try:
                        row = json.loads(line)
                        event = log_event(row)
                    except (ValueError, UnicodeDecodeError, OverflowError, RecursionError):
                        continue
                    verdict = verdict_key(row)
                    if verdict is not None:
                        key, value = verdict
                        if key not in self._verdicts or value[0] >= self._verdicts[key][0]:
                            self._verdicts[key] = value
                    login = login_key(row)
                    if login is not None and login[1] in ("codex", "claude") and login[2]:
                        key = login[1:]
                        previous_login = self._last_logins.get(key)
                        if previous_login is None or login[0] >= previous_login["at"]:
                            self._last_logins[key] = {"family": login[1], "account": login[2],
                                                      "at": login[0], "status": text(row.get("status"))}
                    if login is not None and login[0] >= cutoff:
                        # Sign-ins stay out of the ship's log; they only make accounts refresh.
                        if not initial_poll and (not reset or login not in self._login_seen):
                            self._new_logins += 1
                        self._login_seen[login] = login[0]
                    if event is not None and event["at"] >= cutoff:
                        self._log_events.append(event)
                        key = tuple(event.items())
                        if not reset or key not in self._log_seen:
                            added.append(event)
                        self._log_seen[key] = event["at"]
                self._log_signature = signature
        except OSError:
            return []
        return [{"type": "event", "event": event} for event in sorted(added, key=lambda event: event["at"])]
