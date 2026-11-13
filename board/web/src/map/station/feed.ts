// The agent's work in «Переписка», as in a chat: the task's feed (`GET /api/tasks/{slug}/feed`) under a lesson's
// implementation and in a working study's channel — its messages whole, its commands, edits and tools as short lines,
// its thinking dimmed. The feed is asked with its cursor while the lesson or the channel is open: once a second while
// the agent works and at once on its `activity`, once more after it stopped, then no more. Part of the station's console.

import { computed, nextTick, reactive, ref, watch, type Ref } from "vue";
import type { FeedItem, Lesson, Study, TaskDetail, TaskFeed, TaskSummary } from "../../types";
import { plural } from "../research";

/** How often the feed is asked while the agent works. */
export const FEED_MS = 1000;

/** The feed of one task as the screen shows it. */
export interface FeedView {
  items: FeedItem[];
  /** Where the next request continues; null before the first answer. */
  cursor: string | null;
  /** Older work did not fit: «Показана последняя часть работы». */
  truncated: boolean;
  /** The server has no feed for the task (404, or an older server without the route): the screen goes on without it. */
  off: boolean;
  /** The last request failed; what was shown stays, and the next one goes with the same cursor. */
  failed: boolean;
}

export const blankFeed = (): FeedView => ({ items: [], cursor: null, truncated: false, off: false, failed: false });

/** Takes the server's answer in: new items after the shown ones, or the whole feed anew on the first answer and on `reset`. */
export function applyFeed(view: FeedView, answer: TaskFeed): void {
  const anew = answer.reset || view.cursor === null;
  if (anew) view.items = [...answer.items];
  else view.items.push(...answer.items);
  view.truncated = anew ? answer.truncated : view.truncated || answer.truncated;
  view.cursor = answer.cursor;
  view.failed = false;
}

// ---- the rows of the feed

/** More short lines in a row than this fold: the last RUN_TAIL stay, and a button shows the rest. */
export const RUN_LIMIT = 6;
export const RUN_TAIL = 3;

export const KIND_LABEL: Record<"command" | "edit" | "tool", string> = { command: "команда", edit: "правка", tool: "инструмент" };

export type FeedRow =
  | { type: "message"; key: string; item: FeedItem }
  | { type: "thinking"; key: string; item: FeedItem; head: string; more: boolean }
  | { type: "line"; key: string; item: FeedItem; label: string }
  /** «ещё N действий»: `run` names the folded run for `unfold`. */
  | { type: "more"; key: string; run: number; label: string };

const isLine = (item: FeedItem) => item.kind === "command" || item.kind === "edit" || item.kind === "tool";

/** «ещё 4 действия». */
export const moreLabel = (count: number) => `ещё ${count} ${plural(count, "действие", "действия", "действий")}`;

/** The feed's rows in order; a run of more than RUN_LIMIT short lines folds unless `open` has the index of its first item. */
export function feedRows(items: readonly FeedItem[], open: ReadonlySet<number>): FeedRow[] {
  const rows: FeedRow[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index]!;
    if (!isLine(item)) {
      if (item.kind === "message") rows.push({ type: "message", key: String(index), item });
      else {
        const [head = "", ...rest] = item.text.split("\n");
        rows.push({ type: "thinking", key: String(index), item, head, more: rest.some((line) => line.trim()) });
      }
      index++;
      continue;
    }
    let end = index;
    while (end < items.length && isLine(items[end]!)) end++;
    const folded = end - index > RUN_LIMIT && !open.has(index);
    if (folded) rows.push({ type: "more", key: `more-${index}`, run: index, label: moreLabel(end - index - RUN_TAIL) });
    for (let at = folded ? end - RUN_TAIL : index; at < end; at++) {
      const line = items[at]!;
      rows.push({ type: "line", key: String(at), item: line, label: KIND_LABEL[line.kind as keyof typeof KIND_LABEL] });
    }
    index = end;
  }
  return rows;
}

// ---- asking the server

export type FeedFetch = (slug: string, after: string | null) => Promise<TaskFeed | null>;

/** One task's feed, asked while it is open: `alive` polls it, `poke` asks at once, `close` ends every request. */
export function createFeed(fetch: FeedFetch, slug: string, alive: boolean, every = FEED_MS) {
  const view = reactive<FeedView>(blankFeed());
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let again = false;
  let closed = false;
  let working = alive;

  async function pull() {
    if (closed || view.off) return;
    // One request at a time: a call meanwhile asks once more after it, with the new cursor.
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      const answer = await fetch(slug, view.cursor);
      if (closed) return;
      if (answer) applyFeed(view, answer);
      else {
        view.off = true;
        stop();
      }
    } catch {
      if (!closed) view.failed = true;
    } finally {
      busy = false;
      if (again) {
        again = false;
        void pull();
      }
    }
  }
  function stop() {
    clearInterval(timer);
    timer = undefined;
  }
  /** While the agent works the feed is asked every second; once it stops, one last time. */
  function setAlive(next: boolean) {
    if (next === working) return;
    working = next;
    if (next) {
      if (!closed && !view.off) timer ??= setInterval(pull, every);
    } else stop();
    void pull();
  }
  function close() {
    closed = true;
    stop();
  }
  void pull();
  if (alive) timer = setInterval(pull, every);
  return { slug, view, setAlive, poke: () => void pull(), close };
}

export type TaskFeedHandle = ReturnType<typeof createFeed>;

// ---- the console's feed: the open lesson's implementation, or the open study

