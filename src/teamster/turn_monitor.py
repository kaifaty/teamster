"""Turn control, event streams and rollout monitoring."""
import hashlib
import json
import os
import re
import selectors
import shlex
import subprocess
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, NamedTuple, Optional

from . import account_rotation, accounts, budgets, clock, codex_acp, config, procs, result_schema, sandboxing, task_state, telemetry_log, threads


def _search_command(command):
    while True:
        if "\n" in command or "\r" in command:
            return False
        try:
            lexer = shlex.shlex(command, posix=True, punctuation_chars="|;&>")
            lexer.whitespace_split = True
            lexer.commenters = ""
            words = list(lexer)
        except ValueError:
            return False
        if (len(words) == 3 and Path(words[0]).name in ("sh", "bash", "zsh", "dash", "ksh", "fish")
                and words[1] in ("-c", "-lc")):
            command = words[2]
            continue
        operators = [word for word in words if word and all(char in "|;&>" for char in word)]
        if not words or any(";" in word or "&&" in word or "||" in word
                            or "&" in word.replace(">&", "").replace("&>", "") for word in operators):
            return False
        while "|" in words:
            words = words[words.index("|") + 1:]
        if words and Path(words[0]).name == "env":
            words = words[1:]
        while words and re.match(r"[A-Za-z_][A-Za-z_0-9]*=", words[0]):
            words = words[1:]
        return bool(words) and (Path(words[0]).name in ("pgrep", "grep", "egrep", "fgrep", "rg")
                                or (Path(words[0]).name == "git" and words[1:2] == ["grep"]))


def _stdout_redirected(command):
    try:
        words = shlex.split(command)
    except ValueError:
        return False
    if (len(words) == 3 and Path(words[0]).name in ("sh", "bash", "zsh", "dash", "ksh", "fish")
            and words[1] in ("-c", "-lc")):
        return _stdout_redirected(words[2])
    # Keep quoted and escaped characters inside words, separate from shell operators.
    tokens = list(re.finditer(r'''(?:[^\s'"\\<>|;&]+|'[^']*'|"(?:\\.|[^"\\])*"|\\.)+|[<>|;&]+''', command))
    for index, token in enumerate(tokens[:-1]):
        if token.group() not in (">", ">>", "&>", "&>>"):
            continue
        if tokens[index + 1].group()[0] in "<>|;&":
            continue
        if token.group() not in ("&>", "&>>") and index and tokens[index - 1].end() == token.start():
            descriptor = tokens[index - 1].group()
            if descriptor.isdigit() and descriptor != "1":
                continue
        return True
    return False


class TurnControl:
    """Limits belong to a phase, surviving exec retries but excluding account waits."""

    def __init__(self, minutes, repeat_limit, weekly=None):
        self.minutes = minutes
        self.weekly = weekly
        self.seconds = None if minutes is None else minutes * config.MINUTE_SECONDS
        self.elapsed = 0.0
        self.repeat_limit = repeat_limit
        self.failures = {}
        self.reason = None

    def expired(self, started):
        if self.seconds is None:
            return False
        usage = budgets.monitor_time_usage(self.elapsed, self.seconds, self.minutes, started, clock.CLOCK.monotonic())
        if usage.reason is not None:
            self.reason = usage.reason
            return True
        return False

    def weekly_exhausted(self, spent):
        if self.weekly is not None and spent >= self.weekly:
            self.reason = {"outcome": "budget_exhausted", "weekly": self.weekly, "spent": spent}
            return True
        return False

    def repeated(self, event):
        item = event.get("item") or {}
        if event.get("type") != "item.completed" or item.get("type") != "command_execution":
            return False
        command, code = item.get("command"), item.get("exit_code")
        if not isinstance(command, str) or type(code) is not int:
            return False
        if code == 0:
            self.failures.pop(command, None)
            return False
        output = item.get("aggregated_output", "")
        if not isinstance(output, str):
            return False
        if not output.strip() and ((code == 1 and _search_command(command)) or _stdout_redirected(command)):
            self.failures.pop(command, None)
            return False
        digest = hashlib.sha256(output.encode("utf-8")[-2048:]).hexdigest()
        signature = (code, digest)
        previous, count = self.failures.get(command, (None, 0))
        count = count + 1 if signature == previous else 1
        self.failures[command] = (signature, count)
        if count >= self.repeat_limit:
            self.reason = {"outcome": "stuck", "command": command, "exit_code": code,
                           "output_sha256": digest, "count": count, "output_tail": output[-300:]}
            return True
        return False


