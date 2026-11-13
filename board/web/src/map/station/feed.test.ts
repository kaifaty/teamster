import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { fixtureResearch } from "../../fixtures/research";
import { fixtureSource } from "../../fixtures/source";
import type { FeedItem, TaskDetail, TaskFeed, TaskSummary } from "../../types";
import { research } from "../research";
import { createConsole } from "./console";
import { FEED_MS, atBottom, createFeed, feedRows, useFollow, type FeedFetch } from "./feed";

const NOW = Date.UTC(2026, 10, 9, 4, 12) / 1000;
const U3 = "batch-2026-11-06.md U3"; // accepted, its agent works: lesson-u3-save-migration
const U4 = "batch-2026-11-06.md U4"; // accepted, its agent needs a decision: lesson-u4-flaky-e2e
const AGENT = "lesson-u3-save-migration";

const item = (kind: FeedItem["kind"], text: string = kind, at = NOW): FeedItem => ({ at, kind, text });
const answer = (items: FeedItem[], cursor: string, patch: Partial<TaskFeed> = {}): TaskFeed => ({ items, cursor, reset: false, truncated: false, ...patch });

/** A server's feed: each call takes the next answer; `calls` keeps the cursors the agent's feed was asked with. */
function server(...answers: (TaskFeed | null | Error)[]) {
  const calls: (string | null)[] = [];
  const fetch = vi.fn<FeedFetch>(async (slug, after) => {
    if (slug === AGENT) calls.push(after);
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch, calls };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

afterEach(() => vi.useRealTimers());

describe("a task's feed", () => {
  it("adds what is new after its cursor without repeats, takes `reset` anew and keeps `truncated`", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = server(
      answer([item("message", "a"), item("command", "b")], "c1", { truncated: true }),
      answer([item("edit", "c")], "c2"),
      answer([item("tool", "x")], "c3", { reset: true, truncated: false }),
      answer([], "c3"),
    );
    const feed = createFeed(fetch, AGENT, true);
    // Asked again while a request goes: one more request after it, with the new cursor.
    feed.poke();
    feed.poke();
    await settle();
    expect(calls).toEqual([null, "c1"]);
    expect(feed.view.items.map((one) => one.text)).toEqual(["a", "b", "c"]);
    expect(feed.view.truncated).toBe(true);
    await vi.advanceTimersByTimeAsync(FEED_MS);
    expect(feed.view.items.map((one) => one.text)).toEqual(["x"]);
    expect(feed.view.truncated).toBe(false);
    await vi.advanceTimersByTimeAsync(FEED_MS);
    expect(calls).toEqual([null, "c1", "c2", "c3"]);
    expect(feed.view.items.map((one) => one.text)).toEqual(["x"]);
    feed.close();
  });

  it("asks once a second while the agent works, once more after it stopped, and then no more", async () => {
    vi.useFakeTimers();
    const { fetch } = server(answer([], "c"));
    const feed = createFeed(fetch, AGENT, true);
    await vi.advanceTimersByTimeAsync(3 * FEED_MS);
    expect(fetch).toHaveBeenCalledTimes(4);
    feed.setAlive(false);
    await vi.advanceTimersByTimeAsync(10 * FEED_MS);
    expect(fetch).toHaveBeenCalledTimes(5);
    // The agent goes on after a reply: the feed follows it again.
    feed.setAlive(true);
    await vi.advanceTimersByTimeAsync(FEED_MS);
    expect(fetch).toHaveBeenCalledTimes(7);
    feed.close();
    await vi.advanceTimersByTimeAsync(10 * FEED_MS);
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("keeps what it shows on a network error and goes on with the same cursor; a 404 turns it off", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = server(answer([item("message", "a")], "c1"), new Error("Failed to fetch"), answer([item("command", "b")], "c2"), null);
    const feed = createFeed(fetch, AGENT, true);
    await vi.advanceTimersByTimeAsync(FEED_MS);
    expect(feed.view).toMatchObject({ failed: true, cursor: "c1", items: [{ text: "a" }] });
    await vi.advanceTimersByTimeAsync(FEED_MS);
    expect(feed.view).toMatchObject({ failed: false, cursor: "c2" });
    expect(feed.view.items.map((one) => one.text)).toEqual(["a", "b"]);
    expect(calls).toEqual([null, "c1", "c1"]);
    await vi.advanceTimersByTimeAsync(5 * FEED_MS);
    expect(feed.view.off).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe("the feed's rows", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => item("command", `c${index}`));

  it("shows a run of six short lines whole and folds a run of seven to its last three", () => {
    expect(feedRows([item("message"), ...lines(6)], new Set()).map((row) => row.type)).toEqual(["message", ...Array(6).fill("line")]);
    const rows = feedRows([item("message"), ...lines(7), item("thinking", "first\nsecond")], new Set());
    expect(rows.map((row) => row.type)).toEqual(["message", "more", "line", "line", "line", "thinking"]);
    expect(rows[1]).toMatchObject({ run: 1, label: "ещё 4 действия" });
    expect(rows.slice(2, 5).map((row) => row.type === "line" && row.item.text)).toEqual(["c4", "c5", "c6"]);
    expect(rows[2]).toMatchObject({ label: "команда" });
    expect(rows[5]).toMatchObject({ head: "first", more: true });
    // «ещё N действий» opens the run.
    expect(feedRows([item("message"), ...lines(7)], new Set([1])).filter((row) => row.type === "line")).toHaveLength(7);
    expect(feedRows([...lines(8)], new Set())[0]).toMatchObject({ type: "more", label: "ещё 5 действий" });
  });

  it("keeps the reader at the bottom edge only while they stand at it", () => {
    expect(atBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(atBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 })).toBe(true);
    expect(atBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 400 })).toBe(false);
  });

  it("follows the news at the bottom edge, stays put scrolled up with «Новые действия ↓», and goes down after your own message", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const area = { scrollHeight: 1000, scrollTop: 600, clientHeight: 400, scrollTo: vi.fn() };
    const count = ref(1);
    const own = ref(0);
    const follow = useFollow(ref(area as unknown as HTMLElement), () => count.value, () => count.value, () => own.value);
    const tick = async () => {
      await nextTick();
      await nextTick();
    };

    // At the bottom edge: the new items keep the reader there.
    count.value++;
    await tick();
    expect(area.scrollTo).toHaveBeenCalledTimes(1);
    expect(follow.fresh.value).toBe(false);

    // Scrolled up: the feed stays put and offers «Новые действия ↓», which goes down.
    area.scrollTop = 100;
    count.value++;
    await tick();
    expect(area.scrollTo).toHaveBeenCalledTimes(1);
    expect(follow.fresh.value).toBe(true);
    follow.down();
    expect(area.scrollTo).toHaveBeenCalledTimes(2);
    expect(follow.fresh.value).toBe(false);

    // The human's own message: always down, even scrolled up.
    own.value++;
    await tick();
    expect(area.scrollTo).toHaveBeenCalledTimes(3);
    expect(follow.fresh.value).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("the feed in «Переписка»", () => {
  function setup(fetchFeed: FeedFetch, fetchDetail = vi.fn(async (_slug: string): Promise<TaskDetail | null> => null)) {
    const station = ref(research(fixtureResearch(NOW), [], [])!);
    const tasks = ref<Record<string, TaskSummary>>({ [AGENT]: { slug: AGENT, alive: true, phase: "turn", phase_started_at: NOW - 180, activity: null } as TaskSummary });
    const desk = createConsole(station, ref(NOW), { act: vi.fn() as never, tasks, fetchFeed, fetchDetail });
    const lesson = (entry: string) => station.value.accepted.find((one) => one.entry === entry)!;
    return { desk, tasks, lesson, station, fetchDetail };
  }

  it("asks only while the lesson or the channel is open, at once on the agent's `activity`", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = server(answer([item("command", "ls")], "c"));
    const { desk, tasks, lesson, station } = setup(fetch);
    await desk.showLesson(lesson(U3));
    await nextTick();
    await settle();
    expect(fetch).toHaveBeenLastCalledWith(AGENT, null);
    expect(desk.feedShown.value).toBe(true);
    await vi.advanceTimersByTimeAsync(FEED_MS / 2);
    tasks.value = { [AGENT]: { ...tasks.value[AGENT]!, activity: { at: NOW, kind: "command", text: "ls" } } };
    await nextTick();
    await settle();
    expect(calls).toEqual([null, "c"]);

    // Another channel: the lesson's feed stops; a study that does not work is asked once.
    desk.select(station.value.studies[0]!);
    await nextTick();
    await settle();
    expect(fetch).toHaveBeenLastCalledWith("reflect-review-patterns", null);
    const asked = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * FEED_MS);
    expect(fetch).toHaveBeenCalledTimes(asked);

    // Back to the lesson, then the lesson closes and the screen closes: no more requests.
    await desk.showLesson(lesson(U3));
    await nextTick();
    await vi.advanceTimersByTimeAsync(FEED_MS);
    desk.openEntry.value = null;
    desk.select(station.value.studies[1]!); // archived: no feed
    await nextTick();
    const closed = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * FEED_MS);
    expect(fetch).toHaveBeenCalledTimes(closed);
    await desk.showLesson(lesson(U3));
    await nextTick();
    desk.dispose();
    const disposed = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * FEED_MS);
    expect(fetch).toHaveBeenCalledTimes(disposed);
  });

  it("asks once more after the open lesson's agent stopped, then no more", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = server(answer([item("command", "ls")], "c"));
    const { desk, tasks, lesson } = setup(fetch);
    await desk.showLesson(lesson(U3));
    await nextTick();
    await vi.advanceTimersByTimeAsync(3 * FEED_MS);
    expect(calls.length).toBe(4);
    tasks.value = { [AGENT]: { ...tasks.value[AGENT]!, alive: false } };
    await nextTick();
    await vi.advanceTimersByTimeAsync(10 * FEED_MS);
    expect(calls.length).toBe(5);
    desk.dispose();
  });

  it("puts the phase and how long it goes under the feed", async () => {
    vi.useFakeTimers();
    const { fetch } = server(answer([item("command", "ls")], "c"));
    const { desk, tasks, lesson } = setup(fetch);
    tasks.value = { [AGENT]: { ...tasks.value[AGENT]!, activity: { at: NOW, kind: "command", text: "npm test" } } };
    await desk.showLesson(lesson(U3));
    await nextTick();
    await settle();
    expect(desk.workLineOf(lesson(U3))).toEqual({ phase: "Работа", going: "3 мин", activity: null });
    desk.dispose();
  });

  it("goes on without a feed from an older server, with the last action as before", async () => {
    vi.useFakeTimers();
    const { fetch } = server(null);
    const { desk, tasks, lesson } = setup(fetch);
    tasks.value = { [AGENT]: { ...tasks.value[AGENT]!, activity: { at: NOW, kind: "command", text: "npm test" } } };
    await desk.showLesson(lesson(U3));
    await nextTick();
    await vi.advanceTimersByTimeAsync(5 * FEED_MS);
    expect(fetch.mock.calls.filter(([slug]) => slug === AGENT)).toHaveLength(1);
    expect(desk.feed.value?.off).toBe(true);
    expect(desk.feedShown.value).toBe(false);
    expect(desk.workLineOf(lesson(U3))).toEqual({ phase: "Работа", going: null, activity: "npm test" });
    desk.dispose();
  });

  it("brings a stopped agent's whole report", async () => {
    vi.useFakeTimers();
    const { fetch } = server(answer([], "c"));
    const fetchDetail = vi.fn(async (slug: string) => ({ slug, report: "Line one\n\nLine two" }) as TaskDetail);
    const { desk, lesson } = setup(fetch, fetchDetail);
    await desk.showLesson(lesson(U4));
    await nextTick();
    await settle();
    expect(fetchDetail).toHaveBeenCalledWith("lesson-u4-flaky-e2e");
    expect(desk.agentReport.value).toBe("Line one\n\nLine two");
    await desk.showLesson(lesson(U3));
    await nextTick();
    expect(desk.agentReport.value).toBeNull();
    desk.dispose();
  });
});

describe("dev:fixture", () => {
  it("grows the working agent's feed with every kind of item, and cuts one stopped agent's older work", async () => {
    vi.useFakeTimers();
    const source = fixtureSource();
    const stop = source.connect(() => {}, () => {});
    try {
      const first = await settled(source.fetchFeed(AGENT, null));
      expect(first!.items.length).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(30_000);
      const next = await settled(source.fetchFeed(AGENT, first!.cursor));
      expect(next!.items.length).toBeGreaterThan(20);
      expect(new Set([...first!.items, ...next!.items].map((one) => one.kind))).toEqual(new Set(["message", "thinking", "command", "edit", "tool"]));
      expect((await settled(source.fetchFeed("lesson-u6-ledger-test", null)))!.truncated).toBe(true);
      expect(await settled(source.fetchFeed("no-such-task", null))).toBeNull();
      expect((await settled(source.fetchDetail("lesson-u4-flaky-e2e")))?.report).toContain("\n");
    } finally {
      stop();
    }
  });
});

async function settled<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(100);
  return promise;
}
