"""Run one OpenCode work turn on its own private server."""
import hashlib
import ipaddress
import json
import os
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from . import acp, clock, config, procs


PROCESS_MARKER = "TEAMSTER_OPENCODE_SUPERVISOR"


def provider_connection(worktree, model):
    """Read the native, merged model route in the same project and environment as ACP."""
    provider, model_name = model.split("/", 1)
    env = dict(os.environ, PWD=os.path.realpath(worktree), COPYFILE_DISABLE="1")
    config.mark_executor(env)

    def listing(*args):
        reply = subprocess.run(["opencode", *args], cwd=worktree, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
        return json.loads(reply.stdout)

    try:
        models = listing("api", "--standalone", "model.list")["data"]
        selected, = (m for m in models if m["providerID"] == provider and m["id"] == model_name and m["enabled"])
        route = {k: selected[k] for k in ("modelID", "package", "settings", "headers", "body") if k in selected}
        settings = route["settings"]
        url = urlsplit(settings["baseURL"])
        if url.scheme not in ("http", "https") or not url.hostname:
            raise ValueError
        data = Path(env.get("XDG_DATA_HOME") or Path.home() / ".local/share").resolve()
        resource = {"provider": provider, "data_home": str(data / "opencode"),
                    "route_id": hashlib.sha256(json.dumps(route, sort_keys=True).encode()).hexdigest()}
        auth = listing("auth", "list", "--standalone", "--format", "json")
        connections = [c for item in auth if item["id"] == provider for c in item["connections"]]
        key = settings.get("apiKey")
        if key:
            if connections or key == "***":
                raise ValueError
            resource.update(source="settings", credential_id=hashlib.sha256(key.encode()).hexdigest())
        elif connections:
            connection, = connections
            if connection["type"] == "credential" and connection.get("id"):
                resource.update(source="credential", credential_id=connection["id"])
            elif connection["type"] == "env" and env.get(connection["name"]):
                key = env[connection["name"]]
                resource.update(source="env", variable=connection["name"],
                                credential_id=hashlib.sha256(key.encode()).hexdigest())
            else:
                raise ValueError
        elif url.hostname == "localhost" or ipaddress.ip_address(url.hostname).is_loopback:
            resource["source"] = "local"
        else:
            raise ValueError

        # Restrict background agents as well as the selected ACP model. Keep the caller's inline settings.
        overlay = json.loads(env.get("OPENCODE_CONFIG_CONTENT") or "{}")
        overlay["model"] = model
        overlay.setdefault("policies", []).extend([{"action": "provider.use", "resource": "*", "effect": "deny"},
                                                  {"action": "provider.use", "resource": provider, "effect": "allow"}])
        overrides = overlay.setdefault("providers", {}).setdefault(provider, {}).setdefault("models", {})
        for entry in models:
            if entry["providerID"] == provider and entry["id"] != model_name:
                overrides.setdefault(entry["id"], {})["disabled"] = True
        overrides.setdefault(model_name, {}).update(route)
        for agent in ("title", "summary", "compaction"):
            overlay.setdefault("agents", {}).setdefault(agent, {})["model"] = model
        env["OPENCODE_CONFIG_CONTENT"] = json.dumps(overlay)
        return resource, env
    except (OSError, ValueError, AttributeError, TypeError, KeyError, subprocess.SubprocessError):
        raise ValueError(f"Cannot verify a single effective OpenCode route and credential for {model}. "
                         "Check the provider settings before continuing.") from None


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


def _set_title(worktree, env, acp_pid, session_id, title, check_active, bound):
    # ACP v1 has no rename command. Set the title before OpenCode can generate one.
    argv = ["opencode", "api", "--standalone", "session.update", "--param",
            f"sessionID={session_id}", "--data", json.dumps({"title": title})]
    check_active()
    with tempfile.TemporaryFile() as errors:
        title_env = {**env, PROCESS_MARKER: f"{env[PROCESS_MARKER]}:title:{acp_pid}"}
        proc = subprocess.Popen(argv, cwd=worktree, env=title_env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL if bound else errors,
                                start_new_session=True)
        try:
            while proc.poll() is None:
                check_active()
                try:
                    proc.wait(timeout=0.2)
                except subprocess.TimeoutExpired:
                    pass
            if proc.returncode:
                message = f"OpenCode session title update failed ({proc.returncode})"
                if not bound:
                    errors.seek(0)
                    message += ": " + errors.read(4096).decode(errors="replace").strip()
                raise ValueError(message)
        finally:
            procs.terminate(proc)


def run_opencode(worktree, prompt, model, session_id, stopped, deadline, *, title, created, started=None, env=None):
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
    bound = env is not None
    env = dict(os.environ if env is None else env, PWD=os.path.realpath(worktree), COPYFILE_DISABLE="1")
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
        overlay = json.loads(env.get("OPENCODE_CONFIG_CONTENT") or "{}")
        overlay.setdefault("policies", []).append({"action": "skill.use", "resource": "teamster", "effect": "deny"})
        env["OPENCODE_CONFIG_CONTENT"] = json.dumps(overlay)
        # The ACP server checks the session again when admitting the prompt. It cannot recreate a deleted ID.
        with config.executor_environment(env) as worker_env, acp.AcpClient(
                ["opencode", "acp"], worktree, lambda event: None, allow_once, check_active=check_active,
                env=worker_env, stderr=subprocess.DEVNULL if bound else None) as client:
            if started:
                started(client.process)
            opened = client.open_session(session_id, model=model)
            if not session_id:
                session_id = opened
                created(session_id)
            if title is not None:
                _set_title(worktree, worker_env, client.process.pid, session_id, title, check_active, bound)
            check_active()
            client.on_update = update
            reason = client.prompt(config.EXECUTOR_INSTRUCTIONS + "\n\n" + prompt)
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
                    or any(marker in detail for marker in ("rate limit", "usage limit", "quota exceeded",
                                                           "exceeded your current quota", "http 429"))):
                return "exhausted", f"OpenCode quota exhausted for {model}. Check the connection's reset time and retry."
            if bound:
                return "failed", f"OpenCode rejected the session request ({error.code}). Check the assigned connection for {model}."
        return "failed", str(error)
