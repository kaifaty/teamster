import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import type { ActionResult } from "../../lib/actions";
import type { Cargo, TaskDetail, TaskLimits, TaskSummary } from "../../types";
import { OWN_CHANGE_MS, createShipDesk } from "./desk";
import {
  blankRefit,
  deskOf,
  droppedNote,
  fallbackCommand,
  feedOf,
  isLong,
  answerText,
  causeOf,
  needOf,
  orderOutcome,
  reflectOrder,
  refitLine,
  refitOf,
  replyHint,
  stopConfirm,
  toggleAngle,
  type DeskView,
} from "./orders";

const NOW = 1_800_000_000;

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    slug: "t", kind: "work", title: null, link: null, repo: "repo", branch: null, task_type: null, executor: "codex", account: null,
    reviewer: "claude", model: "gpt-6", effort: "high", column: "running", phase: "turn", phase_started_at: NOW - 600, alive: true, turn: 1,
    fix_round: 0, outcome: "running", result_status: null, summary: null, pr: null, ci: null, sleeping_until: null, created: NOW - 9000,
    updated_at: NOW - 50, activity: null, check: null, review: null, findings_left: 0, stop: null, left: 0, ...overrides,
  };
}

const cargo = (questions: string[]): Cargo => ({
  check: null, claims: [], review: null, stop: null, ci: null, base: null, remaining: [], questions, decisions: { fixed: 0, rejected: 0 },
});

const limits: TaskLimits = {
  max_turn_minutes: 60, weekly_used_percent: 3, max_weekly_percent: 15, fix_rounds: 2, review_rounds: 0, ci_rounds: 1, ci_enabled: true,
  review_angles: ["security", "correctness"], check: null, rotations: [],
};

describe("comms feed", () => {
  const messages = [
    { at: NOW - 2000, source: "review" as const, text: "Codex нашёл 2 дефекта" },
    { at: NOW - 3000, source: "lead" as const, text: "Сделай экран" },
    { at: NOW - 1000, source: "ci" as const, text: "CI упал" },
  ];

  it("orders messages by time and ends with the first line of the last report, its questions counted, not listed", () => {
    const waiting = task({ alive: false, column: "attention", result_status: "needs_decision", summary: "Нужен выбор", updated_at: NOW - 100 });
    const feed = feedOf(waiting, messages, cargo(["Оставить карточку?", "Какой цвет?"]));
    expect(feed.map((item) => [item.who, item.tone, item.text])).toEqual([
      ["Ты · указание", "you", "Сделай экран"],
      ["Ревью · круг исправления", "sys", "Codex нашёл 2 дефекта"],
      ["CI · починка", "sys", "CI упал"],
      ["Агент · доклад", "agent", "Нужен выбор"],
    ]);
    expect(feed[3]!.note).toBe("ждёт решения · 2 вопроса");
  });

  it("puts a working ship's report before the message that set off its turn", () => {
    const working = task({ result_status: "partial", summary: "Частично", phase_started_at: NOW - 500 });
    const feed = feedOf(working, messages, cargo(["Как быть?"]));
    expect(feed.map((item) => item.who)).toEqual(["Ты · указание", "Ревью · круг исправления", "Агент · доклад", "CI · починка"]);
  });

  it("shows a sent order until the messages carry it, and folds a long text", () => {
    const echo = [{ at: NOW, text: "Продолжай" }];
    expect(feedOf(task(), [], null, echo).map((item) => [item.who, item.note])).toEqual([["Ты · указание", "передано"]]);
    expect(feedOf(task(), [{ at: NOW + 1, source: "lead", text: "Продолжай\n" }], null, echo)).toHaveLength(1);
    expect(isLong("1\n2\n3\n4")).toBe(false);
    expect(isLong("1\n2\n3\n4\n5")).toBe(true);
  });

  it("ends with the orders waiting in the queue, marks the sent and the dropped ones", () => {
    const queue = {
      waiting: [
        { at: NOW - 10, text: "Потом слей main" },
        { at: NOW - 20, text: "Сначала P1" },
      ],
      dropped: [{ at: NOW - 2500, text: "Подними версию", dropped_at: NOW - 2400, outcome: "stopped" }],
    };
    const sent = [...messages, { at: NOW - 1500, source: "lead" as const, text: "Добавь тест", queued_at: NOW - 1800 }];
    const working = task({ result_status: "partial", summary: "Частично", phase_started_at: NOW - 500 });
    const echo = [
      { at: NOW - 12, text: "Потом слей main", queued: true },
      { at: NOW, text: "И обнови README", queued: true },
    ];
    const feed = feedOf(working, sent, null, echo, queue);
    expect(feed.map((item) => [item.text, item.note, item.queue])).toEqual([
      ["Сделай экран", null, undefined],
      ["Подними версию", "не доставлено · остановлен", "dropped"],
      ["Codex нашёл 2 дефекта", null, undefined],
      ["Добавь тест", "из очереди", undefined],
      ["Частично", "сделано частично", undefined],
      ["CI упал", null, undefined],
      ["Сначала P1", "в очереди", "waiting"],
      ["Потом слей main", "в очереди", "waiting"],
      ["И обнови README", "в очереди", "waiting"],
    ]);
    expect(feed.filter((item) => item.queue).every((item) => item.tone === "you")).toBe(true);
  });

  it("words why the end of a cycle dropped an order", () => {
    expect(droppedNote("stopped")).toBe("не доставлено · остановлен");
    expect(droppedNote("interrupted")).toBe("не доставлено · прерван");
    expect(droppedNote("failed")).toBe("не доставлено · сбой");
    expect(droppedNote("something_new")).toBe("не доставлено · something_new");
    expect(droppedNote(null)).toBe("не доставлено");
  });
});

