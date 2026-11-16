"""One isolated Claude Code review, with no persisted CLI output or credentials."""
import fcntl
import hashlib
import json
import os
import selectors
import stat
import subprocess
import tempfile
import time
from pathlib import Path

from . import claude_accounts, claude_runner, clock, config, duty, procs, task_state


def worktree_snapshot(st):
    # Status reads file contents, so disable every configured filter, including
    # git-lfs. Worker-written filter scripts must not run in the supervisor.
    configured = subprocess.run(config.GIT + ["config", "--null", "--name-only", "--get-regexp",
                                             r"^filter\..*\.(clean|smudge|process)$"],
                                cwd=st["worktree"], text=True, capture_output=True,
                                errors="surrogateescape")
    if configured.returncode not in (0, 1):
        configured.check_returncode()
    snapshot_git = list(config.GIT)
    drivers = {key[len("filter."):key.rfind(".")] for key in configured.stdout.split("\0") if key}
    for driver in sorted(drivers):
        for command in ("clean=", "smudge=", "process=", "required=false"):
            snapshot_git += ["-c", f"filter.{driver}.{command}"]
    head, status = (procs.sh(snapshot_git + args, cwd=st["worktree"], errors="surrogateescape")
                    for args in (["rev-parse", "HEAD"],
                                 ["status", "--porcelain", "-z", "--untracked-files=all"]))
    names = set()
    records = iter(status.split("\0"))
    for record in records:
        if not record:
            continue
        names.add(record[3:])
        if "R" in record[:2] or "C" in record[:2]:
            names.add(next(records))  # Porcelain -z gives destination, then source.
    files = []
    for name in sorted(names):
        path = Path(st["worktree"]) / name
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode):
            contents = os.readlink(path)
        elif stat.S_ISREG(mode):
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(65536), b""):
                    digest.update(chunk)
            contents = digest.digest()
        else:
            continue  # Directories, including submodules, are covered by status.
        files.append((name, mode, contents))
    return head, status, files


def event_unavailable(event, account, record=True, model=None, limit=None):
    """Recognize review account errors using the shared transport parser."""
    return claude_runner.stream_unavailable(event, account, record, model, limit)


def refresh_limits(cfg, stopped=None):
    """Refresh stale, unblocked accounts before any role chooses from the pool."""
    limits = claude_accounts.read_limits()
    for account in claude_accounts.accounts(cfg):
        if stopped is not None and stopped():
            return
        info = limits.get(account["name"], {})
        now = clock.CLOCK.time()
        if not claude_accounts.limited(info, now) and claude_accounts.probe_due(cfg, info, now):
            probe(cfg, account, stale_only=True, stopped=stopped)


def select_account(cfg, role, exclude=(), prefer_unused=(), stopped=None, task_type=None, model=None):
    """Choose for new work on ``model`` after a refresh, skipping the duty account (duty.claude_reserved)."""
    refresh_limits(cfg, stopped)
    exclude = set(exclude) | duty.claude_reserved(cfg, role, exclude, task_type, stopped, model)
    return claude_accounts.select(cfg, role, exclude, prefer_unused, model)


def _probe_lock(name):
    """The file whose lock serializes the probes of one account."""
    config.TASKS.mkdir(parents=True, exist_ok=True)
    return (config.TASKS / ("claude-probe-" + name + ".lock")).open("a")


def probe(cfg, account, stale_only=False, stopped=None):
    """Serialize account probes, rechecking stale snapshots after taking the lock."""
    with _probe_lock(account["name"]) as lock:
        if stopped is None:
            fcntl.flock(lock, fcntl.LOCK_EX)
        else:
            while not stopped():
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(0.2)
            else:
                return "request failed"
        if stale_only:
            info = claude_accounts.read_limits().get(account["name"], {})
            now = clock.CLOCK.time()
            if claude_accounts.limited(info, now) or not claude_accounts.probe_due(cfg, info, now):
                return None
        if stopped is not None and stopped():
            return "request failed"
        claude_accounts.mark_probe_attempt(account["name"])
        return _probe(cfg, account, stopped)


def _probe(cfg, account, stopped=None):
    """Send one short request with the saved token, without tools or persisted CLI output."""
    environment, token = claude_runner.account_environment(account, config.ACCOUNT_TIMEOUT)
    if stopped is not None and stopped():
        return "request failed"
    if not token:
        claude_accounts.mark_limited(account["name"], token_unavailable=True)
        return "token unavailable"
    claude_accounts.token_available(account["name"])
    return _answer(account["name"], _ask(cfg, environment, stopped), model=cfg["claude"].get("model") or None)


def check_token(cfg, account, token, stopped=None):
    """Probe a token that is not saved yet; return (reason, record).

    The token reaches the CLI only through a pipe. Nothing about the account is
    stored, so a rejected token cannot mark an account whose saved token still
    works; once the token is saved, record() books the answer as probe() would.
    """
    environment = claude_runner.isolated_environment(account)
    answer = _ask(cfg, environment, stopped, token)
    reason = _answer(account["name"], answer, record=False)

    def record():
        # A probe of the replaced token may still be running: let it answer first.
        with _probe_lock(account["name"]) as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            claude_accounts.mark_probe_attempt(account["name"])
            # The saved token is there now, whatever an older probe failed to read.
            claude_accounts.token_available(account["name"])
            _answer(account["name"], answer, model=cfg["claude"].get("model") or None)

    return reason, record