def turn_stop_message(reason):
    if reason["outcome"] == "budget_exhausted":
        if "weekly" in reason:
            return f"weekly budget {reason['weekly']:g}% exhausted (spent {reason['spent']:g}%)"
        return f"time budget {reason['minutes']:g} min exhausted"
    return f"repeated failure ×{reason['count']}: {reason['command']}"


class MonitorQuotaDecision(NamedTuple):
    action: Literal["continue", "limit", "failed"]
    info: Optional[dict] = None
    reason: Optional[str] = None
    allow_credits: bool = False


def monitor_quota_decision(info, cfg, reason=None) -> MonitorQuotaDecision:
    """Choose a quota action from a limit sample/settings, without RPCs or writes."""
    if reason:
        return MonitorQuotaDecision("limit" if cfg["enabled"] else "failed", info, reason)
    if cfg["enabled"] and accounts.exhausted(info, cfg):
        return MonitorQuotaDecision("limit", info, account_rotation.limit_reason(info, cfg), True)
    if cfg["enabled"] and accounts.exhausted(info, cfg, soft=True):
        return MonitorQuotaDecision("limit", info, account_rotation.limit_reason(info, cfg, soft=True), True)
    return MonitorQuotaDecision("continue")


@dataclass
class MonitorEvents:
    """State derived from exec stdout, including an unfinished JSON line."""
    thread: str
    review_entry: Optional[dict] = None
    buffer: bytes = b""
    eof: bool = False
    failed: bool = False
    error: Optional[str] = None
    completed: bool = False
    reason: Optional[str] = None
    authentication_failed: bool = False
    capacity_failed: bool = False
    refusal: Optional[str] = None
    final_message: str = ""
    pending_item: Optional[dict] = None
    text_chunks: list = field(default_factory=list)
    exit_code: Optional[int] = None
    model: Optional[str] = None
    reasoning_effort: Optional[str] = None
    review_model: Optional[str] = None


@dataclass
class MonitorRollout:
    """Rollout polling cursor and the time a live turn crossed its weekly budget."""
    path: Optional[Path]
    previous_stat: Optional[os.stat_result]
    usage_offset: int
    next_search: float
    read_offset: int
    latest_limits: Optional[dict] = None
    next_poll: float = 0.0
    pending_weekly_spent: Optional[float] = None
    weekly_observed_at: float = 0.0
    current_info: Optional[dict] = None


@contextmanager
def monitor_process(st, account, options, prompt):
    """Keep the ACP client, adapter, backend and tool children in one supervised group."""
    directory = config.TASKS / st["slug"]
    with tempfile.TemporaryDirectory(prefix="codex-acp-", dir=directory) as scratch:
        path = Path(scratch)
        (path / "options").write_text(json.dumps(options), encoding="utf-8")
        (path / "prompt").write_text(prompt, encoding="utf-8")
        with (directory / "stderr.log").open("ab") as errors:
            proc = subprocess.Popen(codex_acp.command("codex_acp_turn", scratch), cwd=st["worktree"],
                                    env=accounts.account_env(account), stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=errors, start_new_session=True)
        try:
            yield proc, path / "completed"
        finally:
            procs.terminate(proc)
            proc.stdin.close()


def monitor_thread_started(st, account, stream, reviewing, wrapup, attempt_started):
    """Apply thread.started to task/event state before saving the new thread."""
    thread = stream.thread
    if reviewing and not wrapup:
        stream.review_entry = {"account": account["name"], "thread": thread,
                               "started": attempt_started, "finished": None, "result": None,
                               "round": len(st.get("rounds", [])),
                               "angle": st.get("review_angle") or "correctness"}
        st.setdefault("reviews", []).append(stream.review_entry)
    elif not reviewing:
        st["thread"] = thread
    if not reviewing and not any(t["account"] == account["name"] and t["thread"] == thread for t in st["threads"]):
        st["threads"].append({"account": account["name"], "thread": thread, "started": clock.CLOCK.time()})
    if (st["rotations"] and not st["rotations"][-1].get("event")
            and not st["rotations"][-1]["thread"]):
        st["rotations"][-1]["thread"] = thread
    task_state.save(st)


