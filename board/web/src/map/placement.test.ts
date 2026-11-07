import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../types";
import { MAX_SHIPS, placement, placeOf, systemTasks } from "./placement";

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
    phase_started_at: NOW - 100,
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
    activity: { at: NOW - 5, kind: "command", text: "npm test" },
    ...overrides,
  };
}

describe("placeOf", () => {
  it("sends each phase to its station", () => {
    expect(placeOf(task())).toBe("yard");
    expect(placeOf(task({ phase: "fix" }))).toBe("yard");
    expect(placeOf(task({ phase: "check" }))).toBe("range");
    expect(placeOf(task({ phase: "review" }))).toBe("inspection");
    expect(placeOf(task({ phase: "ci" }))).toBe("gate");
    expect(placeOf(task({ phase: "sleeping" }))).toBe("cryo");
    expect(placeOf(task({ column: "sleeping", phase: "sleeping" }))).toBe("cryo");
    expect(placeOf(task({ column: "review_me", phase: "idle", alive: false }))).toBe("roadstead");
  });

  it("leaves a task in trouble where it stopped and closed tasks off the map", () => {
    expect(placeOf(task({ column: "attention", phase: "idle", alive: false }))).toBe("yard");
    expect(placeOf(task({ column: "attention", phase: "ci", alive: false }))).toBe("gate");
    expect(placeOf(task({ column: "closed" }))).toBeNull();
  });

  it("keeps the lead's sessions at the command station in every state but closed", () => {
    for (const column of ["running", "review_me", "attention"] as const) {
      expect(placeOf(task({ kind: "session", column }))).toBe("command");
    }
    expect(placeOf(task({ kind: "session", column: "closed" }))).toBeNull();
  });
});

describe("placement", () => {
  it("lets a ship circle only while its activity is fresh", () => {
    expect(placement(task(), NOW)).toMatchObject({ action: "work", working: true, stale: false });
    const old = { at: NOW - 61, kind: "command", text: "npm test" } as const;
    expect(placement(task({ activity: old }), NOW)).toMatchObject({ action: "idle", working: false, stale: true });
    expect(placement(task({ activity: null }), NOW)).toMatchObject({ action: "idle", stale: true });
    expect(placement(task({ alive: false }), NOW)).toMatchObject({ action: "idle", working: false });
  });

  it("marks a fix round, fresh or not", () => {
    expect(placement(task({ phase: "fix" }), NOW)).toMatchObject({ action: "work", fixing: true });
    expect(placement(task({ phase: "fix", activity: null }), NOW)).toMatchObject({ action: "idle", fixing: true });
  });

  it("shows the station working for a live task and names the inspector", () => {
    expect(placement(task({ phase: "check" }), NOW)).toMatchObject({ action: "wait", placeWorking: true });
    expect(placement(task({ phase: "ci" }), NOW)).toMatchObject({ action: "wait", placeWorking: true });
    expect(placement(task({ phase: "ci", alive: false }), NOW)).toMatchObject({ placeWorking: false });
    expect(placement(task({ phase: "review" }), NOW)).toMatchObject({ action: "wait", companion: "claude" });
  });

  it("raises the beacon for attention, wherever the ship stopped", () => {
    expect(placement(task({ column: "attention", phase: "check", alive: false }), NOW)).toMatchObject({
      place: "range", action: "idle", beacon: true, placeWorking: false,
    });
  });

  it("gives sleeping and ready ships their own action", () => {
    expect(placement(task({ column: "sleeping", phase: "sleeping" }), NOW)).toMatchObject({ action: "sleep" });
    expect(placement(task({ column: "review_me", phase: "idle", alive: false }), NOW)).toMatchObject({ action: "ready" });
  });

  it("numbers the ships of a station by arrival", () => {
    const first = task({ slug: "first", phase: "check", phase_started_at: NOW - 50 });
    const second = task({ slug: "second", phase: "check", phase_started_at: NOW - 10 });
    const elsewhere = task({ slug: "elsewhere" });
    const peers = [second, elsewhere, first];
    expect(placement(first, NOW, peers)!.slot).toBe(0);
    expect(placement(second, NOW, peers)!.slot).toBe(1);
    expect(placement(elsewhere, NOW, peers)!.slot).toBe(0);
  });

  it("is null for a closed task", () => {
    expect(placement(task({ column: "closed" }), NOW)).toBeNull();
  });
});

describe("systemTasks", () => {
  it("shows the live ships of one repository, oldest first", () => {
    const tasks = [
      task({ slug: "new", created: NOW }),
      task({ slug: "old", created: NOW - 500 }),
      task({ slug: "closed", column: "closed" }),
      task({ slug: "other", repo: "other" }),
    ];
    const { shown, hidden } = systemTasks(tasks, "repo");
    expect(shown.map((item) => item.slug)).toEqual(["old", "new"]);
    expect(hidden).toEqual([]);
  });

  it("hides the quietest ships past the limit and keeps running ones", () => {
    const quiet = Array.from({ length: MAX_SHIPS }, (_, i) => task({ slug: `q${i}`, column: "review_me", alive: false }));
    const { shown, hidden } = systemTasks([...quiet, task({ slug: "running" })], "repo");
    expect(shown).toHaveLength(MAX_SHIPS);
    expect(hidden).toHaveLength(1);
    expect(shown.some((item) => item.slug === "running")).toBe(true);
  });
});
