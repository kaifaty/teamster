import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../types";
import { depotPositions, depots, stars, supplyLines } from "./fleet";

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
  claude: [{ name: "pool-1", seven_day: { used_percent: 58 } }],
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
    ]);
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
