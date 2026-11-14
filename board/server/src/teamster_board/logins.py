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
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(proc.wait(), KILL_SECONDS)
    except asyncio.TimeoutError:
        pass
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await proc.wait()


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

    def start(self, family, account):
        self.snapshot()
        if any(self.rows[key]["family"] == family and self.rows[key]["account"] == account
               for key in self.jobs):
            return error(409, "Вход уже идёт")
        if len(self.jobs) >= 2:
            return error(429, "Too many sign-ins")
        identifier = uuid.uuid4().hex
        row = {"id": identifier, "family": family, "account": account, "stage": "starting",
               "started_at": time.time(), "finished_at": None, "url": None, "code": None,
               "code_expires_at": None, "prompt": False, "output": [], "status": None,
               "ok": None, "message": None, "error": None}
        self.rows[identifier] = row
        initial = copy.deepcopy(row)
        self.publish({"type": "login", "login": initial})
        job = asyncio.create_task(self._run(row))
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

    async def _events(self, stream, row):
        # Discard oversized/non-JSON lines without buffering unbounded tool output.
        pending, oversized, result = b"", False, None
        while chunk := await stream.read(8192):
            parts = chunk.split(b"\n")
            for index, part in enumerate(parts):
                if not oversized:
                    pending += part
                    oversized = len(pending) > 64 * 1024
                if index == len(parts) - 1:
                    continue
                if not oversized and result is None:
                    result = self._event(pending, row)
                pending, oversized = b"", False
        return result

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

    async def _run(self, row):
        proc, readers, tail = None, [], bytearray()
        try:
            command = "login" if row["family"] == "codex" else "claude-login"
            proc = await asyncio.create_subprocess_exec(
                "python3", "-I", str(self.script), command, row["account"], "--events",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, start_new_session=True, cwd=Path.home(),
            )
            self.processes[row["id"]] = proc
            readers = [asyncio.create_task(self._events(proc.stdout, row)),
                       asyncio.create_task(self._stderr(proc.stderr, tail)),
                       asyncio.create_task(proc.wait())]
            done, pending = await asyncio.wait(readers, timeout=LOGIN_TIMEOUT,
                                               return_when=asyncio.FIRST_EXCEPTION)
            if pending:
                # Surface reader failures before reporting a timeout.
                for reader in done:
                    reader.result()
                raise asyncio.TimeoutError
            result = readers[0].result()
            readers[1].result()
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