describe("order groups", () => {
  const groups = (view: DeskView) => (Object.keys(view) as (keyof DeskView)[]).filter((key) => view[key]);

  it("offers only the orders the server accepts in each state", () => {
    expect(groups(deskOf(task()))).toEqual(["reply", "accept", "reflect", "stop"]);
    expect(groups(deskOf(task({ alive: false, column: "attention", result_status: "needs_decision" })))).toEqual([
      "reply", "send", "accept", "refit", "review", "reflect", "clean",
    ]);
    expect(groups(deskOf(task({ alive: false, column: "review_me" })))).toEqual([
      "reply", "send", "accept", "acceptFirst", "refit", "review", "reflect", "clean",
    ]);
    expect(groups(deskOf(task({ column: "sleeping" })))).toEqual(["reply", "accept", "reflect", "stop"]);
    expect(groups(deskOf(task({ alive: false, column: "closed" })))).toEqual(["reply", "send", "accept", "refit", "review", "reflect", "clean"]);
    expect(groups(deskOf(task({ slug: "t-20261105T101500Z", alive: false, column: "closed" })))).toEqual(["accept", "reflect"]);
    expect(groups(deskOf(task({ kind: "session", alive: false })))).toEqual([]);
    expect(groups(deskOf(task({ kind: "scout", alive: false, column: "closed" })))).toEqual(["reflect", "clean"]);
    expect(groups(deskOf(task({ kind: "reflect", alive: false })))).toEqual(["reply", "send", "refit", "reflect", "clean"]);
  });

  it("puts the reply of a busy ship in its queue only when the board's teamster queues", () => {
    expect(groups(deskOf(task(), true))).toEqual(["reply", "send", "queue", "accept", "refit", "reflect", "stop"]);
    expect(groups(deskOf(task({ column: "sleeping" }), true))).toContain("queue");
    expect(groups(deskOf(task({ kind: "reflect" }), true))).toEqual(["reply", "send", "queue", "refit", "reflect", "stop"]);
    expect(deskOf(task({ alive: false, column: "review_me" }), true).queue).toBe(false);
    expect(deskOf(task({ kind: "scout" }), true).send).toBe(false);
    expect(deskOf(task({ slug: "t-20261105T101500Z" }), true).send).toBe(false);
    expect(replyHint(deskOf(task(), true))).toMatch(/^Агент работает: указание встанет в очередь/);
    expect(replyHint(deskOf(task()))).toMatch(/^Идёт ход: teamster отклонит указание\. Обнови teamster до 1\.60/);
    expect(refitLine({ options: { effort: "low" }, errors: [] }, true)).toBe("уйдёт с указанием в очередь: --effort=low");
  });

  it("asks to upgrade teamster only while the board runs orders, and else names why it does not", () => {
    const hintOf = (actions: TaskDetail["actions"]) => {
      const detail = ref({ ...task(), timeline: [], files: [], cargo: null, actions } as TaskDetail);
      const desk = createShipDesk({ slug: ref("t"), task: ref(task()), detail, act: (async () => ({ ok: true, output: "" })) as never });
      return replyHint(deskOf(task(), desk.queue.value), desk.live.value ? null : desk.offReason.value);
    };
    expect(hintOf({ enabled: true, reason: null, queue: false })).toMatch(/Обнови teamster до 1\.60/);
    for (const [reason, words] of [
      ["read_only", "запущена с --read-only"],
      ["no_teamster", "команда teamster не найдена"],
    ] as const) {
      const hint = hintOf({ enabled: false, reason, queue: false });
      expect(hint).toContain(`доска только читает (${words})`);
      expect(hint).not.toMatch(/Обнови teamster/);
    }
  });

  it("warns before a stop that the queue will not go", () => {
    expect(stopConfirm(0)).toBe("Остановить агента посреди хода? Работа в worktree останется.");
    expect(stopConfirm(1)).toMatch(/ 1 указание в очереди не уйдёт\.$/);
    expect(stopConfirm(3)).toMatch(/ 3 указания в очереди не уйдут\.$/);
    expect(stopConfirm(5)).toMatch(/ 5 указаний в очереди не уйдут\.$/);
  });

  it("asks of you what the state calls for, with one main order", () => {
    const need = (overrides: Partial<TaskSummary>, questions: string[] = [], queue = false) => {
      const ship = task(overrides);
      return needOf(ship, cargo(questions), deskOf(ship, queue), NOW);
    };
    expect(need({})).toMatchObject({ kind: "calm", title: "Вмешиваться не нужно" });
    expect(need({ alive: true, column: "sleeping", phase: "sleeping" }).kind).toBe("sleep");
    expect(need({ alive: false, column: "review_me" })).toMatchObject({ kind: "accept", tone: "ok" });
    expect(need({ alive: false, column: "review_me", ci: "failed" })).toMatchObject({ kind: "return", tone: "bad", text: "CI не прошёл: разбери логи упавших проверок, исправь и запушь." });
    expect(need({ alive: false, column: "attention", result_status: "needs_decision", outcome: "completed" }, ["Можно?"])).toMatchObject({ kind: "questions", tone: "warn" });
    // A decision without questions takes your own words; a stopped ship gets «continue» to send.
    expect(need({ alive: false, column: "attention", result_status: "needs_decision", outcome: "completed" })).toMatchObject({ kind: "reply", text: "" });
    expect(need({ alive: false, column: "attention", outcome: "stopped" })).toMatchObject({ kind: "reply", text: "Продолжай с того места, где остановился." });
    // The server takes no words from a scout, an archived record or a closed ship.
    expect(need({ kind: "scout", alive: false, column: "attention", outcome: "stopped" }).kind).toBe("none");
    expect(need({ alive: false, column: "closed" })).toMatchObject({ kind: "none", title: "Задача закрыта: действий не нужно" });
    expect(need({ kind: "session", alive: false, column: "review_me" }).kind).toBe("none");
  });
});

