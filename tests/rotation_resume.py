"""teamster resume: continuing cycles that an external signal cut short."""
import json
import os
import shlex
import signal
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
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
            {"mode": "hold", "write_files": {"pending.txt": "unfinished work\n", "notes.txt": "notes\n"}},
            {"mode": "complete", "reply": self.work_result()},
            {"mode": "complete", "reply": self.review_result(defects=False)}])
        slug = "resume-work"
        # CI after the cycle must not replace the step the signal cut short.
        self.start(slug, "--review", "--fix-rounds", "1", "--ci-command", "true")
        worktree = Path(self.state(slug)["worktree"])
        self.interrupt(slug, lambda: (worktree / "notes.txt").exists())
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
        self.assertIn("uncommitted files: 2; unpushed commits: 0; no PR.", prompt)
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
        self.assertEqual((self.state(slug)["cycle"]["step"], self.state(slug)["review_after"]), ("review", True))
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
        hold = self.root / "check-hold"
        hold.touch()
        command = (f"n=$(cat {shlex.quote(str(counter))} 2>/dev/null || echo 0); n=$((n+1)); "
                   f"echo $n > {shlex.quote(str(counter))}; "
                   f"if [ $n -eq 2 ]; then while [ -f {shlex.quote(str(hold))} ]; do sleep 0.1; done; fi; [ $n -lt 2 ]")
        decisions = [{"id": "F1", "decision": "fixed", "note": "Empty input is skipped."},
                     {"id": "F2", "decision": "rejected", "note": "The slice is intended."}]
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "reply": self.work_result()},
            {"mode": "complete", "reply": self.review_result()}, {"mode": "hold"},
            {"mode": "complete", "write_files": {"tracked.txt": "fixed\n"}, "commit_files": ["tracked.txt"],
             "reply": self.work_result(findings=decisions)},
            {"mode": "complete", "reply": self.work_result()}])
        (self.home / "exec-count").unlink()
        slug = "resume-fix-round"
        before = len(self.invocations())
        self.start(slug, "--review", "--fix-rounds", "2", "--check", command)
        self.interrupt(slug, lambda: len(self.invocations()) == before + 3)
        self.assertIn(f"resumed {slug} from fix", self.resume(slug))
        # The check of the resumed round is cut short too; it fails when it runs again.
        self.interrupt(slug, lambda: self.state(slug).get("check_pid") and counter.exists()
                       and counter.read_text().strip() == "2")
        hold.unlink()
        self.assertIn(f"resumed {slug} from check", self.resume(slug))
        self.wait(slug)
        state = self.state(slug)
        invocations = self.invocations()[before:]
        self.assert_resumed_same_thread(invocations[2], invocations[3], self.home)
        self.assertIn("cut short by the external signal SIGTERM", invocations[3]["prompt"])
        # The failed check starts the second round; its failure ends the cycle without a third round.
        self.assertEqual(len(invocations), 5)
        self.assertFalse(invocations[4]["review"])
        self.assertEqual([entry["step"] for entry in state["resumed"]], ["fix", "check"])
        # The interrupted round counts against --fix-rounds and keeps what the resumed turn and check did.
        first, second = state["rounds"]
        self.assertEqual(first["review"]["findings"][0]["id"], "F1")
        self.assertEqual(first["decisions"], decisions)
        self.assertEqual(len(first["commits"]), 1)
        self.assertEqual(first["check"]["outcome"], "failed")
        self.assertIsNone(second["review"])
        self.assertEqual(second["check"]["outcome"], "failed")
        self.assertEqual((state["outcome"], state["auto_fix_stop"]), ("completed", "check failed"))

    def test_resume_review_step_does_not_fix_from_the_previous_review(self):
        worker = self.worker()
        st = {"slug": "resume-step", "review_result": self.review_result(),
              "cycle": {"kind": "work", "effort": None, "step": "review", "ci": False, "pr": "", "angles": 1}}
        self.assertEqual(worker.supervisor.resume_step(st)[1], "after_review")
        # The next review step starts with the base merge check, before review_turn drops the old review.
        with mock.patch.object(worker.task_state, "save"):
            worker.task_state.mark_step(st, "review")
        self.assertEqual(worker.supervisor.resume_step(st)[1], "review")
        # A state saved before cycles were recorded continues the review it was in.
        legacy = {"slug": "resume-step", "kind": "review", "work_completed": True, "rounds": [{}], "fix_rounds": 2}
        cycle, step = worker.supervisor.resume_step(legacy)
        self.assertEqual((cycle["kind"], step), ("work", "review"))
        self.assertNotIn("review_after", cycle)
        # A stopped supervisor records a skipped CI even when it was cut short in a fix round's check.
        legacy = {"slug": "resume-step", "kind": "work", "rounds": [{}], "result": self.work_result(),
                  "checks": [{"outcome": "interrupted"}], "check_start": 0,
                  "ci": {"outcome": "skipped", "reason": "stopped", "rounds": 0}}
        cycle, step = worker.supervisor.resume_step(legacy)
        self.assertEqual((cycle["ci"], step), (False, "check"))

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

        # The check of a CI repair that ended partial ends the CI cycle once it runs again.
        hold.touch()
        (self.home / "exec-count").unlink()
        counter = self.root / "ci-check-count"
        check = (f"n=$(cat {counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {counter}; "
                 f"if [ $n -eq 2 ]; then while [ -f {hold} ]; do sleep 0.1; done; fi")
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "write_files": {"tracked.txt": "implemented\n"}, "commit_files": ["tracked.txt"],
             "push": True, "reply": self.work_result()},
            {"mode": "complete", "reply": self.work_result("partial")}])
        before = len(self.invocations())
        self.start("resume-ci-check", "--check", check, "--ci-command", "false", "--ci-rounds", "2")
        self.interrupt("resume-ci-check", lambda: self.state("resume-ci-check").get("check_pid")
                       and counter.exists() and counter.read_text().strip() == "2")
        hold.unlink()
        self.assertIn("resumed resume-ci-check from check", self.resume("resume-ci-check"))
        self.wait("resume-ci-check")
        state = self.state("resume-ci-check")
        self.assertEqual([check["outcome"] for check in state["checks"]], ["passed", "interrupted", "passed"])
        self.assertEqual((state["ci"]["rounds"], state["ci"]["reason"]), (1, "partial"))
        self.assertEqual(len(self.invocations()) - before, 2)

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

        # OpenCode has a separate process group and may keep writing after its supervisor dies.
        binary = self.root / "opencode"
        binary.write_text("#!" + sys.executable + """
import os, signal, subprocess, sys
from pathlib import Path
if sys.argv[1] == "api":
    print('{"data":{"id":"ses_recovery"}}')
else:
    assert sys.argv[1] == "acp"
    child = subprocess.Popen(["sleep", "90"])
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    Path("orphan-pids").write_text(f"{os.getpid()} {child.pid}")
    child.wait()
""")
        binary.chmod(0o700)
        slug = "orphan-opencode"
        self.start(slug, "--executor", "opencode", "--model", "offline/model", "--no-push")
        marker = Path(self.state(slug)["worktree"]) / "orphan-pids"
        self.until(lambda: marker.is_file() and marker.read_text().startswith(f"{self.state(slug).get('opencode_pid')} "),
                   timeout=60)
        state = self.state(slug)
        orphan, child = map(int, marker.read_text().split())
        self.extra_pids.update((orphan, child))
        os.kill(state["pid"], signal.SIGKILL)
        self.until(lambda: not self.process_is_live(state["pid"]))
        for args in (("say", slug, "Continue."), ("resume", slug), ("clean", slug)):
            self.assertIn(f"teamster stop {slug}", self.refused(*args))
        self.assertEqual(self.state(slug)["turns"], 1)
        self.assertIn(f"ended OpenCode process {orphan}", self.cli("stop", slug))
        self.assertFalse(self.process_is_live(orphan))
        self.assertFalse(self.process_is_live(child))
        self.assertNotIn("opencode_pid", self.state(slug))

        # Even a group leader in the same worktree is not a worker of this interrupted supervisor.
        worker = self.worker()
        stale = self.state(slug)
        with subprocess.Popen(["sleep", "90"], cwd=stale["worktree"], start_new_session=True,
                              env=dict(self.env, PWD=stale["worktree"])) as unrelated:
            try:
                with mock.patch.object(worker.task_state, "load", return_value=dict(stale, opencode_pid=unrelated.pid)), \
                        mock.patch.object(worker.procs, "end_group") as end:
                    worker.commands.cmd_stop(SimpleNamespace(slug=slug))
                    end.assert_not_called()
            finally:
                unrelated.terminate()

        # A say can win the state lock after clean is requested with an idle task.
        def read_during_clean(slug):
            locked = slug in getattr(worker.task_state.HELD_STATE_LOCKS, "slugs", set())
            return dict(stale, pid=os.getpid()) if locked else stale

        with mock.patch.object(worker.task_state, "load", side_effect=read_during_clean), \
                self.assertRaisesRegex(SystemExit, "still running"):
            worker.commands.cmd_clean(SimpleNamespace(slug=slug, keep_branch=False))
        self.assertTrue(Path(stale["worktree"]).is_dir())

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

    def test_resume_all_continues_every_candidate_at_once(self):
        self.configure(language="en")
        self.account(self.home, "A", self.reset, runs=[{"mode": "hold"}] * 3 + [
            {"mode": "complete", "write_files": {"tracked.txt": "implemented\n"}, "commit_files": ["tracked.txt"],
             "push": True, "delay": 10, "reply": self.work_result()}])
        self.start("resume-legacy", "--ci-command", "true")
        self.interrupt("resume-legacy", lambda: len(self.invocations()) == 1)
        # A state of an earlier version has no cycle record: a turn without a result goes on despite CI.
        path = self.home / "claude-tasks" / "resume-legacy" / "state.json"
        state = self.state("resume-legacy")
        self.assertIsNone(state["result"])
        path.write_text(json.dumps({key: value for key, value in state.items()
                                    if key not in ("cycle", "review_after")}))
        self.start("resume-other")
        self.interrupt("resume-other", lambda: len(self.invocations()) == 2)
        self.start("resume-live")
        self.until(lambda: len(self.invocations()) == 3, timeout=60)
        output = self.resume("--all")
        self.assertIn("resumed resume-legacy from work", output)
        self.assertIn("resumed resume-other from work", output)
        self.assertNotIn("waiting", output)
        # Both executors run at the same time: neither turn has finished once both started.
        self.until(lambda: len(self.invocations()) == 5, timeout=8)
        for slug in ("resume-legacy", "resume-other"):
            self.assertNotIn("turn_finished", self.state(slug))
        for slug in ("resume-legacy", "resume-other"):
            self.wait(slug)
            state = self.state(slug)
            self.assertEqual((state["outcome"], state["result"]), ("completed", self.work_result()))
        self.assertEqual(len(self.invocations()), 5)
        self.assertEqual(self.state("resume-legacy")["ci"]["outcome"], "passed")
        self.cli("stop", "resume-live")
        self.wait("resume-live")

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
