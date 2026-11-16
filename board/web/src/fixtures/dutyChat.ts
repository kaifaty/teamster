// The duty chat in `dev:fixture` mode: a conversation in progress, with a question and its options, started tasks, a
// task note, a running turn and a message waiting for it. Messages sent from the page join it; each turn answers a few
// seconds later and the next waiting message starts the next turn.

import type { DutyChatMessage, DutyChatView } from "../dutyChatTypes";
import type { ActionResult, DutyChatBody } from "../lib/actions";
import type { ServerMessage } from "../types";

/** How long a fixture turn of the duty takes, in milliseconds. */
export const FIXTURE_TURN_MS = 6000;

export interface FixtureDutyChat {
  view(): DutyChatView;
  act(body: DutyChatBody): ActionResult;
  /** Stops the turn that runs, for tests. */
  stop(): void;
}

/** The conversation's start, `now` being Unix seconds; the last turn runs since half a minute. */
export function fixtureConversation(now: number): DutyChatView {
  const at = (minutesAgo: number) => now - minutesAgo * 60;
  const messages: DutyChatMessage[] = [
    { id: "m0", at: at(42), from: "user", text: "Почини разбор дат в парсере: он падает на ISO-строках с часовым поясом.", turn: 1 },
    {
      id: "d0", at: at(41), from: "duty", turn: 1, status: "needs_decision", account: "claude-pool-1",
      text: "Разбор ISO-дат есть в двух репозиториях, и в обоих он одинаково не знает про смещение.",
      question: "В каком репозитории чинить?", options: ["demo-parser", "demo-wallet", "В обоих"], started: [],
    },
    { id: "m118", at: at(39), from: "user", text: "В обоих", turn: 2 },
    {
      id: "d1", at: at(38), from: "duty", turn: 2, status: "started", account: "claude-pool-1",
      text: "Запустил две задачи: исправление в demo-parser и разведку в demo-wallet — там разбор спрятан в сериализаторе.",
      question: null, options: [], started: ["fix-iso-offset", "scout-wallet-dates"],
    },
    {
      id: "m201", at: at(12), from: "note", turn: 3,
      text: "Task note: fix-iso-offset ended turn 1 with outcome completed. Report it to the user, or send it a follow-up.\n\n" +
        "== result: done\nРазбор принимает смещение и Z, добавлены тесты.\n- npm test: passed",
    },
    {
      id: "d2", at: at(11), from: "duty", turn: 3, status: "answered", account: "claude-pool-1",
      text: "fix-iso-offset готова: PR открыт, тесты прошли. Посмотри и прими, когда будет время.",
      question: null, options: [], started: [],
    },
    { id: "m688", at: now - 30, from: "user", text: "Спасибо. Что там с кошельком?", turn: 4 },
  ];
  return {
    actions: { enabled: true, reason: null },
    available: true,
    reason: null,
    duty: { account: "claude-pool-1", family: "claude" },
    busy: true,
    turn_started_at: now - 30,
    messages,
    queued: [{ at: now - 10, from: "user", text: "И добавь тест на переход на летнее время." }],
    last_error: null,
  };
}

const ANSWERS = [
  "Разведка по кошельку закончилась: разбор там общий с парсером, после слияния fix-iso-offset хватит обновить зависимость.",
  "Добавлю тест на летнее время в fix-iso-offset следующим указанием.",
  "Принял.",
];

/** `clock`: Unix seconds now; `emit` tells the page that the conversation changed. */
export function fixtureDutyChat(clock: () => number, emit: (message: ServerMessage) => void): FixtureDutyChat {
  const view = fixtureConversation(clock());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let answers = 0;
  let lastId = 0;
  const changed = () => emit({ type: "duty_chat", at: clock() });

  /** The running turn answers in a few seconds; the first waiting message then starts the next. */
  function runTurn() {
    timer = setTimeout(() => {
      timer = null;
      const turn = (view.messages.at(-1)?.turn ?? 0) || 1;
      const answer: DutyChatMessage = {
        id: `d-fixture-${++lastId}`, at: clock(), from: "duty", turn, status: "answered", account: view.duty?.account ?? null,
        text: ANSWERS[Math.min(answers++, ANSWERS.length - 1)]!, question: null, options: [], started: [],
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
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
