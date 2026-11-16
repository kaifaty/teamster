"""Task commands, descriptions and main repositories."""
import codecs
import errno
import fcntl
import json
import os
import plistlib
import pty
import re
import runpy
import selectors
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
import unicodedata
from contextlib import contextmanager
from pathlib import Path

from . import accounts, budgets, claude_accounts, claude_review, claude_runner, clock, config, credit_resets, duty, duty_chat, executors, installs, procs, prompts, reflection, result_schema, reviewers, sandboxing, supervisor, task_state, telemetry_log, terminal_screen, threads, wait_view


def main_repo(path):
    """The main checkout of the repository `path` belongs to (including worktrees)."""
    common = Path(procs.sh(config.GIT + ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=path))
    return common.parent


def cmd_start(a):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", a.slug):
        procs.die("slug: 2-41 chars of a-z, 0-9 and '-'")
    cfg = config.accounts_config()
    no_push = getattr(a, "no_push", False)
    if no_push and (a.ci or a.ci_command is not None):
        procs.die("--no-push cannot be combined with --ci or --ci-command; CI requires a published branch")
    executor = (executors.get(a.executor) if getattr(a, "executor", None)
                else executors.from_state(cfg))
    reviewer = getattr(a, "reviewer", None) or executor.reviewer(cfg)
    sandbox = a.sandbox if a.sandbox is not None else cfg["sandbox"]
    if not executor.supports_sandbox and sandbox != "off":
        procs.die(f"--executor {executor.name} supports only --sandbox off; --sandbox workspace is not supported")
    try:
        executor.prepare(a.effort, cfg)
    except ValueError as exc:
        procs.die(str(exc))
    reviewers.get(reviewer).prepare(cfg)
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
          "executor": executor.name, "effort": a.effort, "task_type": a.task_type,
          "task_model": None if getattr(a, "model", None) == "default" else getattr(a, "model", None),
          "review_model": None if getattr(a, "review_model", None) == "default" else getattr(a, "review_model", None),
          "account": cfg["accounts"][0]["name"], "thread": "", "threads": [],
          "rotations": [], "reviews": [], "checks": [], "check": a.check, "check_timeout": a.check_timeout,
          "check_loaded": a.check_loaded,
          "guards": a.guard, "base_check": a.base_check,
          "sandbox": sandbox, "writable_dirs": cfg["writable_dirs"], "no_push": no_push,
          "review_angles": a.review_angles,
          "reviewer": reviewer,
          "max_turn_minutes": max_minutes,
          "ci_enabled": not no_push and (a.ci or bool(a.ci_command) or cfg["ci"]), "ci_command": a.ci_command,
          "ci_rounds": a.ci_rounds if a.ci_rounds is not None else 1,
          "ci_timeout_minutes": cfg["ci_timeout_minutes"],
          "max_task_weekly_percent": a.max_weekly if a.max_weekly is not None else cfg.get("max_task_weekly_percent"),
          "weekly_used_percent": 0,
          "created": clock.CLOCK.time(), "turns": 0, "plugin_version": config.plugin_version(),
          "parallel": bool(a.parallel)}
    if config.started_by():
        st["started_by"] = config.started_by()
    task_state.save(st)
    proc = supervisor.spawn(st, prompt, a.effort, review_after=a.review, fix_rounds=a.fix_rounds or 0)
    for _ in range(300):
        st = task_state.load(a.slug)
        if st["thread"] or executor.cursor(st) or st.get("outcome") == "sleeping" or st.get("pid") is None or proc.poll() is not None:
            break
        time.sleep(0.1)
    account = executor.account(st)
    cursor = executor.cursor_label + " " + (executor.cursor(st) or "?")
    print(f"started {a.slug}: executor {executor.name}, account {account or '?'}, {cursor}, pid {st.get('pid')}\n  worktree {wt}\n  branch {branch}")
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
    executor = executors.get(getattr(a, "executor", None) or "codex")
    try:
        executor.prepare_scout(a.effort, cfg, directory)
    except ValueError as exc:
        procs.die(str(exc))
    d = config.TASKS / a.slug
    d.mkdir(parents=True)
    prompt = prompts.scout_prompt(question, cfg)
    (d / "brief.md").write_text(prompt)
    st = {"slug": a.slug, "kind": "scout", "repo": str(directory), "worktree": str(directory), "branch": "",
          "executor": executor.name, "effort": a.effort,
          "account": cfg["accounts"][0]["name"], "thread": "", "threads": [],
          "rotations": [], "reviews": [], "checks": [], "created": clock.CLOCK.time(), "turns": 0}
    if config.started_by():
        st["started_by"] = config.started_by()
    task_state.save(st)
    proc = supervisor.spawn(st, prompt, a.effort, kind="scout")
    for _ in range(300):
        st = task_state.load(a.slug)
        if executor.cursor(st) or st.get("outcome") == "sleeping" or st.get("pid") is None or proc.poll() is not None:
            break
        time.sleep(0.1)
    print(f"started scout {a.slug}: account {executor.account(st) or '?'}, "
          f"{executor.cursor_label} {executor.cursor(st) or '?'}, pid {st.get('pid')}\n  directory {directory}")
    print(f"  wait: {config.COMMAND} wait {a.slug}   (run it as a background command)")


