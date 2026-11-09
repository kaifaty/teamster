"""Process execution, signaling and bounded termination."""
import os
import select
import signal
import subprocess
import sys
import time


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


def terminate(proc):
    """Interrupt the entire exec group, then bound shutdown even if it ignores signals."""

    for sig, timeout in ((signal.SIGINT, 10), (signal.SIGTERM, 5), (signal.SIGKILL, 5)):
        if not signal_group(proc, sig):
            proc.wait()
            break
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            proc.poll()  # Reap the leader, but also wait for its tool processes.
            if not signal_group(proc, 0):
                return
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
