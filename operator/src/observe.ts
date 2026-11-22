import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { connectBoard, InvalidCursor, localUrl } from "./board.ts";
import { MAX_CALLS, recommend } from "./mini.ts";

async function main() {
  const args = process.argv.slice(2);
  const once = args.length === 1 && args[0] === "--once";
  if (args.length && !once) throw new Error("Usage: npm start -- [--once]");
  const token = process.env.BOARD_TOKEN;
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
  `);
  const signalReview = db.prepare(`INSERT INTO reviewing VALUES (?, ?)
    ON CONFLICT (event_id) DO UPDATE SET expires_at = excluded.expires_at`);
  const clearReview = db.prepare("DELETE FROM reviewing WHERE event_id = ?");

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

  try {
    do {
      const count = await poll();
      if (!once && count === 0) await sleep(5000);
    } while (!once);
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
