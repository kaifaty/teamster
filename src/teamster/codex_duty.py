"""One guarded duty turn over the Codex 0.169.0 app-server protocol.

Only command and patch approvals authorize effects. Plain accept is never a
session grant; the shared duty guard remains the boundary on sandbox retries.
"""
import ctypes
import json
import os
import re
import selectors
import shlex
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

from . import accounts, clock, config, procs, result_schema


# Verified against rust-v0.169.0 tools/spec_plan.rs and extension contributors.
# Model metadata can select Code Mode despite these flags. Use a direct-tool
# model by default; enabling the host would also expose unapproved process input.
DUTY_CODEX_DISABLED = (
    "hooks", "plugin_hooks", "plugins", "apps", "enable_mcp_apps", "recommended_plugins", "view_image",
    "multi_agent", "multi_agent_v2", "multi_agent_v2_dynamic_tools", "agent_message_board",
    "agent_message_board_mcp", "memories", "external_agent_memory_import", "goals", "artifact",
    "multi_env_copy_file", "request_permissions_tool", "exec_permission_approvals",
    "image_generation", "image_generation_animation", "browser_use", "browser_use_external",
    "in_app_browser", "computer_use", "skill_mcp_dependency_install", "skill_env_var_dependency_prompt",
    "shell_snapshot", "shell_snapshot_v2", "login_shell_package_path", "deferred_executor",
    "code_mode", "code_mode_only", "code_mode_host", "code_mode_prewarm", "token_budget",
)


def codex_duty_overrides(marker, room):
    """Invocation-only overrides; never edit the account's configuration."""
    values = {"features." + key: False for key in DUTY_CODEX_DISABLED}
    values.update({
        "features.skip_host_skill_discovery": True,
        "agents.enabled": False, "cloud.skills.enabled": False,
        "skills.bundled.enabled": False,
        "cli_auth_credentials_store": "ephemeral", "project_root_markers": [], "project_doc_max_bytes": 0,
        "projects": {str(Path(room).resolve()): {"trust_level": "untrusted"}},
        "orchestrator.mcp.enabled": False,
        "web_search": "disabled", "notify": [], "allow_login_shell": False,
        "approval_policy": "on-request", "approvals_reviewer": "user",
        "sandbox_mode": "workspace-write", "sandbox_workspace_write.writable_roots": [],
        "sandbox_workspace_write.exclude_tmpdir_env_var": True,
        "sandbox_workspace_write.exclude_slash_tmp": True,
        "sandbox_workspace_write.network_access": True,
        "shell_environment_policy.exclude": ["CODEX_SQLITE_HOME"],
        "shell_environment_policy.set." + config.STARTED_BY: "duty",
        "shell_environment_policy.set." + config.DUTY_PROCESS_MARKER: marker,
        "shell_environment_policy.set.TEAMSTER_HOME": str(config.DATA_HOME) if config.LAYOUT == "new" else "",
        "shell_environment_policy.set.CODEX_TASK_HOME": str(config.CODEX_HOME),
        "shell_environment_policy.set.TEAMSTER_CODEX_HOME": str(config.CODEX_HOME),
        "shell_environment_policy.set.BASH_ENV": "/dev/null",
        "shell_environment_policy.set.ENV": "/dev/null",
        "shell_environment_policy.set.ZDOTDIR": str(config.PACKAGE),
        "shell_environment_policy.set.GIT_TERMINAL_PROMPT": "0",
        "shell_environment_policy.set.GH_PROMPT_DISABLED": "1",
        "shell_environment_policy.set.HOME": os.environ["HOME"],
        "shell_environment_policy.experimental_use_profile": False,
    })
    return values


def duty_process_environment(pid):
    """Read actual environment entries, never flattened argv that could spoof ownership."""
    try:
        if sys.platform == "darwin":
            library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
            mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2, pid.
            size = ctypes.c_size_t()
            if library.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
                return []
            buffer = ctypes.create_string_buffer(size.value)
            if library.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
                return []
            data = buffer.raw[:size.value]
            argc = int.from_bytes(data[:4], sys.byteorder)
            position = data.index(b"\0", 4)
            while position < len(data) and data[position] == 0:
                position += 1
            for _ in range(argc):
                position = data.index(b"\0", position) + 1
            return data[position:].split(b"\0")
        return (Path("/proc") / str(pid) / "environ").read_bytes().split(b"\0")
    except (OSError, ValueError):
        return []


