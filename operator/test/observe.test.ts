import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

const question = "Should existing notes keep their original labels?";
function card(slug: string, command: string | null, exit: number, question: string | null = null) {
  return {
    id: `${slug}:0x1.a000000000000p+30`, slug, turn: 1, repository: "/training/notebook",
    goal: "Update the notebook.", executor: "codex", account: null, phase: "idle", outcome: "completed",
    status: question ? "needs_decision" : "succeeded", result_status: question ? "needs_decision" : "done",
    summary: question ? "Waiting for a decision." : "The worker reports all checks passed.",
    blocker: question, question, pr: null,
    checks: {
      saved: command ? { command, outcome: exit === 0 ? "passed" : "failed", exit, seconds: 2, at: 1744830470 } : null,
      reported: command ? [{ command, outcome: "passed", details: "Exit 0." }] : [], ci: null,
    },
    created_at: 1744830464, updated_at: 1744830471, deadline_at: null,
    alive: false, stop_requested: false, archived: false, no_push: true, host_status: "online",
    version: createHash("sha256").update(slug).digest("hex"),
  };
}
const cards = [
  card("label-export", "verify-labels", 0), card("toolbar-spacing", "mobile-layout", 1),
  card("archive-owner", null, 0, question),
];
const events = cards.map(card => ({
  id: randomUUID().replaceAll("-", ""), task_id: card.id, type: card.question ? "needs_decision" : "task_finished",
  repository: card.repository, turn: card.turn, at: card.updated_at, status: card.status, outcome: card.outcome,
  result_status: card.result_status, summary: card.summary, checks: card.checks, pr: null,
  ...(card.question ? { question: card.question } : {}),
}));

async function listen(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function completion(res: ServerResponse, delta: object, finish_reason: "stop" | "tool_calls") {
  const chunk = { choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason }] };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

async function trial(t: TestContext, realMini?: string) {
  const dir = await mkdtemp(join(tmpdir(), "operator-observe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state.sqlite");
  const token = randomBytes(32).toString("hex");
  const cloudKey = randomBytes(32).toString("hex");
  const feed = { events, next_cursor: 1200 };
  const boardRequests: string[] = [];
  t.after(() => assert.ok(boardRequests.every(request => /^GET (events\?after=\d+|tasks(\/[^/?]+)?)$/.test(request))));
  const mock: { calls: number; mode: string; onCall?: () => void } = { calls: 0, mode: "recommend" };
  const board = await listen(t, (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const route = url.pathname.replace(/^\/api\/external-duty\/v1\//, "");
    boardRequests.push(`${req.method} ${route}${url.search}`);
    if (req.method !== "GET" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end();
    } else if (route === "events") {
      const after = Number(url.searchParams.get("after"));
      if (after > feed.next_cursor) {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: { code: "invalid_cursor" } }));
      } else {
        res.end(JSON.stringify({ ...feed, events: after === feed.next_cursor ? [] : feed.events }));
      }
    } else if (route === "tasks") {
      res.end(JSON.stringify({ tasks: cards }));
    } else {
      const task = cards.find(card => route === "tasks/" + encodeURIComponent(card.id));
      if (task) res.end(JSON.stringify({ task }));
      else res.writeHead(404).end(JSON.stringify({ ok: false, error: { code: "task_not_found" } }));
    }
  });
  const mini = realMini ?? (await listen(t, async (req, res) => {
    mock.calls++;
    assert.equal(req.method + " " + req.url, "POST /v1/chat/completions");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    assert.ok([token, cloudKey].every(key => !(raw + JSON.stringify(req.headers)).includes(key)));
    const request = JSON.parse(raw);
    assert.equal(request.model, "inkling-2-mini");
    assert.deepEqual(request.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(),
      ["get_task", "list_tasks"]);
    mock.onCall?.();
    if (mock.mode === "hang") return;
    const last = request.messages.at(-1);
    if (mock.mode === "loop" || last.role === "user") {
      const list = mock.mode === "loop";
      const args = list ? {} : { id: JSON.parse(last.content).task_id };
      completion(res, { tool_calls: [{ index: 0, id: "read_" + mock.calls, type: "function",
        function: { name: list ? "list_tasks" : "get_task", arguments: JSON.stringify(args) } }] }, "tool_calls");
    } else {
      assert.equal(last.role, "tool");
      const { question, checks } = JSON.parse(last.content);
      const saved = checks.saved;
      let text;
      if (question) text = `Ask the human "${question}" and wait for their answer.`;
      else if (saved.outcome === "failed") text = `${saved.command} failed. Return the task to the same executor.`;
      else text = `${saved.command} passed. Hand the task to the human for acceptance.`;
      completion(res, { content: text }, "stop");
    }
  })) + "/v1";
  async function run(signal?: AbortSignal) {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["src/observe.ts", "--once"], {
      cwd: new URL("../", import.meta.url), timeout: 200_000, signal,
      env: { BOARD_URL: board, BOARD_TOKEN: token, MINI_BASE_URL: mini, OPERATOR_STATE: state, OPENAI_API_KEY: cloudKey },
    });
    assert.ok([token, cloudKey].every(key => !(stdout + stderr).includes(key)));
    return stdout.trim().split("\n").map(line => JSON.parse(line));
  }
  return { feed, state, boardRequests, mock, run };
}

