import { describe, expect, it } from "vitest";
import type { Cargo, TaskChanges, TaskLimits, TaskSummary } from "../../types";
import { HULL_SHARE, bridgeView, hullFrame, hullMarks, loopsOf, metersOf, papersOf, routeOf } from "./bridge";
import { doneRows } from "./done";
import { changesLine, nowOf, reportParagraphs } from "./now";

const NOW = 1_800_000_000;

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    slug: "t",
    kind: "work",
    title: null,
    link: null,
    repo: "repo",
    branch: null,
    task_type: null,
    executor: "codex",
    account: null,
    reviewer: "claude",
    model: null,
    effort: null,
    column: "running",
    phase: "turn",
    phase_started_at: NOW - 38 * 60,
    alive: true,
    turn: 1,
    fix_round: 0,
    outcome: "running",
    result_status: null,
    summary: null,
    pr: null,
    ci: null,
    sleeping_until: null,
    created: NOW - 1000,
    updated_at: NOW - 50,
    activity: null,
    check: null,
    review: null,
    findings_left: 0,
    stop: null,
    left: 0,
    ...overrides,
  };
}

function limits(overrides: Partial<TaskLimits> = {}): TaskLimits {
  return {
    max_turn_minutes: 120,
    weekly_used_percent: 6.5,
    max_weekly_percent: 15,
    fix_rounds: 3,
    review_rounds: 2,
    ci_rounds: 1,
    ci_enabled: true,
    review_angles: [],
    check: null,
    rotations: [],
    ...overrides,
  };
}

function cargo(overrides: Partial<Cargo> = {}): Cargo {
  return { check: null, claims: [], review: null, stop: null, ci: null, base: null, remaining: [], questions: [], decisions: { fixed: 0, rejected: 0 }, ...overrides };
}

const ci = (rounds: number, rest: Partial<NonNullable<Cargo["ci"]>> = {}) => ({
  outcome: "failed", passed: 5, failed: 2, total: 7, failing: ["lint", "e2e"], seconds: 300, rounds, reason: null, ...rest,
});

describe("routeOf", () => {
  const here = (overrides: Partial<TaskSummary>) => routeOf(task(overrides), NOW).stops.find((stop) => stop.state === "here")?.id ?? null;

  it("stands the ship at the stop of its phase, and on the roadstead by its column", () => {
    expect(here({ phase: "turn" })).toBe("yard");
    expect(here({ phase: "fix" })).toBe("yard");
    expect(here({ phase: "check" })).toBe("range");
    expect(here({ phase: "review" })).toBe("inspection");
    expect(here({ phase: "ci" })).toBe("gate");
    expect(here({ column: "review_me", phase: "idle", alive: false })).toBe("roadstead");
    expect(here({ column: "attention", phase: "review", alive: false })).toBe("inspection");
    const route = routeOf(task({ phase: "ci" }), NOW);
    expect(route.stops.map((stop) => stop.state)).toEqual(["past", "past", "past", "here", "ahead", "ahead"]);
  });

  it("says that a stopped ship waits for you where it stands, so the strip agrees with the recorder", () => {
    const stopped = routeOf(task({ column: "attention", phase: "idle", alive: false, result_status: "needs_decision" }), NOW);
    const here = stopped.stops.find((stop) => stop.state === "here")!;
    expect([here.id, here.name, here.note]).toEqual(["yard", "Работа", "ждёт тебя"]);
    expect(stopped.line).toBe("Стоит на этапе «Работа»: ход кончился, дальше — по твоему слову");
    expect(routeOf(task({ column: "review_me", phase: "idle", alive: false }), NOW).line).toBe("Готово: ждёт твоей приёмки");
    const working = routeOf(task({ phase: "turn" }), NOW);
    expect(working.line).toBe("Сейчас: Работа · ход");
    expect(working.stops.map((stop) => stop.name)).toEqual(["Работа", "Проверка", "Ревью", "CI", "Приёмка", "В main"]);
    expect(working.stops.every((stop) => stop.note === "")).toBe(true);
  });

  it("puts a sleeping ship into the cryo field with its waking time, and gives a closed one no stop", () => {
    const sleeping = routeOf(task({ column: "sleeping", phase: "sleeping", sleeping_until: NOW + 3600 }), NOW);
    expect(sleeping.cryo?.wakes).toMatch(/\d\d:\d\d/);
    expect(sleeping.stops.some((stop) => stop.state === "here")).toBe(false);
    const closed = routeOf(task({ column: "closed", phase: "idle", alive: false }), NOW);
    expect(closed.ended).toBe(true);
    expect(closed.stops.some((stop) => stop.state === "here")).toBe(false);
    expect(closed.line).toBe("Задача закрыта");
  });
});

