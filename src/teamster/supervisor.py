"""Detached task supervision and spawning."""
import contextlib
import copy
import json
import os
import signal
import subprocess
import sys
import time

from . import budgets, checking, ci_runs, clock, config, executors, installs, notifications, procs, prompts, reflection, review_cycle, task_state, telemetry_log, threads, turns, wait_view


def require_startable():
    """Refuse a supervisor start from a pruned version or beside another data layout; the caller holds spawn_lock."""
    if not config.SCRIPT_RESOLVED.is_file():
        procs.die(f"{config.SCRIPT_RESOLVED} no longer exists: its version was pruned; "
                  f"run {config.COMMAND} again from the current version")
    # A start that waited out a data layout upgrade must not run beside the new layout.
    current = installs.current_version()
    if current is not None and installs.version_layout(current) != config.data_layout():
        procs.die(f"current is now {current} with data layout {installs.version_layout(current)}, "
                  f"this command has layout {config.data_layout()}; run {config.COMMAND} again")


def spawn(st, prompt, effort=None, current_message=False, kind="work", review_after=False, fix_rounds=0):
    """Start the next turn of st, the state this command loaded, and return its supervisor.

    prompt is the text, or a callable that builds it once no other turn has started (say journals its message then).
    """
    # Until the pid is saved, prune and data layout upgrades wait. Refuse before touching
    # the task, so a refused start leaves its files and state as they were.
    with installs.spawn_lock():
        require_startable()
        # Held from this re-check through the new pid, so of two commands that loaded the same
        # idle state only the first starts a turn. write_state, since save would take it again.
        with task_state.state_lock(st["slug"]):
            # Every spawn writes state.json: without one, no other turn can have started.
            if task_state.state_path(st["slug"]).exists():
                latest = task_state.load(st["slug"])
                if latest.get("turns", 0) != st.get("turns", 0):
                    procs.die(f"{st['slug']}: another say or review started turn {latest.get('turns', 0)} while this "
                              "command ran; nothing was sent. Wait for it (or stop it), then run this command again")
                # Only say sends a current message: its refusal names say --queue.
                busy = task_state.busy_message(latest, queue_hint=current_message)
                if busy is not None:
                    procs.die(busy)
            return launch(st, prompt, effort, current_message, kind, review_after, fix_rounds)


def launch(st, prompt, effort, current_message, kind, review_after, fix_rounds):
    """Claim the next turn in st, start its supervisor and save its pid; the caller holds spawn_lock and the state lock."""
    if callable(prompt):
        prompt = prompt()
    d = config.TASKS / st["slug"]
    for name in (("review.md",) if kind == "review" else ("last.md", "review.md")):
        last = d / name
        if last.exists():
            last.unlink()
    turn = {"pending": {"prompt": prompt, "effort": effort, "current_message": current_message,
                        "review_after": review_after}, "kind": kind, "fix_rounds": fix_rounds}
    st.update({key: field.spawn_reset(st, turn) for key, field in task_state.STATE_FIELDS.items()
               if field.spawn_reset is not None and field.spawn_reset is not task_state.STATE_DELETE})
    for key, field in task_state.STATE_FIELDS.items():
        if field.spawn_reset is task_state.STATE_DELETE:
            st.pop(key, None)
    if kind != "review":
        # Standalone review preserves the last work result and publication receipt.
        st.pop("publish", None)
        st["result"] = None
    # The supervisor runs in the worktree: pass the resolved homes, not relative variables.
    environment = dict(os.environ)
    if config.HOME_VARIABLES["TEAMSTER_HOME"]:
        environment["TEAMSTER_HOME"] = str(config.DATA_HOME)
    if config.HOME_VARIABLES["TEAMSTER_HOME"] and config.HOME_VARIABLES["TEAMSTER_CODEX_HOME"]:
        environment["TEAMSTER_CODEX_HOME"] = str(config.CODEX_HOME)
    if config.HOME_VARIABLES["CODEX_TASK_HOME"]:
        environment["CODEX_TASK_HOME"] = str(config.CODEX_HOME)
    with (d / "stderr.log").open("a") as errors:
        proc = subprocess.Popen([sys.executable, "-I", str(config.SCRIPT_RESOLVED), "_run", st["slug"]],
                                cwd=st["worktree"], env=environment, stdin=subprocess.DEVNULL,
                                stdout=errors, stderr=errors, start_new_session=True)
    st["pid"] = proc.pid
    task_state.write_state(st)
    return proc


