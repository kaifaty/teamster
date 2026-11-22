"""Work turns, wrap-up turns and turn execution."""
import json
import sys

from . import account_rotation, accounts, budgets, checking, claude_accounts, claude_review, claude_runner, clock, config, duty, duty_acp, duty_chat, executors, notifications, opencode_runner, procs, prompts, publishing, result_schema, task_state, telemetry_log, threads, turn_monitor


LIMIT_REASONS = ("usage limit", "authentication failed", "token unavailable")


def run_claude_scout_turn(st, cfg, prompt, effort, current_message, stopped, sleep, new_turn=True):
    """Run read-only research or reflection, retrying review accounts without waiting or falling back."""
    last = config.TASKS / st["slug"] / "last.md"
    last.unlink(missing_ok=True)
    reflecting = st.get("kind") == "reflect"
    minutes = st["max_turn_minutes"] if reflecting else cfg["max_review_minutes"]
    deadline = clock.CLOCK.monotonic() + minutes * config.MINUTE_SECONDS
    settings = cfg["claude"]
    model = st.get("task_model") or settings.get("model")
    attempted = set()
    preferred = st.get("claude_account")
    account = None
    if preferred:
        account = claude_review.select_account(
            cfg, "review", exclude={a["name"] for a in claude_accounts.accounts(cfg) if a["name"] != preferred},
            stopped=stopped, task_type=st.get("task_type"), model=model)
    if account is None:
        account = claude_review.select_account(cfg, "review", stopped=stopped, task_type=st.get("task_type"),
                                               model=model)
    # Snapshot the whole work tree even when the inspected directory is a subdirectory.
    snapshot_state = {"worktree": procs.sh(config.GIT + ["rev-parse", "--show-toplevel"], cwd=st["worktree"])}
    while account is not None and not stopped():
        name = account["name"]
        attempted.add(name)
        previous = st.get("claude_account")
        if previous and previous != name:
            prompt = threads.handoff(st, current_message=current_message, cfg=cfg)
            st["rotations"].append({"at": clock.CLOCK.time(), "from": previous, "to": name,
                                    "reason": st.get("error") or "account unavailable", "thread": ""})
            st["session_id"] = ""
        st.update(claude_account=name, outcome="running")
        st.pop("error", None)
        task_state.save(st)
        before = claude_review.worktree_snapshot(snapshot_state)
        launched = False

        def started(proc):
            nonlocal launched
            launched = True
            st["claude_pid"] = proc.pid
            task_state.save(st)

        def progress(telemetry):
            if telemetry.get("session_id") and telemetry["session_id"] != st.get("session_id"):
                st["session_id"] = telemetry["session_id"]
                task_state.save(st)

        try:
            response = claude_runner.run_claude(
                account, st["worktree"], prompt, stopped, deadline,
                model, effort or settings.get("effort"),
                settings["max_turns"], role="reflect" if reflecting else "scout",
                session_id=st.get("session_id") or None,
                started=started, progress=progress,
                task_dir=config.TASKS / st["slug"])
        finally:
            st.pop("claude_pid", None)
            task_state.save(st)
        if launched and claude_review.worktree_snapshot(snapshot_state) != before:
            response.update(outcome="failed", result=None, raw_message="",
                            reason="reflect modified the reading room" if reflecting else "scout modified the directory")
        telemetry = response["telemetry"]
        progress(telemetry)
        phase = telemetry_log.telemetry_phase(st)
        if phase is not None:
            phase.add_claude_usage(telemetry, account=name)
        st["outcome"] = task_state.stop_outcome(st, stopped) or response["outcome"]
        reason = response.get("reason")
        if st["outcome"] == "completed" and reflecting:
            st["result"] = response["result"]
            message = json.dumps(response["result"], ensure_ascii=False)
            last.write_text(message, encoding="utf-8")
            threads.record_session_message(st, message)
        elif st["outcome"] == "completed":
            last.write_text(response["result"], encoding="utf-8")
            threads.record_session_message(st, response["result"])
        elif reason:
            st["error"] = reason
        if st["outcome"] == "budget_exhausted":
            claude_review.record_timeout(st, minutes)
        task_state.save(st)
        if response["outcome"] != "unavailable" or reason not in LIMIT_REASONS or stopped():
            return
        if "limited_until" not in response:  # The stream has already marked its own rejection.
            claude_accounts.mark_limited(name, token_unavailable=reason == "token unavailable", reason=reason,
                                         model=model)
        account = claude_review.select_account(cfg, "review", exclude=attempted, stopped=stopped,
                                               task_type=st.get("task_type"), model=model)
    st["outcome"] = task_state.stop_outcome(st, stopped) or "unavailable"
    if st["outcome"] == "unavailable":
        st["error"] = (f"No available Claude account for {'reflect' if reflecting else 'scout'}"
                       + (f": {st['error']}" if st.get("error") else ""))
    task_state.save(st)


