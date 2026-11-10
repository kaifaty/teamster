import { describe, expect, it } from "vitest";
import { fixtureSource } from "../fixtures/source";
import type { Lesson, ResearchView, Study, TaskSummary } from "../types";
import { stars } from "./fleet";
import { systemTasks } from "./placement";
import { MAX_PROBES, REFLECTION_TASK, isReflection, plural, research, shortDate } from "./research";

const lesson = (entry: string, status: Lesson["status"]): Lesson => ({
  date: "2026-11-07",
  entry,
  scope: "invariant",
  scope_text: "invariant",
  repos: [],
  cue: `cue of ${entry}`,
  status,
  status_text: status,
});

const view = (patch: Partial<ResearchView> = {}): ResearchView => ({
  lessons: [lesson("a", "applied"), lesson("b", "proposed"), lesson("c", "declined"), lesson("d", "proposed"), lesson("e", "other"), lesson("f", "accepted")],
  studies: [],
  batch: { name: "batch-2026-11-07.md", date: "2026-11-07", through: "20261107T051647Z", records: 9, repos: { alpha: 5, beta: 3, gone: 1 } },
  pending: { records: 4, signals: 2, repos: { beta: 1, alpha: 2 }, items: [] },
  reflection_task: "nightly-reflection",
  ...patch,
});

const session = (slug: string, patch: Partial<TaskSummary> = {}): TaskSummary => ({
  slug,
  kind: "session",
  title: null,
  link: null,
  repo: "(no folder)",
  branch: null,
  task_type: null,
  executor: "claude",
  account: null,
  reviewer: null,
  model: null,
  effort: null,
  column: "review_me",
  phase: "idle",
  phase_started_at: null,
  alive: false,
  turn: 1,
  fix_round: 0,
  outcome: null,
  result_status: null,
  summary: null,
  pr: null,
  ci: null,
  sleeping_until: null,
  created: 1,
  updated_at: 1,
  activity: null,
  scheduled: null,
  check: null, review: null, findings_left: 0, stop: null, left: 0,
  ...patch,
});

const study = (slug: string, patch: Partial<Study> = {}): Study => ({
  slug,
  archived: false,
  mode: "study",
  alive: false,
  outcome: "needs_decision",
  error: null,
  executor: "claude",
  account: null,
  created: 1,
  updated_at: 2,
  records: 4,
  file: null,
  waiting: true,
  messages: [],
  ...patch,
});

describe("isReflection", () => {
  it("takes the scheduled task the server names, else the default one", () => {
    expect(isReflection({ kind: "reflect" }, null)).toBe(true);
    expect(isReflection(session("s", { scheduled: "nightly-reflection" }), view())).toBe(true);
    expect(isReflection(session("s", { scheduled: REFLECTION_TASK }), view())).toBe(false);
    expect(isReflection(session("s", { scheduled: REFLECTION_TASK }), null)).toBe(true);
    expect(isReflection(session("s"), null)).toBe(false);
    expect(isReflection(session("s", { kind: "work", scheduled: REFLECTION_TASK }), null)).toBe(false);
    expect(isReflection({ kind: "session" }, null)).toBe(false);
  });

  it("keeps reflection tasks and legacy sessions out of the fleet", () => {
    const tasks = [
      session("study", { kind: "reflect", repo: "archive", alive: true }),
      session("legacy", { scheduled: "nightly-reflection", repo: "archive" }),
      session("work", { kind: "work", repo: "alpha" }),
    ].filter((task) => !isReflection(task, view()));
    expect(stars(tasks).map((star) => star.repo)).toEqual(["alpha"]);
    expect(systemTasks(tasks, "archive")).toEqual({ shown: [], hidden: [] });
    expect(systemTasks(tasks, "alpha").shown.map((task) => task.slug)).toEqual(["work"]);
  });
});

