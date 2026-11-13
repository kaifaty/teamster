import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import type { ActionResult } from "../../lib/actions";
import { FAILING_ENTRY, IMPLEMENT_MS, STAGE_MS, TURN_MS, fixtureResearch } from "../../fixtures/research";
import { fixtureSource } from "../../fixtures/source";
import type { Implementation, Launch, Lesson, ResearchActions, ResearchView, ServerMessage, TaskSummary } from "../../types";
import { research } from "../research";
import { discussOrder, docketParts, implementationLine, isSendKey } from "../station";
import { createConsole, HOLD_MS, type Deck } from "./console";
import { IMPLEMENT_OFF } from "./implement";
import { lessonBadge, launchSteps, mergeLaunches, settlePending, stepTime, withDecisions, type PendingStudy } from "./launch";

const NOW = Date.UTC(2026, 10, 9, 4, 12) / 1000;
const T1 = "batch-2026-11-05.md T1"; // proposed, filed by no study
const U1 = "batch-2026-11-06.md U1"; // accepted
const L1 = "study-2026-11-07.md L1"; // proposed, filed by a study that waits for an answer
const U2 = "batch-2026-11-06.md U2"; // proposed, domain ml-lab, which the board does not know
const U4 = "batch-2026-11-06.md U4"; // accepted, its agent needs a decision
const U5 = "batch-2026-11-06.md U5"; // accepted, its agent opened a PR

function setup(actions: ResearchActions | null = { enabled: true, reason: null }) {
  const view = fixtureResearch(NOW);
  if (actions) view.actions = actions;
  else delete view.actions;
  const station = ref(research(view, [], [])!);
  const update = (change: (view: ResearchView) => void) => {
    change(view);
    station.value = research(view, [], [])!;
  };
  let answer: ActionResult = { ok: true, output: "" };
  const act = vi.fn(async (_route: string, _body: unknown): Promise<ActionResult> => answer);
  const copied: string[] = [];
  const jumps: Deck[] = [];
  const ships: [string, string][] = [];
  const launches = ref<Launch[]>([]);
  const tasks = ref<Record<string, TaskSummary>>({});
  const desk = createConsole(station, ref(NOW), {
    act: act as never,
    copy: async (text) => (copied.push(text), true),
    jump: (deck) => jumps.push(deck),
    openShip: (slug, repo) => ships.push([slug, repo]),
    launches,
    tasks,
  });
  const lesson = (entry: string) => [...station.value.proposed, ...station.value.accepted].find((item) => item.entry === entry)!;
  const study = (slug: string) => station.value.studies.find((item) => item.slug === slug)!;
  return { view, station, update, act, copied, jumps, ships, launches, tasks, desk, lesson, study, answer: (next: ActionResult) => (answer = next) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a lesson's card", () => {
  it("accepts at once, keeps the lesson on its tab for a while and takes it back with «Отменить»", async () => {
    vi.useFakeTimers();
    const { desk, act, lesson, update } = setup();
    const t1 = lesson(T1);
    await desk.accept(t1);
    expect(act).toHaveBeenCalledWith("lesson", { entry: T1, status: "accepted" });
    expect(desk.cardOf(t1)).toMatchObject({ busy: null, error: "", done: { status: "accepted", undo: "proposed" } });

    update((view) => (view.lessons.find((item) => item.entry === T1)!.status = "accepted"));
    expect(desk.labStage.value).toBe("proposed");
    expect(desk.shown.value.map((item) => item.entry)).toContain(T1);

    // «Отменить» puts the lesson back on its tab at once, before the research says so.
    await desk.undo(t1);
    expect(act).toHaveBeenLastCalledWith("lesson", { entry: T1, status: "proposed" });
    expect(desk.cardOf(t1).done).toBeNull();
    expect(desk.index.value.get(T1)?.status).toBe("proposed");
    update((view) => (view.lessons.find((item) => item.entry === T1)!.status = "proposed"));

    await desk.accept(t1);
    vi.advanceTimersByTime(HOLD_MS);
    expect(desk.cardOf(t1).done).toBeNull();
    expect(desk.shown.value.map((item) => item.entry)).not.toContain(T1);
    update((view) => (view.lessons.find((item) => item.entry === T1)!.status = "accepted"));

    // The refresh inside the action already moved the lesson: it keeps its place on the tab anyway.
    const U2 = "batch-2026-11-06.md U2";
    const before = desk.shown.value.map((item) => item.entry);
    act.mockImplementationOnce(async () => {
      update((view) => (view.lessons.find((item) => item.entry === U2)!.status = "accepted"));
      return { ok: true, output: "" };
    });
    await desk.accept(lesson(U2));
    expect(desk.shown.value.map((item) => item.entry)).toEqual(before);
    desk.dispose();
  });

  it("declines with a reason or without one", async () => {
    const { desk, act, lesson } = setup();
    const t1 = lesson(T1);
    desk.openForm(t1, "decline");
    desk.setNote(t1, "  one incident ");
    await desk.decline(t1);
    expect(act).toHaveBeenLastCalledWith("lesson", { entry: T1, status: "declined", note: "one incident" });
    expect(desk.cardOf(t1)).toMatchObject({ form: null, done: { status: "declined", undo: "proposed" } });

    const l1 = lesson(L1);
    desk.openForm(l1, "decline");
    await desk.decline(l1);
    expect(act).toHaveBeenLastCalledWith("lesson", { entry: L1, status: "declined" });
    desk.dispose();
  });

  it("keeps the tab when the last lesson to decide is declined", async () => {
    const { desk, act, lesson, update } = setup();
    update((view) => view.lessons.forEach((item) => item.entry !== T1 && item.status === "proposed" && (item.status = "accepted")));
    const t1 = lesson(T1);
    // The refresh inside the action moves the lesson, and the watchers run before the card holds it.
    act.mockImplementationOnce(async () => {
      update((view) => (view.lessons.find((item) => item.entry === T1)!.status = "declined"));
      await nextTick();
      return { ok: true, output: "" };
    });
    desk.openForm(t1, "decline");
    await desk.decline(t1);
    await nextTick();
    expect(desk.labStage.value).toBe("proposed");
    expect(desk.shown.value.map((item) => item.entry)).toEqual([T1]);
    desk.dispose();
  });

  it("marks an accepted lesson applied, and «Отменить» takes it back to accepted", async () => {
    const { desk, act, lesson } = setup();
    const u1 = lesson(U1);
    desk.openForm(u1, "apply");
    desk.setNote(u1, "PR #31");
    await desk.apply(u1);
    expect(act).toHaveBeenLastCalledWith("lesson", { entry: U1, status: "applied", note: "PR #31" });
    await desk.undo(u1);
    expect(act).toHaveBeenLastCalledWith("lesson", { entry: U1, status: "accepted" });
    desk.dispose();
  });

  it("shows the decision at once while the request is in flight, and takes it back with the server's error", async () => {
    const { desk, act, lesson } = setup();
    const t1 = lesson(T1);
    let finish: (result: ActionResult) => void = () => {};
    act.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    desk.openForm(t1, "decline");
    desk.setNote(t1, "one incident");
    const pending = desk.decline(t1);
    expect(desk.cardOf(t1)).toMatchObject({ busy: "decline", form: null, done: { status: "declined", undo: "proposed" } });
    expect(desk.index.value.get(T1)).toMatchObject({ status: "declined", status_text: "declined: one incident" });
    expect(desk.listOf("declined").map((item) => item.entry)).toContain(T1);
    expect(desk.listOf("proposed").map((item) => item.entry)).not.toContain(T1);
    expect(desk.view.value.proposed.map((item) => item.entry)).not.toContain(T1);
    // The row stays on its tab, held for «Отменить».
    expect(desk.shown.value.map((item) => item.entry)).toContain(T1);
    expect(desk.isHeld(desk.index.value.get(T1)!)).toBe(true);
    await desk.accept(t1);
    expect(act).toHaveBeenCalledTimes(1);
    finish({ ok: false, error: "unknown lesson batch-2026-11-05.md T1" });
    await pending;
    expect(desk.cardOf(t1)).toMatchObject({ busy: null, done: null, form: "decline", note: "one incident", error: "unknown lesson batch-2026-11-05.md T1" });
    expect(desk.index.value.get(T1)?.status).toBe("proposed");
    expect(desk.isHeld(t1)).toBe(false);
    desk.dispose();
  });
});

