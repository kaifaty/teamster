"""Task commands, descriptions and main repositories."""
import json
import os
import plistlib
import queue
import re
import runpy
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import account_commands, account_rotation, accounts, acp, budgets, claude_accounts, claude_review, claude_runner, clock, codex_duty, config, credit_resets, duty, duty_chat, executors, installs, procs, prompts, reflection, result_schema, review_cycle, reviewers, sandboxing, supervisor, task_state, telemetry_log, threads, wait_view


def acp_update(update):
    kind = update["sessionUpdate"]
    if kind == "agent_message_chunk":
        content = update["content"]
        if content["type"] == "text":
            print(content["text"], end="", flush=True)
    elif kind in ("tool_call", "tool_call_update"):
        title = update.get("title") or update["toolCallId"]
        print(f"[{update.get('status') or 'tool'}] {title}", file=sys.stderr, flush=True)


def acp_permission(params):
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        print("ACP permission request cancelled (no interactive terminal).", file=sys.stderr, flush=True)
        return None
    print("\nPermission requested for", json.dumps(params["toolCall"], ensure_ascii=False), file=sys.stderr)
    choices = {}
    for number, option in enumerate(params["options"], 1):
        choices[str(number)] = option["optionId"]
        print(f"  {number}. {option['name']} ({option['kind']})", file=sys.stderr)
    print("Choose an option, or press Enter to cancel: ", file=sys.stderr, end="", flush=True)
    return choices.get(sys.stdin.readline().strip())


def acp_event(kind, **fields):
    print(json.dumps({"type": kind, **fields}), flush=True)


def acp_event_session(client, args):
    incoming = queue.Queue()
    permission_id = 0

    def read_input():
        # The controller can disconnect even while initialize or session/prompt is blocked.
        with os.fdopen(os.dup(sys.stdin.fileno()), "rb") as stream:
            for line in stream:
                incoming.put(line)
        os.kill(os.getpid(), signal.SIGTERM)

    def receive(kind, *keys):
        while client.process.poll() is None:
            try:
                event = json.loads(incoming.get(timeout=0.25))
            except queue.Empty:
                continue
            if not isinstance(event, dict) or event.get("type") != kind or set(event) != {"type", *keys}:
                raise ValueError(f"Expected an ACP {kind} event")
            return event
        raise ValueError(f"ACP agent exited with status {client.process.returncode}")

    def permission(params):
        nonlocal permission_id
        permission_id += 1
        acp_event("permission", id=permission_id, toolCall=params["toolCall"], options=params["options"])
        answer = receive("permission", "id", "optionId")
        if type(answer["id"]) is not int or answer["id"] != permission_id:
            raise ValueError("The permission request is no longer pending")
        choice = answer["optionId"]
        if choice is not None and choice not in [option["optionId"] for option in params["options"]]:
            raise ValueError("Unknown permission option")
        return choice

    def update(item):
        if item["sessionUpdate"] == "agent_message_chunk" and item["content"]["type"] == "text":
            acp_event("chunk", text=item["content"]["text"])

    threading.Thread(target=read_input, daemon=True).start()
    client.open_session(session_id=args.resume, auth_method=args.auth_method, model=args.model)
    client.on_update = update
    client.on_permission = permission
    acp_event("ready")
    while True:
        text = receive("prompt", "text")["text"]
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Expected a nonempty ACP prompt")
        acp_event("done", stopReason=client.prompt(text))


def acp_terminal_session(client, a):
    interactive = sys.stdin.isatty()
    session_id = client.open_session(session_id=a.resume, auth_method=a.auth_method, model=a.model)
    client.on_update = acp_update
    print(f"ACP session: {session_id}", file=sys.stderr, flush=True)
    while True:
        if interactive:
            print("> ", file=sys.stderr, end="", flush=True)
        line = sys.stdin.readline()
        if not line:
            return
        text = line.rstrip("\r\n")
        if not text.strip():
            continue
        reason = client.prompt(text)
        print(flush=True)
        if reason != "end_turn":
            message = f"Agent stopped: {reason}"
            if not interactive:
                raise SystemExit(message)
            print(message, file=sys.stderr, flush=True)


def cmd_acp(a):
    """Run a user-driven conversation in one ACP session."""
    active = False
    stopped = None

    def exit_session(signum, _frame):
        nonlocal active, stopped
        stopped = signum
        if active:
            active = False
            raise SystemExit(128 + signum)

    handlers = {sig: signal.signal(sig, exit_session) for sig in (signal.SIGTERM, signal.SIGHUP)}
    try:
        # Loading can replay the entire transcript. Only new turns belong on stdout.
        with acp.AcpClient([a.program, *a.agent_args], a.repo, lambda update: None, acp_permission) as client:
            try:
                # Defer termination across spawn and let __exit__ finish reaping the process group.
                active = True
                if stopped:
                    raise SystemExit(128 + stopped)
                if a.events:
                    return acp_event_session(client, a)
                return acp_terminal_session(client, a)
            finally:
                active = False
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except (ValueError, OSError) as exc:
        if a.events:
            acp_event("error", message=str(exc))
        raise SystemExit(f"teamster acp: {exc}") from None
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def main_repo(path):
    """The main checkout of the repository `path` belongs to (including worktrees)."""
    common = Path(procs.sh(config.GIT + ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=path))
    return common.parent


def start_option(flag, profile, route, key):
    if flag is not None:
        return flag, "flag"
    if key in profile:
        return profile[key], "profile"
    if key in route:
        return route[key], "role profile"
    return None, "default"


def git_worktree(directory):
    inside = subprocess.run(config.GIT + ["rev-parse", "--is-inside-work-tree"], cwd=directory,
                            text=True, capture_output=True)
    return inside.returncode == 0 and inside.stdout.strip() == "true"


def work_route(a, cfg, role, profile=None, *, sandbox="off", directory=None):
    """Resolve once, before the first turn can start, and keep model defaults provider-local."""
    profile = profile or {}
    explicit = getattr(a, "executor", None)
    model_flag = getattr(a, "model", None)
    routes = config.role_routes(cfg, role)
    if role == "work":
        preferred, source, _ = executors.for_start(explicit, profile, cfg)
    else:
        preferred = executors.get(explicit or ("codex" if role == "scout" else "claude"))
        source = "flag" if explicit else "default"
    candidates = [(preferred, source)]
    if routes and not explicit:
        configured = [(executors.get(route["provider"]), "role profile") for route in routes]
        candidates = (candidates + [entry for entry in configured if entry[0] is not preferred]
                      if source == "profile" else configured)
    elif not explicit and preferred.name in ("codex", "claude"):
        other = "claude" if preferred.name == "codex" else "codex"
        candidates.append((executors.get(other), "fallback"))

    def compatible(candidate):
        if candidate.name == "claude":
            try:
                claude_runner.validate_work_effort(a.effort)
            except ValueError:
                return False
        return ((candidate.name not in ("codex", "claude") or config.provider_installed(candidate.name, for_task=True))
                and (candidate.supports_sandbox or sandbox == "off")
                and (role != "scout" or candidate.name != "claude" or git_worktree(directory)))

    target, source = candidates[0]
    if not explicit and model_flag in (None, "default"):
        if routes:
            usable = [entry for entry in candidates if compatible(entry[0])]
            if usable:
                # Preserve the existing waiting policy when none of the installed pools can start yet.
                target, source = usable[0]
            if len(usable) > 1:
                for candidate, candidate_source in usable:
                    _, _, defaults = executors.for_start(candidate.name, profile, cfg)
                    route = config.role_route(cfg, role, candidate.name)
                    model, _ = start_option(model_flag, defaults, route, "model")
                    if account_rotation.role_can_start(cfg, candidate.name, role,
                                                       None if model == "default" else model,
                                                       getattr(a, "task_type", None)):
                        target, source = candidate, candidate_source
                        break
            if target is not candidates[0][0]:
                source = "fallback"
        elif len(candidates) > 1 and not config.provider_installed(target.name, for_task=True) and compatible(candidates[1][0]):
            target, source = candidates[1]
    _, _, defaults = executors.for_start(target.name, profile, cfg)
    role_defaults = config.role_route(cfg, role, target.name)
    return (target, source, start_option(model_flag, defaults, role_defaults, "model"),
            start_option(a.effort, defaults, role_defaults, "effort"))