def apply_say(st, options, cfg):
    """Check say's options against st and save them in it, as say does right before it starts the turn.

    options maps say's argument names to the values given; absent ones keep the saved settings.
    """
    reflecting = st.get("kind") == "reflect"
    scouting = st.get("kind") in ("scout", "reflect")
    try:
        executor = executors.from_state(st)
        if scouting:
            executor.prepare_scout(options.get("effort") or st.get("effort"), cfg, st["worktree"])
        else:
            executor.prepare(options.get("effort") or st.get("effort"), cfg)
    except ValueError as exc:
        procs.die(str(exc))
    budgets.set_weekly_budget(st, options.get("max_weekly"), cfg)
    if options.get("model") is not None:
        st["task_model"] = None if options["model"] == "default" else options["model"]
    if options.get("review_model") is not None:
        st["review_model"] = None if options["review_model"] == "default" else options["review_model"]
    if options.get("task_type") is not None:
        st["task_type"] = options["task_type"]
    minutes = options.get("max_minutes")
    if minutes is not None or not reflecting:
        st["max_turn_minutes"] = minutes if minutes is not None else cfg.get("max_turn_minutes")
    if options.get("no_ci_command"):
        st["ci_command"] = None
    elif options.get("ci_command") is not None:
        st["ci_command"] = options["ci_command"]
    if options.get("no_ci"):
        st["ci_enabled"] = False
    elif options.get("ci") or options.get("ci_command") is not None:
        st["ci_enabled"] = True
    if options.get("ci_rounds") is not None:
        st["ci_rounds"] = options["ci_rounds"]
    st["ci_timeout_minutes"] = cfg.get("ci_timeout_minutes", 30)
    st["review_angles"] = options.get("review_angles")
    if options.get("reviewer") is not None:
        st["reviewer"] = options["reviewer"]
    if options.get("no_check"):
        st["check"] = None
        st["check_paths"] = []
    elif options.get("check") is not None:
        st["check"] = options["check"]
    if options.get("no_base_check"):
        st["base_check"] = False
    if options.get("check_timeout") is not None:
        st["check_timeout"] = options["check_timeout"]


def say_turn(st, options):
    """spawn's arguments after the prompt for a say with these options."""
    return dict(effort=options.get("effort") or st.get("effort"), current_message=True,
                kind=st["kind"] if st.get("kind") in ("scout", "reflect") else "work",
                review_after=bool(options.get("review")), fix_rounds=options.get("fix_rounds") or 0)


# A later order's option replaces the ones it excludes or overrides in earlier orders.
SAY_OPTION_OVERRIDES = {"ci": ("no_ci",), "no_ci": ("ci",), "ci_command": ("no_ci_command", "no_ci"),
                        "no_ci_command": ("ci_command",), "check": ("no_check",), "no_check": ("check",)}


def merge_say_options(orders):
    merged = {}
    for order in orders:
        for name in order["options"]:
            for other in SAY_OPTION_OVERRIDES.get(name, ()):
                merged.pop(other, None)
        merged.update(order["options"])
    return merged


def send_queue(st, orders):
    """Start one turn for the queued orders on a copy of the finished st; the caller holds spawn_lock and the state lock.

    Returns the new turn's state, or raises SystemExit or another exception with nothing started.
    """
    require_startable()
    cfg = config.accounts_config()
    options = merge_say_options(orders)
    following = copy.deepcopy(st)
    following["pid"] = None
    apply_say(following, options, cfg)
    text = "\n\n".join(order["text"] for order in orders)
    launch(following, lambda: threads.followup_prompt(following, text, cfg, queued=orders),
           **say_turn(following, options))
    return following


