"""Isolated Claude Code transport shared by reviews and writable work turns."""
import json
import os
import selectors
import shlex
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import acp, claude_accounts, clock, config, procs, result_schema, sandboxing

# Claude Code's own maximum Bash timeout; work turns never allow less, and use it as the default.
BASH_FLOOR_SECONDS = 600
# The Bash timeout limit of a turn without a time budget.
BASH_UNBOUNDED_SECONDS = 2 * 60 * 60


def isolated_environment(account):
    """The account's cleaned environment, without any credential."""
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("CLAUDE", "ANTHROPIC"))}
    environment["CLAUDE_CONFIG_DIR"] = str(Path(account["config_dir"]).expanduser())
    environment["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] = "1"
    environment["COPYFILE_DISABLE"] = "1"
    return environment


def account_environment(account, timeout):
    """Read an isolated account's token without exposing credential output."""
    environment = isolated_environment(account)
    try:
        credential = subprocess.run(
            ["security", "find-generic-password", "-s", account["token_keychain"],
             "-a", os.environ.get("USER", ""), "-w"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            timeout=timeout, env=environment)
    except (OSError, subprocess.TimeoutExpired):
        return environment, ""
    token = credential.stdout.strip() if credential.returncode == 0 else ""
    if token:
        environment["CLAUDE_CODE_OAUTH_TOKEN"] = token
    return environment, token


def bash_hook_settings():
    """Settings that run the Bash guard, with teamster's interpreter, before every Bash command."""
    command = shlex.join([sys.executable, "-I", str(config.BASH_GUARD)])
    return {"disableAllHooks": False, "hooks": {"PreToolUse": [
        {"matcher": "Bash", "hooks": [{"type": "command", "command": command}]}]}}


# The tools of a duty chat turn; its hook narrows Bash and the file tools.
DUTY_TOOLS = "Read,Grep,Glob,Bash,Write,Edit"
DUTY_GUARDED_TOOLS = "Bash|Write|Edit|MultiEdit|NotebookEdit"


def duty_hook_settings(room):
    """Settings that run the duty guard before every Bash command and file write of a duty chat turn."""
    command = shlex.join([sys.executable, "-I", str(config.BASH_GUARD), "--duty-room", str(room)])
    # Explicit false: settings from the account or the room must not turn this hook off.
    return json.dumps({"disableAllHooks": False, "hooks": {"PreToolUse": [
        {"matcher": DUTY_GUARDED_TOOLS, "hooks": [{"type": "command", "command": command}]}]}})


def bash_timeouts(deadline, max_minutes):
    """Let a foreground command run to the end of the turn's remaining budget."""
    limit = (BASH_UNBOUNDED_SECONDS if deadline is None
             else max(deadline - clock.CLOCK.monotonic(), BASH_FLOOR_SECONDS))
    if max_minutes is not None:
        limit = min(limit, max_minutes * config.MINUTE_SECONDS)
    # Rounded, not truncated: (now + 900) - now can come out as 899.9999999999995.
    maximum = max(round(limit * 1000), 1000)
    return {"BASH_DEFAULT_TIMEOUT_MS": str(min(maximum, BASH_FLOOR_SECONDS * 1000)),
            "BASH_MAX_TIMEOUT_MS": str(maximum)}


def stream_unavailable(event, account, record=True, model=None, limit=None):
    """Persist safe limit fields and recognize account availability errors.

    With record false, only recognize them: nothing about the account is stored.
    ``model`` is the ``--model`` of the request; its success lifts that model's limit mark.
    With a ``limit`` dict, a rejection on ``model`` (or on the model ``limit`` already
    names) is marked together with its snapshot, and ``limit`` gets ``limited_until``
    and ``limited_model``.
    """
    kind = event.get("type")
    if (kind == "result" or kind == "system" and event.get("subtype") == "api_retry"):
        if event.get("error_status", event.get("api_error_status")) in (401, 403):
            return "authentication failed"
        if kind == "result" and not event.get("is_error") and record:
            claude_accounts.authenticated(account)
            stamp = event.get("timestamp")
            claude_accounts.model_succeeded(account, model, stamp if result_schema.is_finite_number(stamp) else None)
    if kind == "rate_limit_event":
        info = event.get("rate_limit_info")
        if isinstance(info, dict):
            if record:
                mark_model = (model or limit.get("limited_model")) if limit is not None else None
                marked = claude_accounts.save_limits(account, info, event.get("timestamp"), model, mark_model)
                if marked is not None:
                    limit["limited_until"], limit["limited_model"] = marked
            if info.get("status") == "rejected":
                return "usage limit"
    return None


def event_result(event, telemetry, token, account, reviewing=True, scouting=False, reflecting=False, chatting=False,
                 model=None, limit=None):
    """Decode selected stream fields; return (result, unavailability reason)."""
    if not isinstance(event, dict):
        return None, "invalid JSON output"
    kind = event.get("type")
    if (kind == "system" and event.get("subtype") == "init"
            or not reviewing and kind == "result"):
        for key in ("session_id", "model"):
            value = event.get(key)
            if isinstance(value, str) and token not in value:
                telemetry[key] = value
    if kind != "result":
        if not reviewing and kind == "rate_limit_event":
            info = event.get("rate_limit_info")
            windows = info.get("unifiedWindows") if isinstance(info, dict) else None
            window = windows.get("seven_day") if isinstance(windows, dict) else None
            if isinstance(window, dict):
                used, reset = window.get("utilization"), window.get("resetsAt")
                if (result_schema.is_finite_number(used) and 0 <= used <= 1
                        and result_schema.is_finite_number(reset) and reset > clock.CLOCK.time()):
                    telemetry.setdefault("weekly_used_before", used * 100)
                    telemetry.setdefault("weekly_reset_before", reset)
                    telemetry["weekly_used_after"] = used * 100
                    telemetry["weekly_reset_after"] = reset
        return None, stream_unavailable(event, account, model=model, limit=limit)
    usage = event.get("usage")
    if isinstance(usage, dict):
        telemetry["usage"] = {key: usage[key] for key in
                              ("input_tokens", "output_tokens", "cache_creation_input_tokens",
                               "cache_read_input_tokens") if result_schema.is_finite_number(usage.get(key))}
    if result_schema.is_finite_number(event.get("total_cost_usd")):
        telemetry["cost_usd"] = event["total_cost_usd"]
    if type(event.get("num_turns")) is int:
        telemetry["num_turns"] = event["num_turns"]
    reason = stream_unavailable(event, account, model=model, limit=limit)
    if reason:
        return None, reason
    if event.get("is_error"):
        return None, ("review failed" if reviewing else "scout failed" if scouting
                      else "reflect failed" if reflecting else "duty turn failed" if chatting else "work turn failed")
    if scouting:
        answer = event.get("result")
        if not isinstance(answer, str) or not answer.strip():
            return None, "invalid scout output"
        return answer.replace(token, "[REDACTED]"), None
    result = event.get("structured_output")
    schema = result_schema.REVIEW_SCHEMA if reviewing else result_schema.RESULT_SCHEMA
    if not (result_schema.valid_reflect_result(result) if reflecting
            else result_schema.valid_duty_result(result) if chatting
            else result_schema.matches_schema(result, schema)):
        return None, "invalid structured output"
    # A tool may echo its environment. Even a schema-valid answer must not
    # carry the credential into state, review files, or telemetry.
    serialized = json.dumps(result)
    if token in serialized:
        result = json.loads(serialized.replace(token, "[REDACTED]"))
    return result, None


def validate_work_effort(effort):
    if effort is not None and effort not in ("low", "medium", "high", "xhigh", "max"):
        raise ValueError("Invalid Claude effort: expected low, medium, high, xhigh, or max")


def run_work_turn(account, worktree, task_dir, prompt, stopped, session_id=None,
                  model=None, effort=None, max_turns=None, deadline=None, started=None, progress=None,
                  max_minutes=None):
    """Run a writable turn without supervisor task state.

    The caller supplies an existing task directory, a monotonic deadline and
    the task's ``--max-minutes``, which also bound the Bash tool's timeouts.
    An unparsed result returns outcome ``unknown``, result ``None``, and the
    last answer in ``raw_message``. Session and usage fields are in telemetry.
    """
    validate_work_effort(effort)
    system_prompt = sandboxing.claude_system_prompt(worktree, task_dir)
    try:
        return run_claude(account, worktree, prompt, stopped, deadline, model, effort, max_turns,
                          session_id=session_id, system_prompt=system_prompt, started=started, progress=progress,
                          task_dir=task_dir, max_minutes=max_minutes)
    finally:
        system_prompt.unlink(missing_ok=True)


def _prepare_turn(account, stopped, deadline, model, effort, reviewing, read_only, max_minutes):
    """Resolve the native executable and isolated account before starting either transport."""
    response = {"outcome": "unavailable", "result": None, "reason": None, "deadline": deadline,
                "telemetry": {"usage": {}, "cost_usd": None, "session_id": None,
                              "model": None, "reasoning_effort": None, "num_turns": None}}
    if not reviewing:
        response["raw_message"] = ""
    if stopped():
        response["outcome"] = "stopped"
        return response, None
    if deadline is not None and clock.CLOCK.monotonic() >= deadline:
        response["outcome"] = "budget_exhausted"
        return response, None
    executable = config.claude_binary()
    if executable is None:
        response["reason"] = "Claude CLI was not found"
        return response, None
    # Read immediately before launch. Credential output never reaches artifacts.
    remaining = config.ACCOUNT_TIMEOUT if deadline is None else deadline - clock.CLOCK.monotonic()
    if remaining <= 0:
        response["outcome"] = "budget_exhausted"
        return response, None
    environment, token = account_environment(account, min(config.ACCOUNT_TIMEOUT, remaining))
    if stopped():
        response["outcome"] = "stopped"
        return response, None
    if deadline is not None and clock.CLOCK.monotonic() >= deadline:
        response["outcome"] = "budget_exhausted"
        return response, None
    if not token:
        response["reason"] = "token unavailable"
        return response, None
    claude_accounts.token_available(account["name"])
    if stopped():
        response["outcome"] = "stopped"
        return response, None
    if not read_only:
        environment.update(bash_timeouts(deadline, max_minutes))
    response["telemetry"].update(model=model, reasoning_effort=effort)
    return response, (executable, environment, token)


def run_guarded_claude(account, room, prompt, stopped, deadline, model, effort, *, session_id, resume,
                       system_prompt, progress, task_dir, max_minutes, on_text):
    """Run the native, hook-guarded handler for the private duty ACP agent."""
    response, launch = _prepare_turn(account, stopped, deadline, model, effort, False, False, max_minutes)
    if launch is None:
        return response
    executable, environment, token = launch
    environment[config.STARTED_BY] = "duty"
    args = [executable, "-p", "--output-format", "stream-json", "--verbose",
            "--json-schema", json.dumps(result_schema.DUTY_SCHEMA), "--permission-mode", "dontAsk",
            "--allowedTools", DUTY_TOOLS, "--disallowedTools", "NotebookEdit", "--strict-mcp-config",
            "--append-system-prompt-file", str(system_prompt), "--settings", duty_hook_settings(room),
            "--resume" if resume else "--session-id", session_id]
    for key, value in (("model", model), ("effort", effort)):
        if value:
            args += ["--" + key, value]
    if prompt.startswith("-"):
        args.extend(["--", prompt])
    else:
        args.insert(2, prompt)
    try:
        proc = subprocess.Popen(args, cwd=room, env=environment,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        response["reason"] = "Claude CLI could not be started"
        return response
    buffer, eof, termination = b"", False, None
    events_failed = False
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            while True:
                if stopped():
                    response["outcome"] = "stopped"
                    break
                if deadline is not None and clock.CLOCK.monotonic() >= deadline:
                    response["outcome"] = "budget_exhausted"
                    break
                if eof and proc.poll() is not None:
                    if proc.returncode and response["reason"] not in ("authentication failed", "usage limit"):
                        response["reason"] = "duty turn failed"
                    if response["reason"] is None:
                        if response["result"] is None:
                            response["reason"] = "invalid structured output"
                        else:
                            response["outcome"] = "completed"
                    if response["reason"] in ("invalid structured output", "invalid JSON output", "duty turn failed"):
                        response.update(outcome="failed", result=None)
                    break
                for key, _ in selector.select(0.2):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        eof = True
                    buffer += chunk
                    while b"\n" in buffer or (eof and buffer):
                        line, separator, remaining = buffer.partition(b"\n")
                        buffer = remaining if separator else b""
                        if separator and task_dir is not None and not events_failed:
                            events_failed = not _write_event(task_dir, line.replace(token.encode(), b"[REDACTED]"))
                        if not line.strip():
                            continue
                        try:
                            event = json.loads(line)
                        except (ValueError, UnicodeError):
                            with (Path(system_prompt).parent / "stderr.log").open("a", encoding="utf-8") as errors:
                                errors.write(line.decode("utf-8", errors="replace").replace(token, "[REDACTED]") + "\n")
                            continue
                        _record_event(event, response, token, account, model, False, "duty", on_text)
                        if progress:
                            progress(response["telemetry"])
                if (response["reason"] and termination is None and response["reason"] not in
                        ("invalid structured output", "invalid JSON output", "duty turn failed")):
                    # Drain buffered and shutdown usage while terminating, even
                    # when the final result is larger than the stdout pipe.
                    termination = threading.Thread(target=procs.terminate, args=(proc,))
                    termination.start()
    finally:
        if termination is None:
            procs.terminate(proc)
        else:
            termination.join()
        proc.stdout.close()
    return response


def _write_event(task_dir, line):
    try:
        with (Path(task_dir) / "claude-events.jsonl").open("ab") as events:
            events.write(line + b"\n")
        return True
    except OSError:
        try:
            with (Path(task_dir) / "stderr.log").open("a", encoding="utf-8") as errors:
                errors.write("Could not append to claude-events.jsonl.\n")
        except OSError:
            pass
        return False


def _record_event(event, response, token, account, model, reviewing, role, on_text=None):
    if not reviewing and isinstance(event, dict):
        if event.get("type") == "assistant":
            message = event.get("message")
            content = message.get("content") if isinstance(message, dict) else None
            if isinstance(content, list):
                texts = [item["text"] for item in content if isinstance(item, dict)
                         and item.get("type") == "text" and isinstance(item.get("text"), str)]
                if texts:
                    response["raw_message"] = "\n".join(texts).replace(token, "[REDACTED]")
                    if on_text:
                        on_text(response["raw_message"])
        elif event.get("type") == "result" and isinstance(event.get("result"), str) and event["result"]:
            response["raw_message"] = event["result"].replace(token, "[REDACTED]")
    if (role == "work" and not reviewing and isinstance(event, dict)
            and event.get("type") == "result" and "structured_output" not in event):
        event = dict(event, structured_output=result_schema.parse_result(event.get("result")))
    # A later success on a failed stream must not lift that model's limit mark.
    result, reason = event_result(event, response["telemetry"], token, account["name"],
                                  reviewing, role == "scout", role == "reflect", role == "duty",
                                  model=model if not response["reason"] else None, limit=response)
    if reason:
        response["reason"] = response["reason"] or reason
        response["result"] = None
    elif response["reason"] is None and result is not None:
        response["result"] = result


def run_claude(account, worktree, prompt, stopped, deadline=None, model=None, effort=None,
               max_turns=None, *, session_id=None, system_prompt=None, reviewing=False, started=None, progress=None,
               task_dir=None, role="work", max_minutes=None):
    """Run an ordinary Claude role through the stock ACP adapter."""
    if role not in ("work", "scout", "reflect"):
        raise ValueError("Unsupported ordinary Claude role")
    read_only = reviewing or role in ("scout", "reflect")
    response, launch = _prepare_turn(account, stopped, deadline, model, effort, reviewing, read_only, max_minutes)
    if launch is None:
        return response
    executable, environment, token = launch
    options = {"strictMcpConfig": True}
    meta = {"claudeCode": {"options": options, "emitRawSDKMessages": True}}
    if role != "scout":
        schema = (result_schema.REVIEW_SCHEMA if reviewing else result_schema.REFLECT_SCHEMA if role == "reflect"
                  else result_schema.RESULT_SCHEMA)
        options["outputFormat"] = {"type": "json_schema", "schema": schema}
    if read_only:
        # ACP's catalog has no dontAsk. Expose only the old allowlist, remove bypass
        # and decline every permission request in manual mode.
        tools = ["Read", "Grep", "Glob", "Bash"]
        options.update(tools=tools, allowedTools=tools, disallowedTools=["Edit", "Write", "NotebookEdit"],
                       allowDangerouslySkipPermissions=False)
    else:
        meta["systemPrompt"] = {"append": Path(system_prompt).read_text(encoding="utf-8")}
        options["settings"] = bash_hook_settings()
    for key, value in (("model", model), ("effort", effort), ("maxTurns", max_turns)):
        if value is not None:
            options[key] = value
    environment.update(CLAUDE_CODE_EXECUTABLE=os.path.abspath(executable), PWD=str(Path(worktree).resolve()))
    if model:
        # The adapter consults ANTHROPIC_MODEL before account/project settings when restoring a model.
        environment["ANTHROPIC_MODEL"] = model
    role_name = "review" if reviewing else "work turn" if role == "work" else role
    failure = role_name + " failed"
    account_errors = ("usage limit", "authentication failed")
    drain_deadline = None
    events_failed = False
    processes = acp.TaskProcesses(task_dir)
    environment[procs.TURN_PROCESS_MARKER] = processes.marker

    def check_active():
        if stopped():
            processes.interrupt()
            raise InterruptedError
        if deadline is not None and clock.CLOCK.monotonic() >= deadline:
            processes.interrupt()
            raise TimeoutError
        if drain_deadline is not None and time.monotonic() >= drain_deadline:
            processes.interrupt()
            raise ValueError("Claude ACP did not finish shutting down")

    def notification(method, params):
        nonlocal events_failed, drain_deadline
        if method != "_claude/sdkMessage":
            return
        event = params.get("message")
        if task_dir is not None and not events_failed:
            line = json.dumps(event, ensure_ascii=False).encode().replace(token.encode(), b"[REDACTED]")
            events_failed = not _write_event(task_dir, line)
        if (isinstance(event, dict) and event.get("type") == "result"
                and (event.get("subtype") != "success" or event.get("is_error") is not False)):
            event = dict(event, is_error=True)
        _record_event(event, response, token, account, model, reviewing, role)
        # The ACP session, not a backend event or a replay, owns the durable cursor.
        response["telemetry"]["session_id"] = client.session_id
        if progress:
            progress(response["telemetry"])
        if response["reason"] in account_errors and drain_deadline is None:
            drain_deadline = time.monotonic() + procs.GROUP_STEPS[0][1]
            processes.interrupt()
            client.cancel()

    telemetry = response["telemetry"]
    mode = "default" if read_only else "bypassPermissions"
    client = acp.AcpClient(["claude-agent-acp"], worktree, lambda update: None, lambda params: None,
                           check_active=check_active, on_notification=notification, env=environment,
                           stderr=subprocess.DEVNULL)
    try:
        with processes, client:
            processes.leader = client.process
            if started:
                started(client.process)
            cursor = client.open_session(session_id, meta=meta, initial_config={"mode": mode})
            if token in cursor:
                raise ValueError("Invalid Claude session ID")
            telemetry["session_id"] = cursor
            if progress:
                progress(telemetry)
            processes.remember_family()
            check_active()
            stop_reason = client.prompt(prompt)
            if stop_reason == "cancelled":
                processes.interrupt()
            drain_deadline = time.monotonic() + procs.GROUP_STEPS[0][1]
        if stop_reason != "end_turn" or client.process.returncode:
            if response["reason"] not in account_errors:
                response["reason"] = failure
        elif response["result"] is None and not response["reason"]:
            response["reason"] = "invalid structured output"
    except (InterruptedError, TimeoutError) as error:
        response.update(outcome="stopped" if isinstance(error, InterruptedError) else "budget_exhausted", result=None)
        return response
    except acp.AcpRequestError as error:
        data = error.data if isinstance(error.data, dict) else {}
        if error.code == -32000 or data.get("errorKind") == "authentication_failed":
            response["reason"] = "authentication failed"
        elif error.code == -32002 and session_id and not client.session_id:
            response["reason"] = "Saved Claude session was not found on the selected account"
        elif data.get("errorKind") == "rate_limit":
            response["reason"] = "usage limit"
            if isinstance(data.get("rateLimit"), dict) and "limited_until" not in response:
                stream_unavailable({"type": "rate_limit_event", "rate_limit_info": data["rateLimit"]},
                                   account["name"], model=model, limit=response)
        elif response["reason"] not in account_errors:
            response["reason"] = failure
    except FileNotFoundError:
        response["reason"] = "Claude ACP adapter was not found"
        return response
    except (ValueError, OSError):
        if response["reason"] not in account_errors:
            response["reason"] = failure
    if response["reason"] is None:
        response["outcome"] = "completed"
    else:
        response["result"] = None
        if not reviewing and response["reason"] not in account_errors:
            response["outcome"] = "failed" if read_only else "unknown"
    return response