describe("loopsOf", () => {
  it("counts fix rounds from the limits and CI attempts from the cargo, the CI loop only while CI is on", () => {
    const loops = loopsOf(task({ fix_round: 1 }), limits(), cargo({ ci: ci(1) }));
    expect(loops.map((loop) => loop.text)).toEqual(["↺ круг исправления 2 из 3", "↺ попытка CI 1 из 1"]);
    expect(loopsOf(task(), limits({ ci_enabled: false }), null).map((loop) => loop.kind)).toEqual(["fix"]);
    // An older server sends no limits: the summary's round, no limit and no CI loop.
    expect(loopsOf(task({ fix_round: 1 }), undefined, null).map((loop) => loop.text)).toEqual(["↺ круг исправления 1"]);
  });

  it("leaves out the fix loop of a ship that may not fix and has not", () => {
    expect(loopsOf(task(), limits({ fix_rounds: 0, review_rounds: 0, ci_enabled: false }), null)).toEqual([]);
  });
});

describe("metersOf", () => {
  it("reads the turn's time, the budget, the fix rounds and the CI repairs", () => {
    const meters = metersOf(task(), limits(), cargo({ ci: ci(1) }), NOW);
    expect(meters.map((meter) => [meter.label, meter.value])).toEqual([
      ["Время хода", "38 из 120 мин"],
      ["Бюджет задачи", "6,5 из 15 % недели"],
      ["Круги исправления", "2 из 3"],
      ["Попытки починки CI", "1 из 1"],
    ]);
    expect(meters[3]).toMatchObject({ share: 1, tone: "bad" });
  });

  it("leaves out a meter without data instead of drawing it empty", () => {
    expect(metersOf(task({ alive: false }), undefined, null, NOW)).toEqual([]);
    const idle = limits({ weekly_used_percent: 0, max_weekly_percent: null, fix_rounds: 0, review_rounds: 0, ci_enabled: false });
    expect(metersOf(task({ alive: false, column: "attention" }), idle, null, NOW)).toEqual([]);
    expect(metersOf(task(), limits({ ci_enabled: false, weekly_used_percent: null }), null, NOW).map((meter) => meter.id)).toEqual(["turn", "repairs"]);
  });
});

const changes = (overrides: Partial<TaskChanges> = {}): TaskChanges => ({ commits: 3, files: 7, insertions: 120, deletions: 30, uncommitted: 0, ...overrides });

