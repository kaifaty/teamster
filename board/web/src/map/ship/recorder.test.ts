import { describe, expect, it } from "vitest";
import { logEvent } from "../../fixtures/events";
import type { Activity, LogEvent, TaskSummary } from "../../types";
import { logSlug, recorderWindow, tapeMarks, tapeOf, tapeSegments, tapeTicks } from "./recorder";
import { TELEMETRY_LIMIT, mergeTelemetry } from "./telemetry";

const NOW = 1_800_000_000;
const M = 60;

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    slug: "ship",
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
    column: "review_me",
    phase: "idle",
    phase_started_at: null,
    alive: false,
    turn: 2,
    fix_round: 0,
    outcome: null,
    result_status: null,
    summary: null,
    pr: null,
    ci: null,
    sleeping_until: null,
    created: NOW - 200 * M,
    updated_at: NOW - 10 * M,
    activity: null,
    check: null,
    review: null,
    findings_left: 0,
    stop: null,
    left: 0,
    ...overrides,
  };
}

/** A phase from `from` to `to` minutes before NOW. */
const row = (phase: string, from: number, to: number, fields: Partial<LogEvent> = {}): LogEvent =>
  logEvent({ kind: phase === "review" ? "review" : "work", slug: "ship", phase, turn: 1, outcome: "completed", ...fields, took: (from - to) * M }, NOW - to * M);

/** Turn 1 through every stop, the lead's wait, then turn 2 with a failed check. */
const VOYAGE: LogEvent[] = [
  row("work", 190, 160),
  row("check", 160, 155, { outcome: "passed" }),
  row("base_check", 155, 154, { outcome: "passed" }),
  row("review", 154, 140, { findings: 2, verdict: "defects" }),
  row("fix", 140, 120, { round: 1 }),
  row("turn", 190, 110, { outcome: "done" }),
  row("work", 80, 50, { turn: 2 }),
  row("check", 50, 45, { turn: 2, outcome: "failed" }),
  row("turn", 80, 40, { turn: 2, outcome: "done" }),
];

describe("tape segments", () => {
  it("maps the phases to stops, skips the turn rows and adds the roadstead after each turn", () => {
    const segments = tapeSegments(VOYAGE, task(), NOW);
    expect(segments.map((segment) => segment.stop)).toEqual(["yard", "range", "range", "inspection", "yard", "roadstead", "yard", "range", "roadstead"]);
    const [firstWait, lastWait] = segments.filter((segment) => segment.stop === "roadstead");
    // The first wait lasts until the next turn starts; the last one until now, while the ship still waits for you.
    expect([firstWait!.from, firstWait!.to]).toEqual([NOW - 110 * M, NOW - 80 * M]);
    expect([lastWait!.from, lastWait!.to]).toEqual([NOW - 40 * M, NOW]);
    expect(segments.filter((segment) => segment.failed).map((segment) => segment.stop)).toEqual(["inspection", "range"]);
    expect(segments.some((segment) => segment.live)).toBe(false);
    expect(segments[0]!.title).toBe("Верфь, ход 1: 30 мин · завершено");
    expect(segments[3]!.title).toBe("Инспекция, ревью: 14 мин · есть замечания: 2");
  });

  it("maps a scout's phase to the yard", () => {
    expect(tapeSegments([row("scout", 30, 10)], task({ kind: "scout" }), NOW).map((segment) => segment.stop)).toEqual(["yard"]);
  });

  it("draws the live phase from its start to now, and a sleeping ship in the cryo field", () => {
    const working = tapeSegments(VOYAGE.slice(0, 5), task({ alive: true, column: "running", phase: "check", phase_started_at: NOW - 100 * M }), NOW);
    const live = working[working.length - 1]!;
    expect(live).toMatchObject({ stop: "range", from: NOW - 100 * M, to: NOW, live: true });
    expect(live.title).toBe("Полигон: идёт 1 ч 40 мин");

    // The roadstead after a turn ends where the live phase starts.
    const asleep = tapeSegments(VOYAGE, task({ alive: true, column: "sleeping", phase: "sleeping", phase_started_at: NOW - 30 * M }), NOW);
    expect(asleep.slice(-2).map((segment) => [segment.stop, segment.from, segment.to, segment.live])).toEqual([
      ["roadstead", NOW - 40 * M, NOW - 30 * M, false],
      ["cryo", NOW - 30 * M, NOW, true],
    ]);
  });
});

