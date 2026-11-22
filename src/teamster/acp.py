"""A synchronous, single-session Agent Client Protocol v1 client over stdio."""
import json
import os
from pathlib import Path
import select
import subprocess
import time

import teamster

from . import procs


def _select_config(result, config_id):
    options = result.get("configOptions")
    if isinstance(options, list):
        for item in options:
            if isinstance(item, dict) and item.get("id") == config_id and item.get("type") == "select":
                return item
    return {}


def _offers_value(option, value):
    for choice in option.get("options") or []:
        if not isinstance(choice, dict):
            continue
        if "group" in choice:
            if _offers_value(choice, value):
                return True
        elif choice.get("value") == value:
            return True
    return False


class AcpRequestError(ValueError):
    """A JSON-RPC failure with the provider's error code, message and data."""

    def __init__(self, method, error, auth_methods):
        self.code = error.get("code")
        self.data = error.get("data")
        self.provider_message = error.get("message")
        detail = f"ACP {method} failed ({self.code}): {self.provider_message}"
        if isinstance(self.data, dict) and isinstance(self.data.get("message"), str):
            self.provider_message = self.data["message"]
            detail += f": {self.provider_message}"
        if self.code == -32000:
            detail += ". Sign in using the agent CLI"
            if auth_methods:
                detail += " or choose --auth-method from: " + ", ".join(auth_methods)
        super().__init__(detail)