def finish_cycle(st):
    """Publish the end of this supervisor's cycle, then send the orders say --queue left, or drop them.

    The queue is read and emptied in the state lock hold that clears or replaces this supervisor's
    pid, so an order queued while it was alive goes out with this cycle or is dropped with it.
    Returns None without orders, else {"orders", "sent": new state} or {"orders", "dropped": outcome}.
    """
    slug, pid = st["slug"], st["pid"]
    sending = False
    while True:
        with installs.spawn_lock() if sending else contextlib.nullcontext():
            with task_state.state_lock(slug):
                # A stop that arrived during finalization did not change the outcome, but sends nothing.
                latest = json.loads(task_state.state_path(slug).read_text())
                request = (latest.get("stop_request") if latest.get("pid") == pid else None) or st.get("stop_request")
                queue = task_state.read_queue(slug)
                orders = queue["waiting"]
                outcome = (st["outcome"] if st["outcome"] != "completed" else
                           "stopped" if (request or {}).get("pid") == pid else None)
                if orders and outcome is None and not sending:
                    # Starting a supervisor needs spawn_lock, which is taken before the state lock.
                    sending = True
                    continue
                st["pid"] = None
                if not orders:
                    task_state.write_state(st)
                    return None
                if outcome is None:
                    try:
                        report = "\n".join(wait_view.wait_report_lines(st, slug))
                    except Exception as exc:
                        report = f"(report unavailable: {exc})"
                    # Emptied before the start, so a failure after the message is journaled never sends it twice.
                    task_state.write_queue(slug, {"waiting": [], "dropped": queue["dropped"]})
                    try:
                        following = send_queue(st, orders)
                    except (Exception, SystemExit) as exc:
                        outcome = str(exc).removeprefix("teamster: ")
                    else:
                        with task_state.queue_sent_path(slug).open("a", encoding="utf-8") as stream:
                            stream.write(json.dumps({"at": clock.CLOCK.time(), "turn": st.get("turns", 0),
                                                     "next_turn": following["turns"], "count": len(orders),
                                                     "report": report}, ensure_ascii=False) + "\n")
                        return {"orders": orders, "sent": following}
                task_state.write_queue(slug, {"waiting": [], "dropped": queue["dropped"] + [
                    dict(order, dropped_at=st["turn_finished"], outcome=outcome) for order in orders]})
                task_state.write_state(st)
                return {"orders": orders, "dropped": outcome}


        # No automatic review after a CI repair. Only the saved check and CI gate it.