describe("«Внедрить»", () => {
  it("starts the task in the picked repository, and the proposed lesson leaves its tab a moment later", async () => {
    vi.useFakeTimers();
    const { desk, act, lesson, update } = setup();
    const t1 = lesson(T1);
    expect(desk.offersImplement(t1)).toBe(true);
    desk.openForm(t1, "implement");
    expect(desk.cardOf(t1)).toMatchObject({ form: "implement", repo: "/Users/demo/dev/teamster" });
    desk.setRepo(t1, "/Users/demo/dev/demo-vault");
    desk.setNote(t1, " only the supervisor ");
    // The refresh inside the action already moved the lesson to «к внедрению».
    act.mockImplementationOnce(async () => {
      update((view) => (view.lessons.find((item) => item.entry === T1)!.status = "accepted"));
      return { ok: true, output: "", slug: "lesson-t1" };
    });
    await desk.implement(t1, "proposed");
    expect(act).toHaveBeenCalledWith("implement", { entry: T1, repo: "/Users/demo/dev/demo-vault", note: "only the supervisor" });
    expect(desk.cardOf(t1)).toMatchObject({ busy: null, form: null, error: "", started: { slug: "lesson-t1", repo: "demo-vault" } });
    expect(desk.offersImplement(lesson(T1))).toBe(false);
    expect(desk.labStage.value).toBe("proposed");
    expect(desk.shown.value.map((item) => item.entry)).toContain(T1);
    vi.advanceTimersByTime(HOLD_MS);
    expect(desk.shown.value.map((item) => item.entry)).not.toContain(T1);
    desk.dispose();
  });

  it("closes the form and shows the request with its first step at once, then follows the server's start", async () => {
    const { desk, act, lesson, update, launches, tasks } = setup();
    const t1 = lesson(T1);
    let finish: (result: ActionResult) => void = () => {};
    act.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    desk.openForm(t1, "implement");
    desk.setNote(t1, "only the supervisor");
    const started = desk.implement(t1, "proposed");
    expect(desk.cardOf(t1).form).toBeNull();
    expect(desk.requestOf(t1)).toMatchObject({ repo: "teamster", note: "only the supervisor", sending: true });
    expect(desk.launchOf(t1)).toMatchObject({ kind: "implement", stage: "accepting" });
    expect(desk.badgeOf(t1)).toBe("запускается");
    expect(desk.offersImplement(t1)).toBe(false);

    const launch: Launch = {
      slug: "lesson-t1", kind: "implement", entry: T1, repo: "teamster", stage: "accepting", steps: [{ stage: "accepting", at: NOW }], error: null, started_at: NOW,
    };
    finish({ ok: true, output: "", slug: "lesson-t1", launch });
    await started;
    expect(desk.cardOf(t1).started).toBeNull();
    expect(desk.launchOf(t1)).toEqual(launch);
    // The `launch` messages move it on; the research shows the task once its agent started.
    launches.value = [{ ...launch, stage: "worktree", steps: [...launch.steps, { stage: "fetching", at: NOW + 1 }, { stage: "worktree", at: NOW + 3 }] }];
    expect(desk.launchOf(t1)?.stage).toBe("worktree");
    expect(desk.badgeOf(t1)).toBe("запускается");
    const task: Implementation = { slug: "lesson-t1", archived: false, alive: true, repo: "teamster", result_status: null, pr: null, questions: [], summary: null, created: NOW, updated_at: NOW };
    update((view) => Object.assign(view.lessons.find((item) => item.entry === T1)!, { status: "accepted", implementation: task }));
    launches.value = [{ ...launches.value[0]!, stage: "done", steps: [...launches.value[0]!.steps, { stage: "starting", at: NOW + 4 }, { stage: "done", at: NOW + 6 }] }];
    expect(desk.badgeOf(lesson(T1))).toBe("агент работает");
    // While the agent works: the task's phase in plain words and its last action, live from the board.
    expect(desk.workOf(lesson(T1))).toEqual({ phase: "Работа", activity: null });
    tasks.value = { "lesson-t1": { slug: "lesson-t1", alive: true, phase: "check", activity: { at: NOW, kind: "command", text: "npm test" } } as TaskSummary };
    expect(desk.workOf(lesson(T1))).toEqual({ phase: "Проверка", activity: "npm test" });
    desk.dispose();
  });

  it("brings the form back with what was typed on the server's refusal, and «Запустить снова» after a failed start", async () => {
    const { desk, lesson, answer, launches } = setup();
    const u1 = lesson(U1);
    desk.openForm(u1, "implement");
    desk.setRepo(u1, "/Users/demo/dev/demo-vault");
    desk.setNote(u1, "keep it small");
    answer({ ok: false, error: "Урок уже запускается: lesson-u1" });
    await desk.implement(u1, "accepted");
    expect(desk.cardOf(u1)).toMatchObject({ form: "implement", repo: "/Users/demo/dev/demo-vault", note: "keep it small", error: "Урок уже запускается: lesson-u1" });
    expect(desk.requestOf(u1)).toBeNull();

    const launch: Launch = {
      slug: "lesson-u1", kind: "implement", entry: U1, repo: "demo-vault", stage: "fetching", steps: [{ stage: "fetching", at: NOW }], error: null, started_at: NOW,
    };
    answer({ ok: true, output: "", slug: "lesson-u1", launch });
    await desk.implement(u1, "accepted");
    launches.value = [{ ...launch, stage: "failed", error: "git worktree add failed", steps: [...launch.steps, { stage: "worktree", at: NOW + 2 }, { stage: "failed", at: NOW + 3 }] }];
    expect(desk.badgeOf(u1)).toBe("не запустился");
    expect(desk.offersImplement(u1)).toBe(true);
    desk.retry(u1);
    expect(desk.cardOf(u1)).toMatchObject({ form: "implement", repo: "/Users/demo/dev/demo-vault" });
  });

  it("waits for a repository, and shows the server's refusal on the card", async () => {
    const { desk, act, lesson, answer } = setup();
    const u2 = lesson(U2);
    desk.openForm(u2, "implement");
    expect(desk.cardOf(u2).repo).toBe("");
    await desk.implement(u2, "proposed");
    expect(act).not.toHaveBeenCalled();
    desk.setRepo(u2, "/Users/demo/dev/demo-game");
    answer({ ok: false, error: "lesson is already being implemented" });
    await desk.implement(u2, "proposed");
    expect(act).toHaveBeenCalledWith("implement", { entry: U2, repo: "/Users/demo/dev/demo-game" });
    expect(desk.cardOf(u2)).toMatchObject({ busy: null, form: "implement", error: "lesson is already being implemented", started: null });
  });

  it("leaves the docket its quick buttons only: the implementation is followed in the lesson's thread", async () => {
    const { desk, lesson, update, answer } = setup();
    const l1 = lesson(L1);
    const docket = () => {
      const shown = desk.index.value.get(L1)!;
      return docketParts(shown, desk.cardOf(shown), { offers: desk.offersImplement(shown), goes: desk.startGoes(shown) });
    };
    expect(docket()).toEqual({ decide: true, implement: true });
    // «Внедрить» on the docket opens the lesson with the start's form.
    await desk.showLesson(l1, "implement");
    expect(desk.openLesson.value?.entry).toBe(L1);
    expect(desk.cardOf(l1).form).toBe("implement");
    answer({ ok: true, output: "", slug: "lesson-l1" });
    await desk.implement(l1, "proposed");
    expect(docket()).toEqual({ decide: false, implement: false });

    const task: Implementation = {
      slug: "lesson-l1", archived: false, alive: false, repo: "teamster", result_status: "needs_decision", pr: null,
      questions: ["Where?"], summary: null, created: NOW, updated_at: NOW,
    };
    update((view) => Object.assign(view.lessons.find((item) => item.entry === L1)!, { status: "accepted", implementation: task }));
    expect(docket()).toEqual({ decide: false, implement: false });
    const shown = desk.index.value.get(L1)!;
    expect(implementationLine(shown.implementation, desk.cardOf(shown).started)).toMatchObject({ kind: "decision", answer: true });
    expect(desk.badgeOf(shown)).toBe("нужен ответ");
    // The open lesson stays open while it moves from tab to tab.
    expect(desk.openLesson.value?.status).toBe("accepted");
    desk.dispose();
  });

  it("gives way to the lesson's implementation when the server named no slug, and keeps following it once closed", async () => {
    const { desk, lesson, update, answer } = setup();
    const u1 = lesson(U1);
    desk.openForm(u1, "implement");
    answer({ ok: true, output: "started" });
    await desk.implement(u1, "accepted");
    expect(implementationLine(lesson(U1).implementation, desk.cardOf(u1).started)).toMatchObject({ kind: "started", text: "Внедряется: teamster" });
    expect(desk.offersImplement(lesson(U1))).toBe(false);

    const task: Implementation = {
      slug: "lesson-u1", archived: false, alive: true, repo: "teamster", result_status: null, pr: null, questions: [], summary: null, created: NOW, updated_at: NOW,
    };
    update((view) => (view.lessons.find((item) => item.entry === U1)!.implementation = task));
    await nextTick();
    expect(implementationLine(lesson(U1).implementation, desk.cardOf(u1).started)).toMatchObject({ kind: "working", text: "Агент работает · teamster" });

    update((view) => Object.assign(view.lessons.find((item) => item.entry === U1)!.implementation!, { alive: false, archived: true, result_status: "partial" }));
    await nextTick();
    expect(implementationLine(lesson(U1).implementation, desk.cardOf(u1).started)).toMatchObject({ kind: "closed" });
    expect(desk.offersImplement(lesson(U1))).toBe(true);
    desk.dispose();
  });

  it("«Посмотреть» flies to the ship of the lesson's open task, also before the lesson shows it", async () => {
    const { desk, lesson, update, answer, ships } = setup();
    const t1 = lesson(T1);
    expect(desk.shipOf(t1)).toBeNull();
    desk.openForm(t1, "implement");
    desk.setRepo(t1, "/Users/demo/dev/demo-vault");
    answer({ ok: true, output: "", slug: "lesson-t1" });
    await desk.implement(t1, "proposed");
    expect(desk.shipOf(t1)).toEqual({ slug: "lesson-t1", repo: "demo-vault" });
    desk.watchAgent(t1);
    expect(ships).toEqual([["lesson-t1", "demo-vault"]]);

    // A start the server named no slug for has no ship to find until the lesson shows its task.
    const u1 = lesson(U1);
    desk.openForm(u1, "implement");
    answer({ ok: true, output: "started" });
    await desk.implement(u1, "accepted");
    expect(desk.shipOf(u1)).toBeNull();
    const task: Implementation = {
      slug: "lesson-u1", archived: false, alive: true, repo: "teamster", result_status: null, pr: null, questions: [], summary: null, created: NOW, updated_at: NOW,
    };
    update((view) => (view.lessons.find((item) => item.entry === U1)!.implementation = task));
    expect(desk.shipOf(lesson(U1))).toEqual({ slug: "lesson-u1", repo: "teamster" });

    // A closed task's ship has left the map.
    update((view) => Object.assign(view.lessons.find((item) => item.entry === U1)!.implementation!, { alive: false, archived: true }));
    desk.watchAgent(lesson(U1));
    expect(desk.shipOf(lesson(U1))).toBeNull();
    expect(ships).toHaveLength(1);
    desk.dispose();
  });

  it("is not offered while the lesson's implementation goes, and «Внедрено» names the agent's PR", () => {
    const { desk, lesson } = setup();
    expect(desk.offersImplement(lesson(U1))).toBe(true);
    expect(desk.offersImplement(lesson(U5))).toBe(false);
    desk.openForm(lesson(U5), "apply");
    expect(desk.cardOf(lesson(U5)).note).toBe("https://github.com/demo/teamster/pull/41");
  });

  it("answers the agent from the card, and keeps the field off until the task moves on", async () => {
    const { desk, act, lesson, update } = setup();
    const u4 = lesson(U4);
    desk.setAgentText(u4, "  Keep it running  ");
    let finish: (result: ActionResult) => void = () => {};
    act.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const said = desk.sayToAgent(u4);
    // The reply shows in the thread at once, marked as sending.
    expect(desk.agentOf(u4)).toMatchObject({ text: "", said: [{ text: "Keep it running", state: "sending" }] });
    finish({ ok: true, output: "" });
    await said;
    expect(act).toHaveBeenCalledWith("say", { slug: "lesson-u4-flaky-e2e", text: "Keep it running" });
    expect(desk.agentOf(u4).said).toMatchObject([{ state: "sent" }]);
    expect(desk.agentSent(u4)).toBe(true);
    expect(desk.agentOf(u4).text).toBe("");
    desk.setAgentText(u4, "More");
    await desk.sayToAgent(u4);
    expect(act).toHaveBeenCalledTimes(1);
    update((view) => (view.lessons.find((item) => item.entry === U4)!.implementation!.updated_at += 60));
    expect(desk.agentSent(lesson(U4))).toBe(false);
    // The server's error marks the reply and gives the field its text back.
    act.mockImplementationOnce(async () => ({ ok: false, error: "Задача закрыта" }));
    await desk.sayToAgent(lesson(U4));
    expect(desk.agentOf(u4)).toMatchObject({ text: "More", said: [{ state: "sent" }, { text: "More", state: "failed", error: "Задача закрыта" }] });
  });
});

