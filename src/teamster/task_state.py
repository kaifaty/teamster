"""Task state fields, persistence and cancellation outcomes."""
import fcntl
import json
import os
import threading
from contextlib import contextmanager
from typing import Callable, Literal, NamedTuple, Optional

from . import acp, clock, config, executors, opencode_runner, procs, reviewers, threads


def interruption(st):
    """How an external signal cut the last cycle of st short, as {"signal": name or None, "at": time}, or None.

    A work or review cycle is cut short when its supervisor is gone and it either ended interrupted or
    published no result at all, as when the supervisor was killed outright. A stop is not an interruption.
    """
    if st.get("kind") in ("scout", "reflect", "duty") or not st.get("turn_started") or procs.alive(st.get("pid")):
        return None
    if "turn_finished" in st:
        if st.get("outcome") != "interrupted":
            return None
        received = st.get("signal") or {}
        return {"signal": received.get("name"), "at": received.get("at", st["turn_finished"])}
    try:
        # Without a result, the last save is the latest moment the supervisor is known to have run.
        at = state_path(st["slug"]).stat().st_mtime
    except OSError:
        at = None
    return {"signal": None, "at": at}


def interruption_message(st, cut=None):
    """The line wait, status and the interrupted notification print for a cycle an external signal cut short."""
    if cut is None:
        received = st.get("signal") or {}
        cut = {"signal": received.get("name", "unknown signal"), "at": received.get("at")}
    name = cut["signal"] or "an unknown signal (the supervisor left no result)"
    return (f"interrupted externally by {name} at {config.local_time(cut['at'])}; "
            f"continue: {config.COMMAND} resume {st['slug']}")


def mark_step(st, step, ci=False):
    """Save the cycle step that starts now, so resume can continue the cycle there."""
    cycle = st.get("cycle")
    if cycle is not None:
        cycle["step"] = step
        if step == "review":
            # Until review_turn starts, the saved review is the previous one: resume must not fix from it.
            cycle["angles"] = None
        if ci:
            cycle["ci"] = True
        pr = (st.get("publish") or {}).get("pr")
        if pr:
            # Fix rounds drop the publication receipt; the resume prompt still names the PR.
            cycle["pr"] = pr
    save(st)


def state_path(slug):
    return config.TASKS / slug / "state.json"


STATE_DELETE = object()


class StateField(NamedTuple):
    """Root field lifetime and optional factories for load/spawn values.

    task lasts until clean; history accumulates; cursor tracks the current
    account/thread/phase; turn spans a user turn; attempt spans one exec;
    runtime holds process and stop bookkeeping. Lifetimes document ownership;
    only spawn_reset opts a field into the unconditional spawn reset.
    """
    lifetime: Literal["task", "history", "cursor", "turn", "attempt", "runtime"]
    load_default: Optional[Callable[[dict], object]] = None
    spawn_reset: object = None  # Factory (state, turn context), STATE_DELETE, or no reset.