def cmd_reflect(a):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", a.slug):
        procs.die("slug: 2-41 chars of a-z, 0-9 and '-'")
    cfg = config.accounts_config()
    if (config.TASKS / a.slug).exists():
        procs.die(f"task {a.slug!r} exists; pick another slug or clean it")
    order = Path(a.file).read_text() if a.file else a.order
    executor = executors.get(a.executor)
    try:
        executor.prepare(a.effort, cfg)
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
          "executor": executor.name, "effort": a.effort,
          "account": cfg["accounts"][0]["name"], "thread": "", "threads": [],
          "rotations": [], "reviews": [], "checks": [], "created": clock.CLOCK.time(), "turns": 0,
          "reflect_mode": "study" if study else "batch", "reflect_through": through, "reflect_records": records,
          "reflect_order": order if order and order.strip() else None, "reflect_turns": [],
          "max_turn_minutes": a.max_minutes}
    if a.model is not None:
        st["task_model"] = None if a.model == "default" else a.model
    task_state.save(st)
    proc = supervisor.spawn(st, prompt, a.effort, kind="reflect")
    for _ in range(300):
        st = task_state.load(a.slug)
        if executor.cursor(st) or st.get("outcome") == "sleeping" or st.get("pid") is None or proc.poll() is not None:
            break
        time.sleep(0.1)
    selection = f"study of {len(records)} records" if study else f"{len(records)} records through {through}"
    print(f"started reflect {a.slug}: {selection}, executor {executor.name}, "
          f"account {executor.account(st) or '?'}, {executor.cursor_label} {executor.cursor(st) or '?'}, "
          f"pid {st.get('pid')}\n  reading room {room}")
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
    cfg = config.accounts_config()
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
    cfg = config.accounts_config()
    reviewer = getattr(a, "reviewer", None) or st["reviewer"]
    reviewers.get(reviewer).prepare(cfg)
    st["reviewer"] = reviewer
    if getattr(a, "review_model", None) is not None:
        st["review_model"] = None if a.review_model == "default" else a.review_model
    budgets.set_weekly_budget(st, getattr(a, "max_weekly", None), cfg)
    st["review_angles"] = a.review_angles
    supervisor.spawn(st, prompts.review_prompt(st, cfg), a.effort or st.get("effort"), kind="review")
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
    line = (f"{st['slug']:24} {state:8} turns {st.get('turns', 0)}  {location}  "
            f"executor {executor.name}  account {account}  {'thread' if reviewing else executor.cursor_label} {thread[:13]}" + label
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
    cfg = config.accounts_config()
    executors.from_state(st).stats(st)
    for entry in st["threads"] + st["reviews"]:
        reviewers.from_entry(entry).stats(entry, cfg)


def print_codex_review_stats(entry, cfg):
    account = accounts.account_named(cfg, entry["account"])
    path = threads.rollout_path(account["home"], entry["thread"])
    print(f"== {entry['account']}: {entry['thread']}", flush=True)
    if path:
        subprocess.run([sys.executable, "-I", str(config.STATS), str(path)], check=True)
    else:
        print("(rollout not found)")


def prepare_claude_review(cfg):
    config.require_claude()


def prepare_claude_work(effort, cfg):
    claude_runner.validate_work_effort(effort or cfg["claude"].get("effort"))
    config.require_claude()


def prepare_claude_scout(effort, cfg, directory):
    inside = subprocess.run(config.GIT + ["rev-parse", "--is-inside-work-tree"], cwd=directory,
                            text=True, capture_output=True)
    if inside.returncode != 0 or inside.stdout.strip() != "true":
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
            orphan = st.get("claude_pid") if st.get("kind") == duty_chat.CHAT_KIND else None
            if not procs.alive(orphan):
                print("not running")
                return
            # The duty's supervisor died before its Claude, which still holds the session.
            procs.end_group(orphan)
            st.pop("claude_pid", None)
            task_state.write_state(st)
            print(f"stopped {a.slug}: ended Claude process {orphan}")
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
    st = task_state.load(a.slug)
    if st.get("kind") == duty_chat.CHAT_KIND:
        # A task note may start a duty turn at any moment: check and archive under the lock that delivery takes.
        with task_state.state_lock(a.slug):
            st = task_state.load(a.slug)
            if not procs.alive(st.get("pid")) and procs.alive(st.get("claude_pid")):
                procs.die(f"Claude process {st['claude_pid']} of the last duty turn is still running; "
                          f"end it with {config.COMMAND} stop duty, then clean")
            return clean_task(a, st)
    return clean_task(a, st)


def clean_task(a, st):
    if procs.alive(st.get("pid")):
        procs.die("still running; stop it first")
    if st.get("kind") in ("reflect", "duty"):
        shutil.rmtree(config.TASKS / a.slug / "room", ignore_errors=True)
    elif st.get("kind") != "scout":
        repo, wt = st["repo"], st["worktree"]
        if Path(wt).exists():
            procs.sh(config.GIT + ["worktree", "remove", "--force", wt], cwd=repo)
            shutil.rmtree(Path(wt).parent, ignore_errors=True)
        if not a.keep_branch:
            subprocess.run(config.GIT + ["branch", "-D", st["branch"]], cwd=repo, capture_output=True)
    cfg = config.accounts_config()
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
        (record / "state.lock").unlink(missing_ok=True)
        record.rename(archive)
    except OSError as exc:
        procs.die(f"could not archive task record to {archive}: {exc}; record kept at {record}")
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
    account = accounts.account_named(cfg, entry["account"])
    accounts.prepare_home(account)
    subprocess.run([config.codex_binary(), "archive", entry["thread"]], env=accounts.account_env(account), capture_output=True)


reviewers.CODEX_REVIEWER.bind(sys.modules[__name__], stats="print_codex_review_stats", clean="clean_codex_review")
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
    cfg = config.accounts_config()
    if getattr(a, "refresh", False):
        claude_review.refresh_limits(cfg)
    infos = accounts.snapshots(cfg)
    if getattr(a, "json", False):
        print(json.dumps(accounts_json(infos, cfg), ensure_ascii=False))
        return
    record = duty.read_duty()
    print_accounts(infos, cfg, record)
    print("\n".join(accounts.claude_account_lines(
        cfg, record["account"] if record and record["family"] == "claude" else None)))


def codex_status(info, cfg):
    """The machine-readable status of one Codex account snapshot; None when unknown."""
    if info.get("duplicate"):
        return "duplicate"
    if info["logged_in"] is None:
        return None
    if not info["logged_in"]:
        return "not_logged_in"
    return "exhausted" if accounts.exhausted(info, cfg) else "available"


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
        status = codex_status(info, cfg)
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
    print(ACCOUNTS_HEADER)
    for info in infos:
        print(account_line(info, cfg, duty_record))


ACCOUNTS_HEADER = "NAME\tEMAIL\tPLAN\tWEEKLY %\tRESET (LOCAL)\tCREDITS\tRESETS\tSTATUS"


def account_line(info, cfg, duty_record=None):
    """One Codex account row of the accounts table."""
    w = accounts.longest_window(info)
    credits = info.get("limits", {}).get("credits", {})
    if info.get("duplicate"):
        status = "same account as " + info["duplicate"]
    elif info["logged_in"] is None:
        status = "unknown (rpc error: " + info.get("error", "unavailable") + ")"
    elif not info["logged_in"]:
        status = "not logged in"
    elif accounts.exhausted(info, cfg):
        status = "exhausted until " + config.local_time(accounts.reset_time(info, cfg))
    else:
        status = "available"
    if duty_record and duty_record["family"] == "codex" and duty_record["account"] == info["name"]:
        status += " (on duty)"
    account = info.get("account", {})
    resets = credit_resets.reset_credits(info)
    count = info.get("reset_credits", {}).get("availableCount", len(resets))
    nearest = resets[0].get("expiresAt") if resets else None
    reset_label = str(count) + (f" (exp {config.local_time(nearest).split()[0]})" if nearest is not None else "")
    return "\t".join((info["name"], account.get("email") or "—", account.get("planType") or "—",
                      f"{w['used']:g}" if w else "—", config.local_time(w.get("reset")),
                      ("unlimited" if credits.get("unlimited") else
                       str(credits.get("balance") or "0") if credits.get("hasCredits", credits.get("has_credits", False))
                       else "0") +
                      (" (at floor)" if accounts.at_credit_floor(info, cfg) else ""),
                      reset_label, status))


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
    label = duty.duty_label(record)
    return ((f"{label} since " if label else "no duty account since ")
            + config.local_time(record["since"]) + ": " + record["reason"])


def cmd_duty_tick(a):
    cfg = config.accounts_config()
    with duty.duty_lock(wait=False) as held:
        if not held:
            print("duty tick: another duty tick is running; nothing changed")
            return
        refreshed_at = clock.CLOCK.time()
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
        try:
            config.CODEX["path"] = config.resolve_codex()
        except SystemExit as exc:
            # procs.die reports a missing Codex CLI; Claude accounts can still be elected.
            print(f"duty tick: Codex accounts skipped: {exc}", file=sys.stderr)
            infos = [dict(account, logged_in=None) for account in cfg["accounts"]]
        else:
            infos = accounts.snapshots(cfg)
        record, changed = duty.run_duty_tick(cfg, infos, refreshed_at)
    print(("duty changed to " if changed else "duty ") + duty_summary(record))


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
    print("rooms: " + duty_rooms_text(record))
    print(f"checked {config.local_time(record['checked_at'])} ({age:.0f} min ago)")
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
    config.require_claude()
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
                  "branch": "", "executor": "claude", "effort": None, "claude_account": account["name"],
                  "account": cfg["accounts"][0]["name"], "thread": "", "threads": [],
                  "rotations": [], "reviews": [], "checks": [], "created": clock.CLOCK.time(), "turns": 0,
                  "plugin_version": config.plugin_version(), "duty_turns": [], "duty_auto_turns": []}
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
    {"tick": cmd_duty_tick, "status": cmd_duty_status, "clear": cmd_duty_clear,
     "plist": cmd_duty_plist, "chat": cmd_duty_chat}[a.duty_command](a)


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


