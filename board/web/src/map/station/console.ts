// The station's console: the state every deck of the screen shares — the open channel and its reply, the lessons'
// cards, the order — and the actions their buttons run at once through the board server. A board that only reads
// copies the equivalent `teamster` command instead.

import { computed, inject, nextTick, reactive, ref, watch, type InjectionKey, type Ref } from "vue";
import { readOnlyReason, type ActionBodies, type ActionResult, type ActionRoute, type ActionSender, type LessonBody } from "../../lib/actions";
import { lessonCommand, sayCommand } from "../../lib/commands";
import type { Lesson, Study } from "../../types";
import type { Research } from "../research";
import {
  discussOrder,
  filedLessons,
  firstStudy,
  lessonsByEntry,
  openQuestionsAt,
  orderAction,
  reach,
  reflectBodyCommand,
  replyText,
  studyKey,
  turnKey,
  type OrderDraft,
  type OrderKind,
  type Reach,
} from "../station";

export type Deck = "core" | "crew" | "comms" | "order" | "lab" | "hold";
export type Stage = "proposed" | "accepted" | "applied" | "declined";

/** How long a card shows «Принято · Отменить» before its lesson leaves the tab. */
export const HOLD_MS = 8000;

/** A command copied instead of run, because the board only reads. */
export interface Copied {
  command: string;
  /** False when the clipboard refused: the command is then shown to copy by hand. */
  copied: boolean;
  /** Why the board only reads, in words. */
  reason: string;
}

export type CardForm = "decline" | "apply" | "discuss";
export type CardBusy = CardForm | "accept" | "undo";

/** A lesson's card: its open form, the request in flight, and what came of the last one. */
export interface CardState {
  form: CardForm | null;
  note: string;
  busy: CardBusy | null;
  error: string;
  /** The decision just taken, which «Отменить» takes back to `undo`. */
  done: { status: "accepted" | "declined" | "applied"; undo: "proposed" | "accepted" } | null;
  copied: Copied | null;
}

/** The reply composer of one channel. */
export interface ReplyState {
  busy: boolean;
  error: string;
  copied: Copied | null;
  /** The reply just sent, shown until the study's own messages carry it. */
  echo: { text: string; count: number } | null;
}

export interface ConsoleOptions {
  /** Runs an action on the board server and asks for the research again after it succeeded. */
  act: ActionSender;
  /** Copies a command for the terminal; false when the clipboard is not available. */
  copy?: (text: string) => Promise<boolean>;
  /** Brings a deck into view. */
  jump?: (deck: Deck) => void;
}

type Outcome = { kind: "ok"; result: Extract<ActionResult, { ok: true }> } | { kind: "error"; error: string } | { kind: "copied"; copied: Copied };

async function clipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const BLANK_CARD: Readonly<CardState> = Object.freeze({ form: null, note: "", busy: null, error: "", done: null, copied: null });
const BLANK_REPLY: Readonly<ReplyState> = Object.freeze({ busy: false, error: "", copied: null, echo: null });