describe("«Обсудить»", () => {
  it("opens the channel of a study that can take a reply, with a line about the lesson", async () => {
    const { desk, act, lesson, jumps } = setup();
    await desk.discuss(lesson(L1));
    expect(desk.openStudy.value?.slug).toBe("reflect-review-patterns");
    expect(desk.free.value).toBe("По уроку L1: ");
    expect(jumps).toContain("comms");
    expect(act).not.toHaveBeenCalled();
  });

  it("otherwise starts a study over the last 30 days and opens its channel once it shows up", async () => {
    const { desk, act, lesson, update, answer } = setup();
    const t1 = lesson(T1);
    await desk.discuss(t1);
    expect(desk.cardOf(t1).form).toBe("discuss");
    desk.setNote(t1, "Is it still true?");
    answer({ ok: true, output: "", slug: "reflect-1109-041200" });
    await desk.startDiscussion(t1);
    expect(act).toHaveBeenCalledWith("reflect", {
      order:
        "Обсуждаем урок batch-2026-11-05.md T1 («Review a partial result that already pushed»). Прочитай его раздел в файле batch-2026-11-05.md и записи из его доказательств. Ответь на вопрос ниже; если урок стоит уточнить или переписать — предложи новую редакцию.\n\nIs it still true?",
      since: "30d",
    });
    // The channel waited in the list, open, until the research showed the study; then the study takes its place.
    expect(desk.awaiting.value).toBe(true);
    expect(desk.openPending.value).toMatchObject({ slug: "reflect-1109-041200", order: expect.stringContaining("Is it still true?") });
    update((view) => (view.studies = [{ ...view.studies[0]!, slug: "reflect-1109-041200", created: NOW }, ...view.studies]));
    await nextTick();
    expect(desk.openStudy.value?.slug).toBe("reflect-1109-041200");
    expect(desk.awaiting.value).toBe(false);
    expect(desk.channels.value.filter((channel) => channel.study?.slug === "reflect-1109-041200")).toHaveLength(1);
  });

  it("opens the new study's channel before the server answers, and takes it away with the server's error", async () => {
    const { desk, act, lesson } = setup();
    const t1 = lesson(T1);
    let finish: (result: ActionResult) => void = () => {};
    act.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await desk.discuss(t1);
    desk.setNote(t1, "Still true?");
    const started = desk.startDiscussion(t1);
    expect(desk.channels.value[0]).toMatchObject({ pending: { slug: null, mode: "study" } });
    expect(desk.openPending.value).toBe(desk.channels.value[0]!.pending);
    expect(desk.pendingLaunch(desk.openPending.value!)).toMatchObject({ kind: "reflect", stage: "preparing" });
    expect(desk.cardOf(t1).form).toBeNull();
    finish({ ok: false, error: "Урок уже запускается: reflect-x" });
    await started;
    expect(desk.pending).toHaveLength(0);
    expect(desk.openLesson.value?.entry).toBe(T1);
    expect(desk.cardOf(t1)).toMatchObject({ form: "discuss", note: "Still true?", error: "Урок уже запускается: reflect-x" });
  });
});