def monitor_event(st, account, event, stream, control, reviewing, wrapup, attempt_started):
    """Apply one decoded event in wire order; return an immediate stop, if any."""
    if event.get("type") == "thread.started":
        stream.thread = event["thread_id"]
        stream.model = event.get("model") or stream.model
        stream.reasoning_effort = event.get("reasoning_effort") or stream.reasoning_effort
        monitor_thread_started(st, account, stream, reviewing, wrapup, attempt_started)
    if (event.get("type") == "item.completed"
            and (event.get("item") or {}).get("type") == "agent_message"):
        stream.final_message = event["item"].get("text", "")
    stream.refusal = account_rotation.refusal_message(event)
    if stream.refusal is not None:
        st["refusal"] = stream.refusal
        return "refused", None
    if control.repeated(event):
        return "stuck", None
    error = event.get("error")
    category = error.get("category") if isinstance(error, dict) else None
    if account_rotation.limit_error(event) or (category == "limit" and "new_session" not in error.get("actions", [])):
        stream.reason = "usage limit"
    if account_rotation.auth_error(event) or category == "access" or (
            isinstance(error, dict) and error.get("code") == -32000):
        stream.authentication_failed = True
    if not stream.reason and not stream.authentication_failed and account_rotation.capacity_error(event):
        stream.capacity_failed = True
    # `error` events also carry retries ("Reconnecting... 2/5") of turns that complete.
    if event.get("type") == "turn.failed":
        stream.failed = True
        stream.error = (event.get("error") or {}).get("message", "Codex ACP turn failed")
    if event.get("type") == "turn.completed":
        stream.completed = True
    return None


def flush_message(stream, log):
    if stream.pending_item is None:
        return
    item = dict(stream.pending_item, text="".join(stream.text_chunks))
    log.write((json.dumps({"type": "item.completed", "item": item}, ensure_ascii=False) + "\n").encode())
    if item["type"] == "agent_message":
        stream.final_message = item["text"]
    stream.pending_item = None
    stream.text_chunks.clear()


def read_monitor_events(st, account, proc, ready, sel, log, stream, control,
                        reviewing, wrapup, attempt_started):
    """Journal complete events in order, joining ACP text chunks by message ID."""
    for key, _ in ready:
        chunk = os.read(key.fileobj.fileno(), 65536)
        if not chunk:
            sel.unregister(key.fileobj)
            stream.eof = True
        else:
            stream.buffer += chunk
            while b"\n" in stream.buffer:
                line, stream.buffer = stream.buffer.split(b"\n", 1)
                try:
                    event = json.loads(line)
                except ValueError:
                    log.write(line + b"\n")
                    continue
                if event.get("type") == "item.delta":
                    item = event["item"]
                    key = {"type": item["type"], "id": item["id"]}
                    if key != stream.pending_item:
                        flush_message(stream, log)
                        stream.pending_item = key
                    stream.text_chunks.append(item["text"])
                    continue
                flush_message(stream, log)
                log.write(line + b"\n")
                result = monitor_event(st, account, event, stream, control, reviewing, wrapup, attempt_started)
                if result is not None:
                    return result
                if event.get("type") == "thread.started":
                    # monitor_thread_started has durably saved this ID, including on rotation.
                    try:
                        proc.stdin.write(b"prompt\n")
                        proc.stdin.flush()
                    except BrokenPipeError:
                        return "failed", None
    return None


def resolve_monitor_quota(st, request, stopped, control, active_started, on_limit):
    """Run quota effects while exec is alive, preserving stop/deadline priority."""
    if request.action == "failed":
        return "failed", None
    # Quota RPCs and reset-journal locks run while exec is still alive.
    def cancelled():
        return stopped() or control.expired(active_started)

    try:
        decision = on_limit(request.info, request.reason, request.allow_credits, cancelled)
    except RuntimeError:
        if not cancelled():
            raise
        decision = None
    if stopped():
        return task_state.stop_outcome(st, stopped), None
    if control.expired(active_started):
        return "budget_exhausted", None
    return ("limit", decision) if decision is not None or not request.allow_credits else None


