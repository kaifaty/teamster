"""Read task records without importing or mutating the worker plugin."""

import os
import re
import subprocess
import threading
import time
from pathlib import Path

from .activity import EventTail, FEED_FILES, task_feed, worktree_roots
from .desktop_sessions import DesktopSessions
from .journal import LOG_RETENTION_SECONDS, Journal
from .task_files import (
    ARCHIVED, Record, alive, directories, line, lines, number, objects, one_line, read_state,
    safe_slug, task_file, task_messages, task_paths, task_queue, text,
)


FILES = {"brief": "brief.md", "last": "last.md", "review": "review.md", "check": "check.log"}
FAILURES = {"failed", "stopped", "interrupted", "budget_exhausted", "conflict", "stuck",
            "refused", "unavailable", "exhausted", "running", "sleeping", "timeout"}


def branch_changes(worktree, base):
    """Read branch statistics only for a worktree and ref supplied by task state."""
    if (not text(worktree) or not text(base) or base.startswith("-") or base == "@"
            or base.endswith(".") or any(char.isspace() for char in base)
            or re.search(r"[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{", base)
            or any(not part or part.startswith(".") or part.endswith(".lock")
                   for part in base.split("/"))):
        return None

    def git(*args):
        return subprocess.run(
            ["git", "-C", worktree, *args], stdin=subprocess.DEVNULL,
            capture_output=True, encoding="utf-8", errors="replace", check=True,
            timeout=5, env=dict(os.environ, LC_ALL="C", GIT_OPTIONAL_LOCKS="0"),
        ).stdout

    try:
        if git("rev-parse", "--is-inside-work-tree").strip() != "true":
            return None
        changes = {"commits": int(git("rev-list", "--count", f"{base}..HEAD"))}
        shortstat = git("diff", "--shortstat", f"{base}...HEAD")
        for key, label in (("files", "file"), ("insertions", "insertion"), ("deletions", "deletion")):
            match = re.search(rf"(\d+) {label}", shortstat)
            changes[key] = int(match[1]) if match else 0
        changes["uncommitted"] = len(git("status", "--porcelain").splitlines())
        return changes
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None


def mapping(value):
    return value if isinstance(value, dict) else {}


def integer(value):
    return value if type(value) is int else None


def last(value):
    """The last item of a list when it is an object, else None."""
    item = value[-1] if isinstance(value, list) and value else None
    return item if isinstance(item, dict) else None


def turn_check(state):
    """The latest check entry of the current turn: checks[check_start:], else None."""
    checks = state.get("checks")
    start = max(integer(state.get("check_start")) or 0, 0)
    return last(checks[start:]) if isinstance(checks, list) else None


def review_verdict(review):
    verdict = review.get("verdict")
    return verdict if verdict in ("clean", "defects") else None


def cargo_summary(state):
    """The TaskSummary fields describing what the task's last turn brought."""
    check = turn_check(state)
    review = mapping(state.get("review_result"))
    result = mapping(state.get("result"))
    return {
        "check": line(check.get("outcome")) if check else None,
        "review": review_verdict(review),
        "findings_left": len(objects(review.get("findings"))),
        "stop": line(state.get("auto_fix_stop")),
        "left": len(lines(result.get("remaining"))) + len(lines(result.get("questions"))),
    }