def cmd__run(a):
    stop_signal = procs.StopSignal()
    received_signal = None
    finalized = False
    st = None
    def stop(signum, frame):
        nonlocal received_signal
        at = clock.CLOCK.time()
        name = signal.Signals(signum).name
        if not finalized and received_signal is None:
            received_signal = {"signum": signum, "name": name, "at": at}
        # Only ordinary checkpoints may update state: the handler can interrupt
        # json.dumps while it is iterating this dictionary.
        line = (f"supervisor signal: signum={signum} name={name} "
                f"at={time.strftime('%Y-%m-%d %H:%M:%S%z', time.localtime(at))} "
                f"ppid={os.getppid()} pgid={os.getpgrp()}\n")
        # A separate unbuffered append avoids re-entering Python's stderr buffer
        # when a signal interrupts another log write. No sender inference.
        try:
            with (config.TASKS / a.slug / "stderr.log").open("ab", buffering=0) as log:
                log.write(line.encode("utf-8"))
        finally:
            if not finalized:
                stop_signal.request()
    def stopped():
        notifications.reap_notifications()
        # Snapshot the flag before copying metadata: True must never be
        # returned for a signal that arrived after the metadata check.
        cancelled = stop_signal.requested
        if received_signal is not None and st is not None:
            st.setdefault("signal", received_signal)
        return cancelled
    # The handler takes no lock: a stop while sleep holds one would deadlock.
    stop_signal.arm()
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    # A supervisor started for queued orders inherits the signal mask of its predecessor's finalization.
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT, signal.SIGTERM})
    # Preserve interruptible real waits; file-clock waits advance logical time.
    sleep = stop_signal.sleep if clock.CLOCK.path is None else clock.CLOCK.sleep
    # The launcher publishes pid and pending before the supervisor becomes the only writer.
    for _ in range(200):
        st = task_state.load(a.slug)
        if st.get("pid") == os.getpid():
            break
        time.sleep(0.01)
    else:
        return
    cfg = None
    check = None
    try:
        cfg = config.accounts_config()
        pending = st.pop("pending")
        effort = pending["effort"]
        working = st.get("kind") not in ("review", "scout", "reflect")
        if st.get("kind") == "review":
            review_cycle.review_turn(st, cfg, pending["prompt"], effort, stopped, sleep, new_turn=True)
        else:
            turns.work_turn(st, cfg, pending["prompt"], effort, pending.get("current_message", False),
                      stopped, sleep)
            if working:
                task_state.save(st)
            if (st.get("kind") == "reflect" and st.get("outcome") == "completed"
                    and st.get("result") is not None and not stopped()):
                if st.get("reflect_mode") == "study":
                    reflection.record_study(st, stopped)
                else:
                    reflection.record_batch(st, stopped)
                task_state.save(st)
        work_result = st.get("result") if working else None
        if (work_result is not None and work_result["status"] != "done"
                and pending.get("review_after") and st.get("outcome") == "completed"):
            st["review_skipped"] = "result " + work_result["status"]
            task_state.save(st)
        if (working
                and st.get("outcome") in ("completed", "budget_exhausted", "stuck")
                and st.get("check") and not stopped()):
            check = checking.saved_check(st, cfg, stopped, pending.get("review_after"))
        if (st.get("kind") not in ("scout", "reflect") and st.get("outcome") == "completed" and pending.get("review_after") and not stopped()
                and not st.get("review_skipped") and (check is None or check["outcome"] in checking.CHECK_NOT_FAILED)
                and not budgets.stop_at_weekly_budget(st)):
            st["work_completed"] = True
            base_merge = review_cycle.check_base_merge(st, stopped)
            if not stopped() and not budgets.stop_at_weekly_budget(st):
                conflict = base_merge["outcome"] == "conflict"
                review = (None if conflict else
                          review_cycle.review_turn(st, cfg, prompts.review_prompt(st, cfg), effort, stopped, sleep))
                if st.get("fix_rounds") or conflict:
                    review_cycle.auto_fix(st, cfg, review, effort, stopped, sleep, base_merge=base_merge)
        if working:
            ci_runs.ci_cycle(st, cfg, effort, stopped, sleep)
        checks = st.get("checks", [])[st.get("check_start", 0):]
        check = checks[-1] if checks else None
    except (Exception, SystemExit) as exc:
        st.update(outcome="failed", error=str(exc))
        print(f"supervisor failed: {exc}", file=sys.stderr)
    finally:
        mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        finalized = True
        try:
            guarded_changed = len(checking.guarded_changes(st)) if cfg is not None else 0
            st["outcome"] = task_state.stop_outcome(st, stopped) or st["outcome"]
            if st.get("fix_rounds") and (st["outcome"] != "completed" or not st.get("auto_fix_stop")):
                st["auto_fix_stop"] = ("budget" if budgets.budget_stop(st) == "weekly" else
                                       "review refused" if st["outcome"] == "refused" and st.get("kind") == "review"
                                       else st["outcome"] if st["outcome"] != "completed"
                                       else st.get("review_skipped", "review unknown"))
            st.pop("sleeping", None)
            st.pop("pending", None)
            st["turn_finished"] = clock.CLOCK.time()
            telemetry_log.record_turn_result(st, stopped)
            if cfg is not None:
                account = notifications.current_turn_account(st)
                message = f"turn {st['outcome']} on {account}"
                result = st.get("result")
                message += ", result " + (result["status"] if result is not None else "unknown")
                if check is not None:
                    message += ", check " + check["outcome"]
                notifications.notify(st, cfg, "turn_finished", message, outcome=st["outcome"], account=account, result=result,
                       guarded_changed=guarded_changed, ci=st.get("ci"))
                if st["outcome"] == "interrupted":
                    notifications.notify(st, cfg, "interrupted", task_state.interruption_message(st), outcome=st["outcome"],
                           signal=st.get("signal"))
                if (result is not None and result["status"] in ("blocked", "needs_decision")
                        and st.get("kind") not in ("review", "scout")):
                    question = next(iter(result["questions"]), "")
                    notifications.notify(st, cfg, "needs_input", f"result {result['status']}: {question}",
                           result=result, question=question)
            notifications.reap_notifications()
            queued = finish_cycle(st)
            if queued is not None and cfg is not None:
                texts = [order["text"] for order in queued["orders"]]
                if "sent" in queued:
                    following = queued["sent"]
                    notifications.notify(following, cfg, "queue_sent",
                                         f"queued orders sent: {len(texts)}, turn {following['turns']} started",
                                         count=len(texts), turn=following["turns"])
                else:
                    notifications.notify(st, cfg, "queue_dropped",
                                         f"queued orders not sent (outcome {queued['dropped']}): {len(texts)}",
                                         outcome=queued["dropped"], texts=texts)
                notifications.reap_notifications()
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)
