import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../types";
import { MAX_PATCHES, depotEmpty, depotPositions, depots, hullOf, patchSpots, refuelText, stars, supplyLines } from "./fleet";

const NOW = 1_800_000_000;

function task(overrides: Partial<TaskSummary>): TaskSummary {
  return {
    slug: "t", kind: "work", title: null, link: null, repo: "repo", branch: null, task_type: null, executor: "codex",
    account: "personal", reviewer: "claude", model: null, effort: null, column: "running", phase: "turn",
    phase_started_at: NOW, alive: true, turn: 1, fix_round: 0, outcome: "running", result_status: null, summary: null,
    pr: null, ci: null, sleeping_until: null, created: NOW, updated_at: NOW, activity: null,
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

describe("depots", () => {
  it("turns the weekly limit into fuel and marks accounts that give nothing", () => {
    const list = depots(ACCOUNTS, NOW);
    expect(list.map((depot) => [depot.key, depot.fuel, depot.bad])).toEqual([
      ["codex:personal", 59, false],
      ["codex:spent", 0, true],
      ["codex:spare", null, true],
      ["claude:pool-1", 42, false],
      ["claude:pool-2", 10, true],
    ]);
    expect(list.map(depotEmpty)).toEqual([false, true, true, false, true]);
  });

  it("refuels at the end of the limit that ran out, a low depot at the weekly reset, a broken one never", () => {
    const list = depots(ACCOUNTS, NOW);
    expect(list.find((depot) => depot.key === "claude:pool-2")!.refuelAt).toBe(NOW + 1500);
    expect(list.find((depot) => depot.key === "codex:personal")!.refuelAt).toBeNull();
    expect(depots({ claude: [{ name: "p", seven_day: { used_percent: 99, resets_at: NOW + 60 } }] }, NOW)[0]!.refuelAt).toBe(NOW + 60);
    const exhausted = {
      name: "x", status: "exhausted",
      primary: { used_percent: 100, window_minutes: 300, resets_at: NOW + 3600 },
      secondary: { used_percent: 50, window_minutes: 10080, resets_at: NOW + 5 * 86400 },
    };
    expect(depots({ codex: [exhausted] }, NOW)[0]!.refuelAt).toBe(NOW + 3600);
    const tokenless = { name: "p", token_unavailable: true, seven_day: { used_percent: 10, resets_at: NOW + 7200 } };
    expect(depots({ claude: [tokenless] }, NOW)[0]!.refuelAt).toBeNull();
  });

  it("tells when a depot refuels in hours, or in minutes under an hour", () => {
    expect(refuelText(NOW + 1500, NOW)).toBe("заправка через 25 мин");
    expect(refuelText(NOW + 20, NOW)).toBe("заправка через 1 мин");
    expect(refuelText(NOW + 3600, NOW)).toBe("заправка через 1 ч");
    expect(refuelText(NOW + 5 * 3600 + 600, NOW)).toBe("заправка через 5 ч");
    expect(refuelText(NOW - 10, NOW)).toBeNull();
    expect(refuelText(null, NOW)).toBeNull();
  });

  it("is empty without account data", () => {
    expect(depots(null, NOW)).toEqual([]);
    expect(depots("nonsense", NOW)).toEqual([]);
  });

  it("puts Codex on the top edge and Claude on the bottom one", () => {
    const places = depotPositions(depots(ACCOUNTS, NOW), { width: 1600, height: 1000 });
    expect(places.get("codex:personal")!.y).toBeLessThan(places.get("claude:pool-1")!.y);
    expect(places.get("codex:personal")!.x).toBeLessThan(places.get("codex:spent")!.x);
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

describe("supply lines", () => {
  const known = depots(ACCOUNTS, NOW);

  it("joins an account and a repository once and says whether a ship is working there", () => {
    const lines = supplyLines(
      [
        task({ slug: "a", alive: false, column: "attention" }),
        task({ slug: "b" }),
        task({ slug: "c", repo: "other", alive: false, column: "review_me" }),
      ],
      known,
    );
    expect(lines).toEqual([
      { depot: "codex:personal", repo: "repo", active: true },
      { depot: "codex:personal", repo: "other", active: false },
    ]);
  });

  it("skips closed tasks, sessions without an account and unknown accounts", () => {
    const lines = supplyLines(
      [task({ slug: "a", column: "closed" }), task({ slug: "b", account: null }), task({ slug: "c", account: "gone" })],
      known,
    );
    expect(lines).toEqual([]);
  });
});