def print_route(label, target, source, model, effort):
    print(f"  routing {label}: executor {target.name} ({source}), "
          f"model {model[0] or 'default'} ({model[1]}), effort {effort[0] or 'default'} ({effort[1]})")


def cmd_start(a):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", a.slug):
        procs.die("slug: 2-41 chars of a-z, 0-9 and '-'")
    cfg = config.task_config({"executor": getattr(a, "executor", None) or "codex"})
    no_push = getattr(a, "no_push", False)
    if no_push and (a.ci or a.ci_command is not None):
        procs.die("--no-push cannot be combined with --ci or --ci-command; CI requires a published branch")
    profile = config.task_profiles(cfg).get(a.task_type)
    sandbox = a.sandbox if a.sandbox is not None else cfg["sandbox"]
    executor, source, model_option, effort_option = work_route(a, cfg, "work", profile, sandbox=sandbox)
    model, effort = model_option[0], effort_option[0]
    if not executor.supports_sandbox and sandbox != "off":
        procs.die(f"--executor {executor.name} supports only --sandbox off; --sandbox workspace is not supported")
    try:
        executor.prepare(effort, cfg)
    except ValueError as exc:
        procs.die(str(exc))
    review = {"reviewer": executor.reviewer(cfg)}
    review_cycle.configure_reviewer(review, cfg, getattr(a, "reviewer", None), required=a.review)
    if (config.TASKS / a.slug).exists():
        procs.die(f"task {a.slug!r} exists; pick another slug or clean it")
    busy = task_state.running_tasks()
    if busy and not a.parallel:
        procs.die(f"already running: {', '.join(busy)} (wait for it, or pass --parallel if they cannot clash)")
    brief = sys.stdin.read() if a.brief == "-" else Path(a.brief).read_text()
    if not brief.strip():
        procs.die("empty brief")
    rules = sandboxing.rules_text(cfg, no_push=no_push)
    if sandbox == "workspace":
        rules += "\n\n" + sandboxing.sandbox_rules(cfg, no_push=no_push)
    repo = main_repo(a.repo)
    branch = a.branch if a.branch is not None else f"codex/{a.slug}"
    if subprocess.run(config.GIT + ["check-ref-format", "--branch", branch], cwd=repo,
                      capture_output=True).returncode:
        procs.die(f"invalid branch name: {branch!r}")
    wt = config.WORKTREES / f"claude-{a.slug}" / repo.name
    if wt.exists():
        procs.die(f"{wt} exists")
    procs.sh(config.GIT + ["fetch", "--quiet", "origin"], cwd=repo)
    try:
        rules = sandboxing.repository_rules(rules, repo)
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = (exc.stderr or str(exc)) if isinstance(exc, subprocess.CalledProcessError) else str(exc)
        procs.die("cannot read origin for PR rules: " + detail.strip())
    a.base = a.base or procs.sh(config.GIT + ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd=repo,
                          check=False) or "origin/main"
    wt.parent.mkdir(parents=True, exist_ok=True)
    procs.sh(config.GIT + ["worktree", "add", "--quiet", "-b", branch, str(wt), a.base], cwd=repo)
    d = config.TASKS / a.slug
    d.mkdir(parents=True)
    base = a.base.removeprefix("origin/")
    prompt = brief.rstrip() + "\n\n" + rules.replace("{branch}", branch).replace("{base}", base)
    max_minutes = a.max_minutes if a.max_minutes is not None else cfg.get("max_turn_minutes")
    if a.check:
        prompt += "\n" + (prompts.long_check_warning(repo, a.check, max_minutes, cfg) or (
            f'- Перед `status: "done"` запусти сохранённую проверку целиком: `{a.check}` — '
            f'и укажи её в `checks`. Если она падает и на чистой {base}, укажи это с числами, а не чини.'
            if cfg.get("language", "en") == "ru" else
            f'- Before finishing with status "done", run the saved check in full: `{a.check}`, '
            f'and report it in `checks`. If it also fails on a clean {base}, '
            'report that with the numbers instead of fixing it.'))
    (d / "brief.md").write_text(prompt)
    st = {"slug": a.slug, "repo": str(repo), "worktree": str(wt), "branch": branch, "base": a.base,
          "executor": executor.name, "effort": effort, "task_type": a.task_type,
          "task_model": None if model == "default" else model,
          "review_model": None if getattr(a, "review_model", None) == "default" else getattr(a, "review_model", None),
          "account": cfg["accounts"][0]["name"] if executor.account_field is not None else None,
          "thread": "", "threads": [],
          "rotations": [], "reviews": [], "checks": [], "check": a.check, "check_timeout": a.check_timeout,
          "check_loaded": a.check_loaded,
          "guards": a.guard, "base_check": a.base_check,
          "sandbox": sandbox, "writable_dirs": cfg["writable_dirs"], "no_push": no_push,
          "review_angles": a.review_angles,
          **review,
          "max_turn_minutes": max_minutes,
          "ci_enabled": not no_push and (a.ci or bool(a.ci_command) or cfg["ci"]), "ci_command": a.ci_command,
          "ci_rounds": a.ci_rounds if a.ci_rounds is not None else 1,
          "ci_timeout_minutes": cfg["ci_timeout_minutes"],
          "max_task_weekly_percent": a.max_weekly if a.max_weekly is not None else cfg.get("max_task_weekly_percent"),
          "weekly_used_percent": 0,
          "created": clock.CLOCK.time(), "turns": 0, "plugin_version": config.plugin_version(),
          "parallel": bool(a.parallel)}
    task_timeout = getattr(a, "task_timeout", None)
    if task_timeout is not None:
        st["task_deadline"] = st["created"] + task_timeout
    if config.started_by():
        st["started_by"] = config.started_by()
    task_state.save(st)
    proc = supervisor.spawn(st, prompt, effort, review_after=a.review, fix_rounds=a.fix_rounds or 0)
    for _ in range(300):
        st = task_state.load(a.slug)
        if st["thread"] or executor.cursor(st) or st.get("outcome") == "sleeping" or st.get("pid") is None or proc.poll() is not None:
            break
        time.sleep(0.1)
    account = f"account {executor.account(st) or '?'}, " if executor.account_field is not None else ""
    cursor = executor.cursor_label + " " + (executor.cursor(st) or "?")
    print(f"started {a.slug}: executor {executor.name}, {account}{cursor}, pid {st.get('pid')}\n  worktree {wt}\n  branch {branch}")
    if profile is not None or config.role_routes(cfg, "work") or source == "fallback":
        print_route(a.task_type or "work", executor, source, model_option, effort_option)
    print(f"  wait: {config.COMMAND} wait {a.slug}   (run it as a background command)")