def read_monitor_rollout(usage, record_limits):
    """Read new complete lines and keep the last quota across non-quota appends."""
    previous = usage.previous_stat
    observed = usage.path.stat()
    if previous is not None and (observed.st_dev, observed.st_ino, observed.st_size, observed.st_mtime_ns) == (
            previous.st_dev, previous.st_ino, previous.st_size, previous.st_mtime_ns):
        return None
    with usage.path.open("rb") as stream:
        observed = os.fstat(stream.fileno())
        if previous is not None and ((observed.st_dev, observed.st_ino) != (previous.st_dev, previous.st_ino)
                                     or observed.st_size < max(previous.st_size, usage.read_offset)
                                     or (observed.st_size == previous.st_size
                                         and observed.st_mtime_ns != previous.st_mtime_ns)):
            # Replay the rewritten suffix without including earlier execs of a resumed thread.
            usage.read_offset = usage.usage_offset
            usage.latest_limits = None
        stream.seek(usage.read_offset)
        data = stream.read()
    complete = data.rfind(b"\n") + 1
    limits = threads.read_rollout_limits(data[:complete].splitlines(), record_limits)
    usage.read_offset += complete
    usage.previous_stat = observed
    if limits is not None:
        usage.latest_limits = limits
    return usage.latest_limits


def poll_monitor_rollout(st, cfg, account, stream, usage, control, record_limits):
    """Read a changed rollout sample; return its quota action or queue a weekly stop."""
    now = time.monotonic()
    if usage.path is None and now >= usage.next_search:
        usage.path = threads.rollout_path(account["home"], stream.thread)
        usage.next_search = now + config.ROLLOUT_SEARCH_SECONDS
    if usage.path is None or now < usage.next_poll:
        return MonitorQuotaDecision("continue")
    usage.next_poll = now + config.RATE_POLL_SECONDS
    limits = read_monitor_rollout(usage, record_limits)
    if limits is None:
        return MonitorQuotaDecision("continue")
    # A completed model turn needs no wrap-up while the CLI exits.
    # The supervisor checks its final usage after monitor returns.
    if control.weekly is not None and not stream.completed:
        spent = st.get("weekly_used_percent", 0)
        if spent >= control.weekly:
            usage.pending_weekly_spent = spent
            usage.weekly_observed_at = time.monotonic()
            return MonitorQuotaDecision("continue")
    usage.current_info = dict(account, logged_in=True, limits=limits)
    return monitor_quota_decision(usage.current_info, cfg)


def monitor_event_stream(st, cfg, account, proc, receipt, log, stream, usage, control, stopped,
                         on_limit, record_limits, reviewing, wrapup, attempt_started, active_started):
    """Supervise exec/stdout and return the original (outcome, quota payload) pair."""
    with selectors.DefaultSelector() as sel:
        sel.register(proc.stdout, selectors.EVENT_READ)
        while not stream.eof or proc.poll() is None:
            if stopped():
                procs.terminate(proc)
                return task_state.stop_outcome(st, stopped), None
            if control.expired(active_started):
                return "budget_exhausted", None
            ready = sel.select(0.2)
            result = read_monitor_events(st, account, proc, ready, sel, log, stream, control,
                                         reviewing, wrapup, attempt_started)
            if result is not None:
                return result
            if wrapup:
                # A wrap-up gets one bounded attempt, without quota waits or retries.
                if stream.authentication_failed or stream.reason or stream.capacity_failed:
                    return "failed", None
                continue
            if usage.pending_weekly_spent is not None:
                # The final rollout can overtake both the shim's receipt and the ACP reply.
                # Give the shim one short scheduling window, then allow a bounded ACP flush
                # only for the admitted native completion. Neither wait renews on activity.
                if not stream.completed:
                    allowance = 2.0 if receipt.is_file() else 0.25
                    if not (stream.failed or stream.eof) and time.monotonic() < usage.weekly_observed_at + allowance:
                        continue
                    if control.weekly_exhausted(usage.pending_weekly_spent):
                        return "budget_exhausted", None
                usage.pending_weekly_spent = None
            if stream.authentication_failed:
                return ("auth" if cfg["enabled"] else "failed"), None
            if stream.reason:
                request = monitor_quota_decision(usage.current_info, cfg, stream.reason)
                return resolve_monitor_quota(st, request, stopped, control, active_started, on_limit)
            if stream.capacity_failed:
                return "capacity", None
            if (cfg["enabled"] or control.weekly is not None) and stream.thread and proc.poll() is None:
                request = poll_monitor_rollout(st, cfg, account, stream, usage, control, record_limits)
                if request.action != "continue":
                    result = resolve_monitor_quota(st, request, stopped, control, active_started, on_limit)
                    if result is not None:
                        return result
        stream.exit_code = proc.wait()
    return ("completed" if stream.exit_code == 0 and not stream.failed else "failed"), None