describe("the reply in a channel", () => {
  it("says the picked answers and the text, then shows it while the analyst works", async () => {
    const { desk, act, study } = setup();
    const open = study("reflect-review-patterns");
    desk.select(open);
    desk.choose(open, 0, "demo-wallet");
    desk.free.value = "Start there";
    let finish: (result: ActionResult) => void = () => {};
    act.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const sent = desk.sendReply();
    const text = "1. Where should we apply the focused-check rule first?: demo-wallet\nStart there";
    expect(desk.echoOf(open)).toMatchObject({ text, state: "sending" });
    expect(desk.free.value).toBe("");
    finish({ ok: true, output: "" });
    await sent;
    expect(act).toHaveBeenCalledWith("say", { slug: "reflect-review-patterns", text });
    expect(desk.echoOf(open)).toMatchObject({ text, state: "sent" });
    expect(desk.replyReach(open)).toBe("working");
    expect(desk.free.value).toBe("");
  });

  it("marks a reply the server refused and gives the field its text and answers back", async () => {
    const { desk, act, study } = setup();
    const open = study("reflect-review-patterns");
    desk.select(open);
    desk.choose(open, 0, "demo-vault");
    desk.free.value = "Then the rest";
    act.mockImplementationOnce(async () => ({ ok: false, error: "Аналитик работает: ответить можно после его хода" }));
    await desk.sendReply();
    expect(desk.echoOf(open)).toMatchObject({ state: "failed", error: "Аналитик работает: ответить можно после его хода" });
    expect(desk.free.value).toBe("Then the rest");
    expect(desk.answersOf(open)[0]).toBe("demo-vault");
    expect(desk.replyReach(open)).toBe("ok");
  });

  it("takes nothing while the analyst works or once the study is closed", async () => {
    const { desk, act, update, study } = setup();
    update((view) => (view.studies[0]!.alive = true));
    desk.select(study("reflect-review-patterns"));
    desk.free.value = "Hello";
    expect(desk.replyReach(desk.openStudy.value)).toBe("working");
    await desk.sendReply();
    desk.select(study("reflect-check-evidence"));
    expect(desk.replyReach(desk.openStudy.value)).toBe("closed");
    await desk.sendReply();
    expect(act).not.toHaveBeenCalled();
  });

  it("goes with Cmd+Enter or Ctrl+Enter", () => {
    const key = (patch: Partial<KeyboardEvent>) => isSendKey({ key: "Enter", metaKey: false, ctrlKey: false, isComposing: false, ...patch });
    expect(key({ metaKey: true })).toBe(true);
    expect(key({ ctrlKey: true })).toBe(true);
    expect(key({})).toBe(false);
    expect(key({ ctrlKey: true, isComposing: true })).toBe(false);
  });
});