def require_idle(st, queue_hint=False):
    # The early check; spawn repeats it under the state lock against the state on disk.
    busy = task_state.busy_message(st, queue_hint)
    if busy is not None:
        procs.die(busy)


def cmd_scout(a):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", a.slug):
        procs.die("slug: 2-41 chars of a-z, 0-9 and '-'")
    cfg = config.accounts_config()
    if (config.TASKS / a.slug).exists():
        procs.die(f"task {a.slug!r} exists; pick another slug or clean it")
    question = Path(a.file).read_text() if a.file else a.question
    if not question or not question.strip():
        procs.die("empty scout question")
    directory = Path(a.repo).expanduser().resolve()
    if not directory.is_dir():
        procs.die(f"scout directory does not exist: {directory}")
    executor, source, model, effort = work_route(a, cfg, "scout", directory=directory)
    try:
        executor.prepare_scout(effort[0], cfg, directory)
    except ValueError as exc:
        procs.die(str(exc))
    d = config.TASKS / a.slug
    d.mkdir(parents=True)
    prompt = prompts.scout_prompt(question, cfg)
    (d / "brief.md").write_text(prompt)
    st = {"slug": a.slug, "kind": "scout", "repo": str(directory), "worktree": str(directory), "branch": "",
          "executor": executor.name, "effort": effort[0],
          "account": cfg["accounts"][0]["name"], "thread": "", "threads": [],
          "rotations": [], "reviews": [], "checks": [], "created": clock.CLOCK.time(), "turns": 0}
    if config.started_by():
        st["started_by"] = config.started_by()
    if model[0] is not None:
        st["task_model"] = None if model[0] == "default" else model[0]
    task_state.save(st)
    proc = supervisor.spawn(st, prompt, effort[0], kind="scout")
    for _ in range(300):
        st = task_state.load(a.slug)
        if executor.cursor(st) or st.get("outcome") == "sleeping" or st.get("pid") is None or proc.poll() is not None:
            break
        time.sleep(0.1)
    print(f"started scout {a.slug}: account {executor.account(st) or '?'}, "
          f"{executor.cursor_label} {executor.cursor(st) or '?'}, pid {st.get('pid')}\n  directory {directory}")
    if config.role_routes(cfg, "scout") or source == "fallback":
        print_route("scout", executor, source, model, effort)
    print(f"  wait: {config.COMMAND} wait {a.slug}   (run it as a background command)")


def cmd_reflect(a):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", a.slug):
        procs.die("slug: 2-41 chars of a-z, 0-9 and '-'")
    cfg = config.accounts_config()
    if (config.TASKS / a.slug).exists():
        procs.die(f"task {a.slug!r} exists; pick another slug or clean it")
    order = Path(a.file).read_text() if a.file else a.order
    executor, source, model, effort = work_route(a, cfg, "reflect")
    try:
        executor.prepare(effort[0], cfg)
    except ValueError as exc:
        procs.die(str(exc))
    archive = config.TASKS / ".archive"
    tasks, since, repos = a.task or [], getattr(a, "since", None), a.repo or []
    study = bool(tasks or since or repos)
    if study:
        through = None
        records, missing = reflection.study_records(
            archive, tasks, since and reflection.since_stamp(since, clock.CLOCK.time()), repos)
        if missing is not None:
            procs.die(f"no archived record for {missing}")
    else:
        records, through = reflection.pending_records(archive)
    if not records:
        procs.die("no records to reflect on")
    d = config.TASKS / a.slug
    d.mkdir(parents=True)
    room = d / "room"
    reflection.build_room(room, archive, records)
    prompt = (prompts.study_prompt(order, records, cfg) if study else
              prompts.reflect_prompt(order, records, through, cfg))
    (d / "brief.md").write_text(prompt)
    st = {"slug": a.slug, "kind": "reflect", "repo": str(archive), "worktree": str(room), "branch": "",
          "executor": executor.name, "effort": effort[0],
          "account": cfg["accounts"][0]["name"], "thread": "", "threads": [],
          "rotations": [], "reviews": [], "checks": [], "created": clock.CLOCK.time(), "turns": 0,
          "reflect_mode": "study" if study else "batch", "reflect_through": through, "reflect_records": records,
          "reflect_order": order if order and order.strip() else None, "reflect_turns": [],
          "max_turn_minutes": a.max_minutes}
    if model[0] is not None:
        st["task_model"] = None if model[0] == "default" else model[0]
    task_state.save(st)
    proc = supervisor.spawn(st, prompt, effort[0], kind="reflect")
    for _ in range(300):
        st = task_state.load(a.slug)
        if executor.cursor(st) or st.get("outcome") == "sleeping" or st.get("pid") is None or proc.poll() is not None:
            break
        time.sleep(0.1)
    selection = f"study of {len(records)} records" if study else f"{len(records)} records through {through}"
    print(f"started reflect {a.slug}: {selection}, executor {executor.name}, "
          f"account {executor.account(st) or '?'}, {executor.cursor_label} {executor.cursor(st) or '?'}, "
          f"pid {st.get('pid')}\n  reading room {room}")
    if config.role_routes(cfg, "reflect") or source == "fallback":
        print_route("reflect", executor, source, model, effort)
    print(f"  wait: {config.COMMAND} wait {a.slug}   (run it as a background command)")


def cmd_lesson(a):
    print(reflection.set_lesson_status(config.TASKS / ".archive", a.entry, a.status, a.note))


# say's options that only work tasks take.
WORK_SAY_OPTIONS = ("check", "check_loaded", "review", "check_timeout", "fix_rounds", "no_base_check", "review_angles",
                    "reviewer", "review_model", "ci", "no_ci", "ci_command", "no_ci_command", "ci_rounds")


def refuse_work_options(st, options):
    if any(name in options for name in WORK_SAY_OPTIONS):
        procs.die(f"{st['kind']} is read-only; say --check, --check-loaded, --check-timeout, --review, --reviewer, --review-model, --review-angles, --fix-rounds, --ci, --no-ci, --ci-command, --no-ci-command, --ci-rounds and --no-base-check are not supported")


# say's arguments that are not options it saves or passes to the turn.
SAY_CALL_ARGUMENTS = ("cmd", "slug", "message", "file", "queue", "upgrade")


def say_options(a):
    """say's options as given, by argument name; say --queue saves them with the message."""
    return {name: value for name, value in vars(a).items()
            if name not in SAY_CALL_ARGUMENTS and value is not None and value is not False}


