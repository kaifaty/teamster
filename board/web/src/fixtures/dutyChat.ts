// The duty chat in `dev:fixture` mode: a conversation in progress, with a question and its options, started tasks, a
// task note, a running turn and a message waiting for it. Messages sent from the page join it; each turn answers a few
// seconds later, its live activity growing in the duty's feed meanwhile, and the next waiting message starts the next
// turn. The page's `?duty=` drives the chat's other states: a reason it is unavailable (`no_duty`, `codex_duty`,
// `old_teamster`, `read_only`, `no_teamster`), `error` for a failed last turn, `refuse` for a send teamster refuses.
// `a2ui` starts a separate conversation with an approach comparison followed by a task plan.

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

type Answer = Pick<DutyChatMessage, "status" | "text" | "question" | "options" | "task_plan">;
const ACKNOWLEDGED: Answer = { status: "answered", text: "Принял.", question: null, options: [] };
/** The turns' answers in order; the last one repeats. */
const ANSWERS: Answer[] = [
  { status: "answered", text: "ci-wait-retry уже повторяет запрос на 502 и 503 с паузой; тесты идут, PR будет в течение часа.", question: null, options: [] },
  ACKNOWLEDGED,
];
/** The first turn that leaves nothing waiting asks this, so that its options answer. */
const QUESTION: Answer = {
  status: "needs_decision", text: "Передам ci-wait-retry тест на 502 три раза подряд.",
  question: "Добавить повтор и на 504?", options: ["Да, и на 504", "Нет, только 502 и 503"],
};

const COMPARISON: NonNullable<DutyChatMessage["comparison"]> = {
  approaches: [
    { title: "Повторять 502, 503 и 504", detail: "Покроет известные сбои шлюза. При других ошибках проверка завершится сразу." },
    { title: "Повторять все 5xx", detail: "Покроет и новые сбои сервера. Постоянная ошибка может замедлить проверку CI." },
  ],
};

function a2uiConversation(now: number): DutyChatView {
  return {
    ...fixtureConversation(now), busy: false, turn_started_at: null, queued: [],
    messages: [
      { id: "m0", at: now - 60, from: "user", text: "Сравни подходы к повторам в CI demo-assistant и предложи план работ.", turn: 1 },
      {
        id: "d0", at: now - 30, from: "duty", turn: 1, status: "needs_decision", started: [], comparison: COMPARISON,
        text: "Можно повторять известные сбои шлюза или весь диапазон 5xx. От этого зависит первый пункт плана.",
        question: "Какие ошибки повторять?", options: COMPARISON.approaches.map((approach) => approach.title),
      },
    ],
  };
}

