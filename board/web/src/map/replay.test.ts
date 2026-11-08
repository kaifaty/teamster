import { describe, expect, it } from "vitest";
import { FIXTURE_EVENTS, demoEvents, logEvent } from "../fixtures/events";
import type { LogEvent, TaskSummary } from "../types";
import { isFresh, placement } from "./placement";
import { SCENARIO_HISTORY } from "./scenario";
import { REPLAY_QUIET_SECONDS, replayDepartures, replayFleet, replayMarks, replayWindow } from "./replay";

const T = 1_800_000_000;
const base = { slug: "ship", repo: "demo", kind: "work" as const, provider: "claude", turn: 1 };
const ev = (fields: Partial<LogEvent> & { at: number }): LogEvent => logEvent({ ...base, ...fields }, fields.at);

/** One full voyage: work, check, review, a fix, the turn's row with CI, and a verdict. */
const VOYAGE: LogEvent[] = [
  ev({ phase: "work", started: T, at: T + 600, outcome: "completed", account: "pool-1" }),
  ev({ phase: "check", started: T + 600, at: T + 700, outcome: "passed" }),
  ev({ kind: "review", phase: "review", started: T + 750, at: T + 900, outcome: "completed", findings: 1, reviewer: "codex", provider: "codex" }),
  ev({ phase: "fix", started: T + 900, at: T + 1000, round: 1, outcome: "completed" }),
  ev({ phase: "base_check", started: T + 1000, at: T + 1100, outcome: "passed" }),
  ev({ phase: "turn", started: T, at: T + 1500, outcome: "done", result_status: "done", ci: "passed" }),
  ev({ kind: "verdict", at: T + 3000, verdict: "accepted" }),
];

const at = (events: LogEvent[], t: number, live: TaskSummary[] = []) => replayFleet(events, t, live).find((task) => task.slug === "ship");

describe("replayFleet", () => {
  it("puts a ship in a running phase at its station, working", () => {
    const cases: [number, string, string][] = [
      [T + 300, "turn", "yard"],
      [T + 650, "check", "range"],
      [T + 800, "review", "inspection"],
      [T + 950, "fix", "yard"],
      [T + 1050, "check", "range"],
    ];
    for (const [t, phase, place] of cases) {
      const task = at(VOYAGE, t)!;
      expect([task.column, task.phase, task.alive, isFresh(task, t)], `${t - T}`).toEqual(["running", phase, true, true]);
      expect(placement(task, t)!.place).toBe(place);
    }
    expect(at(VOYAGE, T + 800)!.reviewer).toBe("codex");
    expect(at(VOYAGE, T + 950)!.fix_round).toBe(1);
    const scout = ev({ kind: "scout", phase: "scout", started: T, at: T + 60 });
    const wrapup = ev({ phase: "wrapup", started: T, at: T + 60 });
    expect(at([scout], T + 30)!.phase).toBe("turn");
    expect(at([scout], T + 30)!.kind).toBe("scout");
    expect(at([wrapup], T + 30)!.phase).toBe("turn");
  });

  it("keeps a ship where its last phase ended, still and alive, until two quiet hours pass", () => {
    const check = [ev({ phase: "check", started: T, at: T + 100, outcome: "passed" })];
    for (const t of [T + 101, T + 100 + REPLAY_QUIET_SECONDS]) {
      const task = at(check, t)!;
      expect([task.alive, task.phase, isFresh(task, t), placement(task, t)!.place]).toEqual([true, "check", false, "range"]);
    }
    expect(at(check, T + 101 + REPLAY_QUIET_SECONDS)).toBeUndefined();
    // Inside a turn, between its phases, and at the gate after the last one when the turn had CI.
    const between = at(VOYAGE, T + 720)!;
    expect([between.phase, between.alive]).toEqual(["check", true]);
    const gate = at(VOYAGE, T + 1200)!;
    expect([gate.phase, gate.alive, placement(gate, T + 1200)!.place]).toEqual(["ci", true, "gate"]);
  });

  it("sends a done turn to the roadstead and a failed one to attention", () => {
    const ready = at(VOYAGE, T + 1600)!;
    expect([ready.column, ready.alive, placement(ready, T + 1600)!.place]).toEqual(["review_me", false, "roadstead"]);
    const turn = (outcome: string | null, result_status: string | null) =>
      at([ev({ phase: "turn", started: T, at: T + 100, outcome, result_status })], T + 200)!.column;
    for (const outcome of ["failed", "stuck", "stopped", "budget_exhausted", "conflict"]) expect(turn(outcome, "done"), outcome).toBe("attention");
    for (const status of ["partial", "needs_decision", "blocked"]) expect(turn("done", status), status).toBe("attention");
    expect(turn("done", "done")).toBe("review_me");
    expect(placement(at([ev({ phase: "turn", started: T, at: T + 100, outcome: "failed" })], T + 200)!, T + 200)!.beacon).toBe(true);
  });

  it("damages a ship after a failed CI and mends it after a passed one", () => {
    const failed = ev({ phase: "turn", started: T, at: T + 100, outcome: "done", result_status: "done", ci: "failed" });
    const work = ev({ phase: "work", turn: 2, started: T + 200, at: T + 400 });
    const passed = ev({ phase: "turn", turn: 2, started: T + 200, at: T + 500, outcome: "done", result_status: "done", ci: "passed" });
    expect(at([failed, work, passed], T + 150)!.ci).toBe("failed");
    const back = at([failed, work, passed], T + 300)!;
    expect([back.ci, placement(back, T + 300)!.place]).toEqual(["failed", "yard"]);
    expect(at([failed, work, passed], T + 600)!.ci).toBe("passed");
  });

  it("takes a ship off the map after a verdict, into the sun only when accepted or revised", () => {
    expect(at(VOYAGE, T + 3000)).toBeUndefined();
    expect(replayDepartures(VOYAGE, T + 3000).get("ship")).toBe("dive");
    expect(replayDepartures(VOYAGE, T + 2000).has("ship")).toBe(false);
    for (const verdict of ["revised", "redone", "dropped"]) {
      const list = [...VOYAGE.slice(0, -1), ev({ kind: "verdict", at: T + 3000, verdict })];
      expect(replayDepartures(list, T + 3001).get("ship"), verdict).toBe(verdict === "revised" ? "dive" : "fade");
    }
    // A task sent back for more work comes back with its next turn.
    const redone = [...VOYAGE.slice(0, -1), ev({ kind: "verdict", at: T + 3000, verdict: "redone" }), ev({ phase: "work", turn: 2, started: T + 3600, at: T + 4000 })];
    expect(at(redone, T + 3300)).toBeUndefined();
    expect(at(redone, T + 3700)!.phase).toBe("turn");
  });

  it("drops a ready ship after two quiet hours without a verdict", () => {
    const list = VOYAGE.slice(0, -1);
    expect(at(list, T + 1500 + REPLAY_QUIET_SECONDS)!.column).toBe("review_me");
    expect(at(list, T + 1501 + REPLAY_QUIET_SECONDS)).toBeUndefined();
    expect(at(list, T - 1)).toBeUndefined();
  });

  it("takes the family from the provider, model and effort from the live task, and needs a slug and a repository", () => {
    const task = at(VOYAGE, T + 800)!;
    expect([task.executor, task.repo, task.model, task.effort, task.account]).toEqual(["claude", "demo", null, null, "pool-1"]);
    const live = { ...task, executor: "codex", model: "claude-opus-5-5", effort: "high" } as TaskSummary;
    const lent = at(VOYAGE, T + 800, [live])!;
    expect([lent.executor, lent.model, lent.effort]).toEqual(["claude", "claude-opus-5-5", "high"]);
    expect(at([ev({ phase: "work", provider: "codex", started: T, at: T + 60 })], T + 30)!.executor).toBe("codex");
    const orphans = [ev({ phase: "work", repo: null, started: T, at: T + 60 }), ev({ phase: "work", slug: null, started: T, at: T + 60 })];
    expect(replayFleet(orphans, T + 30)).toEqual([]);
  });
});