class AcpClient:
    """Run one agent, delivering session updates and permission requests to the caller.

    on_permission(params) returns one of the offered option IDs, or None to cancel.
    The harness owns model selection, credentials, tools and session storage.
    """

    def __init__(self, argv, cwd, on_update, on_permission, *, check_active=None, env=None,
                 on_notification=None, stderr=None, own_group=True):
        self.argv = argv
        self.cwd = str(Path(cwd).resolve())
        self.env = env
        self.stderr = stderr
        self.on_notification = on_notification
        self.own_group = own_group
        self.on_update = on_update
        self.on_permission = on_permission
        self.check_active = check_active
        self.session_id = None
        self.process = None
        self.request_id = 0
        self.buffer = bytearray()
        self.auth_methods = []

    def __enter__(self):
        env = self.env if self.env is not None else {**os.environ, "PWD": self.cwd}
        self.process = subprocess.Popen(self.argv, cwd=self.cwd, env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr, start_new_session=self.own_group)
        if self.check_active:
            os.set_blocking(self.process.stdin.fileno(), False)
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            try:
                self.process.stdin.close()
            except BrokenPipeError:
                pass
            if self.check_active and exc_type is None:
                # The worker needs the agent's own exit status, even if shutdown is slow.
                while self.process.poll() is None:
                    self.check_active()
                    try:
                        self.process.wait(timeout=0.2)
                    except subprocess.TimeoutExpired:
                        pass
            else:
                try:
                    self.process.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            self.process.stdout.close()
            # The leader may have exited with tool processes still in its group.
            if self.own_group:
                procs.terminate(self.process)
            elif self.process.poll() is None:
                self.process.kill()
                self.process.wait()

    def _send(self, **message):
        line = (json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False) + "\n").encode()
        if self.check_active:
            # A large prompt may fill the pipe while the agent is unresponsive.
            pending = memoryview(line)
            while pending:
                self.check_active()
                if select.select([], [self.process.stdin], [], 0.2)[1]:
                    pending = pending[os.write(self.process.stdin.fileno(), pending):]
        else:
            self.process.stdin.write(line)
            self.process.stdin.flush()

    def _read(self, deadline):
        while True:
            if self.check_active:
                self.check_active()
            if deadline is not None and time.monotonic() >= deadline:
                raise ValueError("ACP agent did not finish the cancelled turn")
            newline = self.buffer.find(b"\n")
            if newline >= 0:
                line = self.buffer[:newline]
                del self.buffer[:newline + 1]
                message = json.loads(line)
                if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                    raise ValueError("Invalid ACP JSON-RPC message")
                return message
            if select.select([self.process.stdout], [], [], 0.25)[0]:
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise ValueError("ACP agent closed stdout before returning a result")
                self.buffer.extend(chunk)
            elif self.process.poll() is not None:
                raise ValueError(f"ACP agent exited with status {self.process.returncode}")

    def _permission(self, message, active_turn):
        params = message.get("params", {})
        outcome = {"outcome": "cancelled"}
        try:
            if active_turn and params.get("sessionId") == self.session_id:
                options = {option["optionId"] for option in params["options"]}
                choice = self.on_permission(params)
                if choice is not None and choice in options:
                    outcome = {"outcome": "selected", "optionId": choice}
        finally:
            # Even Ctrl-C at a permission prompt must settle the agent's request.
            self._send(id=message["id"], result={"outcome": outcome})

    def _dispatch(self, message, session_id, active_turn, pending_updates):
        method = message["method"]
        if "id" in message:
            if method == "session/request_permission":
                self._permission(message, active_turn)
            else:
                self._send(id=message["id"], error={"code": -32601, "message": "Method not found"})
        elif method == "session/update":
            params = message.get("params")
            if not isinstance(params, dict) or not isinstance(params.get("update"), dict):
                raise ValueError("Invalid ACP session update")
            if pending_updates is not None:
                pending_updates.append(params)
            elif session_id is not None and params.get("sessionId") == session_id:
                self.on_update(params["update"])
        elif self.on_notification and session_id is not None and session_id == self.session_id:
            params = message.get("params")
            if isinstance(params, dict) and params.get("sessionId") == session_id:
                self.on_notification(method, params)

    def _call(self, method, params, pending_updates=None):
        self.request_id += 1
        self._send(id=self.request_id, method=method, params=params)
        deadline = None
        while True:
            try:
                message = self._read(deadline)
                if "method" in message:
                    active_turn = method == "session/prompt" and deadline is None
                    self._dispatch(message, params.get("sessionId"), active_turn, pending_updates)
                    continue
                if message.get("id") != self.request_id:
                    raise ValueError(f"Unexpected ACP response ID while waiting for {method}")
                if "error" in message:
                    error = message["error"]
                    if not isinstance(error, dict):
                        raise ValueError(f"Invalid ACP {method} error")
                    raise AcpRequestError(method, error, self.auth_methods)
                result = message.get("result")
                if not isinstance(result, dict):
                    raise ValueError(f"Invalid ACP {method} result")
                return result
            except (TimeoutError, InterruptedError):
                if method == "session/prompt" and self.check_active:
                    # The full prompt was sent. Make one nonblocking cancellation
                    # attempt before the caller closes stdin and reaps the agent.
                    cancel = {"jsonrpc": "2.0", "method": "session/cancel",
                              "params": {"sessionId": self.session_id}}
                    try:
                        os.write(self.process.stdin.fileno(), (json.dumps(cancel) + "\n").encode())
                    except OSError:
                        pass
                raise
            except KeyboardInterrupt:
                if method != "session/prompt" or deadline is not None:
                    raise
                self.cancel()
                deadline = time.monotonic() + 3

    def open_session(self, session_id=None, auth_method=None, model=None, *, meta=None, initial_config=None,
                     config_options=None, capabilities=None):
        """Open an ACP v1 session and confirm the requested initial and subsequent selections."""
        self.session_id = None
        info = self._call("initialize", {"protocolVersion": 1, "clientCapabilities": capabilities or {},
                                         "clientInfo": {"name": "teamster", "version": teamster.__version__}})
        if info.get("protocolVersion") != 1:
            raise ValueError(f"Unsupported ACP protocol version: {info.get('protocolVersion')}")
        self.auth_methods = [method["id"] for method in info.get("authMethods", [])
                             if method.get("type", "agent") == "agent"]
        if auth_method is not None:
            if auth_method not in self.auth_methods:
                available = ", ".join(self.auth_methods) or "none"
                raise ValueError(f"Unsupported ACP auth method {auth_method!r}. Available: {available}")
            self._call("authenticate", {"methodId": auth_method})
        params = {"cwd": self.cwd, "mcpServers": []}
        if meta is not None:
            params["_meta"] = meta
        if initial_config:
            params["configOptions"] = [{"configId": key, "value": value} for key, value in initial_config.items()]
        pending = []
        if session_id is not None:
            capabilities = info.get("agentCapabilities", {})
            if capabilities.get("sessionCapabilities", {}).get("resume") is not None:
                method = "session/resume"
            elif capabilities.get("loadSession"):
                method = "session/load"
            else:
                raise ValueError("ACP agent does not support loading or resuming sessions")
            result = self._call(method, {**params, "sessionId": session_id})
            if result.get("sessionId", session_id) != session_id:
                raise ValueError("ACP agent returned a different session ID on resume")
        else:
            result = self._call("session/new", params, pending)
            session_id = result.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                raise ValueError("ACP agent returned no session ID")
        selections = {"model": model} if model is not None else {}
        selections.update(config_options or {})
        for key, value in selections.items():
            if not _offers_value(_select_config(result, key), value):
                raise ValueError(f"ACP agent does not offer {key} {value!r} in this session")
            selection = {"sessionId": session_id, "configId": key, "value": value}
            result = self._call("session/set_config_option", selection, pending)
        # Selecting one option can change another, for example a model's default effort.
        for key, value in {**(initial_config or {}), **selections}.items():
            selected = [option.get("currentValue") for option in result.get("configOptions") or []
                        if isinstance(option, dict) and option.get("id") == key]
            if selected != [value]:
                raise ValueError(f"ACP agent did not confirm {key} {value!r}")
        self.session_id = session_id
        for update in pending:
            if update.get("sessionId") == session_id:
                self.on_update(update["update"])
        return self.session_id

    def set_title(self, title):
        self._call("session/set_title", {"sessionId": self.session_id, "title": title})

    def cancel(self):
        """Ask the agent to interrupt its prompt while continuing to receive final usage."""
        self._send(method="session/cancel", params={"sessionId": self.session_id})

    def prompt_result(self, text):
        """Run one text turn and return its full ACP result, including extension metadata."""
        if self.session_id is None:
            raise ValueError("Open an ACP session before sending a prompt")
        result = self._call("session/prompt", {"sessionId": self.session_id,
                                              "prompt": [{"type": "text", "text": text}]})
        reason = result.get("stopReason")
        if not isinstance(reason, str) or not reason:
            raise ValueError("ACP agent returned no stop reason")
        return result

    def prompt(self, text):
        """Run one text turn and return its stop reason, including cancellation."""
        return self.prompt_result(text)["stopReason"]
