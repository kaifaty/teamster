import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureSource } from "./source";
import { parseAccounts, parseDuty } from "../lib/accounts";
import type { Accounts } from "../types";

afterEach(() => vi.useRealTimers());

describe("fixture source", () => {
  it("pins a known account, elects automatically and switches off across fixture reconnects", async () => {
    vi.useFakeTimers();
    const source = fixtureSource();
    let accounts: Accounts | null = null;
    const connect = () => source.connect((message) => {
      if (message.type === "snapshot") accounts = message.snapshot.accounts;
      if (message.type === "accounts") accounts = message.accounts;
    }, () => {});
    let stop = connect();
    const current = () => accounts!;
    try {
      expect(parseDuty(current().data)?.mode).toBe("auto");
      const rows = (parseAccounts(current().data, Date.now() / 1000).items ?? []).flatMap((item) => item.kind === "row" ? [item.row] : []);
      const codex = rows.find((row) => row.executor === "codex" && row.pinnable)!;
      expect(await source.act!("duty", { account: codex.name, family: "codex" })).toMatchObject({ ok: true });
      expect(parseDuty(current().data)).toMatchObject({ mode: "pinned", account: codex.name, family: "codex", checked_at: Date.now() / 1000, last_election: { at: Date.now() / 1000, error: null } });
      await vi.advanceTimersByTimeAsync(2000);
      stop();
      stop = connect();
      expect(parseDuty(current().data)).toMatchObject({ mode: "pinned", account: codex.name });
      const login = rows.find((row) => !row.pinnable)!;
      expect(await source.act!("duty", { account: login.name, family: login.executor })).toMatchObject({ ok: false });
      expect(await source.act!("duty", { account: "unknown", family: "claude" })).toMatchObject({ ok: false });
      expect(await source.act!("duty", { mode: "auto" })).toMatchObject({ ok: true });
      expect(parseDuty(current().data)).toMatchObject({ mode: "auto", family: "claude", last_election: { error: null } });
      expect(await source.act!("duty", { mode: "off" })).toMatchObject({ ok: true });
      expect(parseDuty(current().data)).toMatchObject({ mode: "off", account: null, family: null, checked_at: null, last_election: { at: null, error: null } });
    } finally {
      stop();
    }
  });

  it("takes a say to an ordinary task into its messages or its queue and acts on every task", async () => {
    vi.useFakeTimers();
    const source = fixtureSource();
    const removed: string[] = [];
    const stop = source.connect((message) => message.type === "task_removed" && removed.push(message.slug), () => {});
    const act = async (...args: Parameters<NonNullable<typeof source.act>>) => {
      const result = source.act!(...args);
      await vi.advanceTimersByTimeAsync(500);
      return result;
    };
    try {
      // Even while the fixture stream has taken the ship off the board.
      await vi.advanceTimersByTimeAsync(16_000);
      expect(removed).toContain("accounts-json-schema");
      expect(await act("say", { slug: "accounts-json-schema", text: "Доработай перед приёмкой" })).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(10_000);
      const detail = await source.fetchDetail("accounts-json-schema");
      expect(detail?.messages?.at(-1)).toMatchObject({ source: "lead", text: "Доработай перед приёмкой" });
      expect((await source.fetchDetail("board-web-frontend"))?.actions).toEqual({ enabled: true, reason: null, queue: true });
      // A busy ship queues the order when its teamster can, and drops the queue when it stops.
      expect(await act("say", { slug: "board-web-frontend", text: "Потом слей main" })).toMatchObject({ ok: true });
      expect((await source.fetchDetail("board-web-frontend"))?.queue?.waiting.map((order) => order.text)).toEqual(["Потом слей main"]);
      expect(await act("say", { slug: "nightly-bench", text: "Потом слей main" })).toMatchObject({ ok: false });
      // The count takes in what the fixture's queue already holds.
      expect(await act("say", { slug: "ml-eval-pipeline", text: "И обнови README" })).toMatchObject({ output: expect.stringMatching(/: 2 waiting;/) });
      expect(await act("stop", { slug: "board-web-frontend" })).toMatchObject({ ok: true });
      expect((await source.fetchDetail("board-web-frontend"))?.queue).toMatchObject({ waiting: [], dropped: [{ text: "Потом слей main", outcome: "stopped" }] });
      expect(await act("say", { slug: "reflect-review-patterns", text: "demo-wallet" })).toEqual({ ok: true, output: "said to reflect-review-patterns" });
    } finally {
      stop();
    }
  });
});