def run_duty_chat_turn(st, cfg, prompt, effort, current_message, stopped, sleep, new_turn=True):
    """One duty chat turn on the current duty account, never another account.

    When the duty moved since the last turn, the conversation continues on the new account
    with the rotation handoff. A limit or a missing duty ends the turn unavailable or failed.
    """
    directory = config.TASKS / st["slug"]
    last = directory / "last.md"
    last.unlink(missing_ok=True)
    account, refusal = duty_chat.chat_account(cfg)
    if account is None:
        st.update(outcome="failed", error=refusal)
        task_state.save(st)
        return
    name, family = account["name"], account["family"]
    previous_executor = executors.from_state(st)
    previous = previous_executor.account(st)
    if st.get("task_model_family", previous_executor.name) != family:
        st.pop("task_model", None)
        st.pop("task_model_family", None)
    if previous and (previous_executor.name, previous) != (family, name):
        prompt = threads.handoff(st, current_message=current_message, cfg=cfg)
        source = previous if previous_executor.name == family else f"{previous_executor.name}/{previous}"
        target = name if previous_executor.name == family else f"{family}/{name}"
        st["rotations"].append({"at": clock.CLOCK.time(), "from": source, "to": target,
                                "reason": f"the duty moved to {target}", "thread": ""})
        st.update(session_id="", thread="")
        notifications.notify(st, cfg, "rotated", f"rotated from {source} to {target}: the duty moved",
                             **{"from": source, "to": target, "account": name})
    executor = executors.get(family)
    st.update(executor=family, outcome="running")
    st[executor.account_field] = name
    st.pop("error", None)
    task_state.save(st)
    settings = cfg["duty"]
    # say duty --max-minutes and --model replace the settings for the conversation, as say does for a task.
    minutes = st.get("max_turn_minutes") or settings["chat_max_minutes"]
    deadline = clock.CLOCK.monotonic() + minutes * config.MINUTE_SECONDS
    pid_field = family + "_pid"

    def started(proc):
        st[pid_field] = proc.pid
        task_state.save(st)

    def progress(telemetry):
        cursor = telemetry.get(executor.cursor_field)
        if cursor and cursor != executor.cursor(st):
            st[executor.cursor_field] = cursor
            if family == "codex":
                st["threads"].append({"account": name, "thread": cursor, "started": clock.CLOCK.time()})
            task_state.save(st)

    route = config.role_route(cfg, "duty", family)
    configured_model = (settings["chat_model"] or cfg["claude"].get("model") if family == "claude"
                        else settings["chat_codex_model"])
    model = st.get("task_model") or route.get("model") or configured_model
    effort = effort or route.get("effort") or settings["chat_effort" if family == "claude" else "chat_codex_effort"]
    try:
        response = executor.call(
            "duty", account, st["worktree"], prompt, stopped, deadline, model, effort,
            thread_id=executor.cursor(st) or None, system_text=duty_chat.system_text(st["worktree"]),
            started=started, progress=progress, task_dir=directory, max_minutes=minutes)
        if (family == "codex" and st.get("thread")
                and response.get("reason") == "no rollout found for thread id " + st["thread"]):
            # A pre-isolation duty cursor belongs to the account's old store.
            # No turn began; continue from teamster's conversation in the new store.
            prompt = threads.handoff(st, current_message=current_message, cfg=cfg)
            st["thread"] = ""
            task_state.save(st)
            response = executor.call(
                "duty", account, st["worktree"], prompt, stopped, deadline, model, effort,
                system_text=duty_chat.system_text(st["worktree"]),
                started=started, progress=progress, task_dir=directory, max_minutes=minutes)
    finally:
        st.pop(pid_field, None)
        task_state.save(st)
    telemetry = response["telemetry"]
    progress(telemetry)
    st.update(model=telemetry.get("model"), reasoning_effort=telemetry.get("reasoning_effort"))
    phase = telemetry_log.telemetry_phase(st)
    if phase is not None:
        phase.provider = executor.telemetry_provider(st, "duty")
        if family == "claude":
            phase.add_claude_usage(telemetry, account=name)
        else:
            phase.add_usage(name, st.get("thread"), None, None, 0,
                            model=st.get("model"), reasoning_effort=st.get("reasoning_effort"))
    st["outcome"] = task_state.stop_outcome(st, stopped) or response["outcome"]
    reason = response.get("reason")
    if st["outcome"] == "completed":
        st["result"] = response["result"]
        message = json.dumps(response["result"], ensure_ascii=False)
        last.write_text(message, encoding="utf-8")
        if family == "claude":
            threads.record_session_message(st, message)
        duty_chat.record_chat_turn(st)
    elif st["outcome"] == "unavailable" and reason in LIMIT_REASONS:
        if family == "claude" and "limited_until" not in response:  # The stream has already marked its own rejection.
            claude_accounts.mark_limited(name, token_unavailable=reason == "token unavailable", reason=reason,
                                         model=model)
        st["error"] = f"the duty account {name} is unavailable: {reason}"
    elif st["outcome"] == "budget_exhausted":
        st["error"] = f"the duty chat turn reached its time budget ({minutes:g} minutes)"
    elif reason:
        st["error"] = reason
    task_state.save(st)


