"""One headless Codex ACP turn and the CODEX_PATH shim for its native turn contract."""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import threading

from . import acp, config


def command(operation, *args):
    # Run the same installed package even when the task worktree contains Python modules.
    bootstrap = ("import sys; sys.path.insert(0, sys.argv.pop(1)); "
                 "from teamster import codex_acp; sys.exit(codex_acp." + operation + "())")
    return [sys.executable, "-I", "-c", bootstrap, str(config.PACKAGE.resolve().parent), *args]


def backend():
    """Forward app-server stdio. Only the supervisor-admitted thread gets the output schema."""
    if sys.argv[1:2] != ["app-server"]:
        raise ValueError("Codex ACP requires the app-server backend")
    env = dict(os.environ)
    binary = env.pop("TEAMSTER_ACP_BACKEND")
    directory = Path(env.pop("TEAMSTER_ACP_TURN_DIR"))
    env.pop("CODEX_PATH", None)
    contract = json.loads((directory / "options").read_text())
    target = directory / "target"
    proc = subprocess.Popen([binary, *sys.argv[1:]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)

    def forward():
        try:
            for line in sys.stdin.buffer:
                request = json.loads(line)
                method = request.get("method")
                params = request.get("params") or {}
                if method in ("thread/start", "thread/resume") and not params.get("ephemeral"):
                    # exec honors the account's trusted projects and configured tool restrictions.
                    settings = params.setdefault("config", {})
                    settings.pop("projects", None)
                    settings.pop("skills", None)
                    if contract["review"]:
                        settings["web_search"] = "disabled"
                        settings.setdefault("features", {}).update(multi_agent=False, multi_agent_v2=False,
                                                                   view_image=False)
                        settings.setdefault("agents", {})["enabled"] = False
                    if contract["sandbox"] == "workspace-write":
                        settings["sandbox_workspace_write"] = {"network_access": True, "writable_roots": contract["roots"]}
                    params["approvalPolicy"] = "never"
                    params.pop("permissions", None)
                    params.pop("sandbox", None)
                    if contract["sandbox"]:
                        params["sandbox"] = contract["sandbox"]
                if method == "turn/start":
                    if not target.is_file() or params.get("threadId") != target.read_text():
                        raise ValueError("Unexpected Codex turn outside the admitted ACP session")
                    # A second turn/start for this thread needs another supervisor admission.
                    (directory / "sent").touch(exist_ok=False)
                    params["approvalPolicy"] = "never"
                    params.pop("approvalsReviewer", None)
                    params.pop("permissions", None)
                    params.pop("sandboxPolicy", None)
                    if contract["sandbox"] == "workspace-write":
                        params["sandboxPolicy"] = {"type": "workspaceWrite", "networkAccess": True,
                                                   "writableRoots": contract["roots"],
                                                   "excludeTmpdirEnvVar": False, "excludeSlashTmp": False}
                    elif contract["sandbox"] == "read-only":
                        params["sandboxPolicy"] = {"type": "readOnly", "networkAccess": False}
                    if contract["schema"] is not None:
                        params["outputSchema"] = contract["schema"]
                proc.stdin.write(json.dumps(request).encode() + b"\n")
                proc.stdin.flush()
        except (ValueError, OSError) as exc:
            print(f"Codex ACP backend: {exc}", file=sys.stderr, flush=True)
            proc.terminate()
        finally:
            proc.stdin.close()

    threading.Thread(target=forward, daemon=True).start()
    # The adapter drops the command and exit code for classified reads and searches.
    # Request the ordinary terminal representation for every native command so that
    # Teamster can apply its existing repeated-failure guard to the actual exit status.
    for line in proc.stdout:
        message = json.loads(line)
        if message.get("method") in ("item/started", "item/completed"):
            item = message["params"]["item"]
            if item["type"] == "commandExecution" and item.get("commandActions"):
                item["commandActions"] = []
                line = json.dumps(message).encode() + b"\n"
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
    return proc.wait()


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


class Updates:
    """Project ACP messages and tool calls onto the existing supervisor event stream."""

    def __init__(self):
        self.commands = {}

    def update(self, update):
        kind = update["sessionUpdate"]
        if kind in ("agent_message_chunk", "agent_thought_chunk") and update["content"]["type"] == "text":
            item = "agent_message" if kind == "agent_message_chunk" else "reasoning"
            emit({"type": "item.delta", "item": {"type": item, "id": update.get("messageId"),
                                                 "text": update["content"]["text"]}})
        if kind == "tool_call":
            raw = update.get("rawInput")
            raw = raw if isinstance(raw, dict) else {}
            tool_id = update["toolCallId"]
            if update.get("kind") == "edit":
                # The stock adapter sends a diff per hunk and locations on permission requests.
                paths = dict.fromkeys(part["path"] for part in (update.get("content") or [])
                                      if part.get("type") == "diff" and isinstance(part.get("path"), str))
                changes = update.get("locations") or [{"path": path} for path in paths]
                emit({"type": "item.started", "item": {"type": "file_change", "id": tool_id,
                                                      "changes": changes}})
            elif update.get("kind") == "other" and "senderThreadId" in raw:
                emit({"type": "item.started", "item": {"type": "collab_tool_call", "id": tool_id,
                                                      "tool": update["title"], "prompt": raw.get("prompt")}})
            elif update.get("kind") in ("execute", "read", "search"):
                command = raw.get("command") or update["title"]
                self.commands[tool_id] = (command, [])
                emit({"type": "item.started", "item": {"type": "command_execution", "id": tool_id,
                                                      "command": command}})
        if kind == "tool_call_update" and update["toolCallId"] in self.commands:
            tool_id = update["toolCallId"]
            command, chunks = self.commands[tool_id]
            meta = update.get("_meta") or {}
            delta = meta.get("terminal_output_delta") or {}
            if isinstance(delta.get("data"), str):
                chunks.append(delta["data"])
            if update.get("status") in ("completed", "failed"):
                del self.commands[tool_id]
                raw = update.get("rawOutput")
                exit_info = meta.get("terminal_exit") or (raw if isinstance(raw, dict) else {})
                if type(exit_info.get("exit_code")) is int:
                    chunks.extend(c["content"]["text"] for c in update.get("content", [])
                                  if c.get("type") == "content" and c["content"].get("type") == "text")
                    emit({"type": "item.completed", "item": {"type": "command_execution", "id": tool_id,
                          "command": command, "exit_code": exit_info["exit_code"], "aggregated_output": "".join(chunks)}})


def codex_acp_turn():
    """The supervisor owns this process group and admits the prompt after saving the session ID."""
    directory = Path(sys.argv[1])
    options = json.loads((directory / "options").read_text())
    launcher = directory / "app-server"
    launcher.write_text("#!/bin/sh\nexec " + shlex.join(command("backend")) + ' "$@"\n')
    launcher.chmod(0o700)
    mode = "workspace-write" if options["sandbox"] == "workspace-write" else "read-only"
    env = dict(os.environ, CODEX_PATH=str(launcher), CODEX_ACP_PROTOCOL="v1", TEAMSTER_ACP_TURN_DIR=str(directory),
               TEAMSTER_ACP_BACKEND=options["binary"], INITIAL_AGENT_MODE=mode, PWD=os.getcwd())
    # An inherited adapter-specific login or gateway would select a different account.
    for key in ("DEFAULT_AUTH_REQUEST", "CODEX_CONFIG", "MODEL_PROVIDER"):
        env.pop(key, None)
    settings = {"mode": mode}
    if options["effort"]:
        settings["reasoning_effort"] = options["effort"]
    parent = os.getppid()

    def check_active():
        if os.getppid() != parent:
            # The supervisor cannot clean up this group after an unhandled crash.
            os.killpg(os.getpgrp(), signal.SIGKILL)

    try:
        with acp.AcpClient([options["adapter"]], os.getcwd(), lambda _: None, lambda _: None,
                           check_active=check_active, env=env, own_group=False) as client:
            session = client.open_session(options["thread"] or None, model=options["model"], config_options=settings,
                                          capabilities={"_meta": {"terminal_output_delta": True, "jetbrains": {"air": {
                                              "version": 1, "capabilities": ["sessionFailure"]}}}})
            emit({"type": "thread.started", "thread_id": session, **client.config_values})
            if sys.stdin.buffer.readline() != b"prompt\n":
                raise InterruptedError("Supervisor closed before admitting the Codex prompt")
            (directory / "target").write_text(session)
            if not options["thread"]:
                client.set_title(options["slug"])
            updates = Updates()
            client.on_update = updates.update
            emit({"type": "turn.started"})
            prompt = (directory / "prompt").read_text()
            # Slash commands belong to the interactive adapter, including /logout.
            if prompt.lstrip().startswith("/"):
                prompt = "User request:\n" + prompt
            reply = client.prompt_result(prompt)
            failure = (reply.get("_meta") or {}).get("jetbrains", {}).get("air", {}).get("sessionFailure")
            if failure and failure.get("severity") == "error":
                emit({"type": "turn.failed", "error": {"message": failure["title"], "category": failure["category"],
                                                      "actions": failure.get("actions", [])}})
                return 1
            reason = reply["stopReason"]
            if reason != "end_turn":
                raise ValueError(f"Codex ACP stopped with {reason}")
            if not (directory / "sent").exists():
                raise ValueError("Codex ACP did not start the admitted native turn")
            emit({"type": "turn.completed"})
        if client.process.returncode:
            raise ValueError(f"Codex ACP exited with status {client.process.returncode}")
        return 0
    except (OSError, ValueError) as exc:
        error = {"message": str(exc)}
        if isinstance(exc, acp.AcpRequestError):
            error = {"message": exc.provider_message or str(exc), "code": exc.code}
        emit({"type": "turn.failed", "error": error})
        print(str(exc), file=sys.stderr)
        return 1
