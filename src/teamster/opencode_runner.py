"""Run one OpenCode work turn on its own private server."""
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

from . import acp, clock, procs


PROCESS_MARKER = "TEAMSTER_OPENCODE_SUPERVISOR"


def provider_connection(worktree, model):
    """Resolve the single connection that can serve this provider in the ACP process's environment."""
    provider = model.split("/", 1)[0]
    try:
        listing = subprocess.run(["opencode", "auth", "list", "--format", "json"], cwd=worktree,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 timeout=15, check=True)
        connections = [c for item in json.loads(listing.stdout) if item["id"] == provider for c in item["connections"]]
        if len(connections) == 1:
            connection = connections[0]
            data = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share").resolve()
            resource = {"provider": provider, "data_home": str(data / "opencode"), "source": connection["type"]}
            if connection["type"] == "credential" and connection.get("id"):
                return dict(resource, credential_id=connection["id"])
            if connection["type"] == "env" and os.environ.get(connection["name"]):
                value = os.environ[connection["name"]].encode()
                return dict(resource, variable=connection["name"], credential_id=hashlib.sha256(value).hexdigest())
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        pass
    raise ValueError(f"Cannot identify a single OpenCode connection for {provider}. Check its provider settings.")


def orphan_groups(st):
    """Find the recorded ACP group and its title update, even after either leader exits."""
    owner = f"{PROCESS_MARKER}={st['pid']}".encode()
    directory = os.fsencode("PWD=" + os.path.realpath(st["worktree"]))
    acp_pid = st["opencode_pid"]
    title_owner = owner + f":title:{acp_pid}".encode()
    seen = set()
    for entry in procs.sh(["ps", "-U", str(os.getuid()), "-o", "pid="]).split():
        pid = int(entry)
        env = procs.process_environment(pid)
        if directory not in env or (owner not in env and title_owner not in env):
            continue
        try:
            group = os.getpgid(pid)
        except ProcessLookupError:
            continue
        if group != acp_pid and title_owner not in env:
            continue
        if group > 1 and group != os.getpgrp() and group not in seen:
            seen.add(group)
            yield group


def _set_title(worktree, env, acp_pid, session_id, title, check_active):
    # ACP v1 has no rename command. Set the title before OpenCode can generate one.
    argv = ["opencode", "api", "--standalone", "session.update", "--param",
            f"sessionID={session_id}", "--data", json.dumps({"title": title})]
    check_active()
    with tempfile.TemporaryFile() as errors:
        title_env = {**env, PROCESS_MARKER: f"{env[PROCESS_MARKER]}:title:{acp_pid}"}
        proc = subprocess.Popen(argv, cwd=worktree, env=title_env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=errors, start_new_session=True)
        try:
            while proc.poll() is None:
                check_active()
                try:
                    proc.wait(timeout=0.2)
                except subprocess.TimeoutExpired:
                    pass
            if proc.returncode:
                errors.seek(0)
                detail = errors.read(4096).decode(errors="replace").strip()
                raise ValueError(f"OpenCode session title update failed ({proc.returncode}): {detail}")
        finally:
            procs.terminate(proc)


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
    env = dict(os.environ, PWD=os.path.realpath(worktree), COPYFILE_DISABLE="1")
    env[PROCESS_MARKER] = str(os.getpid())

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
        # The ACP server checks the session again when admitting the prompt. It cannot recreate a deleted ID.
        with acp.AcpClient(["opencode", "acp"], worktree, lambda event: None, allow_once,
                           check_active=check_active, env=env) as client:
            if started:
                started(client.process)
            opened = client.open_session(session_id, model=model)
            if not session_id:
                session_id = opened
                created(session_id)
            if title is not None:
                _set_title(worktree, env, client.process.pid, session_id, title, check_active)
            check_active()
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
        if isinstance(error, acp.AcpRequestError):
            data = error.data if isinstance(error.data, dict) else {}
            detail = str(error).lower()
            if (error.code == 429 or data.get("errorKind") in ("rate_limit", "quota_exceeded")
                    or any(marker in detail for marker in ("rate limit", "usage limit", "quota exceeded", "http 429"))):
                return "exhausted", f"OpenCode quota exhausted for {model}. Check the connection's reset time and retry."
        return "failed", str(error)