describe("the order", () => {
  it("starts a study of each kind, and checks the draft first", async () => {
    const { desk, act, answer } = setup();
    answer({ ok: true, output: "", slug: "reflect-new" });
    desk.draft.text = "Focus on CI";
    await desk.sendOrder();
    expect(act).toHaveBeenLastCalledWith("reflect", { order: "Focus on CI" });
    expect(desk.orderState.done).toBe("reflect-new");

    desk.draft.kind = "tasks";
    await nextTick();
    await desk.sendOrder();
    expect(desk.orderState.error).toBe("Назови хотя бы одну задачу");
    await desk.studyRecord("flaky-e2e");
    await desk.sendOrder();
    expect(act).toHaveBeenLastCalledWith("reflect", { tasks: ["flaky-e2e"] });

    desk.draft.kind = "question";
    desk.draft.text = "Why do checks repeat?";
    desk.draft.repos = "demo-wallet";
    await desk.sendOrder();
    expect(act).toHaveBeenLastCalledWith("reflect", { since: "30d", repos: ["demo-wallet"], order: "Why do checks repeat?" });
    expect(act).toHaveBeenCalledTimes(3);
  });
});

describe("a board that only reads", () => {
  for (const [actions, reason] of [
    [{ enabled: false, reason: "read_only" }, "запущена с --read-only"],
    [{ enabled: false, reason: "no_teamster" }, "команда teamster не найдена"],
    [null, "сервер без действий"],
  ] as const) {
    it(`copies the commands as before: ${reason}`, async () => {
      const { desk, act, copied, lesson, study } = setup(actions);
      const t1 = lesson(T1);
      await desk.accept(t1);
      expect(desk.cardOf(t1)).toMatchObject({ done: null, copied: { copied: true, reason } });
      desk.openForm(t1, "decline");
      desk.setNote(t1, "one incident");
      await desk.decline(t1);
      desk.openForm(lesson(U1), "apply");
      await desk.apply(lesson(U1));
      await desk.discuss(t1);
      await desk.startDiscussion(t1);

      desk.select(study("reflect-review-patterns"));
      desk.free.value = "Go on";
      await desk.sendReply();
      desk.draft.kind = "tasks";
      desk.draft.tasks = "flaky-e2e";
      await desk.sendOrder();

      // «Внедрить» has no command to copy: it stays off with the reason.
      expect(desk.implementOff.value).toBe(IMPLEMENT_OFF);
      desk.openForm(lesson(U1), "implement");
      expect(desk.cardOf(lesson(U1)).form).toBeNull();
      await desk.implement(lesson(U1), "accepted");

      expect(act).not.toHaveBeenCalled();
      expect(copied).toEqual([
        "teamster lesson 'batch-2026-11-05.md T1' accepted",
        "teamster lesson 'batch-2026-11-05.md T1' declined --note 'one incident'",
        "teamster lesson 'batch-2026-11-06.md U1' applied",
        `teamster reflect reflect-1109-041200 --since 30d '${discussOrder(t1, "")}'`,
        "teamster say reflect-review-patterns 'Go on'",
        "teamster reflect reflect-1109-041200 --task flaky-e2e",
      ]);
      desk.dispose();
    });
  }
});