describe("research", () => {
  it("is null without a view", () => {
    expect(research(null, [], ["alpha"])).toBeNull();
  });

  it("sorts lessons by status, newest first", () => {
    const made = research(view(), [], [])!;
    expect(made.proposed.map((item) => item.entry)).toEqual(["d", "b"]);
    expect(made.accepted.map((item) => item.entry)).toEqual(["f"]);
    expect(made.applied.map((item) => item.entry)).toEqual(["a"]);
    expect(made.declined.map((item) => item.entry)).toEqual(["c"]);
    expect(made.other.map((item) => item.entry)).toEqual(["e"]);
  });

  it("passes the repositories' disk access through, «ok» for a server that does not say", () => {
    expect(research(view(), [], [])!.reposAccess).toBe("ok");
    expect(research(view({ repos_access: "denied" }), [], [])!.reposAccess).toBe("denied");
    expect(research(view({ repos_access: "scanning" }), [], [])!.reposAccess).toBe("scanning");
  });

  it("watches only systems on the map, most records first", () => {
    expect(research(view(), [], ["alpha", "beta"])!.watched).toEqual([
      { repo: "alpha", count: 2 },
      { repo: "beta", count: 1 },
    ]);
    expect(research(view(), [], ["beta"])!.watched).toEqual([{ repo: "beta", count: 1 }]);
  });

  it("flies probes only while a run is alive", () => {
    const idle = research(view(), [session("old", { scheduled: "nightly-reflection", updated_at: 5 })], ["alpha", "beta"])!;
    expect(idle.running).toBe(false);
    expect(idle.run?.slug).toBe("old");
    expect(idle.probes).toEqual([]);

    const tasks = [
      session("old", { scheduled: "nightly-reflection", updated_at: 50 }),
      session("now", { scheduled: "nightly-reflection", alive: true, updated_at: 10 }),
      session("other", { alive: true }),
    ];
    const busy = research(view(), tasks, ["alpha", "beta"])!;
    expect(busy.running).toBe(true);
    expect(busy.run?.slug).toBe("now");
    expect(busy.probes).toEqual(["alpha", "beta"]);
  });

  it("includes study conversations, counts waiting studies and runs without a legacy session", async () => {
    const studies = [study("active", { alive: true, waiting: false }), study("waiting"), study("archived", { archived: true, waiting: false })];
    const active = research(view({ studies }), [], ["alpha", "beta"])!;
    expect(active.studies).toEqual(studies);
    expect(active.waiting).toBe(1);
    expect(active.running).toBe(true);
    expect(active.run).toBeNull();
    expect(active.probes).toEqual(["alpha", "beta"]);

    const idle = research(view({ studies: [study("waiting")] }), [], ["alpha", "beta"])!;
    expect(idle.waiting).toBe(1);
    expect(idle.running).toBe(false);
    expect(idle.probes).toEqual([]);

    const fixture = research(await fixtureSource().fetchResearch(), [], [])!;
    const reports = fixture.studies.find((item) => item.archived)!.messages.filter((message) => message.from === "analyst");
    const checkLesson = {
      id: "U1", scope: "invariant",
      lesson: "A check is useful evidence only if it fails when the guarded behavior is removed.",
      proposal: "Before implementation, run the named check against a deliberately reproduced defect.",
    };
    expect(reports.map((message) => message.lessons)).toMatchObject([
      [checkLesson],
      [checkLesson, { id: "U2", scope: "domain", lesson: "Keep the ml-lab training smoke outside the interactive task turn.", proposal: null }],
    ]);
  });

  it("visits a live study's known batch instead of unrelated pending records", () => {
    const known = study("batch", { alive: true, waiting: false, file: "batch-2026-11-07.md", records: 9 });
    const changed = view({ studies: [known], pending: { records: 9, signals: 1, repos: { beta: 9 }, items: [] } });
    expect(research(changed, [], ["alpha", "beta"])!.probes).toEqual(["alpha", "beta"]);
    changed.studies = [{ ...known, file: "study-2026-11-08.md" }];
    expect(research(changed, [], ["alpha", "beta"])!.probes).toEqual(["beta"]);
  });

  it("sends the probes where the last run read when nothing waits", () => {
    const quiet = view({ pending: { records: 0, signals: 0, repos: {}, items: [] } });
    const tasks = [session("now", { scheduled: "nightly-reflection", alive: true })];
    expect(research(quiet, tasks, ["alpha", "beta"])!.probes).toEqual(["alpha", "beta"]);
  });

  it("sends at most MAX_PROBES probes", () => {
    const repos = Array.from({ length: 10 }, (_, i) => `repo-${i}`);
    const many = view({ pending: { records: 10, signals: 10, repos: Object.fromEntries(repos.map((repo) => [repo, 1])), items: [] } });
    const tasks = [session("now", { scheduled: "nightly-reflection", alive: true })];
    expect(research(many, tasks, repos)!.probes).toHaveLength(MAX_PROBES);
  });
});

describe("shortDate", () => {
  it("shows day and month, and anything else as written", () => {
    expect(shortDate("2026-11-07")).toBe("07.11");
    expect(shortDate("yesterday")).toBe("yesterday");
    expect(shortDate(null)).toBe("—");
  });
});

describe("plural", () => {
  it("picks the Russian form by the last digits", () => {
    const word = (n: number) => plural(n, "запись", "записи", "записей");
    expect([1, 2, 5, 11, 12, 21, 22, 25, 101, 111, 0].map(word)).toEqual([
      "запись", "записи", "записей", "записей", "записей", "запись", "записи", "записей", "запись", "записей", "записей",
    ]);
  });
});

describe("pending repositories", () => {
  it("keeps every repository with material, also one without a star", async () => {
    const made = research(view({ pending: { records: 3, signals: 0, repos: { gone: 2, alpha: 1 }, items: [] } }), [], ["alpha"])!;
    expect(made.pending.repos).toEqual([{ repo: "gone", count: 2 }, { repo: "alpha", count: 1 }]);
    expect(made.watched).toEqual([{ repo: "alpha", count: 1 }]);
  });
});
