import { describe, expect, it } from "vitest";
import type { DutyChatView } from "../../dutyChatTypes";
import { fixtureConversation, withMode } from "../../fixtures/dutyChat";
import { activeQuestion, arrived, chatRows, feedTail, noteParts, pendingBefore, runTime, sentCount, unavailableText, type PendingMessage } from "./chat";

const NOW = 1_800_000_000;
const ON_MAP: Record<string, string> = { "ci-wait-retry": "demo-assistant" };
const findTask = (slug: string) => (ON_MAP[slug] ? { repo: ON_MAP[slug]! } : null);
const pending = (text: string, before: number, state: PendingMessage["state"] = "sending", key = 1): PendingMessage => ({ key, text, at: NOW, before, state, error: state === "failed" ? "refused" : null });

/** The fixture conversation after its running turn answered with a question and nothing waits. */
function asking(): DutyChatView {
  const view = fixtureConversation(NOW);
  return {
    ...view,
    busy: false,
    queued: [],
    messages: [
      ...view.messages,
      { id: "d9", at: NOW, from: "duty", turn: 4, status: "needs_decision", text: "Готово.", question: "Добавить 504?", options: ["Да", "Нет"], started: [] },
    ],
  };
}

describe("the duty chat's rows", () => {
  it("shows each message by its sender, a note's head in plain words, and the started tasks that are on the map", () => {
    const rows = chatRows(fixtureConversation(NOW), [], findTask);
    expect(rows.map((row) => row.kind)).toEqual(["user", "duty", "user", "duty", "note", "duty", "user", "queued"]);
    const started = rows.find((row) => row.kind === "duty" && row.started.length);
    expect(started?.kind === "duty" && started.started).toEqual([
      { slug: "ci-wait-retry", repo: "demo-assistant" },
      { slug: "scout-cache-layout", repo: null },
      { slug: "ci-runner-probe", repo: null },
    ]);
    expect(rows.find((row) => row.kind === "note")).toMatchObject({ head: "Задача scout-cache-layout закончила ход 1: completed", body: expect.stringContaining("== result: done") });
    expect(noteParts("Просто заметка\nдальше")).toEqual({ head: "Просто заметка", body: "дальше" });
  });

  it("keeps a sent message pending until the view has one more with its text, delivered or queued, and keeps a refused one", () => {
    const view = fixtureConversation(NOW);
    const text = "Ещё вопрос";
    const sent = pending(text, sentCount(view, text));
    expect(chatRows(view, [sent], findTask).at(-1)).toMatchObject({ kind: "pending", pending: { text } });
    const queued = { ...view, queued: [...view.queued, { at: NOW, from: "user" as const, text }] };
    expect(arrived(queued, sent)).toBe(true);
    expect(chatRows(queued, [sent], findTask).map((row) => row.kind).at(-1)).toBe("queued");
    // The same text sent again waits for its own copy.
    expect(arrived(queued, pending(text, sentCount(queued, text)))).toBe(false);
    expect(arrived(queued, { ...sent, state: "failed" })).toBe(false);
    expect(chatRows(queued, [{ ...sent, state: "failed", error: "refused" }], findTask).at(-1)).toMatchObject({ kind: "pending", pending: { state: "failed", error: "refused" } });
  });

  it("counts identical sends still on their way, so that the first one's arrival keeps the second pending", () => {
    const view = fixtureConversation(NOW);
    const first = pending("Да", pendingBefore(view, [], "Да"), "sent", 1);
    const second = pending("Да", pendingBefore(view, [first, pending("Да", 0, "failed", 3), pending("Нет", 0, "sending", 4)], "Да"), "sending", 2);
    expect(second.before).toBe(first.before + 1);
    const once = { ...view, queued: [...view.queued, { at: NOW, from: "user" as const, text: "Да" }] };
    expect([arrived(once, first), arrived(once, second)]).toEqual([true, false]);
  });

  it("makes only the latest unanswered question's options active", () => {
    const view = asking();
    expect(activeQuestion(view)).toBe("d9");
    const rows = chatRows(view, [], findTask).filter((row) => row.kind === "duty" && row.options.length);
    expect(rows.map((row) => row.kind === "duty" && row.active)).toEqual([false, true]);
    // An answer on its way, a queued one or a delivered one answers it; a refused send does not.
    expect(activeQuestion(view, [pending("Да", 0)])).toBeNull();
    expect(activeQuestion(view, [pending("Да", 0, "failed")])).toBe("d9");
    expect(activeQuestion({ ...view, queued: [{ at: NOW, from: "user", text: "Да" }] })).toBeNull();
    expect(activeQuestion({ ...view, queued: [{ at: NOW, from: "note", text: "note" }] })).toBe("d9");
    expect(activeQuestion({ ...view, messages: [...view.messages, { id: "m9", at: NOW, from: "user", text: "Да", turn: 5 }] })).toBeNull();
    expect(activeQuestion(fixtureConversation(NOW))).toBeNull();
  });
});

describe("the duty chat's plain texts", () => {
  it("says why the chat cannot work, by reason, naming real things", () => {
    const texts = (["no_duty", "codex_duty", "old_teamster", "read_only", "no_teamster"] as const).map((mode) =>
      unavailableText(withMode(fixtureConversation(NOW), mode, NOW), { read: true, readError: null }),
    );
    expect(texts).toEqual([
      "Дежурный не выбран",
      "Дежурный — подписка Codex, а чату нужен Claude",
      "teamster старше 1.86.0 и не умеет чат с дежурным: обнови teamster",
      "Доска запущена с --read-only: писать дежурному нельзя",
      "Доска не нашла команду teamster: писать дежурному нельзя",
    ]);
    expect(unavailableText(fixtureConversation(NOW), { read: true, readError: null })).toBeNull();
    expect(unavailableText(null, { read: false, readError: null })).toBeNull();
    expect(unavailableText(null, { read: true, readError: null })).toBe("Сервер доски не знает чата с дежурным: перезапусти доску новой версии");
    expect(unavailableText(null, { read: true, readError: "502 Bad Gateway" })).toBe("Не удалось прочитать переписку с дежурным: 502 Bad Gateway");
  });

  it("tells how long the turn runs and its last steps, one line each", () => {
    expect([7, 750, 3900].map(runTime)).toEqual(["0:07", "12:30", "1:05:00"]);
    const items = [
      { at: 1, kind: "thinking" as const, text: "думаю\nдальше" },
      { at: 2, kind: "command" as const, text: "npm test" },
      { at: 3, kind: "tool" as const, text: "  " },
      { at: 4, kind: "message" as const, text: "\nГотово" },
    ];
    expect(feedTail(items, 2)).toEqual([
      { key: "1", label: "команда", text: "npm test" },
      { key: "3", label: "пишет", text: "Готово" },
    ]);
  });
});
