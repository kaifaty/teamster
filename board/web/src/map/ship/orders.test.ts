import { describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";
import type { ActionResult } from "../../lib/actions";
import type { Cargo, TaskDetail, TaskLimits, TaskSummary } from "../../types";
import { createShipDesk } from "./desk";
import { blankRefit, deskOf, fallbackCommand, feedOf, isLong, mainOrder, reflectOrder, refitLine, refitOf, toggleAngle, type DeskView } from "./orders";

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

  it("orders messages by time and ends with the last report and its waiting questions", () => {
    const waiting = task({ alive: false, column: "attention", result_status: "needs_decision", summary: "Нужен выбор", updated_at: NOW - 100 });
    const feed = feedOf(waiting, messages, cargo(["Оставить карточку?"]));
    expect(feed.map((item) => [item.who, item.tone, item.text])).toEqual([
      ["Ты · указание", "you", "Сделай экран"],
      ["Инспекция · круг исправления", "sys", "Codex нашёл 2 дефекта"],
      ["Врата · починка CI", "sys", "CI упал"],
      ["Капитан · доклад", "agent", "Нужен выбор"],
      ["Капитан · вопрос", "ask", "Оставить карточку?"],
    ]);
    expect(feed[3]!.note).toBe("ждёт решения");
  });

  it("puts a working ship's report before the message that set off its turn, and its questions no longer wait", () => {
    const working = task({ result_status: "partial", summary: "Частично", phase_started_at: NOW - 500 });
    const feed = feedOf(working, messages, cargo(["Как быть?"]));
    expect(feed.map((item) => item.who)).toEqual(["Ты · указание", "Инспекция · круг исправления", "Капитан · доклад", "Капитан · вопрос", "Врата · починка CI"]);
    expect(feed[3]!.tone).toBe("agent");
  });

  it("shows a sent order until the messages carry it, and folds a long text", () => {
    const echo = [{ at: NOW, text: "Продолжай" }];
    expect(feedOf(task(), [], null, echo).map((item) => [item.who, item.note])).toEqual([["Ты · указание", "передано"]]);
    expect(feedOf(task(), [{ at: NOW + 1, source: "lead", text: "Продолжай\n" }], null, echo)).toHaveLength(1);
    expect(isLong("1\n2\n3\n4")).toBe(false);
    expect(isLong("1\n2\n3\n4\n5")).toBe(true);
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

  it("gives the line «what next» a button only for an order the board carries out", () => {
    expect(mainOrder(task(), NOW)).toBeNull();
    expect(mainOrder(task({ alive: false, column: "review_me" }), NOW)).toEqual({ kind: "verdict", label: "Принять" });
    expect(mainOrder(task({ alive: false, column: "attention", outcome: "stopped" }), NOW)?.kind).toBe("fill");
    expect(mainOrder(task({ alive: false, column: "attention", result_status: "needs_decision", outcome: "needs_decision" }), NOW)).toBeNull();
    expect(mainOrder(task({ kind: "scout", alive: false, column: "attention", outcome: "stopped" }), NOW)).toBeNull();
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

describe("console", () => {
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
