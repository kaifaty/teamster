import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { connectBoard, InvalidCursor, localUrl } from "./board.ts";
import { answerQuestion, MAX_CALLS, recommend, titleFor } from "./mini.ts";

async function main() {
  const args = process.argv.slice(2);
  const once = args.length === 1 && args[0] === "--once";
  if (args.length && !once) throw new Error("Usage: npm start -- [--once]");
  const token = process.env.BOARD_TOKEN ?? "";
  if (!token || !process.env.BOARD_URL) throw new Error("Set BOARD_URL and BOARD_TOKEN for the training Board");
  const board = connectBoard(localUrl(process.env.BOARD_URL, "/"), token);
  const mini = localUrl(process.env.MINI_BASE_URL ?? "http://127.0.0.1:18779/v1", "/v1");
  const db = new DatabaseSync(process.env.OPERATOR_STATE ?? "operator.sqlite");
  db.exec(`
    PRAGMA busy_timeout = 1000;
    CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY CHECK (id = 1), cursor INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS recommendations (
      event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, turn INTEGER NOT NULL,
      started_at INTEGER NOT NULL, model_calls INTEGER NOT NULL DEFAULT 0,
      source TEXT, recommendation TEXT
    );
    CREATE TABLE IF NOT EXISTS reviewing (
      event_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_requests (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, deadline INTEGER NOT NULL,
      claimed INTEGER NOT NULL DEFAULT 0, answer TEXT, failed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS project_chat (
      id TEXT PRIMARY KEY, card TEXT NOT NULL, at REAL NOT NULL, question TEXT NOT NULL, reference TEXT
    );
    CREATE INDEX IF NOT EXISTS project_chat_by_card ON project_chat(card, at);
  `);
  const signalReview = db.prepare(`INSERT INTO reviewing VALUES (?, ?)
    ON CONFLICT (event_id) DO UPDATE SET expires_at = excluded.expires_at`);
  const clearReview = db.prepare("DELETE FROM reviewing WHERE event_id = ?");
  const claimQuestion = db.prepare(`UPDATE chat_requests SET claimed = 1 WHERE id = (
    SELECT id FROM chat_requests WHERE claimed = 0 AND deadline > ? ORDER BY deadline, id LIMIT 1
  ) RETURNING id, prompt, deadline`);
  const saveAnswer = db.prepare("UPDATE chat_requests SET prompt = '', answer = ?, failed = ? WHERE id = ?");
  const pruneQuestions = db.prepare(`DELETE FROM chat_requests WHERE deadline <= ?
    AND id NOT IN (SELECT id FROM project_chat)`);

  async function chat() {
    const now = Date.now();
    pruneQuestions.run(now - 5 * 60_000);
    const question = claimQuestion.get(now);
    if (!question) return;
    const signal = AbortSignal.timeout(Math.max(0, Math.min(60_000, Number(question.deadline) - Date.now())));
    const prompt = String(question.prompt);
    let answer = "";
    try {
      if (!prompt.includes(token)) answer = await answerQuestion(board, mini, String(question.id), prompt, signal);
    } catch {
      console.warn("Mini chat request failed");
    }
    if (signal.aborted) answer = "";
    saveAnswer.run(answer || null, Number(!answer), String(question.id));
  }

  async function reconcile() {
    const cards = await board.list();
    const recorded = db.prepare("SELECT 1 FROM recommendations WHERE task_id = ? AND turn = ? AND recommendation IS NOT NULL");
    const unrecorded = cards.filter(card => !recorded.get(card.id, card.turn))
      .map(({ id, turn, status }) => ({ id, turn, status }));
    console.log(JSON.stringify({ type: "reconcile", cards: cards.length, unrecorded }));
  }

  async function poll() {
    const checkpoint = db.prepare("SELECT cursor FROM feed WHERE id = 1").get();
    let after = Number(checkpoint?.cursor ?? 0);
    if (!checkpoint && db.prepare("SELECT 1 FROM recommendations LIMIT 1").get()) await reconcile();
    let page;
    try {
      page = await board.events(after);
    } catch (error) {
      if (!(error instanceof InvalidCursor) || after === 0) throw error;
      await reconcile();
      after = 0;
      page = await board.events(after);
    }

    let modelCalls = 0;
    let written = 0;
    for (const event of page.events) {
      if (!once) await chat();
      db.prepare(`INSERT INTO recommendations (event_id, task_id, turn, started_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (event_id) DO NOTHING`).run(event.id, event.task_id, event.turn, Date.now());
      const row = db.prepare("SELECT * FROM recommendations WHERE event_id = ?").get(event.id)!;
      if (row.recommendation !== null) continue;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        const result = await recommend(board, mini, event, Number(row.started_at), Number(row.model_calls), () => {
          const call = db.prepare(`UPDATE recommendations SET model_calls = model_calls + 1
            WHERE event_id = ? AND recommendation IS NULL AND model_calls < ? RETURNING model_calls`).get(event.id, MAX_CALLS);
          if (!call) throw new Error("Event call budget exhausted");
          if (!heartbeat) {
            // A crashed observer stops renewing, even when its recommendation has no result yet.
            const mark = () => signalReview.run(event.id, Date.now() + 6000);
            mark();
            heartbeat = setInterval(mark, 2000);
          }
          modelCalls++;
          console.log(JSON.stringify({ type: "model_call", event_id: event.id, number: call.model_calls }));
          return Number(call.model_calls);
        });
        const saved = db.prepare(`UPDATE recommendations SET source = ?, recommendation = ?
          WHERE event_id = ? AND recommendation IS NULL RETURNING event_id, task_id, turn, model_calls, source, recommendation`)
          .get(result.source, `${event.task_id}: ${result.recommendation}`, event.id);
        if (saved) {
          written++;
          console.log(JSON.stringify({ type: "recommendation", ...saved }));
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        clearReview.run(event.id);
      }
    }
    db.prepare("INSERT INTO feed VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET cursor = excluded.cursor")
      .run(page.next_cursor);
    console.log(JSON.stringify({
      type: "page", after, next_cursor: page.next_cursor, events: page.events.length,
      recommendations: written, model_calls: modelCalls,
    }));
    return page.events.length;
  }

  let retryTitlesAt = 0;
  const titleRetries = new Map<string, number>();
  async function refreshTitle() {
    const now = Date.now();
    if (now < retryTitlesAt) return;
    for (const [id, retryAt] of titleRetries) {
      if (retryAt <= now) titleRetries.delete(id);
    }
    let taskId: string | undefined;
    try {
      const signal = AbortSignal.timeout(60_000);
      const candidates = await board.titleCandidates(signal);
      const candidate = candidates.find(task => !titleRetries.has(task.id));
      if (!candidate) return;
      taskId = candidate.id;
      const title = await titleFor(mini, candidate, signal);
      if (await board.updateTitle(candidate, title, signal)) {
        console.log(JSON.stringify({ type: "project_title", task_id: candidate.id, title }));
      }
    } catch (error) {
      const retryAt = Date.now() + 60_000;
      if (taskId) titleRetries.set(taskId, retryAt);
      else retryTitlesAt = retryAt;
      console.warn("Project title update delayed:", error instanceof Error ? error.message : String(error));
    }
  }

  let resolving = false;
  async function resolveTasks() {
    if (resolving) return;
    resolving = true;
    try {
      await board.pollResolutions(AbortSignal.timeout(615_000));
    } catch (error) {
      console.warn("Operator resolution delayed:", error instanceof Error ? error.message : String(error));
    } finally {
      resolving = false;
    }
  }

  const resolutionTimer = once ? undefined : setInterval(resolveTasks, 5000);
  try {
    do {
      await chat();
      const count = await poll();
      await refreshTitle();
      if (!once && count === 0) {
        for (let second = 0; second < 5; second++) {
          await sleep(1000);
          await chat();
        }
      }
    } while (!once);
  } finally {
    if (resolutionTimer) clearInterval(resolutionTimer);
    db.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
