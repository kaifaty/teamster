"""Run one OpenCode work turn on its own private server."""
import json
import subprocess
import tempfile

from . import clock, procs


def _response(events, session_id, returncode, stderr):
    parts = []
    finished = False
    for line in events:
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            return "failed", "Invalid OpenCode JSON output"
        if not isinstance(event, dict) or event.get("sessionID") != session_id:
            return "failed", "Unexpected OpenCode session ID"
        kind = event.get("type")
        part = event.get("part")
        if kind == "error":
            error = event.get("error")
            return "failed", (error.get("message") if isinstance(error, dict) else None) or "OpenCode error"
        if kind == "step_start":
            parts.clear()
        elif kind == "text" and isinstance(part, dict) and isinstance(part.get("text"), str):
            parts.append(part["text"])
        finished = kind == "step_finish" and isinstance(part, dict) and part.get("reason") == "stop"
    if returncode:
        stderr.seek(0)
        return "failed", stderr.read(4096).decode(errors="replace").strip() or f"OpenCode exited with {returncode}"
    if not finished or not parts:
        return "failed", "OpenCode returned no complete final answer"
    return "completed", "".join(parts)


def run_opencode(worktree, prompt, model, session_id, stopped, deadline, started=None, *, title):
    """Return (outcome, final answer or error) for the caller's persisted session ID."""
    def interruption():
        if stopped():
            return "stopped", "OpenCode stopped"
        if deadline is not None and clock.CLOCK.monotonic() >= deadline:
            return "budget_exhausted", "OpenCode reached the turn time budget"

    argv = ["opencode", "run", "--standalone", "--auto", "--format", "json",
            "--session", session_id, "--model", model, "--title", title]
    # Tool events and long prompts can exceed a pipe buffer. Keep the process
    # interruptible without retaining the whole tool transcript in memory.
    with tempfile.TemporaryFile() as request, tempfile.TemporaryFile() as events, tempfile.TemporaryFile() as stderr:
        request.write(prompt.encode())
        request.seek(0)
        if reason := interruption():
            return reason
        try:
            proc = subprocess.Popen(argv, cwd=worktree, stdin=request, stdout=events, stderr=stderr,
                                    start_new_session=True)
        except OSError as error:
            return "failed", f"Could not start OpenCode: {error}"
        try:
            if started:
                started(proc)
            while True:
                try:
                    proc.wait(timeout=0.2)
                except subprocess.TimeoutExpired:
                    pass
                if reason := interruption():
                    return reason
                if proc.returncode is not None:
                    break
            events.seek(0)
            return _response(events, session_id, proc.returncode, stderr)
        finally:
            procs.terminate(proc)