def claude_work_turn(st, cfg, prompt, effort, stopped, account, wrapup=False, deadline=None):
    """Run one Claude session attempt; return its outcome and unavailability reason.

    A work attempt that reached an account limit returns outcome ``limit``; its
    state still records ``unavailable`` until the caller rotates or waits.
    """
    directory = config.TASKS / st["slug"]
    last = directory / "last.md"
    last.unlink(missing_ok=True)
    settings = cfg["claude"]
    binding = st.get("work_binding")
    model = binding["model"] if binding else st.get("task_model") or settings.get("model")
    if model == "default":
        model = None
    if deadline is None:
        minutes = 10 if wrapup else st.get("max_turn_minutes", cfg.get("max_turn_minutes"))
        deadline = None if minutes is None else clock.CLOCK.monotonic() + minutes * config.MINUTE_SECONDS
    weekly = budgets.ClaudeWeeklyUsage(account["name"])

    def progress(telemetry):
        weekly.observe(telemetry)
        session_id = telemetry.get("session_id")
        cycle = st.get("cycle") or {}
        if session_id and (session_id != st.get("session_id") or "waiting_prompt" in cycle):
            st["session_id"] = session_id
            cycle.pop("waiting_prompt", None)
            cycle.pop("waiting_active_seconds", None)
            task_state.save(st)

    def started(proc):
        st["claude_pid"] = proc.pid
        task_state.save(st)

    try:
        response = claude_runner.run_work_turn(
            account, st["worktree"], directory, prompt, lambda: stopped() or (not wrapup and weekly.exhausted(st)),
            session_id=st.get("session_id") or None,
            model=model,
            effort=effort or settings.get("effort"),
            deadline=deadline, started=started, progress=progress,
            max_minutes=st.get("max_turn_minutes", cfg.get("max_turn_minutes")))
    finally:
        st.pop("claude_pid", None)
        task_state.save(st)
    telemetry = response["telemetry"]
    if telemetry.get("session_id"):
        st["session_id"] = telemetry["session_id"]
    st.update(model=telemetry.get("model"), reasoning_effort=telemetry.get("reasoning_effort"))
    weekly_stopped = not wrapup and weekly.exhausted(st)
    st["weekly_used_percent"] = st.get("weekly_used_percent", 0) + weekly.spent
    phase = telemetry_log.telemetry_phase(st)
    if phase is not None:
        phase.add_claude_usage(telemetry, account=account["name"], weekly_before=weekly.before,
                              weekly_after=weekly.after, weekly_spent=weekly.spent)
    result = response["result"]
    outcome = task_state.stop_outcome(st, stopped) or response["outcome"]
    if outcome == "unknown":
        outcome = "completed" if response["reason"] == "invalid structured output" else "failed"
    if weekly_stopped and not stopped() and outcome != "failed":
        outcome = "completed" if result is not None else "budget_exhausted"
    if wrapup:
        st["wrapup"].update(outcome=outcome, result=result if outcome == "completed" else None)
    else:
        st.update(outcome=outcome, result=result)
    if response["raw_message"] or outcome == "completed":
        last.write_text(response["raw_message"] or json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        if outcome != "unavailable":
            # Handoffs to another account read summaries from structured results.
            threads.record_session_message(st, json.dumps(result, ensure_ascii=False) if result is not None
                                          else response["raw_message"])
    reason = response.get("reason")
    if outcome == "unavailable":
        reason = reason or "account unavailable"
        st["error"] = f"No available Claude account: {account['name']} ({reason})"
        if reason in LIMIT_REASONS:
            if "limited_until" not in response:  # The stream has already marked its own rejection.
                claude_accounts.mark_limited(account["name"], token_unavailable=reason == "token unavailable",
                                             reason=reason, model=model)
            if not wrapup:
                outcome = "limit"
    elif reason and outcome != "completed":
        st["error"] = reason
    task_state.save(st)
    return outcome, reason


def run_claude_turn(st, cfg, prompt, effort, current_message, stopped, sleep, new_turn=True):
    """Continue the assigned session, or apply the pool policy of an older record."""
    minutes = st.get("max_turn_minutes", cfg.get("max_turn_minutes"))
    deadline = None if minutes is None else clock.CLOCK.monotonic() + minutes * config.MINUTE_SECONDS
    if deadline is not None:
        deadline -= (st.get("cycle") or {}).get("waiting_active_seconds", 0)
    tried, rotation, account, reason = set(), None, None, None
    while True:
        # Limit probes and reset waits are not part of the turn's time budget.
        choice_started = clock.CLOCK.monotonic()
        chosen = account_rotation.claude_choice(st, cfg, stopped, exclude=tried)
        if (chosen is None or account_rotation.restoring_wait(st)) and not stopped():
            st.pop("error", None)
            retry_prompt = prompt
            if account and st.get("session_id"):
                retry_prompt = prompts.reset_resume_prompt(cfg)
                if current_message or "work_binding" not in st:
                    retry_prompt += "\n\n" + prompt
            if st.get("work_binding") and deadline is not None:
                st["cycle"]["waiting_active_seconds"] = max(0, minutes * config.MINUTE_SECONDS - (deadline - choice_started))
            reason_at_limit = "assigned Claude account unavailable" if st.get("work_binding") else "all Claude accounts unavailable"
            chosen = account_rotation.wait_for_claude_account(
                st, cfg, reason_at_limit + (f"; {account['name']}: {reason}" if account else ""),
                stopped, sleep, prompt=retry_prompt)
            tried = set()
        if deadline is not None:
            deadline += clock.CLOCK.monotonic() - choice_started
        if stopped():
            st["outcome"] = task_state.stop_outcome(st, stopped)
            task_state.save(st)
            return
        if chosen is None:
            return
        st.pop("error", None)
        previous = st.get("claude_account")
        if account is not None and chosen["name"] == account["name"]:
            # Without a session, repeat the previous attempt's prompt, including any handoff.
            if st.get("session_id"):
                attempt_prompt = retry_prompt
        elif previous and chosen["name"] != previous:
            attempt_prompt = threads.handoff(st, current_message=current_message, cfg=cfg)
            st["rotations"].append({"at": clock.CLOCK.time(), "from": previous, "to": chosen["name"],
                                    "reason": reason or "unavailable for work", "thread": ""})
            rotation = st["rotations"][-1]
            st.update(claude_account=chosen["name"], session_id="")
            notifications.notify(st, cfg, "rotated", f"rotated from {rotation['from']} to {rotation['to']}",
                                 **{"from": rotation["from"], "to": rotation["to"], "account": chosen["name"]})
        else:
            attempt_prompt = prompt
        account = chosen
        st.update(claude_account=account["name"], outcome="running")
        if "work_binding" in st:
            account = bind_claude_account(st, cfg, account)
        task_state.save(st)
        tried.add(account["name"])
        outcome, reason = claude_work_turn(st, cfg, attempt_prompt, effort, stopped, account, deadline=deadline)
        if rotation is not None and not rotation["thread"] and st.get("session_id"):
            rotation["thread"] = st["session_id"]
            task_state.save(st)
        if outcome != "limit" or ("work_binding" in st and reason != "usage limit"):
            break
    if outcome == "budget_exhausted" and not stopped():
        phase = telemetry_log.telemetry_phase(st)
        if phase is not None:
            phase.finish(outcome=outcome)
        reason = ({"outcome": "budget_exhausted", "weekly": st["max_task_weekly_percent"],
                   "spent": st["weekly_used_percent"]} if budgets.weekly_budget_exhausted(st) else
                  {"outcome": "budget_exhausted", "minutes": st.get("max_turn_minutes", cfg.get("max_turn_minutes"))})
        wrapup_turn(st, cfg, account, effort, stopped, reason)
    elif budgets.weekly_budget_exhausted(st):
        if outcome == "completed":
            phase = telemetry_log.telemetry_phase(st)
            if phase is not None:
                phase.finish(outcome=outcome)
            publishing.publish_turn(st, stopped)
        budgets.stop_at_weekly_budget(st)
        task_state.save(st)


def bind_claude_account(st, cfg, account):
    binding = st.get("work_binding")
    model = binding["model"] if binding else st.get("task_model") or cfg["claude"].get("model")
    resource = claude_runner.keychain_connection(account)
    task_state.bind_work(st, model, account=account["name"], **resource)
    return dict(account, credential_id=resource["credential_id"])


def opencode_work_turn(st, prompt, stopped, minutes, wrapup=False):
    last = config.TASKS / st["slug"] / "last.md"
    last.unlink(missing_ok=True)
    st.update(model=st["task_model"], reasoning_effort=None)
    phase = telemetry_log.telemetry_phase(st)
    if phase is not None:
        phase.model = st["model"]

    def started(proc):
        st["opencode_pid"] = proc.pid
        task_state.save(st)

    def created(session_id):
        st["session_id"] = session_id
        task_state.save(st)

    deadline = None if minutes is None else clock.CLOCK.monotonic() + minutes * config.MINUTE_SECONDS
    env = None
    if "work_binding" in st:
        connection, env = opencode_runner.provider_connection(st["worktree"], st["task_model"])
        task_state.bind_work(st, st["task_model"], **connection)
    prompt += "\n\nReturn only a JSON object matching this schema:\n" + json.dumps(result_schema.RESULT_SCHEMA)
    try:
        outcome, message = opencode_runner.run_opencode(
            st["worktree"], prompt, st["model"], st.get("session_id"), stopped, deadline,
            title=None if st.get("session_id") and threads.session_messages(st) else st["slug"],
            started=started, created=created, env=env)
    finally:
        st.pop("opencode_pid", None)
        task_state.save(st)
    outcome = task_state.stop_outcome(st, stopped) or outcome
    result = None
    if outcome == "completed":
        last.write_text(message, encoding="utf-8")
        result = result_schema.parse_result(message)
        if result is None:
            outcome, message = "failed", "OpenCode returned an invalid work result"
        else:
            threads.record_session_message(st, message)
    state = st["wrapup"] if wrapup else st
    state.update(outcome=outcome, result=result)
    if outcome in ("failed", "unavailable", "exhausted"):
        state["error"] = message
    task_state.save(st)
    return outcome


def run_opencode_turn(st, cfg, prompt, effort, current_message, stopped, sleep, new_turn=True):
    minutes = st.get("max_turn_minutes", cfg.get("max_turn_minutes"))
    # The first process can stop after opening the session but before delivering the brief.
    if current_message and st.get("session_id") and not threads.session_messages(st):
        prompt = threads.handoff(st, current_message=True, cfg=cfg)
    outcome = opencode_work_turn(st, prompt, stopped, minutes)
    if outcome == "budget_exhausted" and not stopped():
        phase = telemetry_log.telemetry_phase(st)
        if phase is not None:
            phase.finish(outcome=outcome)
        wrapup_turn(st, cfg, None, effort, stopped, {"outcome": outcome, "minutes": minutes})


def opencode_wrapup_turn(st, cfg, account, prompt, effort, stopped, thread):
    # The budget may have expired before OpenCode accepted its first work prompt.
    if not threads.session_messages(st):
        prompt = threads.handoff(st, cfg=cfg) + "\n\n" + prompt
    return opencode_work_turn(st, prompt, stopped, 10, wrapup=True)


def wrapup_turn(st, cfg, account, effort, stopped, reason, review_entry=None, quota_probe_cancelled=False):
    with telemetry_log.record_phase(st, "wrapup", stopped) as phase:
        _wrapup_turn(st, cfg, account, effort, stopped, reason, review_entry, quota_probe_cancelled)
        phase.finish(outcome=task_state.stop_outcome(st, stopped) or st["wrapup"]["outcome"])


def _wrapup_turn(st, cfg, account, effort, stopped, reason, review_entry=None, quota_probe_cancelled=False):
    """Publish the typed stop and allow exactly one short resume on its thread."""
    executor = executors.for_turn(st)
    thread = ((review_entry or {}).get("thread") if st.get("kind") == "review"
              else executor.cursor(st))
    if not (st.get("wrapup") or {}).get("pending"):
        st["turn_stop"] = dict(reason, at=clock.CLOCK.time())
        st.setdefault("turn_stops", []).append(dict(st["turn_stop"], turn=st.get("turns", 0)))
        st["outcome"] = reason["outcome"]
        st["review_skipped"] = reason["outcome"]
        st["wrapup"] = {"outcome": "not_run", "result": None}
        if st.get("work_binding") and thread:
            st["wrapup"]["pending"] = True
            if quota_probe_cancelled:
                st["wrapup"]["quota_probe_cancelled"] = True
        task_state.save(st)
        notifications.notify(st, cfg, reason["outcome"], turn_monitor.turn_stop_message(reason),
                             account=account["name"] if account else None, **reason)
    if not thread or stopped() or st.get("kind") == "reflect":
        return
    if st.get("kind") not in ("review", "scout"):
        st["result"] = None
    try:
        st["wrapup"]["outcome"] = executor.call(
            "wrapup", st, cfg, account, prompts.wrapup_prompt(st, reason, cfg), effort, stopped, thread)
    except (Exception, SystemExit) as exc:
        st["wrapup"].update(outcome="failed", error=str(exc))
    if st["wrapup"]["outcome"] != "completed":
        st["wrapup"]["result"] = None
        last = config.TASKS / st["slug"] / ("review.md" if st.get("kind") == "review" else "last.md")
        last.unlink(missing_ok=True)
    if st.get("kind") not in ("review", "scout"):
        st["result"] = st["wrapup"]["result"]
    elif review_entry is not None and st["wrapup"]["outcome"] == "completed":
        review_entry.update(result=st["wrapup"]["result"], finished=clock.CLOCK.time())
    if review_entry is not None and st["wrapup"]["outcome"] == "refused":
        review_entry.update(outcome="refused", refusal=st["refusal"], result=None, finished=clock.CLOCK.time())
    st["outcome"] = (task_state.stop_outcome(st, stopped) or
                     ("refused" if st["wrapup"]["outcome"] == "refused" else reason["outcome"]))
    if st["outcome"] != "interrupted":
        st["wrapup"].pop("pending", None)
    task_state.save(st)


def run_turn(st, cfg, prompt, effort, current_message, stopped, sleep, new_turn=True):
    kind = st.get("kind", "work")
    phase = "fix" if kind == "work" and st.get("rounds") else kind
    with telemetry_log.record_phase(st, phase, stopped):
        st.pop("refusal", None)
        if kind == "reflect":
            return reflect_turn(st, cfg, prompt, effort, current_message, stopped, sleep, new_turn=new_turn)
        if kind == duty_chat.CHAT_KIND:
            return run_duty_chat_turn(st, cfg, prompt, effort, current_message, stopped, sleep, new_turn=new_turn)
        return executors.for_turn(st).call("scout" if kind == "scout" else "turn", st, cfg, prompt, effort, current_message,
                                           stopped, sleep, new_turn=new_turn)


def reflect_turn(st, cfg, prompt, effort, current_message, stopped, sleep, new_turn=True):
    """A read-only scout turn in the reading room that must end with a valid reflect result."""
    before = claude_review.worktree_snapshot(st)
    executors.for_turn(st).call("scout", st, cfg, prompt, effort, current_message, stopped, sleep, new_turn=new_turn)
    if claude_review.worktree_snapshot(st) != before:
        st.update(outcome="failed", result=None, error="reflect modified the reading room")
    elif st.get("outcome") == "completed" and st.get("result") is None:
        st.update(outcome="failed", error="invalid reflect result")
    task_state.save(st)


def _run_turn(st, cfg, prompt, effort, current_message, stopped, sleep, new_turn=True):
    """Run one work/scout/review phase, sharing quota, rotation and reset handling."""
    reviewing = st.get("kind") == "review"
    cfg = account_rotation.codex_work_config(st, cfg)
    original_prompt = prompt
    minutes = (cfg.get("max_review_minutes", 30) if st.get("kind") in ("review", "scout")
               else st.get("max_turn_minutes", cfg.get("max_turn_minutes")))
    control = turn_monitor.TurnControl(minutes, cfg.get("repeat_limit", 3), st.get("max_task_weekly_percent"))
    control.elapsed = (st.get("cycle") or {}).get("waiting_active_seconds", 0)
    visited = set()
    soft_visited = {}
    rotations = 0
    rotation = None
    soft_rotation = False
    floor_rotation = False
    capacity_pauses = 0
    capacity_resumed_at = None
    resume_thread = (st.get("cycle") or {}).get("waiting_review_thread") if reviewing else None
    if new_turn:
        st.update(auth_excluded=[], auth_excluded_ids=[], auth_transitions=0, auth_failures={})
        st.pop("reset_reconciled", None)
    quota_snapshot = None
    if reviewing and not cfg["accounts"]:
        st.update(outcome="unavailable", error="No Codex account configured for review")
        task_state.save(st)
        return
    if st.get("work_binding"):
        chosen = account_rotation.bound_codex_ready(st, cfg, prompt, stopped, sleep)
        if not chosen:
            return
        account = cfg["accounts"][0]
        quota_snapshot = chosen.get("limits")
        budgets.warn_weekly_headroom(st, cfg, [chosen])
    elif cfg["enabled"]:
        infos = account_rotation.task_snapshots(st, cfg, stopped, new_turn=new_turn)
        if "work_binding" not in st:
            budgets.warn_weekly_headroom(st, cfg, infos)
        current = next((i for i in infos if i["name"] == st["account"]), {})
        same_account = {i["name"] for i in infos if current.get("account_id")
                        and i.get("account_id") == current["account_id"]}
        resuming = bool(st.get("thread")) and not reviewing
        # New work skips the duty account; a resumed thread keeps its own account.
        usable = resuming and current.get("logged_in") and not accounts.exhausted(current, cfg)
        reserved = duty.codex_reserved(infos, cfg, () if usable else same_account if resuming else ())
        chosen = accounts.available(infos, cfg, (same_account if resuming else set()) | reserved)
        if usable:
            if (not accounts.exhausted(current, cfg, soft=True) or not chosen
                    or accounts.exhausted(chosen, cfg, soft=True)):
                chosen = current
            else:
                soft_rotation = True
        floor_reason = None
        if not chosen and cfg["credits"]:
            if (current.get("logged_in") and accounts.has_credits(current, cfg)
                    and (resuming or current.get("name") not in reserved)):
                chosen = current
            else:
                floor_reason = accounts.credit_floor_reason(current, cfg) if current.get("logged_in") else None
                chosen = accounts.credit_account(infos, cfg, reserved)
        if stopped():
            return
        if not chosen or account_rotation.restoring_wait(st):
            chosen = account_rotation.wait_for_account(
                st, infos, cfg, "all accounts unavailable" + (f"; {floor_reason}" if floor_reason else ""),
                stopped, sleep, prompt=prompt)
            if not chosen:
                return
        if resuming and chosen["name"] != st["account"]:
            prompt = threads.handoff(st, current_message=current_message, cfg=cfg)
            reason = floor_reason or account_rotation.limit_reason(current, cfg, soft=soft_rotation)
            if not any(a["name"] == st["account"] for a in cfg["accounts"]):
                reason = "account removed"
            st["rotations"].append({"at": clock.CLOCK.time(), "from": st["account"], "to": chosen["name"],
                                    "reason": reason, "thread": ""})
            floor_rotation = floor_reason is not None
            rotation = st["rotations"][-1]
            if not soft_rotation:
                rotations += 1
                visited.add(st["account"])
            else:
                soft_visited[st["account"]] = current["limits"]
            st["thread"] = ""
        account = accounts.account_named(cfg, chosen["name"])
        quota_snapshot = chosen.get("limits")
        if not reviewing:
            st["account"] = account["name"]
        if "work_binding" in st and not st["work_binding"]:
            if not chosen.get("account_id") or not chosen.get("member_id"):
                raise ValueError(f"Cannot identify the owner of Codex account {account['name']}. Check its login.")
            model = st.get("task_model") or threads.configured_model_settings(account["home"])["model"]
            task_state.bind_work(st, model, account=account["name"], home=account["home"],
                                 account_id=chosen["account_id"], member_id=chosen["member_id"])
            cfg = account_rotation.codex_work_config(st, cfg)
            budgets.warn_weekly_headroom(st, cfg, [chosen])
    elif reviewing and st["account"] is None:
        account = cfg["accounts"][0]
    else:
        account = accounts.account_named(cfg, st["account"])
    if reviewing:
        st["review_account"] = account["name"]
    task_state.save(st)
    if rotation is not None:
        notifications.notify(st, cfg, "rotated", f"rotated from {rotation['from']} to {rotation['to']}" +
               (f": {rotation['reason']}" if soft_rotation or floor_rotation else ""),
               **{"from": rotation["from"], "to": rotation["to"], "account": account["name"]})

    def on_limit(local, reason, allow_credits, cancelled):
        infos = account_rotation.task_snapshots(st, cfg, cancelled)
        current = next((i for i in infos if i["name"] == account["name"]), {})
        if local and accounts.exhausted(local, cfg):
            # The RPC may lag the local rollout; keep its fresh credit balance.
            credits = current.get("limits", {}).get("credits", {})
            current["limits"] = dict(local["limits"], credits=credits)
        soft = allow_credits and local and not accounts.exhausted(local, cfg)
        if soft:
            for info in infos:
                previous = soft_visited.get(info["name"], {})
                windows = [(window, info.get("limits", {}).get(name, {}))
                           for name, window in previous.items() if name in ("primary", "secondary")
                           and window.get("used", 0) >= cfg.get("soft_switch_at", cfg["switch_at"])]
                if windows and all(before.get("reset") is not None and after.get("reset") is not None
                                   and after["reset"] > before["reset"] for before, after in windows):
                    del soft_visited[info["name"]]
        used = visited | set(soft_visited) if soft else visited
        used_ids = {i.get("account_id") for i in infos if i["name"] in used and i.get("account_id")}
        excluded = used | {i["name"] for i in infos if i.get("account_id") in used_ids}
        if soft:
            # The current account still works, so a soft switch never moves to the duty account.
            chosen = accounts.available(infos, cfg, excluded | duty.codex_reserved(infos, cfg))
            if chosen and not accounts.exhausted(chosen, cfg, soft=True):
                # Keep the local windows until RPC confirms their reset, even if RPC usage lags.
                soft_visited[account["name"]] = local["limits"]
                return {"reason": reason, "infos": infos, "chosen": chosen, "soft": True}
            return None
        current["ordinary"] = False
        excluded |= duty.codex_reserved(infos, cfg, excluded)
        chosen = accounts.available(infos, cfg, excluded) if rotations < len(cfg["accounts"]) else None
        if allow_credits and not chosen and cfg["credits"] and current.get("logged_in"):
            # Each limit sample re-reads the balance, so a live exec on credits stops at the floor.
            if accounts.has_credits(current, cfg):
                return None
            if rotations < len(cfg["accounts"]):
                chosen = accounts.credit_account(infos, cfg, excluded)
            floor_reason = accounts.credit_floor_reason(current, cfg)
            if floor_reason:
                return {"reason": floor_reason, "infos": infos, "chosen": chosen, "floor": True}
        if not allow_credits and not chosen and cfg["credits"]:
            # Codex refused this exec; only another unvisited account may spend credits.
            if rotations < len(cfg["accounts"]):
                chosen = accounts.credit_account(infos, cfg, excluded)
            if not chosen:
                for info in infos:
                    if info["name"] in excluded or not info.get("logged_in") or info.get("duplicate"):
                        continue
                    floor_reason = accounts.credit_floor_reason(info, cfg)
                    if floor_reason:
                        reason += f"; {floor_reason}"
                        break
        return {"reason": reason, "infos": infos, "chosen": chosen}

    while not stopped():
        st.pop("reset_reconciled", None)
        visited.add(account["name"])
        review_start = len(st.get("reviews", []))
        capacity_retry = resume_thread and resume_thread != (st.get("cycle") or {}).get("waiting_review_thread")
        attempt_prompt = prompts.capacity_resume_prompt(cfg) if capacity_retry else prompt
        if resume_thread and st.get("work_binding") and current_message and not reviewing:
            attempt_prompt += "\n\n" + original_prompt
        result, decision = turn_monitor.monitor(st, cfg, account, attempt_prompt, effort, stopped, on_limit, control=control,
                                   quota_snapshot=quota_snapshot, resume_thread=resume_thread)
        quota_snapshot = None
        # A resumed exec can fail before thread.started; keep the known thread for the next retry.
        previous_thread, resume_thread = resume_thread, None
        phase = telemetry_log.telemetry_phase(st)
        weekly_exhausted = (result in ("auth", "limit", "capacity", "failed", "completed")
                            and control.weekly_exhausted(st.get("weekly_used_percent", 0)))
        if weekly_exhausted and result != "completed":
            result = "budget_exhausted"
        if result in ("auth", "limit", "capacity") and control.expired(clock.CLOCK.monotonic()):
            result = "budget_exhausted"
        if result != "auth":
            st.setdefault("auth_failures", {})[account["name"]] = 0
        if stopped():
            st["outcome"] = task_state.stop_outcome(st, stopped)
            break
        if weekly_exhausted and result == "completed":
            # The model has finished: keep its result and account the phase once,
            # publish completed workspace work, then record the budget stop.
            st["outcome"] = result
            if phase is not None:
                phase.finish(outcome=result)
            publishing.publish_turn(st, stopped)
            budgets.stop_at_weekly_budget(st)
            break
        if result in ("budget_exhausted", "stuck"):
            reason = dict(control.reason, active_seconds=round(control.elapsed, 3))
            reviews = st.get("reviews", [])[review_start:]
            phase = telemetry_log.telemetry_phase(st)
            if phase is not None:
                phase.finish(outcome=result)
            wrapup_turn(st, cfg, account, effort, stopped, reason,
                        review_entry=reviews[-1] if reviews else None,
                        quota_probe_cancelled=bool(decision and decision.get("quota_probe_cancelled")))
            break
        if result == "capacity":
            schedule = cfg.get("capacity_retry_minutes", [1, 5, 15, 30])
            if (capacity_resumed_at is not None and control.elapsed - capacity_resumed_at
                    >= config.CAPACITY_RESET_MINUTES * config.MINUTE_SECONDS):
                capacity_pauses = 0
            if capacity_pauses >= len(schedule):
                st["outcome"] = "failed"
                break
            pause = (config.CAPACITY_RETRY_SECONDS if config.CAPACITY_RETRY_SECONDS is not None
                     else schedule[capacity_pauses] * config.MINUTE_SECONDS)
            capacity_pauses += 1
            st["capacity_retries"] = st.get("capacity_retries", 0) + 1
            task_state.save(st)
            sleep_started = clock.CLOCK.monotonic()
            try:
                until = sleep_started + pause
                while not stopped():
                    left = until - clock.CLOCK.monotonic()
                    if left <= 0:
                        break
                    sleep(min(config.SLEEP_STEP, left))
            finally:
                if phase is not None:
                    phase.sleep_seconds += max(0, clock.CLOCK.monotonic() - sleep_started)
            if stopped():
                st["outcome"] = task_state.stop_outcome(st, stopped)
                break
            reviews = st.get("reviews", [])[review_start:]
            thread = ((reviews[-1]["thread"] if reviews else None) if reviewing
                      else st.get("thread")) or previous_thread
            if thread:
                resume_thread = thread
            capacity_resumed_at = control.elapsed
            if st.get("work_binding"):
                ready = account_rotation.bound_codex_ready(st, cfg, original_prompt, stopped, sleep)
                if not ready:
                    break
                quota_snapshot = ready.get("limits")
            continue
        if result in ("completed", "failed", "refused") or not cfg["enabled"]:
            st["outcome"] = result
            break
        if result == "auth":
            failures = st.setdefault("auth_failures", {})
            failures[account["name"]] = failures.get(account["name"], 0) + 1
            infos = account_rotation.task_snapshots(st, cfg, stopped)
            if stopped():
                break
            current = next((i for i in infos if i["name"] == account["name"]), {})
            capped = st["auth_transitions"] >= 2 * len(cfg["accounts"])
            if not capped and failures[account["name"]] == 1 and current.get("logged_in") and not accounts.exhausted(current, cfg):
                quota_snapshot = current.get("limits")
                if not reviewing and st.get("thread"):
                    prompt = prompts.auth_resume_prompt(cfg)
                    if st.get("work_binding") and current_message:
                        prompt += "\n\n" + original_prompt
                task_state.save(st)
                continue
            if st.get("work_binding"):
                st.update(outcome="failed", error=f"Authentication failed on the assigned Codex account {account['name']}. Restore its login.")
                break
            if failures[account["name"]] >= 2 or current.get("logged_in") is False:
                account_rotation.exclude_auth_account(st, account, current)
                infos = account_rotation.refresh_login_state(st, infos)
            if not infos or capped:
                names = st.get("needs_login", []) or [a["name"] for a in cfg["accounts"]]
                st.update(outcome="failed", error="all accounts fail with auth errors; " +
                          "; ".join("run login " + name for name in names))
                task_state.save(st)
                break
            excluded = {account["name"]}
            excluded |= duty.codex_reserved(infos, cfg, excluded)
            decision = {"reason": "authentication error", "infos": infos,
                        "chosen": accounts.available(infos, cfg, excluded)}
        chosen = decision["chosen"]
        if not chosen:
            retry_prompt = prompts.reset_resume_prompt(cfg)
            if st.get("work_binding") and current_message:
                retry_prompt += "\n\n" + original_prompt
            if st.get("work_binding"):
                st["cycle"]["waiting_active_seconds"] = control.elapsed
                if reviewing and len(st["reviews"]) > review_start:
                    resume_thread = st["reviews"][-1]["thread"]
                    st["cycle"]["waiting_review_thread"] = resume_thread
            chosen = account_rotation.wait_for_account(st, decision["infos"], cfg, decision["reason"], stopped, sleep,
                                                       prompt=retry_prompt if st.get("thread") and not reviewing else prompt)
            if not chosen:
                break
            # Fresh quota snapshots start a new rotation cycle, including past accounts.
            visited.clear()
            soft_visited.clear()
            rotations = 0
        quota_snapshot = chosen.get("limits")
        if chosen["name"] == account["name"]:
            if not reviewing and st.get("thread"):
                prompt = retry_prompt
            task_state.save(st)
            continue
        if not reviewing:
            prompt = threads.handoff(st, current_message=current_message, cfg=cfg)
        st["rotations"].append({"at": clock.CLOCK.time(), "from": account["name"], "to": chosen["name"],
                                "reason": decision["reason"], "thread": ""})
        rotation = st["rotations"][-1]
        if result == "auth":
            st["auth_transitions"] += 1
        account = accounts.account_named(cfg, chosen["name"])
        if reviewing:
            st["review_account"] = account["name"]
        else:
            st.update(account=account["name"], thread="")
        soft_rotation = decision.get("soft", False)
        floor_rotation = decision.get("floor", False)
        if soft_rotation:
            # Its reserve remains usable after the other accounts reach the soft threshold.
            visited.discard(rotation["from"])
        else:
            rotations += 1
        task_state.save(st)
        notifications.notify(st, cfg, "rotated", f"rotated from {rotation['from']} to {rotation['to']}" +
               (f": {rotation['reason']}" if soft_rotation or floor_rotation else ""),
               **{"from": rotation["from"], "to": rotation["to"], "account": account["name"]})


def work_turn(st, cfg, prompt, effort, current_message, stopped, sleep, work_paths=None, **turn_options):
    if work_paths is None and st.get("kind") not in ("scout", "reflect", "duty"):
        work_paths = checking.check_paths(st)
    run_turn(st, cfg, prompt, effort, current_message, stopped, sleep, **turn_options)
    publishing.publish_turn(st, stopped)
    if work_paths is not None:
        st["check_paths"] = sorted(set(work_paths) | set(checking.check_paths(st)))


def codex_wrapup_turn(st, cfg, account, prompt, effort, stopped, thread):
    control = turn_monitor.TurnControl(10, cfg.get("repeat_limit", 3))
    if st.get("work_binding"):
        cfg = account_rotation.codex_work_config(st, cfg)
        account = cfg["accounts"][0]
        control.elapsed = st["wrapup"].get("active_seconds", 0)
        if st["wrapup"].pop("quota_probe_cancelled", False) or account_rotation.restoring_wait(st):
            ready = account_rotation.wait_for_account(st, [dict(account, logged_in=None)], cfg,
                                                      "assigned quota needs a fresh reading", stopped, prompt=prompt)
        else:
            ready = account_rotation.bound_codex_ready(st, cfg, prompt, stopped)
        if not ready:
            return st["outcome"]
    while True:
        result, _ = turn_monitor.monitor(st, cfg, account, prompt, effort, stopped,
                                         lambda *args: None, control=control, wrapup=True, wrapup_thread=thread)
        if result != "limit":
            break
        st["wrapup"]["active_seconds"] = control.elapsed
        infos = account_rotation.task_snapshots(st, cfg, stopped)
        if not account_rotation.wait_for_account(st, infos, cfg, "assigned account rejected wrap-up", stopped, prompt=prompt):
            return st["outcome"]
    st["wrapup"]["outcome"] = result
    if result in ("stuck", "budget_exhausted"):
        st["turn_stops"].append(dict(control.reason, turn=st.get("turns", 0), phase="wrapup",
                                     active_seconds=round(control.elapsed, 3), at=clock.CLOCK.time()))
    return result


def claude_wrapup_turn(st, cfg, account, prompt, effort, stopped, thread):
    if st.get("work_binding"):
        account = account_rotation.claude_choice(st, cfg, stopped)
        if account is None and not stopped():
            account = account_rotation.wait_for_claude_account(st, cfg, "assigned Claude account unavailable", stopped,
                                                              prompt=prompt)
        if account is None:
            return st["outcome"]
        account = bind_claude_account(st, cfg, account)
    result, _ = claude_work_turn(st, cfg, prompt, effort, stopped, account, wrapup=True)
    return result


executors.get("codex").bind(sys.modules[__name__], turn="_run_turn", scout="_run_turn", wrapup="codex_wrapup_turn")
executors.get("codex").bind(duty_acp, duty="run_duty")
executors.get("claude").bind(duty_acp, duty="run_duty")
executors.get("claude").bind(sys.modules[__name__], turn="run_claude_turn", scout="run_claude_scout_turn",
                             wrapup="claude_wrapup_turn")
executors.get("opencode").bind(sys.modules[__name__], turn="run_opencode_turn", wrapup="opencode_wrapup_turn")
