"""Keep work-executor dispatch open to registered, test-only harnesses."""
import ast
from concurrent.futures import ThreadPoolExecutor
import contextlib
import io
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import shlex
import subprocess
import sys
import textwrap
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parent))

from rotation_support import RotationTestCase, SCRIPT


PROJECT_REVIEW = "Run teamster scout progress-review before acceptance."


@contextlib.contextmanager
def local_opencode_provider(env, binary):
    """Run the installed CLI against a scripted loopback Chat Completions endpoint."""
    home = Path(env["HOME"])
    (home / "opencode").symlink_to(Path(binary).resolve(strict=True))
    requests = []
    work_prompts = []
    stop_requested = threading.Event()
    release = threading.Event()

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            messages = request["messages"]
            requests.append((self.path, request["model"]))
            if (home / "quota-exhausted").exists():
                payload = json.dumps({"error": {"message": "You exceeded your current quota.",
                                                "type": "insufficient_quota", "code": "insufficient_quota"}}).encode()
                self.send_response(429)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if "Wait here for stop" in json.dumps(messages):
                stop_requested.set()
                release.wait(30)
                return
            # The second edit is possible only if OpenCode restored the first answer.
            resumed = any(m["role"] == "assistant" and "Initial edit" in (m.get("content") or "")
                          for m in messages)
            markers = [label for label in ("alpha", "beta") if f"[{label}]" in json.dumps(messages)]
            assert len(markers) == 1, "expected only this task's brief in its history"
            summary = ("Follow-up edit " if resumed else "Initial edit ") + markers[0]
            if messages[-1]["role"] == "user":
                work_prompts.append((resumed, messages))
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
    keep = {"HOME", "PATH", "PWD", "TEAMSTER_CLAUDE", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
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
            "agents": {"title": {"model": "offline/other"}, "summary": {"model": "offline/other"},
                       "compaction": {"model": "offline/other"}},
            "policies": [{"action": "provider.use", "resource": "*", "effect": "deny"},
                         {"action": "provider.use", "resource": "offline", "effect": "allow"}],
            "providers": {"offline": {"package": "@opencode/ai/providers/openai-compatible", "env": ["OFFLINE_KEY"],
                                      "settings": {"baseURL": f"http://127.0.0.1:{server.server_port}/v1"},
                                      "models": {"model": {"name": "Test model"}, "other": {"name": "Auxiliary model"}}}},
        }))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield stop_requested
        finally:
            release.set()
            server.shutdown()
            thread.join()
    assert requests == [("/v1/chat/completions", "model")] * 10, requests
    assert [resumed for resumed, _ in work_prompts] == [False, False, True, True]
    for resumed, messages in work_prompts:
        instructions = "\n".join(m["content"] for m in messages if m["role"] == "system")
        project = instructions.find(PROJECT_REVIEW)
        role = instructions.find("You are a managed Teamster executor.")
        assert 0 <= project < role, (resumed, [m["role"] for m in messages], instructions)
        assert "Inline OpenCode guidance." in instructions[:role]
        assert "status needs_decision" in instructions[role:]
        assert "Do not echo the schema" in instructions[role:]
        assert "You are a managed Teamster executor." not in messages[-1]["content"]


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
        import json
        import os
        from pathlib import Path
        import signal
        import sys
        import time
        import uuid

        signal.signal(signal.SIGINT, signal.SIG_DFL)
        home = Path.home()
        cwd = Path(os.environ["PWD"])
        config = [{"id": "model", "type": "select", "options": [{"value": "offline/other"}, {"value": "offline/model"}]}]

        def send(**message):
            print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)

        def record(method):
            with (home / "opencode-calls").open("a") as calls:
                print(method, file=calls)
            gate = home / "hold-method"
            if gate.exists() and gate.read_text() == method:
                (home / "waiting-pid").write_text(str(os.getpid()))
                deadline = time.monotonic() + 15
                while gate.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                if gate.exists():
                    sys.exit("Timed out in fake " + method)

        assert os.environ.get("TEAMSTER_MANAGED_EXECUTOR") == "1"
        assert not {"BOARD_TOKEN", "BOARD_EXTERNAL_DUTY_CONFIG", "BOARD_URL"}.intersection(os.environ)
        if sys.argv[1:] == ["api", "--standalone", "model.list"]:
            route = cwd / "fixture-route"
            settings = {"baseURL": route.read_text() if route.exists() else "http://127.0.0.1:9001/private?v=fixture-private"}
            if "claude-opencode-stop" in cwd.parts:
                settings["apiKey"] = (cwd / "fixture-key").read_text() if (cwd / "fixture-key").exists() else "fixture-local-key"
            model = {"providerID": "offline", "id": "model", "modelID": "model", "enabled": True,
                     "package": "@opencode/ai/providers/openai-compatible", "settings": settings}
            print(json.dumps({"data": [model, dict(model, id="other")]}))
            sys.exit(0)
        if sys.argv[1:] == ["auth", "list", "--standalone", "--format", "json"]:
            if {"claude-opencode-parallel", "claude-opencode-stop"} & set(cwd.parts):
                print("[]")
                sys.exit(0)
            source = home / "connection-id"
            print(json.dumps([{"id": "offline", "connections": [
                {"type": "credential", "id": source.read_text() if source.exists() else "cred_fixture"}]}]))
            sys.exit(0)

        if sys.argv[1] == "api":
            assert sys.argv[2:5] == ["--standalone", "session.update", "--param"]
            stored = home / sys.argv[5].split("=", 1)[1]
            state = json.loads(stored.read_text())
            assert state["cwd"] == str(cwd) and sys.argv[6] == "--data"
            record("session.update")
            if (home / "fail-title").exists():
                sys.exit("fixture title failure")
            state["title"] = json.loads(sys.argv[7])["title"]
            stored.write_text(json.dumps(state))
            sys.exit(0)

        assert sys.argv[1:] == ["acp"]
        assert os.environ.get("COPYFILE_DISABLE") == "1"
        overlay = json.loads(os.environ["OPENCODE_CONFIG_CONTENT"])
        role_file = Path(overlay["instructions"][-1])
        assert role_file.is_absolute()
        assert {"action": "tool.use", "resource": "subagent:*", "effect": "deny"} not in overlay["policies"]
        assert {"action": "skill.use", "resource": "teamster", "effect": "deny"} in overlay["policies"]
        if not (home / "unbound-direct-call").exists():
            assert overlay["model"] == "offline/model"
            assert all(overlay["agents"][agent]["model"] == "offline/model" for agent in ("title", "summary", "compaction"))
            assert overlay["providers"]["offline"]["models"]["other"]["disabled"]
            assert [p for p in overlay["policies"] if p["action"] == "provider.use"][-2:] == [
                {"action": "provider.use", "resource": "*", "effect": "deny"},
                {"action": "provider.use", "resource": "offline", "effect": "allow"}]
        for line in sys.stdin:
            request = json.loads(line)
            method, params = request["method"], request["params"]
            record(method)
            if method == "initialize":
                result = {"protocolVersion": 1, "agentCapabilities": {"sessionCapabilities": {"resume": {}}}}
            elif method == "session/new":
                assert Path(params["cwd"]) == cwd == Path.cwd()
                session_id = "ses_" + uuid.uuid4().hex
                (home / session_id).write_text(json.dumps({"cwd": str(cwd)}))
                result = {"sessionId": session_id, "configOptions": config}
            else:
                session_id = params["sessionId"]
                stored = home / session_id
                if not stored.exists():
                    missing = {"code": -32602, "message": "Invalid params: session not found: " + session_id,
                               "data": {"sessionId": session_id}}
                    send(id=request["id"], error=missing)
                    continue
                state = json.loads(stored.read_text())
                assert state["cwd"] == str(cwd)
                if method == "session/resume":
                    assert Path(params["cwd"]) == Path.cwd()
                    result = {"configOptions": config, "_meta": {"description": "PRIVATE-SESSION-METADATA"}}
                elif method == "session/set_config_option":
                    assert params["configId"] == "model" and params["value"] == "offline/model"
                    config[0]["currentValue"] = params["value"]
                    result = {"configOptions": config}
                else:
                    assert method == "session/prompt" and config[0]["currentValue"] == "offline/model"
                    assert state["title"]
                    if (home / "quota-exhausted").exists():
                        send(id=request["id"], error={"code": -32603, "message": "You exceeded your current quota"})
                        continue
                    prompt = params["prompt"][0]["text"]
                    instructions = role_file.read_text()
                    assert "managed Teamster executor" in instructions
                    assert "status needs_decision" in instructions and "Do not echo the schema" in instructions
                    assert "managed Teamster executor" not in prompt
                    answer = json.loads((home / "response.json").read_text())
                    wrapup = "The turn's time budget has expired." in prompt
                    if wrapup:
                        state["wrapup_context"] = prompt
                        stored.write_text(json.dumps(state))
                        answer["status"] = "partial"
                    elif "label" in state:
                        assert "Make the second change" in prompt
                        summary = "Follow-up edit " + state["label"]
                    else:
                        prompt = state.get("wrapup_context", "") + prompt
                        assert "Make the first change" in prompt
                        labels = [label for label in ("alpha", "beta") if f"[{label}]" in prompt]
                        assert len(labels) == 1
                        state["label"] = labels[0]
                        stored.write_text(json.dumps(state))
                        summary = "Initial edit " + state["label"]
                        if "Retry the interrupted request" in prompt:
                            summary += " (retried)"
                    if not wrapup:
                        send(id="edit", method="session/request_permission", params={
                            "sessionId": session_id, "toolCall": {"toolCallId": "edit", "title": "Edit tracked.txt"},
                            "options": [{"optionId": "deny", "kind": "reject_once", "name": "Deny"},
                                        {"optionId": "allow", "kind": "allow_once", "name": "Allow once"}],
                        })
                        decision = json.loads(sys.stdin.readline())
                        assert decision["id"] == "edit"
                        assert decision["result"]["outcome"] == {"outcome": "selected", "optionId": "allow"}
                        with (cwd / "tracked.txt").open("a") as out:
                            print(summary, file=out)
                        answer["summary"] = summary
                    reply = (home / "reply-mode").read_text() if (home / "reply-mode").exists() else "complete"
                    target = "ses_other" if reply == "wrong-session" else session_id
                    text = json.dumps(answer)
                    middle = len(text) // 2
                    for chunk in (text[:middle], text[middle:]):
                        update = {"sessionUpdate": "agent_message_chunk", "messageId": "answer",
                                  "content": {"type": "text", "text": chunk}}
                        send(method="session/update", params={"sessionId": target, "update": update})
                        if reply == "incomplete-json":
                            break
                    if reply == "truncated":
                        sys.exit(0)
                    if reply == "provider-error":
                        send(id=request["id"], error={"code": -32603, "message": "Unauthorized"})
                        continue
                    result = {"stopReason": "max_tokens" if reply == "length" else "end_turn"}
            send(id=request["id"], result=result)
            if method == "session/set_config_option" and (home / "delete-after-resume").exists():
                stored.unlink()
            if method == "session/prompt" and reply == "crash-after-answer":
                sys.exit(1)
        '''))
    fake.chmod(0o700)


class ExecutorTests(RotationTestCase):
    def response_items(self, thread):
        rollout = self.worker().threads.rollout_path(self.home, thread)
        events = map(json.loads, rollout.read_text().splitlines())
        return [event["payload"] for event in events if event["type"] == "response_item"]

    def test_codex_returns_required_review_to_operator(self):
        slug = "operator-review"
        review_order = "teamster scout nested-review 'Review tracked.txt'"
        edit = "echo 'Ready for review' > tracked.txt"
        self.commit_fixture({"AGENTS.md": f"After editing tracked.txt, obtain independent review with `{review_order}`.\n"})
        self.brief.write_text("Edit tracked.txt and follow the repository's review instructions.")
        self.configure(language="en")
        self.env.update(BOARD_TOKEN="fixture-token", BOARD_EXTERNAL_DUTY_CONFIG=str(self.root / "board.json"),
                        BOARD_URL="http://127.0.0.1:1")
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "shell": [edit], "required_review": review_order,
             "reply": self.work_result(summary="Edited tracked.txt.", checks=[])},
            {"mode": "complete", "reply": self.review_result(False)},
            {"mode": "complete", "reply": self.work_result(checks=[])}])

        self.start(slug, "--no-push")
        self.wait(slug)
        work = self.state(slug)
        self.assertEqual((Path(work["worktree"]) / "tracked.txt").read_text(), "Ready for review\n")
        self.assertEqual((work["result"]["status"], work["result"]["questions"]),
                         ("needs_decision", ["Please assign an independent review."]))
        calls = [item for item in self.response_items(work["thread"]) if item["type"] in ("function_call", "custom_tool_call")]
        self.assertEqual([json.loads(call["arguments"])["cmd"] for call in calls], [edit, "cat AGENTS.md"])

        subprocess.run([sys.executable, "-I", str(SCRIPT), "review", slug], cwd=work["worktree"],
                       env=self.env, capture_output=True, check=True, timeout=15)
        self.wait(slug)
        self.assertEqual(self.state(slug)["reviews"][-1]["result"], self.review_result(False))
        self.cli("say", slug, "Finish the reviewed change.")
        self.wait(slug)
        first, review, followup = self.invocations()
        for turn in (first, review, followup):
            self.assertIn("managed Teamster executor", turn["instructions"])
            if turn["review"]:
                self.assertFalse(turn["thread_config"]["agents"]["enabled"])
            else:
                self.assertNotIn("enabled", turn["thread_config"].get("agents", {}))
                for feature in ("multi_agent", "multi_agent_v2"):
                    self.assertNotIn(feature, turn["thread_config"].get("features", {}))
            self.assertIn({"name": "teamster", "enabled": False}, turn["thread_config"]["skills"]["config"])
            self.assertFalse(turn["thread_config"]["plugins"]["teamster@kaifaty"]["enabled"])
        self.assertTrue(review["review"])
        self.assertFalse(review["resume"])
        self.assertNotEqual(review["thread"], first["thread"])
        self.assertTrue(followup["resume"])
        self.assertEqual(followup["thread"], first["thread"])
        self.assertEqual(self.state(slug)["result"]["status"], "done")

    def test_codex_shell_records_denied_task_commands(self):
        slug = "operator-control"
        nested = "teamster scout nested-review 'Review tracked.txt'"
        queued = shlex.join([sys.executable, "-I", str(SCRIPT), "say", slug, "Unexpected order", "--queue"])
        start = shlex.join(["teamster", "start", "nested-work", "--brief", str(self.brief), "--no-push"])
        denied = [nested, queued, start, f"teamster review {slug}", "teamster _run missing", "teamster wait missing", "teamster duty clear"]
        reads = [f"teamster status {slug}", f"teamster stats {slug}", "teamster report --json"]
        # Stand in for an older installation later on PATH. The executor must reach this checkout's CLI.
        old = self.root / "teamster"
        old.write_text("#!/bin/sh\nexit 91\n")
        old.chmod(0o700)
        self.configure(language="en")
        pilot = self.worker()
        pilot.duty.pin_duty("claude", "fixture-operator", None)
        duty_record = pilot.duty.duty_path()
        saved_duty = duty_record.read_bytes()
        fixture = self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "shell": denied + reads, "reply": self.work_result(checks=[])}])
        # The native shell starts with only core variables. Keep any regression inside the fake installation.
        fixture["duty_config"] = {"shell_environment_policy": {"inherit": "core", "set": {
            "CODEX_TASK_CODEX": str(self.fake), "CODEX_TASK_HOME": str(self.home), "CODEX_FAKE_TRACE": str(self.trace_path)}}}
        (self.home / "fixture.json").write_text(json.dumps(fixture))
        self.start(slug, "--no-push")
        self.wait(slug)
        state = self.state(slug)
        items = self.response_items(state["thread"])
        calls = [item for item in items if item["type"] in ("function_call", "custom_tool_call")]
        self.assertEqual([json.loads(call["arguments"])["cmd"] for call in calls], denied + reads)
        outputs = {item["call_id"]: item["output"] for item in items if item["type"] == "function_call_output"}
        for call, verb in zip(calls, ("scout", "say", "start", "review", "_run", "wait", "duty")):
            self.assertIn(f"Exit code: 1\nteamster: '{verb}' is reserved for the operator", outputs[call["call_id"]])
        replies = [outputs[call["call_id"]] for call in calls[len(denied):]]
        for reply in replies:
            self.assertIn("Exit code: 0", reply)
        self.assertEqual(duty_record.read_bytes(), saved_duty)
        self.assertIn(slug, replies[0])
        self.assertIn("total:", replies[1])
        report = json.loads(replies[2].split("\n", 1)[1])
        self.assertIn("tasks", report)
        self.assertIn("accounts", report)
        self.assertEqual(list(self.home.glob("fixture-thread-*")), [self.home / ("fixture-thread-" + state["thread"])])
        self.assertFalse((self.home / "claude-tasks" / "nested-review").exists())
        self.assertFalse((self.home / "claude-tasks" / "nested-work").exists())
        self.assertFalse(state["reviews"])
        self.assertEqual(state["turns"], 1)
        self.assertFalse(self.worker().threads.followup_messages(state))

    def test_opencode_start_and_say_resume_the_worker_session(self):
        self.env.update(HOME=str(self.root), PWD=str(self.repo), TEAMSTER_CLAUDE=str(self.root / "missing-claude"))
        self.env.update(BOARD_TOKEN="fixture-token", BOARD_EXTERNAL_DUTY_CONFIG=str(self.root / "board.json"))
        profiles = {"feature": {"executor": "codex", "model": "codex-only", "effort": "high"}}
        real_binary = os.environ.get("TEAMSTER_TEST_OPENCODE")
        if real_binary:
            provider = local_opencode_provider(self.env, real_binary)
        else:
            install_fake_opencode(self.root)
            provider = contextlib.nullcontext()
        guidance = self.root / "opencode-guidance.md"
        guidance.write_text("Inline OpenCode guidance.\n")
        self.env["OPENCODE_CONFIG_CONTENT"] = json.dumps({"instructions": [str(guidance)]})
        (self.repo / "AGENTS.md").write_text(PROJECT_REVIEW + "\n")
        self.git("add", "AGENTS.md")
        self.git("commit", "-m", "Require independent review")
        handoff = self.work_result("needs_decision", checks=[],
                                   questions=["Can you arrange the required progress-review scout?"])
        (self.root / "response.json").write_text(json.dumps(handoff))
        flags = ["--executor", "opencode", "--model", "offline/model", "--task-type", "feature", "--no-push"]
        labels = {"opencode-work": "alpha", "opencode-parallel": "beta"}
        with provider as stop_requested:
            worktrees = self.git("worktree", "list", "--porcelain")
            for configured, options in (("off", ["--sandbox", "workspace"]), ("workspace", [])):
                self.configure(accounts=[], claude={"accounts": []}, task_profiles=profiles, sandbox=configured)
                refused = subprocess.run([sys.executable, "-I", str(SCRIPT), "start", "opencode-sandbox",
                                          "--brief", str(self.brief), *flags, *options],
                                         cwd=self.repo, env=self.env, text=True, capture_output=True, timeout=15)
                self.assertNotEqual(refused.returncode, 0)
                self.assertIn("--sandbox workspace is not supported", refused.stderr)
            self.assertEqual(self.git("worktree", "list", "--porcelain"), worktrees)
            self.assertFalse((self.root / "opencode-calls").exists())

            for slug, label in labels.items():
                self.brief.write_text(f"Make the first change to tracked.txt. Store this marker: [{label}].\n")
                self.start(slug, *flags, "--sandbox", "off", "--parallel",
                           "--check", f"grep -q 'Initial edit {label}' tracked.txt")

            sessions = {}
            for slug, label in labels.items():
                self.assertIn("Initial edit " + label, self.wait(slug))
                first = self.state(slug)
                self.assertEqual((first["executor"], first["task_model"], first["effort"], first["account"]),
                                 ("opencode", "offline/model", None, None))
                sessions[slug] = first["session_id"]
                self.assertTrue(first["session_id"])
                self.assertEqual((Path(first["worktree"]) / "tracked.txt").read_text(),
                                 f"initial\nInitial edit {label}\n")
            self.assertEqual(len(set(sessions.values())), 2)

            for slug in labels:
                self.cli("say", slug, "Make the second change to tracked.txt.")
            for slug, label in labels.items():
                summary = "Follow-up edit " + label
                self.assertIn(summary, self.wait(slug))
                second = self.state(slug)
                self.assertEqual((second["session_id"], second["turns"]), (sessions[slug], 2))
                self.assertEqual(second["result"], dict(handoff, summary=summary))
                self.assertEqual([check["outcome"] for check in second["checks"]], ["passed", "passed"])
                self.assertEqual((Path(second["worktree"]) / "tracked.txt").read_text(),
                                 f"initial\nInitial edit {label}\nFollow-up edit {label}\n")
            self.assertEqual((self.repo / "tracked.txt").read_text(), "initial\n")
            self.assertEqual(self.trace(), [])
            report = json.loads(self.cli("report", "--json", "--by", "executor"))
            self.assertEqual([group["executor"] for group in report["groups"]], ["opencode"])

            slug = "opencode-work"
            session = sessions[slug]
            worktree = Path(self.state(slug)["worktree"])
            binding = self.state(slug)["work_binding"]
            (self.root / "quota-exhausted").touch()
            self.cli("say", slug, "Continue on the original connection.")
            self.assertIn("reset time", self.cli("wait", slug))
            limited = self.state(slug)
            self.assertEqual((limited["outcome"], limited["work_binding"], limited["session_id"]),
                             ("exhausted", binding, session))
            (self.root / "quota-exhausted").unlink()
            if real_binary:
                info = subprocess.check_output(
                    ["opencode", "api", "--standalone", "session.get", "--param", f"sessionID={session}"],
                    cwd=worktree, env=dict(self.env, PWD=str(worktree)), timeout=30)
                self.assertEqual(json.loads(info)["data"]["title"], slug)
                other = "opencode-parallel"
                self.cli("say", other, "Wait here for stop.")
                self.assertTrue(stop_requested.wait(30))
                pid = self.state(other)["opencode_pid"]
                self.cli("stop", other)
                self.assertEqual(self.state(other)["outcome"], "stopped")
                self.assertEqual(self.state(other)["session_id"], sessions[other])
                self.assertFalse(self.process_is_live(pid))
                subprocess.run(["opencode", "session", "delete", "--standalone", session], cwd=worktree,
                               env=dict(self.env, PWD=str(worktree)), stdin=subprocess.DEVNULL,
                               capture_output=True, check=True, timeout=30)
            else:
                self.assertEqual((binding["provider"], binding["model"], binding["credential_id"]),
                                 ("offline", "offline/model", "cred_fixture"))
                self.assertEqual(self.state("opencode-parallel")["work_binding"]["source"], "local")
                self.assertNotIn("fixture-private", json.dumps(binding))
                (worktree / "fixture-route").write_text("http://127.0.0.1:9002/")
                self.cli("say", slug, "Continue at the assigned endpoint.")
                self.assertIn("assigned work connection", self.cli("wait", slug))
                self.assertEqual(self.state(slug)["session_id"], session)
                (worktree / "fixture-route").unlink()
                (self.root / "connection-id").write_text("cred_replacement")
                self.cli("say", slug, "Make a change on the original connection.")
                self.assertIn("assigned work connection", self.cli("wait", slug))
                self.assertEqual(self.state(slug)["work_binding"], binding)
                (self.root / "connection-id").unlink()
                (self.root / session).unlink()
            self.cli("say", slug, "Make a third change to tracked.txt.")
            output = self.cli("wait", slug, "--timeout", "30", timeout=45)
            failed = self.state(slug)
            self.assertEqual((failed["session_id"], failed["outcome"], failed.get("result")), (session, "failed", None))
            self.assertEqual(failed["error"], f"Saved OpenCode session {session} was not found")
            self.assertIn(failed["error"], output)
            summaries = [json.loads(msg)["summary"] for msg in self.worker().threads.session_messages(failed)]
            self.assertEqual(summaries, ["Initial edit alpha", "Follow-up edit alpha"])
            self.assertEqual((worktree / "tracked.txt").read_text(),
                             "initial\nInitial edit alpha\nFollow-up edit alpha\n")
            if not real_binary:
                stderr = self.home / "claude-tasks" / slug / "stderr.log"
                self.assertNotIn("PRIVATE-SESSION-METADATA", stderr.read_text())
                calls = (self.root / "opencode-calls").read_text().splitlines()
                self.assertEqual((calls.count("session/new"), calls.count("session/prompt")), (2, 5))

                (self.root / "delete-after-resume").touch()
                other = "opencode-parallel"
                self.cli("say", other, "Make a third change to tracked.txt.")
                self.cli("wait", other, "--timeout", "30", timeout=45)
                failed = self.state(other)
                self.assertEqual((failed["outcome"], failed["session_id"], failed.get("result")),
                                 ("failed", sessions[other], None))
                self.assertEqual((Path(failed["worktree"]) / "tracked.txt").read_text(),
                                 "initial\nInitial edit beta\nFollow-up edit beta\n")

    def test_opencode_stops_during_session_start_and_resume(self):
        self.env.update(HOME=str(self.root), PWD=str(self.repo))
        self.configure(accounts=[], claude={"accounts": []})
        self.brief.write_text("Make the first change to tracked.txt. Store this marker: [alpha].")
        install_fake_opencode(self.root)
        (self.root / "response.json").write_text(json.dumps(self.work_result(checks=[])))
        slug = "opencode-stop"
        gate = self.root / "hold-method"
        waiting = self.root / "waiting-pid"

        def stop_at(method, launch, *args):
            gate.write_text(method)
            with ThreadPoolExecutor(max_workers=1) as pool:
                # start waits for a session ID. Stop its worker while creation is still pending.
                launched = pool.submit(launch, *args)
                try:
                    self.until(lambda: waiting.exists() and waiting.read_text().isdigit(), timeout=15)
                    pid = int(waiting.read_text())
                    self.extra_pids.add(pid)
                    self.cli("stop", slug)
                    launched.result()
                    self.assertEqual(self.state(slug)["outcome"], "stopped")
                    self.assertFalse(self.process_is_live(pid))
                finally:
                    gate.unlink(missing_ok=True)
                    waiting.unlink(missing_ok=True)

        stop_at("session/new", self.start, slug, "--executor", "opencode", "--model", "offline/model", "--no-push")
        self.assertFalse(self.state(slug).get("session_id"))
        failure = self.root / "fail-title"
        failure.touch()
        self.cli("say", slug, "Retry the interrupted request.")
        self.assertIn("OpenCode session title update failed (1)", self.cli("wait", slug, "--timeout", "30"))
        session = self.state(slug)["session_id"]
        self.assertNotIn("session/prompt", (self.root / "opencode-calls").read_text())
        failure.unlink()
        self.cli("say", slug, "Retry the interrupted request.")
        self.assertIn("Initial edit alpha (retried)", self.wait(slug))
        self.assertEqual(self.state(slug)["session_id"], session)
        binding = self.state(slug)["work_binding"]
        self.assertEqual(binding["source"], "settings")
        self.assertNotIn("fixture-local-key", json.dumps(binding))
        key = Path(self.state(slug)["worktree"]) / "fixture-key"
        key.write_text("fixture-replacement-key")
        self.cli("say", slug, "Continue on the assigned local connection.")
        self.assertIn("assigned work connection", self.cli("wait", slug))
        self.assertEqual(self.state(slug)["work_binding"], binding)
        key.unlink()
        stop_at("session/resume", self.cli, "say", slug, "Make the second change to tracked.txt.")

        calls = (self.root / "opencode-calls").read_text().splitlines()
        self.assertEqual(calls.count("session/prompt"), 1)
        self.assertEqual(calls[-1], "session/resume")

    def test_opencode_first_turn_timeout_keeps_the_brief_for_say(self):
        self.env.update(HOME=str(self.root), PWD=str(self.repo))
        self.configure(language="en", accounts=[], claude={"accounts": []})
        self.enable_fake_clock(auto_advance=False)
        self.brief.write_text("Make the first change to tracked.txt. Store this marker: [alpha].")
        install_fake_opencode(self.root)
        (self.root / "response.json").write_text(json.dumps(self.work_result(checks=[])))
        slug = "opencode-timeout"
        gate = self.root / "hold-method"
        waiting = self.root / "waiting-pid"
        gate.write_text("session/prompt")
        try:
            self.start(slug, "--executor", "opencode", "--model", "offline/model", "--no-push", "--max-minutes", "1")
            self.until(lambda: waiting.exists() and waiting.read_text().isdigit(), timeout=15)
            worker_pid = int(waiting.read_text())
            self.extra_pids.add(worker_pid)
            session = self.state(slug)["session_id"]
            self.advance_fake_clock(60)
            self.until(lambda: not self.process_is_live(worker_pid), timeout=10)
        finally:
            gate.unlink(missing_ok=True)
        self.wait(slug)
        state = self.state(slug)
        self.assertEqual((state["outcome"], state["result"]["status"]), ("budget_exhausted", "partial"))
        phases = [(row["phase"], row["session_id"]) for row in self.phase_telemetry_journal()]
        self.assertEqual(phases, [("work", session), ("wrapup", session)])
        self.cli("say", slug, "Retry the interrupted request.")
        self.assertIn("Initial edit alpha (retried)", self.wait(slug))
        self.assertEqual(self.state(slug)["session_id"], session)

    def test_codex_backend_rejects_schema_bearing_turn_outside_admitted_session(self):
        bridge = self.worker().turn_monitor.codex_acp
        # An echo backend makes any forwarded request visible on stdout.
        echo = self.root / "echo-backend"
        echo.write_text("#!/bin/sh\nexec /bin/cat\n")
        echo.chmod(0o700)
        (self.root / "options").write_text("{}")
        env = dict(self.env, TEAMSTER_ACP_BACKEND=str(echo), TEAMSTER_ACP_TURN_DIR=str(self.root))
        env[bridge.procs.TURN_PROCESS_MARKER] = "fixture-turn"
        request = {"id": 1, "method": "turn/start", "params": {
            "threadId": "title-thread", "outputSchema": {"type": "object", "properties": {"title": {"type": "string"}}}}}
        for admitted in (False, True):
            with self.subTest(admitted=admitted):
                if admitted:
                    (self.root / "target").write_text("worker-thread")
                result = subprocess.run(bridge.command("backend", "app-server"), cwd=self.root, env=env,
                                        input=json.dumps(request) + "\n", text=True, capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("outside the admitted ACP session", result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertFalse((self.root / "sent").exists())

    def test_codex_close_distinguishes_legacy_missing_method_from_cleanup_failure(self):
        self.configure(language="en")
        result = self.work_result()
        self.account(self.home, "A", self.reset, runs=[{"mode": "complete", "reply": result, "spawn_child": "detached"}])
        fixture = self.home / "fixture.json"
        account = json.loads(fixture.read_text())
        for slug, reply, error in (
                ("legacy-close", {"error": {"code": -32601, "message": "Method not found"}}, None),
                ("invalid-close", {"result": {}}, "Invalid background terminal list"),
                ("internal-close", {"error": {"code": -32603, "message": "Method not found"}}, "Method not found")):
            with self.subTest(slug=slug):
                fixture.write_text(json.dumps(dict(account, terminal_list_reply=reply)))
                self.start(slug, "--executor", "codex")
                output = self.cli("wait", slug, "--timeout", "30")
                child = [row["child_pid"] for row in self.trace() if row.get("command") == "exec-child"][-1]
                self.extra_pids.add(child)
                self.assertFalse(self.process_is_live(child))
                state = self.state(slug)
                self.assertEqual(state["outcome"], "failed" if error else "completed")
                self.assertEqual(state["result"], None if error else result)
                if error:
                    self.assertIn(error, state["error"])
                    self.assertNotIn("== result: done", output)

    def test_acp_stdio_conversation(self):
        self.env.update(HOME=str(self.root), BOARD_TOKEN="fixture-operator-token")
        repo = self.root / "work tree"
        repo.mkdir()
        agent = self.root / "acp agent.py"
        agent.write_text(textwrap.dedent('''\
            import json
            import os
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
            reply(init, protocolVersion=1, agentCapabilities={"loadSession": True,
                  "sessionCapabilities": {} if mode == "configured" else {"close": {}}},
                  authMethods=[{"id": "fixture", "name": "Fixture"}])
            if mode == "load":
                auth = receive("authenticate")
                assert auth["params"]["methodId"] == "fixture"
                reply(auth)
            session = receive("session/" + ("new" if mode == "configured" else mode))
            assert session["params"]["cwd"] == str(Path.cwd())
            assert "systemPrompt" not in session["params"] and "TEAMSTER_MANAGED_EXECUTOR" not in os.environ
            assert os.environ.get("BOARD_TOKEN") == "fixture-operator-token"
            if mode == "configured":
                option = {"id": "reasoning_effort", "type": "select", "currentValue": "low",
                          "options": [{"group": "efforts", "name": "Efforts",
                                       "options": [{"value": "high", "name": "High"}]}]}
                reply(session, sessionId="session-1", configOptions=[option])
                selected = receive("session/set_config_option")
                assert selected["params"] == {"sessionId": "session-1",
                    "configId": "reasoning_effort", "value": "high"}
                reply(selected, configOptions=[dict(option, currentValue="high")])
                prompt = receive("session/prompt")
                send(id=prompt["id"], error={"code": -32603, "message": "Internal error",
                                            "data": {"message": "Usage limit reached"}})
                sys.exit(0)
            elif mode == "new":
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
            closing = receive("session/close")
            assert closing["params"]["sessionId"] == "session-1"
            reply(closing)
            '''))
        for mode, options in (("new", []), ("load", ["--resume", "session-1", "--auth-method", "fixture"])):
            with self.subTest(mode=mode):
                cmd = [sys.executable, "-I", str(SCRIPT), "acp", "--repo", str(repo), *options,
                       "--", sys.executable, "-I", str(agent), mode, "--literal=two words; *"]
                run = subprocess.run(cmd, cwd=self.root, env=self.env, text=True, input="first turn\n1\n",
                                     capture_output=True, timeout=15)
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(run.stdout, "Reply to first turn\nReply to 1\n")

        acp = self.worker().commands.acp
        with acp.AcpClient([sys.executable, "-I", str(agent), "configured", "--literal=two words; *"],
                           repo, lambda update: None, lambda params: None, env=self.env) as client:
            self.assertEqual(client.open_session(config_options={"reasoning_effort": "high"}), "session-1")
            with self.assertRaisesRegex(acp.AcpRequestError, "Usage limit reached") as failure:
                client.prompt("Work")
            self.assertEqual(failure.exception.code, -32603)
            self.assertEqual(failure.exception.data, {"message": "Usage limit reached"})

    def test_codex_tool_updates_keep_board_edit_paths_and_subagent_prompts(self):
        transport = self.worker().turn_monitor.codex_acp
        updates = transport.Updates()
        diff = {"type": "diff", "path": "src/main.py", "oldText": "old", "newText": "new"}
        with mock.patch.object(transport, "emit") as emit:
            updates.update({"sessionUpdate": "tool_call", "toolCallId": "edit", "kind": "edit",
                            "title": "Editing files", "content": [diff, diff]})
            updates.update({"sessionUpdate": "tool_call", "toolCallId": "agent", "kind": "other",
                            "title": "spawnAgent", "rawInput": {"senderThreadId": "one", "prompt": "Inspect tests"}})
        self.assertEqual([call.args[0]["item"] for call in emit.call_args_list],
                         [{"id": "edit", "type": "file_change", "changes": [{"path": "src/main.py"}]},
                          {"id": "agent", "type": "collab_tool_call", "tool": "spawnAgent", "prompt": "Inspect tests"}])

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
        self.env.update(HOME=str(self.root), PWD=str(self.repo))
        install_fake_opencode(self.root)
        (self.root / "response.json").write_text(json.dumps(self.work_result()))
        runner = self.worker().turns.opencode_runner
        with mock.patch.dict(os.environ, self.env, clear=True):
            (self.root / "unbound-direct-call").touch()
            for reply in ("truncated", "provider-error", "wrong-session", "length", "crash-after-answer"):
                with self.subTest(reply=reply):
                    (self.root / "reply-mode").write_text(reply)
                    outcome, _ = runner.run_opencode(
                        self.repo, "Make the first change [alpha]", "offline/model", None,
                        lambda: False, None, title="opencode-failure", created=lambda session: None)
                    self.assertEqual(outcome, "failed")

        (self.root / "unbound-direct-call").unlink()
        (self.root / "reply-mode").write_text("incomplete-json")
        self.brief.write_text("Make the first change [alpha].")
        slug = "opencode-incomplete"
        self.start(slug, "--executor", "opencode", "--model", "offline/model", "--no-push", "--check", "touch check-ran")
        self.assertIn("OpenCode returned an invalid work result", self.cli("wait", slug, "--timeout", "30", timeout=45))
        state = self.state(slug)
        self.assertEqual((state["outcome"], state["result"], state["checks"]), ("failed", None, []))
        self.assertFalse((Path(state["worktree"]) / "check-ran").exists())

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
            self.assertEqual(reviewed["outcome"], "unavailable")
            self.assertIn("separate linked task", reviewed["error"])
            self.assertEqual(len(self.review_invocations()), 0)
            turn.assert_called_once()

            cli("scout", "registered-scout", "Read the fixture", "--repo", str(self.repo), "--executor", name)
            scout.assert_called_once()
            self.assertEqual(self.state("registered-scout")["outcome"], "completed")


if __name__ == "__main__":
    unittest.main()
