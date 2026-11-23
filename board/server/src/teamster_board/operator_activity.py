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
from .store import ARCHIVED, Store, cargo, mapping, text

CHAT_TIMEOUT_MS = 120_000
CHAT_QUEUE_LIMIT = 4
RUN_KINDS = ("work", "review", "scout", "reflect")
SEARCH_PAGE = 8


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
            **({"chat": True} if chat else {})}


class OperatorChat:
    def __init__(self, path, store, project_tasks, resolution):
        self.path = path
        self.store = store
        self.project_tasks = project_tasks
        self.resolution = resolution

    def _journal(self, db, card, linked):
        identities = card["sessions"]
        rows = db.execute("""
            SELECT event_id, task_id, turn, started_at, source, recommendation FROM recommendations
            WHERE recommendation IS NOT NULL AND source IN ('mini', 'handoff')
              AND task_id IN (SELECT value FROM json_each(?))
            ORDER BY started_at DESC, event_id DESC
        """, (json.dumps(identities),)).fetchall()
        recommendations = [
            {"event_id": event, "task_id": identity, "slug": linked.get(identity, {}).get("slug", identity.partition(":")[0]),
             "title": identity.partition(":")[0], "turn": turn, "started_at": at / 1000, "source": source,
             "recommendation": value.removeprefix(f"{identity}: ")}
            for event, identity, turn, at, source, value in rows
        ]
        return {**self.resolution.view(card["id"]), "recommendations": recommendations,
                "commands": self.resolution.commands(identities)}

    def journal(self, identity):
        card, linked = self.project_tasks.card(identity)
        if not self.path.is_file():
            return {**self.resolution.view(identity), "commands": self.resolution.commands(card["sessions"]),
                    "recommendations": []}
        with _connect(self.path, "ro") as db:
            data = self._journal(db, card, linked)
            if db.execute("SELECT 1 FROM sqlite_schema WHERE name='project_chat'").fetchone():
                db.row_factory = sqlite3.Row
                chat = db.execute("""
                    SELECT h.id, h.at, h.question, h.reference, r.answer,
                        CASE WHEN r.answer IS NOT NULL THEN 'answered'
                             WHEN r.failed OR r.deadline <= ? THEN 'failed' ELSE 'pending' END AS status
                    FROM project_chat h JOIN chat_requests r USING (id)
                    WHERE h.card = ? ORDER BY h.at, h.id
                """, (int(time.time() * 1000), identity)).fetchall()
                data["chat"] = [dict(row) for row in chat]
        return data

    def _reference(self, db, identity, reference):
        journal = self._journal(db, *self.project_tasks.card(identity))
        for kind, name, key in (("recommendation", "recommendations", "event_id"),
                                ("resolution", "events", "seq"), ("command", "commands", "id")):
            for row in journal[name]:
                if reference == f"{kind}:{row[key]}":
                    return {"kind": kind, "record": json.dumps(row, ensure_ascii=False)[:900]}
        raise KeyError(reference)

    def _run(self, db, address, *, created=None):
        with self.store.lock:
            record = self.store._record(address)
            if record is None or record.summary["kind"] not in RUN_KINDS:
                return None
            summary, state = record.summary, record.state
            if created is not None and summary["created"] != created:
                return None
            evidence = cargo(state)
            report = text(mapping(state.get("result")).get("summary")) or summary["summary"]
            brief = self.store.file_path(address, "brief")
            identity = duty_tasks.task_id(state.get("slug"), summary["created"])
            status = duty_tasks.task_status(state, summary["alive"] and not record.archived)
        row = db.execute("""
            SELECT recommendation FROM recommendations
            WHERE task_id = ? AND turn = ? AND recommendation IS NOT NULL
            ORDER BY started_at DESC LIMIT 1
        """, (identity, summary["turn"])).fetchone()
        checks = sorted(evidence["claims"], key=lambda check: check["outcome"] == "passed")
        return {
            **{key: summary[key] for key in (
                "slug", "turn", "column", "phase", "executor", "outcome", "result_status", "pr", "lead_verdict",
            )},
            "project": summary["repo"], "status": status, "summary": (report or "")[:650],
            "goal": (duty_tasks._goal(brief) or "")[:400],
            "saved_check": evidence["check"],
            "reported_checks": checks[:4],
            "ci": {key: evidence["ci"][key] for key in ("outcome", "failing")} if evidence["ci"] else None,
            "remaining": evidence["remaining"][:4], "questions": evidence["questions"][:3],
            "review": evidence["review"]["verdict"] if evidence["review"] else None,
            "recommendation": row[0].removeprefix(f"{identity}: ")[:350] if row else None,
        }

    def _project_task(self, db, identity):
        card, linked = self.project_tasks.card(identity)
        runs = sorted((run for run in linked.values() if run["kind"] in RUN_KINDS),
                      key=lambda run: run["updated_at"], reverse=True)
        latest = next((entry for run in runs
                       if (entry := self._run(db, run["slug"], created=run["created"])) is not None), None)
        return {
            **{key: card[key] for key in ("id", "project", "title", "status", "parent_id")},
            "depends_on": card["depends_on"][:8],
            "linked_runs": [{"id": run["slug"], "outcome": run["outcome"]} for run in runs[:8]],
            "pull_requests": [pr["url"][:300] for pr in card["pull_requests"][:3]],
            "linked_run": latest,
        }

    def _context(self, db, target):
        kind, identity = target.get("kind"), target.get("id")
        if not valid_text(identity, 255):
            raise ValueError
        if kind == "run" and target.keys() == {"kind", "id", "created"}:
            if type(target["created"]) not in (int, float):
                raise ValueError
            run = self._run(db, identity, created=target["created"])
            if run is None:
                raise KeyError(identity)
            return run
        if kind == "project" and target.keys() == {"kind", "id"}:
            return self._project_task(db, identity)
        raise ValueError

    def _catalog(self):
        for task in self.project_tasks.tasks():
            yield ({"kind": "project", "id": task["id"], "title": task["title"],
                    "project": task["project"], "status": task["status"]},
                   tuple(task["session_slugs"].values()))
        for run in self.store.summaries():
            if run["repo"] and run["kind"] in RUN_KINDS:
                yield ({"kind": "run", "id": run["slug"], "title": run["title"] or run["slug"],
                        "project": run["repo"], "status": run["outcome"] or run["column"]}, ())

    def _search(self, query, project, status, offset):
        matches = []
        for row, aliases in self._catalog():
            if project and project != row["project"].casefold() or status and status != row["status"]:
                continue
            names = tuple(name.casefold() for name in (row["id"], row["title"], *aliases))
            if query in names:
                rank = 0
            elif any(query in name for name in names):
                rank = 1
            elif all(any(word in name for name in names) for word in query.split()):
                rank = 2
            else:
                continue
            matches.append((rank, row["kind"], row["title"].casefold(), row["id"], row))
        matches.sort(key=lambda match: match[:4])
        end = offset + SEARCH_PAGE
        return {"tasks": [row for _, _, _, _, row in matches[offset:end]],
                "total": len(matches), "next_offset": end if end < len(matches) else None}

    def read(self, identity, view, query, project, status, offset, kind, card_id):
        if not re.fullmatch(r"[a-f0-9]{32}", identity):
            return 404, {"error": "chat_inactive"}
        with _connect(self.path, "ro") as db:
            active = db.execute("""
                SELECT 1 FROM chat_requests WHERE id = ? AND claimed = 1 AND deadline > ?
                AND answer IS NULL AND failed = 0
            """, (identity, int(time.time() * 1000))).fetchone()
            if not active:
                return 404, {"error": "chat_inactive"}
            if view == "projects":
                names = sorted({row["project"] for row, _ in self._catalog()})
                return 200, {"projects": names[offset:offset + 24],
                             "next_offset": offset + 24 if offset + 24 < len(names) else None}
            if view == "search":
                return 200, self._search(query.strip().casefold(), project.strip().casefold(), status, offset)
            if view == "card" and valid_text(card_id, 255):
                if kind == "project":
                    try:
                        return 200, {"task": self._project_task(db, card_id)}
                    except KeyError:
                        pass
                if kind == "run":
                    run = self._run(db, card_id)
                    if run is not None:
                        return 200, {"task": run}
                return 404, {"error": "task_not_found"}
        return 400, {"error": "invalid_read"}

    def send(self, data):
        question, history, target = data.get("question"), data.get("history"), data.get("target")
        reference = data.get("reference")
        project = target.get("id") if isinstance(target, dict) and target.get("kind") == "project" else None
        if (data.keys() - {"reference"} != {"question", "history", "target"} or not valid_text(question, 2000)
                or (target is not None and not isinstance(target, dict))
                or ("reference" in data and (project is None or not valid_text(reference, 270)))
                or not isinstance(history, list) or len(history) > 2
                or any(not isinstance(pair, dict) or pair.keys() != {"question", "answer"}
                       or not all(valid_text(value, 800) for value in pair.values()) for pair in history)):
            return error(400, "invalid_question")
        try:
            with _connect(self.path, "rw") as db, db:
                context = self._context(db, target) if target is not None else None
                payload = {"task": context, "conversation": history, "question": question.strip()}
                if reference is not None:
                    payload["event"] = self._reference(db, project, reference)
                prompt = json.dumps(payload, ensure_ascii=False)
                # Cap bytes as well as characters to leave room for the model's answer.
                if len(prompt.encode("utf-8", errors="replace")) > 18_000:
                    return error(400, "invalid_question")
                now = int(time.time() * 1000)
                identity = uuid4().hex
                durable = project is not None and db.execute(
                    "SELECT 1 FROM sqlite_schema WHERE name='project_chat'").fetchone()
                if durable:
                    db.execute("BEGIN IMMEDIATE")
                    if db.execute("""SELECT 1 FROM project_chat h JOIN chat_requests r USING (id)
                                     WHERE h.card=? AND r.deadline>? AND r.answer IS NULL AND r.failed=0""",
                                  (project, now)).fetchone():
                        return error(429, "operator_busy")
                inserted = db.execute("""
                    INSERT INTO chat_requests (id, prompt, deadline) SELECT ?, ?, ?
                    WHERE (SELECT count(*) FROM chat_requests WHERE deadline > ? AND answer IS NULL
                           AND failed = 0) < ?
                """, (identity, prompt, now + CHAT_TIMEOUT_MS, now, CHAT_QUEUE_LIMIT))
                if not inserted.rowcount:
                    return error(429, "operator_busy")
                if durable:
                    db.execute("INSERT INTO project_chat VALUES (?, ?, ?, ?, ?)",
                               (identity, project, now / 1000, question.strip(), reference))
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
