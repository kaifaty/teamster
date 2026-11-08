import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../types";
import { DAY_LAMPS, MAX_PATCHES, daysLeft, hullOf, patchSpots, stars, tankEmpty, tanks, untilText } from "./fleet";

const NOW = 1_800_000_000;

function task(overrides: Partial<TaskSummary>): TaskSummary {
  return {
    slug: "t", kind: "work", title: null, link: null, repo: "repo", branch: null, task_type: null, executor: "codex",
    account: "personal", reviewer: "claude", model: null, effort: null, column: "running", phase: "turn",
    phase_started_at: NOW, alive: true, turn: 1, fix_round: 0, outcome: "running", result_status: null, summary: null,
    pr: null, ci: null, sleeping_until: null, created: NOW, updated_at: NOW, activity: null, check: null, review: null, findings_left: 0, stop: null, left: 0,
    ...overrides,
  };
}

const ACCOUNTS = {
  codex: [
    { name: "personal", status: "available", secondary: { used_percent: 41, window_minutes: 10080 } },
    { name: "spent", status: "exhausted", secondary: { used_percent: 100, window_minutes: 10080 } },
    { name: "spare", status: "not_logged_in" },
  ],
  claude: [
    { name: "pool-1", seven_day: { used_percent: 58 } },
    { name: "pool-2", seven_day: { used_percent: 90, resets_at: NOW + 7200 }, limited_until: NOW + 1500 },
  ],
};

describe("stars", () => {
  it("counts ships and keeps a repository whose tasks are all closed as a quiet star", () => {
    const list = stars([
      task({ slug: "a", repo: "b-repo" }),
      task({ slug: "b", repo: "b-repo", column: "attention", alive: false }),
      task({ slug: "c", repo: "b-repo", column: "review_me", alive: false }),
      task({ slug: "d", repo: "b-repo", column: "sleeping", executor: "claude" }),
      task({ slug: "e", repo: "a-repo", column: "closed" }),
    ]);
    expect(list.map((star) => star.repo)).toEqual(["a-repo", "b-repo"]);
    expect(list[0]).toMatchObject({ live: 0, dots: [] });
    expect(list[1]).toMatchObject({ live: 4, attention: 1, ready: 1, sleeping: 1 });
    expect(list[1]!.dots.map((dot) => dot.state)).toEqual(["work", "attention", "ready", "sleep"]);
  });
});

describe("tanks", () => {
  it("turns the weekly limit into fuel and marks accounts that give nothing", () => {
    const list = tanks(ACCOUNTS, NOW);
    expect(list.map((tank) => [tank.key, tank.fuel, tank.bad])).toEqual([
      ["codex:personal", 59, false],
      ["codex:spent", 0, true],
      ["codex:spare", null, true],
      ["claude:pool-1", 42, false],
      ["claude:pool-2", 10, true],
    ]);
    expect(list.map(tankEmpty)).toEqual([false, true, true, false, true]);
  });

  it("refills at the end of the limit that ran out, at the weekly reset otherwise, and never without a login or a token", () => {
    const list = tanks(ACCOUNTS, NOW);
    expect(list.find((tank) => tank.key === "claude:pool-2")!.refillAt).toBe(NOW + 1500);
    expect(list.find((tank) => tank.key === "codex:personal")!.refillAt).toBeNull();
    expect(tanks({ claude: [{ name: "p", seven_day: { used_percent: 9, resets_at: NOW + 60 } }] }, NOW)[0]!.refillAt).toBe(NOW + 60);
    const exhausted = {
      name: "x", status: "exhausted",
      primary: { used_percent: 100, window_minutes: 300, resets_at: NOW + 3600 },
      secondary: { used_percent: 50, window_minutes: 10080, resets_at: NOW + 5 * 86400 },
    };
    expect(tanks({ codex: [exhausted] }, NOW)[0]!.refillAt).toBe(NOW + 3600);
    const tokenless = { name: "p", token_unavailable: true, seven_day: { used_percent: 10, resets_at: NOW + 7200 } };
    expect(tanks({ claude: [tokenless] }, NOW)[0]!.refillAt).toBeNull();
  });

  it("carries the free resets, the five-hour window and the admiral", () => {
    const data = {
      codex: [{
        name: "main", status: "available",
        primary: { used_percent: 30, window_minutes: 300, resets_at: NOW + 3600 },
        secondary: { used_percent: 10, window_minutes: 10080, resets_at: NOW + 3 * 86400 },
        reset_credits: { available_count: 2, expires_at: [new Date((NOW + 2 * 86400) * 1000).toISOString(), NOW + 86400] },
      }],
      claude: [{ name: "pool", five_hour: { used_percent: 12.5, resets_at: NOW + 600 } }],
      duty: { account: "pool", family: "claude" },
    };
    const [main, pool] = tanks(data, NOW);
    expect(main!.resets).toEqual({ count: 2, expires: [NOW + 86400, NOW + 2 * 86400] });
    expect(main!.burst).toEqual({ percent: 30, resetsAt: NOW + 3600 });
    expect(main!.admiral).toBe(false);
    expect(pool!.resets).toBeNull();
    expect(pool!.burst).toEqual({ percent: 12.5, resetsAt: NOW + 600 });
    expect(pool!.admiral).toBe(true);
  });

  it("tells how long until a refill in minutes, hours or days", () => {
    expect(untilText(NOW + 1500, NOW)).toBe("25 мин");
    expect(untilText(NOW + 20, NOW)).toBe("1 мин");
    expect(untilText(NOW + 3600, NOW)).toBe("1 ч");
    expect(untilText(NOW + 30 * 3600, NOW)).toBe("30 ч");
    expect(untilText(NOW + 4 * 86400 + 3600, NOW)).toBe("4 д");
    expect(untilText(NOW - 10, NOW)).toBeNull();
    expect(untilText(null, NOW)).toBeNull();
  });

  it("lights a lamp for every day left until the refill, up to a week", () => {
    expect(daysLeft(NOW + 3600, NOW)).toBe(1);
    expect(daysLeft(NOW + 86400 + 1, NOW)).toBe(2);
    expect(daysLeft(NOW + 30 * 86400, NOW)).toBe(DAY_LAMPS);
    expect(daysLeft(NOW - 1, NOW)).toBe(0);
    expect(daysLeft(null, NOW)).toBe(0);
  });

  it("is empty without account data", () => {
    expect(tanks(null, NOW)).toEqual([]);
    expect(tanks("nonsense", NOW)).toEqual([]);
  });
});

describe("ships", () => {
  it("picks the hull by effort and leaves scouts and flagships as they are", () => {
    const hull = (effort: string | null, kind: TaskSummary["kind"] = "work") => hullOf({ kind, effort });
    expect([null, "low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => hull(effort))).toEqual([
      "light", "light", "light", "frigate", "cruiser", "cruiser", "cruiser",
    ]);
    expect(hull("high", "review")).toBe("frigate");
    expect(hull("max", "scout")).toBe("scout");
    expect(hull("max", "session")).toBe("flagship");
  });

  it("gives one patch per fix round, at most three, always at the same distinct spots", () => {
    expect(patchSpots("a", 0)).toEqual([]);
    expect(patchSpots("a", 2)).toHaveLength(2);
    expect(patchSpots("a", 9)).toHaveLength(MAX_PATCHES);
    expect(patchSpots("a", 3).slice(0, 2)).toEqual(patchSpots("a", 2));
    const spots = patchSpots("a", 3).map(({ x, y }) => `${x},${y}`);
    expect(new Set(spots).size).toBe(3);
  });
});
