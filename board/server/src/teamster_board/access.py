"""Bound disk access probes to one pending daemon thread per device."""

import os
import threading


_lock = threading.Lock()
_pending = set()


def readable(path, timeout=3.0) -> bool | None:
    try:
        device = os.stat(path).st_dev
    except OSError:
        return False
    done = threading.Event()
    result = [None]

    def probe():
        try:
            descriptor = os.open(path, os.O_RDONLY)
            os.close(descriptor)
            result[0] = True
        except OSError:
            result[0] = False
        finally:
            with _lock:
                _pending.remove(device)
                done.set()

    with _lock:
        if device in _pending:
            return None
        _pending.add(device)
        threading.Thread(target=probe, daemon=True).start()
    return result[0] if done.wait(timeout) else None