function taskPlan(approach: string): Answer {
  const tasks = [
    {
      repo: "demo-assistant", title: "Добавить повторы запросов к CI",
      goal: "Повторять запрос к раннеру при выбранных ответах сервера.",
      done_when: [`Проверки подтверждают политику «${approach}».`, "После трёх попыток запрос завершается с ошибкой."],
    },
    {
      repo: "demo-assistant", title: "Уточнить сообщение об отказе CI",
      goal: "Показать код ответа раннера и ссылку на запуск в итоговом сообщении.",
      done_when: ["Итоговое сообщение содержит код ответа и ссылку на запуск."],
    },
    {
      repo: "demo-assistant", title: "Уточнить ключ кэша сборки",
      goal: "Включить хеш lock-файла в ключ кэша зависимостей.",
      done_when: ["Изменение lock-файла даёт новый ключ кэша."],
    },
  ];
  return {
    status: "needs_decision",
    text: [`Предлагаю три независимые задачи для demo-assistant. Подход к повторам — «${approach}».`,
      ...tasks.map((task, index) => `${index + 1}. ${task.title}. ${task.goal}`)].join("\n"),
    question: "Что взять в работу?", options: [],
    task_plan: { id: "a2a20000000000000000000000000001", actionable: true, tasks },
  };
}

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
/** `currentDuty`: the duty account the board's accounts name now; `mode`: the page's `?duty=`. */
export function fixtureDutyChat(
  clock: () => number,
  emit: (message: ServerMessage) => void,
  currentDuty?: () => DutyChatView["duty"],
  mode: string | null = null,
): FixtureDutyChat {
  const a2ui = mode === "a2ui";
  const view = a2ui ? a2uiConversation(clock()) : withMode(fixtureConversation(clock()), mode, clock());
  const work: Pick<FeedItem, "kind" | "text">[] = a2ui ? [{ kind: "message", text: "Готовлю ответ." }] : WORK;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let answers = 0;
  let asked = false;
  let lastId = 0;
  const changed = () => emit({ type: "duty_chat", at: clock() });
  const selectedDuty = () => currentDuty ? currentDuty() : view.duty;

  /** The running turn answers in a few seconds; the first waiting message then starts the next. */
  function runTurn(account = view.duty?.account ?? null) {
    timer = setTimeout(() => {
      timer = null;
      const latest = view.messages.at(-1);
      const turn = latest?.turn || 1;
      const ask = !a2ui && !asked && !view.queued.length;
      asked ||= ask;
      const approach = a2ui && turn === 2
        ? COMPARISON.approaches.find(({ title }) => title === latest?.text)
        : undefined;
      const result = a2ui ? (approach ? taskPlan(approach.title) : ACKNOWLEDGED)
        : ask ? QUESTION : ANSWERS[Math.min(answers++, ANSWERS.length - 1)]!;
      const answer: DutyChatMessage = {
        id: `d-fixture-${++lastId}`, at: clock(), from: "duty", turn, account, started: [], ...result,
      };
      view.messages = [...view.messages, answer].slice(-200);
      const [next, ...rest] = view.queued;
      const duty = selectedDuty();
      if (next && duty?.family === "claude") {
        view.queued = rest;
        view.messages = [...view.messages, { id: `m-fixture-${++lastId}`, at: clock(), from: next.from, text: next.text, turn: turn + 1 }];
        view.turn_started_at = clock();
        runTurn(duty.account);
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
      const duty = selectedDuty();
      const reason = duty === null ? "no_duty" : duty.family === "codex" ? "codex_duty" : null;
      // A reason the page asked for stands over the accounts' duty.
      return structuredClone(withMode({ ...view, duty, reason, available: reason === null }, mode && REASONS.has(mode) ? mode : null, clock()));
    },
    act(body) {
      let message = "text" in body ? body.text.trim() : "";
      if ("text" in body && !message) return { ok: false, error: "Invalid text" };
      if (mode === "refuse") return { ok: false, error: "teamster: no duty account (duty.json is absent or names no account)" };
      const duty = selectedDuty();
      if (!("text" in body) && duty?.family !== "claude") {
        return { ok: false, code: "plan_unavailable", error: "Сейчас дежурный не может принять ответ на план" };
      }
      if (!duty) return { ok: false, error: "No duty account" };
      if (duty.family !== "claude") return { ok: false, error: "The duty chat needs a Claude duty account" };
      const latest = view.messages.at(-1);
      const turn = (latest?.turn ?? 0) + 1;
      if (!("text" in body)) {
        const proposal = view.messages.find((entry) => entry.task_plan?.id === body.plan_id);
        const plan = proposal?.task_plan;
        if (plan?.accepted_turn !== undefined) return { ok: false, code: "plan_already_answered", error: "На этот план уже ответили" };
        if (!plan || proposal !== latest || view.busy || view.queued.some((row) => row.from === "user")) {
          return { ok: false, code: "stale_plan", error: "Дежурный перешёл к другому ходу. Этот план уже нельзя отправить" };
        }
        const selection = new Map(body.selected.map(({ index, done_when }) => [index, done_when.map((criterion) => criterion.trim())]));
        if (!selection.size || selection.size !== body.selected.length || [...selection].some(([index, criteria]) =>
          !Number.isInteger(index) || !plan.tasks[index] || !criteria.length || criteria.length > 3
          || criteria.some((criterion) => !criterion || [...criterion].length > 200))) {
          return { ok: false, code: "invalid_plan_reply", error: "Проверь выбранные задачи и критерии готовности" };
        }
        const lines = plan.tasks.flatMap((task, index) => {
          const criteria = selection.get(index);
          return criteria ? [`${task.title} (${task.repo})\n${task.goal}\n${criteria.map((criterion) => `- ${criterion}`).join("\n")}`] : [];
        });
        message = `Возьми в работу только выбранные задачи. Остальные пункты пропусти.\n\n${lines.join("\n\n")}`;
        plan.accepted_turn = turn;
      }
      if (view.busy) {
        view.queued = [...view.queued, { at: clock(), from: "user", text: message }];
        changed();
        return { ok: true, output: "", queued: true };
      }
      if (latest?.task_plan) latest.task_plan.actionable = false;
      view.messages = [...view.messages, { id: `m-fixture-${++lastId}`, at: clock(), from: "user", text: message, turn }];
      view.busy = true;
      view.turn_started_at = clock();
      view.last_error = null;
      runTurn(duty.account);
      changed();
      return "text" in body ? { ok: true, output: "", queued: false } : { ok: true, output: "", turn };
    },
    feed(after) {
      const turn = view.messages.at(-1)?.turn ?? 0;
      const start = view.busy ? view.turn_started_at : null;
      const shown = start === null ? 0 : Math.min(work.length, 1 + Math.floor((clock() - start) / FEED_STEP_SECONDS));
      const items = work.slice(0, shown).map((item, index) => ({ ...item, at: start! + index * FEED_STEP_SECONDS }));
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
