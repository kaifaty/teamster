"""Headless Antigravity work turns authenticated with a Gemini API key."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile

from . import clock, config, procs, result_schema


def prepare(effort, cfg):
    if effort is not None and effort not in ("low", "medium", "high", "xhigh", "max"):
        raise ValueError("Invalid agy effort: expected low, medium, high, xhigh, or max")
    if not config.agy_binary():
        raise ValueError("agy executable not found on PATH")
    if not os.environ.get("GEMINI_API_KEY", "").strip():
        raise ValueError("agy requires GEMINI_API_KEY for Gemini API access")


def _read_event(line, response, session_started):
    event = json.loads(line)
    if not isinstance(event, dict):
        raise ValueError("expected an agy event object")
    kind = event.get("event")
    if kind == "step_update":
        return
    if kind not in ("init", "result"):
        raise ValueError("unexpected agy event")
    payload = event.get(kind)
    if not isinstance(payload, dict):
        raise ValueError("invalid agy event payload")
    session_id = event.get("conversation_id") if kind == "init" else payload.get("conversation_id")
    if session_id:
        if not isinstance(session_id, str) or response["session_id"] not in (None, session_id):
            raise ValueError("unexpected agy conversation ID")
        if response["session_id"] is None:
            response["session_id"] = session_id
            if session_started:
                session_started(session_id)
    if kind == "init":
        response["model"] = payload.get("model") or response["model"]
        return
    status = payload.get("status")
    if status != "SUCCESS":
        response.update(outcome="failed", result=None, reason=str(payload.get("error") or f"agy ended with status {status}"))
        return
    if not session_id:
        raise ValueError("agy result has no conversation ID")
    result = payload.get("structured_output")
    if not result_schema.matches_schema(result, result_schema.RESULT_SCHEMA):
        reason = ("agy tool permission denied (see stderr.log)" if payload.get("denied_actions")
                  else "invalid agy structured output")
        response.update(outcome="failed", reason=reason, result=None)
        return
    response.update(outcome="completed", result=result, reason=None)


def run_agy_work(worktree, task_dir, prompt, stopped, *, session_id=None, model=None,
                  effort=None, deadline=None, started=None, session_started=None):
    """Poll the process group and persist its conversation ID before it starts editing."""
    response = {"outcome": "failed", "reason": None, "result": None,
                "session_id": session_id, "model": model}

    def interrupted():
        if stopped():
            response.update(outcome="stopped", reason="stop requested", result=None)
            return True
        if deadline is not None and clock.CLOCK.monotonic() >= deadline:
            response.update(outcome="budget_exhausted", reason="time budget exhausted", result=None)
            return True
        return False

    if interrupted():
        return response
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    args = [config.agy_binary(), "--output-format", "stream-json",
            "--json-schema", json.dumps(result_schema.RESULT_SCHEMA),
            "--settings", '{"modelProvider":"gemini"}', "--mode", "accept-edits",
            "--add-dir", str(Path(worktree).resolve())]
    if not args[0] or not key:
        response["reason"] = "agy requires its executable on PATH and GEMINI_API_KEY"
        return response
    for flag, value in (("--model", model), ("--effort", effort), ("--conversation", session_id)):
        if value:
            args.extend((flag, value))
    args.extend(("-p", prompt))
    environment = os.environ.copy()
    environment["GEMINI_API_KEY"] = key
    environment.pop("AGY_ADC_AUTH", None)
    key_bytes = key.encode()

    def read_line(line):
        if line.strip():
            _read_event(line.replace(key_bytes, b"[REDACTED]"), response, session_started)

    with tempfile.TemporaryFile() as errors:
        try:
            proc = subprocess.Popen(args, cwd=worktree, env=environment, start_new_session=True,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=errors)
        except OSError as exc:
            response["reason"] = f"could not start agy: {exc}".replace(key, "[REDACTED]")
            return response
        try:
            if started:
                started(proc)
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ)
                pending = b""
                # A tool can inherit stdout and keep the pipe open after agy exits.
                while proc.poll() is None or selector.select(0):
                    if interrupted():
                        break
                    for stream, _ in selector.select(0.2):
                        chunk = os.read(stream.fd, 65536)
                        if not chunk:
                            selector.unregister(stream.fd)
                            continue
                        lines = (pending + chunk).split(b"\n")
                        pending = lines.pop()
                        for line in lines:
                            read_line(line)
                else:
                    read_line(pending)
                    if proc.returncode != 0 and not response["reason"]:
                        response.update(outcome="failed", result=None, reason=f"agy exited with code {proc.returncode} (see stderr.log)")
                    elif response["outcome"] == "failed" and not response["reason"]:
                        response["reason"] = "agy returned no result (see stderr.log)"
        except (ValueError, OSError) as exc:
            response.update(outcome="failed", result=None, reason=f"agy: {exc}".replace(key, "[REDACTED]"))
        finally:
            procs.terminate(proc)
            proc.stdout.close()

        # Keep stderr diagnostics (including headless permission denials), but never the API key.
        errors.seek(0)
        with (Path(task_dir) / "stderr.log").open("ab") as log:
            for line in errors:
                log.write(line.replace(key_bytes, b"[REDACTED]"))
    return response
