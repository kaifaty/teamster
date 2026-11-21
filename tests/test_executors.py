"""Keep work-executor dispatch open to registered, test-only harnesses."""
import ast
import contextlib
import io
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import subprocess
import sys
import textwrap
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parent))

from rotation_support import RotationTestCase, SCRIPT


@contextlib.contextmanager
def local_opencode_provider(env, binary):
    """Run the installed CLI against a scripted loopback Chat Completions endpoint."""
    home = Path(env["HOME"])
    (home / "opencode").symlink_to(Path(binary).resolve(strict=True))
    requests = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            messages = request["messages"]
            requests.append((self.path, request["model"]))
            # The second edit is possible only if OpenCode restored the first answer.
            resumed = any(m["role"] == "assistant" and "Initial edit" in (m.get("content") or "")
                          for m in messages)
            summary = "Follow-up edit" if resumed else "Initial edit"
            if messages[-1]["role"] == "user":
                args = {"command": "echo '" + summary + "' >> tracked.txt"}
                delta = {"tool_calls": [{"index": 0, "id": "edit-" + str(len(requests)), "type": "function",
                                         "function": {"name": "shell", "arguments": json.dumps(args)}}]}
                finish = "tool_calls"
            else:
                result = json.loads((home / "response.json").read_text())
                result["summary"] = summary
                delta, finish = {"content": json.dumps(result)}, "stop"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for part, reason in [({"role": "assistant"}, None), (delta, None), ({}, finish)]:
                event = {"id": "chatcmpl-local", "object": "chat.completion.chunk", "created": 1, "model": "model",
                         "choices": [{"index": 0, "delta": part, "finish_reason": reason}]}
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")

    # Build the CLI's environment only from this test's fixture paths and Git identity.
    keep = {"HOME", "PATH", "TEAMSTER_CLAUDE", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
            "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"}
    for key in list(env):
        if key not in keep and not key.startswith(("CODEX_TASK_", "CODEX_FAKE_")):
            del env[key]
    env.update(XDG_CONFIG_HOME=str(home / ".config"), XDG_CACHE_HOME=str(home / "cache"),
               XDG_STATE_HOME=str(home / "state"), XDG_DATA_HOME=str(home / "data"),
               SHELL="/bin/sh", OFFLINE_KEY="fixture", HTTP_PROXY="http://127.0.0.1:9",
               HTTPS_PROXY="http://127.0.0.1:9", NO_PROXY="127.0.0.1,localhost")
    with HTTPServer(("127.0.0.1", 0), Provider) as server:
        root = home / ".config" / "opencode"
        root.mkdir(parents=True)
        (root / "opencode.json").write_text(json.dumps({
            "update": "disable", "model": "offline/model",
            "policies": [{"action": "provider.use", "resource": "*", "effect": "deny"},
                         {"action": "provider.use", "resource": "offline", "effect": "allow"}],
            "providers": {"offline": {"package": "@opencode/ai/providers/openai-compatible", "env": ["OFFLINE_KEY"],
                                      "settings": {"baseURL": f"http://127.0.0.1:{server.server_port}/v1"},
                                      "models": {"model": {"name": "Test model"}}}},
        }))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield
        finally:
            server.shutdown()
            thread.join()
    assert requests == [("/v1/chat/completions", "model")] * 4, requests


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


def install_fake_opencode(root):
    fake = root / "opencode"
    fake.write_text("#!" + sys.executable + "\n" + textwrap.dedent('''\
        import argparse
        import json
        from pathlib import Path
        import sys

        parser = argparse.ArgumentParser()
        with (Path.home() / "opencode-calls").open("a") as calls:
            print(sys.argv[1], file=calls)
        if sys.argv[1] == "api":
            parser.add_argument("operation", choices=["session.get"])
            parser.add_argument("--standalone", action="store_true", required=True)
            parser.add_argument("--param", required=True)
            lookup = parser.parse_args(sys.argv[2:])
            key, session_id = lookup.param.split("=", 1)
            assert key == "sessionID" and sys.stdin.read() == ""
            stored = Path.home() / session_id
            if not stored.exists():
                print(json.dumps({"_tag": "SessionNotFoundError"}))
                sys.exit("HTTP 404 Not Found")
            print(json.dumps({"id": session_id, "directory": stored.read_text()}))
            sys.exit(0)
        parser.add_argument("command", choices=["run"])
        parser.add_argument("--standalone", action="store_true", required=True)
        parser.add_argument("--auto", action="store_true", required=True)
        parser.add_argument("--model", choices=["offline/model"], required=True)
        parser.add_argument("--format", choices=["json"], required=True)
        parser.add_argument("--title", required=True)
        parser.add_argument("--session", required=True)
        args = parser.parse_args()
        prompt = sys.stdin.read()
        session = Path.home() / args.session
        if session.exists():
            assert session.read_text() == str(Path.cwd())
            assert "Make the second change" in prompt
            summary = "Follow-up edit"
        else:
            assert "Make the first change" in prompt
            session.write_text(str(Path.cwd()))
            summary = "Initial edit"
        with Path("tracked.txt").open("a") as out:
            print(summary, file=out)
        result = json.loads((Path.home() / "response.json").read_text())
        result["summary"] = summary
        for kind, fields in [("step_start", {}), ("text", {"text": json.dumps(result)}),
                             ("step_finish", {"reason": "stop"})]:
            part = {"type": kind.replace("_", "-"), "sessionID": args.session,
                    "messageID": "msg_fixture", **fields}
            print(json.dumps({"type": kind, "sessionID": args.session, "part": part}))
        '''))
    fake.chmod(0o700)


