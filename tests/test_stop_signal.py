"""Check that a stop signal always ends the supervisor's sleep, whenever it arrives."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


# Isolated Python omits the script directory from its import path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from worker_loader import SCRIPT, load_worker


CHILD = Path(__file__).resolve().with_name("stop_signal_child.py")
# A group leader that SIGINT ends, with a child that ignores SIGINT and SIGTERM.
GROUP = r"""import subprocess, sys, time
child = subprocess.Popen([sys.executable, "-I", "-c", "import signal, time; "
                          "signal.signal(signal.SIGINT, signal.SIG_IGN); "
                          "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                          "print('ready', flush=True); time.sleep(60)"], stdout=subprocess.PIPE, text=True)
assert child.stdout.readline() == "ready\n"
print(child.pid, flush=True)
time.sleep(60)
"""


class StopSignalTests(unittest.TestCase):
    def scenario(self, name):
        """Run one scenario of stop_signal_child.py in its own process and temporary home."""
        directory = tempfile.TemporaryDirectory(prefix="codex-stop-signal-")
        self.addCleanup(directory.cleanup)
        environment = {key: value for key, value in os.environ.items() if not key.startswith("TEAMSTER_")}
        environment["CODEX_TASK_HOME"] = directory.name
        result = subprocess.run([sys.executable, "-I", str(CHILD), str(SCRIPT), name], env=environment,
                                text=True, capture_output=True, timeout=150)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def assert_sweep(self, runs, outcome=None):
        calibration, *positions = runs
        # The calibration run counts the lines before sleep blocks; a SIGINT during select ends it.
        self.assertTrue(calibration["result"], calibration)
        self.assertGreater(calibration["lines"], 0, calibration)
        self.assertEqual([run["position"] for run in positions], list(range(1, calibration["lines"] + 1)))
        for run in runs:
            with self.subTest(position=run["position"]):
                self.assertTrue(run["fired"], run)
                self.assertTrue(run["result"], run)
                if run["position"] is not None:
                    # The swept sleep lasts 30 s; the bound tolerates a loaded machine.
                    self.assertLess(run["elapsed"], 5, run)
                if outcome is not None:
                    self.assertEqual(run["outcome"], outcome, run)

    def test_stop_requested_before_sleep_returns_at_once(self):
        run = self.scenario("requested_before")
        self.assertTrue(run["result"])
        self.assertLess(run["elapsed"], 5)

    def test_sigint_during_select_ends_a_long_sleep(self):
        run = self.scenario("signal_during_select")
        self.assertTrue(run["result"])
        self.assertLess(run["returned_after_signal"], 5)

    def test_sigint_at_every_line_of_sleep_is_never_missed(self):
        self.assert_sweep(self.scenario("primitive_sweep"))

    def test_other_handled_signal_neither_ends_nor_spins_sleep(self):
        run = self.scenario("other_signal")
        # SIGUSR1 is sent 0.1 s into a 2 s sleep; a late timer would land it in the later sleep.
        self.assertTrue(run["handled_in_first"], run)
        (first, first_elapsed), (later, later_elapsed) = run["first"], run["later"]
        self.assertFalse(first)
        self.assertGreaterEqual(first_elapsed, 2)
        self.assertFalse(later)
        self.assertGreaterEqual(later_elapsed, 0.3)
        # One select call per wakeup, plus at most one for a timeout that returns a little early.
        self.assertLessEqual(run["first_selects"], 3, run)
        self.assertLessEqual(run["later_selects"], 2, run)

    def test_supervisor_stop_at_every_line_of_its_sleep_records_stopped(self):
        # The supervisor's real handler and sleep, with the turn replaced by one sleep:
        # a deadlocked handler ends the child with a faulthandler traceback.
        self.assert_sweep(self.scenario("supervisor_sweep"), outcome="stopped")


    def test_end_group_waits_for_a_child_that_outlives_its_leader(self):
        directory = tempfile.TemporaryDirectory(prefix="codex-end-group-")
        self.addCleanup(directory.cleanup)
        environment = {key: value for key, value in os.environ.items() if not key.startswith("TEAMSTER_")}
        environment["CODEX_TASK_HOME"] = directory.name
        worker = load_worker(environment, clear=True)
        leader = subprocess.Popen([sys.executable, "-I", "-c", GROUP], stdout=subprocess.PIPE, text=True,
                                  start_new_session=True)
        child = int(leader.stdout.readline())
        leader.stdout.close()

        def kill_child():
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass

        self.addCleanup(kill_child)
        os.kill(child, 0)
        # The leader is not end_group's child in teamster: reap it here as its parent would.
        reaper = threading.Thread(target=leader.wait, daemon=True)
        reaper.start()
        with mock.patch.object(worker.procs, "GROUP_STEPS",
                               ((signal.SIGINT, 2), (signal.SIGTERM, 1), (signal.SIGKILL, 10))):
            worker.procs.end_group(leader.pid)
        reaper.join(10)
        self.assertIsNotNone(leader.returncode)
        # end_group returns only once SIGKILL has ended the child as well. The dead child may stay a zombie
        # until init reaps it, and macOS then answers killpg with EPERM, so wait for the child itself to go.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            self.fail("the child is still there after end_group")


if __name__ == "__main__":
    unittest.main(verbosity=2)
