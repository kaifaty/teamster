"""Run one stop-signal scenario in a fresh process and print its measurements as JSON.

Usage: python -I stop_signal_child.py SCRIPT SCENARIO. The parent sets a temporary home.
"""
import faulthandler
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time
from types import SimpleNamespace
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker_loader import load_worker


# A deadlocked handler ends the process with a traceback. The swept sleeps last
# 30 s, so one lost wakeup still ends on its run's assertion, under this bound.
DEADLINE = time.monotonic() + 90
faulthandler.dump_traceback_later(90, exit=True)
worker = load_worker(name="stop_signal_worker", script=sys.argv[1])


def armed():
    stop = worker.procs.StopSignal()
    stop.arm()
    signal.signal(signal.SIGINT, lambda signum, frame: stop.request())
    return stop


def later(delay, signum):
    """Send signum to this process from another thread; return the send times."""
    sent = []

    def send():
        sent.append(time.monotonic())
        os.kill(os.getpid(), signum)
    timer = threading.Timer(delay, send)
    timer.start()
    return timer, sent


def timed(sleep, seconds):
    started = time.monotonic()
    result = sleep(seconds)
    return result, time.monotonic() - started


def traced(sleep, seconds, position=None):
    """Call sleep(seconds) under a line tracer for the frames it enters.

    A handled SIGUSR1 at 0.5 s wakes sleep once, so the lines that run after a
    wakeup are swept too. With a position, raise SIGINT at that line event.
    Without one, count the line events until sleep blocks again; a SIGINT from
    another thread then ends it.
    """
    lines = [0]
    fired = []
    handled = []
    signal.signal(signal.SIGUSR1, lambda signum, frame: handled.append(signum))

    def local(frame, event, arg):
        if fired:
            return None
        if event == "line":
            lines[0] += 1
            if lines[0] == position:
                fired.append(position)
                signal.raise_signal(signal.SIGINT)
        return local

    def send():
        time.sleep(0.5)
        os.kill(os.getpid(), signal.SIGUSR1)
        if position is None:
            while not handled:
                time.sleep(0.01)
            time.sleep(1.0)
            fired.append(None)
            os.kill(os.getpid(), signal.SIGINT)
    sender = threading.Thread(target=send)
    sender.start()
    started = time.monotonic()
    # Only frames entered after this call are traced: sleep and its callees.
    sys.settrace(lambda frame, event, arg: None if fired else local)
    try:
        result = sleep(seconds)
    finally:
        sys.settrace(None)
    elapsed = time.monotonic() - started
    sender.join()
    return {"position": position, "lines": lines[0], "fired": bool(fired), "result": result, "elapsed": elapsed}


def sweep(run):
    """Calibrate with run(None), then run every counted line position once."""
    runs = [run(None)]
    for position in range(1, runs[0]["lines"] + 1):
        runs.append(run(position))
    return runs


def requested_before():
    stop = armed()
    stop.request()
    return dict(zip(("result", "elapsed"), timed(stop.sleep, 30)))


def signal_during_select():
    stop = armed()
    timer, sent = later(0.1, signal.SIGINT)
    started = time.monotonic()
    result = stop.sleep(30)
    returned = time.monotonic()
    timer.join()
    return {"result": result, "sent_after": sent[0] - started, "returned_after_signal": returned - sent[0]}


def primitive_sweep():
    return sweep(lambda position: traced(armed().sleep, 30, position))


def other_signal():
    stop = armed()
    handled = []
    signal.signal(signal.SIGUSR1, lambda signum, frame: handled.append(time.monotonic()))
    calls = []
    real_select = worker.procs.select.select

    def counted(*args):
        calls.append(args[-1])
        return real_select(*args)
    timer, _ = later(0.1, signal.SIGUSR1)
    with mock.patch.object(worker.procs.select, "select", counted):
        first = timed(stop.sleep, 2)
        first_returned = time.monotonic()
        timer.join()
        first_calls = len(calls)
        # Measure the later sleep only when the signal was handled within the first.
        later_sleep = timed(stop.sleep, 0.3) if handled and handled[0] < first_returned else None
    return {"first": first, "first_selects": first_calls, "handled_in_first": later_sleep is not None,
            "later": later_sleep, "later_selects": len(calls) - first_calls}


def supervisor_sweep():
    slug = "stop-sweep"
    (worker.config.TASKS / slug).mkdir(parents=True)

    def run(position):
        worker.task_state.write_state({
            "slug": slug, "kind": "scout", "repo": str(worker.config.DATA_HOME),
            "worktree": str(worker.config.DATA_HOME), "turns": 1, "pid": os.getpid(),
            "pending": {"prompt": "sleep", "effort": None}, "stop_request": {"pid": os.getpid()}})
        measured = {}

        def work_turn(st, cfg, prompt, effort, current_message, stopped, sleep):
            st["outcome"] = "sleeping"
            measured.update(traced(sleep, 30, position))
        # Longer than the swept sleep, so a lost wakeup ends on the parent's assertion.
        faulthandler.dump_traceback_later(45, exit=True)
        with mock.patch.object(worker.turns, "work_turn", work_turn):
            worker.supervisor.cmd__run(SimpleNamespace(slug=slug))
        faulthandler.dump_traceback_later(max(1, DEADLINE - time.monotonic()), exit=True)
        measured["outcome"] = worker.task_state.load(slug)["outcome"]
        return measured
    return sweep(run)


SCENARIOS = {function.__name__: function for function in (
    requested_before, signal_during_select, primitive_sweep, other_signal, supervisor_sweep)}


if __name__ == "__main__":
    print(json.dumps(SCENARIOS[sys.argv[2]]()))
