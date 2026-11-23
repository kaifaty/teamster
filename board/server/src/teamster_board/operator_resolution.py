"""Explicitly delegated resolutions and their durable command receipts."""

import fcntl
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
from contextlib import closing, contextmanager
from pathlib import Path
from uuid import uuid4

from . import duty_tasks
from .external_duty import valid_text
from .store import ARCHIVED, Store, alive


TERMINAL = ("archived", "cleanup_blocked", "revoked")
SCHEMA = """
CREATE TABLE IF NOT EXISTS operator_resolutions (
    card TEXT PRIMARY KEY, run TEXT NOT NULL UNIQUE, generation TEXT NOT NULL,
    rule TEXT NOT NULL, evidence TEXT, phrase TEXT, status TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS operator_resolution_events (
    seq INTEGER PRIMARY KEY, card TEXT NOT NULL, generation TEXT NOT NULL, actor TEXT NOT NULL,
    kind TEXT NOT NULL, at REAL NOT NULL, detail TEXT NOT NULL, event_key TEXT NOT NULL UNIQUE
);
"""


def _key(*values):
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()[:32]


def _normalize(value):
    return " ".join(value.casefold().split())


class OperatorResolution:
    def __init__(self, board):
        self.board = board
        self.store = board.store
        self.home = board.settings.task_home.resolve()
        self.ledger = self.home / "external-duty"

    @contextmanager
    def _db(self, *, write=False):
        if write:
            self.ledger.mkdir(mode=0o700, parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.ledger / "commands.sqlite3", timeout=2)) as db:
            db.row_factory = sqlite3.Row
            if write:
                db.executescript(SCHEMA)
            yield db

    @contextmanager
    def _exclusive(self):
        self.ledger.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self.board.actions.lock, (self.ledger / "commands.lock").open("ab") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield lock.fileno()

    @staticmethod
    def _event(db, row, kind, detail, *, actor="operator"):
        db.execute("""INSERT OR IGNORE INTO operator_resolution_events
            (card, generation, actor, kind, at, detail, event_key) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                   (row["card"], row["generation"], actor, kind, time.time(), json.dumps(detail, ensure_ascii=False),
                    _key(row["generation"], kind, detail)))

    def _status(self, db, row, kind, detail, *, payload=None):
        with db:
            self._event(db, row, kind, detail)
            db.execute("UPDATE operator_resolutions SET status=?, payload=? WHERE card=?",
                       (kind, row["payload"] if payload is None else json.dumps(payload, ensure_ascii=False), row["card"]))
        return dict(row, status=kind, payload=row["payload"] if payload is None else json.dumps(payload, ensure_ascii=False))

    def _run(self, identity=None, *, address=None, archives=False):
        slug = identity.partition(":")[0] if identity else address
        with self.store.lock:
            def get(path):
                record = self.store._record(path)
                if record is None or (record.archived and not archives):
                    return None
                self.store._read_state(record)
                state = record.state
                actual = duty_tasks.task_id(state.get("slug"), state.get("created"))
                base = ARCHIVED.fullmatch(path) if record.archived else None
                if (not actual or (identity is not None and identity != actual)
                        or (base[1] if base else path) != state.get("slug")
                        or state.get("kind", "work") not in ("work", "review")):
                    return None
                return record, actual, state.copy()

            found = get(address or slug)
            if found or not archives or not identity:
                return found
            for name in (*self.store.records, *self.store.older_archives.get(slug, {})):
                match = ARCHIVED.fullmatch(name)
                if match and match[1] == slug and (found := get(name)):
                    return found
        return None

    def view(self, card=None):
        if not (self.ledger / "commands.sqlite3").is_file():
            return {"assignment": None, "events": []} if card else {"tasks": []}
        try:
            with self._db() as db:
                if not db.execute("SELECT 1 FROM sqlite_schema WHERE name='operator_resolutions'").fetchone():
                    return {"assignment": None, "events": []} if card else {"tasks": []}
                if card is None:
                    rows = db.execute("""SELECT card, run, status FROM operator_resolutions
                                         WHERE status NOT IN ('archived', 'revoked') ORDER BY card""").fetchall()
                    return {"tasks": [dict(row) for row in rows]}
                assignment = db.execute(
                    "SELECT card, run, rule, evidence, phrase, status FROM operator_resolutions WHERE card=?", (card,)
                ).fetchone()
                rows = db.execute("""SELECT seq, actor, kind, at, detail FROM operator_resolution_events
                    WHERE card=? ORDER BY seq""", (card,)).fetchall()
                return {"assignment": dict(assignment) if assignment else None,
                        "events": [dict(row, detail=json.loads(row["detail"])) for row in rows]}
        except sqlite3.OperationalError:
            if not (self.ledger / "commands.sqlite3").exists():
                return {"assignment": None, "events": []} if card else {"tasks": []}
            raise

    def commands(self, sessions):
        """Read confirmed external-duty commands by stable run identity."""
        if not sessions or not (self.ledger / "commands.sqlite3").is_file():
            return []
        with self._db() as db:
            if not db.execute("SELECT 1 FROM sqlite_schema WHERE name='commands'").fetchone():
                return []
            rows = db.execute("""SELECT actor, request_id, target, intent, result, finished_at FROM commands
                                 WHERE status IN (200, 201) AND finished_at IS NOT NULL
                                   AND target IN (SELECT value FROM json_each(?))
                                 ORDER BY finished_at""", (json.dumps(sessions),)).fetchall()
        commands = []
        for row in rows:
            route, _, args = json.loads(row["intent"])
            run = json.loads(row["result"])["task"]
            commands.append({
                "id": row["actor"] + ":" + row["request_id"], "actor": row["actor"],
                "run": row["target"], "slug": run["slug"], "action": route, "at": row["finished_at"],
                "executor": run["executor"], "account": run.get("account"), "model": run.get("model"),
                "text": args.get("goal") if route == "start" else args.get("message"),
            })
        return commands

    def assign(self, data):
        card = data.get("card")
        if not Store._safe_slug(card):
            raise ValueError("Invalid project card")
        with self._exclusive(), self._db(write=True) as db, db:
            old = db.execute("SELECT * FROM operator_resolutions WHERE card=?", (card,)).fetchone()
            if data.keys() == {"card", "revoke"} and data["revoke"] is True:
                if old and old["status"] not in ("archived", "revoked"):
                    self._event(db, old, "revoked", {}, actor="user")
                    db.execute("UPDATE operator_resolutions SET status='revoked' WHERE card=?", (card,))
                return
            rule = data.get("rule")
            fields = {"card", "run", "rule"}
            if rule == "negative":
                fields |= {"evidence", "phrase"}
            if (data.keys() != fields or rule not in ("verdict", "negative")
                    or not valid_text(data.get("run"), 255) or
                    rule == "negative" and (not Store._safe_slug(data.get("evidence"))
                                           or not valid_text(data.get("phrase"), 400)
                                           or len(_normalize(data["phrase"])) < 12)):
                raise ValueError("Invalid resolution rule")
            if old and old["status"] not in TERMINAL:
                raise ValueError("Revoke the current delegation first")
            task, linked = self.board.project_tasks.card(card)
            run = data["run"]
            if run not in linked or not self._run(run):
                raise ValueError("Choose a linked managed run")
            other = db.execute("SELECT card FROM operator_resolutions WHERE run=? AND card<>?", (run, card)).fetchone()
            if other:
                raise ValueError("Run already has a resolution record")
            evidence = None
            if rule == "negative":
                found = self._run(address=data["evidence"], archives=True)
                if not found or found[1] == run:
                    raise ValueError("Choose a different managed evidence run")
                evidence = found[1]
            # Persist a projected card before any terminal verdict can hide its projection.
            self.board.project_tasks.save({"id": task["id"]})
            row = {"card": card, "generation": uuid4().hex}
            db.execute("""INSERT OR REPLACE INTO operator_resolutions
                (card, run, generation, rule, evidence, phrase, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')""",
                       (card, run, row["generation"], rule, evidence, data.get("phrase")))
            self._event(db, row, "delegated", {"run": run, "rule": rule, "evidence": evidence,
                                               "phrase": data.get("phrase")}, actor="user")

    @staticmethod
    def _version(state):
        return _key(state)

    def _verdict(self, record, state):
        return self.store.lead_verdict(record.summary["slug"], record, Path(state["repo"]).name)[0]

    def _command(self, lock_fd, subcommand, operation, args):
        env = dict(os.environ)
        if self.board.settings.layout == "legacy":
            env.pop("TEAMSTER_HOME", None)
            env["CODEX_TASK_HOME"] = str(self.home)
        else:
            env["TEAMSTER_HOME"] = str(self.home)
        command = [sys.executable, "-I", str(self.board.settings.teamster), subcommand, operation["slug"],
                   "--expect-created", str(operation["created"]), "--expect-turn", str(operation["turn"]),
                   "--operation-id", operation["id"], *args]
        try:
            proc = subprocess.run(command, capture_output=True, text=True, errors="replace", env=env,
                                  cwd=self.home, timeout=120, pass_fds=(lock_fd,))
        except subprocess.TimeoutExpired:
            return None, "Teamster command timed out"
        except OSError as exc:
            return False, str(exc)
        if proc.returncode < 0:
            return None, "Teamster command was interrupted"
        if proc.returncode:
            reason = proc.stderr.strip()[-800:] or "Teamster rejected the command"
            if subcommand == "clean":
                path = self.board.settings.path("tasks") / ".archive" / ".operator-receipts" / (operation["id"] + ".json")
                try:
                    if json.loads(path.read_text()).get("phase") in ("verified", "archived"):
                        return None, reason
                except (OSError, ValueError):
                    pass
            return False, reason
        try:
            receipt = json.loads(proc.stdout)
        except ValueError:
            receipt = None
        if (not isinstance(receipt, dict) or receipt.get("operation_id") != operation["id"]
                or (subcommand == "clean" and (receipt.get("phase") != "archived"
                    or receipt.get("sha") != operation["sha"] or not receipt.get("archive")
                    or not isinstance(receipt.get("files"), int)))):
            return None, "Teamster returned no verified receipt"
        return True, receipt

    def _execute(self, db, row, lock_fd):
        operation = json.loads(row["payload"])
        is_verdict = row["status"] == "verdict_started"
        args = ["dropped", f"--note={operation['note']}"] if is_verdict else [
            "--archive-safe", "--expect-head", operation["sha"], "--expect-verdict", operation["verdict"],
        ]
        ok, receipt = self._command(lock_fd, "verdict" if is_verdict else "clean", operation, args)
        if ok is None:
            attempts = operation.get("unconfirmed", 0) + 1
            operation["unconfirmed"] = attempts
            self._status(db, row, row["status"] if attempts < 2 else "cleanup_blocked",
                         {"reason": receipt, "operation": operation["id"], "attempt": attempts}, payload=operation)
            return
        if not ok:
            self._status(db, row, "cleanup_blocked", {"reason": receipt, "operation": operation["id"]})
            return
        if is_verdict:
            self._status(db, row, "verdict_recorded", {"operation": operation["id"], "verdict": "dropped",
                                                      "run": row["run"], "turn": operation["turn"],
                                                      "evidence": operation["evidence"]})
        else:
            self._status(db, row, "archived", {"operation": operation["id"], "sha": receipt["sha"],
                                              "archive": receipt["archive"], "files": receipt["files"]})
        return

    def _step(self, db, row, lock_fd):
        if row["status"] == "verdict_started":
            operation = json.loads(row["payload"])
            source = self._run(row["evidence"], archives=True)
            if not source or self._version(source[2]) != operation["evidence"]["version"]:
                self._status(db, row, "needs_decision", {"reason": "Evidence changed before the verdict was confirmed",
                          "operation": operation["id"], "evidence": operation["evidence"]})
                return False
        if row["status"] in ("verdict_started", "archive_started"):
            self._execute(db, row, lock_fd)
            return True
        current = self._run(row["run"])
        if not current:
            self._status(db, row, "cleanup_blocked", {"reason": "Run is no longer at its original address"})
            return False
        record, _, state = current
        turn = state.get("turns", 0)
        if alive(state.get("pid")) or not state.get("turn_finished") or state.get("pending"):
            self._status(db, row, "waiting_run", {"run": row["run"], "turn": turn})
            return False
        try:
            card, linked = self.board.project_tasks.card(row["card"])
        except KeyError:
            linked = {}
        if row["run"] not in linked:
            self._status(db, row, "cleanup_blocked", {"reason": "Run is no longer linked to the delegated card"})
            return False
        version = self._version(state)
        verdict = self._verdict(record, state)
        if not verdict and card["status"] in ("done", "cancelled") and row["status"] != "verdict_recorded":
            self._status(db, row, "needs_decision", {"reason": "Project card was closed without a current run verdict"})
            return False
        if not verdict and row["rule"] == "verdict":
            self._status(db, row, "waiting_verdict", {"turn": turn})
            return False
        if not verdict and row["status"] == "verdict_recorded":
            # Store's poll may not have observed the just-written journal row yet.
            return False
        operation = {"slug": state["slug"], "created": state["created"], "turn": turn, "version": version}
        if not verdict:
            source = self._run(row["evidence"], archives=True)
            if source is None:
                self._status(db, row, "needs_decision", {"reason": "Evidence run is unavailable", "evidence": row["evidence"]})
                return False
            source_state = source[2]
            evidence = {"run": row["evidence"], "slug": source[0].summary["slug"],
                        "turn": source_state.get("turns"), "version": self._version(source_state)}
            if alive(source_state.get("pid")) or not source_state.get("turn_finished"):
                self._status(db, row, "waiting_evidence", {"evidence": row["evidence"],
                                                           "turn": source_state.get("turns")})
                return False
            result = source_state.get("result") or {}
            report = result.get("summary") or ""
            if (source_state.get("outcome") != "completed" or result.get("status") != "done"
                    or _normalize(row["phrase"]) not in _normalize(report)):
                self._status(db, row, "needs_decision", {"reason": "Evidence does not confirm the rule",
                                                           "evidence": evidence, "report": report[:1000]})
                return False
            evidence["report"] = report[:4000]
            note = f"Experiment dropped by operator. Evidence: {evidence['slug']} turn {evidence['turn']}. {row['phrase']}"
            operation.update(id=_key(row["generation"], "verdict", version, evidence["version"]), note=note,
                             evidence=evidence)
            started = self._status(db, row, "verdict_started", operation, payload=operation)
            self._execute(db, started, lock_fd)
            return True
        terminal = "done" if verdict in ("accepted", "revised") else "cancelled"
        if card["status"] != terminal:
            self.board.project_tasks.save({"id": row["card"], "status": terminal})
        ref = f"refs/heads/{state['branch']}"
        try:
            head = subprocess.check_output(["git", "-C", state["repo"], "rev-parse", "--verify", ref],
                                           text=True, stderr=subprocess.DEVNULL, timeout=10).strip()
        except (OSError, subprocess.SubprocessError):
            self._status(db, row, "cleanup_blocked", {"reason": "Retained branch is unavailable", "branch": ref})
            return True
        operation.update(id=_key(row["generation"], "archive", version, head), sha=head, verdict=verdict,
                         worktree=state.get("worktree"))
        started = self._status(db, row, "archive_started", operation, payload=operation)
        self._execute(db, started, lock_fd)
        return True

    def poll(self):
        with self._exclusive() as lock_fd, self._db(write=True) as db:
            rows = db.execute("""SELECT * FROM operator_resolutions
                WHERE status NOT IN ('archived', 'cleanup_blocked', 'revoked') ORDER BY card""").fetchall()
            for row in rows:
                if self._step(db, row, lock_fd):
                    return {"card": row["card"]}
        return {"card": None}
