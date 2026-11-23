"""Board activity and chat requests shared with the Mini operator."""

import json
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from fastapi.responses import JSONResponse

from . import duty_tasks
from .actions import error
from .external_duty import valid_text
from .store import ARCHIVED, Store, text

CHAT_TIMEOUT_MS = 120_000
CHAT_QUEUE_LIMIT = 4


def _connect(path, mode):
    return closing(sqlite3.connect(f"{path.absolute().as_uri()}?mode={mode}", uri=True, timeout=0.2))


def _targets(store: Store, identities, repositories):
    """Link to the exact run, including archives whose slug has been reused."""
    targets = {}
    if not identities:
        return targets

    def add(address, record):
        state = record.state
        slug = state.get("slug")
        identity = duty_tasks.task_id(slug, state.get("created"))
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


def read_operator_activity(path: Path, store: Store, repositories, *, writable=False):
    current = None
    try:
        with _connect(path, "ro") as db:
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
            chat = writable and db.execute("SELECT 1 FROM sqlite_schema WHERE name = 'chat_requests'").fetchone()
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
    return {"available": True, "current": targets.get(current), "history": history,
            **({"chat": {"projects": sorted({Path(repo).name for repo in repositories})}} if chat else {})}


class OperatorChat:
    def __init__(self, path, store, project_tasks, repositories):
        self.path = path
        self.store = duty_tasks.read_store(store)
        self.project_tasks = project_tasks
        self.repositories = repositories
        self.projects = {Path(repo).name for repo in repositories}

    def _run(self, db, identity):
        card = duty_tasks.task(self.store, self.repositories, identity)
        if card is None:
            return None
        row = db.execute("""
            SELECT recommendation FROM recommendations
            WHERE task_id = ? AND turn = ? AND recommendation IS NOT NULL
            ORDER BY started_at DESC LIMIT 1
        """, (identity, card["turn"])).fetchone()
        saved = card["checks"]["saved"]
        return {
            **{key: card[key] for key in ("slug", "turn", "status", "phase", "executor", "summary", "pr")},
            "project": Path(card["repository"]).name,
            "goal": (card["goal"] or "")[:650], "blocker": (card["blocker"] or "")[:350],
            "saved_check": {"command": saved["command"], "outcome": saved["outcome"],
                            "exit": saved["exit"]} if saved else None,
            "ci": card["checks"]["ci"]["outcome"] if card["checks"]["ci"] else None,
            "recommendation": row[0].removeprefix(f"{identity}: ")[:500] if row else None,
        }

    def _context(self, db, target):
        kind, identity = target.get("kind"), target.get("id")
        if not valid_text(identity, 255):
            raise ValueError
        if kind == "run" and target.keys() == {"kind", "id", "created"}:
            archive = ARCHIVED.fullmatch(identity)
            run = self._run(db, duty_tasks.task_id(archive[1] if archive else identity, target["created"]))
            if run is None:
                raise KeyError(identity)
            return run
        if kind == "project" and target.keys() == {"kind", "id"}:
            card, linked = self.project_tasks.card(identity)
            if card["project"] not in self.projects:
                raise KeyError(identity)
            # A map card can link desktop sessions or runs from other repositories.
            candidates = sorted((ref for ref, record in linked.items()
                                 if record["kind"] in ("work", "review") and record["repo"] in self.projects),
                                key=lambda ref: linked[ref]["updated_at"], reverse=True)
            runs = (self._run(db, ref) for ref in candidates)
            return {**{key: card[key] for key in ("project", "title", "status")},
                    "pull_requests": [pr["url"][:300] for pr in card["pull_requests"][:3]],
                    "linked_run": next((run for run in runs if run is not None), None)}
        raise ValueError

    def send(self, data):
        question, history, target = data.get("question"), data.get("history"), data.get("target")
        if (data.keys() != {"question", "history", "target"} or not valid_text(question, 2000)
                or (target is not None and not isinstance(target, dict))
                or not isinstance(history, list) or len(history) > 2
                or any(not isinstance(pair, dict) or pair.keys() != {"question", "answer"}
                       or not all(valid_text(value, 800) for value in pair.values()) for pair in history)):
            return error(400, "invalid_question")
        try:
            with _connect(self.path, "rw") as db, db:
                context = self._context(db, target) if target is not None else None
                prompt = json.dumps({"task": context, "conversation": history, "question": question.strip()},
                                    ensure_ascii=False)
                # Cap bytes as well as characters to leave room for the model's answer.
                if len(prompt.encode("utf-8", errors="replace")) > 14_000:
                    return error(400, "invalid_question")
                now = int(time.time() * 1000)
                identity = uuid4().hex
                inserted = db.execute("""
                    INSERT INTO chat_requests (id, prompt, deadline) SELECT ?, ?, ?
                    WHERE (SELECT count(*) FROM chat_requests WHERE deadline > ? AND answer IS NULL
                           AND failed = 0) < ?
                """, (identity, prompt, now + CHAT_TIMEOUT_MS, now, CHAT_QUEUE_LIMIT))
                if not inserted.rowcount:
                    return error(429, "operator_busy")
        except ValueError:
            return error(400, "invalid_question")
        except KeyError:
            return error(404, "operator_task_unavailable")
        except (OSError, sqlite3.Error):
            return error(503, "operator_unavailable")
        return JSONResponse({"id": identity}, status_code=202)

    def reply(self, identity):
        if not re.fullmatch(r"[a-f0-9]{32}", identity):
            return error(404, "unknown_question")
        try:
            with _connect(self.path, "ro") as db:
                row = db.execute("SELECT deadline, answer, failed FROM chat_requests WHERE id = ?",
                                 (identity,)).fetchone()
        except sqlite3.Error:
            return error(503, "operator_unavailable")
        if row is None:
            return error(404, "unknown_question")
        deadline, answer, failed = row
        if failed:
            return error(502, "operator_no_answer")
        if answer is None and time.time() * 1000 >= deadline:
            return error(504, "operator_timeout")
        return JSONResponse({"answer": answer}, headers={"Cache-Control": "no-store"})