CLAUDE_LOGIN_ENTER_DELAY = 0.5
# setup-token's pseudo-terminal: wide enough that the token and the sign-in link never wrap.
CLAUDE_LOGIN_ROWS, CLAUDE_LOGIN_COLUMNS = 24, 1000
# Screen rows are emitted once the output has paused this long, so half-drawn frames stay unseen,
CLAUDE_LOGIN_QUIET = 0.1
# or after this long without a pause, outside a synchronized frame.
CLAUDE_LOGIN_LATEST = 1.0
CLAUDE_TOKEN = r"sk-ant-oat01-[A-Za-z0-9_-]+"
CLAUDE_PROMPT = "Paste code here"


class LoginEvents:
    """The newline-delimited sign-in protocol; credentials stay only in memory."""

    def __init__(self, claude=False):
        self.claude = claude
        self.seen = set()
        self.opened = False
        self.code_expected = False
        self.code_sent = False
        self.prompted = False
        self.prompt_rows = set()
        self.scrolled = 0
        self.token = ""
        self.finished = False
        self.cancelled = None
        self.saving = False

    def send(self, event, **fields):
        print(json.dumps(dict(event=event, **fields), ensure_ascii=False), flush=True)

    def clean(self, text):
        text = re.sub(r"(?:\x1b\[|\x9b)([0-9]*)C",
                      lambda match: " " * min(int(match[1] or 1), 1000), text)
        # OSC/DCS strings, CSI sequences and the remaining terminal escapes.
        text = re.sub(r"(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)"
                      r"|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f]).*?(?:\x1b\\|\x9c)"
                      r"|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]",
                      "", text, flags=re.DOTALL)
        return "".join(char for char in text if not unicodedata.category(char).startswith("C"))

    def line(self, text):
        text = self.clean(text)
        if self.claude:
            text = re.sub(r"sk-ant-oat01-[A-Za-z0-9_-]*", "[token hidden]", text)
        if not text.strip():
            return
        if text not in self.seen:
            self.send("output", text=text[:500])
            self.seen.add(text)
        url = re.search(r"https://[^\s<>\"']+", text)
        if url and not self.opened:
            self.send("open", url=url.group().rstrip(".,);]"))
            self.opened = True
        if not self.claude and not self.code_sent:
            if self.code_expected:
                code = re.fullmatch(r"[A-Z0-9]+(?:-[A-Z0-9]+)+", text.strip())
                if code and 6 <= len(code.group().replace("-", "")) <= 16:
                    self.send("code", code=code.group(), expires_at=int(time.time()) + 900)
                    self.code_sent = True
            if "Enter this one-time code" in text:
                self.code_expected = True

    def screen(self, screen):
        """Emit the screen rows, with those that scrolled off since the last call, and a
        prompt when `Paste code here` appears on a row that did not show it before."""
        fresh = min(screen.scrolled - self.scrolled, len(screen.scrollback))
        first = screen.scrolled - fresh
        rows = screen.scrollback[len(screen.scrollback) - fresh:] + screen.lines()
        self.scrolled = screen.scrolled
        for row in rows:
            self.line(row)
        # Rows are numbered from the first output row, so they keep their numbers as they scroll.
        shown = {first + index for index, row in enumerate(rows) if CLAUDE_PROMPT in row}
        if shown - self.prompt_rows and not self.prompted:
            self.send("prompt")
            self.prompted = True
        self.prompt_rows = shown

    def result(self, status, message="", code=0):
        self.finished = True
        self.send("result", ok=code == 0, status=status, message=message)
        if code:
            raise SystemExit(code)


