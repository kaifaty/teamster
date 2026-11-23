"""Project-owned outcomes and their links to the Board's cached work records."""

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import time
from contextlib import closing
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from .actions import string
from .duty_tasks import _goal, task_id
from .store import ready_for_review
from .task_files import ARCHIVED, Record, alive, directories, line, number, read_state, safe_slug, task_messages, task_queue


TERMINAL = ("done", "cancelled")
STATUSES = ("active", "needs_input", "blocked", "ready", *TERMINAL)
PR_PATH = re.compile(r"/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/(pulls?)/([1-9][0-9]*)")
PR_PREFIX = re.compile(r"(?:/[A-Za-z0-9_.-]+)*")
HOST_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"
PR_HOST = re.compile(rf"(?:{HOST_LABEL}(?:\.{HOST_LABEL})*|\[[0-9a-fA-F:.]+\])(?::[0-9]+)?")


def _pull_request(url):
    if not isinstance(url, str) or re.search(r"[\s\\\x00-\x1f\x7f]", url):
        return None
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not PR_HOST.fullmatch(parts.netloc) or port == 0:
        return None
    segments = parts.path.removesuffix("/").rsplit("/", 4)
    if len(segments) != 5:
        return None
    prefix, owner, repo, route, index = segments
    github = parts.hostname == "github.com"
    if (not PR_PATH.fullmatch(f"/{owner}/{repo}/{route}/{index}") or not PR_PREFIX.fullmatch(prefix)
            or any(segment in (".", "..") for segment in (prefix + f"/{owner}/{repo}").split("/"))
            or (github and prefix) or route != ("pull" if github else "pulls")):
        return None
    host = parts.netloc.lower()
    if port == (443 if parts.scheme == "https" else 80):
        host = host.rsplit(":", 1)[0]
    return {"provider": "github" if github else "forgejo",
            "url": f"{parts.scheme}://{host}{parts.path.rstrip('/')}"}


def _forge_json(*args):
    try:
        command = subprocess.run(args, check=True, capture_output=True, encoding="utf-8",
                                 stdin=subprocess.DEVNULL, timeout=8, env={**os.environ, "GH_PROMPT_DISABLED": "1"})
        return json.loads(command.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def forgejo_logins():
    logins = _forge_json("tea", "login", "list", "--output", "json")
    if not isinstance(logins, list):
        return {}
    trusted = {}
    for login in logins:
        if not isinstance(login, dict):
            continue
        url, name = login.get("url"), login.get("name")
        if not isinstance(url, str) or not isinstance(name, str) or not name:
            continue
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError:
            continue
        if (parsed.scheme in ("https", "http") and PR_HOST.fullmatch(parsed.netloc)
                and not parsed.query and not parsed.fragment):
            origin = (parsed.scheme, parsed.hostname, port or (443 if parsed.scheme == "https" else 80))
            trusted.setdefault((*origin, parsed.path.rstrip("/")), name)
    return trusted


def _pull_request_data(pr, logins, github_fields):
    parts = urlsplit(pr["url"])
    prefix, owner, repo, _, index = parts.path.rsplit("/", 4)
    if pr["provider"] == "github":
        return _forge_json("gh", "pr", "view", f"https://github.com/{owner}/{repo}/pull/{index}",
                           "--json", github_fields)
    else:
        port = parts.port or (443 if parts.scheme == "https" else 80)
        origin = (parts.scheme, parts.hostname, port)
        login = logins.get((*origin, prefix))
        if login is None and not prefix:
            # Older cards could only save root-relative Forgejo links.
            matches = [name for key, name in logins.items() if key[:3] == origin]
            if len(matches) == 1:
                login = matches[0]
        if login is None:
            return None
        return _forge_json("tea", "api", f"--login={login}", f"/repos/{owner}/{repo}/pulls/{index}")


def _status_of_pull_request(data):
    if not isinstance(data, dict) or not isinstance(data.get("state"), str):
        return None
    state = data["state"].lower()
    if data.get("merged") is True or state == "merged":
        return "merged"
    if state == "open" and (data.get("isDraft") is True or data.get("draft") is True):
        return "draft"
    return state if state in ("open", "closed") else None


def pull_request_status(pr, logins):
    return _status_of_pull_request(_pull_request_data(pr, logins, "state,isDraft"))


def pull_request_conflict(pr):
    if pr["provider"] != "github":
        return None
    data = _pull_request_data(pr, {}, "state,isDraft,isCrossRepository,mergeable,headRefName,headRefOid,baseRefName")
    if (_status_of_pull_request(data) != "open" or data.get("isDraft") is not False
            or data.get("isCrossRepository") is not False or data.get("mergeable") != "CONFLICTING"):
        return None
    head, base, branch = (data.get(key) for key in ("headRefOid", "baseRefName", "headRefName"))
    if (not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}", head)
            or not isinstance(base, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}", base)
            or not isinstance(branch, str)):
        return None
    return {"url": pr["url"], "head": head, "base": base, "branch": branch}


