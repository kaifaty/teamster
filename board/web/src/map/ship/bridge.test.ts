import { describe, expect, it } from "vitest";
import type { Cargo, TaskLimits, TaskSummary } from "../../types";
import { HULL_SHARE, bridgeView, gaugesOf, hangarCaption, hullFrame, hullMarks, hullReport, loopsOf, routeOf } from "./bridge";

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

  it("puts a sleeping ship into the cryo field with its waking time, and gives a closed one no stop", () => {
    const sleeping = routeOf(task({ column: "sleeping", phase: "sleeping", sleeping_until: NOW + 3600 }), NOW);
    expect(sleeping.cryo?.wakes).toMatch(/\d\d:\d\d/);
    expect(sleeping.stops.some((stop) => stop.state === "here")).toBe(false);
    const closed = routeOf(task({ column: "closed", phase: "idle", alive: false }), NOW);
    expect(closed.ended).toBe(true);
    expect(closed.stops.some((stop) => stop.state === "here")).toBe(false);
    expect(closed.line).toMatch(/Рейс окончен/);
  });
});

describe("loopsOf", () => {
  it("counts fix rounds from the limits and CI attempts from the cargo, the CI loop only while CI is on", () => {
    const loops = loopsOf(task({ fix_round: 1 }), limits(), cargo({ ci: ci(1) }));
    expect(loops.map((loop) => loop.text)).toEqual(["круг исправления 2 из 3", "попытка CI 1 из 1"]);
    expect(loopsOf(task(), limits({ ci_enabled: false }), null).map((loop) => loop.kind)).toEqual(["fix"]);
    // An older server sends no limits: the summary's round, no limit and no CI loop.
    expect(loopsOf(task({ fix_round: 1 }), undefined, null).map((loop) => loop.text)).toEqual(["круг исправления 1"]);
  });
});

describe("gaugesOf", () => {
  it("reads the turn's time, the fuel, the repairs and the gate's attempts", () => {
    const gauges = gaugesOf(task(), limits(), cargo({ ci: ci(1) }), NOW);
    expect(gauges.map((gauge) => [gauge.label, gauge.value])).toEqual([
      ["Время хода", "38 / 120 мин"],
      ["Топливо задачи", "6,5 / 15 %"],
      ["Круги ремонта", "2 / 3"],
      ["Попытки врат", "1 / 1"],
    ]);
    expect(gauges[3]).toMatchObject({ share: 1, tone: "bad" });
  });

  it("shows a dash, not a zero, without data", () => {
    const old = gaugesOf(task({ alive: false }), undefined, null, NOW);
    expect(old.map((gauge) => gauge.value)).toEqual(["—", "—", "—", "—"]);
    expect(old.every((gauge) => gauge.share === null)).toBe(true);
    expect(gaugesOf(task(), limits({ ci_enabled: false, weekly_used_percent: null }), null, NOW).map((gauge) => gauge.value)).toEqual(["38 / 120 мин", "—", "2 / 3", "—"]);
  });
});

describe("hullReport", () => {
  it("lists the check, at most five findings with their place, CI's passes and failures, the base, the stop and open items", () => {
    const findings = Array.from({ length: 7 }, (_, index) => ({ id: `F${index + 1}`, severity: index ? "P2" : "P1", title: `t${index}`, file: index ? null : "a.ts", line: index ? null : 8 }));
    const report = hullReport(
      cargo({
        check: { command: "npm test", outcome: "passed", exit: 0, seconds: 134, at: null },
        review: { verdict: "defects", summary: null, findings, reviews: 2 },
        ci: ci(0),
        base: { base: "main", outcome: "conflict", files: ["x.py"] },
        stop: "base conflict",
        remaining: ["docs"],
        questions: ["why?"],
      }),
      NOW,
    );
    expect(report.rows.map((row) => [row.key, row.title, row.tone])).toEqual([
      ["check", "Полигон: проверка пройдена", "ok"],
      ["review", "Инспекция: 7 замечаний", "bad"],
      ["ci", "Врата: CI упал", "bad"],
      ["base", "База: main конфликт", "bad"],
      ["stop", "Остановка: конфликт с базой", "bad"],
    ]);
    const review = report.rows[1]!;
    expect(review.items).toHaveLength(5);
    expect(review.items[0]).toEqual({ mark: "P1", tone: "bad", text: "t0", where: "a.ts:8" });
    expect(review.more).toBe(2);
    expect(report.rows[2]).toMatchObject({ aside: "прошло 5 из 7 · 5 мин", items: [{ text: "lint" }, { text: "e2e" }] });
    expect(report).toMatchObject({ remaining: ["docs"], questions: ["why?"] });
    expect(hullReport(null, NOW).rows).toEqual([]);
  });
});

describe("the screen of a session and a scout", () => {
  it("keeps a session to its papers and a scout without repair loops and gauges", () => {
    const session = task({ kind: "session" });
    expect(bridgeView(session)).toMatchObject({ route: false, gauges: false, commands: false, hull: false, docs: false });
    expect(routeOf(session, NOW).stops.some((stop) => stop.state === "here")).toBe(false);
    expect(gaugesOf(session, null, null, NOW)).toEqual([]);
    const scout = task({ kind: "scout" });
    expect(bridgeView(scout)).toMatchObject({ route: true, loops: false, repairGauges: false, commands: true });
    expect(loopsOf(scout, limits(), null)).toEqual([]);
    expect(gaugesOf(scout, limits(), null, NOW).map((gauge) => gauge.id)).toEqual(["turn", "fuel"]);
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

  it("captions a working ship with its activity and a stopped one with its result", () => {
    const working = task({ activity: { at: NOW - 5, kind: "edit", text: "a.ts" } });
    expect(hangarCaption(working, NOW)).toEqual({ label: "сейчас", text: "правка: a.ts · 5 с назад" });
    const stopped = task({ alive: false, column: "review_me", summary: "Готово", activity: { at: NOW - 5, kind: "edit", text: "a.ts" } });
    expect(hangarCaption(stopped, NOW)).toEqual({ label: "итог", text: "Готово" });
  });
});
