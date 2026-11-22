"""Teamster's private, single-turn ACP v1 agent over JSON-RPC stdio.

The supervisor fixes the room, account locator, system file, model, effort and
deadline at process launch. ACP accepts initialize, session/new or session/resume,
one text session/prompt, and session/cancel. The ACP ID is the native ID. Claude
reserves a UUID at new and confirms it at CLI init. Codex opens the thread during
new/resume. Only native confirmation advances the supervisor's saved cursor.

session/update carries text chunks, the validated JSON answer and cursor updates.
The prompt receipt names the schema-bound messageId and returns native telemetry in _meta.
JSON-RPC errors carry native failures and limit receipts in error.data. Codex
checks command details, move_path and grantRoot on the original app-server
request. Claude runs with dontAsk and its mandatory PreToolUse hook.
Closing stdin cancels native work even when the supervisor dies.
"""
import contextlib
import json
import os
from pathlib import Path
import queue
import signal
import sys
import threading
import uuid

from . import acp, claude_runner, clock, codex_duty, config, duty_chat, result_schema


DUTY_META = "teamster.dev/duty"


def duty_agent_command(account, system_file, deadline, model, effort, max_minutes):
    family = account["family"]
    # Only non-secret locators cross the launch boundary. Each native handler
    # reads its own credential inside the adapter immediately before login.
    keys = ("home",) if family == "codex" else ("name", "config_dir", "token_keychain")
    settings = {"family": family, "account": {key: str(account[key]) for key in keys},
                "system_file": str(system_file.resolve()), "deadline": deadline,
                "model": model, "effort": effort, "max_minutes": max_minutes}
    return [sys.executable, "-I", "-B", "-c", "import sys; sys.path.insert(0, sys.argv[1]); "
            "from teamster import duty_acp; duty_acp.serve_duty()", str(config.PACKAGE.resolve().parent),
            json.dumps(settings)]


def run_duty(account, room, prompt, stopped, deadline, model, effort, *, thread_id=None,
             system_text="", started=None, progress=None, task_dir=None, max_minutes=None):
    cursor = "thread" if account["family"] == "codex" else "session_id"
    messages = {}
    telemetry = {"model": model, "reasoning_effort": effort}
    response = {"outcome": "failed", "reason": None, "result": None, "telemetry": telemetry}

    def check_active():
        if stopped():
            raise InterruptedError("stopped")
        if clock.CLOCK.monotonic() >= deadline:
            raise TimeoutError("duty time budget exhausted")

    def update(event):
        meta = event.get("_meta", {}).get(DUTY_META, {})
        if event["sessionUpdate"] == "session_info_update" and "telemetry" in meta:
            if meta["telemetry"].get(cursor) != (client.session_id or thread_id):
                raise ValueError("Duty adapter confirmed a different session ID")
            telemetry.update(meta["telemetry"])
            if progress:
                progress(telemetry)
        elif event["sessionUpdate"] == "agent_message_chunk" and event.get("messageId"):
            messages.setdefault(event["messageId"], []).append(event["content"]["text"])

    marker = uuid.uuid4().hex
    system_file = duty_chat.write_system_prompt(system_text, task_dir)
    argv = duty_agent_command(account, system_file, deadline, model, effort, max_minutes)
    client = acp.AcpClient(argv, room, update, lambda params: None, check_active=check_active,
                           env={**os.environ, config.DUTY_PROCESS_MARKER: marker})
    try:
        check_active()
        with client:
            if started:
                started(client.process)
            session = client.open_session(thread_id)
            reply = client.prompt_result(prompt)
            if reply["stopReason"] == "cancelled":
                response.update(outcome="stopped", result=None)
            else:
                receipt = reply["_meta"][DUTY_META]
                result = json.loads("".join(messages[receipt["answerId"]]))
                if not result_schema.valid_duty_result(result):
                    raise ValueError("invalid structured output")
                final = receipt["telemetry"]
                if reply["stopReason"] != "end_turn" or telemetry.get(cursor) != session or final.get(cursor) != session:
                    raise ValueError("Duty adapter returned an unconfirmed answer")
                telemetry.update(final)
                response.update(outcome="completed", result=result)
        if client.process.returncode:
            raise ValueError(f"Duty adapter exited with status {client.process.returncode}")
    except InterruptedError:
        response.update(outcome="stopped", result=None)
    except TimeoutError:
        response.update(outcome="budget_exhausted", result=None)
    except acp.AcpRequestError as exc:
        data = exc.data if isinstance(exc.data, dict) else {}
        telemetry.update(data.get("telemetry", {}))
        response.update(outcome=data.get("outcome", "failed"), reason=exc.provider_message, result=None)
        if "limited_until" in data:
            response["limited_until"] = data["limited_until"]
    except (OSError, ValueError, KeyError) as exc:
        response.update(outcome="failed", reason=str(exc), result=None)
    finally:
        system_file.unlink(missing_ok=True)
        if client.process and client.process.returncode:
            # A killed adapter could not reap its separate native process groups.
            codex_duty.end_duty_terminals(marker)
    return response