def pull_request_evidence(prs):
    logins = forgejo_logins() if any(pr["provider"] == "forgejo" for pr in prs) else {}
    rows = []
    for pr in prs:
        data = _pull_request_data(pr, logins, "state,isDraft,title,body,mergedAt,mergeCommit,baseRefName")
        record = data if isinstance(data, dict) else {}
        rows.append({"url": pr["url"], "status": _status_of_pull_request(data),
                     "title": str(record.get("title") or "")[:200],
                     "description": str(record.get("body") or "")[:2600],
                     "merged_at": record.get("mergedAt") or record.get("merged_at"),
                     "merge_sha": (record.get("mergeCommit") or {}).get("oid") if pr["provider"] == "github" else None,
                     "base": record.get("baseRefName")})
    return rows


def _pull_requests(rows):
    if not isinstance(rows, list):
        raise ValueError("Expected a pull_requests array")
    unique = {}
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"provider", "url"}:
            raise ValueError("Expected a provider and URL for each pull request")
        pr = _pull_request(row["url"])
        if pr is None or pr["provider"] != row["provider"]:
            raise ValueError("Invalid pull request URL or provider")
        unique[pr["url"]] = pr
    return list(unique.values())


def _refs(values, name):
    if not isinstance(values, list) or not all(safe_slug(value) for value in values):
        raise ValueError(f"Expected an array of IDs in {name}")
    return list(dict.fromkeys(values))


def _add_managed(sources, record):
    summary = record.summary
    slug = record.state.get("slug")
    board_slug = summary["slug"]
    if record.archived:
        match = ARCHIVED.fullmatch(board_slug)
        if not match:
            return
        board_slug = match[1]
    if (slug == board_slug and summary["kind"] in ("work", "review", "scout")
            and record.state.get("repo") and safe_slug(summary["repo"])):
        identity = task_id(slug, summary["created"])
        if identity is not None:
            sources[identity] = dict(summary, archived=record.archived)


def _fields(project, title, status="active", sessions=()):
    return {"project": project, "title": title, "status": status, "parent_id": None,
            "depends_on": [], "sessions": list(sessions), "pull_requests": []}


def _managed_status(source):
    verdict = source["lead_verdict"]
    if verdict:
        return "done" if verdict in ("accepted", "revised") else "cancelled"
    if source["kind"] == "scout" and (source["archived"] or not source["alive"]):
        return "done" if source["outcome"] == "completed" else "cancelled"
    ready = ready_for_review(source["result_status"], source["outcome"])
    if source["archived"]:
        return "done" if ready else "cancelled"
    if source["alive"]:
        return "active"
    if ready:
        return "ready"
    return "needs_input" if source["result_status"] == "needs_decision" else "blocked"


def _cards(saved, sources):
    cards = dict(saved)
    attached = {ref for card in saved.values() for ref in card["sessions"]}
    for ref, source in sources.items():
        if source["kind"] == "session":
            continue
        if ref in saved:
            if saved[ref].get("follow_source"):
                cards[ref] = dict(saved[ref], status=_managed_status(source))
        elif ref not in attached:
            status = _managed_status(source)
            if status not in TERMINAL:
                cards[ref] = dict(_fields(source["repo"], source["slug"], status, [ref]),
                                  follow_source=True, title_source="generated")
    return cards


def _managed_links(refs, sources):
    slug = None
    prs = {}
    for ref in refs:
        source = sources.get(ref)
        if source is None or source["kind"] == "session":
            continue
        if slug is None and not source["archived"]:
            slug = source["slug"]
        pr = _pull_request(source["pr"])
        if pr:
            prs[pr["url"]] = pr
    return slug, prs