def cmd_say(a):
    st = task_state.load(a.slug)
    queued = getattr(a, "queue", False)
    if queued and getattr(a, "upgrade", False):
        procs.die("say --queue cannot be combined with --upgrade, which moves the task when say runs; "
                  "send the message with say --upgrade once the current cycle ends")
    if st.get("kind") == duty_chat.CHAT_KIND:
        # The duty conversation takes say exactly as duty chat: on the duty account, with the held task notes.
        return say_duty_chat(a)
    move = installs.follow_pin(st, upgrade=getattr(a, "upgrade", False))
    options = say_options(a)
    scouting = st.get("kind") in ("scout", "reflect", "duty")
    if st.get("no_push") and (options.get("ci") or options.get("ci_command") is not None):
        procs.die("--no-push task cannot enable --ci or --ci-command; CI requires a published branch")
    if scouting:
        refuse_work_options(st, options)
    if not queued:
        require_idle(st, queue_hint=True)
    msg = Path(a.file).read_text() if a.file else a.message
    if not msg or not msg.strip():
        procs.die("empty message")
    cfg = config.task_config(st)
    supervisor.apply_say(st, options, cfg)
    if queued:
        # The supervisor applies the options again when it sends the queue, as a say then would.
        waiting = task_state.enqueue(a.slug, {"at": clock.CLOCK.time(), "text": msg, "options": options})
        if waiting is not None:
            print(f"queued for {a.slug}: {waiting} waiting; sent when the current cycle ends")
            return
        # The cycle may have ended since st was loaded: send from the state it left.
        st = task_state.load(a.slug)
        supervisor.apply_say(st, options, cfg)
    # If no thread was created (all accounts exhausted on start), retain the brief too.
    # spawn journals the message only once this turn is claimed: a refused say leaves no trace.
    supervisor.spawn(st, lambda: threads.followup_prompt(st, msg, cfg), **supervisor.say_turn(st, options))
    if move:
        print(move)
    print(f"sent to {a.slug} (turn {st['turns']}), pid {st['pid']}")


def cmd_review(a):
    st = task_state.load(a.slug)
    move = installs.follow_pin(st)
    if st.get("kind") in ("scout", "reflect", "duty"):
        procs.die(f"{st['kind']} is read-only; review is not supported")
    require_idle(st)
    cfg = config.task_config(st)
    review_cycle.configure_reviewer(st, cfg, getattr(a, "reviewer", None), required=True)
    if getattr(a, "review_model", None) is not None:
        st["review_model"] = None if a.review_model == "default" else a.review_model
    budgets.set_weekly_budget(st, getattr(a, "max_weekly", None), cfg)
    st["review_angles"] = a.review_angles
    effort = a.effort if config.role_routes(cfg, "review") else a.effort or st.get("effort")
    supervisor.spawn(st, prompts.review_prompt(st, cfg), effort, kind="review")
    if move:
        print(move)
    print(f"reviewing {a.slug}, pid {st['pid']}")


def cmd_resume(a):
    if bool(a.slugs) == bool(a.all):
        procs.die("resume takes task slugs or --all")
    if a.all:
        states = [task_state.load(p.parent.name) for p in sorted(config.TASKS.glob("*/state.json"))]
        candidates = [st for st in states if supervisor.resume_refusal(st) is None]
        if not candidates:
            print("nothing to resume")
            return
    else:
        candidates = [task_state.load(slug) for slug in dict.fromkeys(a.slugs)]
        refusals = [reason for reason in map(supervisor.resume_refusal, candidates) if reason is not None]
        if refusals:
            procs.die("cannot resume: " + "; ".join(refusals))
    # Tasks one restart cut short were running together then; they all continue together.
    for st in candidates:
        move = installs.follow_pin(st, upgrade=True)
        cut = task_state.interruption(st)
        resumed, step = supervisor.resume(st["slug"], st)
        if move:
            print(move)
        print(f"resumed {st['slug']} from {step} (turn {resumed.get('turns', 0)}, interrupted by "
              f"{cut['signal'] or 'an unknown signal'} at {config.local_time(cut['at'])}), pid {resumed['pid']}")
        print(f"  wait: {config.COMMAND} wait {st['slug']}   (run it as a background command)")


def describe(st, detail):
    supervisor_alive = procs.alive(st.get("pid"))
    cut = task_state.interruption(st)
    if cut is not None:
        state = "interrupted"
    elif st.get("outcome") == "sleeping":
        state = (f"sleeping until {config.local_time(st['sleeping']['until'])}" if supervisor_alive
                 else "paused, supervisor gone; continue with say")
    else:
        state = "running" if supervisor_alive else "idle"
    reviewing = st.get("kind") == "review"
    scouting = st.get("kind") in ("scout", "reflect", "duty")
    executor = executors.from_state(st)
    account, thread = executor.status_account(st), executor.cursor(st)
    if reviewing:
        account, thread = st.get("review_account") or "?", ""
        reviews = st.get("reviews", [])[st.get("review_start", 0):]
        if reviews and ("review_account" not in st or st["review_account"] is not None):
            account, thread = reviews[-1]["account"], reviews[-1]["thread"]
    location = st["worktree"] if scouting else st["branch"]
    label = "  " + st["kind"] if scouting else ("  review" if reviewing else "")
    account_text = f"  account {account}" if reviewing or executor.account_field is not None else ""
    line = (f"{st['slug']:24} {state:8} turns {st.get('turns', 0)}  {location}  "
            f"executor {executor.name}{account_text}  {'thread' if reviewing else executor.cursor_label} {thread[:13]}" + label
            + "  sandbox " + ("room" if st.get("kind") == "duty" else "read-only" if scouting else st.get("sandbox", "off")))
    if st.get("no_push"):
        line += "  push disabled (--no-push)"
    queued = len(task_state.locked_queue(st["slug"])["waiting"])
    if queued:
        line += f"  queued orders {queued}"
    if reviewing:
        line += executor.review_status(st)
    if st.get("task_model"):
        line += f"\nmodel {st['task_model']}  effort {st.get('reasoning_effort') or st.get('effort') or 'default'}"
    if st.get("weekly_budget_warning"):
        line += "\n" + st["weekly_budget_warning"]
    line += executor.status_error(st)
    if cut is not None:
        line += "\n" + task_state.interruption_message(st, cut)
    switch = st.get("base_switch")
    if switch:
        line += f"\nbase {switch['from']} is gone; checked against {switch['to']}"
    if not detail:
        return line
    if st.get("kind") == "reflect":
        result = st.get("result")
        lines = [line, f"reading room {st['worktree']}",
                 f"result {result['status']}: {result['summary']}" if result else "result: none"]
        if st.get("reflect_file"):
            lines.append(f"{reflection.file_kind(st)} {Path(st['repo']) / st['reflect_file']}")
        return "\n".join(lines)
    if st.get("kind") == "duty":
        result = st.get("result")
        return "\n".join([line, f"room {st['worktree']}", f"answers {len(st.get('duty_turns', []))}",
                          f"result {result['status']}: {result['reply']}" if result else "result: none"])
    if scouting:
        return line + "\nlast message:\n" + (threads.last_message(st) or "(none)")
    pr = st.get("publish", {}).get("pr", "")
    commits = procs.sh(config.GIT + ["log", "--oneline", f"{st['base']}..HEAD"], cwd=st["worktree"], check=False)
    review = config.TASKS / st["slug"] / "review.md"
    message = (review.read_text().strip() if reviewing and review.exists() else
               executor.status_message(st))
    return "\n".join([line, f"worktree {st['worktree']}", *result_schema.result_lines(st.get("result")),
                      f"PR: {pr or 'none'}", "commits:\n" + (commits or "(none)"),
                      "last message:\n" + (message or "(none)")])


def cmd_status(a):
    states = ([task_state.load(a.slug)] if a.slug else
              [task_state.load(p.parent.name) for p in sorted(config.TASKS.glob("*/state.json"))])
    for st in states:
        print(describe(st, bool(a.slug)))