describe("replay scale", () => {
  it("marks the verdicts and the CI failures of the window", () => {
    const marks = replayMarks([ev({ phase: "turn", at: T + 2000, ci: "failed" }), VOYAGE[6]!], { since: T, until: T + 4000 });
    expect(marks.map((mark) => [mark.kind, mark.share])).toEqual([["ci", 0.5], ["sun", 0.75]]);
  });

  it("covers the last day or a local calendar day, never past now", () => {
    expect(replayWindow("", T)).toEqual({ since: T - 86400, until: T });
    const day = replayWindow("2027-01-14", T);
    expect(new Date(day.since * 1000).getHours()).toBe(0);
    expect(day.until - day.since).toBe(86400);
  });
});

describe("demo history", () => {
  const sources = { fixtures: FIXTURE_EVENTS, scenario: SCENARIO_HISTORY };
  for (const [name, list] of Object.entries(sources)) {
    it(`${name}: a ship reaches the sun, one fails at the gate and goes back to the yard, one needs attention`, () => {
      const now = T;
      const { events } = demoEvents(list, now, now - 26 * 3600, now);
      const tracks = new Map<string, string[]>();
      for (let t = now - 24 * 3600; t <= now; t += 60) {
        const fleet = replayFleet(events, t);
        for (const task of fleet) {
          const where = placement(task, t, fleet)!;
          const mark = `${where.place}${task.ci === "failed" ? "/damaged" : ""}${task.column === "attention" ? "/attention" : ""}`;
          const track = tracks.get(task.slug) ?? [];
          if (track[track.length - 1] !== mark) track.push(mark);
          tracks.set(task.slug, track);
        }
        for (const [slug, how] of replayDepartures(events, t)) {
          const track = tracks.get(slug);
          if (track && how === "dive" && track[track.length - 1] === "roadstead") track.push("sun");
        }
      }
      const all = [...tracks.values()].map((track) => track.join(" "));
      expect(all.some((track) => /yard.* range.* inspection.* gate.* roadstead sun/.test(track)), all.join("\n")).toBe(true);
      expect(all.some((track) => /gate yard\/damaged/.test(track)), all.join("\n")).toBe(true);
      expect(all.some((track) => track.includes("/attention")), all.join("\n")).toBe(true);
    });
  }
});