def _public(identity, card, sources):
    fields = dict(card)
    fields.pop("follow_source", None)
    fields.pop("title_source", None)
    fields.pop("title_revision", None)
    fields.pop("title_frozen", None)
    fields.pop("title_since", None)
    hidden = set(fields.pop("hidden_prs", ()))
    slug, managed = _managed_links(card["sessions"], sources)
    session_slugs = {ref: sources[ref]["slug"] for ref in card["sessions"] if ref in sources}
    prs = {pr["url"]: pr for pr in card["pull_requests"]}
    prs.update((url, pr) for url, pr in managed.items() if url not in hidden)
    return dict(fields, id=identity, source_slug=slug, session_slugs=session_slugs, pull_requests=list(prs.values()))


def _links(card, field):
    if field == "parent_id":
        return [card[field]] if card[field] is not None else []
    return card[field]


def _check_links(identity, card, cards):
    for field in ("parent_id", "depends_on"):
        pending = list(_links(card, field))
        visited = set()
        while pending:
            ref = pending.pop()
            if ref == identity:
                raise ValueError(f"Cycle in {field}")
            if ref not in cards:
                raise ValueError(f"Unknown task ID in {field}")
            if ref not in visited:
                visited.add(ref)
                pending.extend(_links(cards[ref], field))


def _edit(data, current, sources):
    if data.keys() - {"id", "project", "title", "status", "parent_id", "depends_on", "sessions", "pull_requests"}:
        raise ValueError("Unknown project task field")
    card = current | data
    card.pop("id", None)
    card["project"] = string(card, "project", 255, required=True)
    if not safe_slug(card["project"]):
        raise ValueError("Invalid project name")
    card["title"] = string(card, "title", 200, required=True)
    if card["status"] not in STATUSES:
        raise ValueError("Invalid project task status")
    if "title" in data:
        card["title_source"] = "manual"
        card.pop("title_revision", None)
        card.pop("title_since", None)
    elif card.get("title_source") in ("generated", "operator"):
        card.setdefault("title_since", time.time())
    if current["status"] in TERMINAL or card["status"] in TERMINAL:
        card["title_frozen"] = True
    if card["parent_id"] is not None and not safe_slug(card["parent_id"]):
        raise ValueError("Invalid parent_id")
    card["depends_on"] = _refs(card["depends_on"], "depends_on")
    if "sessions" in data:
        slugs = {source["slug"]: ref for ref, source in sources.items()}
        refs = [slugs.get(value, value) for value in data["sessions"]]
        if any(ref not in sources and ref not in current["sessions"] for ref in refs):
            raise ValueError("Unknown session")
        card["sessions"] = list(dict.fromkeys(refs))
    if "status" in data or data.get("id") not in card["sessions"]:
        card.pop("follow_source", None)
    if "pull_requests" in data:
        card["pull_requests"] = _pull_requests(data["pull_requests"])
        # Replacing the displayed list can also remove a managed URL. New publications still appear.
        _, managed = _managed_links(current["sessions"], sources)
        hidden = set(card.get("hidden_prs", ())) | managed.keys()
        card["hidden_prs"] = sorted(hidden.difference(pr["url"] for pr in card["pull_requests"]))
    return card


