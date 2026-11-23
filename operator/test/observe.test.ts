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
  t.after(() => assert.ok(boardRequests.every(request => /^GET (events\?after=\d+|tasks(\/[^/?]+)?|project-titles)$/.test(request))));
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
    const last = request.messages.at(-1);
    if (mock.mode === "chat") {
      assert.ok(!request.tools?.length);
      const prompt = JSON.parse(last.content);
      assert.equal(prompt.task.saved_check.command, "verify-labels");
      assert.equal(prompt.conversation[0].answer, "The check passed.");
      assert.equal(prompt.question, "What should I do next?");
      completion(res, { content: "Review the result for acceptance." }, "stop");
      return;
    }
    assert.deepEqual(request.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(),
      ["get_task", "list_tasks"]);
    mock.onCall?.();
    if (mock.mode === "hang") return;
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
  if (!live) mock.onCall = () => {
    const db = new DatabaseSync(state, { readOnly: true });
    try {
      const active = db.prepare("SELECT * FROM reviewing").all();
      assert.equal(active.length, 1);
      assert.ok(events.some(event => event.id === active[0].event_id));
      assert.ok(Number(active[0].expires_at) > Date.now());
    } finally {
      db.close();
    }
  };
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
  const recommendations = rows.map((row): string => row.recommendation);
  if (live) {
    for (const [i, card] of cards.slice(0, 2).entries()) {
      const saved = card.checks.saved!;
      const outcome = saved.outcome === "passed" ? /\b(pass\w*|succeed\w*|success\w*)\b/i : /\bfail\w*\b/i;
      const exitCode = new RegExp(String.raw`\bexit(?:\s+(?:code|status))?(?:\s+of)?\W*${saved.exit}\b`, "i");
      assert.ok(recommendations[i].includes(saved.command), `Missing saved check ${saved.command}`);
      assert.ok(outcome.test(recommendations[i]) || exitCode.test(recommendations[i]),
        `Missing saved outcome for ${saved.command}: ${saved.outcome} (exit ${saved.exit})`);
    }
    const failure = recommendations[1].toLowerCase().replace(/[`*_]/g, "");
    const namedExecutor = failure.split(/[^a-z0-9-]+/).includes(cards[1].executor.toLowerCase());
    const sameExecutor = failure.split(/[.!?;\n]/).some(clause =>
      /\b(same|original)\b/.test(clause) && /\b(executor|worker|assignee|agent)\b/.test(clause));
    assert.ok(namedExecutor || sameExecutor, `Missing reference to the assigned executor (${cards[1].executor})`);
    assert.ok(recommendations[2].includes(question), "Missing the verbatim decision question");
    assert.match(recommendations[2], /\b(human|person|user|reviewer)\b/i);
  } else {
    assert.deepEqual(recommendations, [
      `${cards[0].id}: verify-labels passed. Hand the task to the human for acceptance.`,
      `${cards[1].id}: mobile-layout failed. Return the task to the same executor.`,
      `${cards[2].id}: Ask the human "${question}" and wait for their answer.`,
    ]);
  }
  const calls = output.filter(row => row.type === "model_call").length;
  assert.equal(rows.reduce((total, row) => total + row.model_calls, 0), calls);
  if (!live) assert.equal(mock.calls, calls);
  assert.equal(output.find(row => row.type === "page").model_calls, calls);

  feed.events = [];
  feed.next_cursor = 1600;
  assert.deepEqual((await run()).find(row => row.type === "page"), { type: "page", after: 1200, next_cursor: 1600, events: 0,
    recommendations: 0, model_calls: 0 });

  feed.events = events;
  feed.next_cursor = 1150;
  const beforeReplay = boardRequests.length;
  const replay = await run();
  assert.deepEqual(boardRequests.slice(beforeReplay),
    ["GET events?after=1600", "GET tasks", "GET events?after=0", "GET project-titles"]);
  assert.ok(replay.some(row => row.type === "reconcile" && row.cards === 3 && row.unrecorded.length === 0));
  assert.deepEqual(replay.find(row => row.type === "page"),
    { type: "page", after: 0, next_cursor: 1150, events: 3, recommendations: 0, model_calls: 0 });
  const db = new DatabaseSync(state, { readOnly: true });
  t.after(() => db.close());
  assert.deepEqual(db.prepare("SELECT * FROM reviewing").all(), []);
  assert.deepEqual(db.prepare("SELECT event_id, recommendation FROM recommendations ORDER BY rowid").all()
    .map(row => [row.event_id, row.recommendation]), rows.map(row => [row.event_id, row.recommendation]));
  assert.equal(db.prepare("SELECT cursor FROM feed").get()!.cursor, 1150);
  if (!live) assert.equal(mock.calls, calls);

  if (!live) {
    const writable = new DatabaseSync(state);
    t.after(() => writable.close());
    const prompt = JSON.stringify({ task: { saved_check: { command: "verify-labels", outcome: "passed" } },
      conversation: [{ question: "What happened?", answer: "The check passed." }], question: "What should I do next?" });
    writable.prepare("INSERT INTO chat_requests (id, prompt, deadline) VALUES ('question', ?, ?)")
      .run(prompt, Date.now() + 30_000);
    mock.mode = "chat";
    await run();
    assert.deepEqual({ ...db.prepare("SELECT prompt, answer, failed FROM chat_requests").get() },
      { prompt: "", answer: "Review the result for acceptance.", failed: 0 });
    await run();
    assert.equal(mock.calls, calls + 1);
  }
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
  assert.equal(resumed.find(row => row.type === "page").recommendations, 1);
  assert.equal(expired.event_id, events[1].id);
  assert.equal(expired.source, "handoff");
  assert.match(expired.recommendation, /60-second event budget/);
  assert.equal(expired.model_calls, 2);
  assert.equal(mock.calls, 5);
});
