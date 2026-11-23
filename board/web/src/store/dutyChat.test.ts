import { afterEach, describe, expect, it, vi } from "vitest";
import type { DutyChatView } from "../dutyChatTypes";
import { FIXTURE_TURN_MS, fixtureConversation, fixtureDutyChat } from "../fixtures/dutyChat";
import type { ActionResult, ActionSender } from "../lib/actions";
import type { BoardSource } from "../lib/source";
import type { ServerMessage } from "../types";
import { createDutyChat, DUTY_CHAT_TEXT_LIMIT, dutyChatTextError } from "./dutyChat";

afterEach(() => vi.useRealTimers());

/** A host whose source answers reads with `views` in turn and whose messages the test sends. */
function host(views: (DutyChatView | null)[], act?: ActionSender) {
  const listeners = new Set<(message: ServerMessage) => void>();
  const fetchDutyChat = vi.fn(async () => (views.length > 1 ? views.shift()! : views[0]!));
  const source = { fetchDutyChat, act } as unknown as BoardSource;
  return {
    source,
    fetchDutyChat,
    subscribe(listener: (message: ServerMessage) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    send: (message: ServerMessage) => listeners.forEach((listener) => listener(message)),
    listeners,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createDutyChat", () => {
  it("reads the conversation again on duty_chat and after a snapshot, and only then", async () => {
    const first = fixtureConversation(1000);
    const second = { ...first, busy: false, turn_started_at: null };
    const fake = host([first, second]);
    const chat = createDutyChat(fake);
    expect(chat.view.value).toBeNull();
    await chat.refresh();
    expect(chat.view.value).toEqual(first);
    fake.send({ type: "ping", at: 1 });
    fake.send({ type: "task_removed", slug: "x" });
    await settle();
    expect(fake.fetchDutyChat).toHaveBeenCalledTimes(1);
    fake.send({ type: "duty_chat", at: 2 });
    await settle();
    expect(chat.view.value?.busy).toBe(false);
    fake.send({ type: "snapshot", snapshot: { generated_at: 3, tasks: [], accounts: { fetched_at: null, error: null, data: null } } });
    await settle();
    expect(fake.fetchDutyChat).toHaveBeenCalledTimes(3);
    chat.stop();
    expect(fake.listeners.size).toBe(0);
  });

  it("keeps the newest read when an older one answers late, and reports a failed read", async () => {
    const early = fixtureConversation(1000);
    const late = { ...early, queued: [] };
    let release: (view: DutyChatView) => void = () => {};
    const fake = host([early]);
    fake.fetchDutyChat
      .mockImplementationOnce(() => new Promise<DutyChatView>((resolve) => (release = resolve)))
      .mockResolvedValueOnce(late)
      .mockRejectedValueOnce(new Error("503 Service Unavailable"));
    const chat = createDutyChat(fake);
    const slow = chat.refresh();
    await chat.refresh();
    release(early);
    await slow;
    expect(chat.view.value).toEqual(late);
    await chat.refresh();
    expect(chat.readError.value).toBe("503 Service Unavailable");
    expect(chat.view.value).toEqual(late);
  });

  it("sends trimmed text to duty-chat, reads again after an accepted message and passes a refusal on", async () => {
    const results: ActionResult[] = [
      { ok: true, output: "", queued: true },
      { ok: false, error: "teamster: no duty account (duty.json is absent or names no account)" },
    ];
    const act = vi.fn(async () => results.shift()!) as unknown as ActionSender;
    const fake = host([fixtureConversation(1000)], act);
    const chat = createDutyChat(fake);
    const sending = chat.send("  И тест на летнее время.  ");
    expect(chat.sending.value).toBe(true);
    expect(await sending).toEqual({ ok: true, output: "", queued: true });
    expect(chat.sending.value).toBe(false);
    expect(act).toHaveBeenCalledWith("duty-chat", { text: "И тест на летнее время." });
    expect(fake.fetchDutyChat).toHaveBeenCalledTimes(1);
    expect(await chat.send("Ещё")).toEqual({ ok: false, error: "teamster: no duty account (duty.json is absent or names no account)" });
    expect(fake.fetchDutyChat).toHaveBeenCalledTimes(1);
    // The server's limits are checked before anything is sent.
    expect(await chat.send("   ")).toEqual({ ok: false, error: "Пустое сообщение" });
    expect(dutyChatTextError("ё".repeat(DUTY_CHAT_TEXT_LIMIT))).toBeNull();
    expect(dutyChatTextError("😀".repeat(DUTY_CHAT_TEXT_LIMIT))).toBeNull();
    expect(await chat.send("x".repeat(DUTY_CHAT_TEXT_LIMIT + 1))).toMatchObject({ ok: false });
    expect(act).toHaveBeenCalledTimes(2);
  });

  it("leaves the view empty for a source without the duty chat", async () => {
    const chat = createDutyChat({ source: {} as BoardSource, subscribe: () => () => {} });
    await chat.refresh();
    expect(chat.view.value).toBeNull();
  });

  it("reconciles an uncertain plan submission by its durable receipt without sending again", async () => {
    const plan = { id: "b".repeat(32), actionable: true, tasks: [{ repo: "teamster", title: "Board", goal: "Fix chat", done_when: ["Check chat"] }] };
    const message = { id: "d1", at: 1000, from: "duty", turn: 1, text: "Plan", task_plan: plan } as const;
    const open = { ...fixtureConversation(1000), busy: false, messages: [message], queued: [] };
    let finish: (result: ActionResult) => void = () => {};
    const act = vi.fn(() => new Promise<ActionResult>((resolve) => { finish = resolve; }));
    const fake = host([open], act);
    const chat = createDutyChat(fake);
    const reply = { plan_id: plan.id, selected: [{ index: 0, done_when: ["Check chat"] }] };
    await chat.refresh();
    const sending = chat.sendPlan(reply);
    await chat.sendPlan(reply);
    expect(act).toHaveBeenCalledExactlyOnceWith("duty-chat", reply);

    finish({ ok: false, error: "connection lost", code: "plan_submission_unknown" });
    await sending;
    expect(chat.planSend.value).toEqual({ planId: plan.id, state: "unknown" });
    await chat.sendPlan(reply);
    expect(act).toHaveBeenCalledTimes(1);
    fake.fetchDutyChat.mockResolvedValueOnce({
      ...open, messages: [{ ...message, task_plan: { ...plan, actionable: false, accepted_turn: 2 } }],
    });
    fake.send({ type: "duty_chat", at: 1001 });
    await settle();
    expect(chat.view.value?.messages[0]?.task_plan?.accepted_turn).toBe(2);
    expect(act).toHaveBeenCalledTimes(1);
  });
});

describe("fixture duty chat", () => {
  it("is a believable conversation: a question with options, started tasks, a note, a running turn and a queued message", () => {
    const view = fixtureConversation(10_000);
    expect(view).toMatchObject({ available: true, reason: null, busy: true, last_error: null });
    const decision = view.messages.find((message) => message.status === "needs_decision");
    expect(decision?.question).toBeTruthy();
    expect(decision?.options?.length).toBeGreaterThanOrEqual(2);
    expect(view.messages.find((message) => message.status === "started")?.started?.length).toBeGreaterThan(0);
    expect(view.messages.filter((message) => message.from === "note")).toHaveLength(1);
    expect(view.queued).toHaveLength(1);
    expect(new Set(view.messages.map((message) => message.id)).size).toBe(view.messages.length);
    expect(view.messages.map((message) => message.at)).toEqual([...view.messages.map((message) => message.at)].sort((a, b) => a - b));
  });

  it("answers the running turn, sends the queued message next and queues what comes while busy", async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const emitted: ServerMessage[] = [];
    const chat = fixtureDutyChat(() => now, (message) => emitted.push(message));
    const start = chat.view();
    expect(chat.act({ text: " Ещё вопрос " })).toEqual({ ok: true, output: "", queued: true });
    expect(chat.view().queued.map((row) => row.text)).toEqual([start.queued[0]!.text, "Ещё вопрос"]);
    now += 6;
    vi.advanceTimersByTime(FIXTURE_TURN_MS);
    const next = chat.view();
    expect(next.messages.at(-2)).toMatchObject({ from: "duty", status: "answered", turn: 4 });
    expect(next.messages.at(-1)).toMatchObject({ from: "user", text: start.queued[0]!.text, turn: 5 });
    expect(next.busy).toBe(true);
    vi.advanceTimersByTime(2 * FIXTURE_TURN_MS);
    const idle = chat.view();
    expect(idle.busy).toBe(false);
    expect(idle.queued).toEqual([]);
    expect(chat.act({ text: "Новое" })).toEqual({ ok: true, output: "", queued: false });
    expect(chat.view()).toMatchObject({ busy: true });
    expect(emitted.every((message) => message.type === "duty_chat")).toBe(true);
    expect(emitted.length).toBeGreaterThanOrEqual(4);
    chat.stop();
  });
});