describe("doneRows", () => {
  it("lists the branch, the PR, the check, the agent's checks, at most five findings, CI, the base, the stop and what is left", () => {
    const findings = Array.from({ length: 7 }, (_, index) => ({ id: `F${index + 1}`, severity: index ? "P2" : "P1", title: `t${index}`, file: index ? null : "a.ts", line: index ? null : 8 }));
    const rows = doneRows(
      task({ pr: "https://github.com/o/r/pull/12" }),
      cargo({
        check: { command: "npm test", outcome: "passed", exit: 0, seconds: 134, at: null },
        claims: [{ command: "npm test", outcome: "passed", details: "40 passed" }, { command: "e2e", outcome: "not_run", details: "" }],
        review: { verdict: "defects", summary: null, findings, reviews: 2 },
        ci: ci(0),
        base: { base: "origin/main", outcome: "conflict", files: ["x.py"] },
        stop: "base conflict",
        remaining: ["docs"],
        questions: ["why?"],
        decisions: { fixed: 1, rejected: 0 },
      }),
      changes(),
      NOW,
    );
    expect(rows.map((row) => [row.key, row.title, row.tone, row.text])).toEqual([
      ["changes", "Изменения", "ok", "3 коммита · 7 файлов · +120 −30"],
      ["pr", "PR", "ok", "PR #12 ↗"],
      ["check", "Проверка", "ok", "Пройдена · 2 мин 14 с"],
      ["claims", "Проверки агента", "muted", "Прошло 1 из 2"],
      ["review", "Ревью", "bad", "7 замечаний · после 2 ревью · исправлено 1"],
      ["ci", "CI", "bad", "Упал · прошло 5 из 7 · 5 мин"],
      ["base", "Слияние с main", "bad", "Конфликт · 1 файл"],
      ["stop", "Автоцикл остановлен", "bad", "конфликт с базой"],
      ["remaining", "Не сделано", "warn", "По отчёту агента:"],
    ]);
    const review = rows[4]!;
    expect(review.items).toHaveLength(5);
    expect(review.items[0]).toEqual({ mark: "P1", tone: "bad", text: "t0", where: "a.ts:8" });
    expect(review.more).toBe(2);
    expect(rows[0]!.items).toEqual([]);
    expect(rows[3]!.items.map((item) => [item.mark, item.text, item.where])).toEqual([["✓", "npm test", "40 passed"], ["—", "e2e", null]]);
    expect(rows[5]!.items.map((item) => item.text)).toEqual(["lint", "e2e"]);
    // The questions wait in «Сейчас», never here.
    expect(rows.some((row) => row.items.some((item) => item.text === "why?"))).toBe(false);
  });

  it("says plainly that nothing changed, and leaves out what it does not know", () => {
    const rows = doneRows(task({ alive: false }), cargo(), changes({ commits: 0, files: 0, insertions: 0, deletions: 0 }), NOW);
    expect(rows.map((row) => [row.key, row.tone, row.text])).toEqual([["changes", "muted", "Нет: в ветке ни одного коммита"]]);
    expect(doneRows(task(), null, null, NOW)).toEqual([]);
    expect(doneRows(task(), cargo(), changes({ uncommitted: 2 }), NOW)[0]).toMatchObject({ tone: "warn", text: "3 коммита · 7 файлов · +120 −30 · незакоммичено 2" });
  });
});

describe("nowOf", () => {
  const ask = cargo({ questions: ["Можно?", "А это?"] });
  const NOON = new Date(2026, 10, 10, 20, 16).getTime() / 1000;

  it("words a ship that waits for a decision, with the turn, the branch and the PR", () => {
    const waiting = task({ column: "attention", alive: false, phase: "idle", turn: 2, result_status: "needs_decision", outcome: "completed", updated_at: NOON });
    expect(nowOf(waiting, ask, changes({ commits: 0, files: 0, insertions: 0, deletions: 0 }), limits(), NOON + 300)).toEqual({
      tone: "wait",
      headline: "Агент ждёт твоего решения: 2 вопроса",
      facts: ["ход 2 закончился в 20:16", "ничего не изменено", "PR нет"],
    });
  });

  it("words the other states in plain words", () => {
    const head = (overrides: Partial<TaskSummary>, more: Partial<Cargo> = {}) => nowOf(task(overrides), cargo(more), null, limits(), NOW);
    expect(head({ phase: "turn", turn: 3 })).toMatchObject({ tone: "work", headline: "Агент работает: ход 3", facts: ["идёт 38 мин из 120 мин"] });
    expect(head({ phase: "fix" }).headline).toBe("Агент исправляет находки ревью: круг 2 из 3");
    expect(head({ alive: false, column: "review_me", phase: "idle", review: "clean", ci: "passed", pr: "https://x/pull/7" }, { ci: ci(0, { outcome: "passed", passed: 7, failed: 0, failing: [] }) })).toMatchObject({
      tone: "ready",
      headline: "Готово: можно принимать",
      facts: ["ход 1 закончился в " + new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date((NOW - 50) * 1000)), "PR #7", "ревью чистое", "CI 7 из 7"],
    });
    expect(head({ alive: false, column: "review_me", phase: "idle", ci: "failed" }, { ci: ci(1) })).toMatchObject({ tone: "bad", headline: "CI не прошёл: 2 из 7 упали" });
    expect(head({ alive: false, column: "attention", phase: "idle", result_status: "blocked" }).headline).toBe("Агент заблокирован: нужна твоя помощь");
    expect(head({ alive: true, column: "sleeping", phase: "sleeping" }).tone).toBe("sleep");
    expect(head({ alive: false, column: "closed", phase: "idle" })).toMatchObject({ tone: "dim", headline: "Задача закрыта" });
  });
});

