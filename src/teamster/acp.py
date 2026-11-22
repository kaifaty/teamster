"""A synchronous, single-session Agent Client Protocol v1 client over stdio."""
import json
import os
from pathlib import Path
import select
import subprocess
import time

import teamster

from . import procs


def _model_config(result):
    options = result.get("configOptions")
    if isinstance(options, list):
        for item in options:
            if isinstance(item, dict) and item.get("id") == "model" and item.get("type") == "select":
                return item
    return {}


class AcpRequestError(ValueError):
    """A JSON-RPC failure with the provider's error code, message and data."""

    def __init__(self, detail, error):
        super().__init__(detail)
        self.code = error.get("code")
        self.message = error.get("message")
        self.data = error.get("data")


class AcpClient:
    """Run one agent, delivering session updates and permission requests to the caller.

    on_permission(params) returns one of the offered option IDs, or None to cancel.
    The harness owns model selection, credentials, tools and session storage.
    """

    def __init__(self, argv, cwd, on_update, on_permission, *, check_active=None, env=None,
                 on_notification=None, stderr=None):
        self.argv = argv
        self.cwd = str(Path(cwd).resolve())
        self.env = env
        self.stderr = stderr
        self.on_notification = on_notification
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
                                        stderr=self.stderr, start_new_session=True)
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
            procs.terminate(self.process)

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
                    detail = f"ACP {method} failed ({error.get('code')}): {error.get('message')}"
                    if error.get("code") == -32000:
                        detail += ". Sign in using the agent CLI"
                        if self.auth_methods:
                            detail += " or choose --auth-method from: " + ", ".join(self.auth_methods)
                    raise AcpRequestError(detail, error)
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

    def open_session(self, session_id=None, auth_method=None, model=None, *, meta=None, config_options=None):
        """Negotiate v1 and open a new session or load an existing session."""
        self.session_id = None
        info = self._call("initialize", {"protocolVersion": 1, "clientCapabilities": {},
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
        if config_options:
            params["configOptions"] = [{"configId": key, "value": value} for key, value in config_options.items()]
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
        if config_options:
            options = result.get("configOptions")
            if not isinstance(options, list):
                raise ValueError("ACP agent returned no session configuration")
            for key, value in config_options.items():
                selected = [item.get("currentValue") for item in options
                            if isinstance(item, dict) and item.get("id") == key]
                if selected != [value]:
                    raise ValueError(f"ACP agent did not confirm {key} {value!r}")
        if model is not None:
            choices = _model_config(result).get("options")
            if not isinstance(choices, list) or not any(
                isinstance(choice, dict) and choice.get("value") == model for choice in choices
            ):
                raise ValueError(f"ACP agent does not offer model {model!r} in this session")
            selection = {"sessionId": session_id, "configId": "model", "value": model}
            try:
                confirmed = self._call("session/set_config_option", selection, pending)
            except ValueError:
                raise ValueError(f"ACP agent could not select model {model!r}") from None
            if _model_config(confirmed).get("currentValue") != model:
                raise ValueError(f"ACP agent did not confirm model {model!r}")
        self.session_id = session_id
        for update in pending:
            if update.get("sessionId") == session_id:
                self.on_update(update["update"])
        return self.session_id

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