def run_login_events(a, command):
    events = LoginEvents(claude=a.cmd == "claude-login")

    def cancelled(signum, frame):
        if events.cancelled is not None:
            return
        events.cancelled = signum
        if not events.saving:
            raise SystemExit(128 + signum)

    handlers = {sig: signal.signal(sig, cancelled) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        command(a, events)
    except (SystemExit, KeyboardInterrupt) as exc:
        if events.finished:
            raise
        code = exc.code if isinstance(exc, SystemExit) else 130
        events.result("failed", str(code) if isinstance(code, str) else "", code=code if isinstance(code, int) and code else 1)
    except (OSError, ValueError, subprocess.SubprocessError):
        # Never include a subprocess exception: it can contain credential input/output.
        events.result("failed", "Claude login failed; account settings were not changed" if events.claude
                      else "Codex login failed", code=1)
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def terminate_login(proc, events):
    """Keep ordinary cleanup, but finish cancellation before the caller's kill deadline."""
    try:
        if events.cancelled is None:
            procs.terminate(proc)
    finally:
        if events.cancelled is not None:
            procs.signal_group(proc, signal.SIGTERM)
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                proc.poll()
                if not procs.signal_group(proc, 0):
                    break
                time.sleep(0.02)
            else:
                procs.signal_group(proc, signal.SIGKILL)
            proc.wait()


def codex_login_events(argv, environment, events):
    proc = subprocess.Popen(argv, env=environment, cwd=environment["CODEX_HOME"], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, errors="replace", start_new_session=True)
    try:
        for line in proc.stdout:
            events.line(line)
        return proc.wait()
    finally:
        terminate_login(proc, events)
        proc.stdout.close()


def claude_login_events(environment, events):
    master, slave = pty.openpty()
    proc = None
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ,
                    struct.pack("HHHH", CLAUDE_LOGIN_ROWS, CLAUDE_LOGIN_COLUMNS, 0, 0))
        attributes = termios.tcgetattr(slave)
        attributes[3] &= ~termios.ECHO
        termios.tcsetattr(slave, termios.TCSANOW, attributes)
        proc = subprocess.Popen([config.claude_binary(), "setup-token"], env=environment,
                                stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        slave = None
        # setup-token redraws only changed cells and moves the cursor over the rest,
        # so its output reads correctly only on a screen.
        screen = terminal_screen.Screen(CLAUDE_LOGIN_ROWS, CLAUDE_LOGIN_COLUMNS)
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        input_decoder = codecs.getincrementaldecoder("utf-8")("replace")
        incoming, oversized = "", False
        queued, enter_pending, input_deadline = [], False, 0.0
        changed, last_output = None, 0.0
        with selectors.DefaultSelector() as selector:
            selector.register(master, selectors.EVENT_READ)
            selector.register(sys.stdin, selectors.EVENT_READ)
            while True:
                timeout = 0.2
                if changed is not None:
                    timeout = min(timeout, max(0, last_output + CLAUDE_LOGIN_QUIET - time.monotonic()))
                if (enter_pending or queued) and proc.poll() is None:
                    timeout = min(timeout, max(0, input_deadline - time.monotonic()))
                output = False
                for key, _ in selector.select(timeout):
                    if key.fileobj == master:
                        output = True
                        try:
                            chunk = os.read(master, 65536)
                        except OSError as exc:
                            if exc.errno != errno.EIO:
                                raise
                            chunk = b""
                        screen.feed(decoder.decode(chunk, final=not chunk))
                        if not chunk:
                            events.screen(screen)
                            # The last whole token on the final screen, never a partial frame's.
                            tokens = re.findall(CLAUDE_TOKEN, screen.text())
                            events.token = tokens[-1] if tokens else ""
                            return proc.wait()
                        last_output = time.monotonic()
                        changed = last_output if changed is None else changed
                    else:
                        chunk = os.read(sys.stdin.fileno(), 4096)
                        if not chunk:
                            selector.unregister(sys.stdin)
                            continue
                        for char in input_decoder.decode(chunk):
                            if char == "\n":
                                line = incoming.removesuffix("\r")
                                if not oversized and len(line) <= 512 and all(
                                        not unicodedata.category(c).startswith("C") for c in line):
                                    queued.append(line)
                                incoming, oversized = "", False
                            elif not oversized:
                                incoming += char
                                if len(incoming) > 513:
                                    incoming, oversized = "", True
                now = time.monotonic()
                if changed is not None and (
                        not output and now - last_output >= CLAUDE_LOGIN_QUIET
                        or now - changed >= CLAUDE_LOGIN_LATEST and not screen.synchronized):
                    events.screen(screen)
                    changed = None
                if (enter_pending or queued) and time.monotonic() >= input_deadline and proc.poll() is None:
                    if enter_pending:
                        os.write(master, b"\r")
                        enter_pending = False
                    else:
                        os.write(master, queued.pop(0).encode("utf-8"))
                        enter_pending = True
                        events.prompted = False
                    # Keep Return separate from both the pasted text and the next queued line.
                    input_deadline = time.monotonic() + CLAUDE_LOGIN_ENTER_DELAY
    finally:
        if proc is not None:
            terminate_login(proc, events)
        os.close(master)
        if slave is not None:
            os.close(slave)


def cmd_login(a):
    if getattr(a, "events", False):
        return run_login_events(a, _cmd_login)
    return _cmd_login(a)


def _cmd_login(a, events=None):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}", a.name):
        procs.die("invalid account name")
    cfg = config.accounts_config()
    account = next((i for i in cfg["accounts"] if i["name"] == a.name), None)
    if account is None:
        account = {"name": a.name, "home": str(config.CODEX_HOME.parent / ".codex-accounts" / a.name)}
        cfg["accounts"].append(account)
    cfg.pop("enabled", None)
    with config.home_lock(exclusive=True):
        path = config.data_path("settings")
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
        tmp.replace(path)
    accounts.prepare_home(account)
    binary = config.codex_binary()
    try:
        argv = [binary, "login"] + ([] if a.browser else ["--device-auth"])
        if events:
            code = codex_login_events(argv, accounts.account_env(account), events)
        else:
            # The child inherits the person's terminal for the device code or the browser prompt.
            code = subprocess.run(argv, env=accounts.account_env(account)).returncode
    except KeyboardInterrupt:
        code = 130
    if code:
        if events:
            events.result("failed", code=code if code > 0 else 128 - code)
        raise SystemExit(code if code > 0 else 128 - code)
    if events:
        events.send("stage", stage="checking")
    # Like `accounts`, read the homes under the shared lock so migrate-home cannot move them meanwhile.
    with config.home_lock():
        # Re-read the settings: another login may have added an account during this sign-in.
        cfg = config.accounts_config()
        infos = accounts.snapshots(cfg)
        info = next((item for item in infos if item["name"] == a.name), None)
        if info is None:
            procs.die(f"account {a.name!r} was removed from the settings during the sign-in")
        # Snapshots mark the later of two accounts with one ChatGPT identity as the duplicate.
        others = [item for item in infos if item.get("duplicate") == a.name]
        other = info.get("duplicate") or (others[0]["name"] if others else None)
        status = "duplicate" if other else codex_status(info, cfg) or "unknown"
        record_login("codex", a.name, status)
    if not events:
        print(ACCOUNTS_HEADER)
        for item in [info] + others:
            print(account_line(item, cfg))
    ru = cfg.get("language", "en") == "ru"
    message = ""
    if other:
        message = (f"{a.name} — тот же аккаунт ChatGPT, что и {other}; войди заново другим аккаунтом: "
              f"teamster login {a.name}" if ru else
              f"{a.name} is the same ChatGPT account as {other}; sign in again with another account: "
              f"teamster login {a.name}")
    elif status == "not_logged_in":
        message = (f"{a.name} не вошёл в аккаунт после codex login; войди заново: teamster login {a.name}" if ru else
              f"{a.name} is not logged in after codex login; sign in again: teamster login {a.name}")
    elif status == "unknown":
        message = (f"не удалось проверить {a.name} после codex login; проверь: teamster accounts" if ru else
              f"could not check {a.name} after codex login; check it with: teamster accounts")
    if events:
        return events.result(status, message, code=0 if status in ("available", "exhausted") else 1)
    if message:
        print(message)
    if status not in ("available", "exhausted"):
        raise SystemExit(1)