class ExecutorTests(RotationTestCase):
    def test_opencode_start_and_say_resume_the_worker_session(self):
        self.env.update(HOME=str(self.root), TEAMSTER_CLAUDE=str(self.root / "missing-claude"))
        self.configure(accounts=[], claude={"accounts": []}, task_profiles={
            "feature": {"executor": "codex", "model": "codex-only", "effort": "high"}})
        self.brief.write_text("Make the first change to tracked.txt.\n")
        real_binary = os.environ.get("TEAMSTER_TEST_OPENCODE")
        if real_binary:
            provider = local_opencode_provider(self.env, real_binary)
        else:
            install_fake_opencode(self.root)
            provider = contextlib.nullcontext()
        (self.root / "response.json").write_text(json.dumps(self.work_result(checks=[])))
        slug = "opencode-work"
        with provider:
            self.start(slug, "--executor", "opencode", "--model", "offline/model", "--task-type", "feature",
                       "--no-push", "--check", "grep -q 'Initial edit' tracked.txt")
            self.assertIn("Initial edit", self.wait(slug))
            first = self.state(slug)
            self.assertEqual((first["executor"], first["task_model"], first["effort"], first["account"]),
                             ("opencode", "offline/model", None, None))
            session = first["session_id"]
            self.assertTrue(session)
            file = Path(first["worktree"]) / "tracked.txt"
            self.assertEqual(file.read_text(), "initial\nInitial edit\n")

            self.cli("say", slug, "Make the second change to tracked.txt.")
            self.assertIn("Follow-up edit", self.wait(slug))
            second = self.state(slug)
            self.assertEqual((second["session_id"], second["turns"]), (session, 2))
            self.assertEqual(second["result"], self.work_result(summary="Follow-up edit", checks=[]))
            self.assertEqual([check["outcome"] for check in second["checks"]], ["passed", "passed"])
            self.assertEqual(file.read_text(), "initial\nInitial edit\nFollow-up edit\n")
            self.assertEqual((self.repo / file.name).read_text(), "initial\n")
            self.assertEqual(self.trace(), [])
            report = json.loads(self.cli("report", "--json", "--by", "executor"))
            self.assertEqual([group["executor"] for group in report["groups"]], ["opencode"])

            if real_binary:
                subprocess.run(["opencode", "session", "delete", "--standalone", session], cwd=file.parent,
                               env=self.env, stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=30)
            else:
                (self.root / session).unlink()
            self.cli("say", slug, "Make a third change to tracked.txt.")
            output = self.cli("wait", slug, "--timeout", "30", timeout=45)
            failed = self.state(slug)
            self.assertEqual((failed["session_id"], failed["outcome"], failed.get("result")), (session, "failed", None))
            self.assertEqual(failed["error"], f"Saved OpenCode session {session} was not found")
            self.assertIn(failed["error"], output)
            summaries = [json.loads(msg)["summary"] for msg in self.worker().threads.session_messages(failed)]
            self.assertEqual(summaries, ["Initial edit", "Follow-up edit"])
            self.assertEqual(file.read_text(), "initial\nInitial edit\nFollow-up edit\n")
            if not real_binary:
                self.assertEqual((self.root / "opencode-calls").read_text().splitlines(), ["run", "api", "run", "api"])

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

    def test_opencode_requires_a_successful_finish_in_the_requested_session(self):
        runner = self.worker().turns.opencode_runner
        session = "ses_fixture"
        answer = {"type": "text", "sessionID": session, "part": {"text": json.dumps(self.work_result())}}
        finish = {"type": "step_finish", "sessionID": session, "part": {"reason": "stop"}}
        error = {"type": "error", "sessionID": session, "error": {"message": "Unauthorized"}}
        for tail in ([], [error, finish], [dict(finish, sessionID="ses_other")],
                     [dict(finish, part={"reason": "length"})]):
            with self.subTest(tail=tail):
                events = [json.dumps(row).encode() for row in [answer, *tail]]
                outcome, _ = runner._response(events, session, 0, io.BytesIO())
                self.assertEqual(outcome, "failed")

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
        scout = mock.Mock(side_effect=lambda st, *args, **kwargs: st.update(outcome="completed"))
        executor.bind(SimpleNamespace(run=scout), scout="run")
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

            cli("scout", "registered-scout", "Read the fixture", "--repo", str(self.repo), "--executor", name)
            scout.assert_called_once()
            self.assertEqual(self.state("registered-scout")["outcome"], "completed")


if __name__ == "__main__":
    unittest.main()