test("three work outcomes, empty page, restart and cursor recovery", async t => {
  const live = process.env.TRIAL_MINI_URL;
  const { feed, state, boardRequests, mock, run } = await trial(t, live);
  const output = await run();
  const rows = output.filter(row => row.type === "recommendation");
  for (const row of rows) t.diagnostic(JSON.stringify(row));
  assert.deepEqual(rows.map(row => row.task_id), cards.map(card => card.id));
  for (const [i, row] of rows.entries()) {
    assert.equal(row.source, "mini");
    assert.ok(row.recommendation.includes(cards[i].id));
    assert.ok(row.model_calls >= 2 && row.model_calls <= 3);
    assert.ok(boardRequests.includes("GET tasks/" + encodeURIComponent(cards[i].id)));
  }
  assert.match(rows[0].recommendation, /verify-labels/);
  assert.match(rows[0].recommendation, /accept/i);
  assert.match(rows[1].recommendation, /mobile-layout/);
  assert.match(rows[1].recommendation, /same executor|original (executor|worker)|back to (the )?(executor|codex)/i);
  assert.ok(rows[2].recommendation.includes(question));
  assert.match(rows[2].recommendation, /human/i);
  assert.match(rows[2].recommendation, /wait|pause|on hold/i);
  const calls = output.filter(row => row.type === "model_call").length;
  assert.equal(rows.reduce((total, row) => total + row.model_calls, 0), calls);
  if (!live) assert.equal(mock.calls, calls);
  assert.equal(output.at(-1).model_calls, calls);

  feed.events = [];
  feed.next_cursor = 1600;
  assert.deepEqual((await run()).at(-1), { type: "page", after: 1200, next_cursor: 1600, events: 0,
    recommendations: 0, model_calls: 0 });

  feed.events = events;
  feed.next_cursor = 1150;
  const beforeReplay = boardRequests.length;
  const replay = await run();
  assert.deepEqual(boardRequests.slice(beforeReplay), ["GET events?after=1600", "GET tasks", "GET events?after=0"]);
  assert.ok(replay.some(row => row.type === "reconcile" && row.cards === 3 && row.unrecorded.length === 0));
  assert.deepEqual(replay.at(-1), { type: "page", after: 0, next_cursor: 1150, events: 3, recommendations: 0, model_calls: 0 });
  const db = new DatabaseSync(state, { readOnly: true });
  t.after(() => db.close());
  assert.deepEqual(db.prepare("SELECT event_id, recommendation FROM recommendations ORDER BY rowid").all()
    .map(row => [row.event_id, row.recommendation]), rows.map(row => [row.event_id, row.recommendation]));
  assert.equal(db.prepare("SELECT cursor FROM feed").get()!.cursor, 1150);
  if (!live) assert.equal(mock.calls, calls);
});

test("the call limit and the original event deadline hand off to a human", async t => {
  const { feed, run, mock, state } = await trial(t);
  feed.events = events.slice(0, 2);
  mock.mode = "loop";
  const stop = new AbortController();
  mock.onCall = () => {
    if (mock.calls === 4) {
      mock.mode = "hang";
      stop.abort();
    }
  };
  await assert.rejects(run(stop.signal), { name: "AbortError" });
  const db = new DatabaseSync(state);
  t.after(() => db.close());
  const capped = db.prepare("SELECT * FROM recommendations WHERE event_id = ?").get(events[0].id)!;
  assert.equal(capped.source, "handoff");
  assert.match(String(capped.recommendation), /three-call limit/);
  assert.equal(capped.model_calls, 3);
  assert.equal(db.prepare("SELECT cursor FROM feed").get(), undefined);
  // Resume the interrupted second event with five seconds left and a model that never responds.
  db.prepare("UPDATE recommendations SET started_at = ? WHERE event_id = ?").run(Date.now() - 55_000, events[1].id);
  const resumed = await run(AbortSignal.timeout(15_000));
  const [expired] = resumed.filter(row => row.type === "recommendation");
  assert.equal(resumed.at(-1).recommendations, 1);
  assert.equal(expired.event_id, events[1].id);
  assert.equal(expired.source, "handoff");
  assert.match(expired.recommendation, /60-second event budget/);
  assert.equal(expired.model_calls, 2);
  assert.equal(mock.calls, 5);
});