# Keep the historical insertion order for both load defaults and spawn values:
# state.json remains a flat dict, including identical serialization bytes.
# Factories allocate fresh mutable defaults for each state/turn.
STATE_FIELDS = {
    "account": StateField("cursor", load_default=lambda st: "main"),
    "executor": StateField("task", load_default=lambda st: "codex"),
    "work_binding": StateField("task"),  # Absent on legacy records, null until the first work admission.
    "claude_account": StateField("task"),
    "session_id": StateField("cursor"),
    "threads": StateField("history", load_default=lambda st: (
        [{"account": st["account"], "thread": st["thread"], "started": st.get("created", 0)}]
        if st.get("thread") else [])),
    "rotations": StateField("history", load_default=lambda st: []),
    "reviews": StateField("history", load_default=lambda st: []),
    "checks": StateField("history", load_default=lambda st: []),
    "turn_stops": StateField("history", load_default=lambda st: []),
    # Last work result survives standalone review; only work/scout spawn clears it.
    "result": StateField("turn", load_default=lambda st: None),
    "pending": StateField("turn", spawn_reset=lambda st, turn: turn["pending"]),
    # Phase cursor, also used as the persistent scout marker.
    "kind": StateField("cursor", spawn_reset=lambda st, turn: turn["kind"]),
    "work_completed": StateField("turn", spawn_reset=lambda st, turn: False),
    "review_start": StateField("turn", spawn_reset=lambda st, turn: len(st.get("reviews", []))),
    "turn_started": StateField("turn", spawn_reset=lambda st, turn: clock.CLOCK.time()),
    "check_start": StateField("turn", spawn_reset=lambda st, turn: len(st.get("checks", []))),
    "turns": StateField("history", spawn_reset=lambda st, turn: st.get("turns", 0) + 1),
    "rotation_start": StateField("turn", spawn_reset=lambda st, turn: len(st["rotations"])),
    "event_start": StateField("turn", spawn_reset=lambda st, turn: len(threads.events(st))),
    "exhausted": StateField("turn", spawn_reset=lambda st, turn: None),
    "outcome": StateField("turn", spawn_reset=lambda st, turn: "running"),
    # Waiting budget is also restarted at automatic phase boundaries.
    "reset_wait_seconds": StateField("turn", spawn_reset=lambda st, turn: 0),
    # Task total; capacity_start marks where the current turn began.
    "capacity_retries": StateField("history"),
    "capacity_start": StateField("turn", spawn_reset=lambda st, turn: st.get("capacity_retries", 0)),
    "fix_rounds": StateField("turn", load_default=lambda st: 0,
                             spawn_reset=lambda st, turn: turn["fix_rounds"]),
    "rounds": StateField("turn", load_default=lambda st: [], spawn_reset=lambda st, turn: []),
    "guards": StateField("task", load_default=lambda st: []),
    "base_check": StateField("task", load_default=lambda st: False),
    "sandbox": StateField("task", load_default=lambda st: "off"),
    "writable_dirs": StateField("task", load_default=lambda st: []),
    "sleeping": StateField("turn", spawn_reset=STATE_DELETE),
    "turn_finished": StateField("turn", spawn_reset=STATE_DELETE),
    "error": StateField("turn", spawn_reset=STATE_DELETE),
    "review_skipped": StateField("turn", spawn_reset=STATE_DELETE),
    "auto_fix_stop": StateField("turn", spawn_reset=STATE_DELETE),
    "base_merges": StateField("turn", spawn_reset=STATE_DELETE),
    "auto_fix_escalations": StateField("turn", spawn_reset=STATE_DELETE),
    "turn_stop": StateField("turn", spawn_reset=STATE_DELETE),
    "wrapup": StateField("turn", spawn_reset=STATE_DELETE),
    "review_result": StateField("turn", spawn_reset=STATE_DELETE),
    # One review angle may span multiple exec attempts.
    "review_angle": StateField("turn", spawn_reset=STATE_DELETE),
    # Refusal belongs to the current phase, which may span multiple attempts.
    "refusal": StateField("turn", spawn_reset=STATE_DELETE),
    "stop_request": StateField("runtime", spawn_reset=STATE_DELETE),
    "signal": StateField("runtime", spawn_reset=STATE_DELETE),
    "ci": StateField("turn", spawn_reset=STATE_DELETE),
    "ci_reruns": StateField("history"),
    "slug": StateField("task"),
    "repo": StateField("task"),
    "worktree": StateField("task"),
    "branch": StateField("task"),
    "base": StateField("task"),
    "base_switch": StateField("task"),
    "effort": StateField("task"),
    "task_model": StateField("task"),
    "task_model_family": StateField("task"),
    "review_model": StateField("task"),
    "task_type": StateField("task"),
    "model": StateField("cursor", spawn_reset=lambda st, turn: None),
    "reasoning_effort": StateField("cursor", spawn_reset=lambda st, turn: None),
    "thread": StateField("cursor"),
    "check": StateField("task"),
    "check_loaded": StateField("task"),
    "check_timeout": StateField("task"),
    "ci_enabled": StateField("task"),
    "no_push": StateField("task"),
    "ci_command": StateField("task"),
    "ci_rounds": StateField("task"),
    "ci_timeout_minutes": StateField("task"),
    "max_task_weekly_percent": StateField("task"),
    "weekly_used_percent": StateField("history"),
    "created": StateField("task"),  # Immutable task birth metadata.
    "task_deadline": StateField("task"),  # Absolute wall time shared by every cycle.
    "plugin_version": StateField("task"),
    # The version and script of the last spawn: say and review re-run in that version (installs.follow_pin).
    "runtime": StateField("task", spawn_reset=lambda st, turn: {
        "version": config.plugin_version(), "script": str(config.SCRIPT_RESOLVED)}),
    "pid": StateField("runtime"),
    "codex_pid": StateField("runtime"),
    "claude_pid": StateField("runtime"),
    "opencode_pid": StateField("runtime"),
    "check_pid": StateField("runtime"),
    "account_ids": StateField("task"),  # Task-wide identity cache, refreshed by probes.
    # Auth retry bookkeeping is reset by _run_turn(new_turn=True), not spawn.
    "auth_excluded": StateField("turn"),
    "auth_excluded_ids": StateField("turn"),
    "auth_failures": StateField("turn"),
    "auth_transitions": StateField("turn"),
    "needs_login": StateField("task"),  # Account health cache; cleared by a fresh successful probe.
    "reset_reconciled": StateField("attempt"),  # Short-lived reset/probe coordination flag.
    "weekly_marks": StateField("task"),  # High-water cache per account/weekly window.
    "weekly_budget_warning": StateField("task"),  # Derived quota probe cache, recomputed as needed.
    "check_paths": StateField("history"),  # Accumulating protected paths; explicit --no-check clears it.
    "max_turn_minutes": StateField("turn"),  # say replaces this launch parameter, not spawn.
    "review_angles": StateField("turn"),  # say/review replace this launch parameter, not spawn.
    "reviewer": StateField("task", load_default=lambda st: reviewers.CODEX_REVIEWER.name),
    "reviewer_explicit": StateField("task"),
    "publish": StateField("turn"),  # Last work receipt survives standalone review, like result.
    # New user turns discard the exec cursor; automatic phases retain the last attempt.
    "exec_event_start": StateField("attempt", spawn_reset=STATE_DELETE),
    # review_turn marks the account unselected (None) before phase/angle early exits.
    "review_account": StateField("cursor"),
    # Reflection: the record selection of the reading room, the batch or study file teamster writes,
    # the lead's order and one entry per recorded answer of the executor.
    "reflect_mode": StateField("task"),
    "reflect_through": StateField("task"),
    "reflect_records": StateField("task"),
    "reflect_file": StateField("task"),
    "reflect_order": StateField("task"),
    "reflect_turns": StateField("history"),
    "parallel": StateField("task"),  # Whether start got --parallel.
    # Whether start or say asked for --review, kept after the supervisor takes its pending order.
    "review_after": StateField("turn", spawn_reset=lambda st, turn: bool(turn["pending"]["review_after"])),
    # The cycle this supervisor runs: its kind and effort, the step it is in and the last PR,
    # so resume continues an interrupted cycle where it stopped.
    "cycle": StateField("turn", spawn_reset=lambda st, turn: {
        "kind": turn["kind"], "effort": turn["pending"]["effort"], "step": "review" if turn["kind"] == "review" else "work",
        "ci": False, "pr": (st.get("publish") or {}).get("pr", "")}),
    # One entry per resume: when, the signal that cut the cycle short and the step it continued from.
    "resumed": StateField("history"),
    # "duty" for a task that a duty chat turn started (config.started_by); the end of its cycles notes the duty.
    "started_by": StateField("task"),
    # Duty chat: one entry per recorded answer, and the start times of note-driven turns in the last hour.
    "duty_turns": StateField("history"),
    "duty_auto_turns": StateField("history"),
}


