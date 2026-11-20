"""One human-driven ACP session per task chat WebSocket."""

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path

import anyio
from fastapi import WebSocketDisconnect

from .actions import BODY_LIMIT, error, same_origin, string
from .store import Record, Store, text


PROTOCOL = "teamster-board-chat"
AGENTS = {
    "opencode": ("opencode", "acp"),
    "codex": ("codex-acp",),
    "claude": ("claude-agent-acp",),
}


def _worktree(state, root, slug):
    repo = Path(text(state.get("repo")) or "")
    saved = Path(text(state.get("worktree")) or "")
    missing = "Restore this task's worktree or open a task with an available worktree."
    if not repo.is_absolute() or not saved.is_absolute():
        raise ValueError(missing)
    try:
        # The worktrees root can be a migration symlink. Below it, only this
        # task's own checkout may be opened, even when another task uses the same repo.
        expected = root.resolve() / f"claude-{slug}" / repo.name
        cwd = saved.resolve(strict=True)
        if cwd != expected or Store._file(cwd, ".git") is None:
            raise ValueError(missing)
        common = subprocess.check_output(
            ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
            stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
        )
        if Path(os.fsdecode(common.rstrip(b"\n"))).parent != repo.resolve():
            raise ValueError(missing)
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        raise ValueError(missing) from exc
    return cwd


def _resolve_target(store, worktrees_path, slug):
    if not store._safe_slug(slug) or store.tasks_path.is_symlink():
        raise ValueError("Open a local Teamster task with an available worktree.")
    record = Record(store.tasks_path / slug, archived=False)
    store._read_state(record)
    state = record.state
    if state.get("slug") != slug or state.get("kind", "work") not in ("work", "review"):
        raise ValueError("Open a local Teamster work or review task with an available worktree.")
    cwd = _worktree(state, worktrees_path, slug)
    executor = text(state.get("executor", "codex")) or "unknown"
    path = os.pathsep.join(entry for entry in os.get_exec_path() if os.path.isabs(entry))
    for name in dict.fromkeys([executor, *AGENTS]):
        command = AGENTS.get(name)
        if command and (executable := shutil.which(command[0], path=path)):
            return cwd, [executable, *command[1:]], executor, " ".join(command)
    raise ValueError("Install codex-acp, claude-agent-acp or OpenCode on the Board server's PATH, then reopen the chat.")


async def _converse(socket, proc, agent, executor):
    expected = None

    async def from_agent():
        nonlocal expected
        while line := await proc.stdout.readline():
            event = json.loads(line)
            kind = event["type"]
            if kind == "ready":
                event.update(agent=agent, executor=executor)
            if kind in ("ready", "done"):
                expected = "prompt"
            elif kind == "permission":
                expected = "permission"
            elif kind == "error":
                raise ValueError(event["message"])
            await socket.send_json(event)
        raise ValueError("The agent connection closed. Check the Board server log "
                         "and that teamster supports acp --events.")

    async def from_browser():
        nonlocal expected
        while True:
            frame = await socket.receive()
            if frame["type"] == "websocket.disconnect":
                return
            raw = frame.get("text")
            if raw is None or len(raw.encode()) > BODY_LIMIT:
                raise ValueError("Expected a chat message within the Board size limit.")
            msg = json.loads(raw)
            if expected is None or not isinstance(msg, dict) or msg.get("type") != expected:
                raise ValueError("Unexpected chat message.")
            fields = {"type", "text"} if expected == "prompt" else {"type", "id", "optionId"}
            if set(msg) != fields:
                raise ValueError("Invalid chat message fields.")
            if expected == "prompt":
                msg["text"] = string(msg, "text", 8000, required=True)
            # The CLI checks the request ID and choice against the agent's pending options.
            expected = None
            proc.stdin.write((json.dumps(msg) + "\n").encode())
            await proc.stdin.drain()

    tasks = [asyncio.create_task(from_agent()), asyncio.create_task(from_browser())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        with anyio.CancelScope(shield=True):
            await asyncio.gather(*tasks, return_exceptions=True)


async def task_chat(socket, slug, board):
    if (board.settings.read_only or not same_origin(socket)
            or PROTOCOL not in socket.scope["subprotocols"]):
        await socket.send_denial_response(error(403, "forbidden"))
        return

    await socket.accept(subprotocol=PROTOCOL)
    proc = None
    try:
        if not board.actions.command:
            raise ValueError("Install teamster with ACP support on the Board server and reopen the chat.")
        cwd, argv, executor, agent = await asyncio.to_thread(
            _resolve_target, board.store, board.actions.worktrees_path, slug)
        with anyio.CancelScope(shield=True):
            proc = await asyncio.create_subprocess_exec(
                board.actions.command, "acp", "--events", "--repo", str(cwd), "--", *argv,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, cwd=Path.home(),
                limit=1024 * 1024, start_new_session=True,
            )
        await _converse(socket, proc, agent, executor)
    except WebSocketDisconnect:
        pass
    except (ValueError, KeyError, OSError, RecursionError) as exc:
        try:
            await socket.send_json({"type": "error", "message": str(exc)})
            await socket.close(code=1011)
        except WebSocketDisconnect:
            pass
    finally:
        if proc is not None:
            # The CLI handles SIGTERM even inside an ACP call, settling any
            # permission request and reaping the agent's entire process group.
            with anyio.CancelScope(shield=True):
                if proc.returncode is None:
                    try:
                        proc.terminate()
                    except ProcessLookupError:
                        pass
                await proc.communicate()