describe("«Сейчас»", () => {
  it("finds the message that set off the turn: the newest, and only one sent before the last turn ended", () => {
    const messages = [
      { at: NOW - 900, source: "review" as const, text: "2 находки" },
      { at: NOW - 300, source: "lead" as const, text: "почему нельзя?" },
    ];
    expect(causeOf(task({ alive: false, updated_at: NOW - 200 }), messages)).toEqual({ who: "Ты написал", tone: "you", at: NOW - 300, text: "почему нельзя?" });
    expect(causeOf(task({ alive: true }), messages.slice(0, 1))).toMatchObject({ who: "Отчёт ревью", tone: "sys" });
    expect(causeOf(task({ alive: false, updated_at: NOW - 400 }), messages)).toBeNull();
    expect(causeOf(task(), [])).toBeNull();
  });

  it("makes one reply of the quick answers, quoting the start of each question", () => {
    const questions = ["Можно ли в этой сессии изменить ~/.codex/checks/home-infra/ci_wait.py (вне репозитория)? Сначала сохраню копию.", "Добавить ли ранний выход?", "А третий?"];
    expect(answerText(questions, [])).toBe("");
    expect(answerText(questions, [], "  Сделай сам  ")).toBe("Сделай сам");
    expect(answerText(questions, [{ kind: "yes" }, { kind: "own", text: " только для веток " }, { kind: "own", text: " " }], "Копию оставь.")).toBe(
      [
        "Ответы на вопросы:",
        "1. «Можно ли в этой сессии изменить ~/.codex/checks/home-infra/ci_wait.py…» — да.",
        "2. «Добавить ли ранний выход?» — только для веток",
        "",
        "Копию оставь.",
      ].join("\n"),
    );
    expect(answerText(questions, [null, { kind: "no" }])).toBe("Ответы на вопросы:\n2. «Добавить ли ранний выход?» — нет.");
  });
});