class DutyAgent:
    def __init__(self, settings):
        self.settings = settings
        self.inbox = queue.Queue()
        self.disconnected = False
        self.cancelled = False
        self.session = None
        self.request_id = None

    def read_input(self):
        prompt_pending = False
        try:
            with os.fdopen(os.dup(sys.stdin.fileno()), "rb") as stream:
                for line in stream:
                    request = json.loads(line)
                    if request.get("jsonrpc") != "2.0":
                        break
                    method = request.get("method")
                    current = self.session and request.get("params", {}).get("sessionId") == self.session
                    if method == "session/cancel" and "id" not in request:
                        if current and prompt_pending:
                            self.cancelled = True
                    else:
                        if current and method == "session/prompt":
                            prompt_pending = True
                        self.inbox.put(request)
        except (OSError, ValueError, AttributeError):
            pass
        finally:
            self.disconnected = True

    def stop(self, signum, frame):
        self.disconnected = True

    def stopped(self):
        return self.disconnected or self.cancelled

    def receive(self, *methods):
        self.request_id = None
        while not self.disconnected:
            if clock.CLOCK.monotonic() >= self.settings["deadline"]:
                raise TimeoutError("duty time budget exhausted")
            try:
                request = self.inbox.get(timeout=0.2)
            except queue.Empty:
                continue
            self.request_id = request["id"]
            if request.get("method") in methods and isinstance(request.get("params"), dict):
                return request["method"], request["params"]
            self.send(error={"code": -32601, "message": "Unsupported duty method"})
        raise InterruptedError("stopped")

    def send(self, **fields):
        if "method" not in fields:
            fields["id"] = self.request_id
        print(json.dumps({"jsonrpc": "2.0", **fields}, ensure_ascii=False), flush=True)

    def update(self, kind, meta=None, **fields):
        update = {"sessionUpdate": kind, **fields}
        if meta:
            update["_meta"] = {DUTY_META: meta}
        self.send(method="session/update", params={"sessionId": self.session, "update": update})

    def text(self, value, message_id=None):
        fields = {"messageId": message_id} if message_id else {}
        self.update("agent_message_chunk", content={"type": "text", "text": value}, **fields)

    def run(self, system_file):
        settings = self.settings
        _, params = self.receive("initialize")
        if params.get("protocolVersion") != 1:
            raise ValueError("Duty requires ACP v1")
        self.send(result={"protocolVersion": 1, "authMethods": [],
                          "agentCapabilities": {"sessionCapabilities": {"resume": {}}}})
        method, params = self.receive("session/new", "session/resume")
        room = Path.cwd()
        resume = method == "session/resume"
        old_id = params.get("sessionId")
        if (params.get("cwd") != str(room) or params.get("mcpServers") != [] or
                resume and (not isinstance(old_id, str) or not old_id) or not resume and old_id is not None):
            raise ValueError("Invalid duty session parameters")
        with contextlib.ExitStack() as stack:
            if settings["family"] == "codex":
                rpc, telemetry = stack.enter_context(codex_duty.codex_duty_session(
                    settings["account"], room, self.stopped, settings["deadline"], settings["model"], settings["effort"],
                    old_id, system_file.read_text(encoding="utf-8"), system_file.parent,
                    os.environ[config.DUTY_PROCESS_MARKER]))
                self.session = rpc.thread
                self.update("session_info_update", {"telemetry": telemetry})
            elif settings["family"] == "claude":
                self.session = old_id if resume else str(uuid.uuid4())
            else:
                raise ValueError("Unsupported duty family")
            self.send(result={} if resume else {"sessionId": self.session})
            _, params = self.receive("session/prompt")
            blocks = params.get("prompt")
            if (params.get("sessionId") != self.session or not isinstance(blocks, list) or len(blocks) != 1
                    or not isinstance(blocks[0], dict) or blocks[0].get("type") != "text"
                    or not isinstance(blocks[0].get("text"), str)):
                raise ValueError("Duty requires one text prompt for the open session")
            prompt = blocks[0]["text"]
            if settings["family"] == "codex":
                answer_id = codex_duty.codex_duty_prompt(rpc, prompt, settings["effort"], self.text)
                response = {"outcome": "completed", "telemetry": telemetry}
            else:
                confirmed = False

                def progress(telemetry):
                    nonlocal confirmed
                    if telemetry.get("session_id"):
                        if telemetry["session_id"] != self.session:
                            raise ValueError("Claude duty returned a different session ID")
                        if not confirmed:
                            confirmed = True
                            self.update("session_info_update", {"telemetry": telemetry})

                response = claude_runner.run_guarded_claude(
                    settings["account"], room, prompt, self.stopped, settings["deadline"],
                    settings["model"], settings["effort"], session_id=self.session, resume=resume,
                    system_prompt=system_file, progress=progress, task_dir=system_file.parent,
                    max_minutes=settings["max_minutes"], on_text=self.text)
                if response["outcome"] == "completed" and not confirmed:
                    raise ValueError("Claude duty returned no confirmed session ID")
        if self.disconnected:
            return
        if self.cancelled or response["outcome"] == "stopped":
            self.send(result={"stopReason": "cancelled"})
        elif response["outcome"] == "completed":
            if settings["family"] == "claude":
                # Claude returns structured_output separately from its assistant text.
                answer_id = "result"
                self.text(json.dumps(response["result"], ensure_ascii=False), answer_id)
            receipt = {"telemetry": response["telemetry"], "answerId": answer_id}
            self.send(result={"stopReason": "end_turn", "_meta": {DUTY_META: receipt}})
        else:
            data = {key: response[key] for key in ("outcome", "telemetry", "limited_until") if key in response}
            self.send(error={"code": -32001, "message": response["reason"] or response["outcome"], "data": data})


def serve_duty():
    agent = DutyAgent(json.loads(sys.argv[2]))
    system_file = Path(agent.settings["system_file"])
    signal.signal(signal.SIGTERM, agent.stop)
    signal.signal(signal.SIGINT, agent.stop)
    threading.Thread(target=agent.read_input, daemon=True).start()
    try:
        agent.run(system_file)
    except (InterruptedError, TimeoutError, OSError, ValueError, KeyError, TypeError) as exc:
        if agent.disconnected or agent.request_id is None:
            return
        if agent.cancelled:
            agent.send(result={"stopReason": "cancelled"})
        else:
            reason = str(exc)
            unavailable = any(word in reason.lower() for word in ("usage limit", "rate limit", "authentication"))
            outcome = "budget_exhausted" if isinstance(exc, TimeoutError) else "unavailable" if unavailable else "failed"
            agent.send(error={"code": -32001, "message": reason, "data": {"outcome": outcome}})
    finally:
        system_file.unlink(missing_ok=True)
