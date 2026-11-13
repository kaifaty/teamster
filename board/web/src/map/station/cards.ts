// The lessons' cards: each lesson's open form and its decision. A decision shows at once — on the lesson's row and in
// its thread — and goes back with the server's error; for a few seconds after it the lesson stays on its tab and
// «Отменить» takes it back. Part of the station's console.

import { computed, reactive, ref, watch, type Ref } from "vue";
import type { LessonBody } from "../../lib/actions";
import { lessonCommand } from "../../lib/commands";
import type { Lesson, LessonStatus } from "../../types";
import type { Research } from "../research";
import { defaultRepo, lessonsByEntry, type Started } from "../station";
import type { Copied, Outcome } from "./console";
import { withDecisions, type Decision } from "./launch";

export type Stage = "proposed" | "accepted" | "applied" | "declined";

/** How long a lesson shows «Принято · Отменить» before it leaves the tab. */
export const HOLD_MS = 8000;

export type CardForm = "decline" | "apply" | "discuss" | "implement";
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
  /** «Репозиторий»: a repository's path, empty until one is picked. */
  repo: string;
  /** The task an older server started before it answered, shown until the research carries it. */
  started: Started | null;
}

const BLANK_CARD: Readonly<CardState> = Object.freeze({ form: null, note: "", busy: null, error: "", done: null, copied: null, repo: "", started: null });

export interface CardsContext {
  research: Ref<Research>;
  live: Readonly<Ref<boolean>>;
  run: (route: "lesson", body: LessonBody, command: string) => Promise<Outcome>;
}

export function createCards({ research, live, run }: CardsContext) {
  /** Decisions in flight, by entry: the lessons show them before the research does. */
  const decisions = reactive<Record<string, Decision>>({});
  const lists = computed(() => withDecisions(research.value, decisions));
  /** The research with the decisions in flight. */
  const view = computed<Research>(() => ({ ...research.value, ...lists.value }));
  const index = computed(() => lessonsByEntry([lists.value.proposed, lists.value.accepted, lists.value.applied, lists.value.declined, lists.value.other]));
  // Once the server took a decision, the next research tells how the lesson stands.
  watch(research, () => {
    for (const [key, decision] of Object.entries(decisions)) if (decision.confirmed) delete decisions[key];
  });
  function confirm(entry: string, status: LessonStatus) {
    const decision = decisions[entry];
    if (!decision) return;
    const shown = lessonsByEntry([research.value.proposed, research.value.accepted, research.value.applied, research.value.declined, research.value.other]).get(entry);
    if (shown?.status === status) delete decisions[entry];
    else decision.confirmed = true;
  }

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
    if (form === "implement" && !live.value) return;
    // «Внедрено» after the agent's PR names the PR.
    const note = form === "apply" ? (lesson.implementation?.pr ?? "") : "";
    Object.assign(state, { form, note, error: "", copied: null });
    if (form === "implement") state.repo = defaultRepo(lesson, research.value.repos);
  }
  function setRepo(lesson: Lesson, path: string) {
    const state = edit(lesson);
    if (state.form === "implement") state.repo = path;
  }
  function setNote(lesson: Lesson, text: string) {
    const state = edit(lesson);
    if (state.form) state.note = text;
  }
  function closeForm(lesson: Lesson) {
    const state = edit(lesson);
    if (!state.busy) Object.assign(state, { form: null, note: "", error: "" });
  }

  const listOf = (stage: Stage): Lesson[] => (stage === "declined" ? [...lists.value.declined, ...lists.value.other] : lists.value[stage]);

  /** Lessons decided a moment ago stay on their tab while «Отменить» is offered. */
  const held = reactive<Record<string, { lesson: Lesson; stage: Stage; index: number }>>({});
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** `index`: where the lesson stood on its tab before the action. */
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
    const before = { form: state.form, note: state.note };
    const note = state.form ? state.note.trim() : "";
    const body: LessonBody = { entry, status };
    if (note) body.note = note;
    Object.assign(state, { busy, error: "", copied: null });
    // A board that acts shows the decision at once; one that only reads copies the command.
    const optimistic = live.value;
    if (optimistic) {
      decisions[entry] = { status, note, confirmed: false };
      Object.assign(state, { form: null, note: "", done: { status, undo: status === "applied" ? "accepted" : "proposed" } });
      hold(lesson, stage, index);
    }
    const outcome = await run("lesson", body, lessonCommand(entry, status, note));
    state.busy = null;
    if (outcome.kind === "error") {
      delete decisions[entry];
      release(entry);
      Object.assign(state, before, { error: outcome.error });
      return;
    }
    Object.assign(state, { form: null, note: "" });
    if (outcome.kind === "copied") state.copied = outcome.copied;
    else confirm(entry, status);
  }

  const accept = (lesson: Lesson) => decide(lesson, "accept", "accepted", "proposed");
  const decline = (lesson: Lesson) => decide(lesson, "decline", "declined", "proposed");
  const apply = (lesson: Lesson) => decide(lesson, "apply", "applied", "accepted");

  /** «Отменить»: the lesson goes back to where it was, at once; the server's error puts the decision back. */
  async function undo(lesson: Lesson) {
    const state = edit(lesson);
    const done = state.done;
    if (!done || state.busy) return;
    const entry = lesson.entry.trim();
    const kept = held[entry] ? { ...held[entry]! } : null;
    Object.assign(state, { busy: "undo", error: "" });
    decisions[entry] = { status: done.undo, note: "", confirmed: false };
    release(entry);
    const outcome = await run("lesson", { entry, status: done.undo }, lessonCommand(entry, done.undo));
    state.busy = null;
    if (outcome.kind === "error") {
      decisions[entry] = { status: done.status, note: "", confirmed: true };
      state.done = done;
      if (kept) hold(kept.lesson, kept.stage, kept.index);
      state.error = outcome.error;
    } else confirm(entry, done.undo);
  }

  // ---- the lab's tabs

  const firstStage = (): Stage => (["proposed", "accepted", "applied"] as const).find((stage) => listOf(stage).length) ?? "proposed";
  const labStage = ref<Stage>(firstStage());
  const shown = computed(() => {
    const list = [...listOf(labStage.value)];
    for (const [key, item] of Object.entries(held)) {
      // The lesson as it stands now, in its old place.
      if (item.stage === labStage.value && !list.some((lesson) => lesson.entry.trim() === key)) list.splice(Math.min(item.index, list.length), 0, index.value.get(key) ?? item.lesson);
    }
    return list;
  });
  /** Whether the row stays on its tab only for «Отменить»: its lesson has moved on. */
  const isHeld = (lesson: Lesson) => {
    const key = lesson.entry.trim();
    return held[key]?.stage === labStage.value && !listOf(labStage.value).some((item) => item.entry.trim() === key);
  };
  // New proposals bring the lab back to the decisions, unless the human looks at another stage that has lessons. A
  // decision just taken empties its tab before the lesson is held there: the tab stays for its «Отменить».
  watch(
    () => lists.value.proposed.length,
    (count, before) => {
      const acting = Object.values(cards).some((card) => card.busy);
      if (count > (before ?? 0) || (!shown.value.length && !acting)) labStage.value = firstStage();
    },
  );

  function dispose() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return {
    view, index, cardOf, edit, openForm, setRepo, setNote, closeForm, listOf, hold, accept, decline, apply, undo,
    labStage, shown, isHeld, dispose,
  };
}
