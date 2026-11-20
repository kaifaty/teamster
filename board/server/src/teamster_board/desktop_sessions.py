"""Read Claude Desktop sessions and their live activity."""

import json
import stat
import time
from dataclasses import dataclass, field
from pathlib import Path

from .activity import EventTail
from .task_files import alive, directories, number, safe_slug, source_file, text


@dataclass
class SessionRecord:
    path: Path
    state: dict
    summary: dict = field(default_factory=dict)
    tail: EventTail | None = None
    transcript_search_at: float | None = None
    activity: dict | None = None


class DesktopSessions:
    """Keep Desktop session metadata and transcript caches across Board polls."""

    def __init__(self):
        self.records = {}
        self._session_signatures = {}
        self._session_paths = {}
        self._live_sessions = {}
        self._next_sessions_scan = 0.0

    def _scan_sessions(self, root):
        if root is None:
            return
        paths = set()
        if not root.is_symlink():
            for account in directories(root / "claude-code-sessions"):
                for directory in directories(account):
                    try:
                        candidates = directory.iterdir()
                        for path in candidates:
                            if not (path.name.startswith("local_") and path.suffix == ".json"):
                                continue
                            try:
                                metadata = path.lstat()
                                if not stat.S_ISREG(metadata.st_mode):
                                    continue
                                paths.add(path)
                                signature = (metadata.st_mtime_ns, metadata.st_size)
                                if signature == self._session_signatures.get(path):
                                    continue
                                self._session_signatures[path] = signature
                                raw = json.loads(path.read_text(encoding="utf-8"))
                                state = self._session_metadata(raw)
                            except (OSError, ValueError):
                                continue
                            if state is None:
                                continue
                            old_slug = self._session_paths.get(path)
                            slug = state["sessionId"]
                            if old_slug and (old_slug != slug or state.get("isArchived")):
                                self.records.pop(old_slug, None)
                                self._session_paths.pop(path, None)
                            if state.get("isArchived"):
                                continue
                            record = self.records.get(slug)
                            if record is None or record.path != path:
                                record = SessionRecord(path, state)
                                self.records[slug] = record
                            else:
                                if record.state.get("cliSessionId") != state.get("cliSessionId"):
                                    record.tail = None
                                    record.transcript_search_at = None
                                    record.activity = None
                                record.state = state
                            self._session_paths[path] = slug
                    except OSError:
                        continue
        for path in set(self._session_signatures) - paths:
            del self._session_signatures[path]
            slug = self._session_paths.pop(path, None)
            if slug:
                self.records.pop(slug, None)

    def _session_metadata(self, raw):
        if not isinstance(raw, dict):
            return None
        slug = raw.get("sessionId")
        if not safe_slug(slug) or not slug.startswith("local_"):
            return None
        fields = ("sessionId", "cliSessionId", "title", "cwd", "originCwd", "model", "effort",
                  "isArchived", "createdAt", "lastActivityAt", "completedTurns",
                  "interruptedAwaitingPerson")
        state = {key: raw[key] for key in fields if key in raw}
        if (number(state.get("createdAt")) is None
                or number(state.get("lastActivityAt")) is None
                or not isinstance(raw.get("prs", []), list)
                or type(state.get("isArchived", False)) is not bool
                or type(state.get("completedTurns", 0)) is not int):
            return None
        if any(state.get(key) is not None and not isinstance(state[key], str)
               for key in ("cliSessionId", "title", "cwd", "originCwd", "model", "effort")):
            return None
        if state.get("cliSessionId") is not None and not safe_slug(state["cliSessionId"]):
            return None
        if any("\0" in (state.get(key) or "") for key in ("cwd", "originCwd")):
            return None
        # Scheduled sessions (such as the batch reflection) carry their task id.
        state["scheduledTaskId"] = text(raw.get("scheduledTaskId"))
        state["prs"] = [{key: pr[key] for key in ("url", "state", "branch", "own") if key in pr}
                        for pr in raw.get("prs", []) if isinstance(pr, dict)]
        return state

    def _read_live_sessions(self, root):
        if root is None or root.is_symlink():
            self._live_sessions.clear()
            return {}
        present = set()
        try:
            directory = root / "sessions"
            candidates = [] if directory.is_symlink() else directory.iterdir()
            for path in candidates:
                if not (path.suffix == ".json" and path.stem.isascii() and path.stem.isdecimal()):
                    continue
                if source_file(root, path) is None:
                    continue
                present.add(path)
                try:
                    raw = json.loads(path.read_text(encoding="utf-8"))
                    cwd = raw.get("cwd") if isinstance(raw, dict) else None
                    if (isinstance(raw, dict) and type(raw.get("pid")) is int
                            and raw["pid"] == int(path.stem)
                            and safe_slug(raw.get("sessionId"))
                            and raw.get("status") in ("busy", "idle")
                            and number(raw.get("statusUpdatedAt")) is not None
                            and (cwd is None or (isinstance(cwd, str) and "\0" not in cwd))):
                        self._live_sessions[path] = {key: raw[key] for key in (
                            "pid", "sessionId", "cwd", "status", "statusUpdatedAt", "entrypoint")
                            if key in raw}
                except (OSError, ValueError):
                    pass
        except OSError:
            pass
        for path in set(self._live_sessions) - present:
            del self._live_sessions[path]
        sessions = {}
        for state in self._live_sessions.values():
            if not alive(state["pid"]):
                continue
            previous = sessions.get(state["sessionId"])
            rank = (state["status"] == "busy", state["statusUpdatedAt"])
            if previous is None or rank > (previous["status"] == "busy", previous["statusUpdatedAt"]):
                sessions[state["sessionId"]] = state
        return sessions

    def _session_activity(self, record, live, root):
        if root is None:
            return
        projects = root / "projects"
        if root.is_symlink() or projects.is_symlink():
            return
        if record.tail is not None and source_file(root, record.tail.path) is None:
            record.tail = None
        if record.tail is None:
            session_id = record.state.get("cliSessionId")
            if not safe_slug(session_id):
                return
            cwd = text(live.get("cwd")) or text(record.state.get("cwd")) or ""
            encoded = "".join(char if char.isascii() and char.isalnum() else "-" for char in cwd)
            path = source_file(root, projects / encoded / (session_id + ".jsonl"))
            now = time.monotonic()
            if path is None and (record.transcript_search_at is None
                                 or now - record.transcript_search_at >= 60):
                record.transcript_search_at = now
                for directory in directories(projects):
                    path = source_file(root, directory / (session_id + ".jsonl"))
                    if path is not None:
                        break
            if path is None:
                return
            record.tail = EventTail(path)
        if source_file(root, record.tail.path) is not None:
            activity = record.tail.read()
            if activity is not None:
                record.activity = activity

    def _session_summary(self, slug, record, live, root, session_stale_hours):
        state = record.state
        is_alive = live is not None and live.get("status") == "busy"
        updated_at = number(state.get("lastActivityAt")) / 1000
        prs = state.get("prs", [])
        own = [pr for pr in prs if pr.get("own") is True]
        pr = (own or prs or [{}])[-1]
        if is_alive:
            column = "running"
        elif state.get("interruptedAwaitingPerson") is not None:
            column = "attention"
        elif prs and all(pr.get("state") in ("MERGED", "CLOSED") for pr in prs):
            column = "closed"
        elif updated_at < time.time() - session_stale_hours * 3600:
            column = "closed"
        else:
            column = "review_me"
        cwd = text(state.get("originCwd")) or text(state.get("cwd")) or ""
        if cwd and Path(cwd).is_relative_to(root):
            repo = "(no folder)"
        else:
            repo = Path(cwd.split("/.claude/worktrees/", 1)[0]).name
        return {
            "slug": slug, "kind": "session", "title": text(state.get("title")),
            "link": "claude://claude.ai/epitaxy/" + slug,
            "repo": repo, "branch": text(own[-1].get("branch")) if own else None,
            "task_type": None, "executor": "claude", "account": None, "reviewer": None,
            "model": text(state.get("model")), "effort": text(state.get("effort")),
            "column": column, "phase": "turn" if is_alive else "idle",
            "phase_started_at": number(live.get("statusUpdatedAt")) / 1000 if is_alive else updated_at,
            "alive": is_alive, "turn": state.get("completedTurns", 0), "fix_round": 0,
            "outcome": None, "result_status": None, "summary": None,
            "pr": text(pr.get("url")), "ci": None, "sleeping_until": None,
            "created": number(state.get("createdAt")) / 1000,
            "updated_at": updated_at, "activity": record.activity if is_alive else None,
            "scheduled": state.get("scheduledTaskId"),
            "check": None, "review": None, "findings_left": 0, "stop": None, "left": 0,
            "lead_verdict": None, "lead_verdict_at": None, "started_by": None,
        }

    def poll(self, root, claude_home, sessions_seconds, session_stale_hours):
        if root is None:
            return []
        previous = {slug: record.summary for slug, record in self.records.items()}
        now = time.monotonic()
        if now >= self._next_sessions_scan:
            self._scan_sessions(root)
            self._next_sessions_scan = now + sessions_seconds
        live_sessions = self._read_live_sessions(claude_home)
        messages = [{"type": "task_removed", "slug": slug}
                    for slug in previous if slug not in self.records]
        for slug, record in self.records.items():
            live = live_sessions.get(record.state.get("cliSessionId"))
            if live is not None and live["status"] == "busy":
                self._session_activity(record, live, claude_home)
                if (record.activity is not None
                        and record.activity["at"] < number(live["statusUpdatedAt"]) / 1000):
                    record.activity = None
            else:
                record.activity = None
            summary = self._session_summary(slug, record, live, root, session_stale_hours)
            if summary != record.summary:
                old_activity = record.summary.get("activity")
                record.summary = summary
                messages.append({"type": "task", "task": summary})
                if summary["activity"] is not None and summary["activity"] != old_activity:
                    messages.append({"type": "activity", "slug": slug, "activity": summary["activity"]})
        return messages
