import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import type { ActionResult } from "../../lib/actions";
import { fixtureResearch } from "../../fixtures/research";
import { fixtureSource } from "../../fixtures/source";
import type { ResearchActions, ResearchView } from "../../types";
import { research } from "../research";
import { discussOrder, isSendKey } from "../station";
import { createConsole, HOLD_MS, type Deck } from "./console";

const NOW = Date.UTC(2026, 10, 9, 4, 12) / 1000;
const T1 = "batch-2026-11-05.md T1"; // proposed, filed by no study
const U1 = "batch-2026-11-06.md U1"; // accepted
const L1 = "study-2026-11-07.md L1"; // proposed, filed by a study that waits for an answer

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
  const desk = createConsole(station, ref(NOW), {
    act: act as never,
    copy: async (text) => (copied.push(text), true),
    jump: (deck) => jumps.push(deck),
  });
  const lesson = (entry: string) => [...station.value.proposed, ...station.value.accepted].find((item) => item.entry === entry)!;
  const study = (slug: string) => station.value.studies.find((item) => item.slug === slug)!;
  return { view, station, update, act, copied, jumps, desk, lesson, study, answer: (next: ActionResult) => (answer = next) };
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

    await desk.undo(t1);
    expect(act).toHaveBeenLastCalledWith("lesson", { entry: T1, status: "proposed" });
    expect(desk.cardOf(t1).done).toBeNull();
    expect(desk.shown.value.map((item) => item.entry)).not.toContain(T1);

    await desk.accept(t1);
    vi.advanceTimersByTime(HOLD_MS);
    expect(desk.cardOf(t1).done).toBeNull();
    expect(desk.shown.value.map((item) => item.entry)).not.toContain(T1);
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

  it("holds its buttons while the request is in flight and shows an error on the card", async () => {
    const { desk, act, lesson } = setup();
    const t1 = lesson(T1);
    let finish: (result: ActionResult) => void = () => {};
    act.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pending = desk.accept(t1);
    expect(desk.cardOf(t1).busy).toBe("accept");
    await desk.accept(t1);
    expect(act).toHaveBeenCalledTimes(1);
    finish({ ok: false, error: "unknown lesson batch-2026-11-05.md T1" });
    await pending;
    expect(desk.cardOf(t1)).toMatchObject({ busy: null, done: null, error: "unknown lesson batch-2026-11-05.md T1" });
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
    expect(desk.awaiting.value).toBe("reflect-1109-041200");
    update((view) => (view.studies = [{ ...view.studies[0]!, slug: "reflect-1109-041200", created: NOW }, ...view.studies]));
    await nextTick();
    expect(desk.openStudy.value?.slug).toBe("reflect-1109-041200");
    expect(desk.awaiting.value).toBeNull();
  });
});

describe("the reply in a channel", () => {
  it("says the picked answers and the text, then shows it while the analyst works", async () => {
    const { desk, act, study } = setup();
    const open = study("reflect-review-patterns");
    desk.select(open);
    desk.choose(open, 0, "demo-wallet");
    desk.free.value = "Start there";
    await desk.sendReply();
    const text = "1. Where should we apply the focused-check rule first?: demo-wallet\nStart there";
    expect(act).toHaveBeenCalledWith("say", { slug: "reflect-review-patterns", text });
    expect(desk.echoOf(open)).toMatchObject({ text });
    expect(desk.replyReach(open)).toBe("working");
    expect(desk.free.value).toBe("");
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

    const started = await run(source.act!("reflect", { order: "Why?", since: "30d" }));
    expect(started).toMatchObject({ ok: true, slug: expect.stringMatching(/^reflect-/) });
    await vi.advanceTimersByTimeAsync(10_000);
    view = (await source.fetchResearch())!;
    expect(view.studies[0]).toMatchObject({ slug: started.ok ? started.slug : "", alive: false, waiting: true });
  });
});
