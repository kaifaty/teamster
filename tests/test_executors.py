"""Keep work-executor dispatch open to registered, test-only harnesses."""
import ast
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap
from types import SimpleNamespace
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parent))

from rotation_support import RotationTestCase, SCRIPT


def fixture_work_turn(st, cfg, prompt, effort, current_message, stopped, sleep, new_turn=True):
    Path(st["worktree"], "adapter.txt").write_text("Fixture work complete.\n")
    st.update(fixture_account="fixture-worker", fixture_cursor="fixture-position", outcome="completed",
              result={"status": "done", "summary": "Fixture work complete.", "checks": [],
                      "pr": "", "pr_title": "", "pr_body": "", "commit_message": "",
                      "questions": [], "remaining": [], "findings": []})


def fixture_last_message(st):
    return json.dumps(st["result"])


def fixture_messages(st):
    return [fixture_last_message(st)]


class ExecutorTests(RotationTestCase):
    def test_acp_stdio_conversation(self):
        self.env["HOME"] = str(self.root)
        repo = self.root / "work tree"
        repo.mkdir()
        agent = self.root / "acp agent.py"
        agent.write_text(textwrap.dedent('''\
            import json
            from pathlib import Path
            import sys

            def receive(method):
                message = json.loads(input())
                assert message["method"] == method, message
                return message

            def send(**message):
                print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)

            def reply(request, **result):
                send(id=request["id"], result=result)

            mode, argument = sys.argv[1:]
            assert argument == "--literal=two words; *"
            assert Path.cwd() == Path(__file__).parent / "work tree"
            init = receive("initialize")
            assert init["params"]["protocolVersion"] == 1
            reply(init, protocolVersion=1, agentCapabilities={"loadSession": True},
                  authMethods=[{"id": "fixture", "name": "Fixture"}])
            if mode == "load":
                auth = receive("authenticate")
                assert auth["params"]["methodId"] == "fixture"
                reply(auth)
            session = receive("session/" + mode)
            assert session["params"]["cwd"] == str(Path.cwd())
            if mode == "new":
                reply(session, sessionId="session-1")
            else:
                assert session["params"]["sessionId"] == "session-1"
                send(method="session/update", params={"sessionId": "session-1",
                     "update": {"sessionUpdate": "agent_message_chunk",
                                "content": {"type": "text", "text": "Old reply"}}})
                reply(session)

            for text in ("first turn", "1"):
                prompt = receive("session/prompt")
                assert prompt["params"]["sessionId"] == "session-1"
                assert prompt["params"]["prompt"] == [{"type": "text", "text": text}]
                if text == "first turn":
                    # Both peers can use the same ID at the same time.
                    send(id=prompt["id"], method="session/request_permission",
                         params={"sessionId": "session-1", "toolCall": {"toolCallId": "call-1"},
                                 "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"}]})
                    decision = json.loads(input())
                    assert decision["id"] == prompt["id"]
                    assert decision["result"]["outcome"] == {"outcome": "cancelled"}, decision
                send(method="session/update", params={"sessionId": "session-1",
                     "update": {"sessionUpdate": "agent_message_chunk",
                                "content": {"type": "text", "text": "Reply to " + text}}})
                reply(prompt, stopReason="end_turn")
            '''))
        for mode, options in (("new", []), ("load", ["--resume", "session-1", "--auth-method", "fixture"])):
            with self.subTest(mode=mode):
                cmd = [sys.executable, "-I", str(SCRIPT), "acp", "--repo", str(repo), *options,
                       "--", sys.executable, "-I", str(agent), mode, "--literal=two words; *"]
                run = subprocess.run(cmd, cwd=self.root, env=self.env, text=True, input="first turn\n1\n",
                                     capture_output=True, timeout=15)
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(run.stdout, "Reply to first turn\nReply to 1\n")

    def test_executor_selection_stays_in_contract(self):
        violations = []
        for path in SCRIPT.parent.glob("*.py"):
            # Standalone helpers moved into the package directory are not package code.
            if path.name in ("executors.py", "codex_stats.py", "rollout.py", "task_report.py"):
                continue
            for node in ast.walk(ast.parse(path.read_text())):
                access = (isinstance(node, ast.Subscript)
                          and isinstance(node.slice, ast.Constant) and node.slice.value == "executor")
                lookup = (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                          and node.func.attr == "get" and node.args
                          and isinstance(node.args[0], ast.Constant) and node.args[0].value == "executor")
                comparison = (isinstance(node, ast.Compare)
                              and any((isinstance(value, ast.Name) and value.id == "executor")
                                      or (isinstance(value, ast.Attribute) and value.attr == "executor")
                                      for value in [node.left] + node.comparators))
                if access or lookup or comparison:
                    violations.append(f"{path.name}:{node.lineno}")
        self.assertEqual(violations, [])

    def test_codex_status_uses_patched_last_message(self):
        worker = self.worker()
        state = {"slug": "codex-status", "executor": "codex", "account": "fixture-account",
                 "thread": "fixture-thread", "worktree": str(self.root),
                 "branch": "fixture-branch", "base": "HEAD"}
        marker = "Patched last-message marker."
        output = io.StringIO()
        with mock.patch.object(worker.task_state, "load", return_value=state), \
                mock.patch.object(worker.procs, "sh", return_value=""), \
                mock.patch.object(worker.threads, "last_message", return_value=marker), \
                contextlib.redirect_stdout(output):
            worker.commands.cmd_status(SimpleNamespace(slug=state["slug"]))
        self.assertIn(marker, output.getvalue())

    def test_registered_executor_lifecycle(self):
        self.env.update(HOME=str(self.root), USER="fixture-user")
        name = "fixture-harness"
        self.configure(executor=name)
        self.configure_notify()
        self.account(self.home, "A", self.reset,
                     runs=[{"mode": "complete", "reply": self.review_result(defects=False)}])
        worker = self.worker()

        class FixtureExecutor(worker.executors.Executor):
            event_log = False
            provider = "fixture-provider"

        executor = FixtureExecutor(name, "fixture_account", "fixture_cursor", "position")
        executor.bind(sys.modules[__name__], turn="fixture_work_turn", last_message="fixture_last_message",
                      messages="fixture_messages", pr_messages="fixture_messages")
        worker.executors.register(executor)
        for path in SCRIPT.parent.glob("*.py"):
            self.assertNotIn(name, path.read_text())

        original_spawn = worker.supervisor.spawn

        def inline_supervisor(st, *args, **kwargs):
            # Keep the real spawn resets and supervisor cycle; only replace the
            # detached launcher so this process retains its test-only registry.
            proc = SimpleNamespace(pid=os.getpid(), poll=lambda: 0)
            with mock.patch.object(worker.supervisor.subprocess, "Popen", return_value=proc):
                original_spawn(st, *args, **kwargs)
            with mock.patch.object(worker.supervisor.signal, "signal"):
                worker.supervisor.cmd__run(SimpleNamespace(slug=st["slug"]))
            return proc

        def cli(*args):
            output = io.StringIO()
            with mock.patch.object(sys, "argv", [str(SCRIPT), *args]), contextlib.redirect_stdout(output):
                worker.cli.main()
            return output.getvalue()

        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch.object(worker.supervisor, "spawn", side_effect=inline_supervisor), \
                mock.patch.object(sys.modules[__name__], "fixture_work_turn", wraps=fixture_work_turn) as turn:
            started = cli("start", "registered-task", "--brief", str(self.brief), "--repo", str(self.repo),
                          "--executor", name, "--no-push", "--check", "test -f adapter.txt")
            state = self.state("registered-task")
            self.assertEqual(state["outcome"], "completed", state.get("error"))
            turn.assert_called_once()
            self.assertEqual(state["checks"][-1]["outcome"], "passed")
            self.assertEqual((state["executor"], state["fixture_account"], state["fixture_cursor"]),
                             (name, "fixture-worker", "fixture-position"))
            self.assertIn("account fixture-worker, position fixture-position", started)
            status = cli("status", "registered-task")
            self.assertIn("executor " + name + "  account fixture-worker  position fixture-posit", status)
            self.assertIn("Fixture work complete.", status)
            waited = cli("wait", "registered-task")
            self.assertIn("Fixture work complete.", waited)
            self.assertIn("check `test -f adapter.txt`: passed", waited)
            finished = self.notification("registered-task", "turn_finished")
            self.assertEqual(finished["account"], "fixture-worker")
            work_row = next(row for row in self.telemetry_journal() if row["phase"] == "work")
            self.assertEqual((work_row["provider"], work_row["account"], work_row["fixture_cursor"]),
                             ("fixture-provider", "fixture-worker", "fixture-position"))

            cli("review", "registered-task")
            reviewed = self.state("registered-task")
            self.assertEqual(reviewed["outcome"], "completed", reviewed.get("error"))
            self.assertEqual(reviewed["review_result"]["verdict"], "clean")
            self.assertEqual(len(self.review_invocations()), 1)
            turn.assert_called_once()
            self.assertIn("review by main", cli("wait", "registered-task"))
            self.assertIn("account main  thread", cli("status", "registered-task"))
            self.assertEqual(self.notification("registered-task", "review_done")["account"], "main")


if __name__ == "__main__":
    unittest.main()
