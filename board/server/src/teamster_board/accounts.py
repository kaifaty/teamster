"""Cached snapshots from the worker's read-only accounts and report commands."""

import asyncio
import json
import logging
import re
import time
from pathlib import Path

ACCOUNTS_TIMEOUT = 60
OUTPUT_LIMIT = 1024 * 1024
REPORT_SECONDS = 60
REPORT_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
REPORT_DIMENSIONS = {"task-type", "effort", "model", "executor", "reviewer"}
LOGGER = logging.getLogger(__name__)


async def _read_output(stream, truncate=False):
    output = bytearray()
    while chunk := await stream.read(64 * 1024):
        remaining = OUTPUT_LIMIT - len(output)
        output.extend(chunk[:remaining])
        if len(chunk) > remaining and not truncate:
            raise ValueError("output exceeds 1 MiB")
    return bytes(output)


async def _snapshot(script, command, arguments, previous):
    proc = None
    output = None
    readers = []
    data, error = previous, None
    try:
        proc = await asyncio.create_subprocess_exec(
            "python3", "-I", str(script), command, "--json", *arguments,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        readers = [asyncio.create_task(_read_output(proc.stdout)),
                   asyncio.create_task(_read_output(proc.stderr, truncate=True))]
        output = asyncio.gather(*readers, proc.wait())
        # Python 3.10 wait_for can swallow shutdown cancellation as output finishes.
        done, _ = await asyncio.wait([output], timeout=ACCOUNTS_TIMEOUT)
        if not done:
            raise asyncio.TimeoutError
        stdout, stderr, _ = output.result()
        if stderr:
            LOGGER.warning("%s stderr: %s", command, stderr.decode("utf-8", "replace").strip())
        if proc.returncode:
            detail = stderr.decode("utf-8", "replace").strip() if command == "accounts" else ""
            raise ValueError(detail or f"{command} exited with status {proc.returncode}")
        data = json.loads(stdout)
    except asyncio.TimeoutError:
        error = f"{command} timed out after {ACCOUNTS_TIMEOUT:g} seconds"
    except (OSError, ValueError) as exc:
        error = str(exc)
    finally:
        for reader in readers:
            reader.cancel()
        if output is not None:
            output.cancel()
            await asyncio.gather(output, *readers, return_exceptions=True)
        if proc is not None:
            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            # Process has no public close; descendants may still hold its pipes open.
            proc._transport.close()
            waiter = asyncio.create_task(proc.wait())
            try:
                await asyncio.wait([waiter], timeout=2)
            finally:
                waiter.cancel()
                await asyncio.gather(waiter, return_exceptions=True)
    return {"fetched_at": time.time(), "error": error, "data": data}


class Accounts:
    def __init__(self, script: Path, seconds: float):
        self.script = script
        self.seconds = seconds
        self.value = {"fetched_at": None, "error": None, "data": None}
        self._last_started = float("-inf")
        self._lock = asyncio.Lock()

    async def refresh(self, force=False):
        async with self._lock:
            if not force and time.monotonic() - self._last_started < self.seconds:
                return None
            self._last_started = time.monotonic()
            self.value = await _snapshot(self.script, "accounts", (), self.value["data"])
            return self.value


class Reports:
    def __init__(self, script: Path):
        self.script = script
        self._cache = {}
        self._lock = asyncio.Lock()

    async def get(self, since: str, by: str | None = None):
        if not REPORT_DATE.fullmatch(since):
            raise ValueError("since must be YYYY-MM-DD")
        if by is not None and any(part not in REPORT_DIMENSIONS for part in by.split(",")):
            raise ValueError("invalid report dimensions")
        key = (since, by)
        async with self._lock:
            cached = self._cache.get(key)
            if cached is not None and time.monotonic() - cached[0] < REPORT_SECONDS:
                return cached[1]
            arguments = ["--since", since]
            if by is not None:
                arguments.extend(["--by", by])
            value = await _snapshot(self.script, "report", arguments, cached[1]["data"] if cached else None)
            self._cache[key] = (time.monotonic(), value)
            return value
