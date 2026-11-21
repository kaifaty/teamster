"""Run one OpenCode work turn on its own private server."""
import json
import os
import subprocess
import tempfile

from . import acp, clock, procs


def run_opencode(worktree, prompt, model, session_id, stopped, deadline, *, title, created, started=None):
    """Create a titled session if needed, then work only in that existing session."""
    def check_active():
        if stopped():
            raise InterruptedError("OpenCode stopped")
        if deadline is not None and clock.CLOCK.monotonic() >= deadline:
            raise TimeoutError("OpenCode reached the turn time budget")

    def allow_once(params):
        return next((item["optionId"] for item in params["options"] if item["kind"] == "allow_once"), None)

    parts = []
    message_id = None

    def update(event):
        nonlocal message_id
        kind = event.get("sessionUpdate")
        if kind == "tool_call":
            parts.clear()
        elif kind == "agent_message_chunk" and event.get("content", {}).get("type") == "text":
            if event.get("messageId") != message_id:
                parts.clear()
            message_id = event.get("messageId")
            parts.append(event["content"]["text"])

    try:
        check_active()
        if not session_id:
            # Giving the session its title at creation avoids a separate model call for an automatic title.
            argv = ["opencode", "api", "--standalone", "session.create", "--data", json.dumps({"title": title})]
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
                proc = subprocess.Popen(argv, cwd=worktree, env={**os.environ, "PWD": os.path.realpath(worktree)},
                                        stdin=subprocess.DEVNULL, stdout=output, stderr=errors, start_new_session=True)
                try:
                    if started:
                        started(proc)
                    while proc.poll() is None:
                        check_active()
                        try:
                            proc.wait(timeout=0.2)
                        except subprocess.TimeoutExpired:
                            pass
                    if proc.returncode:
                        errors.seek(0)
                        detail = errors.read(4096).decode(errors="replace").strip()
                        return "failed", detail or f"OpenCode session creation exited with {proc.returncode}"
                    output.seek(0)
                    try:
                        session_id = json.load(output)["data"]["id"]
                    except (KeyError, TypeError):
                        session_id = None
                    if not isinstance(session_id, str) or not session_id:
                        return "failed", "OpenCode returned no session ID"
                    created(session_id)
                finally:
                    procs.terminate(proc)

        check_active()
        # The ACP server checks the session again when admitting the prompt. It cannot recreate a deleted ID.
        with acp.AcpClient(["opencode", "acp"], worktree, lambda event: None, allow_once,
                           check_active=check_active) as client:
            if started:
                started(client.process)
            client.open_session(session_id, model=model)
            client.on_update = update
            reason = client.prompt(prompt)
        check_active()
        if client.process.returncode:
            return "failed", f"OpenCode exited with {client.process.returncode}"
        if reason != "end_turn" or not parts:
            return "failed", f"OpenCode returned no complete final answer ({reason})"
        return "completed", "".join(parts)
    except InterruptedError as error:
        return "stopped", str(error)
    except TimeoutError as error:
        return "budget_exhausted", str(error)
    except (ValueError, OSError) as error:
        if session_id and f"session not found: {session_id}" in str(error):
            return "failed", f"Saved OpenCode session {session_id} was not found"
        return "failed", str(error)