def record_login(family, name, status):
    """Journal a finished sign-in so the board refreshes accounts; a failed write only warns."""
    try:
        telemetry_log.record_account_login(family, name, status)
    except OSError as exc:
        print(f"could not write the telemetry journal: {exc}", file=sys.stderr)


def terminal_device():
    """The person's terminal by its own device path. macOS kqueue rejects the
    /dev/tty alias, and the Claude CLI watches its input with kqueue."""
    for descriptor in (0, 1, 2):
        try:
            return os.ttyname(descriptor)
        except OSError:
            pass
    return "/dev/tty"


@contextmanager
def _locked_claude_settings():
    path = config.data_path("settings")
    with config.home_lock(exclusive=True):
        source = config.settings_path()
        settings = json.loads(source.read_text(encoding="utf-8")) if source.exists() else {}
        normalized = config.accounts_config()["claude"]["accounts"]
        pool = settings.setdefault("claude", {}).setdefault("accounts", normalized)
        yield pool
        temporary = path.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)


def cmd_claude_rename(a):
    if not re.fullmatch(r"[a-z0-9-]+", a.new):
        procs.die("Claude account name must contain only a-z, 0-9 and '-'")
    with _locked_claude_settings() as pool:
        account = next((item for item in pool if item["name"] == a.old), None)
        if account is None:
            procs.die(f"Claude account {a.old!r} does not exist")
        if any(item["name"] == a.new for item in pool):
            procs.die(f"Claude account {a.new!r} already exists")
        account["name"] = a.new
        claude_accounts.rename_limits(a.old, a.new)
    print(f"Claude account {a.old} renamed to {a.new}")