def cargo(state):
    """TaskDetail.cargo: the verification, review, CI, base merge and open work of the task."""
    check = turn_check(state)
    result = mapping(state.get("result"))
    review = state.get("review_result")
    ci = state.get("ci")
    base = last(state.get("base_merges"))
    if isinstance(ci, dict):
        ci_checks = objects(ci.get("checks"))
        failing = [item for item in ci_checks if item.get("bucket") in ("fail", "cancel")]
        ci = {
            "outcome": line(ci.get("outcome")),
            "passed": sum(item.get("bucket") == "pass" for item in ci_checks),
            "failed": len(failing),
            "total": len(ci_checks),
            "failing": [name for name in (line(item.get("name")) for item in failing) if name][:10],
            "seconds": number(ci.get("seconds")),
            "rounds": integer(ci.get("rounds")) or 0,
            "reason": line(ci.get("reason")),
        }
    else:
        ci = None
    if isinstance(review, dict):
        review = {
            "verdict": review_verdict(review),
            "summary": line(review.get("summary")),
            "findings": [{
                "id": line(item.get("id")) or "",
                "severity": line(item.get("severity")) or "",
                "title": line(item.get("title")) or "",
                "file": line(item.get("file")),
                "line": integer(item.get("line")),
            } for item in objects(review.get("findings"))[:30]],
            "reviews": len(state.get("reviews")) if isinstance(state.get("reviews"), list) else 0,
        }
    else:
        review = None
    decisions = [item.get("decision") for item in objects(result.get("findings"))]
    return {
        "check": {
            "command": line(check.get("cmd")) or "",
            "outcome": line(check.get("outcome")) or "",
            "exit": integer(check.get("exit")),
            "seconds": number(check.get("seconds")),
            "at": number(check.get("at")),
        } if check else None,
        "claims": [{
            "command": line(item.get("command")) or "",
            "outcome": line(item.get("outcome")) or "",
            "details": line(item.get("details")) or "",
        } for item in objects(result.get("checks"))[:10]],
        "review": review,
        "stop": line(state.get("auto_fix_stop")),
        "ci": ci,
        "base": {
            "base": line(base.get("base")) or "",
            "outcome": line(base.get("outcome")) or "",
            "files": lines(base.get("files"))[:20],
        } if base else None,
        "remaining": lines(result.get("remaining"))[:20],
        "questions": lines(result.get("questions"))[:20],
        "decisions": {"fixed": decisions.count("fixed"), "rejected": decisions.count("rejected")},
    }


def limits(state):
    rotations = []
    for item in objects(state.get("rotations")):
        at = number(item.get("at"))
        if at is not None:
            rotations.append({"at": at, **{key: line(item.get(key))
                                           for key in ("from", "to", "reason")}})
    angles = state.get("review_angles")
    rounds = state.get("rounds")
    return {
        "max_turn_minutes": number(state.get("max_turn_minutes")),
        "weekly_used_percent": number(state.get("weekly_used_percent")),
        "max_weekly_percent": number(state.get("max_task_weekly_percent")),
        "fix_rounds": number(state.get("fix_rounds")),
        "review_rounds": len(rounds) if isinstance(rounds, list) else 0,
        "ci_rounds": number(state.get("ci_rounds")),
        "ci_enabled": state.get("ci_enabled") is True or bool(text(state.get("ci_command"))),
        "review_angles": angles if isinstance(angles, list) and all(isinstance(a, str) for a in angles) else [],
        "check": line(state.get("check")),
        "rotations": sorted(rotations, key=lambda item: item["at"])[-20:],
    }


def phase(state, is_alive):
    """Derive the phase from the cursors the plugin persists, in priority order.

    A dead supervisor is idle. A live supervisor with outcome sleeping is
    sleeping; check_pid means the saved check is executing; ci.outcome pending
    means wait_ci is polling. kind review covers Codex and Claude review,
    including account selection between attempts. For work, nonempty rounds
    records an automatic review fix; a failed ci with rounds > 0 records a CI
    repair. These are fix while work is running (or an executor pid is set).
    Otherwise running work/scout is turn; completed work between phases is idle.

    turn_started, unfinished review.started, the latest sleep rotation.at and
    turn_finished provide known start times. For a missing start (including
    check, CI and fix), Store retains the time it first observes that phase in
    Record until the phase changes. A phase present on the server's initial
    poll keeps a null fallback: its start predates observation and is unknown.
    """
    if not is_alive:
        return "idle", number(state.get("turn_finished"))
    if state.get("outcome") == "sleeping":
        sleeps = [item for item in objects(state.get("rotations")) if item.get("event") == "sleep"]
        return "sleeping", number(sleeps[-1].get("at")) if sleeps else None
    if state.get("check_pid"):
        return "check", None
    ci = mapping(state.get("ci"))
    if ci.get("outcome") == "pending":
        return "ci", None
    if state.get("kind") == "review":
        reviews = state.get("reviews")
        start = max(integer(state.get("review_start")) or 0, 0)
        latest = (last(reviews[start:]) if isinstance(reviews, list) else None) or {}
        started = number(latest.get("started")) if latest.get("finished") is None else None
        return "review", started
    if state.get("outcome") == "running" or any(state.get(key) for key in ("codex_pid", "claude_pid", "opencode_pid")):
        if state.get("rounds") or (ci.get("outcome") == "failed" and (integer(ci.get("rounds")) or 0) > 0):
            return "fix", None
        return "turn", number(state.get("turn_started"))
    return "idle", number(state.get("turn_finished"))


