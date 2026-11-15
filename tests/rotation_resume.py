"""teamster resume: continuing cycles that an external signal cut short."""
import json
import os
import signal
import subprocess
import sys
from pathlib import Path


# Isolated Python omits the script directory from its import path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from rotation_support import PYTHON, SCRIPT, RotationTestCase


class ResumeTests(RotationTestCase):
    def resume(self, *args):
        output = self.cli("resume", *args)
        for line in output.splitlines():
            pid = line.rpartition(", pid ")[2]
            if pid.isdigit():
                self.extra_pids.add(int(pid))
        return output

    def refused(self, *args):
        result = subprocess.run([PYTHON, "-I", str(SCRIPT), *args], cwd=self.repo, env=self.env,
                                text=True, capture_output=True, timeout=30)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return result.stderr

    def interrupt(self, slug, ready):
        self.until(ready, timeout=60)
        os.kill(self.state(slug)["pid"], signal.SIGTERM)
        output = self.wait(slug)
        self.assertEqual(self.state(slug)["outcome"], "interrupted")
        self.assertIn("; continue: teamster resume " + slug, output)
        return output

    def test_resume_work_turn_continues_the_thread_then_the_cycle(self):
        self.configure(language="en")
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "hold", "write_files": {"pending.txt": "unfinished work\n"}},
            {"mode": "complete", "reply": self.work_result()},
            {"mode": "complete", "reply": self.review_result(defects=False)}])
        slug = "resume-work"
        self.start(slug, "--review", "--fix-rounds", "1")
        worktree = Path(self.state(slug)["worktree"])
        self.interrupt(slug, lambda: (worktree / "pending.txt").exists())
        status = self.cli("status")
        self.assertIn(slug, status)
        self.assertIn("interrupted", status)
        self.assertIn("interrupted externally by SIGTERM at ", self.cli("status", slug))
        output = self.resume(slug)
        self.assertIn(f"resumed {slug} from work (turn 1, interrupted by SIGTERM at ", output)
        output = self.wait(slug)
        state = self.state(slug)
        self.assertEqual(state["outcome"], "completed")
        self.assertEqual(state["turns"], 1)
        self.assertEqual([(entry["step"], entry["signal"], entry["turn"]) for entry in state["resumed"]],
                         [("work", "SIGTERM", 1)])
        first, resumed, review = self.invocations()
        self.assert_resumed_same_thread(first, resumed, self.home)
        prompt = resumed["prompt"]
        self.assertIn("cut short by the external signal SIGTERM at ", prompt)
        self.assertIn("through no fault of yours", prompt)
        self.assertIn("uncommitted files: 1; unpushed commits: 0; no PR.", prompt)
        self.assertNotIn("Сохранить весь исходный бриф", prompt)
        self.assertTrue(review["review"])
        self.assertEqual(state["review_result"]["verdict"], "clean")
        self.assertNotIn("interrupted externally", output)
        rows = [row for row in self.telemetry_journal() if row["slug"] == slug and row["phase"] == "turn"]
        self.assertEqual([(row["turn"], row["outcome"]) for row in rows], [(1, "interrupted"), (1, "completed")])
        report = json.loads(self.cli("report", "--slug", slug, "--json"))
        self.assertEqual(report["summary"]["outcomes"], {"completed": 1})
        self.assertEqual(report["tasks"][0]["follow_ups"], 0)
        self.assertIn("nothing to resume", self.resume("--all"))
        self.assertIn("not cut short by a signal", self.refused("resume", slug))

    def test_resume_review_runs_the_review_again(self):
        self.configure(language="en")
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "reply": self.work_result()}, {"mode": "hold"},
            {"mode": "complete", "reply": self.review_result(defects=False)}])
        slug = "resume-review"
        self.start(slug, "--review", "--fix-rounds", "1")
        self.until(lambda: len(self.invocations()) == 2, timeout=60)
        thread = self.invocations()[-1]["thread"]
        self.interrupt(slug, lambda: any(entry["thread"] == thread for entry in self.state(slug)["reviews"]))
        self.assertIn(f"resumed {slug} from review", self.resume(slug))
        self.wait(slug)
        state = self.state(slug)
        work, interrupted, review = self.invocations()
        self.assertTrue(interrupted["review"] and review["review"])
        self.assertNotEqual(review["thread"], interrupted["thread"])
        self.assertEqual(state["outcome"], "completed")
        self.assertEqual(state["review_result"]["verdict"], "clean")
        self.assertEqual(state["resumed"][0]["step"], "review")
        self.assertFalse(state["rounds"])

    def test_resume_fix_round_and_saved_review_without_its_round(self):
        self.configure(language="en")
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "reply": self.work_result()},
            {"mode": "complete", "reply": self.review_result()}, {"mode": "hold"},
            {"mode": "complete", "reply": self.work_result()},
            {"mode": "complete", "reply": self.review_result(defects=False)}])
        slug = "resume-fix"
        self.start(slug, "--review", "--fix-rounds", "2")
        self.interrupt(slug, lambda: len(self.invocations()) == 3)
        state = self.state(slug)
        self.assertEqual((state["cycle"]["step"], len(state["rounds"])), ("fix", 1))
        # The same state just before the fix round: the review is saved, its round not started.
        state.update(kind="review", rounds=[], cycle=dict(state["cycle"], step="review"))
        (self.home / "claude-tasks" / slug / "state.json").write_text(json.dumps(state))
        self.assertIn(f"resumed {slug} from after_review", self.resume(slug))
        self.wait(slug)
        state = self.state(slug)
        invocations = self.invocations()
        self.assertEqual(len(invocations), 5)
        fix = invocations[3]
        self.assertFalse(fix["review"])
        self.assertEqual(fix["thread"], invocations[0]["thread"])
        self.assertIn("Empty input raises an exception", fix["prompt"])
        self.assertNotIn("cut short", fix["prompt"])
        self.assertTrue(invocations[4]["review"])
        self.assertEqual(len(state["rounds"]), 1)
        self.assertEqual(state["rounds"][0]["review"]["findings"][0]["id"], "F1")
        self.assertEqual((state["outcome"], state["auto_fix_stop"]), ("completed", "clean"))

        self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "reply": self.work_result()},
            {"mode": "complete", "reply": self.review_result()}, {"mode": "hold"},
            {"mode": "complete", "reply": self.work_result()},
            {"mode": "complete", "reply": self.review_result(defects=False)}])
        (self.home / "exec-count").unlink()
        slug = "resume-fix-round"
        before = len(self.invocations())
        self.start(slug, "--review", "--fix-rounds", "2")
        self.interrupt(slug, lambda: len(self.invocations()) == before + 3)
        self.assertIn(f"resumed {slug} from fix", self.resume(slug))
        self.wait(slug)
        state = self.state(slug)
        invocations = self.invocations()[before:]
        self.assertEqual(len(invocations), 5)
        self.assert_resumed_same_thread(invocations[2], invocations[3], self.home)
        self.assertIn("cut short by the external signal SIGTERM", invocations[3]["prompt"])
        self.assertTrue(invocations[4]["review"])
        # The interrupted round counts against --fix-rounds; the clean review stops the cycle.
        self.assertEqual(len(state["rounds"]), 1)
        self.assertEqual((state["outcome"], state["auto_fix_stop"]), ("completed", "clean"))

    def test_resume_check_and_ci_rerun_without_an_executor_turn(self):
        self.configure(language="en")
        hold = self.root / "hold"
        hold.touch()
        command = f"if [ -f {hold} ]; then sleep 60; fi"
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "write_files": {"tracked.txt": "implemented\n"}, "commit_files": ["tracked.txt"],
             "push": True, "reply": self.work_result()}])
        self.start("resume-check", "--check", command)
        self.interrupt("resume-check", lambda: self.state("resume-check").get("check_pid"))
        hold.unlink()
        self.assertIn("resumed resume-check from check", self.resume("resume-check"))
        self.wait("resume-check")
        state = self.state("resume-check")
        self.assertEqual([check["outcome"] for check in state["checks"]], ["interrupted", "passed"])
        self.assertEqual(state["outcome"], "completed")
        self.assertEqual(len(self.invocations()), 1)

        hold.touch()
        (self.home / "exec-count").unlink()
        self.start("resume-ci", "--ci-command", command)
        self.interrupt("resume-ci", lambda: (self.state("resume-ci").get("ci") or {}).get("checks"))
        hold.unlink()
        self.assertEqual(self.state("resume-ci")["ci"]["reason"], "stopped")
        self.assertIn("resumed resume-ci from ci", self.resume("resume-ci"))
        output = self.wait("resume-ci")
        state = self.state("resume-ci")
        self.assertEqual((state["ci"]["outcome"], state["ci"]["rounds"], state["outcome"]), ("passed", 0, "completed"))
        self.assertIn(": passed (1/1,", output)
        self.assertEqual(len(self.invocations()), 2)

    def test_resume_after_a_kill_that_left_no_result(self):
        self.configure(language="en")
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "hold"}, {"mode": "complete", "reply": self.work_result()}])
        slug = "resume-killed"
        self.start(slug)
        self.until(lambda: self.state(slug).get("codex_pid"), timeout=60)
        state = self.state(slug)
        # A shutdown kills the supervisor and its worker without a chance to record anything.
        os.kill(state["pid"], signal.SIGKILL)
        os.killpg(state["codex_pid"], signal.SIGKILL)
        self.until(lambda: not self.process_is_live(state["pid"]) and not self.process_is_live(state["codex_pid"]))
        self.assertEqual(self.state(slug)["outcome"], "running")
        status = self.cli("status", slug)
        self.assertNotIn(" running ", status)
        self.assertIn("interrupted externally by an unknown signal (the supervisor left no result) at ", status)
        self.assertIn("continue: teamster resume " + slug, status)
        self.assertIn(f"resumed {slug} from work (turn 1, interrupted by an unknown signal at ", self.resume("--all"))
        self.wait(slug)
        state = self.state(slug)
        self.assertEqual(state["outcome"], "completed")
        self.assertIsNone(state["resumed"][0]["signal"])
        self.assertIn("an external signal (unknown: the supervisor left no result)", self.invocations()[1]["prompt"])

    def test_resume_refuses_stopped_and_running_tasks_and_say_still_continues(self):
        self.configure(language="en")
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "hold"}, {"mode": "hold"}, {"mode": "complete", "reply": self.work_result()}])
        self.start("resume-stopped")
        self.until(lambda: self.state("resume-stopped").get("codex_pid"), timeout=60)
        self.assertIn("still running", self.refused("resume", "resume-stopped"))
        self.cli("stop", "resume-stopped")
        self.wait("resume-stopped")
        self.assertIn("stopped with stop", self.refused("resume", "resume-stopped"))
        self.assertIn("nothing to resume", self.resume("--all"))
        self.cli("say", "resume-stopped", "Hold on.")
        self.interrupt("resume-stopped", lambda: len(self.invocations()) == 2)
        self.cli("say", "resume-stopped", "Continue from the worktree.")
        self.wait("resume-stopped")
        state = self.state("resume-stopped")
        self.assertEqual((state["outcome"], state["turns"]), ("completed", 3))
        self.assertNotIn("resumed", state)
        self.assertIn("Continue from the worktree.", self.invocations()[-1]["prompt"])

    def test_resume_all_continues_parallel_tasks_and_one_other(self):
        self.configure(language="en")
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "hold"}, {"mode": "hold"}, {"mode": "hold"},
            {"mode": "complete", "reply": self.work_result()}])
        self.start("resume-alone")
        self.start("resume-beside", "--parallel")
        self.until(lambda: len(self.invocations()) == 2, timeout=60)
        for slug in ("resume-alone", "resume-beside"):
            self.interrupt(slug, lambda: True)
        self.start("resume-later")
        self.interrupt("resume-later", lambda: len(self.invocations()) == 3)
        output = self.resume("--all")
        self.assertIn("resumed resume-alone from work", output)
        self.assertIn("resumed resume-beside from work", output)
        self.assertIn("waiting: teamster resume resume-later", output)
        for slug in ("resume-alone", "resume-beside"):
            self.wait(slug)
            self.assertEqual(self.state(slug)["outcome"], "completed")
        self.assertEqual(self.state("resume-later")["outcome"], "interrupted")
        self.assertIn("resumed resume-later from work", self.resume("--all"))
        self.wait("resume-later")
        self.assertEqual(self.state("resume-later")["outcome"], "completed")