describe("refit", () => {
  const ship = task({ alive: false });

  it("sends only the changed fields, within the contract", () => {
    const draft = { ...blankRefit(), model: " gpt-6 ", effort: "xhigh", max_minutes: "90", max_weekly: "15", fix_rounds: "3", reviewer: "claude", angles: ["correctness", "security"] };
    expect(refitOf(draft, ship, limits)).toEqual({ options: { effort: "xhigh", max_minutes: 90, fix_rounds: 3 }, errors: [] });
    expect(refitLine(refitOf(draft, ship, limits))).toBe("уйдёт с указанием: --effort=xhigh --max-minutes=90 --fix-rounds=3");
    expect(refitLine(refitOf(blankRefit(), ship, limits))).toBe("ничего не меняется");
    const more = { ...blankRefit(), max_weekly: "2,5", ci_rounds: "0", reviewer: "codex", angles: ["auto"] };
    expect(refitOf(more, ship, limits).options).toEqual({ max_weekly: 2.5, ci_rounds: 0, reviewer: "codex", review_angles: "auto" });
  });

  it("refuses fields out of bounds, and ultra for a Claude ship", () => {
    const draft = { ...blankRefit(), model: "bad model", max_minutes: "4", max_weekly: "101", fix_rounds: "1.5", ci_rounds: "6" };
    expect(refitOf(draft, ship, limits).errors).toHaveLength(5);
    expect(refitOf(draft, ship, limits).options).toEqual({});
    expect(refitOf({ ...blankRefit(), effort: "ultra" }, ship, limits).options).toEqual({ effort: "ultra" });
    expect(refitOf({ ...blankRefit(), effort: "ultra" }, { ...ship, executor: "claude" }, limits).errors).toHaveLength(1);
  });

  it("keeps auto alone among the angles", () => {
    expect(toggleAngle(["correctness"], "auto")).toEqual(["auto"]);
    expect(toggleAngle(["auto"], "tests")).toEqual(["tests"]);
    expect(toggleAngle(["tests", "security"], "tests")).toEqual(["security"]);
  });
});

describe("fallback commands", () => {
  it("copies the command equal to each order", () => {
    const slug = "fix-login-20261105T101500Z";
    expect(fallbackCommand({ route: "say", body: { slug: "fix-login", text: "it's done", options: { model: "gpt-6", max_weekly: 15, review_angles: ["correctness", "tests"] } } })).toBe(
      "teamster say fix-login --model=gpt-6 --max-weekly=15 --review-angles=correctness,tests 'it'\\''s done'",
    );
    expect(fallbackCommand({ route: "verdict", body: { slug, verdict: "redone", note: "в PR #12" } })).toBe("teamster verdict fix-login redone --note 'в PR #12'");
    expect(fallbackCommand({ route: "review", body: { slug: "fix-login", review_angles: "auto", reviewer: "codex" } })).toBe(
      "teamster review fix-login --reviewer=codex --review-angles=auto",
    );
    expect(fallbackCommand(reflectOrder(slug), new Date("2026-11-09T05:07:00Z"))).toBe("teamster reflect reflect-1109-050700 --task fix-login");
    expect(fallbackCommand({ route: "stop", body: { slug: "fix-login" } })).toBe("teamster stop fix-login");
    expect(fallbackCommand({ route: "clean", body: { slug: "fix-login", keep_branch: true } })).toBe("teamster clean fix-login --keep-branch");
    expect(fallbackCommand({ route: "clean", body: { slug: "fix-login", keep_branch: false } })).toBe("teamster clean fix-login");
  });
});

