// The station's console: the state every deck of the screen shares — what «Переписка» shows (a study's channel or a
// lesson's thread) and its replies, the lessons' cards, the order — and the actions their buttons run through the
// board server. Each action shows its result at once and puts things back on the server's error. A board that only
// reads copies the equivalent `teamster` command instead.

import { computed, inject, nextTick, reactive, ref, watch, type InjectionKey, type Ref } from "vue";
import { readOnlyReason, type ActionBodies, type ActionResult, type ActionRoute, type ActionSender, type ReflectBody } from "../../lib/actions";
import { sayCommand } from "../../lib/commands";
import type { Launch, Lesson, Study, TaskDetail, TaskSummary } from "../../types";
import type { Research } from "../research";
import {
  discussOrder,
  filedLessons,
  firstStudy,
  implementationLine,
  openQuestionsAt,
  orderAction,
  outsideOf,
  reach,
  reflectBodyCommand,
  replyText,
  studyKey,
  turnKey,
  type OrderDraft,
  type OrderKind,
  type Reach,
} from "../station";
import { createCards } from "./cards";
import { createFeeds, type FeedFetch } from "./feed";
import { createImplementation, type ShipOptions } from "./implement";
import { localLaunch, mergeLaunches, pendingKey, settlePending, type PendingStudy } from "./launch";

export { HOLD_MS, type CardBusy, type CardForm, type CardState, type Stage } from "./cards";

export type Deck = "core" | "crew" | "comms" | "order" | "lab" | "hold";

/** A command copied instead of run, because the board only reads. */
export interface Copied {
  command: string;
  /** False when the clipboard refused: the command is then shown to copy by hand. */
  copied: boolean;
  /** Why the board only reads, in words. */
  reason: string;
}

/** The reply composer of one channel. */
export interface ReplyState {
  busy: boolean;
  error: string;
  copied: Copied | null;
  /** The reply just sent, shown until the study's own messages carry it; `failed` keeps the server's error. */
  echo: { text: string; count: number; state: "sending" | "sent" | "failed"; error: string } | null;
}

export interface ConsoleOptions extends ShipOptions {
  /** Runs an action on the board server and asks for the research again after it succeeded. */
  act: ActionSender;
  /** Copies a command for the terminal or a lesson's manual assignment; false when the clipboard is not available. */
  copy?: (text: string) => Promise<boolean>;
  /** Brings a deck into view. */
  jump?: (deck: Deck) => void;
  /** Scrolls «Переписка» into view where it stands below the lessons, without lighting it. */
  reveal?: () => void;
  /** The starts the board's `launch` messages reported. */
  launches?: Readonly<Ref<readonly Launch[]>>;
  /** The board's tasks by slug, live. */
  tasks?: Readonly<Ref<Readonly<Record<string, TaskSummary>>>>;
  /** The agent's work by time (GET /api/tasks/{slug}/feed); without it «Переписка» shows no feed. */
  fetchFeed?: FeedFetch;
  /** A task's detail, for a stopped agent's whole report. */
  fetchDetail?: (slug: string) => Promise<TaskDetail | null>;
}

export type Outcome = { kind: "ok"; result: Extract<ActionResult, { ok: true }> } | { kind: "error"; error: string } | { kind: "copied"; copied: Copied };

async function clipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const BLANK_REPLY: Readonly<ReplyState> = Object.freeze({ busy: false, error: "", copied: null, echo: null });