describe("dev:fixture", () => {
  it("plays the station's actions on its own data", async () => {
    vi.useFakeTimers();
    const source = fixtureSource();
    const run = async <T>(promise: Promise<T>) => {
      await vi.advanceTimersByTimeAsync(500);
      return promise;
    };
    expect(await run(source.act!("lesson", { entry: T1, status: "accepted" }))).toMatchObject({ ok: true });
    expect((await source.fetchResearch())!.lessons.find((item) => item.entry === T1)!.status).toBe("accepted");

    expect(await run(source.act!("say", { slug: "reflect-review-patterns", text: "Go on" }))).toMatchObject({ ok: true });
    let view = (await source.fetchResearch())!;
    expect(view.studies[0]).toMatchObject({ alive: true, waiting: false });
    expect(view.studies[0]!.messages.at(-1)).toMatchObject({ from: "lead", text: "Go on" });

    const launched: Launch[] = [];
    const stop = source.connect((message) => message.type === "launch" && launched.push(message.launch), () => {});
    try {
      // A start answers at once with its first step, then goes stage by stage in `launch` messages.
      const started = await run(source.act!("reflect", { order: "Why?", since: "30d" }));
      expect(started).toMatchObject({ ok: true, slug: expect.stringMatching(/^reflect-/), launch: { kind: "reflect", stage: "preparing" } });
      await vi.advanceTimersByTimeAsync(3 * STAGE_MS);
      expect(launched.filter((launch) => launch.kind === "reflect").map((launch) => launch.stage)).toEqual(["preparing", "starting", "done"]);
      expect((await source.fetchResearch())!.launches?.find((launch) => launch.kind === "reflect")?.stage).toBe("done");
      await vi.advanceTimersByTimeAsync(TURN_MS);
      view = (await source.fetchResearch())!;
      expect(view.studies[0]).toMatchObject({ slug: started.ok ? started.slug : "", alive: false, waiting: true });

      // «Внедрить»: the start goes through its stages, then the agent works, asks, takes the answer and opens a PR.
      const implementation = () => source.fetchResearch().then((research) => research!.lessons.find((item) => item.entry === T1)!.implementation);
      expect(await run(source.act!("implement", { entry: T1, repo: "/Users/demo/dev/teamster" }))).toMatchObject({
        ok: true, output: "", slug: "lesson-t1", launch: { slug: "lesson-t1", kind: "implement", entry: T1, repo: "teamster", stage: "fetching" },
      });
      expect(await implementation()).toBeUndefined();
      expect(await run(source.act!("implement", { entry: T1, repo: "/Users/demo/dev/teamster" }))).toEqual({ ok: false, error: "Урок уже запускается: lesson-t1" });
      await vi.advanceTimersByTimeAsync(3 * STAGE_MS);
      expect(launched.filter((launch) => launch.slug === "lesson-t1").map((launch) => launch.stage)).toEqual(["fetching", "worktree", "starting", "done"]);
      expect(await implementation()).toMatchObject({ slug: "lesson-t1", repo: "teamster", alive: true });
      expect(await run(source.act!("implement", { entry: T1, repo: "/Users/demo/dev/teamster" }))).toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(IMPLEMENT_MS);
      expect(await implementation()).toMatchObject({ alive: false, result_status: "needs_decision", questions: [expect.any(String)] });
      expect(await run(source.act!("say", { slug: "lesson-t1", text: "AGENTS.md" }))).toMatchObject({ ok: true });
      expect(await implementation()).toMatchObject({ alive: true });
      await vi.advanceTimersByTimeAsync(IMPLEMENT_MS);
      expect(await implementation()).toMatchObject({ alive: false, result_status: "done", pr: expect.stringMatching(/\/pull\/\d+$/) });

      // One lesson's first start fails, so that the screen shows that path.
      await run(source.act!("implement", { entry: FAILING_ENTRY, repo: "/Users/demo/dev/demo-game" }));
      await vi.advanceTimersByTimeAsync(4 * STAGE_MS);
      expect(launched.filter((launch) => launch.entry === FAILING_ENTRY).at(-1)).toMatchObject({ stage: "failed", error: expect.stringContaining("git worktree add") });
    } finally {
      stop();
    }
  });

  it("puts the implementing agents on the board, with their phase and last action", async () => {
    vi.useFakeTimers();
    const source = fixtureSource();
    const messages: ServerMessage[] = [];
    const stop = source.connect((message) => messages.push(message), () => {});
    try {
      await vi.advanceTimersByTimeAsync(3000);
      const snapshot = messages.find((message) => message.type === "snapshot");
      expect(snapshot?.type === "snapshot" && snapshot.snapshot.tasks.some((task) => task.slug === "lesson-u3-save-migration")).toBe(true);
      const actions = messages.flatMap((message) => (message.type === "task" && message.task.slug === "lesson-u3-save-migration" ? [message.task.activity?.text] : []));
      expect(new Set(actions).size).toBeGreaterThan(1);
    } finally {
      stop();
    }
  });
});

