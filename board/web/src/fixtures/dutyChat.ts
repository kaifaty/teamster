// The duty chat in `dev:fixture` mode: a conversation in progress, with a question and its options, started tasks, a
// task note, a running turn and a message waiting for it. Messages sent from the page join it; each turn answers a few
// seconds later, its live activity growing in the duty's feed meanwhile, and the next waiting message starts the next
// turn. The page's `?duty=` drives the chat's other states: a reason it is unavailable (`no_duty`, `codex_duty`,
// `old_teamster`, `read_only`, `no_teamster`), `error` for a failed last turn, `refuse` for a send teamster refuses.

import type { DutyChatMessage, DutyChatReason, DutyChatView } from "../dutyChatTypes";
import type { ActionResult, DutyChatBody } from "../lib/actions";
import type { FeedItem, ServerMessage, TaskFeed } from "../types";

/** How long a fixture turn of the duty takes, in milliseconds. */
export const FIXTURE_TURN_MS = 6000;

export interface FixtureDutyChat {
  view(): DutyChatView;
  act(body: DutyChatBody): ActionResult;
  /** The running turn's activity, the task feed of slug `duty`. */
  feed(after: string | null): TaskFeed;
  /** Stops the turn that runs, for tests. */
  stop(): void;
}

/** The conversation's start, `now` being Unix seconds; the last turn runs since half a minute. */
export function fixtureConversation(now: number): DutyChatView {
  const at = (minutesAgo: number) => now - minutesAgo * 60;
  const messages: DutyChatMessage[] = [
    { id: "m0", at: at(42), from: "user", text: "В demo-assistant ожидание CI падает, когда раннер отвечает 502. Разберись.", turn: 1 },
    {
      id: "d0", at: at(41), from: "duty", turn: 1, status: "needs_decision", account: "claude-pool-1",
      text: "Ожидание CI повторяет запрос только на таймаут, а 502 считает провалом. Рядом кэш сборки без ключа по lock-файлу: часть провалов может быть оттуда.",
      question: "Чинить повтор сразу или сначала разобрать кэш?", options: ["Чинить сразу", "Сначала кэш", "И то и другое"], started: [],
    },
    { id: "m118", at: at(39), from: "user", text: "И то и другое", turn: 2 },
    {
      id: "d1", at: at(38), from: "duty", turn: 2, status: "started", account: "claude-pool-1",
      text: "Запустил две задачи в demo-assistant: ci-wait-retry чинит повтор на 502, scout-cache-layout разбирает кэш сборки.",
      question: null, options: [], started: ["ci-wait-retry", "scout-cache-layout", "ci-runner-probe"],
    },
    {
      id: "m201", at: at(12), from: "note", turn: 3,
      text: "Task note: scout-cache-layout ended turn 1 with outcome completed. Report it to the user, or send it a follow-up.\n\n" +
        "== result: done\nКэш общий для всех веток, ключ без хеша lock-файла.\n- npm test: passed",
    },
    {
      id: "d2", at: at(11), from: "duty", turn: 3, status: "answered", account: "claude-pool-1",
      text: "scout-cache-layout закончила первый ход: кэш общий для всех веток, ключ без хеша lock-файла. Это и роняет часть сборок.",
      question: null, options: [], started: [],
    },
    { id: "m688", at: now - 30, from: "user", text: "Спасибо. Что с повтором на 502?", turn: 4 },
  ];
  return {
    actions: { enabled: true, reason: null },
    available: true,
    reason: null,
    duty: { account: "claude-pool-1", family: "claude" },
    busy: true,
    turn_started_at: now - 30,
    messages,
    queued: [{ at: now - 10, from: "user", text: "И пусть проверит 502 три раза подряд." }],
    last_error: null,
  };
}

type Answer = Pick<DutyChatMessage, "status" | "text" | "question" | "options">;
/** The turns' answers in order; the last one repeats. */
const ANSWERS: Answer[] = [
  { status: "answered", text: "ci-wait-retry уже повторяет запрос на 502 и 503 с паузой; тесты идут, PR будет в течение часа.", question: null, options: [] },
  { status: "answered", text: "Принял.", question: null, options: [] },
];
/** The first turn that leaves nothing waiting asks this, so that its options answer. */
const QUESTION: Answer = {
  status: "needs_decision", text: "Передам ci-wait-retry тест на 502 три раза подряд.",
  question: "Добавить повтор и на 504?", options: ["Да, и на 504", "Нет, только 502 и 503"],
};

