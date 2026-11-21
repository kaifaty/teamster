"""Process execution, signaling and bounded termination."""
import ctypes
import os
import select
import signal
import subprocess
import sys
import time
from pathlib import Path


def die(msg):
    sys.exit(f"teamster: {msg}")


def sh(cmd, cwd=None, check=True, errors="strict"):
    r = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, errors=errors)
    if check and r.returncode != 0:
        die(f"{' '.join(cmd)} failed:\n{r.stderr.strip() or r.stdout.strip()}")
    return r.stdout.rstrip()


def signal_group(proc, sig):
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS may reject killpg even while the leader is still alive.
        if proc.poll() is not None:
            return False
        if sig:
            try:
                os.kill(proc.pid, sig)
            except ProcessLookupError:
                return False
    return True


# The steps that end a process group: each signal, then how long the group may take to leave.
GROUP_STEPS = ((signal.SIGINT, 10), (signal.SIGTERM, 5), (signal.SIGKILL, 5))


def signal_pgid(pgid, sig):
    """Send sig to the process group pgid; whether anything of it was left to receive it."""
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS may reject killpg even while the leader is still alive.
        try:
            os.kill(pgid, sig)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
    return True


def end_group(pid):
    """Interrupt the process group of ``pid``, which is not our child, then terminate and kill what stays.

    Like terminate, it waits for the whole group: a tool process that ignores SIGINT outlives its leader.
    """
    for sig, timeout in GROUP_STEPS:
        if not signal_pgid(pid, sig):
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not signal_pgid(pid, 0):
                return
            time.sleep(0.05)


def terminate(proc):
    """Interrupt the entire exec group, then bound shutdown even if it ignores signals."""

    for sig, timeout in GROUP_STEPS:
        if not signal_group(proc, sig):
            proc.wait()
            break
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            proc.poll()  # Reap the leader, but also wait for its tool processes.
            if not signal_group(proc, 0):
                return
            time.sleep(0.05)


def process_environment(pid):
    """Read actual environment entries, never flattened argv that could spoof ownership."""
    try:
        if sys.platform == "darwin":
            library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
            mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2, pid.
            size = ctypes.c_size_t()
            if library.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
                return []
            buffer = ctypes.create_string_buffer(size.value)
            if library.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
                return []
            data = buffer.raw[:size.value]
            argc = int.from_bytes(data[:4], sys.byteorder)
            position = data.index(b"\0", 4)
            while position < len(data) and data[position] == 0:
                position += 1
            for _ in range(argc):
                position = data.index(b"\0", position) + 1
            return data[position:].split(b"\0")
        return (Path("/proc") / str(pid) / "environ").read_bytes().split(b"\0")
    except (OSError, ValueError):
        return []


def alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class StopSignal:
    """A stop request that a signal handler can set without taking any lock.

    threading.Event guards its flag with a non-reentrant lock that Event.wait
    holds briefly, so a handler calling set() during that window deadlocks.
    Here the handler only assigns a boolean, and the wakeup fd wakes the sleep:
    the C-level handler writes to it before any Python code runs.
    """

    def __init__(self):
        self.requested = False
        self._read, self._write = os.pipe()
        os.set_blocking(self._read, False)
        os.set_blocking(self._write, False)

    def arm(self):
        """Route signal wakeups to the pipe; call from the main thread before installing handlers."""
        signal.set_wakeup_fd(self._write, warn_on_full_buffer=False)

    def request(self):
        self.requested = True

    def sleep(self, seconds):
        """Wait until seconds pass or a stop is requested; return whether one was."""
        deadline = time.monotonic() + max(0, seconds)
        while not self.requested:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            if select.select([self._read], [], [], left)[0]:
                # Another handled signal, or a stop whose handler has run by
                # the time the loop condition is read again: drain and recheck.
                self._drain()
        return self.requested

    def _drain(self):
        try:
            while os.read(self._read, 512):
                pass
        except BlockingIOError:
            pass
