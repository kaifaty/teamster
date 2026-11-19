"""Account login, terminal event transport, and Claude account management."""
import codecs
import errno
import fcntl
import json
import os
import pty
import re
import selectors
import signal
import struct
import subprocess
import sys
import termios
import time
import unicodedata
from contextlib import contextmanager
from pathlib import Path

from . import accounts, claude_accounts, claude_review, claude_runner, config, credit_resets, procs, telemetry_log, terminal_screen


def codex_status(info, cfg):
    """The machine-readable status of one Codex account snapshot; None when unknown."""
    if info.get("duplicate"):
        return "duplicate"
    if info["logged_in"] is None:
        return None
    if not info["logged_in"]:
        return "not_logged_in"
    return "exhausted" if accounts.exhausted(info, cfg) else "available"


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
    binary = config.codex_binary()
    with config.home_lock(exclusive=True):
        cfg = config.accounts_config()
        account = next((i for i in cfg["accounts"] if i["name"] == a.name), None)
        if account is None:
            account = {"name": a.name, "home": str(config.CODEX_HOME.parent / ".codex-accounts" / a.name)}
            cfg["accounts"].append(account)
        cfg.pop("enabled", None)
        path = config.data_path("settings")
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
        tmp.replace(path)
    accounts.prepare_home(account)
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
def _locked_account_pool(family):
    path = config.data_path("settings")
    with config.home_lock(exclusive=True):
        source = config.settings_path()
        settings = json.loads(source.read_text(encoding="utf-8")) if source.exists() else {}
        cfg = config.accounts_config()
        if family == "claude":
            pool = settings.setdefault("claude", {}).setdefault("accounts", cfg["claude"]["accounts"])
        else:
            pool = settings.setdefault("accounts", cfg["accounts"])
        yield pool
        temporary = path.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)


def cmd_claude_rename(a):
    if not re.fullmatch(r"[a-z0-9-]+", a.new):
        procs.die("Claude account name must contain only a-z, 0-9 and '-'")
    with _locked_account_pool("claude") as pool:
        account = next((item for item in pool if item["name"] == a.old), None)
        if account is None:
            procs.die(f"Claude account {a.old!r} does not exist")
        if any(item["name"] == a.new for item in pool):
            procs.die(f"Claude account {a.new!r} already exists")
        account["name"] = a.new
        claude_accounts.rename_limits(a.old, a.new)
    print(f"Claude account {a.old} renamed to {a.new}")


def cmd_account_remove(a):
    family = "claude" if a.cmd == "claude-remove" else "codex"
    with _locked_account_pool(family) as pool:
        account = next((item for item in pool if item["name"] == a.name), None)
        if account is None:
            procs.die(f"{family.capitalize()} account {a.name!r} does not exist")
        if len(pool) == 1:
            if family == "claude":
                procs.die("Cannot remove the last Claude account; switch reviewer to codex")
            procs.die("Cannot remove the last Codex account")
        pool.remove(account)
        if family == "claude":
            claude_accounts.clear_limits(a.name)
    print(f"{family.capitalize()} account {a.name} removed")
    if family == "claude":
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
    with _locked_account_pool("claude") as pool:
        current = next((item for item in pool if item["name"] == a.name), None)
        if current is None:
            if previous is not None:
                procs.die(f"Claude account {a.name!r} was removed from the settings during the sign-in")
            pool.append(account)
        else:
            current.update(account)
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