/** A turn's steps, one more every FEED_STEP_SECONDS. */
const WORK: Pick<FeedItem, "kind" | "text">[] = [
  { kind: "thinking", text: "Пользователь спрашивает про ci-wait-retry: посмотрю её последний ход." },
  { kind: "command", text: "teamster status ci-wait-retry" },
  { kind: "tool", text: "Read ~/.teamster/tasks/ci-wait-retry/last.md" },
  { kind: "command", text: "teamster wait ci-wait-retry --timeout 0" },
  { kind: "message", text: "Собираю ответ." },
];
const FEED_STEP_SECONDS = 1.2;

const REASONS = new Set<string>(["no_duty", "codex_duty", "old_teamster", "read_only", "no_teamster"]);

/** The conversation in the state `mode` (the page's `?duty=`) asks for; as it is without one. */
export function withMode(view: DutyChatView, mode: string | null, now: number): DutyChatView {
  if (mode === "error") return { ...view, busy: false, turn_started_at: null, queued: [], last_error: { at: now - 5, text: "the duty's turn ended with outcome failed: Claude exited with code 1" } };
  if (!mode || !REASONS.has(mode)) return view;
  const reason = mode as DutyChatReason;
  const duty = reason === "no_duty" ? null : reason === "codex_duty" ? { account: "codex-main", family: "codex" as const } : view.duty;
  const off = reason === "read_only" || reason === "no_teamster";
  return { ...view, actions: { enabled: !off, reason: off ? reason : null }, available: false, reason, duty, busy: false, turn_started_at: null, queued: [] };
}

/** `clock`: Unix seconds now; `emit` tells the page that the conversation changed. */
export function fixtureDutyChat(clock: () => number, emit: (message: ServerMessage) => void, mode: string | null = null): FixtureDutyChat {
  const view = withMode(fixtureConversation(clock()), mode, clock());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let answers = 0;
  let asked = false;
  let lastId = 0;
  const changed = () => emit({ type: "duty_chat", at: clock() });

  /** The running turn answers in a few seconds; the first waiting message then starts the next. */
  function runTurn() {
    timer = setTimeout(() => {
      timer = null;
      const turn = (view.messages.at(-1)?.turn ?? 0) || 1;
      const ask = !asked && !view.queued.length;
      asked ||= ask;
      const answer: DutyChatMessage = {
        id: `d-fixture-${++lastId}`, at: clock(), from: "duty", turn, account: view.duty?.account ?? null, started: [],
        ...(ask ? QUESTION : ANSWERS[Math.min(answers++, ANSWERS.length - 1)]!),
      };
      view.messages = [...view.messages, answer].slice(-200);
      const [next, ...rest] = view.queued;
      if (next) {
        view.queued = rest;
        view.messages = [...view.messages, { id: `m-fixture-${++lastId}`, at: clock(), from: next.from, text: next.text, turn: turn + 1 }];
        view.turn_started_at = clock();
        runTurn();
      } else {
        view.busy = false;
        view.turn_started_at = null;
      }
      changed();
    }, FIXTURE_TURN_MS);
  }

  return {
    view() {
      // The running turn of the fixture goes on once someone looks at it.
      if (view.busy && timer === null) runTurn();
      return structuredClone(view);
    },
    act({ text }) {
      const message = text.trim();
      if (!message) return { ok: false, error: "Invalid text" };
      if (mode === "refuse") return { ok: false, error: "teamster: no duty account (duty.json is absent or names no account)" };
      if (view.busy) {
        view.queued = [...view.queued, { at: clock(), from: "user", text: message }];
        changed();
        return { ok: true, output: "", queued: true };
      }
      const turn = (view.messages.at(-1)?.turn ?? 0) + 1;
      view.messages = [...view.messages, { id: `m-fixture-${++lastId}`, at: clock(), from: "user", text: message, turn }];
      view.busy = true;
      view.turn_started_at = clock();
      view.last_error = null;
      runTurn();
      changed();
      return { ok: true, output: "", queued: false };
    },
    feed(after) {
      const turn = view.messages.at(-1)?.turn ?? 0;
      const start = view.busy ? view.turn_started_at : null;
      const shown = start === null ? 0 : Math.min(WORK.length, 1 + Math.floor((clock() - start) / FEED_STEP_SECONDS));
      const items = WORK.slice(0, shown).map((item, index) => ({ ...item, at: start! + index * FEED_STEP_SECONDS }));
      const [from, seen] = (after ?? "").split(":").map(Number);
      const more = from === turn && Number.isInteger(seen) && seen! <= items.length;
      return { items: more ? items.slice(seen) : items, cursor: `${turn}:${items.length}`, reset: !more, truncated: false };
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