describe("order outcomes", () => {
  it("tells what each order changed in words, never teamster's raw output", () => {
    const say = { route: "say", body: { slug: "t", text: "Дальше" } } as const;
    expect(orderOutcome(say, "sent to t (turn 4), pid 12")).toBe("Указание передано: агент начал ход 4");
    expect(orderOutcome(say, "")).toBe("Указание передано");
    expect(orderOutcome(say, "queued for t: 2 waiting; sent when the current cycle ends", { queued: true })).toBe(
      "Указание в очереди: уйдёт одним ходом, когда агент закончит цикл",
    );
    expect(orderOutcome({ route: "verdict", body: { slug: "t", verdict: "accepted" } }, "verdict accepted recorded for t (repo)")).toBe(
      "Вердикт «принято» записан — это оценка для статистики; PR этим не сливается",
    );
    expect(orderOutcome({ route: "verdict", body: { slug: "t", verdict: "dropped" } }, "")).toMatch(/^Вердикт «не берём» записан/);
    expect(orderOutcome({ route: "review", body: { slug: "t" } }, "reviewing t, pid 3")).toBe("Внеочередное ревью запущено");
    expect(orderOutcome(reflectOrder("t"), "said", { slug: "reflect-1110-120000" })).toBe("Задача отправлена на рефлексию: reflect-1110-120000");
    expect(orderOutcome({ route: "stop", body: { slug: "t" } }, "stopped t")).toBe("Агент остановлен");
    expect(orderOutcome({ route: "clean", body: { slug: "t", keep_branch: true } }, "cleaned t")).toBe("Задача убрана: worktree удалён, ветка осталась");
    expect(orderOutcome({ route: "clean", body: { slug: "t", keep_branch: false } }, "cleaned t")).toBe("Задача убрана: worktree и ветка удалены");
  });
});

describe("console", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps teamster's output for the title and drops an outcome once the ship moves on past its own effect", async () => {
    vi.useFakeTimers();
    const ship = ref(task({ slug: "a" }));
    const detail = ref({ ...ship.value, timeline: [], files: [], cargo: null, actions: { enabled: true, reason: null, queue: true } } as TaskDetail);
    const outputs = ["queued for a: 2 waiting; sent when the current cycle ends", "stopped a"];
    const desk = createShipDesk({ slug: ref("a"), task: ship, detail, act: (async () => ({ ok: true, output: outputs.shift()! })) as never });
    desk.reply.value = "Потом слей main";
    await desk.send();
    expect([desk.groups.reply.done, desk.groups.reply.output]).toEqual([
      "Указание в очереди: уйдёт одним ходом, когда агент закончит цикл",
      "queued for a: 2 waiting; sent when the current cycle ends",
    ]);
    vi.advanceTimersByTime(OWN_CHANGE_MS + 1);
    await desk.stop();
    // The stop's own effect, soon after it, keeps its outcome; the queued say is out of date.
    ship.value = { ...ship.value, alive: false, column: "attention", phase: "idle", outcome: "stopped" };
    await nextTick();
    expect([desk.groups.reply.done, desk.groups.reply.output]).toEqual(["", ""]);
    expect(desk.groups.recall.done).toBe("Агент остановлен");
    vi.advanceTimersByTime(OWN_CHANGE_MS + 1);
    ship.value = { ...ship.value, column: "closed" };
    await nextTick();
    expect(desk.groups.recall.done).toBe("");
  });

  it("leaves another ship's console alone when an order's answer comes late", async () => {
    const slug = ref("a");
    const detail = ref({ ...task({ slug: "a", alive: false }), timeline: [], files: [], cargo: null, actions: { enabled: true, reason: null } } as TaskDetail);
    const answers: ((result: ActionResult) => void)[] = [];
    const act = () => new Promise<ActionResult>((resolve) => answers.push(resolve));
    const desk = createShipDesk({ slug, task: ref(task({ slug: "a", alive: false })), detail, act: act as never });
    desk.reply.value = "Продолжай";
    const sent = desk.send();
    const judged = desk.verdict("accepted");
    slug.value = "b";
    await nextTick();
    desk.reply.value = "черновик для b";
    desk.refit.model = "gpt-7";
    for (const answer of answers) answer({ ok: true, output: "done" });
    await sent;
    expect(await judged).toBe(false);
    expect(desk.reply.value).toBe("черновик для b");
    expect(desk.refit.model).toBe("gpt-7");
    expect(desk.echo.value).toEqual([]);
    expect([desk.groups.reply.done, desk.groups.accept.done, desk.groups.reply.busy]).toEqual(["", "", null]);
  });
});