describe("a start's steps", () => {
  const launch = (patch: Partial<Launch>): Launch => ({
    slug: "lesson-u1", kind: "implement", entry: U1, repo: "teamster", stage: "fetching", steps: [{ stage: "fetching", at: 100 }], error: null, started_at: 100, ...patch,
  });

  it("puts the stages in their order with how long each went, the last one going, and a skipped stage without a line", () => {
    const steps = [{ stage: "accepting", at: 100 }, { stage: "fetching", at: 100.4 }, { stage: "starting", at: 112 }] as Launch["steps"];
    expect(launchSteps(launch({ stage: "starting", steps }), 130)).toEqual([
      { stage: "accepting", text: "Урок принят", state: "done", seconds: expect.closeTo(0.4) },
      { stage: "fetching", text: "Репозиторий обновлён", state: "done", seconds: expect.closeTo(11.6) },
      { stage: "starting", text: "Запускаю агента", state: "running", seconds: 18 },
    ]);
    const done = [...steps, { stage: "done" as const, at: 115 }];
    expect(launchSteps(launch({ stage: "done", steps: done }), 200).map((step) => [step.text, step.state])).toEqual([
      ["Урок принят", "done"], ["Репозиторий обновлён", "done"], ["Агент запущен", "done"],
    ]);
    expect(stepTime(0.4)).toBe("0,4 с");
    expect(stepTime(11.6)).toBe("12 с");
    expect(stepTime(65)).toBe("1 мин 5 с");
  });

  it("marks the step a start broke at, and words a study's start its own way", () => {
    const steps = [{ stage: "fetching", at: 100 }, { stage: "worktree", at: 101 }, { stage: "failed", at: 104 }] as Launch["steps"];
    expect(launchSteps(launch({ stage: "failed", steps, error: "no space" }), 200)).toEqual([
      { stage: "fetching", text: "Репозиторий обновлён", state: "done", seconds: 1 },
      { stage: "worktree", text: "Создаю рабочую копию", state: "failed", seconds: 3 },
    ]);
    const study = launch({ kind: "reflect", entry: null, repo: null, stage: "starting", steps: [{ stage: "preparing", at: 100 }, { stage: "starting", at: 102 }] });
    expect(launchSteps(study, 103).map((step) => step.text)).toEqual(["Записи собраны", "Запускаю аналитика"]);
    // A start known by its stage only stands at its beginning.
    expect(launchSteps(launch({ stage: "worktree", steps: [] }), 105)).toEqual([{ stage: "worktree", text: "Создаю рабочую копию", state: "running", seconds: 5 }]);
  });

  it("keeps the latest news of each start from the research and the messages", () => {
    const older = launch({});
    const newer = launch({ stage: "worktree", steps: [...older.steps, { stage: "worktree", at: 103 }] });
    expect(mergeLaunches([newer], [older])).toEqual([newer]);
    expect(mergeLaunches([older], [newer])).toEqual([newer]);
    // An older server sends none.
    expect(mergeLaunches([], [])).toEqual([]);
  });
});