def finish_monitor(st, account, proc, stream, usage, last, reviewing, wrapup,
                   record_limits, telemetry, usage_before, weekly_started):
    """Close stdout, finalize results, account final rollout/telemetry, then save."""
    proc.stdout.close()
    st.pop("codex_pid", None)
    message = stream.final_message
    if message:
        last.write_text(message + "\n", encoding="utf-8")
    result = None
    if stream.completed and stream.exit_code == 0 and not stream.failed and not stream.refusal:
        result = result_schema.parse_result(message, reviewing=reviewing, reflecting=st.get("kind") == "reflect")
    if wrapup:
        st["wrapup"]["result"] = result
        if stream.refusal:
            st["wrapup"]["refusal"] = stream.refusal
    elif stream.review_entry is not None:
        stream.review_entry["finished"] = clock.CLOCK.time()
        stream.review_entry["result"] = result
        if stream.refusal:
            stream.review_entry.update(outcome="refused", refusal=stream.refusal)
    elif not reviewing and st.get("kind") != "scout":
        st["result"] = result
    settings = {"model": stream.model, "reasoning_effort": stream.reasoning_effort}
    final_path = usage.path
    try:
        final_path = usage.path or threads.rollout_path(account["home"], stream.thread)
        reported = threads.rollout_model_settings(final_path, usage.usage_offset)
        # Native review inherits the parent model unless review_model replaces it.
        if stream.review_model is None or stream.review_model == reported.get("model"):
            settings.update(reported)
    except Exception as exc:
        telemetry_log.telemetry_error(st, exc)
    st.update(model=settings["model"], reasoning_effort=settings["reasoning_effort"])
    if telemetry is not None:
        telemetry.model, telemetry.reasoning_effort = settings["model"], settings["reasoning_effort"]
    try:
        if final_path is not None:
            threads.rollout_limits(final_path, record_limits, usage.usage_offset)
        if telemetry is not None:
            telemetry.add_usage(account["name"], stream.thread, usage_before,
                                final_path, usage.usage_offset,
                                st.get("weekly_used_percent", 0) - weekly_started, **settings)
    except Exception as exc:
        telemetry_log.telemetry_error(st, exc)
    task_state.save(st)