describe("tape marks", () => {
  it("marks the lead's orders, the account changes, the verdicts and the failed stops", () => {
    const verdict = logEvent({ kind: "verdict", slug: "ship", verdict: "redone", note: "again" }, NOW - 5 * M);
    const events = [...VOYAGE, verdict];
    const segments = tapeSegments(events, task(), NOW);
    const messages = [
      { at: NOW - 100 * M, source: "lead" as const, text: "Добавь метрики" },
      { at: NOW - 139 * M, source: "review" as const, text: "2 находки" },
    ];
    const rotations = [
      { at: NOW - 48 * M, from: "pool-1", to: "pool-2", reason: "limit" },
      { at: NOW - 60 * M, from: "pool-2", to: null, reason: "no account" },
    ];
    const marks = tapeMarks(events, segments, messages, rotations);
    expect(marks.map((mark) => [mark.kind, mark.label, (NOW - mark.at) / M])).toEqual([
      ["fail", "✗", 140],
      ["say", "▼ указание", 100],
      ["fuel", "⛽ заправка", 48],
      ["fail", "✗", 45],
      ["verdict", "✓ вердикт", 5],
    ]);
    expect(marks.find((mark) => mark.kind === "fuel")!.title).toBe("Заправка: смена аккаунта pool-1 → pool-2 · limit");
    expect(marks.find((mark) => mark.kind === "verdict")!.title).toBe("Вердикт: на переделку · again");

    // Placed on the tape: from the launch to now, close marks in separate rows.
    const tape = tapeOf(events, task(), messages, rotations, NOW);
    expect([tape.start, tape.end]).toEqual([NOW - 200 * M, NOW]);
    expect(tape.marks.map((mark) => mark.left)).toEqual([30, 50, 76, 77.5, 97.5]);
    expect(tape.marks.map((mark) => mark.lane)).toEqual([0, 0, 0, 1, 0]);
    expect(tape.segments[0]).toMatchObject({ left: 5, width: 15 });
  });
});

describe("tape ticks", () => {
  it("gives four to six times, the ends included, with dates past a day", () => {
    for (const minutes of [7, 50, 123, 600, 1439, 3000, 31 * 1440]) {
      const ticks = tapeTicks(NOW - minutes * M, NOW, true);
      expect(ticks.length, `${minutes} min`).toBeGreaterThanOrEqual(4);
      expect(ticks.length, `${minutes} min`).toBeLessThanOrEqual(6);
      expect(ticks[0]!.left).toBe(0);
      expect(ticks[ticks.length - 1]!.left).toBe(100);
      expect(ticks[ticks.length - 1]!.label.endsWith(" сейчас")).toBe(true);
      const lefts = ticks.map((tick) => tick.left);
      expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
      const clock = minutes > 1440 ? /^\d\d\.\d\d \d\d:\d\d/ : /^\d\d:\d\d( сейчас)?$/;
      for (const tick of ticks) expect(tick.label).toMatch(clock);
    }
  });
});

describe("recorder window", () => {
  it("asks from the launch, not earlier than 31 days back, for the slug without the archive suffix", () => {
    expect(recorderWindow(NOW - 3600, NOW)).toEqual({ since: NOW - 3600, until: NOW });
    expect(recorderWindow(NOW - 40 * 86400, NOW).since).toBe(NOW - 31 * 86400 + 60);
    expect(logSlug("pr-template-20261105T101500Z")).toBe("pr-template");
    expect(logSlug("pr-template")).toBe("pr-template");
  });
});

describe("telemetry", () => {
  const act = (at: number, text: string, kind: Activity["kind"] = "command"): Activity => ({ at, kind, text });

  it("merges the log and the live activities without repeats, newest first, at most ten", () => {
    const log = [act(NOW - 10, "npm test"), act(NOW - 20, "src/a.ts", "edit")];
    const live = [act(NOW - 1, "git diff"), act(NOW - 10, "npm test"), act(NOW - 10, "npm run build")];
    expect(mergeTelemetry(log, live).map((activity) => activity.text)).toEqual(["git diff", "npm test", "npm run build", "src/a.ts"]);

    const many = Array.from({ length: 14 }, (_, index) => act(NOW - index, `step ${index}`));
    const merged = mergeTelemetry(many.slice(4), many.slice(0, 6));
    expect(merged).toHaveLength(TELEMETRY_LIMIT);
    expect(merged[0]!.text).toBe("step 0");
    expect(merged[9]!.text).toBe("step 9");
  });
});