def cmd_stats(a):
    st = task_state.load(a.slug)
    cfg = config.task_config(st)
    executors.from_state(st).stats(st)
    for entry in st["threads"] + st["reviews"]:
        reviewers.from_entry(entry).stats(entry, cfg)


def codex_thread_account(entry, cfg):
    account = next((a for a in cfg["accounts"] if a["name"] == entry["account"]), None)
    if account is None:
        print(f"Skipping thread {entry['thread']}: Codex account {entry['account']!r} is no longer configured")
    return account


def print_codex_review_stats(entry, cfg):
    account = codex_thread_account(entry, cfg)
    if account is None:
        return
    path = threads.rollout_path(account["home"], entry["thread"])
    print(f"== {entry['account']}: {entry['thread']}", flush=True)
    if path:
        subprocess.run([sys.executable, "-I", str(config.STATS), str(path)], check=True)
    else:
        print("(rollout not found)")


def prepare_claude_review(cfg):
    config.require_claude()
    config.task_adapter("claude")


def prepare_claude_work(effort, cfg):
    claude_runner.validate_work_effort(effort or cfg["claude"].get("effort"))
    prepare_claude_review(cfg)


def prepare_claude_scout(effort, cfg, directory):
    if not git_worktree(directory):
        raise ValueError("scout --executor claude requires a directory inside a git work tree")
    prepare_claude_work(effort, cfg)


def print_claude_work_stats(st):
    rows = telemetry_log.claude_work_rows(st)
    token_fields = ("input", "output", "cached_input")

    def total(values):
        known = [value for value in values if value is not None]
        return sum(known) if known else None

    def number(value, spec):
        return format(value, spec) if value is not None else "-"

    totals = {key: total(row.get(key) for row in rows)
              for key in ("active_seconds", "cost_usd", "weekly_spent")}
    totals["tokens"] = {key: total((row.get("tokens") or {}).get(key) for row in rows)
                        for key in token_fields}
    print("== Claude " + (st["kind"] if st.get("kind") in ("scout", "reflect", "duty") else "work"), flush=True)
    print(f"{'start (UTC)':20} {'min':>6} {'account':16} {'session':13} {'model':24} {'effort':7} "
          f"{'input':>10} {'output':>10} {'cached':>10} {'cost $':>10} {'weekly %':>8}")
    for row in rows + [totals]:
        start = (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(row["started"]))
                 if row.get("started") is not None else "total:")
        seconds = row.get("active_seconds")
        minutes = number(seconds / 60 if seconds is not None else None, ".1f")
        tokens = [number((row.get("tokens") or {}).get(key), ".0f") for key in token_fields]
        print(f"{start:20} {minutes:>6} {row.get('account') or '-':16} "
              f"{(row.get('session_id') or '-')[:13]:13} {row.get('model') or '-':24} "
              f"{row.get('reasoning_effort') or '-':7} "
              f"{tokens[0]:>10} {tokens[1]:>10} {tokens[2]:>10} "
              f"{number(row.get('cost_usd'), '.4f'):>10} {number(row.get('weekly_spent'), '.2f'):>8}",
              flush=True)


executors.get("claude").bind(sys.modules[__name__], prepare="prepare_claude_work",
                             prepare_scout="prepare_claude_scout", stats="print_claude_work_stats")


def prepare_opencode_work(effort, cfg):
    if effort is not None:
        raise ValueError("OpenCode work does not support --effort")
    if not shutil.which("opencode"):
        raise ValueError("OpenCode CLI was not found. Install opencode and add it to PATH.")


def print_opencode_work_stats(st):
    print(f"OpenCode work: model {st['task_model']}, session {st.get('session_id') or '?'}")


executors.get("opencode").bind(sys.modules[__name__], prepare="prepare_opencode_work", stats="print_opencode_work_stats")


def prepare_codex(effort, cfg, directory=None):
    config.codex_binary()
    config.task_adapter("codex")


def prepare_codex_review(cfg):
    prepare_codex(None, cfg)


executors.get("codex").bind(sys.modules[__name__], prepare="prepare_codex", prepare_scout="prepare_codex")


def cmd_report(a):
    report = runpy.run_path(str(config.REPORT))
    try:
        data = report["build_report"](telemetry_log.journal_path(), a.since, a.repo, a.slug,
                                      by=getattr(a, "by", None))
    except ValueError as exc:
        procs.die(str(exc))
    print(json.dumps(data, ensure_ascii=False) if a.json else report["render_report"](data))


def cmd_stop(a):
    with task_state.state_lock(a.slug):
        st = task_state.load(a.slug)
        pid = st.get("pid")
        if not procs.alive(pid):
            name, orphan = task_state.session_process(st)
            if orphan is None:
                print("not running")
                return
            # The supervisor died before its transport, which still holds the session.
            marker = codex_duty.duty_process_marker(orphan) if name in ("Codex", "Claude") else None
            if name == "Codex":
                # App-server owns terminal groups separate from its own. Let
                # its SIGTERM shutdown end those before the group fallback.
                try:
                    os.kill(orphan, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                for _ in range(100):
                    if not procs.alive(orphan):
                        break
                    time.sleep(0.2)
            procs.end_group(orphan)
            if marker:
                codex_duty.end_duty_terminals(marker)
            st.pop(name.lower() + "_pid", None)
            if name == "OpenCode":
                now = clock.CLOCK.time()
                st.update(outcome="stopped", turn_finished=now, stop_request={"at": now, "pid": pid})
                supervisor.finish_cycle(st)
            else:
                task_state.write_state(st)
            print(f"stopped {a.slug}: ended {name} process {orphan}")
            return
        st["stop_request"] = {"at": clock.CLOCK.time(), "pid": pid}
        task_state.write_state(st)
    try:
        os.killpg(pid, signal.SIGINT)
    except (ProcessLookupError, PermissionError):
        pass
    for _ in range(100):
        time.sleep(0.2)
        latest = task_state.load(a.slug)
        if latest.get("pid") != pid or not procs.alive(pid):
            break
    else:
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    print(f"stopped {a.slug}")


def cmd_clean(a):
    with task_state.state_lock(a.slug):
        st = task_state.load(a.slug)
        if procs.alive(st.get("pid")):
            procs.die("still running; stop it first")
        name, orphan = task_state.session_process(st)
        if orphan is not None:
            procs.die(f"{name} process {orphan} of the last {st['kind']} turn is still running; "
                      f"end it with {config.COMMAND} stop {a.slug}, then clean")
        return clean_task(a, st)


def clean_task(a, st):
    cfg = config.task_config(st)
    if st.get("kind") in ("reflect", "duty"):
        shutil.rmtree(config.TASKS / a.slug / "room", ignore_errors=True)
    elif st.get("kind") != "scout":
        repo, wt = st["repo"], st["worktree"]
        if Path(wt).exists():
            procs.sh(config.GIT + ["worktree", "remove", "--force", wt], cwd=repo)
            shutil.rmtree(Path(wt).parent, ignore_errors=True)
        if not a.keep_branch:
            subprocess.run(config.GIT + ["branch", "-D", st["branch"]], cwd=repo, capture_output=True)
    for entry in st["threads"] + st["reviews"]:
        reviewers.from_entry(entry).clean(entry, cfg)
    record = config.TASKS / a.slug
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(clock.CLOCK.time()))
    archive = config.TASKS / ".archive" / f"{a.slug}-{stamp}"
    if archive.exists():
        procs.die(f"task record archive already exists: {archive}")
    try:
        archive.parent.mkdir(parents=True, exist_ok=True)
        (record / "events.jsonl").unlink(missing_ok=True)
        (record / "claude-events.jsonl").unlink(missing_ok=True)
        record.rename(archive)
    except OSError as exc:
        procs.die(f"could not archive task record to {archive}: {exc}; record kept at {record}")
    # Keep the live lock reachable at the task path until the entire record moves.
    (archive / "state.lock").unlink()
    print(f"cleaned {a.slug}; record in {archive}")
    if st.get("kind") in ("scout", "reflect", "duty"):
        return
    try:
        # Use the report's own matching so the reminder agrees with `report`.
        verdict = runpy.run_path(str(config.REPORT))["lead_verdict"](
            telemetry_log.journal_path(), Path(st["repo"]).name, a.slug, st.get("created"))
    except OSError as exc:
        print(f"could not check the lead verdict for {a.slug}: telemetry journal unreadable ({exc})")
        return
    if verdict is None:
        print(f"no lead verdict for {a.slug}; record it: verdict {a.slug} "
              + "|".join(telemetry_log.LEAD_VERDICTS) + " [--note TEXT]")