def monitor(st, cfg, account, prompt, effort, stopped, on_limit,
            control=None, wrapup=False, wrapup_thread=None, quota_snapshot=None, resume_thread=None):
    """Run one ACP session attempt, preserving native rollout and task accounting."""
    d = config.TASKS / st["slug"]
    accounts.prepare_home(account)
    reviewing = st.get("kind") == "review"
    control = control or TurnControl(cfg.get("max_review_minutes", 30) if st.get("kind") in ("review", "scout")
                                     else st.get("max_turn_minutes", cfg.get("max_turn_minutes")),
                                     cfg.get("repeat_limit", 3), st.get("max_task_weekly_percent"))
    thread = (wrapup_thread if wrapup else resume_thread if resume_thread is not None
              else "" if reviewing else st.get("thread", ""))
    stream = MonitorEvents(thread)
    last = d / ("review.md" if reviewing else "last.md")
    last.unlink(missing_ok=True)
    kind = st.get("kind", "work")
    sandbox = ("read-only" if kind in ("scout", "reflect") else
               "workspace-write" if st.get("sandbox") == "workspace" else None)
    if sandbox == "workspace-write":
        rules = sandboxing.sandbox_rules(cfg, reviewing=reviewing, no_push=st.get("no_push", False))
        try:
            rules = sandboxing.repository_rules(rules, st["worktree"])
        except (OSError, subprocess.CalledProcessError):
            pass
        if not prompt.endswith(rules):
            prompt += "\n\n" + rules
    defaults = threads.configured_model_settings(account["home"], [])
    review_model = (st.get("review_model") or config.role_route(cfg, "review", "codex").get("model")
                    or defaults["review_model"]) if reviewing else None
    model = review_model if reviewing else st.get("task_model")
    schema = (None if kind == "scout" else result_schema.REFLECT_SCHEMA if kind == "reflect" else
              result_schema.REVIEW_SCHEMA if reviewing else result_schema.RESULT_SCHEMA)
    # A resume may report the previous turn's override. Reapply the configured
    # default when the task has cleared its model or effort override.
    if thread:
        model = model or defaults["model"]
    if model or thread:
        effort = effort or defaults["reasoning_effort"]
    options = {"binary": config.codex_binary(), "adapter": config.codex_adapter(), "thread": thread,
               "slug": st["slug"], "model": model, "effort": effort, "sandbox": sandbox,
               "roots": st.get("writable_dirs", []), "schema": schema, "review": reviewing}
    stream.model = model or defaults["model"]
    stream.reasoning_effort = effort or defaults["reasoning_effort"]
    stream.review_model = review_model
    path = threads.rollout_path(account["home"], thread) if thread else None
    previous_stat = path.stat() if path else None
    usage_offset = previous_stat.st_size if previous_stat is not None else 0
    telemetry = telemetry_log.telemetry_phase(st)
    usage_before = threads.rollout_usage(path)[1] if telemetry is not None else None
    weekly_started = st.get("weekly_used_percent", 0)
    weekly_seeded = budgets.weekly_used(quota_snapshot or {}) is not None
    if weekly_seeded:
        st.update(budgets.monitor_weekly_usage(st, account["name"], quota_snapshot, False).updates)

    def record_limits(limits):
        nonlocal weekly_seeded
        sample = budgets.monitor_weekly_usage(st, account["name"], limits, weekly_seeded)
        st.update(sample.updates)
        weekly_seeded = sample.seeded
        return sample.delta

    next_search = time.monotonic() + config.ROLLOUT_SEARCH_SECONDS if thread else 0.0
    usage = MonitorRollout(path, previous_stat, usage_offset, next_search, read_offset=usage_offset)
    st["exec_event_start"] = len(threads.events(st))
    task_state.save(st)
    with (d / "events.jsonl").open("ab", buffering=0) as log:
        if stopped():
            return task_state.stop_outcome(st, stopped), None
        attempt_started = clock.CLOCK.time()
        active_started = clock.CLOCK.monotonic()
        proc = None
        try:
            with monitor_process(st, account, options, prompt) as (proc, receipt):
                st["codex_pid"] = proc.pid
                task_state.save(st)
                result = monitor_event_stream(st, cfg, account, proc, receipt, log, stream, usage, control, stopped,
                                              on_limit, record_limits, reviewing, wrapup, attempt_started, active_started)
        finally:
            if proc is not None:
                control.elapsed = budgets.monitor_time_usage(control.elapsed, control.seconds, control.minutes,
                                                     active_started, clock.CLOCK.monotonic()).elapsed
                flush_message(stream, log)
                finish_monitor(st, account, proc, stream, usage, last, reviewing, wrapup,
                               record_limits, telemetry, usage_before, weekly_started)
    if result[0] == "failed":
        # A rejected prompt and its final quota can arrive in either order.
        # Once final accounting calls for a wrap-up, the rejection is already
        # in the event journal and is not a supervisor error.
        if control.weekly_exhausted(st.get("weekly_used_percent", 0)):
            return "budget_exhausted", None
        if stream.error:
            st["error"] = stream.error
            task_state.save(st)
    return result
