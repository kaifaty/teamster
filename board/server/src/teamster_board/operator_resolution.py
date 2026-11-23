"""Explicitly delegated resolutions and their durable command receipts."""

import fcntl
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from contextlib import closing, contextmanager
from pathlib import Path
from uuid import uuid4

from . import duty_tasks
from .external_duty import valid_text
from .project_tasks import pull_request_evidence
from .store import ARCHIVED, Store, alive, ready_for_review


TERMINAL = ("archived", "cleanup_blocked", "revoked", "followup_finished", "clarification_requested")
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


def _record_anchor(record, state, pulls):
    pr = next((pr for pr in pulls if pr["url"] == record.summary["pr"] and pr["status"] == "merged"), None)
    if pr is None:
        return None
    sha, base = pr.get("merge_sha"), pr.get("base")
    if (not re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", sha or "")
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}", base or "")):
        return None
    try:
        git = ["git", "-C", state["repo"]]
        branch = f"refs/heads/{state['branch']}"
        listed = subprocess.check_output([*git, "for-each-ref", "--format=%(refname)", branch],
                                         text=True, stderr=subprocess.DEVNULL, timeout=5)
        registered = subprocess.check_output([*git, "worktree", "list", "--porcelain"],
                                             text=True, stderr=subprocess.DEVNULL, timeout=5)
        if branch in listed.splitlines() or f"branch {branch}" in registered.splitlines():
            return None
        subprocess.check_call([*git, "merge-base", "--is-ancestor", sha, f"refs/remotes/origin/{base}"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return {"sha": sha, "base": base}


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
                        WHERE status NOT IN ('archived', 'revoked', 'followup_finished', 'clarification_requested')
                        ORDER BY card""").fetchall()
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

    def proposal_target(self, card, linked, pulls):
        if card["status"] in ("done", "cancelled"):
            raise ValueError("Task is already in history")
        runs = sorted((item for item in linked if linked[item]["kind"] in ("work", "review")),
                      key=lambda item: linked[item]["updated_at"], reverse=True)
        current = next((found for item in runs if (found := self._run(item))), None)
        run = current[1] if current else None
        target = {"run": run, "turn": None, "from": card["status"], "actions": ["clarify"]}
        if run is None:
            return target
        record, _, state = current
        target["turn"] = state.get("turns", 0)
        worktree = state.get("worktree")
        has_tree = bool(worktree and Path(worktree).is_dir())
        if has_tree:
            target["actions"].extend(("continue", "ask_executor"))
        if (len(runs) == 1 and target["turn"] > 0 and state.get("turn_finished")
                and not (alive(state.get("pid")) or state.get("pending") or self._verdict(record, state))):
            anchor = _record_anchor(record, state, pulls) if worktree and not (has_tree or Path(worktree).is_symlink()) else None
            if has_tree and not any(pr["status"] == "merged" for pr in pulls):
                target["actions"].append("cancel")
            merged = len(pulls) == len(card["pull_requests"]) and pulls and all(pr["status"] == "merged" for pr in pulls)
            if (has_tree or anchor) and (merged or not card["pull_requests"] and card["status"] == "ready"):
                target["actions"].append("accept")
                if anchor:
                    target["record_only"] = anchor
        return target

    def _transition(self, db, row, previous, status):
        card, _ = self.board.project_tasks.card(row["card"])
        changed = card["status"] != status
        if changed:
            self.board.project_tasks.save({"id": row["card"], "status": status})
        if previous != status:
            with db:
                self._event(db, row, "status_changed", {"from": previous, "to": status})
        return changed

    def choose(self, identity, proposal, target, option):
        action = option["action"]
        with self._exclusive() as lock_fd, self._db(write=True) as db:
            old = db.execute("SELECT * FROM operator_resolutions WHERE card=?", (identity,)).fetchone()
            if db.execute("""SELECT 1 FROM operator_resolution_events
                    WHERE card=? AND generation=? AND kind='choice'""", (identity, proposal)).fetchone():
                if not db.execute("""SELECT 1 FROM operator_resolution_events
                    WHERE card=? AND generation=? AND kind='choice' AND json_extract(detail, '$.action')=?""",
                                  (identity, proposal, action)).fetchone():
                    raise ValueError("A different option was already chosen")
                return
            if old and old["status"] not in TERMINAL:
                raise ValueError("A resolution is already in progress")
            card, linked = self.board.project_tasks.card(identity)
            run = target["run"]
            current = self._run(run) if run in linked else None
            if (card["status"] != target["from"] or run and
                    (not current or current[2].get("turns", 0) != target["turn"])):
                raise ValueError("Task changed. Ask the operator for a new proposal")
            operation = {"from": card["status"], "action": action, "text": option["text"]}
            if action == "clarify":
                status = "clarification_started"
            else:
                record, _, state = current
                operation.update(slug=state["slug"], created=state["created"], turn=target["turn"],
                                 id=_key(proposal, action), version=self._version(state))
                status = "dispatch_started"
                if action in ("continue", "ask_executor") and self.board.actions.reason:
                    raise ValueError("Board cannot send an order to the executor")
                worktree = state.get("worktree")
                if action != "accept" and (not worktree or not Path(worktree).is_dir()):
                    raise ValueError("The linked worktree is unavailable")
                if action in ("accept", "cancel"):
                    other_runs = [ref for ref in linked if ref != run and linked[ref]["kind"] in ("work", "review")]
                    if (other_runs or self._verdict(record, state) or not state.get("turn_finished")
                            or alive(state.get("pid")) or state.get("pending")):
                        raise ValueError("Run changed or still has work")
                    if action == "accept" and card["pull_requests"]:
                        pulls = pull_request_evidence(card["pull_requests"][:3])
                        if len(pulls) != len(card["pull_requests"]) or any(pr["status"] != "merged" for pr in pulls):
                            raise ValueError("Linked pull requests are not all confirmed merged")
                        archive = target.get("record_only")
                        if archive:
                            if (not worktree or Path(worktree).exists() or Path(worktree).is_symlink()
                                    or _record_anchor(record, state, pulls) != archive):
                                raise ValueError("Archive evidence changed. Ask for a new proposal")
                            operation["record_only"] = archive
                    if "record_only" not in operation and (not worktree or not Path(worktree).is_dir()):
                        raise ValueError("The linked worktree is unavailable")
                    operation.update(verdict="accepted" if action == "accept" else "dropped",
                                     note=f"User selected the operator's proposal. {option['text']}")
                    status = "verdict_started"
            if run and db.execute("SELECT 1 FROM operator_resolutions WHERE run=? AND card<>?",
                                  (run, identity)).fetchone():
                raise ValueError("Run is already linked to a different resolution")
            self.board.project_tasks.save({"id": identity, **({"status": card["status"]}
                                           if status == "verdict_started" else {})})
            row = {"card": identity, "run": run or identity, "generation": proposal, "rule": "choice", "status": status,
                   "payload": json.dumps(operation, ensure_ascii=False)}
            with db:
                db.execute("""INSERT OR REPLACE INTO operator_resolutions
                    (card, run, generation, rule, status, payload) VALUES (:card, :run, :generation, :rule, :status, :payload)""",
                           row)
                self._event(db, row, "choice", {"action": action, "note": option["text"], "run": run,
                                                "proposal": proposal}, actor="user")
            if status == "dispatch_started":
                request = ("Answer this question using existing evidence. Do not change files.\n\n"
                           if action == "ask_executor" else "Continue this task with the following assignment.\n\n")
                reply = self.board.actions._task("say", {"slug": operation["slug"], "text": request + option["text"]})
                if not isinstance(reply, dict) or not reply.get("ok"):
                    reason = "Teamster could not confirm delivery"
                    if hasattr(reply, "body"):
                        reason = json.loads(reply.body).get("error", reason)
                    self._status(db, row, "cleanup_blocked", {"reason": reason})
                    return
                self._status(db, row, "waiting_followup", {"action": action, "run": run, "note": option["text"]})
                self._transition(db, row, operation["from"], "active")
            else:
                self._step(db, row, lock_fd)

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
                    or receipt.get("record_from") != (operation.get("record_only") or {}).get("base")
                    or not isinstance(receipt.get("files"), int)))):
            return None, "Teamster returned no verified receipt"
        return True, receipt

    def _execute(self, db, row, lock_fd):
        operation = json.loads(row["payload"])
        is_verdict = row["status"] == "verdict_started"
        args = [operation.get("verdict", "dropped"), f"--note={operation['note']}"] if is_verdict else [
            "--archive-safe", "--expect-head", operation["sha"], "--expect-verdict", operation["verdict"],
        ]
        if not is_verdict and operation.get("record_only"):
            args.extend(("--archive-record-from", operation["record_only"]["base"]))
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
            self._status(db, row, "verdict_recorded", {"operation": operation["id"],
                                                      "verdict": operation.get("verdict", "dropped"),
                                                      "run": row["run"], "turn": operation["turn"],
                                                      "evidence": operation.get("evidence")})
        else:
            if row["rule"] == "choice":
                self._transition(db, row, operation["from"],
                                 "done" if operation["verdict"] == "accepted" else "cancelled")
            self._status(db, row, "archived", {"operation": operation["id"], "sha": receipt["sha"],
                                              "archive": receipt["archive"], "files": receipt["files"],
                                              **({"record_only": True} if operation.get("record_only") else {})})
        return

    def _step(self, db, row, lock_fd):
        if row["rule"] == "choice":
            operation = json.loads(row["payload"])
            if row["status"] == "clarification_started":
                self._transition(db, row, operation["from"], "needs_input")
                self._status(db, row, "clarification_requested", {"note": operation["text"]})
                return True
            if row["status"] == "dispatch_started":
                self._status(db, row, "cleanup_blocked", {"reason": "Delivery is unconfirmed. Inspect the executor before retrying."})
                return True
            if row["status"] == "waiting_followup":
                card, _ = self.board.project_tasks.card(row["card"])
                if card["status"] in ("done", "cancelled"):
                    self._status(db, row, "cleanup_blocked", {"reason": "The card was closed while the executor was working"})
                    return True
                current = self._run(row["run"])
                if not current:
                    self._status(db, row, "cleanup_blocked", {"reason": "Executor is no longer available"})
                    return True
                state = current[2]
                if (state.get("turns", 0) <= operation["turn"] or not state.get("turn_finished")
                        or alive(state.get("pid")) or state.get("pending")):
                    return self._transition(db, row, operation["from"], "active")
                result = state.get("result") or {}
                status = ("needs_input" if operation["action"] == "ask_executor" or result.get("status") == "needs_decision"
                          else "ready" if ready_for_review(result.get("status"), state.get("outcome")) else "blocked")
                self._transition(db, row, "active", status)
                self._status(db, row, "followup_finished", {"run": row["run"], "turn": state["turns"],
                                                            "report": str(result.get("summary") or "")[:1000]})
                return True
        if row["status"] == "verdict_started" and row["rule"] == "negative":
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
        if row["rule"] != "choice" and card["status"] != terminal:
            self.board.project_tasks.save({"id": row["card"], "status": terminal})
        selection = json.loads(row["payload"]) if row["rule"] == "choice" else {}
        anchor = selection.get("record_only")
        if anchor:
            head = anchor["sha"]
            operation["record_only"] = anchor
        else:
            ref = f"refs/heads/{state['branch']}"
            try:
                head = subprocess.check_output(["git", "-C", state["repo"], "rev-parse", "--verify", ref],
                                               text=True, stderr=subprocess.DEVNULL, timeout=10).strip()
            except (OSError, subprocess.SubprocessError):
                self._status(db, row, "cleanup_blocked", {"reason": "Retained branch is unavailable", "branch": ref})
                return True
        operation.update(id=_key(row["generation"], "archive", version, head), sha=head, verdict=verdict,
                         worktree=state.get("worktree"))
        if row["rule"] == "choice":
            operation["from"] = selection["from"]
        started = self._status(db, row, "archive_started", operation, payload=operation)
        self._execute(db, started, lock_fd)
        return True

    def poll(self):
        with self._exclusive() as lock_fd, self._db(write=True) as db:
            rows = db.execute("""SELECT * FROM operator_resolutions WHERE status NOT IN
                (SELECT value FROM json_each(?)) ORDER BY card""", (json.dumps(TERMINAL),)).fetchall()
            for row in rows:
                if self._step(db, row, lock_fd):
                    return {"card": row["card"]}
        return {"card": None}
