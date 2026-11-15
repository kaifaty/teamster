"""teamster resume: continuing cycles that an external signal cut short."""
import json
import os
import shlex
import signal
import subprocess
import sys
from pathlib import Path
from unittest import mock


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

    def interrupt(self, slug, ready, signum=signal.SIGTERM):
        self.until(ready, timeout=60)
        os.kill(self.state(slug)["pid"], signum)
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
        # A state without its cycle record still reviews and fixes by the saved --review flag.
        state = self.state(slug)
        self.assertTrue(state.pop("review_after"))
        del state["cycle"]
        legacy = self.home / "claude-tasks" / slug / "state.json"
        legacy.write_text(json.dumps(dict(state, review_after=True)))
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

        # The check fails once, right after the resumed fix round.
        counter = self.root / "check-count"
        command = (f"n=$(cat {shlex.quote(str(counter))} 2>/dev/null || echo 0); n=$((n+1)); "
                   f"echo $n > {shlex.quote(str(counter))}; [ $n -ne 2 ]")
        decisions = [{"id": "F1", "decision": "fixed", "note": "Empty input is skipped."},
                     {"id": "F2", "decision": "rejected", "note": "The slice is intended."}]
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "reply": self.work_result()},
            {"mode": "complete", "reply": self.review_result()}, {"mode": "hold"},
            {"mode": "complete", "write_files": {"tracked.txt": "fixed\n"}, "commit_files": ["tracked.txt"],
             "reply": self.work_result(findings=decisions)},
            {"mode": "complete", "reply": self.work_result()},
            {"mode": "complete", "reply": self.review_result(defects=False)}])
        (self.home / "exec-count").unlink()
        slug = "resume-fix-round"
        before = len(self.invocations())
        self.start(slug, "--review", "--fix-rounds", "2", "--check", command)
        self.interrupt(slug, lambda: len(self.invocations()) == before + 3)
        self.assertIn(f"resumed {slug} from fix", self.resume(slug))
        self.wait(slug)
        state = self.state(slug)
        invocations = self.invocations()[before:]
        self.assertEqual(len(invocations), 6)
        self.assert_resumed_same_thread(invocations[2], invocations[3], self.home)
        self.assertIn("cut short by the external signal SIGTERM", invocations[3]["prompt"])
        self.assertFalse(invocations[4]["review"])
        self.assertTrue(invocations[5]["review"])
        # The interrupted round counts against --fix-rounds and keeps what the resumed turn did.
        first, second = state["rounds"]
        self.assertEqual(first["review"]["findings"][0]["id"], "F1")
        self.assertEqual(first["decisions"], decisions)
        self.assertEqual(len(first["commits"]), 1)
        self.assertEqual(first["check"]["outcome"], "failed")
        self.assertIsNone(second["review"])
        self.assertEqual(second["check"]["outcome"], "passed")
        self.assertEqual((state["outcome"], state["auto_fix_stop"]), ("completed", "clean"))

    def test_resume_review_step_does_not_fix_from_the_previous_review(self):
        worker = self.worker()
        st = {"slug": "resume-step", "review_result": self.review_result(),
              "cycle": {"kind": "work", "effort": None, "step": "review", "ci": False, "pr": "", "angles": 1}}
        self.assertEqual(worker.supervisor.resume_step(st)[1], "after_review")
        # The next review step starts with the base merge check, before review_turn drops the old review.
        with mock.patch.object(worker.task_state, "save"):
            worker.task_state.mark_step(st, "review")
        self.assertEqual(worker.supervisor.resume_step(st)[1], "review")

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
            {"mode": "hold"}, {"mode": "hold"}, {"mode": "hold"}, {"mode": "complete", "reply": self.work_result()}])
        self.start("resume-stopped")
        self.until(lambda: self.state("resume-stopped").get("codex_pid"), timeout=60)
        self.assertIn("still running", self.refused("resume", "resume-stopped"))
        self.cli("stop", "resume-stopped")
        self.wait("resume-stopped")
        self.assertIn("stopped with stop", self.refused("resume", "resume-stopped"))
        self.assertIn("nothing to resume", self.resume("--all"))
        self.cli("say", "resume-stopped", "Hold on.")
        self.interrupt("resume-stopped", lambda: len(self.invocations()) == 2)
        # Beside a live supervisor the task waits, and no new process starts.
        self.start("resume-live")
        self.until(lambda: len(self.invocations()) == 3, timeout=60)
        pid = self.state("resume-stopped")["pid"]
        self.assertIn("waiting: teamster resume resume-stopped", self.resume("--all"))
        state = self.state("resume-stopped")
        self.assertEqual((state["outcome"], state["pid"], len(self.invocations())), ("interrupted", pid, 3))
        self.assertNotIn("resumed", state)
        self.cli("stop", "resume-live")
        self.wait("resume-live")
        self.cli("say", "resume-stopped", "Continue from the worktree.")
        self.wait("resume-stopped")
        state = self.state("resume-stopped")
        self.assertEqual((state["outcome"], state["turns"]), ("completed", 3))
        self.assertNotIn("resumed", state)
        self.assertIn("Continue from the worktree.", self.invocations()[-1]["prompt"])

    def test_resume_all_continues_overlapping_cycles_and_holds_the_rest(self):
        self.configure(language="en")
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "hold"}, {"mode": "hold"}, {"mode": "hold"},
            {"mode": "complete", "reply": self.work_result()}])
        self.start("resume-alone")
        self.start("resume-beside", "--parallel")
        self.until(lambda: len(self.invocations()) == 2, timeout=60)
        for slug in ("resume-alone", "resume-beside"):
            self.interrupt(slug, lambda: True)
        # --parallel alone does not make a task continue beside others: its cycle overlapped none.
        self.start("resume-later", "--parallel")
        self.interrupt("resume-later", lambda: len(self.invocations()) == 3)
        output = self.resume("--all")
        self.assertIn("resumed resume-alone from work", output)
        self.assertIn("resumed resume-beside from work", output)
        self.assertIn("waiting: teamster resume resume-later  (started with --parallel, "
                      "but its interrupted cycle overlapped no other)", output)
        for slug in ("resume-alone", "resume-beside"):
            self.wait(slug)
            self.assertEqual(self.state(slug)["outcome"], "completed")
        self.assertEqual(self.state("resume-later")["outcome"], "interrupted")
        self.assertIn("resumed resume-later from work", self.resume("--all"))
        self.wait("resume-later")
        self.assertEqual(self.state("resume-later")["outcome"], "completed")

    def test_resume_claude_session_with_exact_times_after_sigint(self):
        self.fixture_timeout = 120
        clock = self.enable_fake_clock(auto_advance=False)
        self.claude_pool_fixture(runs=[{"mode": "hold"}, {"reply": self.work_result()}])
        slug = "resume-claude"
        self.start(slug, "--executor", "claude")
        self.until(lambda: any(event["command"] == "holding" for event in self.claude_trace()), timeout=60)
        cut_at = clock.time()
        self.interrupt(slug, lambda: True, signal.SIGINT)
        session = self.state(slug)["session_id"]
        self.assertEqual(self.state(slug)["signal"], {"signum": signal.SIGINT, "name": "SIGINT", "at": cut_at})
        self.advance_fake_clock(600)
        self.assertIn(f"resumed {slug} from work (turn 1, interrupted by SIGINT at ", self.resume(slug))
        self.wait(slug)
        state = self.state(slug)
        self.assertEqual(state["outcome"], "completed")
        self.assertEqual(state["resumed"], [{"at": cut_at + 600, "signal": "SIGINT", "signal_at": cut_at,
                                             "step": "work", "turn": 1}])
        first, resumed = self.claude_invocations()
        self.assertEqual(resumed["argv"][resumed["argv"].index("--resume") + 1], first["session_id"])
        self.assertEqual((state["session_id"], resumed["session_id"]), (session, session))
        at = self.worker().config.local_time(cut_at)
        self.assertIn(f"Your turn was cut short by the external signal SIGINT at {at}, through no fault of yours.",
                      resumed["argv"][1])

    def test_resume_prompt_names_unpushed_commits_and_the_saved_pr(self):
        self.configure(language="ru")
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "write_files": {"tracked.txt": "implemented\n"}, "commit_files": ["tracked.txt"],
             "push": True, "reply": self.work_result()},
            {"mode": "hold", "write_files": {"tracked.txt": "follow-up\n"}, "commit_files": ["tracked.txt"]},
            {"mode": "complete", "reply": self.work_result()}])
        slug = "resume-pr"
        self.start(slug)
        self.wait(slug)
        pr = self.state(slug)["publish"]["pr"]
        self.assertTrue(pr)
        worktree = self.state(slug)["worktree"]
        head = self.git("-C", worktree, "rev-parse", "HEAD")
        self.cli("say", slug, "Продолжи.")
        self.interrupt(slug, lambda: self.git("-C", worktree, "rev-parse", "HEAD") != head
                       and self.state(slug).get("codex_pid"), signal.SIGINT)
        self.resume(slug)
        self.wait(slug)
        prompt = self.invocations()[-1]["prompt"]
        self.assertIn("Твой ход оборвал внешний сигнал SIGINT в ", prompt)
        self.assertIn(f"незакоммиченных файлов — 0; незапушенных коммитов — 1; PR: {pr}.", prompt)
