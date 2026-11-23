import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureSource } from "./source";
import { FIXTURE_TURN_MS } from "./dutyChat";
import type { DutyChatBody } from "../lib/actions";
import { parseAccounts, parseDuty } from "../lib/accounts";
import type { Accounts } from "../types";

afterEach(() => vi.useRealTimers());

describe("fixture source", () => {
  it("turns the A2UI comparison into a plan and records one edited selection", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { search: "?duty=a2ui" });
    const source = fixtureSource();
    const stop = source.connect(() => {}, () => {});
    const view = async () => (await source.fetchDutyChat!())!;
    const act = async (body: DutyChatBody) => {
      const result = source.act!("duty-chat", body);
      await vi.advanceTimersByTimeAsync(300);
      return result;
    };
    try {
      const choice = (await view()).messages.at(-1)!.comparison!.approaches[0].title;
      expect(await act({ text: choice })).toMatchObject({ ok: true, queued: false });
      await vi.advanceTimersByTimeAsync(FIXTURE_TURN_MS);
      const plan = (await view()).messages.at(-1)!.task_plan!;
      expect(plan.actionable).toBe(true);
      expect(plan.tasks).toHaveLength(3);
      expect(plan.tasks[0]!.done_when[0]).toContain(choice);

      const reply = { plan_id: plan.id, selected: [{ index: 2, done_when: ["  Новый критерий  "] }] };
      expect(await act({ ...reply, plan_id: "0".repeat(32) })).toMatchObject({ ok: false, code: "stale_plan" });
      expect(await act({ ...reply, selected: [{ index: 2, done_when: [" "] }] })).toMatchObject({ ok: false, code: "invalid_plan_reply" });
      expect(await act(reply)).toMatchObject({ ok: true, turn: 3 });
      expect(await act(reply)).toMatchObject({ ok: false, code: "plan_already_answered" });
      await vi.advanceTimersByTimeAsync(FIXTURE_TURN_MS);
      const finished = await view();
      expect(finished.messages.find((entry) => entry.task_plan)?.task_plan).toMatchObject({ actionable: false, accepted_turn: 3 });
      const submitted = finished.messages.filter((entry) => entry.from === "user" && entry.turn === 3);
      expect(submitted).toHaveLength(1);
      expect(submitted[0]!.text).toContain("- Новый критерий");
      expect(submitted[0]!.text).not.toContain(plan.tasks[0]!.title);
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
  });

  it("pins a known account, elects automatically and switches off across fixture reconnects", async () => {
    vi.useFakeTimers();
    const source = fixtureSource();
    let accounts: Accounts | null = null;
    let chatNotifications = 0;
    const connect = () => source.connect((message) => {
      if (message.type === "snapshot") accounts = message.snapshot.accounts;
      if (message.type === "accounts") accounts = message.accounts;
      if (message.type === "duty_chat") chatNotifications += 1;
    }, () => {});
    let stop = connect();
    const current = () => accounts!;
    try {
      expect(parseDuty(current().data)?.mode).toBe("auto");
      const chat = await source.fetchDutyChat!();
      const rows = (parseAccounts(current().data, Date.now() / 1000).items ?? []).flatMap((item) => item.kind === "row" ? [item.row] : []);
      const codex = rows.find((row) => row.executor === "codex" && row.pinnable)!;
      expect(await source.act!("duty", { account: codex.name, family: "codex" })).toMatchObject({ ok: true });
      expect(parseDuty(current().data)).toMatchObject({ mode: "pinned", account: codex.name, family: "codex", checked_at: Date.now() / 1000, last_election: { at: Date.now() / 1000, error: null } });
      expect(chatNotifications).toBe(1);
      expect(await source.fetchDutyChat!()).toMatchObject({ available: false, reason: "codex_duty", duty: { account: codex.name, family: "codex" }, busy: true, messages: chat!.messages });
      const codexSend = source.act!("duty-chat", { text: "Refuse on Codex" });
      await vi.advanceTimersByTimeAsync(300);
      expect(await codexSend).toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(2000);
      stop();
      stop = connect();
      expect(parseDuty(current().data)).toMatchObject({ mode: "pinned", account: codex.name });
      const login = rows.find((row) => !row.pinnable)!;
      expect(await source.act!("duty", { account: login.name, family: login.executor })).toMatchObject({ ok: false });
      expect(await source.act!("duty", { account: "unknown", family: "claude" })).toMatchObject({ ok: false });
      expect(await source.act!("duty", { mode: "auto" })).toMatchObject({ ok: true });
      expect(parseDuty(current().data)).toMatchObject({ mode: "auto", family: "claude", last_election: { error: null } });
      const otherClaude = rows.find((row) => row.executor === "claude" && row.pinnable && row.name !== chat!.duty!.account)!;
      expect(await source.act!("duty", { account: otherClaude.name, family: "claude" })).toMatchObject({ ok: true });
      expect(await source.fetchDutyChat!()).toMatchObject({ available: true, reason: null, duty: { account: otherClaude.name, family: "claude" }, messages: chat!.messages });
      await vi.advanceTimersByTimeAsync(6000);
      expect((await source.fetchDutyChat!())?.messages.filter((message) => message.from === "duty").at(-1)?.account).toBe(chat!.duty!.account);
      expect(await source.act!("duty", { mode: "off" })).toMatchObject({ ok: true });
      expect(parseDuty(current().data)).toMatchObject({ mode: "off", account: null, family: null, checked_at: null, last_election: { at: null, error: null } });
      expect(await source.fetchDutyChat!()).toMatchObject({ available: false, reason: "no_duty", duty: null, busy: true });
      const offSend = source.act!("duty-chat", { text: "Refuse without a duty" });
      await vi.advanceTimersByTimeAsync(300);
      expect(await offSend).toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(6000);
      const finished = await source.fetchDutyChat!();
      expect(finished?.busy).toBe(false);
      expect(finished?.messages.filter((message) => message.from === "duty").at(-1)?.account).toBe(otherClaude.name);
      expect(finished?.messages.some((message) => message.text.startsWith("Refuse"))).toBe(false);
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