def timeline(state):
    entries = []

    def add(at, message):
        at = number(at)
        if at is not None:
            entries.append({"at": at, "text": one_line(message)})

    add(state.get("created"), "Task created")
    add(state.get("turn_started"), f"Turn {state.get('turns', 0)} started")
    add(state.get("turn_finished"), f"Turn {state.get('turns', 0)} {state.get('outcome', 'finished')}")
    for item in state.get("threads", []):
        add(item.get("started"), f"Turn on {item.get('account', '?')}")
    for item in objects(state.get("checks")):
        add(item.get("at"), f"Check {item.get('outcome', '?')}: {item.get('cmd', '')}")
    for item in objects(state.get("reviews")):
        label = f"Review {item.get('angle', 'correctness')} by {item.get('reviewer', 'codex')}/{item.get('account', '?')}"
        add(item.get("started"), label + " started")
        add(item.get("finished"), label + " " + str(item.get("outcome") or "finished"))
    for item in objects(state.get("rotations")):
        event = item.get("event")
        label = (f"{event}: {item.get('account') or ''} {item.get('reason') or ''}" if event else
                 f"Rotated {item.get('from', '?')} to {item.get('to', '?')}: {item.get('reason', '')}")
        add(item.get("at"), label)
    ci = mapping(state.get("ci"))
    if ci:
        # CI has no own wall-clock timestamp; state mtime is its durable observation.
        add(state.get("_updated_at"), f"CI {ci.get('outcome', '?')}: {ci.get('reason', '')}")
    return sorted(entries, key=lambda item: item["at"])[-200:]