def cmd_claude_remove(a):
    with _locked_claude_settings() as pool:
        account = next((item for item in pool if item["name"] == a.name), None)
        if account is None:
            procs.die(f"Claude account {a.name!r} does not exist")
        if len(pool) == 1:
            procs.die("Cannot remove the last Claude account; switch reviewer to codex")
        pool.remove(account)
        claude_accounts.clear_limits(a.name)
    print(f"Claude account {a.name} removed")
    print(f"Remove the config directory manually: {account['config_dir']}")
    print(f"Remove the Keychain service manually: {account['token_keychain']}")


def cmd_claude_probe(a):
    probe_claude_account(a.name)


def probe_claude_account(name, login=False):
    cfg = config.accounts_config()
    account = next((item for item in claude_accounts.accounts(cfg) if item["name"] == name), None)
    if account is None:
        procs.die(f"Claude account {name!r} does not exist")
    reason = claude_review.probe(cfg, account)
    if login:
        record_login("claude", name, reason or "ok")
    if reason:
        print(f"Claude account {name}: {reason}")
        raise SystemExit(1)
    windows = claude_accounts.format_windows(claude_accounts.read_limits().get(name, {}))
    print(f"Claude account {name}: token ok; {windows}")


def cmd_claude_login(a):
    if getattr(a, "events", False):
        return run_login_events(a, _cmd_claude_login)
    return _cmd_claude_login(a)