class ProjectTasks:
    def __init__(self, path, store):
        self.path = path
        self.store = store
        self._archives = {}

    def _sources(self, saved, requested=()):
        refs = {ref for card in saved.values() for ref in card["sessions"]}
        refs.update(requested)
        with self.store.lock:
            sources = {slug: record.summary for slug, record in self.store.session_records.items()}
            for record in self.store.records.values():
                _add_managed(sources, record)
            # Resolve only missing links against the poll's archive index, including reused slugs.
            older = {}
            for ref in refs - sources.keys():
                match = ARCHIVED.fullmatch(ref)
                if match:
                    group = self.store.older_archives.get(match[1], {})
                    if ref in group:
                        older[ref] = group[ref]
                elif ":" in ref:
                    older.update(self.store.older_archives.get(ref.partition(":")[0], {}))
            cached = {}
            for name, signature in older.items():
                previous, record = self._archives.get(name, (None, None))
                if signature != previous:
                    record = self.store._record(name)
                elif record is not None:
                    # A new journal verdict can arrive after clean without changing state.json.
                    record.summary = self.store._summary(name, record)
                if record is not None:
                    _add_managed(sources, record)
                    cached[name] = (signature, record)
            self._archives = cached
            return sources

    def _connect(self, mode):
        if self.path.is_symlink():
            raise OSError("The project task database is a symbolic link")
        return closing(sqlite3.connect(f"{self.path.absolute().as_uri()}?mode={mode}", uri=True))

    @staticmethod
    def _load(db, *, create=False):
        version, = db.execute("PRAGMA user_version").fetchone()
        if version not in (0, 1, 2):
            raise sqlite3.DatabaseError("Unsupported project task database version")
        if version == 0:
            if not create:
                return {}
            db.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, fields TEXT NOT NULL)")
        saved = {identity: json.loads(fields) for identity, fields in db.execute("SELECT id, fields FROM tasks")}
        if version == 1:
            # V1 stored plain snapshots for parent/dependency pins, without their status origin.
            linked = {ref for card in saved.values() for ref in _links(card, "parent_id") + card["depends_on"]}
            for ref in linked:
                card = saved[ref]
                if (card["status"] not in TERMINAL
                        and card == _fields(card["project"], ref.partition(":")[0], card["status"], [ref])):
                    card["follow_source"] = True
                    if create:
                        db.execute("UPDATE tasks SET fields = ? WHERE id = ?", (json.dumps(card, ensure_ascii=False), ref))
        if create and version < 2:
            db.execute("PRAGMA user_version = 2")
        return saved

    def _saved(self):
        if not self.path.exists():
            return {}
        with self._connect("ro") as db:
            db.execute("BEGIN")
            return self._load(db)

    def _view(self):
        saved = self._saved()
        sources = self._sources(saved)
        return _cards(saved, sources), sources

    def tasks(self):
        cards, sources = self._view()
        return [_public(identity, card, sources) for identity, card in cards.items()]

    def card(self, identity):
        cards, sources = self._view()
        task = _public(identity, cards[identity], sources)
        return task, {ref: sources[ref] for ref in task["session_slugs"]}

    def details(self, identity):
        task, linked = self.card(identity)
        sessions = {ref: summary.copy() for ref, summary in linked.items()}
        work = {}
        with self.store.lock:
            for ref, summary in linked.items():
                if summary["kind"] not in ("work", "review", "scout"):
                    continue
                record = self.store._record(summary["slug"])
                if record is None or record.state.get("created") != summary["created"]:
                    continue
                messages = task_messages(self.store._file(record.path, "messages.jsonl"))
                queue = [] if record.archived else task_queue(self.store._file(record.path, "queue.json"))["waiting"]
                started = number(record.state.get("turn_started"))
                recent = {}
                if summary["alive"]:
                    activities = (item for tail in record.tails.values() for item in tail.activities
                                  if item["kind"] != "thinking" and item["text"]
                                  and started is not None and item["at"] >= started)
                    for item in sorted(activities, key=lambda item: item["at"])[::-1]:
                        recent.setdefault((item["kind"], item["text"]), item)
                        if len(recent) == 5:
                            break
                work[ref] = {
                    "goal": (_goal(self.store._file(record.path, "brief.md")) or "")[:600] or None,
                    "order": next((item for item in reversed(messages) if item["source"] == "lead"), None),
                    "next_order": queue[0] if queue else None,
                    "queued": len(queue),
                    "turn_started_at": started,
                    "check_command": line(record.state.get("check")) if summary["phase"] == "check" else None,
                    "recent_activity": list(recent.values()),
                }
        for summary in sessions.values():
            summary.pop("archived", None)
        return sessions, task["pull_requests"], work

    def _title_candidate(self, identity, card, source, repositories, *, fresh=False):
        if (card is None or card.get("title_source") not in ("generated", "operator")
                or card.get("title_frozen") or card["status"] in TERMINAL or identity not in card["sessions"]
                or source is None or source["archived"] or source["repo"] != card["project"]):
            return None
        slug = source["slug"]
        record = Record(self.store.tasks_path / slug, False)
        read_state(record)
        state = record.state
        repo = state.get("repo")
        if (not isinstance(repo, str) or not Path(repo).is_absolute() or state.get("slug") != slug
                or task_id(slug, state.get("created")) != identity):
            return None
        checkout = Path(repo).resolve()
        if not any(checkout.is_relative_to(root) and checkout.name == root.name for root in repositories):
            return None
        verdict_from = self.store.lead_verdict if fresh else self.store._journal.lead_verdict
        _, verdict_at = verdict_from(slug, record, source["repo"], current=False)
        turn_at = max(number(state.get(key)) or 0 for key in ("turn_started", "turn_finished"))
        if verdict_at is not None and (verdict_at > turn_at or verdict_at >= card.get("title_since", float("inf"))):
            return None
        goal = (_goal(self.store._file(record.path, "brief.md")) or "")[:1800]
        report = state.get("result")
        summary = report.get("summary") if isinstance(report, dict) else None
        summary = summary.strip()[:600] if isinstance(summary, str) else ""
        if not (goal or summary):
            return None
        revision = hashlib.sha256(json.dumps([goal, summary]).encode("utf-8")).hexdigest()
        if revision == card.get("title_revision"):
            return None
        return dict(id=identity, revision=revision, title=card["title"], goal=goal, summary=summary)

    def title_candidates(self, repositories):
        cards, sources = self._view()
        repositories = {Path(repo) for repo in repositories}
        with self.store.lock:
            return [candidate for identity, card in sorted(cards.items())
                    if (candidate := self._title_candidate(identity, card, sources.get(identity), repositories))]

    def update_title(self, identity, revision, title, repositories):
        with self._connect("rwc") as db, db:
            db.execute("BEGIN IMMEDIATE")
            saved = self._load(db)
            sources = self._sources(saved)
            card = _cards(saved, sources).get(identity)
            candidate = self._title_candidate(identity, card, sources.get(identity),
                                              {Path(repo) for repo in repositories}, fresh=True)
            if candidate is None or candidate["revision"] != revision:
                return False
            card = dict(card, title_revision=revision)
            card.setdefault("title_since", time.time())
            if title is not None:
                card.update(title=title, title_source="operator")
            self._load(db, create=True)
            db.execute("INSERT OR REPLACE INTO tasks VALUES (?, ?)", (identity, json.dumps(card, ensure_ascii=False)))
            return True

    def scout_history(self, project):
        """Read unlinked finished scouts, including archives outside the Board's polling window."""
        linked = {ref for card in self._saved().values() for ref in card["sessions"]}
        history = []
        for folder, archived in ((self.store.tasks_path, False), (self.store.tasks_path / ".archive", True)):
            for path in directories(folder):
                record = Record(path, archived)
                read_state(record)
                state = record.state
                repo = state.get("repo")
                if state.get("kind") != "scout" or not isinstance(repo, str) or Path(repo).name != project:
                    continue
                if not archived and alive(state.get("pid")):
                    continue
                match = ARCHIVED.fullmatch(path.name) if archived else None
                slug = match[1] if match else path.name
                if slug != state.get("slug") or archived and not match:
                    continue
                created = number(state.get("created"))
                identity = task_id(slug, created)
                if identity is not None and identity not in linked:
                    history.append({"id": identity, "slug": path.name, "title": slug, "created": created})
        return sorted(history, key=lambda row: (row["created"], row["slug"]), reverse=True)

    def save(self, data):
        if "sessions" in data:
            data = dict(data, sessions=_refs(data["sessions"], "sessions"))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect("rwc") as db, db:
            db.execute("BEGIN IMMEDIATE")
            saved = self._load(db, create=True)
            sources = self._sources(saved, data.get("sessions", ()))
            cards = _cards(saved, sources)
            if "id" in data:
                identity = data["id"]
                if not safe_slug(identity):
                    raise ValueError("Invalid project task ID")
                if identity not in cards:
                    raise KeyError(identity)
                current = cards[identity]
            else:
                identity = str(uuid4())
                current = _fields(None, None)
            card = _edit(data, current, sources)
            _check_links(identity, card, cards)
            # Referenced projections get durable IDs even after their records leave the poll window.
            changes = {ref: cards[ref] for ref in _links(card, "parent_id") + card["depends_on"] if ref not in saved}
            changes[identity] = card
            attached = set()
            for row in (saved | changes).values():
                for ref in row["sessions"]:
                    if ref in attached:
                        raise ValueError("Session already attached to another project task")
                    attached.add(ref)
            db.executemany("INSERT OR REPLACE INTO tasks VALUES (?, ?)",
                           ((key, json.dumps(row, ensure_ascii=False)) for key, row in changes.items()))
            return _public(identity, card, sources)