export function createConsole(research: Ref<Research>, now: Ref<number>, options: ConsoleOptions) {
  const copy = options.copy ?? clipboard;
  const jump = (deck: Deck) => options.jump?.(deck);
  const studies = computed(() => research.value.studies);
  const index = computed(() =>
    lessonsByEntry([research.value.proposed, research.value.accepted, research.value.applied, research.value.declined, research.value.other]),
  );
  const filed = computed(() => filedLessons(studies.value));

  // ---- actions: run on the server, or copied when the board only reads

  const live = computed(() => research.value.actions?.enabled === true);
  const offReason = computed(() => readOnlyReason(research.value.actions?.reason, !!research.value.actions));

  async function run<R extends ActionRoute>(route: R, body: ActionBodies[R], command: string): Promise<Outcome> {
    if (!live.value) return { kind: "copied", copied: { command, copied: await copy(command), reason: offReason.value } };
    const result = await options.act(route, body);
    return result.ok ? { kind: "ok", result } : { kind: "error", error: result.error };
  }

  // ---- the channel that is open in the comms room

  const keyOf = (study: Study | null) => (study ? studyKey(study) : null);
  const openKey = ref<string | null>(keyOf(firstStudy(studies.value)));
  const openStudy = computed(() => studies.value.find((study) => studyKey(study) === openKey.value) ?? null);
  // A study that starts waiting comes forward, unless the human is in another one.
  watch(
    () => keyOf(firstStudy(studies.value)),
    (key) => {
      if (!openStudy.value) openKey.value = key;
    },
  );
  function select(study: Study) {
    openKey.value = studyKey(study);
  }

  /** A study an action just started: its channel opens as soon as the research shows it. */
  const awaiting = ref<string | null>(null);
  function follow(slug: string | undefined) {
    awaiting.value = slug ?? null;
    catchUp();
  }
  function catchUp() {
    const study = awaiting.value ? studies.value.find((item) => item.slug === awaiting.value && !item.archived) : null;
    if (!study) return;
    awaiting.value = null;
    select(study);
  }
  watch(studies, catchUp);

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
  /** The reply just sent, while the study's messages do not carry it yet. */
  function echoOf(study: Study) {
    const echo = replies[studyKey(study)]?.echo;
    return echo && study.messages.length <= echo.count ? echo : null;
  }
  /** Whether a reply can go to the study now: not while the analyst works on the last one. */
  const replyReach = (study: Study | null): Reach => (study && echoOf(study) ? "working" : reach(study));

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

  async function sendReply() {
    const study = openStudy.value;
    const text = reply.value;
    if (!study || !text || replyReach(study) !== "ok" || replies[studyKey(study)]?.busy) return;
    const key = studyKey(study);
    const turn = turnKey(study);
    const count = study.messages.length;
    replies[key] = { busy: true, error: "", copied: null, echo: null };
    const state = replies[key]!;
    const outcome = await run("say", { slug: study.slug, text }, sayCommand(study.slug, text));
    state.busy = false;
    if (outcome.kind === "error") {
      state.error = outcome.error;
      return;
    }
    if (outcome.kind === "copied") state.copied = outcome.copied;
    else state.echo = { text, count };
    drafts[key] = "";
    answers[turn] = [];
    custom[turn] = [];
  }

  // ---- the lessons' cards


  const cards = reactive<Record<string, CardState>>({});
  const cardOf = (lesson: Lesson): Readonly<CardState> => cards[lesson.entry.trim()] ?? BLANK_CARD;
  /** The card's state to change: the reactive one, created on first use. */
  function edit(lesson: Lesson): CardState {
    const key = lesson.entry.trim();
    if (!cards[key]) cards[key] = { ...BLANK_CARD };
    return cards[key]!;
  }

  function openForm(lesson: Lesson, form: CardForm) {
    const state = edit(lesson);
    if (state.busy) return;
    Object.assign(state, { form, note: "", error: "", copied: null });
  }
  function setNote(lesson: Lesson, text: string) {
    const state = edit(lesson);
    if (state.form) state.note = text;
  }
  function closeForm(lesson: Lesson) {
    const state = edit(lesson);
    if (!state.busy) Object.assign(state, { form: null, note: "", error: "" });
  }

  const listOf = (stage: Stage): Lesson[] =>
    stage === "declined" ? [...research.value.declined, ...research.value.other] : research.value[stage];

  /** Lessons decided a moment ago stay on their tab while «Отменить» is offered. */
  const held = reactive<Record<string, { lesson: Lesson; stage: Stage; index: number }>>({});
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** `index`: where the lesson stood on its tab before the action, whose refresh has already moved it. */
  function hold(lesson: Lesson, stage: Stage, index: number) {
    const key = lesson.entry.trim();
    held[key] = { lesson, stage, index: Math.max(0, index) };
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => release(key), HOLD_MS));
  }
  function release(key: string) {
    clearTimeout(timers.get(key));
    timers.delete(key);
    delete held[key];
    if (cards[key]) cards[key].done = null;
  }

  async function decide(lesson: Lesson, busy: CardBusy, status: "accepted" | "declined" | "applied", stage: Stage) {
    const state = edit(lesson);
    if (state.busy) return;
    const entry = lesson.entry.trim();
    const index = listOf(stage).findIndex((item) => item.entry.trim() === entry);
    const note = state.form ? state.note.trim() : "";
    const body: LessonBody = { entry, status };
    if (note) body.note = note;
    Object.assign(state, { busy, error: "", copied: null });
    const outcome = await run("lesson", body, lessonCommand(entry, status, note));
    state.busy = null;
    if (outcome.kind === "error") {
      state.error = outcome.error;
      return;
    }
    Object.assign(state, { form: null, note: "" });
    if (outcome.kind === "copied") {
      state.copied = outcome.copied;
      return;
    }
    state.done = { status, undo: status === "applied" ? "accepted" : "proposed" };
    hold(lesson, stage, index);
  }

  const accept = (lesson: Lesson) => decide(lesson, "accept", "accepted", "proposed");
  const decline = (lesson: Lesson) => decide(lesson, "decline", "declined", "proposed");
  const apply = (lesson: Lesson) => decide(lesson, "apply", "applied", "accepted");

  /** «Отменить»: the lesson goes back to where it was. */
  async function undo(lesson: Lesson) {
    const state = edit(lesson);
    if (!state.done || state.busy) return;
    const entry = lesson.entry.trim();
    const status = state.done.undo;
    Object.assign(state, { busy: "undo", error: "" });
    const outcome = await run("lesson", { entry, status }, lessonCommand(entry, status));
    state.busy = null;
    if (outcome.kind === "error") state.error = outcome.error;
    else release(entry);
  }

  /** «Обсудить»: in the study that filed the lesson when it can take a reply, otherwise a new study. */
  async function discuss(lesson: Lesson) {
    const at = filed.value.get(lesson.entry.trim());
    if (at && reach(at.study) === "ok") await clarify(at.id, at.study);
    else openForm(lesson, "discuss");
  }

  async function startDiscussion(lesson: Lesson) {
    const state = edit(lesson);
    if (state.busy) return;
    const body = { order: discussOrder(lesson, state.note), since: "30d" };
    Object.assign(state, { busy: "discuss", error: "", copied: null });
    const outcome = await run("reflect", body, reflectBodyCommand(body, new Date(now.value * 1000)));
    state.busy = null;
    if (outcome.kind === "error") {
      state.error = outcome.error;
      return;
    }
    Object.assign(state, { form: null, note: "" });
    if (outcome.kind === "copied") {
      state.copied = outcome.copied;
      return;
    }
    follow(outcome.result.slug);
    jump("comms");
  }

  // ---- the lab's tabs

  const firstStage = (): Stage => (["proposed", "accepted", "applied"] as const).find((stage) => listOf(stage).length) ?? "proposed";
  const labStage = ref<Stage>(firstStage());
  const shown = computed(() => {
    const list = [...listOf(labStage.value)];
    for (const [key, item] of Object.entries(held)) {
      if (item.stage === labStage.value && !list.some((lesson) => lesson.entry.trim() === key)) list.splice(Math.min(item.index, list.length), 0, item.lesson);
    }
    return list;
  });
  // New proposals bring the lab back to the decisions, unless the human looks at another stage that has lessons. A
  // card's own action empties its tab before the card holds the lesson: the tab stays for its «Отменить».
  watch(
    () => research.value.proposed.length,
    (count, before) => {
      const acting = Object.values(cards).some((card) => card.busy);
      if (count > (before ?? 0) || (!shown.value.length && !acting)) labStage.value = firstStage();
    },
  );
  function showStage(stage: Stage) {
    labStage.value = stage;
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

  async function sendOrder() {
    const result = ordered.value;
    if (orderState.busy) return;
    if ("error" in result) {
      orderState.error = result.error;
      return;
    }
    Object.assign(orderState, { busy: true, error: "", done: null, copied: null });
    const outcome = await run("reflect", result.body, result.command);
    orderState.busy = false;
    if (outcome.kind === "error") {
      orderState.error = outcome.error;
      return;
    }
    if (outcome.kind === "copied") orderState.copied = outcome.copied;
    else {
      orderState.done = outcome.result.slug ?? "";
      follow(outcome.result.slug);
    }
    draft.text = "";
    draft.tasks = "";
  }

  function dispose() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return {
    studies,
    index,
    filed,
    live,
    openKey,
    openStudy,
    select,
    awaiting,
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
    cardOf,
    openForm,
    setNote,
    closeForm,
    accept,
    decline,
    apply,
    undo,
    discuss,
    startDiscussion,
    labStage,
    shown,
    listOf,
    showStage,
    draft,
    ordered,
    orderState,
    order,
    studyRecord,
    sendOrder,
    dispose,
  };
}

export type StationConsole = ReturnType<typeof createConsole>;

export const CONSOLE: InjectionKey<StationConsole> = Symbol("station-console");

export function useConsole(): StationConsole {
  const console = inject(CONSOLE);
  if (!console) throw new Error("A station deck stands outside the station screen");
  return console;
}