def clean_codex_review(entry, cfg):
    if not config.provider_installed("codex"):
        return
    account = codex_thread_account(entry, cfg)
    if account is None:
        return
    accounts.prepare_home(account)
    subprocess.run([config.codex_binary(), "archive", entry["thread"]], env=accounts.account_env(account), capture_output=True)


reviewers.CODEX_REVIEWER.bind(sys.modules[__name__], stats="print_codex_review_stats", clean="clean_codex_review",
                              prepare="prepare_codex_review")
reviewers.CLAUDE_REVIEWER.bind(sys.modules[__name__], prepare="prepare_claude_review")


def cmd_verdict(a):
    try:
        row = telemetry_log.record_lead_verdict(a.slug, a.verdict, a.note)
    except OSError as exc:
        procs.die(f"could not write the telemetry journal: {exc}")
    if row is None:
        procs.die(f"no task {a.slug!r} in task state or the telemetry journal")
    print(f"verdict {a.verdict} recorded for {a.slug} ({row['repo']})")


def cmd_accounts(a):
    cfg = config.accounts_config(allow_empty_pools=True)
    has_claude = config.provider_installed("claude")
    if getattr(a, "refresh", False) and has_claude:
        claude_review.refresh_limits(cfg)
    infos = accounts.snapshots(cfg)
    if getattr(a, "json", False):
        report = accounts_json(infos, cfg)
        report["login_harnesses"] = ["codex"] if config.provider_installed("codex") else []
        if has_claude and shutil.which("security"):
            report["login_harnesses"].append("claude")
        if not has_claude:
            report["claude"] = []
        print(json.dumps(report, ensure_ascii=False))
        return
    record = duty.read_duty()
    print_accounts(infos, cfg, record)
    if has_claude:
        print("\n".join(accounts.claude_account_lines(
            cfg, record["account"] if record and record["family"] == "claude" else None)))


def accounts_json(infos, cfg):
    def iso_time(stamp):
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stamp)) if stamp is not None else None

    def window(value, claude=False):
        if not value:
            return None
        used = value.get("utilization" if claude else "used")
        result = {"used_percent": used * 100 if claude and used is not None else used,
                  "resets_at": iso_time(value.get("resetsAt" if claude else "reset"))}
        if not claude:
            result["window_minutes"] = value.get("minutes")
        return result

    codex = []
    for info in infos:
        limits = info.get("limits", {})
        credits = limits.get("credits", {})
        resets = info.get("reset_credits", {})
        available = credit_resets.reset_credits(info)
        status = account_commands.codex_status(info, cfg)
        codex.append({
            "name": info["name"], "plan": info.get("account", {}).get("planType"),
            "email": info.get("account", {}).get("email"),
            "primary": window(limits.get("primary")), "secondary": window(limits.get("secondary")),
            "credits": {"balance": credits.get("balance"), "unlimited": credits.get("unlimited"),
                        "has_credits": credits.get("hasCredits", credits.get("has_credits")),
                        "spendable": accounts.spendable_credits(info, cfg)},
            "reset_credits": {
                "available_count": resets.get("availableCount", len(available) if "credits" in resets else None),
                "expires_at": [iso_time(credit.get("expiresAt")) for credit in available] if "credits" in resets else None},
            "status": status})
    cached = claude_accounts.read_limits()
    claude = []
    for account in claude_accounts.accounts(cfg):
        info = cached.get(account["name"], {})
        windows = info.get("unifiedWindows") or {}
        active = claude_accounts.limited(info)
        limited_until = info.get("limited_until", info.get("resetsAt")) if active else None
        claude.append({"name": account["name"],
                       "weight": account.get("weight", 1),
                       "updated_at": iso_time(info.get("updated_at")),
                       "stale": claude_accounts.stale(cfg, info),
                       "five_hour": window(windows.get("five_hour"), claude=True),
                       "seven_day": window(windows.get("seven_day"), claude=True),
                       "limited_until": iso_time(limited_until),
                       "model_limits": [{"model": model, "limited_until": iso_time(until)}
                                        for model, until in claude_accounts.model_limits(info).items()],
                       "token_unavailable": True if claude_accounts.token_marked(info) else None,
                       "needs_login": True if (claude_accounts.token_marked(info) or
                                                info.get("reason") == "authentication failed") else None})
    return {"codex": codex, "claude": claude,
            "thresholds": {"soft_switch_at": cfg.get("soft_switch_at", cfg["switch_at"]),
                           "switch_at": cfg["switch_at"]},
            "credits_floor": accounts.credits_floor(cfg), "credits_floor_until": cfg.get("credits_floor_until"),
            "duty": duty.read_duty()}


def print_accounts(infos, cfg, duty_record=None):
    if cfg.get("soft_switch_at", cfg["switch_at"]) != cfg["switch_at"]:
        print(f"soft_switch_at: {cfg['soft_switch_at']:g}% (switch_at: {cfg['switch_at']:g}%)")
    floor = accounts.credits_floor(cfg)
    if floor > 0:
        until = cfg.get("credits_floor_until")
        print(f"credits_floor: {floor:g}" + (f" through {until}" if until else "") +
              ("" if cfg.get("credits") else " (credits off)"))
    print(account_commands.ACCOUNTS_HEADER)
    for info in infos:
        print(account_commands.account_line(info, cfg, duty_record))


DUTY_LAUNCHD_LABEL = "teamster.duty"


def home_environment():
    """The variables that make a launchd job resolve this process's homes."""
    if config.LAYOUT == "legacy":
        return {"CODEX_TASK_HOME": str(config.CODEX_HOME)}
    environment = {"TEAMSTER_HOME": str(config.DATA_HOME)}
    if config.CODEX_HOME != config.default_codex_home().resolve():
        environment["TEAMSTER_CODEX_HOME"] = str(config.CODEX_HOME)
    return environment


