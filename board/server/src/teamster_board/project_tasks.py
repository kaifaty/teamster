"""Project-owned outcomes and their links to the Board's cached work records."""

import json
import re
import sqlite3
from contextlib import closing
from urllib.parse import urlsplit
from uuid import uuid4

from .actions import string
from .duty_tasks import task_id
from .task_files import ARCHIVED, safe_slug


STATUSES = ("active", "needs_input", "blocked", "ready", "done", "cancelled")
PR_PATH = re.compile(r"/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/(pulls?)/([1-9][0-9]*)/?")
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
    match = PR_PATH.fullmatch(parts.path)
    if not match or any(segment in (".", "..") for segment in match.groups()[:2]):
        return None
    github = parts.hostname == "github.com"
    if match[3] != ("pull" if github else "pulls"):
        return None
    host = parts.netloc.lower()
    if port == (443 if parts.scheme == "https" else 80):
        host = host.rsplit(":", 1)[0]
    return {"provider": "github" if github else "forgejo",
            "url": f"{parts.scheme}://{host}{parts.path.rstrip('/')}"}


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


def _cards(saved, sources):
    cards = dict(saved)
    attached = {ref for card in saved.values() for ref in card["sessions"]}
    for ref, source in sources.items():
        column = source["column"]
        if (ref in cards or ref in attached or source["kind"] == "session"
                or column == "closed" or source["lead_verdict"]):
            continue
        status = "active"
        if column == "review_me":
            status = "ready"
        elif column == "attention":
            status = "needs_input" if source["result_status"] == "needs_decision" else "blocked"
        cards[ref] = _fields(source["repo"], source["slug"], status, [ref])
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
    hidden = set(fields.pop("hidden_prs", ()))
    slug, managed = _managed_links(card["sessions"], sources)
    prs = {pr["url"]: pr for pr in card["pull_requests"]}
    prs.update((url, pr) for url, pr in managed.items() if url not in hidden)
    return dict(fields, id=identity, source_slug=slug, pull_requests=list(prs.values()))


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
    if card["parent_id"] is not None and not safe_slug(card["parent_id"]):
        raise ValueError("Invalid parent_id")
    card["depends_on"] = _refs(card["depends_on"], "depends_on")
    if "sessions" in data:
        slugs = {source["slug"]: ref for ref, source in sources.items()}
        refs = [slugs.get(value, value) for value in data["sessions"]]
        if any(ref not in sources and ref not in current["sessions"] for ref in refs):
            raise ValueError("Unknown session")
        card["sessions"] = list(dict.fromkeys(refs))
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
        if version == 0:
            if create:
                db.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, fields TEXT NOT NULL)")
                db.execute("PRAGMA user_version = 1")
            return {}
        if version != 1:
            raise sqlite3.DatabaseError("Unsupported project task database version")
        return {identity: json.loads(fields) for identity, fields in db.execute("SELECT id, fields FROM tasks")}

    def tasks(self):
        saved = {}
        if self.path.exists():
            with self._connect("ro") as db:
                saved = self._load(db)
        sources = self._sources(saved)
        return [_public(identity, card, sources) for identity, card in _cards(saved, sources).items()]

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