def bind_work(st, model, **connection):
    """Record the actual admission once. A profile name alone cannot authorize a later turn."""
    binding = dict(version=executors.WORK_BINDING_VERSION, executor=executors.from_state(st).name, model=model or "default", **connection)
    if st["work_binding"] is None:
        st["work_binding"] = binding
        save(st)
    elif st["work_binding"] != binding:
        raise ValueError("The assigned work connection or model changed. Restore it or start a separate linked task.")


def load(slug):
    p = state_path(slug)
    if not p.exists():
        procs.die(f"no task {slug!r}")
    st = json.loads(p.read_text())
    for key, field in STATE_FIELDS.items():
        if field.load_default is not None:
            st.setdefault(key, field.load_default(st))
    return st


# The slugs whose state lock this thread holds.
HELD_STATE_LOCKS = threading.local()


@contextmanager
def state_lock(slug):
    # stop and spawn read, modify and write state under it, serialized with
    # supervisor saves so none can lose another's published fields.
    # Reentrant in one thread: the supervisor saves its final state inside the hold that reads the queue.
    held = getattr(HELD_STATE_LOCKS, "slugs", None)
    if held is None:
        held = HELD_STATE_LOCKS.slugs = set()
    if slug in held:
        yield
        return
    try:
        lock = state_path(slug).with_suffix(".lock").open("a")
    except FileNotFoundError:
        procs.die(f"no task {slug!r}")
    with lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        held.add(slug)
        try:
            yield
        finally:
            held.discard(slug)