def duty_process_marker(pid):
    prefix = (config.DUTY_PROCESS_MARKER + "=").encode()
    return next((entry[len(prefix):].decode("ascii") for entry in duty_process_environment(pid)
                 if entry.startswith(prefix) and re.fullmatch(b"[0-9a-f]{32}", entry[len(prefix):])), None)


def end_duty_terminals(marker):
    """End this invocation's commands even after app-server dies; never log environments.

    Terminal children create new sessions. Supervisors of tasks started by the
    duty remove this marker, so those independently managed tasks are preserved.
    """
    if not marker:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        snapshot = subprocess.run(["ps", "-U", str(os.getuid()), "-o", "pid=,pgid="],
                                  capture_output=True, text=True, check=True)
        for line in snapshot.stdout.splitlines():
            fields = line.split()
            if len(fields) != 2:
                continue
            pid, group = map(int, fields)
            if group not in (0, 1, os.getpgrp()) and duty_process_marker(pid) == marker:
                procs.signal_pgid(group, sig)
        time.sleep(0.05)


def duty_guard_reason(room, event):
    """Reuse duty_denial/inside_room through the standalone guard's JSON interface."""
    try:
        checked = subprocess.run(
            [sys.executable, "-I", str(config.BASH_GUARD), "--duty-room", str(room)],
            input=json.dumps(event), text=True, capture_output=True, timeout=config.ACCOUNT_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return "Blocked by teamster: duty guard could not decide the request"
    if checked.returncode == 0:
        return ""
    return checked.stderr.strip() or "Blocked by teamster: duty guard failed closed"


def duty_command_text(command):
    """Unwrap only the protocol's literal shell argv, retaining the exact script."""
    if not isinstance(command, str) or not command:
        return None
    try:
        words = shlex.split(command)
    except ValueError:
        return None
    if words and words[0] in ("/bin/bash", "/bin/sh", "/bin/zsh"):
        if len(words) == 3 and words[1] in ("-c", "-lc"):
            return words[2]
        return None
    return command


def approval(method, params, items, room, thread, turn):
    """One decision per request, with no cached or persistent grants."""
    refusal = "Blocked by teamster: unreadable or unknown duty approval request"
    if (not thread or not turn or not isinstance(params, dict) or params.get("threadId") != thread
            or params.get("turnId") != turn or not isinstance(params.get("itemId"), str) or not params["itemId"]):
        return "decline", refusal
    if method == "item/commandExecution/requestApproval":
        if (params.get("kind", "command") != "command" or params.get("networkApprovalContext")
                or params.get("additionalPermissions") or params.get("approvalId")
                or params.get("environmentId") not in (None, "local") or params.get("pluginId")):
            return "decline", refusal
        item = items.get(params["itemId"])
        if item is not None and (not isinstance(item, dict) or item.get("type") != "commandExecution"
                                 or item.get("pluginId") or item.get("scriptPath")):
            return "decline", refusal
        command = duty_command_text(params.get("command"))
        cwd = params.get("cwd")
        if command is None or not isinstance(cwd, str) or not Path(cwd).is_absolute():
            return "decline", refusal
        reason = duty_guard_reason(room, {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd,
                                          "duty_transport": "codex"})
    elif method == "item/fileChange/requestApproval":
        item = items.get(params["itemId"])
        if (params.get("grantRoot") or not isinstance(item, dict) or item.get("type") != "fileChange"
                or item.get("id") != params["itemId"] or not isinstance(item.get("changes"), list)
                or not item["changes"]):
            return "decline", refusal
        for change in item["changes"]:
            if not isinstance(change, dict) or not isinstance(change.get("kind"), dict):
                return "decline", refusal
            kind = change["kind"]
            if kind.get("type") not in ("add", "delete", "update"):
                return "decline", refusal
            paths = [change.get("path")]
            if kind.get("move_path") is not None:
                paths.append(kind["move_path"])
            for path in paths:
                if not isinstance(path, str) or not path:
                    return "decline", refusal
                reason = duty_guard_reason(room, {"tool_name": "Write", "tool_input": {"file_path": path},
                                                  "cwd": str(room)})
                if reason:
                    return "decline", reason
        reason = ""
    else:
        return "decline", refusal
    return ("decline", reason) if reason else ("accept", "")


def codex_duty_credentials(account):
    """Read the current access token; never refresh or write account credentials."""
    path = Path(account["home"]) / "auth.json"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        tokens = document["tokens"]
        token, identity = tokens["access_token"], tokens["account_id"]
        if not all(isinstance(value, str) and value for value in (token, identity)):
            raise ValueError("missing token or account id")
        if document.get("auth_mode") not in (None, "chatgpt"):
            raise ValueError("unsupported authentication mode")
    except (OSError, ValueError, TypeError, KeyError):
        # Parser errors can contain secrets. Keyring-only accounts cannot be
        # bridged without inheriting the account's credential-store configuration.
        raise ValueError("Codex duty needs readable ChatGPT authentication in " + str(path)) from None
    return {"accessToken": token, "chatgptAccountId": identity, "chatgptPlanType": None}


def codex_duty_preflight(home, room, effective, requirements, overrides):
    """Refuse inherited authority that cannot be disabled for this invocation."""
    if not isinstance(effective, dict) or not isinstance(effective.get("config"), dict):
        raise ValueError("cannot inspect the Codex duty configuration")
    if not isinstance(requirements, dict) or requirements.get("requirements", {}) is not None:
        # The public requirements response omits exec-policy rules. A managed
        # policy object therefore cannot establish the absence of allow rules.
        raise ValueError("Codex duty cannot isolate managed approval rules in configRequirements/read.requirements")
    values = effective["config"]
    layers = effective.get("layers")
    if not isinstance(layers, list):
        raise ValueError("cannot inspect Codex duty configuration layers")
    folders = {Path(home), Path("/etc/codex")}
    skills = {Path(home) / "skills", Path(home) / ".agents" / "skills",
              Path(room) / ".agents" / "skills", Path(room) / ".codex" / "skills"}
    for layer in layers:
        if not isinstance(layer, dict) or not isinstance(layer.get("name"), dict):
            raise ValueError("cannot inspect a Codex duty configuration layer")
        source = layer["name"]
        kind = source.get("type")
        settings = layer.get("config")
        if not isinstance(settings, dict):
            raise ValueError("cannot inspect Codex duty config/read.layers.config")
        if kind in ("system", "user", "project"):
            path = source.get("dotCodexFolder" if kind == "project" else "file")
            if not isinstance(path, str) or not Path(path).is_absolute():
                raise ValueError("cannot inspect a Codex duty configuration layer path")
            folder = Path(path) if kind == "project" else Path(path).parent
            # Host skill roots include disabled project layers in this version.
            skills.add(folder / "skills")
            if layer.get("disabledReason"):
                continue
            if (settings or kind == "project"
                    or kind == "user" and Path(path) != Path(home) / "config.toml"):
                raise ValueError("Codex duty cannot isolate " + kind + " configuration at " + path)
            folders.add(folder)
        elif kind not in ("packagedDefaults", "sessionFlags"):
            raise ValueError("Codex duty cannot isolate config/read.layers source " + str(kind))
        if settings.get("hooks"):
            raise ValueError("Codex duty cannot isolate hooks in config/read.layers.config.hooks")
    for key in ("mcp_servers", "hooks"):
        if values.get(key):
            raise ValueError("Codex duty cannot isolate config/read.config." + key)
    environment = values.get("shell_environment_policy") or {}
    if not isinstance(environment, dict) or environment.get("include_only") or environment.get("filters"):
        raise ValueError("Codex duty cannot isolate config/read.config.shell_environment_policy filters")
    for folder in sorted(folders):
        hooks = folder / "hooks.json"
        try:
            hooks.lstat()
        except FileNotFoundError:
            pass
        else:
            raise ValueError("Codex duty cannot isolate hooks at " + str(hooks))
        rules = folder / "rules"
        try:
            has_rules = any(path.suffix == ".rules" for path in rules.iterdir())
        except FileNotFoundError:
            has_rules = False
        if has_rules:
            raise ValueError("Codex duty cannot isolate approval rules at " + str(rules))
        skills.add(folder / "skills")
    for path in sorted(skills):
        if os.path.lexists(path):
            raise ValueError("Codex duty cannot isolate skills at " + str(path))
    # config/read includes flattened additional configuration. Check every
    # invocation override before creating a thread (and before SessionStart).
    for key, expected in overrides.items():
        current = values
        for part in key.split("."):
            current = current.get(part) if isinstance(current, dict) else None
        if current != expected:
            raise ValueError("Codex duty could not enforce " + key)


class DutyRPC:
    """Line-delimited app-server RPC with cancellation and one active turn."""

    def __init__(self, process, room, stopped, deadline, directory, account):
        self.process, self.room, self.stopped, self.deadline = process, room, stopped, deadline
        self.directory = directory
        self.selector = selectors.DefaultSelector()
        self.selector.register(process.stdout, selectors.EVENT_READ)
        self.buffer = b""
        self.serial = 0
        self.replies = {}
        self.thread, self.turn = "", ""
        self.items = {}
        self.finished = None
        self.answer = ""
        self.account = account
        self.credentials = None

    def send(self, message):
        self.process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode())
        self.process.stdin.flush()

    def check(self):
        if self.stopped():
            raise InterruptedError("stopped")
        if clock.CLOCK.monotonic() >= self.deadline:
            raise TimeoutError("duty time budget exhausted")

    def call(self, method, params):
        self.check()
        self.serial += 1
        request_id = self.serial
        self.send({"id": request_id, "method": method, "params": params})
        while request_id not in self.replies:
            self.read()
        reply = self.replies.pop(request_id)
        if "error" in reply:
            if method == "account/login/start":
                raise ValueError("Codex duty authentication failed for " + str(Path(self.account["home"]) / "auth.json"))
            if (method == "thread/resume" and isinstance(reply["error"], dict)
                    and reply["error"].get("message") == "no rollout found for thread id " + params["threadId"]):
                raise ValueError(reply["error"]["message"])
            raise ValueError("Codex duty " + method + " failed: " + str(reply["error"]))
        return reply.get("result")

    def refresh_credentials(self, message):
        """Borrow an owner's replacement access token, without an OAuth exchange."""
        path = Path(self.account["home"]) / "auth.json"
        try:
            params = message.get("params")
            if (self.finished is not None or not self.credentials or not isinstance(params, dict)
                    or params.get("reason") != "unauthorized"
                    or params.get("previousAccountId") not in (None, self.credentials["chatgptAccountId"])):
                raise ValueError("Codex duty cannot refresh authentication for " + str(path))
            credentials = codex_duty_credentials(self.account)
            if credentials["chatgptAccountId"] != self.credentials["chatgptAccountId"]:
                raise ValueError("Codex duty authentication account changed in " + str(path))
            if credentials["accessToken"] == self.credentials["accessToken"]:
                raise ValueError("Codex duty needs the account owner to refresh authentication in " + str(path))
        except ValueError as exc:
            self.send({"id": message["id"], "error": {"code": -32000, "message": str(exc)}})
            raise
        self.credentials = credentials
        self.send({"id": message["id"], "result": credentials})

    def event(self, value):
        with (self.directory / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(value, ensure_ascii=False) + "\n")

    def read(self):
        self.check()
        if b"\n" not in self.buffer:
            if not self.selector.select(0.2):
                if self.process.poll() is not None:
                    raise ValueError("Codex duty app-server exited before completing its turn")
                return
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise ValueError("Codex duty app-server closed stdout")
            self.buffer += chunk
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            try:
                message = json.loads(line)
            except (ValueError, UnicodeError):
                raise ValueError("unreadable Codex duty app-server message")
            if not isinstance(message, dict):
                raise ValueError("unreadable Codex duty app-server message")
            if "method" in message and "id" in message:
                self.check()
                if message["method"] == "account/chatgptAuthTokens/refresh":
                    self.refresh_credentials(message)
                    continue
                if self.finished is None:
                    decision, reason = approval(message["method"], message.get("params"), self.items,
                                                self.room, self.thread, self.turn)
                else:
                    decision, reason = "decline", "Blocked by teamster: the duty turn has ended"
                self.check()
                self.send({"id": message["id"], "result": {"decision": decision}})
                self.event({"type": "duty.approval", "method": message["method"],
                            "decision": decision, "reason": reason})
                if reason and self.thread and self.turn:
                    # The approval enum has no reason field. Steer supplies the
                    # guard's explanation as context without granting anything.
                    self.serial += 1
                    self.send({"id": self.serial, "method": "turn/steer", "params": {
                        "threadId": self.thread, "expectedTurnId": self.turn,
                        "input": [{"type": "text", "text": reason}]}})
            elif "id" in message:
                self.replies[message["id"]] = message
            else:
                self.notification(message.get("method"), message.get("params"))

    def notification(self, method, params):
        if not isinstance(params, dict) or params.get("threadId") != self.thread:
            return
        if method == "turn/started":
            self.turn = (params.get("turn") or {}).get("id") or self.turn
        if params.get("turnId", self.turn) != self.turn:
            return
        if method in ("item/started", "item/completed"):
            item = params.get("item")
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                return
            self.items[item["id"]] = item
            kind = item.get("type")
            if kind == "agentMessage" and method == "item/completed":
                self.answer = item.get("text", "")
                self.event({"type": "item.completed", "item": {"type": "agent_message", "text": self.answer}})
            elif kind == "commandExecution":
                self.event({"type": method.replace("/", "."), "item": {
                    "id": item["id"], "type": "command_execution", "command": item.get("command", ""),
                    "aggregated_output": item.get("aggregatedOutput", ""),
                    "exit_code": item.get("exitCode"), "status": item.get("status")}})
            elif kind == "fileChange":
                self.event({"type": method.replace("/", "."), "item": {
                    "id": item["id"], "type": "file_change", "changes": item.get("changes", [])}})
            elif kind not in ("userMessage", "reasoning", "plan", "contextCompaction", "agentMessage", "sleep"):
                raise ValueError("Codex duty exposed an unexpected tool: " + str(kind))
        elif method == "item/fileChange/patchUpdated":
            item = self.items.get(params.get("itemId"))
            if item is not None and item.get("type") == "fileChange":
                item["changes"] = params.get("changes")
        elif method == "turn/completed":
            self.finished = params.get("turn")