def _cmd_claude_login(a, events=None):
    if not re.fullmatch(r"[a-z0-9-]+", a.name):
        procs.die("Claude account name must contain only a-z, 0-9 and '-'")
    config.require_claude()
    cfg = config.accounts_config()
    pool = cfg["claude"]["accounts"]
    previous = next((account for account in pool if account["name"] == a.name), None)
    directory = a.config_dir or (previous["config_dir"] if previous else
                                 str(Path.home() / ".claude-accounts" / a.name))
    service = a.keychain or (previous["token_keychain"] if previous else
                             "codex-worker-claude-" + a.name)
    if events and any(char in '\\"' or unicodedata.category(char).startswith("C")
                      for value in (service, os.environ.get("USER", "")) for char in value):
        return events.result("failed", "Keychain service and user must not contain control characters, "
                             "quotes or backslashes", code=1)
    directory = str(Path(directory).expanduser().resolve())
    environment = {key: os.environ[key] for key in ("HOME", "USER", "PATH") if key in os.environ}
    environment.update(LANG="en_US.UTF-8", CLAUDE_CONFIG_DIR=directory)
    Path(directory).mkdir(mode=0o700, parents=True, exist_ok=True)
    account = {"name": a.name, "config_dir": directory, "token_keychain": service}
    if events:
        code = claude_login_events(environment, events)
        if code or not events.token:
            return events.result("failed", "Claude login failed; account settings were not changed", code=1)
        # Check the captured token before it can replace a saved one that still works.
        events.send("stage", stage="checking")
        reason, record = claude_review.check_token(cfg, account, events.token, stopped=lambda: False)
        # A usage limit also proves that the token authenticates: save it and report the limit.
        if reason not in (None, "usage limit"):
            with config.home_lock():
                record_login("claude", a.name, reason)
            return events.result(reason, f"Claude account {a.name}: {reason}; "
                                 "the Keychain item and account settings were not changed", code=1)
        events.saving = True
        events.send("stage", stage="saving")
        # security's interactive command parser reads the password from a pipe,
        # keeping it out of argv, the environment and the terminal.
        arguments = ["add-generic-password", "-U", "-s", service,
                     "-a", os.environ.get("USER", ""), "-w", events.token]
        command = " ".join('"' + value + '"' for value in arguments) + "\n"
        proc = subprocess.Popen(["security", "-i"], env=environment, stdin=subprocess.PIPE,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                start_new_session=True)
        try:
            proc.communicate(command.encode("utf-8"), timeout=config.ACCOUNT_TIMEOUT)
            if proc.returncode:
                return events.result("failed", "Claude login failed; account settings were not changed", code=1)
        finally:
            procs.terminate(proc)
        if claude_runner.account_environment(account, config.ACCOUNT_TIMEOUT)[1] != events.token:
            return events.result("failed", "Claude token could not be read back from Keychain", code=1)
    else:
        # setup-token displays the credential for the person to paste into the
        # Keychain prompt. Keep both interactive tools off captured command output.
        try:
            with open(terminal_device(), "r+b", buffering=0) as terminal:
                for argv in ([config.claude_binary(), "setup-token"],
                             ["security", "add-generic-password", "-U", "-s", service,
                              "-a", os.environ.get("USER", ""), "-w"]):
                    if subprocess.run(argv, env=environment, stdin=terminal,
                                      stdout=terminal, stderr=terminal).returncode:
                        procs.die("Claude login failed; account settings were not changed")
        except OSError:
            procs.die("Claude login requires a terminal and the Claude CLI and Keychain tools")
    with _locked_claude_settings() as pool:
        previous = next((item for item in pool if item["name"] == a.name), None)
        if previous is None:
            pool.append(account)
        else:
            previous.update(account)
        claude_accounts.clear_limits(a.name)
    if events:
        # The check already answered for the saved token: book it instead of probing again.
        # Like the probe, it must not run while the home moves.
        with config.home_lock():
            record()
            record_login("claude", a.name, reason or "ok")
        events.saving = False
        if events.cancelled is not None:
            return events.result("failed", "Claude login cancelled after saving account settings",
                                 code=128 + events.cancelled)
        if reason:
            return events.result(reason, f"Claude account {a.name}: {reason}", code=1)
        windows = claude_accounts.format_windows(claude_accounts.read_limits().get(a.name, {}))
        return events.result("ok", f"Claude account {a.name}: token ok; {windows}")
    print(f"Claude account {a.name} saved")
    # The probe writes cached limits; like claude-probe, it must not run while the home moves.
    with config.home_lock():
        probe_claude_account(a.name, login=True)


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