class Store:
    def __init__(self, tasks_path, stale_days=7, claude_desktop_dir=None, claude_home=None,
                 sessions_seconds=5, session_stale_hours=48, telemetry_path=None):
        self.tasks_path = Path(tasks_path)
        self.stale_days = stale_days
        self.claude_desktop_dir = Path(claude_desktop_dir) if claude_desktop_dir is not None else None
        self.claude_home = Path(claude_home) if claude_home is not None else None
        self.sessions_seconds = sessions_seconds
        self.session_stale_hours = session_stale_hours
        self._desktop_sessions = DesktopSessions()
        self.session_records = self._desktop_sessions.records
        self.records = {}
        self.telemetry_path = Path(telemetry_path) if telemetry_path is not None else None
        self._journal = Journal()
        self.lock = threading.RLock()
        self._initial_poll = True

    _file = staticmethod(task_file)
    _directories = staticmethod(directories)
    _read_state = staticmethod(read_state)
    _safe_slug = staticmethod(safe_slug)

    def _paths(self, *, strict=False):
        return task_paths(self.tasks_path, strict=strict)

    def lead_verdict(self, slug, record, repo):
        """Read the current verdict without consuming this store's pending journal events."""
        reader = Journal()
        reader.poll(self.telemetry_path, initial_poll=True)
        return reader.lead_verdict(slug, record, repo)

    def _summary(self, slug, record):
        state = record.state
        now = time.time()
        is_alive = alive(state.get("pid"))
        result = mapping(state.get("result"))
        status = text(result.get("status"))
        outcome = text(state.get("outcome"))
        if record.archived or (not is_alive and (
                state.get("kind") == "scout"
                or record.updated_at < now - self.stale_days * 86400)):
            column = "closed"
        elif is_alive:
            column = "sleeping" if outcome == "sleeping" else "running"
        else:
            column = "review_me" if status == "done" and outcome not in FAILURES else "attention"
        current_phase, started_at = phase(state, is_alive)
        if record.observed_phase != current_phase:
            record.observed_phase = current_phase
            record.phase_started_at = None if self._initial_poll else now
        if started_at is None:
            started_at = record.phase_started_at
        executor = state.get("executor", "codex")
        summary = text(result.get("summary"))
        ci = mapping(state.get("ci"))
        repo = Path(state.get("repo") or state.get("worktree") or "").name
        verdict, verdict_at = self._journal.lead_verdict(slug, record, repo)
        return {
            "slug": slug,
            "kind": state.get("kind", "work"),
            "title": None,
            "link": None,
            "repo": repo,
            "branch": text(state.get("branch")),
            "task_type": text(state.get("task_type")),
            "executor": executor,
            "account": None if executor == "opencode" else text(
                state.get("claude_account") if executor == "claude" else state.get("account")),
            "reviewer": text(state.get("reviewer")),
            "model": text(state.get("task_model") or (state.get("model") if executor == "claude" else None)),
            "effort": text(state.get("reasoning_effort") or state.get("effort")),
            "column": column,
            "phase": current_phase,
            "phase_started_at": started_at,
            "alive": is_alive,
            "turn": state.get("turns", 0),
            "fix_round": (len(state["rounds"]) if isinstance(state.get("rounds"), list) else 0)
                         + (integer(ci.get("rounds")) or 0),
            "outcome": outcome,
            "result_status": status,
            "summary": one_line(summary.splitlines()[0]) if summary else None,
            "pr": text((state.get("publish") or {}).get("pr") or result.get("pr")),
            "ci": text(ci.get("outcome")),
            "sleeping_until": number((state.get("sleeping") or {}).get("until")),
            "created": number(state.get("created")),
            "updated_at": record.updated_at,
            "activity": record.activity if is_alive else None,
            "scheduled": None,
            "lead_verdict": verdict,
            "lead_verdict_at": verdict_at,
            "started_by": text(state.get("started_by")),
            **cargo_summary(state),
        }

    def poll(self):
        with self.lock:
            return self._poll()

    def events(self, since, until):
        with self.lock:
            return self._journal.events(since, until)

    def take_logins(self):
        """Count sign-in rows appended since the last call; rows present at startup do not count."""
        with self.lock:
            return self._journal.take_logins()

    def last_logins(self):
        with self.lock:
            return self._journal.last_logins()

    def _poll_log(self):
        return self._journal.poll(self.telemetry_path, initial_poll=self._initial_poll)

    def _record(self, slug):
        if not self._safe_slug(slug):
            return None
        record = self.records.get(slug)
        if record is not None:
            return record
        archive = self.tasks_path / ".archive"
        if self.tasks_path.is_symlink():
            return None
        # The 50-record limit applies to snapshots, not archive REST addresses.
        for root, archived in ((self.tasks_path, False), (archive, True)):
            if root.is_symlink():
                continue
            record = Record(root / slug, archived=archived)
            self._read_state(record)
            if record.signature is not None:
                record.summary = self._summary(slug, record)
                return record
        return None

    def _poll(self):
        messages = []
        # The journal first: a verdict read now shows in this poll's task summaries.
        log_messages = self._poll_log()
        paths = self._paths()
        present = {path.name for path, _ in paths}
        for slug in list(self.records):
            if slug not in present:
                record = self.records.pop(slug)
                if not record.archived and record.summary.get("kind") != "duty":
                    messages.append({"type": "task_removed", "slug": slug})
        for path, archived in paths:
            slug = path.name
            previous = self.records.get(slug)
            record = previous if previous and previous.path == path else Record(path, archived)
            self._read_state(record)
            if record.signature is None:
                continue
            record.archived = archived
            latest = []
            if not archived and alive(record.state.get("pid")):
                for filename in ("events.jsonl", "claude-events.jsonl"):
                    event_path = self._file(path, filename)
                    if event_path is None:
                        continue
                    if filename not in record.tails:
                        record.tails[filename] = EventTail(event_path)
                    tail = record.tails[filename]
                    activity = tail.read()
                    if activity is not None:
                        latest.append((activity["at"], activity))
            if latest:
                record.activity = max(latest, key=lambda item: item[0])[1]
            summary = self._summary(slug, record)
            if summary != record.summary:
                old_activity = record.summary.get("activity")
                record.summary = summary
                if summary["kind"] == "duty":
                    # The duty chat is not a ship: its changes reach pages as duty_chat messages.
                    self.records[slug] = record
                    continue
                messages.append({"type": "task", "task": summary})
                if summary["activity"] is not None and summary["activity"] != old_activity:
                    messages.append({"type": "activity", "slug": slug, "activity": summary["activity"]})
            self.records[slug] = record
        messages.extend(self._desktop_sessions.poll(self.claude_desktop_dir, self.claude_home,
                                                   self.sessions_seconds, self.session_stale_hours))
        messages.extend(log_messages)
        self._initial_poll = False
        return messages

    def summary(self, slug):
        """One task's current summary, or None."""
        with self.lock:
            session = self.session_records.get(slug) if self._safe_slug(slug) else None
            record = session or self._record(slug)
            return None if record is None else record.summary.copy()

    def summaries(self):
        with self.lock:
            # The duty chat is a conversation, not a task of the map.
            rows = [record.summary.copy() for _, record in sorted(self.records.items())
                    if record.summary.get("kind") != "duty"]
            rows.extend(record.summary.copy() for _, record in sorted(self.session_records.items()))
            closed = sorted((row for row in rows if row["column"] == "closed"),
                            key=lambda row: (row["updated_at"], row["slug"]), reverse=True)[:50]
            return [row for row in rows if row["column"] != "closed"] + closed

    def detail(self, slug):
        with self.lock:
            if not self._safe_slug(slug):
                return None
            session = self.session_records.get(slug)
            if session is not None:
                entries = [{"at": session.summary[key], "text": label}
                           for key, label in (("created", "Session created"),
                                              ("updated_at", "Last activity"))
                           if session.summary[key] is not None]
                return dict(session.summary, timeline=sorted(entries, key=lambda item: item["at"]),
                            files=[], report=None, changes=None, cargo=None, limits=None,
                            messages=[], activity_log=[],
                            queue={"waiting": [], "dropped": []})
            record = self._record(slug)
            if record is None:
                return None
            state = dict(record.state, _updated_at=record.updated_at)
            report = text(mapping(state.get("result")).get("summary"))
            detail = dict(record.summary, timeline=timeline(state),
                        report=report[:7999] + "…" if report and len(report) > 8000 else report,
                        files=[name for name, filename in FILES.items()
                               if self._file(record.path, filename) is not None],
                        cargo=cargo(record.state), limits=limits(record.state),
                        messages=task_messages(self._file(record.path, "messages.jsonl")),
                        queue=task_queue(self._file(record.path, "queue.json")),
                        activity_log=sorted((activity for tail in record.tails.values()
                                             for activity in tail.activities),
                                            key=lambda item: item["at"])[-10:][::-1]
                        if record.summary["alive"] else [])
        detail["changes"] = branch_changes(state.get("worktree"), state.get("base"))
        return detail

    def feed(self, slug, after=None):
        with self.lock:
            if (not self._safe_slug(slug) or self.tasks_path.is_symlink()
                    or slug in self.session_records):
                return None
            record = self._record(slug)
            if record is None or record.archived or self._file(record.path, "state.json") is None:
                return None
            self._read_state(record)
            worktree = record.state.get("worktree")
            paths = {name: self._file(record.path, name) for name in FEED_FILES}
        # Resolved outside the lock: the worktree may stand on a slow or unmounted disk.
        return task_feed(paths, slug, after, worktree_roots(worktree))

    def file_path(self, slug, name):
        with self.lock:
            if (name not in FILES or self.tasks_path.is_symlink()
                    or not self._safe_slug(slug) or slug in self.session_records):
                return None
            record = self._record(slug)
            if record is None:
                return None
            if record.archived and record.path.parent.is_symlink():
                return None
            return self._file(record.path, FILES[name])
