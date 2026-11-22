"""Process execution, signaling and bounded termination."""
import ctypes
import os
import re
import select
import signal
import struct
import subprocess
import sys
import time
from pathlib import Path


# Older Teamster supervisors already clear this key when a command starts a new task.
TURN_PROCESS_MARKER = "TEAMSTER_DUTY_PROCESS"


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


def process_marker(pid):
    prefix = (TURN_PROCESS_MARKER + "=").encode()
    return next((entry[len(prefix):].decode("ascii") for entry in process_environment(pid)
                 if entry.startswith(prefix) and re.fullmatch(b"[0-9a-f]{32}", entry[len(prefix):])), None)


def _darwin_pids(kind, value):
    # Sandboxed processes cannot exec the setuid /bin/ps. libproc returns byte counts.
    listpids = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True).proc_listpids
    size = listpids(kind, value, None, 0)
    while size > 0:
        pids = (ctypes.c_int * (size // ctypes.sizeof(ctypes.c_int)))()
        used = listpids(kind, value, pids, ctypes.sizeof(pids))
        if used < 0:
            break
        if used < size:
            return pids[:used // ctypes.sizeof(ctypes.c_int)]
        size *= 2
    raise OSError(ctypes.get_errno(), "Could not enumerate user processes")


def _darwin_ids(pid):
    # XNU PROC_PIDUNIQIDENTIFIERINFO. The original parent's unique ID survives reparenting.
    info = ctypes.create_string_buffer(56)
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
    if libproc.proc_pidinfo(pid, 17, 0, info, len(info)) == len(info):
        return struct.unpack_from("=QQ", info, 16)
    return None, None


def boot_session():
    """Darwin process unique IDs are valid only until the next boot."""
    value = ctypes.create_string_buffer(64)
    size = ctypes.c_size_t(len(value))
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    if library.sysctlbyname(b"kern.bootsessionuuid", value, ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "Could not identify the current boot")
    return value.value.decode("ascii")


def backend_ids(pid, marker):
    """Remember the adapter's family at session admission, before it can launch user commands."""
    parents = set()
    pending = [pid]
    entry = os.fsencode(TURN_PROCESS_MARKER + "=" + marker)
    while pending:
        parent = pending.pop()
        unique, _ = _darwin_ids(parent)
        env = process_environment(parent)
        if unique is not None and unique not in parents and (entry in env or not any(env)):
            parents.add(unique)
            pending.extend(_darwin_pids(6, parent))  # PROC_PPID_ONLY
    return parents


def _user_pids():
    if sys.platform == "darwin":
        return _darwin_pids(4, os.getuid())  # PROC_UID_ONLY
    snapshot = subprocess.run(["ps", "-U", str(os.getuid()), "-o", "pid="],
                              capture_output=True, text=True, check=True)
    return map(int, snapshot.stdout.split())


def marked_processes(marker, parents=None):
    """Find survivors of one invocation, including reparented terminals. Never log environments."""
    if not marker:
        return
    entry = os.fsencode(TURN_PROCESS_MARKER + "=" + marker)
    hidden = {}
    for pid in _user_pids():
        if pid <= 1 or pid == os.getpid():
            continue
        env = process_environment(pid)
        if entry in env:
            if parents is not None:
                unique, _ = _darwin_ids(pid)
                if unique is not None:
                    parents.add(unique)
            yield pid
        elif parents is not None and not any(env):
            # macOS hides system binaries' environments, even /bin/sleep's. Only
            # follow their original lineage. A new Teamster supervisor clears its marker.
            unique, parent = _darwin_ids(pid)
            if unique is not None:
                hidden[unique] = pid, parent
    while hidden:
        children = {unique for unique, (_, parent) in hidden.items() if parent in parents}
        if not children:
            break
        parents.update(children)
        for unique in children:
            pid, _ = hidden.pop(unique)
            if _darwin_ids(pid)[0] == unique:
                yield pid


def end_marked_processes(marker, parents=None):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in marked_processes(marker, parents):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        time.sleep(0.05)


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