def duty_launchd_plist(minutes):
    """A launchd job for duty tick; printing it never installs or loads anything."""
    environment = {"PATH": os.pathsep.join(["/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".local/bin"),
                                            "/usr/bin", "/bin", "/usr/sbin", "/sbin"])}
    environment.update(home_environment())
    for key in ("CODEX_TASK_CODEX", "CODEX_TASK_CLAUDE"):
        if config.env(key):
            environment["TEAMSTER_" + key.removeprefix("CODEX_TASK_")] = config.env(key)
    log = str(config.data_path("duty_launchd_log"))
    command = Path(sys.executable).parent / "teamster"
    if installs.running_from_versions():
        # The launcher follows the current link, so the job survives upgrades and prunes.
        program = [str(installs.bin_dir() / "teamster"), "duty", "tick"]
    elif command.is_file():
        program = [str(command), "duty", "tick"]
    else:
        program = [sys.executable, "-I", str(config.SCRIPT_RESOLVED), "duty", "tick"]
    return {"Label": DUTY_LAUNCHD_LABEL,
            "ProgramArguments": program,
            "StartInterval": minutes * 60, "RunAtLoad": True, "EnvironmentVariables": environment,
            "StandardOutPath": log, "StandardErrorPath": log}


def duty_rooms_text(record):
    families = ["%s %s" % (family, ", ".join(f"{name} {room:g}" for name, room in sorted(entries.items())))
                for family, entries in sorted(record["rooms"].items()) if entries]
    return "; ".join(families) or "none"


def duty_summary(record):
    label, unavailable = duty.duty_label(record), record["pinned_unavailable"]
    text = ((f"{label} since " if label else "no duty account since ")
            + config.local_time(record["since"]) + ": " + record["reason"])
    if record["pinned"]:
        text += " (pinned" + (f"; unavailable: {unavailable}" if unavailable else "") + ")"
    return text


def cmd_duty_tick(a):
    cfg = config.accounts_config()
    with duty.duty_lock(wait=False) as held:
        if not held:
            print("duty tick: another duty tick is running; nothing changed")
            return
        record, changed = duty_tick(cfg)
    print(("duty changed to " if changed else "duty ") + duty_summary(record))


def duty_tick(cfg, unpin=False):
    """Refresh stale limits and record the election as duty tick does; the caller holds duty_lock."""
    refreshed_at = clock.CLOCK.time()
    if config.provider_installed("claude"):
        try:
            claude_review.refresh_limits(cfg)
        except Exception as exc:
            # Stale or unknown snapshots simply stay out of the election.
            print(f"duty tick: Claude limit refresh failed: {exc}", file=sys.stderr)
        # A fresh snapshot is not probed; mark a missing token as probes and selection do.
        for account in claude_accounts.accounts(cfg):
            if claude_runner.account_environment(account, config.ACCOUNT_TIMEOUT)[1]:
                claude_accounts.token_available(account["name"])
            else:
                claude_accounts.mark_limited(account["name"], token_unavailable=True)
    infos = accounts.snapshots(cfg)
    return duty.run_duty_tick(cfg, infos, refreshed_at, unpin)


def cmd_duty_auto(a):
    cfg = config.accounts_config()
    # Waits for a running tick, which then cannot undo this election.
    with duty.duty_lock():
        record, changed = duty_tick(cfg, unpin=True)
    print("duty elected automatically: " + ("changed to " if changed else "") + duty_summary(record))


def duty_set_target(cfg, name, family):
    """(family, account settings) that duty set names; dies on an unknown or ambiguous name."""
    pools = (("claude", claude_accounts.accounts(cfg)), ("codex", cfg["accounts"]))
    matches = [(pool_family, account) for pool_family, pool in pools for account in pool
               if account["name"] == name and family in (None, pool_family)]
    if not matches:
        procs.die(f"no {family + ' ' if family else ''}account {name!r} (see teamster accounts); nothing changed")
    if len(matches) > 1:
        procs.die(f"{name!r} names both claude/{name} and codex/{name}; choose one with --family claude "
                  "or --family codex; nothing changed")
    return matches[0]


def cmd_duty_set(a):
    cfg = config.accounts_config()
    family, account = duty_set_target(cfg, a.account, a.family)
    label, name, now = family + "/" + a.account, a.account, clock.CLOCK.time()
    if family == "claude":
        config.require_claude()
        if not claude_runner.account_environment(account, config.ACCOUNT_TIMEOUT)[1]:
            procs.die(f"{label} has no token; sign it in with teamster claude-login {name}; nothing changed")
        info = claude_accounts.read_limits().get(name, {})
        if info.get("reason") == "authentication failed":
            procs.die(f"{label} needs login: authentication failed; run teamster claude-login {name}; nothing changed")
        # The token was just read: drop a missing-token mark as duty tick does.
        claude_accounts.token_available(name)
        candidate = duty.claude_duty_candidate(cfg, account, claude_accounts.read_limits().get(name, {}), now, now)
    else:
        config.codex_binary()
        info = next(item for item in accounts.snapshots(cfg) if item["name"] == name)
        if info["logged_in"] is False:
            procs.die(f"{label} is not logged in; run teamster login {name}; nothing changed")
        candidate = duty.codex_duty_candidate(cfg, info)
    # Written after a running tick ends; a tick that starts meanwhile finds the lock held and changes nothing.
    with duty.duty_lock():
        duty.pin_duty(family, name, candidate["unavailable"])
    print(f"duty pinned to {label}; duty tick keeps it until teamster duty auto or duty clear")
    if candidate["unavailable"]:
        print(f"warning: {label} cannot work now: {candidate['unavailable']}; it stays on duty while pinned")


def cmd_duty_status(a):
    record = duty.read_duty(warn=False)
    unreadable = record is None and duty.duty_path().exists()
    age = (clock.CLOCK.time() - record["checked_at"]) / 60 if record else None
    stale = age is not None and age > duty.DUTY_STALE_MINUTES
    if a.json:
        print(json.dumps({"duty": record, "checked_minutes_ago": round(age, 1) if age is not None else None,
                          "stale": stale, "unreadable": unreadable}, ensure_ascii=False))
        return
    if record is None:
        print(f"duty.json is unreadable; account selection ignores it until the next duty tick: {duty.duty_path()}"
              if unreadable else "no duty account: duty.json is absent")
        return
    print("duty " + duty_summary(record))
    print("pinned by hand: duty tick keeps it; teamster duty auto returns to election" if record["pinned"]
          else "elected by duty tick")
    print("rooms: " + duty_rooms_text(record))
    print(f"checked {config.local_time(record['checked_at'])} ({age:.0f} min ago)")
    if record["pinned_unavailable"]:
        print(f"warning: the pinned duty cannot work now: {record['pinned_unavailable']}")
    if stale:
        print(f"warning: no duty check for {age:.0f} minutes; re-election is not running "
              "(run duty tick, or install the duty plist job)")


def cmd_duty_clear(a):
    if duty.clear_duty():
        print(f"duty cleared; the change log stays in {duty.duty_log_path()}")
    else:
        print("no duty account: duty.json is absent")


def cmd_duty_plist(a):
    sys.stdout.write(plistlib.dumps(duty_launchd_plist(a.minutes)).decode("utf-8"))