export interface FeedContext {
  fetchFeed: FeedFetch | null;
  fetchDetail: ((slug: string) => Promise<TaskDetail | null>) | null;
  openLesson: Readonly<Ref<Lesson | null>>;
  /** The open study, when no lesson and no channel just ordered stands in «Переписка». */
  openStudy: Readonly<Ref<Study | null>>;
  tasks: Readonly<Ref<Readonly<Record<string, TaskSummary>>>>;
  /** Whether the lesson's agent stopped after its turn: with questions, stopped, or a change outside the repository. */
  stopped: (lesson: Lesson) => boolean;
}

export function createFeeds(context: FeedContext) {
  const { fetchFeed, fetchDetail, openLesson, openStudy, tasks } = context;
  const aliveOf = (slug: string, known: boolean) => tasks.value[slug]?.alive ?? known;
  /** Whose feed «Переписка» asks for: the open lesson's task while it exists, or the open study's. */
  const target = computed<{ slug: string; alive: boolean } | null>(() => {
    const lesson = openLesson.value;
    if (lesson) {
      const task = lesson.implementation;
      return task && !task.archived ? { slug: task.slug, alive: aliveOf(task.slug, task.alive) } : null;
    }
    // The channel shows the analyst at work by the research: either one saying so keeps the feed going.
    const study = openStudy.value;
    return study && !study.archived ? { slug: study.slug, alive: study.alive || !!tasks.value[study.slug]?.alive } : null;
  });

  const current = ref<TaskFeedHandle | null>(null);
  /** Folded runs opened with «ещё N действий», and thoughts opened, by item index; they close with a new feed. */
  const unfolded = reactive(new Set<number>());
  const opened = reactive(new Set<number>());
  function close() {
    current.value?.close();
    current.value = null;
    unfolded.clear();
    opened.clear();
  }
  watch(
    () => target.value?.slug ?? null,
    (slug) => {
      if (current.value?.slug === slug) return;
      close();
      if (slug && fetchFeed) current.value = createFeed(fetchFeed, slug, target.value!.alive);
    },
    { immediate: true },
  );
  watch(() => target.value?.alive, (alive) => current.value?.setAlive(!!alive));
  // The agent's `activity` messages: the feed has news at once.
  watch(
    () => [target.value?.slug, target.value ? tasks.value[target.value.slug]?.activity : undefined] as const,
    ([slug, activity], [was, before]) => {
      if (slug === was && activity && activity !== before) current.value?.poke();
    },
  );
  // A new feed from the server starts folded again.
  watch(
    () => current.value?.view.items[0],
    () => {
      unfolded.clear();
      opened.clear();
    },
  );

  const view = computed(() => current.value?.view ?? null);
  /** The feed «Переписка» shows: one the server has, with something in it. */
  const shown = computed(() => {
    const feed = view.value;
    return !!feed && !feed.off && feed.items.length > 0;
  });
  const rows = computed(() => feedRows(view.value?.items ?? [], unfolded));

  // ---- the agent's report once it stopped

  const report = reactive<{ key: string; text: string | null }>({ key: "", text: null });
  const reportKey = computed(() => {
    const lesson = openLesson.value;
    const task = lesson?.implementation;
    return lesson && task && context.stopped(lesson) ? `${task.slug}:${task.updated_at}` : "";
  });
  watch(
    reportKey,
    async (key) => {
      if (!key || !fetchDetail || report.key === key) return;
      report.key = key;
      report.text = null;
      try {
        const detail = await fetchDetail(key.slice(0, key.lastIndexOf(":")));
        if (report.key === key) report.text = detail?.report?.trim() || null;
      } catch {
        // The summary's first line stays.
      }
    },
    { immediate: true },
  );

  return {
    feed: view,
    feedShown: shown,
    feedRows: rows,
    /** «ещё N действий»: the folded run shows whole. */
    unfold: (run: number) => unfolded.add(run),
    thoughtOpen: (index: number) => opened.has(index),
    toggleThought: (index: number) => (opened.has(index) ? opened.delete(index) : opened.add(index)),
    /** The stopped agent's report in full, with its line breaks; null while it is not known. */
    agentReport: computed(() => (report.key && report.key === reportKey.value ? report.text : null)),
    disposeFeed: close,
  };
}

// ---- staying at the bottom

/** How near the bottom edge still counts as standing at it, in pixels. */
export const BOTTOM_SLACK = 48;

/** Whether the scroller stands at its bottom edge: news then keeps it there. */
export const atBottom = (area: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">, slack = BOTTOM_SLACK) =>
  area.scrollHeight - area.scrollTop - area.clientHeight <= slack;

const motion = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

/**
 * Follows a scroller's news: at its bottom edge the news keeps it there, and always after the human's own message
 * (`own` changes); scrolled up, it stays put, and `fresh` offers «Новые действия ↓» when the feed (`count`) grew.
 */
export function useFollow(scroller: Readonly<Ref<HTMLElement | null>>, news: () => unknown, count: () => number, own: () => unknown = () => null) {
  const fresh = ref(false);
  watch([news, own, count], async ([, mine, items], [, before, was]) => {
    const area = scroller.value;
    if (!area) return;
    const near = atBottom(area);
    await nextTick();
    if (near || mine !== before) {
      area.scrollTo({ top: area.scrollHeight, behavior: motion() });
      fresh.value = false;
    } else if (items > was) fresh.value = true;
  });
  const onScroll = () => {
    if (fresh.value && scroller.value && atBottom(scroller.value)) fresh.value = false;
  };
  const down = () => {
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: motion() });
    fresh.value = false;
  };
  return { fresh, onScroll, down };
}
