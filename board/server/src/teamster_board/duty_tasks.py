"""Compact local task cards built from the Board's task records."""

import hashlib
import json
import re
from pathlib import Path

from .store import ARCHIVED, Record, Store, cargo, line, mapping, number, text


TASK_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{1,40}")
BRIEF_BYTES = 48_000


def read_store(board_store):
    """Keep a separate journal cursor so fresh reads cannot consume Board updates."""
    return Store(board_store.tasks_path, telemetry_path=board_store.telemetry_path)


def task_id(slug, created):
    created = number(created)
    if created is None or not isinstance(slug, str) or TASK_SLUG.fullmatch(slug) is None:
        return None
    return f"{slug}:{created.hex()}"


def check_results(state):
    checks = cargo(state)
    return {"saved": checks["check"], "reported": checks["claims"], "ci": checks["ci"]}


def decision_question(state):
    result = mapping(state.get("result"))
    if result.get("status") not in ("blocked", "needs_decision"):
        return None
    questions = result.get("questions")
    if isinstance(questions, list):
        return next((question.strip() for question in questions
                     if isinstance(question, str) and question.strip()), None)
    return None


def stop_requested(state):
    pid = state.get("pid")
    return pid is not None and mapping(state.get("stop_request")).get("pid") == pid


def unfinished(state):
    # A dead supervisor may have saved its work result before a check or finalization.
    return state.get("pid") is not None and number(state.get("turn_finished")) is None


def task_status(state, is_alive):
    outcome = state.get("outcome")
    if is_alive:
        return "stopping" if stop_requested(state) else "running"
    if outcome == "stopped":
        return "stopped"
    if unfinished(state):
        return "failed"
    if outcome == "completed":
        status = text(mapping(state.get("result")).get("status"))
        if decision_question(state) is not None:
            return "needs_decision"
        if status in ("blocked", "needs_decision"):
            return "blocked"
        return {"done": "succeeded", "partial": "partial"}.get(status, "failed")
    return "failed" if outcome else "idle"


def _goal(path):
    if path is None:
        return None
    try:
        with path.open("rb") as stream:
            brief = stream.read(BRIEF_BYTES).decode("utf-8", errors="replace")
    except FileNotFoundError:
        return None
    rules = max(brief.rfind(f"\n\n{heading}\n") for heading in ("## How to work", "## Как работать"))
    if rules >= 0:
        brief = brief[:rules]
    brief = brief.rsplit("\n\n## Done when\n", 1)[0]
    return text(brief.strip())


def _signature(path):
    if path is not None:
        try:
            stat = path.stat()
        except FileNotFoundError:
            pass
        else:
            return stat.st_mtime_ns, stat.st_size
    return None


def _card(store, path, archived, allowed_repos):
    record = Record(path, archived)
    store._read_state(record, strict=True)
    state = record.state
    if state.get("kind", "work") not in ("work", "review"):
        return None
    slug = state.get("slug")
    identity = task_id(slug, state.get("created"))
    repo = text(state.get("repo"))
    if identity is None or repo is None or not Path(repo).is_absolute():
        return None
    try:
        repository = str(Path(repo).resolve())
    except (ValueError, RuntimeError):
        return None
    if repository not in allowed_repos:
        return None
    archive = ARCHIVED.fullmatch(path.name) if archived else None
    record_slug = archive.group(1) if archive else path.name
    if record_slug != slug or (archived and archive is None):
        return None

    summary = store._summary(path.name, record)
    is_alive = summary["alive"] and not archived
    status = task_status(state, is_alive)
    question = decision_question(state) if status == "needs_decision" else None
    if status in ("needs_decision", "blocked"):
        blocker = question or summary["summary"] or status
    elif status == "failed":
        reason = "Supervisor exited without finishing the turn" if unfinished(state) else summary["outcome"]
        blocker = line(state.get("error")) or reason
    else:
        blocker = None
    files = [_signature(store._file(path, name, strict=True)) for name in ("queue.json", "messages.jsonl")]
    verdict = (summary["lead_verdict"], summary["lead_verdict_at"])
    version = hashlib.sha256(json.dumps(
        [state, record.signature, files, archived, is_alive, verdict], sort_keys=True,
    ).encode("utf-8")).hexdigest()
    updated = max(record.updated_at, summary["lead_verdict_at"] or 0,
                  *(signature[0] / 1_000_000_000 for signature in files if signature is not None))
    return {
        "id": identity,
        "slug": slug,
        "repository": repository,
        "goal": _goal(store._file(path, "brief.md", strict=True)),
        "executor": summary["executor"],
        "account": summary["account"],
        "status": status,
        "phase": summary["phase"] if not archived else "idle",
        "created_at": summary["created"],
        "updated_at": updated,
        "turn": summary["turn"],
        "outcome": summary["outcome"],
        "result_status": summary["result_status"],
        "blocker": blocker,
        "question": question,
        "checks": check_results(state),
        "pr": summary["pr"],
        "summary": summary["summary"],
        "alive": is_alive,
        "stop_requested": stop_requested(state),
        "archived": archived,
        "no_push": state.get("no_push") is True,
        "deadline_at": number(state.get("task_deadline")),
        "version": version,
        "host_status": "online",
    }


def tasks(store, allowed_repos):
    with store.lock:
        store._poll_log()
        return [card for path, archived in sorted(store._paths(strict=True))
                if (card := _card(store, path, archived, allowed_repos)) is not None]


def _live_card(store, allowed_repos, slug):
    if store.tasks_path.is_symlink():
        raise OSError(f"Task directory is a symlink: {store.tasks_path}")
    return _card(store, store.tasks_path / slug, False, allowed_repos)


def _archived_cards(store, allowed_repos, slug):
    for path in sorted(store._directories(store.tasks_path / ".archive", strict=True), reverse=True):
        match = ARCHIVED.fullmatch(path.name)
        if match and match.group(1) == slug:
            card = _card(store, path, True, allowed_repos)
            if card is not None:
                yield card


def task_by_slug(store, allowed_repos, slug, *, include_archive=False):
    if not isinstance(slug, str) or TASK_SLUG.fullmatch(slug) is None:
        return None
    with store.lock:
        store._poll_log()
        current = _live_card(store, allowed_repos, slug)
        if current is None and include_archive:
            return next(_archived_cards(store, allowed_repos, slug), None)
        return current


def task(store, allowed_repos, identity):
    if not isinstance(identity, str):
        return None
    slug, separator, _ = identity.partition(":")
    if not separator or TASK_SLUG.fullmatch(slug) is None:
        return None
    with store.lock:
        store._poll_log()
        current = _live_card(store, allowed_repos, slug)
        if current is not None and current["id"] == identity:
            return current
        return next((card for card in _archived_cards(store, allowed_repos, slug)
                     if card["id"] == identity), None)
