"""Write state.json fixtures of this version with the fake Codex, in a temporary home.

Run with python3 -I tests/make_state_fixtures.py tests/fixtures/state-<version> on the
release before the one that changes state fields. Paths are rewritten to ROOT_PLACEHOLDER
and the live pid of the sleeping supervisor to a pid that cannot exist.
"""
import json
import sys
import time
import unittest
from pathlib import Path


# Isolated Python omits the script directory from its import path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from rotation_support import IMPOSSIBLE_PID, RotationTestCase


ROOT_PLACEHOLDER = "/teamster-fixture"
OUTPUT = None


class StateFixtures(RotationTestCase):
    def save(self, slug):
        state = self.state(slug)
        for key, value in list(state.items()):
            if (key == "pid" or key.endswith("_pid")) and isinstance(value, int):
                state[key] = IMPOSSIBLE_PID
        text = json.dumps(state, ensure_ascii=False, indent=2).replace(str(self.root), ROOT_PLACEHOLDER)
        target = OUTPUT / slug / "state.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text + "\n", encoding="utf-8")

    def test_write_fixtures(self):
        self.configure(language="en")
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "reply": self.work_result()},
            {"mode": "complete", "reply": "Verified: tracked.txt:1 is the only input."},
            {"mode": "complete", "reply": self.work_result()},
            {"mode": "complete", "reply": self.review_result()}])
        self.start("work-done")
        self.wait("work-done")
        self.save("work-done")
        self.cli("scout", "scout", "Where does tracked.txt enter?", "--repo", str(self.repo))
        self.wait("scout")
        self.save("scout")
        self.start("review", "--review")
        self.wait("review")
        self.save("review")
        reset = int(time.time()) + 30 * 3600
        self.exhaust_accounts((self.home, "A", reset), (self.other, "B", reset + 3600))
        self.start("sleeping")
        self.wait("sleeping")
        self.assertEqual(self.state("sleeping")["outcome"], "sleeping")
        self.save("sleeping")
        self.cli("stop", "sleeping")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python3 -I tests/make_state_fixtures.py tests/fixtures/state-<version>")
    OUTPUT = Path(sys.argv[1]).resolve()
    if OUTPUT.exists():
        sys.exit(f"{OUTPUT} exists; fixtures of a released version are never rewritten")
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(StateFixtures))
    sys.exit(0 if result.wasSuccessful() else 1)
