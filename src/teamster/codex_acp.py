"""One headless Codex ACP turn and the CODEX_PATH shim for its native turn contract."""
import json
import os
from pathlib import Path
import shlex
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
    proc = subprocess.Popen([binary, *sys.argv[1:]], stdin=subprocess.PIPE, env=env)

    def forward():
        try:
            for line in sys.stdin.buffer:
                request = json.loads(line)
                method = request.get("method")
                params = request.get("params") or {}
                if method in ("thread/start", "thread/resume") and not params.get("ephemeral"):
                    # exec honors the account's trusted projects and configured tool restrictions.
                    settings = params.get("config", {})
                    settings.pop("projects", None)
                    settings.pop("skills", None)
                    params["approvalPolicy"] = "never"
                    if contract["sandbox"]:
                        params["sandbox"] = contract["sandbox"]
                if method == "turn/start" and target.is_file() and params.get("threadId") == target.read_text():
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
                elif method == "turn/start" and not params.get("outputSchema"):
                    raise ValueError("Unexpected Codex turn outside the admitted ACP session")
                proc.stdin.write(json.dumps(request).encode() + b"\n")
                proc.stdin.flush()
        except (ValueError, OSError) as exc:
            print(f"Codex ACP backend: {exc}", file=sys.stderr, flush=True)
            proc.terminate()
        finally:
            proc.stdin.close()

    threading.Thread(target=forward, daemon=True).start()
    return proc.wait()


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


class Updates:
    """Project ACP messages and tool calls onto the existing supervisor event stream."""

    def __init__(self):
        self.message_id = None
        self.text = []
        self.commands = {}

    def flush(self):
        if self.text:
            emit({"type": "item.completed", "item": {"type": "agent_message", "id": self.message_id,
                                                      "text": "".join(self.text)}})
            self.text.clear()

    def update(self, update):
        kind = update["sessionUpdate"]
        if kind == "agent_message_chunk" and update["content"]["type"] == "text":
            if self.message_id != update.get("messageId"):
                self.flush()
            self.message_id = update.get("messageId")
            self.text.append(update["content"]["text"])
        if kind == "tool_call":
            self.flush()
            command = (update.get("rawInput") or {}).get("command") if isinstance(update.get("rawInput"), dict) else None
            if update.get("kind") in ("execute", "read", "search"):
                self.commands[update["toolCallId"]] = command or update["title"]
        if kind == "tool_call_update" and update.get("status") in ("completed", "failed"):
            command = self.commands.pop(update["toolCallId"], None)
            raw = update.get("rawOutput")
            exit_info = (update.get("_meta", {}).get("terminal_exit")
                         or (raw if isinstance(raw, dict) else {}))
            if command and isinstance(exit_info.get("exit_code"), int):
                output = "".join(c["content"]["text"] for c in update.get("content", [])
                                 if c.get("type") == "content" and c["content"].get("type") == "text")
                emit({"type": "item.completed", "item": {"type": "command_execution", "id": update["toolCallId"],
                      "command": command, "exit_code": exit_info["exit_code"], "aggregated_output": output}})


def run():
    """The supervisor owns this process group and admits the prompt after saving the session ID."""
    directory = Path(sys.argv[1])
    options = json.loads((directory / "options").read_text())
    launcher = directory / "app-server"
    launcher.write_text("#!/bin/sh\nexec " + shlex.join(command("backend")) + ' "$@"\n')
    launcher.chmod(0o700)
    mode = "workspace-write" if options["sandbox"] == "workspace-write" else "read-only"
    env = dict(os.environ, CODEX_PATH=str(launcher), TEAMSTER_ACP_TURN_DIR=str(directory),
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
            raise InterruptedError("Codex turn supervisor exited")

    try:
        with acp.AcpClient([options["adapter"]], os.getcwd(), lambda _: None, lambda _: None,
                           check_active=check_active, env=env, own_group=False) as client:
            session = client.open_session(options["thread"] or None, model=options["model"], config_options=settings,
                                          capabilities={"_meta": {"jetbrains": {"air": {
                                              "version": 1, "capabilities": ["sessionFailure"]}}}})
            emit({"type": "thread.started", "thread_id": session})
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
            updates.flush()
            failure = (reply.get("_meta") or {}).get("jetbrains", {}).get("air", {}).get("sessionFailure")
            if failure and failure.get("severity") == "error":
                raise ValueError(f"{failure.get('category')}: {failure.get('title')}")
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
        emit({"type": "turn.failed", "error": {"message": str(exc)}})
        print(str(exc), file=sys.stderr)
        return 1
