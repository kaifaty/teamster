"""Interactive account sign-ins through the worker's JSON-line event interface."""

import asyncio
import copy
import json
import os
import signal
import time
import unicodedata
import uuid
from pathlib import Path

from .actions import error
from .store import number

LOGIN_TIMEOUT = 16 * 60
KILL_SECONDS = 3
RETENTION_SECONDS = 600
FINISHED = {"done", "failed", "cancelled"}


async def stop_process(proc):
    """Terminate the whole session, including children holding the pipes open."""
    def stopped():
        return proc.returncode is not None and proc.stdout.at_eof() and proc.stderr.at_eof()

    if stopped():
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        deadline = time.monotonic() + KILL_SECONDS
        while not stopped() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
    finally:
        if not stopped():
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        await proc.wait()


async def _wait_exit(proc):
    # Process.wait() may wait for inherited pipes even after the direct child exits.
    while proc.returncode is None:
        await asyncio.sleep(0.01)


class Logins:
    def __init__(self, script, publish, refresh):
        self.script = script
        self.publish = publish
        self.refresh = refresh
        self.rows = {}
        self.jobs = {}
        self.processes = {}

    def snapshot(self):
        cutoff = time.time() - RETENTION_SECONDS
        for identifier, row in list(self.rows.items()):
            if row["finished_at"] is not None and row["finished_at"] < cutoff and identifier not in self.jobs:
                del self.rows[identifier]
        return copy.deepcopy(list(self.rows.values()))

    def _change(self, row, **fields):
        if all(row[key] == value for key, value in fields.items()):
            return
        row.update(fields)
        self.publish({"type": "login", "login": copy.deepcopy(row)})

    def _finish(self, row, stage, **fields):
        self._change(row, stage=stage, finished_at=time.time(), prompt=False, **fields)

    def start(self, family, account, *, new=False):
        self.snapshot()
        active = [row for row in self.rows.values() if row["stage"] not in FINISHED]
        for row in active:
            if row["family"] == family and row["account"] == account:
                if new:
                    return {"ok": True, "login": copy.deepcopy(row)}
                return error(409, "Вход уже идёт")
        if len(active) >= 2:
            return error(429, "Too many sign-ins")
        identifier = uuid.uuid4().hex
        row = {"id": identifier, "family": family, "account": account, "stage": "starting",
               "started_at": time.time(), "finished_at": None, "url": None, "code": None,
               "code_expires_at": None, "prompt": False, "output": [], "status": None,
               "ok": None, "message": None, "error": None}
        self.rows[identifier] = row
        initial = copy.deepcopy(row)
        self.publish({"type": "login", "login": initial})
        job = asyncio.create_task(self._run(row, new))
        self.jobs[identifier] = job
        job.add_done_callback(lambda _: self.jobs.pop(identifier, None))
        return {"ok": True, "login": initial}

    def _find(self, data):
        identifier = data.get("id")
        if not isinstance(identifier, str) or not identifier:
            return None, error(400, "Invalid id")
        self.snapshot()
        row = self.rows.get(identifier)
        if row is None:
            return None, error(404, "Sign-in not found")
        if row["stage"] in FINISHED:
            return None, error(409, "Sign-in has finished")
        return row, None

    async def input(self, data):
        row, failure = self._find(data)
        if failure is not None:
            return failure
        if row["family"] != "claude":
            return error(409, "Codex sign-in does not accept input")
        text = data.get("text")
        if not isinstance(text, str):
            return error(400, "Invalid text")
        text = text.strip()
        if not 1 <= len(text) <= 512 or any(unicodedata.category(char) == "Cc" for char in text):
            return error(400, "Invalid text")
        proc = self.processes.get(row["id"])
        if proc is None or proc.returncode is not None:
            return error(409, "Sign-in is not ready for input")
        try:
            proc.stdin.write((text + "\n").encode("utf-8"))
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            return error(409, "Sign-in input has closed")
        self._change(row, prompt=False)
        return {"ok": True}

    def cancel(self, data):
        row, failure = self._find(data)
        if failure is not None:
            return failure
        self._finish(row, "cancelled")
        self.jobs[row["id"]].cancel()
        return {"ok": True}

    async def close(self):
        jobs = list(self.jobs.values())
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)

    async def _stderr(self, stream, tail):
        while chunk := await stream.read(8192):
            tail.extend(chunk)
            del tail[:-2048]

    async def _events(self, stream, row, result):
        # Discard oversized/non-JSON lines without buffering unbounded tool output.
        pending, oversized = b"", False
        while chunk := await stream.read(8192):
            parts = chunk.split(b"\n")
            for index, part in enumerate(parts):
                if not oversized:
                    pending += part
                    oversized = len(pending) > 64 * 1024
                if index == len(parts) - 1:
                    continue
                if not oversized and not result.done():
                    event = self._event(pending, row)
                    if event is not None:
                        result.set_result(event)
                pending, oversized = b"", False

    def _event(self, line, row):
        if row["stage"] in FINISHED:
            return None
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError, RecursionError):
            return None
        if not isinstance(event, dict):
            return None
        kind = event.get("event")
        if kind == "output" and isinstance(event.get("text"), str):
            lines = [line[:300] for line in event["text"].splitlines()] or [""]
            self._change(row, output=(row["output"] + lines)[-40:])
        elif kind == "open" and isinstance(event.get("url"), str):
            self._change(row, url=event["url"], stage="waiting")
        elif (kind == "code" and isinstance(event.get("code"), str)
              and number(event.get("expires_at")) is not None):
            self._change(row, code=event["code"], code_expires_at=event["expires_at"], stage="waiting")
        elif kind == "prompt":
            self._change(row, prompt=True)
        elif kind == "stage" and event.get("stage") in ("saving", "checking"):
            self._change(row, stage=event["stage"])
        elif (kind == "result" and type(event.get("ok")) is bool
              and isinstance(event.get("status"), str) and isinstance(event.get("message"), str)):
            return event
        return None

    async def _run(self, row, new):
        proc, readers, tail = None, [], bytearray()
        try:
            command = "login" if row["family"] == "codex" else "claude-login"
            proc = await asyncio.create_subprocess_exec(
                "python3", "-I", str(self.script), command, row["account"], "--events", *(["--new"] if new else []),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, start_new_session=True, cwd=Path.home(),
            )
            self.processes[row["id"]] = proc
            result = asyncio.get_running_loop().create_future()
            readers = [asyncio.create_task(self._events(proc.stdout, row, result)),
                       asyncio.create_task(self._stderr(proc.stderr, tail))]
            drained = asyncio.gather(*readers)
            exited = asyncio.create_task(_wait_exit(proc))
            readers.extend((drained, exited))
            deadline = time.monotonic() + LOGIN_TIMEOUT
            done, _ = await asyncio.wait([exited, drained], timeout=LOGIN_TIMEOUT,
                                         return_when=asyncio.FIRST_COMPLETED)
            if not done:
                raise asyncio.TimeoutError
            for reader in done:
                reader.result()
            if exited not in done:
                done, _ = await asyncio.wait([exited], timeout=max(0, deadline - time.monotonic()))
                if not done:
                    raise asyncio.TimeoutError
            if not result.done():
                await asyncio.wait([result, drained], timeout=2, return_when=asyncio.FIRST_COMPLETED)
            if drained.done():
                drained.result()
            result = result.result() if result.done() else None
            if result is None:
                self._finish(row, "failed", ok=False,
                             error=tail.decode("utf-8", "replace").strip() or "Sign-in exited without a result")
            else:
                success = result["ok"]
                self._finish(row, "done" if success else "failed", ok=success,
                             status=result["status"], message=result["message"],
                             error=None if success else tail.decode("utf-8", "replace").strip()
                             or result["message"] or "Sign-in failed")
                if success:
                    self.refresh()
        except asyncio.TimeoutError:
            self._finish(row, "failed", ok=False, error="Время на вход вышло")
        except asyncio.CancelledError:
            if row["stage"] not in FINISHED:
                self._finish(row, "cancelled")
        except Exception as exc:
            self._finish(row, "failed", ok=False,
                         error=tail.decode("utf-8", "replace").strip() or str(exc) or "Sign-in failed")
        finally:
            if proc is not None:
                await stop_process(proc)
            for reader in readers:
                reader.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
            self.processes.pop(row["id"], None)