def _ask(cfg, environment, stopped=None, token=None):
    """Run the probe request; return (output, returncode, timed_out), or None if it could not start.

    A token given here is written to a pipe the CLI reads
    (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR); otherwise the environment carries it.
    """
    executable = config.claude_binary()
    if executable is None:
        return None
    args = [executable, "-p", "Reply with the single word OK.",
            "--output-format", "stream-json", "--verbose", "--max-turns", "1",
            "--tools", "", "--permission-mode", "dontAsk"]
    if cfg["claude"].get("model"):
        args += ["--model", cfg["claude"]["model"]]
    timed_out = False
    credential_fd = None
    credential_args = {}
    try:
        if token is not None:
            credential_fd, writer = os.pipe()
            with os.fdopen(writer, "wb") as stream:
                stream.write(token.encode("utf-8"))
            environment.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
            environment["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"] = str(credential_fd)
            credential_args["pass_fds"] = (credential_fd,)
        with tempfile.TemporaryDirectory(prefix="teamster-claude-probe-") as directory:
            if stopped is None:
                response = subprocess.run(args, cwd=directory, env=environment,
                                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                          stderr=subprocess.DEVNULL, timeout=config.CLAUDE_PROBE_TIMEOUT,
                                          **credential_args)
                output, returncode = response.stdout, response.returncode
            else:
                proc = subprocess.Popen(args, cwd=directory, env=environment,
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, start_new_session=True, **credential_args)
                chunks, eof = [], False
                deadline = clock.CLOCK.monotonic() + config.CLAUDE_PROBE_TIMEOUT
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(proc.stdout, selectors.EVENT_READ)
                        while True:
                            if stopped() or clock.CLOCK.monotonic() >= deadline:
                                timed_out = True
                                break
                            if eof and proc.poll() is not None:
                                break
                            for key, _ in selector.select(0.2):
                                chunk = os.read(key.fileobj.fileno(), 65536)
                                if not chunk:
                                    selector.unregister(key.fileobj)
                                    eof = True
                                chunks.append(chunk)
                finally:
                    procs.terminate(proc)
                    proc.stdout.close()
                output, returncode = b"".join(chunks), proc.returncode
    except subprocess.TimeoutExpired as exc:
        output, returncode = exc.stdout or b"", None
        timed_out = True
    except OSError:
        return None
    finally:
        if credential_fd is not None:
            os.close(credential_fd)
    return output, returncode, timed_out


def _answer(name, answer, record=True, model=None):
    """The probe's failure reason, or None; with record, store what it says about the account.

    ``model`` is the probe's ``--model`` (``claude.model``).
    """
    if answer is None:
        return "request failed"
    output, returncode, timed_out = answer
    reason, answered, limit = None, False, {}
    for line in output.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            reason = reason or "request failed"
            continue
        if not isinstance(event, dict):
            reason = reason or "request failed"
            continue
        # Later events of a failed probe do not lift its mark.
        unavailable = event_unavailable(event, name, record, model if reason is None else None, limit)
        reason = reason or unavailable
        if event.get("type") == "result":
            if event.get("is_error"):
                reason = reason or "request failed"
            else:
                answered = isinstance(event.get("result"), str) and bool(event["result"].strip())
    if reason in ("usage limit", "authentication failed") and record and "limited_until" not in limit:
        claude_accounts.mark_limited(name, reason=reason, model=model)
    if timed_out:
        return "request failed"
    if reason is None and returncode == 0 and answered:
        if record:
            claude_accounts.authenticated(name)
        return None
    return reason or "request failed"


def record_timeout(st, minutes):
    st["turn_stop"] = {"outcome": "budget_exhausted", "minutes": minutes}
    st.setdefault("turn_stops", []).append(dict(
        st["turn_stop"], turn=st.get("turns", 0), at=clock.CLOCK.time()))


def run(st, cfg, prompt, stopped, account, deadline=None):
    """Run one review angle; the caller owns review history and phase telemetry."""
    response = {"outcome": "unavailable", "result": None, "reason": None, "deadline": deadline,
                "telemetry": {"usage": {}, "cost_usd": None, "session_id": None,
                              "model": None, "reasoning_effort": None, "num_turns": None}}
    if stopped():
        response["outcome"] = task_state.stop_outcome(st, stopped)
        return response
    minutes = cfg["max_review_minutes"]
    if deadline is None:
        deadline = clock.CLOCK.monotonic() + minutes * config.MINUTE_SECONDS
    response["deadline"] = deadline
    if clock.CLOCK.monotonic() >= deadline:
        response["outcome"] = "budget_exhausted"
        record_timeout(st, minutes)
        return response
    executable = config.claude_binary()
    if executable is None:
        response["reason"] = "Claude CLI was not found"
        return response
    settings = cfg["claude"]
    before = worktree_snapshot(st)
    launched = False

    def started(proc):
        nonlocal launched
        launched = True
        st["codex_pid"] = proc.pid
        task_state.save(st)

    try:
        response = claude_runner.run_claude(
            account, st["worktree"], prompt, stopped, deadline,
            settings.get("model"), settings.get("effort"), settings["max_turns"],
            reviewing=True, started=started,
            task_dir=config.TASKS / st["slug"] if st.get("slug") else None)
        if response["outcome"] == "stopped":
            response["outcome"] = task_state.stop_outcome(st, stopped)
        elif response["outcome"] == "budget_exhausted":
            record_timeout(st, minutes)
    finally:
        if launched:
            st.pop("codex_pid", None)
            task_state.save(st)
    if launched and worktree_snapshot(st) != before:
        response.update(outcome="failed", result=None, reason="reviewer modified the worktree")
    return response