describe("a lesson's row", () => {
  const base = (patch: Partial<Lesson> = {}): Lesson => ({
    date: "2026-11-09", entry: "b.md U9", scope: "invariant", scope_text: "invariant", repos: [], cue: "cue", status: "accepted", status_text: "accepted", ...patch,
  });
  const task = (patch: Partial<Implementation>): Implementation => ({
    slug: "lesson-u9", archived: false, alive: false, repo: "teamster", result_status: null, pr: null, questions: [], summary: null, created: 100, updated_at: 100, ...patch,
  });
  const start = (patch: Partial<Parameters<typeof lessonBadge>[1]> = {}) => ({ sending: false, launch: null, started: null, ...patch });
  const going: Launch = { slug: "lesson-u9", kind: "implement", entry: "b.md U9", repo: "teamster", stage: "worktree", steps: [{ stage: "worktree", at: 100 }], error: null, started_at: 100 };

  it("labels each state of the lesson's implementation", () => {
    expect(lessonBadge(base(), start())).toBeNull();
    expect(lessonBadge(base({ status: "proposed" }), start({ sending: true }))).toBe("запускается");
    expect(lessonBadge(base(), start({ launch: going }))).toBe("запускается");
    // A start that is done waits for the research to show its task.
    expect(lessonBadge(base(), start({ launch: { ...going, stage: "done" } }))).toBe("запускается");
    expect(lessonBadge(base(), start({ launch: { ...going, stage: "failed", error: "boom" } }))).toBe("не запустился");
    // An older server's start, by `started`.
    expect(lessonBadge(base(), start({ started: { slug: "lesson-u9", repo: "teamster" } }))).toBe("запускается");
    expect(lessonBadge(base({ implementation: task({ alive: true }) }), start({ launch: { ...going, stage: "done" } }))).toBe("агент работает");
    expect(lessonBadge(base({ implementation: task({ result_status: "needs_decision" }) }), start())).toBe("нужен ответ");
    expect(lessonBadge(base({ implementation: task({ result_status: "done", pr: "https://github.com/o/r/pull/3" }) }), start())).toBe("PR готов");
    expect(lessonBadge(base({ outside: ["~/.codex/x"], implementation: task({ result_status: "done" }) }), start())).toBe("правка готова");
    expect(lessonBadge(base({ implementation: task({ result_status: "blocked" }) }), start())).toBe("остановился");
    expect(lessonBadge(base({ implementation: task({ archived: true, result_status: "partial" }) }), start())).toBeNull();
    // An applied lesson's open task is no longer the row's concern.
    expect(lessonBadge(base({ status: "applied", implementation: task({ result_status: "done", pr: "https://github.com/o/r/pull/3" }) }), start())).toBeNull();
  });

  it("moves a decision to its new list at once, newest first, and back without it", () => {
    const lists = { proposed: [base({ entry: "b.md A", status: "proposed", date: "2026-11-09" })], accepted: [base({ entry: "b.md B", date: "2026-11-10" }), base({ entry: "b.md C", date: "2026-11-01" })], applied: [], declined: [], other: [] };
    const moved = withDecisions(lists, { "b.md A": { status: "accepted", note: "", confirmed: false } });
    expect(moved.proposed).toEqual([]);
    expect(moved.accepted.map((lesson) => [lesson.entry, lesson.status])).toEqual([["b.md B", "accepted"], ["b.md A", "accepted"], ["b.md C", "accepted"]]);
    expect(withDecisions(lists, { "b.md A": { status: "declined", note: "one case", confirmed: false } }).declined[0]).toMatchObject({ status: "declined", status_text: "declined: one case" });
    expect(withDecisions(lists, {})).toBe(lists);
  });

  it("lets a study take the place of its waiting channel once the research shows it", () => {
    const waiting: PendingStudy[] = [
      { id: "1", order: "Why?", mode: "study", at: 100, slug: "reflect-a", launch: null },
      { id: "2", order: null, mode: "batch", at: 101, slug: null, launch: null },
    ];
    const studies = fixtureResearch(NOW).studies;
    expect(settlePending(waiting, studies)).toEqual({ left: waiting, found: [] });
    const study = { ...studies[0]!, slug: "reflect-a" };
    expect(settlePending(waiting, [study])).toEqual({ left: [waiting[1]], found: [{ pending: waiting[0], study }] });
    // An archived study of a reused slug is not the one just ordered.
    expect(settlePending(waiting, [{ ...study, archived: true }]).found).toEqual([]);
  });
});