def write_state(st):
    p = state_path(st["slug"])
    tmp = p.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(st, ensure_ascii=False, indent=2))
    tmp.replace(p)


def save(st):
    with state_lock(st["slug"]):
        p = state_path(st["slug"])
        if st.get("pid") and p.exists():
            latest = json.loads(p.read_text())
            if latest.get("pid") == st["pid"] and "stop_request" in latest:
                st["stop_request"] = latest["stop_request"]
        write_state(st)


def interrupted_acp_processes(st):
    """A completed cleanup removes the record. Call after confirming the supervisor is gone."""
    return acp.TaskProcesses.recover(config.TASKS / st["slug"])


def reap_acp_turn(st):
    """Called under the state lock after the supervisor is gone, before reusing its worktree."""
    processes = interrupted_acp_processes(st)
    if processes:
        processes.terminate()
        processes.clear()
        st.pop("claude_pid", None)
        st.pop("codex_pid", None)


def session_processes(st, *, terminals=False):
    """Live process groups holding the task's session after its supervisor exits."""
    if st.get("kind") == "duty":
        for name in ("Claude", "Codex"):
            pid = st.get(name.lower() + "_pid")
            if procs.alive(pid):
                yield name, pid
                return
    elif processes := interrupted_acp_processes(st):
        for pid in (st.get("claude_pid"), st.get("codex_pid")):
            if pid and procs.process_marker(pid) == processes.marker:
                yield "ACP", pid
                return
        if terminals:
            for pid in procs.marked_processes(processes.marker, processes.parents):
                yield "ACP", pid
    elif st.get("opencode_pid"):
        for group in opencode_runner.orphan_groups(st):
            yield "OpenCode", group


def session_process(st, *, terminals=False):
    return next(session_processes(st, terminals=terminals), (None, None))


def busy_message(st, queue_hint=False):
    """Why no new turn may start beside the live supervisor of st, or None when it is idle.

    queue_hint adds the say --queue alternative to the refusal of a say. A transport that outlived
    its supervisor may still hold the session.
    """
    if not procs.alive(st.get("pid")):
        name, pid = session_process(st)
        if pid is not None:
            return (f"{name} process {pid} of the previous {st['kind']} turn outlived its supervisor and still "
                    f"holds the session; end it with {config.COMMAND} stop {st['slug']}, then send the message again")
        return None
    if st.get("outcome") == "sleeping":
        return (f"waiting for limit reset until {config.local_time(st['sleeping']['until'])}; stop first to send a new message"
                + ("; or queue it with say --queue" if queue_hint else ""))
    return (f"{st['slug']} is still running a turn; wait for it (or stop it) first"
            + ("; or queue the message with say --queue" if queue_hint else ""))