def cmd_duty_chat(a):
    text = Path(a.file).read_text(encoding="utf-8") if a.file else a.text
    if not text or not text.strip():
        procs.die("empty message")
    with config.home_lock():
        sent = send_to_duty(text, {}, a.queue)
    if sent is None:
        return
    st, proc, account = sent
    turn = st["turns"]
    print(f"sent to the duty {account} (turn {turn}), pid {st['pid']}\n"
          f"  wait: {config.COMMAND} wait {duty_chat.CHAT_SLUG}", flush=True)
    # Poll this command's own child: a supervisor killed before it cleared its pid stays a zombie until reaped.
    while proc.poll() is None:
        if task_state.load(duty_chat.CHAT_SLUG).get("turns", 0) != turn:
            break
        time.sleep(config.WAIT_POLL_SECONDS)
    st = task_state.load(duty_chat.CHAT_SLUG)
    answer = next((entry for entry in reversed(st.get("duty_turns", [])) if entry["turn"] == turn), None)
    if answer is None:
        procs.die(f"the duty gave no answer (outcome {st.get('outcome')})"
                  + (f": {st['error']}" if st.get("error") and st.get("turns") == turn else ""))
    for line in wait_view.wait_duty_lines({"result": answer}, ""):
        print(line)


def say_duty_chat(a):
    options = say_options(a)
    refuse_work_options({"kind": duty_chat.CHAT_KIND}, options)
    text = Path(a.file).read_text() if a.file else a.message
    if not text or not text.strip():
        procs.die("empty message")
    sent = send_to_duty(text, options, a.queue)
    if sent is not None:
        st = sent[0]
        print(f"sent to {duty_chat.CHAT_SLUG} (turn {st['turns']}), pid {st['pid']}")


def send_to_duty(text, options, queue):
    """Send the user's message to the duty conversation, creating it first; the caller holds the home lock.

    Returns (state, the turn's supervisor, the duty account), or None when the message was queued.
    """
    cfg = config.accounts_config()
    account, refusal = duty_chat.chat_account(cfg)
    if account is None:
        procs.die(refusal)
    duty_chat.prepare_chat_backend(account["family"])
    order = {"at": clock.CLOCK.time(), "text": text, "options": options, "source": "user"}
    if not task_state.state_path(duty_chat.CHAT_SLUG).exists():
        opened = open_duty_chat(cfg, account, order)
        if opened is not None:
            return opened + (account["name"],)
    sent = send_duty_chat(cfg, order, queue)
    return None if sent is None else sent + (account["name"],)


def open_duty_chat(cfg, account, order):
    """Create the duty conversation and start its first turn; return (state, supervisor), or None when it exists.

    Creation holds spawn_lock and the state lock, so a creation an interruption cut short, which left no
    state.json, is removed and made again, and two commands never both create it.
    """
    d = duty_chat.chat_dir()
    with installs.spawn_lock():
        supervisor.require_startable()
        d.mkdir(parents=True, exist_ok=True)
        with task_state.state_lock(duty_chat.CHAT_SLUG):
            if task_state.state_path(duty_chat.CHAT_SLUG).exists():
                return None
            duty_chat.clear_partial_chat()
            room = duty_chat.chat_room()
            duty_chat.build_chat_room(room)
            brief = prompts.duty_chat_brief(cfg)
            (d / "brief.md").write_text(brief, encoding="utf-8")
            st = {"slug": duty_chat.CHAT_SLUG, "kind": duty_chat.CHAT_KIND, "repo": str(room), "worktree": str(room),
                  "branch": "", "executor": account["family"], "effort": None,
                  "account": cfg["accounts"][0]["name"], "thread": "", "threads": [],
                  "rotations": [], "reviews": [], "checks": [], "created": clock.CLOCK.time(), "turns": 0,
                  "plugin_version": config.plugin_version(), "duty_turns": [], "duty_auto_turns": []}
            st[executors.from_state(st).account_field] = account["name"]
            supervisor.apply_say(st, order["options"], cfg)
            task_state.save(st)

            sent = []

            def prompt():
                sent.extend(duty_chat.held_notes())
                orders = sent + [order]
                threads.journal_followups(st, order["text"], "user", orders if len(orders) > 1 else ())
                return brief + "\n\n" + "\n\n".join(item["text"] for item in orders)

            turn = supervisor.say_turn(st, order["options"])
            proc = supervisor.launch(st, prompt, turn["effort"], True, duty_chat.CHAT_KIND, False, 0)
            # The held notes leave notes.json only once the turn that carries them is started and saved.
            duty_chat.release_held_notes(sent)
    return st, proc


def send_duty_chat(cfg, order, queue):
    """Send a later message to the duty conversation as say does; return (state, supervisor), or None when queued."""
    st = task_state.load(duty_chat.CHAT_SLUG)
    duty_chat.require_chat_task(st)
    # The conversation outlives versions: it follows the version that runs this command.
    move = installs.follow_pin(st, upgrade=True)
    if move:
        print(move)
    # Checked before queueing, as say does: a bad option must not reach the queue.
    supervisor.apply_say(st, order["options"], cfg)
    if queue:
        waiting = task_state.enqueue(duty_chat.CHAT_SLUG, order)
        if waiting is not None:
            print(f"queued for the duty: {waiting} waiting; sent when the current turn ends")
            return None
        st = task_state.load(duty_chat.CHAT_SLUG)
    else:
        # spawn checks again under the lock, on the state as it is then.
        require_idle(st, queue_hint=True)
    supervisor.apply_say(st, order["options"], cfg)
    sent = []

    def prompt():
        # Read under the state lock: the notes held for this message go out with it.
        sent.extend(duty_chat.held_notes())
        orders = sent + [order]
        if len(orders) == 1:
            return threads.followup_prompt(st, order["text"], cfg, source="user")
        return threads.followup_prompt(st, "\n\n".join(item["text"] for item in orders), cfg, queued=orders)

    # The turn starts from the state read under the lock: a turn that ended after st was loaded keeps its answer.
    proc = supervisor.spawn(st, prompt, **supervisor.say_turn(st, order["options"]),
                            refresh=lambda latest: supervisor.apply_say(latest, order["options"], cfg))
    # The held notes leave notes.json only once the turn that carries them is started and saved.
    with task_state.state_lock(duty_chat.CHAT_SLUG):
        duty_chat.release_held_notes(sent)
    return st, proc


def cmd_duty(a):
    {"tick": cmd_duty_tick, "status": cmd_duty_status, "clear": cmd_duty_clear, "set": cmd_duty_set,
     "auto": cmd_duty_auto, "plist": cmd_duty_plist, "chat": cmd_duty_chat}[a.duty_command](a)


def cmd_reset_credit(a):
    cfg = config.accounts_config()
    account = accounts.account_named(cfg, a.account)
    try:
        action = credit_resets.reset_credit_action(account, a.credit, confirmed=a.yes)
    except (OSError, ValueError, KeyError, RuntimeError) as exc:
        procs.die(f"free limit reset failed: {exc}")
    credit = action["credit"]
    print(f"Free limit reset on {a.account}: {credit['id']} ({credit.get('title') or 'Full reset'}), "
          f"expires {config.local_time(credit.get('expiresAt'))}")
    if action["outcome"] == "consumed (inferred)":
        print("consumed (inferred)")
        print_accounts([action["info"]], cfg)
        return
    if not a.yes:
        print("Preview only; pass --yes to consume this reset.")
        return
    print(json.dumps(action["response"], ensure_ascii=False, indent=2))
    print_accounts([action["info"]], cfg)


def cmd_docs(a):
    directory = config.PACKAGE / "docs"
    names = sorted(path.stem for path in directory.glob("*.md"))
    if a.name is None:
        print("\n".join(names))
    elif a.name in names:
        sys.stdout.write((directory / (a.name + ".md")).read_text(encoding="utf-8"))
    else:
        procs.die(f"unknown document {a.name!r}; run teamster docs to list documents")


def cmd_path(a):
    print(config.PACKAGE)