def run_codex_duty(account, room, prompt, stopped, deadline, model, effort, *, thread_id=None,
                   system_text="", started=None, progress=None, task_dir=None, max_minutes=None):
    """Run and validate one turn, ending its entire process group on every exit."""
    directory = Path(task_dir)
    response = {"outcome": "failed", "result": None, "reason": None,
                "telemetry": {"thread": thread_id, "model": model, "reasoning_effort": effort}}
    process, rpc = None, None
    try:
        if stopped():
            raise InterruptedError("stopped")
        if clock.CLOCK.monotonic() >= deadline:
            raise TimeoutError("duty time budget exhausted")
        marker = uuid.uuid4().hex
        home = directory / "codex-home"
        if home.is_symlink():
            raise ValueError("Codex duty cannot isolate a symbolic-link home at " + str(home))
        home.mkdir(mode=0o700, exist_ok=True)
        home.chmod(0o700)
        home = home.resolve()
        if os.path.lexists(home / ".env"):
            raise ValueError("Codex duty cannot isolate environment configuration at " + str(home / ".env"))
        overrides = codex_duty_overrides(marker, room)
        args = [config.codex_binary(), "app-server", "--strict-config"]
        for key, value in overrides.items():
            # This table needs TOML's key/value separator, unlike scalar JSON literals.
            encoded = ("{" + json.dumps(str(Path(room).resolve())) + ' = {trust_level = "untrusted"}}'
                       if key == "projects" else json.dumps(value))
            args += ["-c", key + "=" + encoded]
        environment = accounts.account_env(dict(account, home=str(home)))
        for key in list(environment):
            if (key.startswith(("OPENAI_", "CODEX_EXEC_SERVER_", "CODEX_APP_SERVER_"))
                    or key in ("CODEX_API_KEY", "CODEX_ACCESS_TOKEN")):
                environment.pop(key)
        environment.update(HOME=str(home), CODEX_SQLITE_HOME=str(home))
        environment[config.STARTED_BY] = "duty"
        environment[config.DUTY_PROCESS_MARKER] = marker
        process = subprocess.Popen(args, cwd=room, env=environment, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        if started is not None:
            started(process)
        if duty_process_marker(process.pid) != marker:
            raise ValueError("Codex duty cannot identify its command processes on this platform")
        rpc = DutyRPC(process, room, stopped, deadline, directory, account)
        initialized = rpc.call("initialize", {"clientInfo": {"name": "teamster-duty", "version": "1"},
                                              "capabilities": {"experimentalApi": True}})
        if not isinstance(initialized, dict) or not re.search(r"\b0\.169\.0\b", initialized.get("userAgent", "")):
            raise ValueError("Codex duty requires the verified app-server protocol 0.169.0")
        rpc.send({"method": "initialized"})
        effective = rpc.call("config/read", {"includeLayers": True, "cwd": str(room)})
        requirements = rpc.call("configRequirements/read", {})
        codex_duty_preflight(home, room, effective, requirements, overrides)
        rpc.credentials = codex_duty_credentials(account)
        rpc.call("account/login/start", dict(rpc.credentials, type="chatgptAuthTokens"))
        # Signing in can load cloud-managed configuration. Inspect again before
        # thread startup, where hooks and tools can begin acting.
        effective = rpc.call("config/read", {"includeLayers": True, "cwd": str(room)})
        requirements = rpc.call("configRequirements/read", {})
        codex_duty_preflight(home, room, effective, requirements, overrides)
        params = {"cwd": str(room), "approvalPolicy": "untrusted", "approvalsReviewer": "user",
                  "model": model or "gpt-5.5",
                  "sandbox": "workspace-write", "developerInstructions": system_text,
                  "environments": [],
                  "config": {"model_reasoning_effort": effort} if effort else {}}
        if thread_id:
            params["threadId"] = thread_id
        reply = rpc.call("thread/resume" if thread_id else "thread/start", params)
        if (not isinstance(reply, dict) or reply.get("approvalPolicy") != "untrusted"
                or reply.get("approvalsReviewer") != "user"):
            raise ValueError("Codex duty could not enforce client approvals")
        sandbox = reply.get("sandbox") or {}
        # Codex 0.169.0 reports the room-only sandbox, with /tmp and TMPDIR excluded, as readOnly: the
        # working directory is implied and never listed. A reply that names any other writable root is refused.
        if sandbox.get("type") not in ("readOnly", "workspaceWrite") or any(
                Path(path).resolve() != Path(room).resolve() for path in sandbox.get("writableRoots") or []):
            raise ValueError("Codex duty could not confine the initial sandbox to its room")
        rpc.thread = (reply.get("thread") or {}).get("id")
        if not isinstance(rpc.thread, str) or not rpc.thread:
            raise ValueError("Codex duty returned no thread id")
        response["telemetry"].update(thread=rpc.thread, model=reply.get("model") or model,
                                     reasoning_effort=reply.get("reasoningEffort") or effort)
        rpc.event({"type": "thread.started", "thread_id": rpc.thread})
        if progress is not None:
            progress(response["telemetry"])
        turn_params = {"threadId": rpc.thread, "input": [{"type": "text", "text": prompt}],
                       "environments": [], "outputSchema": result_schema.DUTY_SCHEMA}
        if effort:
            turn_params["effort"] = effort
        begun = rpc.call("turn/start", turn_params)
        rpc.turn = (begun.get("turn") or {}).get("id") or rpc.turn
        if not rpc.turn:
            raise ValueError("Codex duty returned no turn id")
        while rpc.finished is None:
            rpc.read()
        if rpc.finished.get("status") != "completed":
            error = rpc.finished.get("error") or {}
            raise ValueError("Codex duty turn failed: " + str(error.get("message") or rpc.finished.get("status")))
        try:
            result = json.loads(rpc.answer)
        except (ValueError, TypeError):
            raise ValueError("invalid JSON output")
        if not result_schema.valid_duty_result(result):
            raise ValueError("invalid structured output")
        response.update(outcome="completed", result=result)
    except InterruptedError:
        response["outcome"] = "stopped"
    except TimeoutError:
        response["outcome"] = "budget_exhausted"
    except (OSError, ValueError, TypeError, KeyError) as exc:
        response["reason"] = str(exc)
        if any(word in str(exc).lower() for word in ("usage limit", "rate limit", "authentication")):
            response["outcome"] = "unavailable"
    finally:
        if rpc is not None:
            if rpc.thread and process.poll() is None:
                try:
                    if rpc.turn:
                        rpc.send({"id": "interrupt", "method": "turn/interrupt",
                                  "params": {"threadId": rpc.thread, "turnId": rpc.turn}})
                    rpc.send({"id": "clean", "method": "thread/backgroundTerminals/clean",
                              "params": {"threadId": rpc.thread}})
                except OSError:
                    pass
            rpc.selector.close()
        if process is not None:
            # Codex terminals have their own process groups. EOF and SIGTERM
            # let app-server shutdown terminate_all_processes before fallback
            # signals end any remaining members of the server's own group.
            try:
                process.stdin.close()
            except OSError:
                pass
            if process.poll() is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
            try:
                process.wait(timeout=config.ACCOUNT_TIMEOUT)
            except subprocess.TimeoutExpired:
                pass
            procs.terminate(process)
            end_duty_terminals(marker)
            process.stdout.close()
    return response