QUEUE_DROPPED_LIMIT = 10


def queue_path(slug):
    return config.TASKS / slug / "queue.json"


def read_queue(slug):
    """The say --queue orders of slug, {"waiting": [...], "dropped": [...]}; the caller holds state_lock."""
    p = queue_path(slug)
    queue = json.loads(p.read_text()) if p.exists() else {}
    return {"waiting": queue.get("waiting", []), "dropped": queue.get("dropped", [])}


def write_queue(slug, queue):
    """Replace queue.json atomically, keeping the newest dropped orders; the caller holds state_lock."""
    p = queue_path(slug)
    tmp = p.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps({"waiting": queue["waiting"], "dropped": queue["dropped"][-QUEUE_DROPPED_LIMIT:]},
                              ensure_ascii=False, indent=2))
    tmp.replace(p)


def locked_queue(slug):
    # queue.json is replaced, never removed: without one there is nothing to lock for.
    if not queue_path(slug).exists():
        return {"waiting": [], "dropped": []}
    with state_lock(slug):
        return read_queue(slug)


def enqueue(slug, order):
    """Append a say --queue order while the supervisor of slug is alive; return the waiting count, or None when idle.

    Its supervisor reads the queue under the same lock when its cycle ends, so the order cannot miss that read.
    """
    with state_lock(slug):
        st = load(slug)
        if deadline_reached(st) or not procs.alive(st.get("pid")):
            return None
        queue = read_queue(slug)
        queue["waiting"].append(order)
        write_queue(slug, queue)
        return len(queue["waiting"])


def queue_sent_path(slug):
    """One line per cycle whose end sent the queue: the finished turn, the turn it started and its wait report."""
    return config.TASKS / slug / "queue-sent.jsonl"


def queue_dropped_path(slug):
    """One line per cycle whose end dropped the queue: the turn, the outcome and every text, beyond the dropped history."""
    return config.TASKS / slug / "queue-dropped.jsonl"


def locked_queue_log(slug, path):
    """The lines of queue-sent.jsonl or queue-dropped.jsonl, read under the state lock."""
    if not queue_path(slug).exists():
        return []
    with state_lock(slug):
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def deadline_reached(st):
    """Whether this task's wall-clock lifetime has elapsed."""
    deadline = st.get("task_deadline")
    return deadline is not None and clock.CLOCK.time() >= deadline


def stop_outcome(st, stopped):
    """Distinguish a stop addressed to this supervisor, a signal and a deadline."""
    if not stopped():
        return None
    pid = st.get("pid")
    request = st.get("stop_request") or {}
    if pid and request.get("pid") != pid:
        # The signal can arrive before the supervisor's next save imports stop's
        # durable request. Atomic state replacement makes this read consistent.
        latest = load(st["slug"])
        if latest.get("pid") == pid:
            request = latest.get("stop_request") or {}
            if request.get("pid") == pid:
                st["stop_request"] = request
    if pid and request.get("pid") == pid:
        return "stopped"
    if not st.get("signal") and deadline_reached(st):
        return "timeout"
    return "interrupted"


def running_tasks(exclude="", root=None, scouts=False):
    """Slugs whose supervisor is alive, including sleeping and waiting ones."""
    out = []
    for p in (config.TASKS if root is None else root).glob("*/state.json"):
        st = json.loads(p.read_text())
        if (st["slug"] != exclude and (scouts or st.get("kind") not in ("scout", "reflect", "duty"))
                and procs.alive(st.get("pid"))):
            out.append(st["slug"])
    return out