export function createConsole(research: Ref<Research>, now: Ref<number>, options: ConsoleOptions) {
  const copy = options.copy ?? clipboard;
  const jump = (deck: Deck) => options.jump?.(deck);
  const studies = computed(() => research.value.studies);
  const filed = computed(() => filedLessons(studies.value));
  const launches = computed(() => mergeLaunches(research.value.launches ?? [], options.launches?.value ?? []));

  // ---- actions: run on the server, or copied when the board only reads

  const live = computed(() => research.value.actions?.enabled === true);
  const offReason = computed(() => readOnlyReason(research.value.actions?.reason, !!research.value.actions));

  async function run<R extends ActionRoute>(route: R, body: ActionBodies[R], command: string): Promise<Outcome> {
    if (!live.value) return { kind: "copied", copied: { command, copied: await copy(command), reason: offReason.value } };
    const result = await options.act(route, body);
    return result.ok ? { kind: "ok", result } : { kind: "error", error: result.error };
  }

  const cards = createCards({ research, live, run });
  const { index, edit, openForm } = cards;

  // ---- what «Переписка» shows: a study's channel, a channel just ordered, or a lesson

  const keyOf = (study: Study | null) => (study ? studyKey(study) : null);
  const openKey = ref<string | null>(keyOf(firstStudy(studies.value)));
  const openStudy = computed(() => studies.value.find((study) => studyKey(study) === openKey.value) ?? null);
  /** The lesson open in «Переписка», by entry; it stays open while it moves from tab to tab. */
  const openEntry = ref<string | null>(null);
  const openLesson = computed(() => (openEntry.value ? (index.value.get(openEntry.value) ?? null) : null));
  // A study that starts waiting comes forward, unless the human is in another one.
  watch(
    () => keyOf(firstStudy(studies.value)),
    (key) => {
      if (!openStudy.value && !openPending.value) openKey.value = key;
    },
  );
  function select(study: Study) {
    openKey.value = studyKey(study);
    openEntry.value = null;
  }

  const agentField = ref<HTMLTextAreaElement | null>(null);
  /** Opens a lesson in «Переписка»: `answer` focuses the reply to its agent, `implement` opens the start's form. */
  async function showLesson(lesson: Lesson, then: "answer" | "implement" | null = null) {
    openEntry.value = lesson.entry.trim();
    options.reveal?.();
    if (then === "implement") openForm(lesson, "implement");
    if (then === "answer") await focus(agentField);
  }

  /** Studies ordered from this screen: each is a channel at once, until the research shows it. */
  const pending = reactive<PendingStudy[]>([]);
  let pendingCount = 0;
  const openPending = computed(() => pending.find((item) => pendingKey(item) === openKey.value) ?? null);
  /** The channels in their order: those just ordered first, then the studies, newest first. */
  const channels = computed(() => [
    ...pending.map((item) => ({ key: pendingKey(item), pending: item, study: null })),
    ...studies.value.map((study) => ({ key: studyKey(study), pending: null, study })),
  ]);
  /** The start of a study just ordered: the server's latest news, or its first step before the server answered. */
  function pendingLaunch(item: PendingStudy): Launch | null {
    if (!item.slug) return localLaunch("reflect", "preparing", item.at);
    return launches.value.find((launch) => launch.slug === item.slug) ?? item.launch;
  }
  function settle() {
    const { left, found } = settlePending(pending, studies.value);
    // The study takes its channel's place; a lesson opened meanwhile stays open.
    for (const { pending: item, study } of found) if (openKey.value === pendingKey(item)) openKey.value = studyKey(study);
    if (found.length) pending.splice(0, pending.length, ...left);
  }
  watch(studies, settle);
  function dropPending(item: PendingStudy) {
    const at = pending.findIndex((candidate) => candidate.id === item.id);
    if (at >= 0) pending.splice(at, 1);
    if (openKey.value === pendingKey(item)) openKey.value = keyOf(firstStudy(studies.value));
  }
  function showPending(item: PendingStudy) {
    openKey.value = pendingKey(item);
    openEntry.value = null;
  }

  /** A new study: its channel opens at once with the request; the server's error takes it away. */
  async function startStudy(body: ReflectBody, command: string): Promise<Outcome> {
    if (!live.value) return run("reflect", body, command);
    const mode: Study["mode"] = body.tasks?.length || body.since !== undefined || body.repos?.length ? "study" : "batch";
    pending.unshift({ id: String(++pendingCount), order: body.order ?? null, mode, at: now.value, slug: null, launch: null });
    const item = pending[0]!;
    showPending(item);
    options.reveal?.();
    const outcome = await run("reflect", body, command);
    if (outcome.kind !== "ok" || !outcome.result.slug) dropPending(item);
    else {
      Object.assign(item, { slug: outcome.result.slug, launch: outcome.result.launch ?? null });
      settle();
    }
    return outcome;
  }

  // ---- answers to the analyst

  /** Answers to the open questions, by the analyst's turn and question number: a new turn starts clean. */
  const answers = reactive<Record<string, string[]>>({});
  const answersOf = (study: Study) => (answers[turnKey(study)] ??= []);
  /** Questions answered in the human's own words instead of an option. */
  const custom = reactive<Record<string, boolean[]>>({});
  const customOf = (study: Study) => (custom[turnKey(study)] ??= []);
  function choose(study: Study, number: number, option: string) {
    const list = answersOf(study);
    list[number] = list[number] === option ? "" : option;
    customOf(study)[number] = false;
  }
  function ownAnswer(study: Study, number: number) {
    customOf(study)[number] = true;
    answersOf(study)[number] = "";
  }

  /** The free text of a reply, kept for each study. */
  const drafts = reactive<Record<string, string>>({});
  const free = computed({
    get: () => (openStudy.value ? (drafts[studyKey(openStudy.value)] ?? "") : ""),
    set: (text: string) => {
      if (openStudy.value) drafts[studyKey(openStudy.value)] = text;
    },
  });

  const replies = reactive<Record<string, ReplyState>>({});
  const replyOf = (study: Study): Readonly<ReplyState> => replies[studyKey(study)] ?? BLANK_REPLY;
  /** The reply just sent, while the study's messages do not carry it yet; one that failed stays with its error. */
  function echoOf(study: Study) {
    const echo = replies[studyKey(study)]?.echo;
    return echo && (echo.state === "failed" || study.messages.length <= echo.count) ? echo : null;
  }
  /** Whether a reply can go to the study now: not while the analyst works on the last one. */
  const replyReach = (study: Study | null): Reach => (study && echoOf(study) && echoOf(study)!.state !== "failed" ? "working" : reach(study));

  const replyField = ref<HTMLTextAreaElement | null>(null);
  const orderField = ref<HTMLTextAreaElement | null>(null);

  async function focus(field: Ref<HTMLTextAreaElement | null>) {
    await nextTick();
    const area = field.value;
    if (!area || area.disabled) return;
    area.scrollIntoView({ block: "nearest", behavior: "smooth" });
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  /** «Ответить»: the channel opens and its reply field takes the focus. */
  async function answer(study: Study) {
    select(study);
    jump("comms");
    await focus(replyField);
  }

  /** «Обсудить» a lesson in the study that filed it: a line about the lesson starts the reply. */
  async function clarify(id: string, study: Study) {
    select(study);
    jump("comms");
    const prefix = `По уроку ${id}: `;
    if (!free.value.includes(prefix)) free.value = (free.value.trim() ? `${free.value.trim()}\n` : "") + prefix;
    await focus(replyField);
  }

  const questionsAt = computed(() => (openStudy.value ? openQuestionsAt(openStudy.value) : -1));
  const openQuestions = computed(() => (openStudy.value && questionsAt.value >= 0 ? (openStudy.value.messages[questionsAt.value]?.questions ?? []) : []));
  const reply = computed(() =>
    openStudy.value && replyReach(openStudy.value) === "ok" ? replyText(openQuestions.value, answersOf(openStudy.value), free.value) : "",
  );

  /** «Отправить»: the reply shows in the channel at once as sending; the server's error gives the field its text back. */
  async function sendReply() {
    const study = openStudy.value;
    const text = reply.value;
    if (!study || !text || replyReach(study) !== "ok" || replies[studyKey(study)]?.busy) return;
    const key = studyKey(study);
    const turn = turnKey(study);
    const count = study.messages.length;
    const kept = { draft: drafts[key] ?? "", answers: [...answersOf(study)], custom: [...customOf(study)] };
    const clear = () => {
      drafts[key] = "";
      answers[turn] = [];
      custom[turn] = [];
    };
    replies[key] = { busy: true, error: "", copied: null, echo: live.value ? { text, count, state: "sending", error: "" } : null };
    const state = replies[key]!;
    if (state.echo) clear();
    const outcome = await run("say", { slug: study.slug, text }, sayCommand(study.slug, text));
    state.busy = false;
    if (outcome.kind === "error") {
      if (state.echo) Object.assign(state.echo, { state: "failed", error: outcome.error });
      else state.error = outcome.error;
      if (!drafts[key]?.trim()) {
        drafts[key] = kept.draft;
        answers[turn] = kept.answers;
        custom[turn] = kept.custom;
      }
      return;
    }
    if (outcome.kind === "copied") state.copied = outcome.copied;
    else if (state.echo) state.echo.state = "sent";
    clear();
  }

  const tasks = options.tasks ?? ref({});
  const implementation = createImplementation({
    research, now, live, act: options.act, openShip: options.openShip, run, launches, tasks,
    cardOf: cards.cardOf, edit, openForm, listOf: cards.listOf, hold: cards.hold,
  });
  const STOPPED = new Set(["decision", "stopped", "outside"]);
  const feeds = createFeeds({
    fetchFeed: options.fetchFeed ?? null,
    fetchDetail: options.fetchDetail ?? null,
    openLesson,
    openStudy: computed(() => (openPending.value ? null : openStudy.value)),
    tasks,
    stopped: (lesson) => STOPPED.has(implementationLine(lesson.implementation, cards.cardOf(lesson).started, outsideOf(lesson))?.kind ?? ""),
  });

  /** «Обсудить»: in the study that filed the lesson when it can take a reply, otherwise a new study. */
  async function discuss(lesson: Lesson) {
    const at = filed.value.get(lesson.entry.trim());
    if (at && reach(at.study) === "ok") await clarify(at.id, at.study);
    else openForm(lesson, "discuss");
  }

  /** «Начать обсуждение»: the new study's channel opens at once; the server's error brings the lesson and its form back. */
  async function startDiscussion(lesson: Lesson) {
    const state = edit(lesson);
    if (state.busy) return;
    const note = state.note;
    const body = { order: discussOrder(lesson, note), since: "30d" };
    Object.assign(state, { busy: "discuss", error: "", copied: null });
    if (live.value) Object.assign(state, { form: null, note: "" });
    const outcome = await startStudy(body, reflectBodyCommand(body, new Date(now.value * 1000)));
    state.busy = null;
    if (outcome.kind === "error") {
      Object.assign(state, { form: "discuss", note, error: outcome.error });
      if (live.value) void showLesson(lesson);
      return;
    }
    Object.assign(state, { form: null, note: "" });
    if (outcome.kind === "copied") state.copied = outcome.copied;
    else jump("comms");
  }

  // ---- the lab's tabs

  function showStage(stage: "proposed" | "accepted") {
    cards.labStage.value = stage;
    jump("lab");
  }

  // ---- the order deck

  const draft = reactive<OrderDraft>({ kind: "batch", tasks: "", since: "30d", repos: "", text: "" });
  const ordered = computed(() => orderAction(draft, new Date(now.value * 1000)));
  const orderState = reactive({ busy: false, error: "", done: null as string | null, copied: null as Copied | null });
  watch(() => ({ ...draft }), () => (orderState.error = ""));

  /** An order of the given kind, ready to be written. */
  async function order(kind: OrderKind) {
    draft.kind = kind;
    jump("order");
    await focus(orderField);
  }

  /** A record from the hold goes into a task order. */
  async function studyRecord(slug: string) {
    const tasks = draft.tasks.split(/[\s,]+/).filter(Boolean);
    if (!tasks.includes(slug)) draft.tasks = [...tasks, slug].join(" ");
    await order("tasks");
  }

  /** «Запустить»: the study's channel opens at once and the draft clears; the server's error puts the draft back. */
  async function sendOrder() {
    const result = ordered.value;
    if (orderState.busy) return;
    if ("error" in result) {
      orderState.error = result.error;
      return;
    }
    const kept = { text: draft.text, tasks: draft.tasks };
    Object.assign(orderState, { busy: true, error: "", done: null, copied: null });
    if (live.value) Object.assign(draft, { text: "", tasks: "" });
    const outcome = await startStudy(result.body, result.command);
    orderState.busy = false;
    if (outcome.kind === "error") {
      Object.assign(draft, kept);
      await nextTick();
      orderState.error = outcome.error;
      return;
    }
    if (outcome.kind === "copied") orderState.copied = outcome.copied;
    else orderState.done = outcome.result.slug ?? "";
    Object.assign(draft, { text: "", tasks: "" });
  }

  return {
    copyText: copy,
    studies,
    repos: computed(() => research.value.repos),
    reposAccess: computed(() => research.value.reposAccess),
    filed,
    live,
    launches,
    openKey,
    openStudy,
    openEntry,
    openLesson,
    select,
    showLesson,
    agentField,
    channels,
    pending,
    openPending,
    pendingLaunch,
    showPending,
    dropPending,
    /** Whether a study just ordered waits to show up: the screen asks for news more often meanwhile. */
    awaiting: computed(() => pending.length > 0),
    answersOf,
    customOf,
    choose,
    ownAnswer,
    free,
    replyField,
    orderField,
    answer,
    clarify,
    reply,
    replyOf,
    echoOf,
    replyReach,
    sendReply,
    ...cards,
    ...implementation,
    ...feeds,
    dispose() {
      cards.dispose();
      feeds.disposeFeed();
    },
    discuss,
    startDiscussion,
    showStage,
    draft,
    ordered,
    orderState,
    order,
    studyRecord,
    sendOrder,
  };
}

export type StationConsole = ReturnType<typeof createConsole>;

export const CONSOLE: InjectionKey<StationConsole> = Symbol("station-console");

export function useConsole(): StationConsole {
  const console = inject(CONSOLE);
  if (!console) throw new Error("A station deck stands outside the station screen");
  return console;
}