describe("reportParagraphs", () => {
  it("keeps every paragraph of the report and marks the code", () => {
    const text = "Ничего не изменено.\n\nПричина: только `ci_wait.py`\nрешает это.\n\n\nИтог";
    expect(reportParagraphs(text)).toEqual([
      [{ code: false, text: "Ничего не изменено." }],
      [{ code: false, text: "Причина: только " }, { code: true, text: "ci_wait.py" }, { code: false, text: "\nрешает это." }],
      [{ code: false, text: "Итог" }],
    ]);
    expect(reportParagraphs("one ` stray")).toEqual([[{ code: false, text: "one " }, { code: false, text: "` stray" }]]);
  });

  it("words the branch's changes in short", () => {
    expect(changesLine(null)).toBeNull();
    expect(changesLine(changes({ commits: 0, uncommitted: 0 }))).toBe("ничего не изменено");
    expect(changesLine(changes({ commits: 1, files: 2, uncommitted: 1 }))).toBe("1 коммит · 2 файла · незакоммичено 1");
  });
});

describe("the screen of a session and a scout", () => {
  it("keeps a session to its papers and a scout without repair loops and meters", () => {
    const session = task({ kind: "session" });
    expect(bridgeView(session)).toMatchObject({ route: false, gauges: false, commands: false, hull: false, docs: false });
    expect(routeOf(session, NOW).stops.some((stop) => stop.state === "here")).toBe(false);
    expect(metersOf(session, null, null, NOW)).toEqual([]);
    expect(papersOf(session, null, null, NOW)).toMatchObject({ more: [] });
    const scout = task({ kind: "scout" });
    expect(bridgeView(scout)).toMatchObject({ route: true, loops: false, repairGauges: false, commands: true });
    expect(loopsOf(scout, limits(), null)).toEqual([]);
    expect(metersOf(scout, limits(), null, NOW).map((meter) => meter.id)).toEqual(["turn", "fuel"]);
  });

  it("names the papers in plain words", () => {
    const papers = papersOf(task({ executor: "claude", account: "main", model: "claude-opus-5-5", effort: "high" }), limits(), null, NOW);
    expect(papers.main.slice(0, 3).map((row) => [row.label, row.value])).toEqual([
      ["Исполнитель", "Claude · main"],
      ["Модель", "claude-opus-5-5"],
      ["Усилие", "high"],
    ]);
    expect(papers.more.map((row) => row.label)).toEqual(["Проверка", "Круги исправления", "CI", "Лимит хода", "Бюджет", "Смены аккаунта"]);
  });

  it("marks holes for open findings and patches for rounds, stable per slug", () => {
    const frame = hullFrame("shipBlue");
    const marks = hullMarks("ship", 2, 2, frame);
    expect(marks.filter((mark) => mark.kind === "hole")).toHaveLength(2);
    expect(marks.filter((mark) => mark.kind === "patch")).toHaveLength(2);
    expect(hullMarks("ship", 2, 2, frame)).toEqual(marks);
    expect(hullMarks("ship", 40, 9, frame).length).toBe(8);
  });

  it("scales every hull class to the same length in the hangar", () => {
    // The opaque part of the light ship is 0.896 of its picture, the copper frigate's 0.978.
    expect(hullFrame("shipBlue").size * 0.896).toBeCloseTo(HULL_SHARE * 100, 0);
    expect(hullFrame("shipCopperFrigate").size * 0.978).toBeCloseTo(HULL_SHARE * 100, 0);
  });
});
