"""Read the Mini pilot's SQLite state for the Board and Map."""

import sqlite3
import time
from contextlib import closing
from pathlib import Path

from .duty_tasks import task_id
from .store import ARCHIVED, Store, text


def _targets(store: Store, identities, repositories):
    """Link to the exact run, including archives whose slug has been reused."""
    targets = {}
    if not identities:
        return targets

    def add(address, record):
        state = record.state
        slug = state.get("slug")
        identity = task_id(slug, state.get("created"))
        if identity not in identities or identity in targets or state.get("kind", "work") not in ("work", "review"):
            return
        archive = ARCHIVED.fullmatch(address) if record.archived else None
        if (archive[1] if archive else address) != slug:
            return
        repo = text(state.get("repo"))
        if not repo or not Path(repo).is_absolute():
            return
        try:
            if str(Path(repo).resolve()) not in repositories:
                return
        except (OSError, RuntimeError, ValueError):
            return
        targets[identity] = {"task_id": identity, "slug": address, "title": slug}

    with store.lock:
        for address, record in store.records.items():
            add(address, record)
        for slug in {identity.partition(":")[0] for identity in identities - targets.keys()}:
            for address in store.older_archives.get(slug, {}):
                record = store._record(address)
                if record is not None:
                    add(address, record)
    return targets


def read_operator_activity(path: Path, store: Store, repositories):
    current = None
    try:
        with closing(sqlite3.connect(f"{path.absolute().as_uri()}?mode=ro", uri=True, timeout=0.2)) as db:
            db.execute("BEGIN")
            rows = db.execute("""
                SELECT event_id, task_id, turn, started_at, source, recommendation FROM recommendations
                WHERE recommendation IS NOT NULL AND source IN ('mini', 'handoff')
                ORDER BY started_at DESC, event_id DESC LIMIT 50
            """).fetchall()
            if db.execute("SELECT 1 FROM sqlite_schema WHERE name = 'reviewing'").fetchone():
                row = db.execute("""
                    SELECT recommendations.task_id FROM reviewing JOIN recommendations USING (event_id)
                    WHERE expires_at > ? AND recommendation IS NULL ORDER BY expires_at DESC LIMIT 1
                """, (time.time() * 1000,)).fetchone()
                current = row[0] if row is not None else None
    except sqlite3.Error:
        return {"available": False, "current": None, "history": []}

    identities = {row[1] for row in rows}
    if current is not None:
        identities.add(current)
    targets = _targets(store, identities, repositories)
    history = [
        {**targets[identity], "event_id": event, "turn": turn, "started_at": started / 1000,
         "source": source, "recommendation": recommendation.removeprefix(f"{identity}: ")}
        for event, identity, turn, started, source, recommendation in rows if identity in targets
    ]
    return {"available": True, "current": targets.get(current), "history": history}
