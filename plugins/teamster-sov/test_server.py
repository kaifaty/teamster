"""Exercise the MCP stdio adapter against a local fake Board."""
import json
import sys
import tempfile
import threading
import unittest
from contextlib import asynccontextmanager
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


API = "/api/external-duty/v1"
ADAPTER = Path(__file__).with_name("server.py")
TOKEN = "fake-board-token-for-mcp-tests-only"
RUNNING = "running:0x1.0000000000000p+0"
DECISION = "decision:0x1.0000000000000p+1"
FOREIGN = "foreign:0x1.0000000000000p+2"
UNAVAILABLE = "unavailable:0x1.0000000000000p+3"
REDIRECT = "redirect:0x1.0000000000000p+4"
PR = "https://github.com/example/pilot/pull/42"


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        root = Path(scratch.name).resolve()
        repository = root / "pilot"
        repository.mkdir()
        self.private_path = f"{repository}/private.txt"
        self.config = root / "board.json"
        self.config.write_text(json.dumps({
            "actor": "test-mcp",
            "token": TOKEN,
            "repositories": [str(repository)],
            "max_parallel": 1,
            "task_timeout_seconds": 600,
        }), encoding="utf-8")
        self.config.chmod(0o600)

        cards = {
            RUNNING: {
                "id": RUNNING, "repository": str(repository), "status": "running",
                "phase": "turn", "turn": 1,
                "goal": f"Prepare a patch using -I{self.private_path} and {TOKEN}.\n"
                        "Additional brief contents should stay local.",
                "pr": f"https://user:{TOKEN}@github.com/example/pilot/pull/1?token={TOKEN}",
            },
            DECISION: {
                "id": DECISION, "repository": str(repository), "status": "needs_decision",
                "phase": "idle", "turn": 2, "result_status": "needs_decision",
                "summary": "Prepared a patch.", "question": "Which label should we use?",
                "checks": {
                    "saved": {"command": f"cat {self.private_path}", "outcome": "passed", "exit": 0},
                    "reported": [{"command": "unit tests", "outcome": "passed",
                                  "details": f"private check details: {TOKEN}"}],
                    "ci": {"outcome": "failed", "passed": 3, "failed": 1, "total": 4},
                },
                "pr": PR, "log": f"raw worker log: {TOKEN}", "account": "private account name",
            },
            FOREIGN: {
                "id": FOREIGN, "repository": str(root / "foreign"), "status": "running",
                "goal": "foreign repository goal",
            },
        }
        self.requests = []
        requests = self.requests
        private_body = {"error": {"code": "host_unreachable", "detail": f"{TOKEN} {self.private_path}"}}

        class BoardHandler(BaseHTTPRequestHandler):
            def parse_request(self):
                if not super().parse_request():
                    return False
                self.authorized = self.headers.get_all("Authorization") == [f"Bearer {TOKEN}"]
                requests.append((self.command, self.path, self.authorized))
                return True

            def do_GET(self):
                path = unquote(self.path)
                if not self.authorized:
                    status, body = 403, {"error": {"code": "forbidden"}}
                elif path == f"{API}/tasks":
                    status, body = 200, {"tasks": list(cards.values())}
                elif path == f"{API}/tasks/{UNAVAILABLE}":
                    status, body = 503, private_body
                elif path == f"{API}/tasks/{REDIRECT}":
                    self.send_response(302)
                    self.send_header("Location", f"{API}/events")
                    self.end_headers()
                    return
                elif (task_id := path.removeprefix(f"{API}/tasks/")) in cards:
                    status, body = 200, {"task": cards[task_id]}
                else:
                    status, body = 404, {"error": {"code": "task_not_found"}}
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def log_message(self, *args):
                pass

        self.board = ThreadingHTTPServer(("127.0.0.1", 0), BoardHandler)
        thread = threading.Thread(target=self.board.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(self.board.server_close)
        self.addCleanup(self.board.shutdown)

    @asynccontextmanager
    async def connect(self):
        params = StdioServerParameters(command=sys.executable, args=[
            str(ADAPTER), str(self.config), "--board-port", str(self.board.server_port),
        ])
        async with stdio_client(params) as (reader, writer):
            async with ClientSession(reader, writer, read_timeout_seconds=timedelta(seconds=10)) as session:
                await session.initialize()
                yield session

    def assert_sanitized(self, result):
        serialized = result.model_dump_json()
        for private in (TOKEN, str(self.config.parent), "raw worker log", "private check details",
                        "private account name", "foreign repository goal", "Additional brief contents"):
            self.assertNotIn(private, serialized)

    async def test_tools_return_compact_cards_for_one_repository(self):
        async with self.connect() as session:
            tools = (await session.list_tools()).tools
            self.assertEqual({tool.name for tool in tools}, {"list_tasks", "get_task"})
            self.assertTrue(all(tool.annotations and tool.annotations.readOnlyHint for tool in tools))
            listed = await session.call_tool("list_tasks", {})
            detail = await session.call_tool("get_task", {"task_id": DECISION})

        for result in (listed, detail):
            self.assertFalse(result.isError)
            self.assert_sanitized(result)
        cards = {card["id"]: card for card in listed.structuredContent["tasks"]}
        self.assertEqual(set(cards), {RUNNING, DECISION})
        self.assertEqual((cards[RUNNING]["status"], cards[RUNNING]["phase"]), ("running", "turn"))
        self.assertIn("Prepare a patch", cards[RUNNING]["progress"])
        self.assertFalse(cards[RUNNING].get("pr"))

        decision = detail.structuredContent["task"]
        self.assertEqual(decision, cards[DECISION])
        self.assertEqual((decision["repository"], decision["status"], decision["phase"], decision["turn"]),
                         ("pilot", "needs_decision", "idle", 2))
        self.assertEqual(decision["question"], "Which label should we use?")
        self.assertEqual(decision["progress"], "Prepared a patch.")
        self.assertEqual(decision["pr"], PR)
        checks = decision["checks"]
        self.assertEqual(checks["saved"]["outcome"], "passed")
        self.assertEqual(checks["reported"][0]["outcome"], "passed")
        self.assertEqual((checks["ci"]["outcome"], checks["ci"]["failed"], checks["ci"]["total"]), ("failed", 1, 4))
        self.assertEqual([(method, unquote(path), authorized) for method, path, authorized in self.requests],
                         [("GET", f"{API}/tasks", True), ("GET", f"{API}/tasks/{DECISION}", True)])

    async def test_foreign_tasks_and_upstream_error_details_remain_private(self):
        async with self.connect() as session:
            for task_id in (FOREIGN, UNAVAILABLE, REDIRECT, "../events?after=0"):
                with self.subTest(task_id=task_id):
                    result = await session.call_tool("get_task", {"task_id": task_id})
                    self.assertTrue(result.isError)
                    self.assert_sanitized(result)
        self.assertEqual([(method, unquote(path), authorized) for method, path, authorized in self.requests],
                         [("GET", f"{API}/tasks/{task_id}", True)
                          for task_id in (FOREIGN, UNAVAILABLE, REDIRECT)])


if __name__ == "__main__":
    unittest.main()
