// The station's console: what the human has picked on every deck of the screen — decisions on lessons, answers to
// the analyst, an order — and the transmitter that copies it all as one command. The decks share one console, so
// a decision taken in the lab and an answer typed in the comms room go out in the same transmission. The board
// never runs the command.

import { computed, inject, nextTick, reactive, ref, watch, type InjectionKey, type Ref } from "vue";
import { transmission } from "../../lib/commands";
import type { Lesson, Study } from "../../types";
import type { Research } from "../research";
import {
  filedLessons,
  firstStudy,
  lessonsByEntry,
  openQuestionsAt,
  orderCommand,
  reach,
  replyText,
  studyKey,
  transmissionFor,
  turnKey,
  type Decision,
  type DecisionStatus,
  type OrderDraft,
  type OrderKind,
} from "../station";

export type Composer = "reply" | "order";

export function createConsole(research: Ref<Research>, now: Ref<number>) {
  const studies = computed(() => research.value.studies);
  const index = computed(() =>
    lessonsByEntry([research.value.proposed, research.value.accepted, research.value.applied, research.value.declined, research.value.other]),
  );
  const filed = computed(() => filedLessons(studies.value));

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
    if (composer.value === "order" && reach(study) === "ok") composer.value = "reply";
  }

  // ---- decisions on lessons

  const decisions = ref<Decision[]>([]);
  const decided = (entry: string) => decisions.value.find((decision) => decision.entry === entry.trim()) ?? null;

  /** Picks a decision, or takes it back when it is picked again. A note belongs to one decision only. */
  function decide(entry: string, id: string, status: DecisionStatus) {
    const key = entry.trim();
    const current = decided(key);
    decisions.value = decisions.value.filter((decision) => decision.entry !== key);
    if (current?.status !== status) decisions.value = [...decisions.value, { entry: key, id, status, note: "" }];
  }
  const drop = (decision: Decision) => (decisions.value = decisions.value.filter((item) => item !== decision));
  /** A lesson id names a staged decision, unless another one shares it: then the whole entry does. */
  const chipName = (decision: Decision) =>
    decisions.value.some((other) => other !== decision && other.id === decision.id) ? decision.entry : decision.id;
  /** The lesson id at the end of an index entry. */
  const lessonId = (lesson: Lesson) => filed.value.get(lesson.entry.trim())?.id ?? lesson.entry.trim().split(/\s+/).pop() ?? lesson.entry;

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
    composer.value = "reply";
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

  // ---- the transmitter

  const composer = ref<Composer>(firstStudy(studies.value) ? "reply" : "order");
  const replyField = ref<HTMLTextAreaElement | null>(null);
  const orderField = ref<HTMLTextAreaElement | null>(null);

  async function focus(field: Ref<HTMLTextAreaElement | null>) {
    await nextTick();
    const area = field.value;
    if (!area) return;
    area.scrollIntoView({ block: "nearest", behavior: "smooth" });
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  /** «Уточнить»: a line about the lesson in the reply to the study that filed it. */
  async function clarify(id: string, study: Study | null = openStudy.value) {
    if (study) openKey.value = studyKey(study);
    composer.value = "reply";
    const prefix = `По уроку ${id}: `;
    if (!free.value.includes(prefix)) free.value = (free.value.trim() ? `${free.value.trim()}\n` : "") + prefix;
    await focus(replyField);
  }

  const target = openStudy;
  const targetReach = computed(() => reach(target.value));
  const questionsAt = computed(() => (target.value ? openQuestionsAt(target.value) : -1));
  const openQuestions = computed(() => (target.value && questionsAt.value >= 0 ? (target.value.messages[questionsAt.value]?.questions ?? []) : []));
  const reply = computed(() =>
    target.value && targetReach.value === "ok" ? replyText(openQuestions.value, answersOf(target.value), free.value) : "",
  );
  const replyCommand = computed(() => transmissionFor(decisions.value, target.value, reply.value));

  const draft = reactive<OrderDraft>({ kind: "batch", tasks: "", since: "30d", repos: "", text: "" });
  const ordered = computed(() => orderCommand(draft, new Date(now.value * 1000)));
  /** Decisions staged on lessons go out with the order. */
  const orderLine = computed(() =>
    "command" in ordered.value ? transmission([transmissionFor(decisions.value, null, ""), ordered.value.command]) : "",
  );
  const orderError = ref("");
  watch(() => ({ ...draft }), () => (orderError.value = ""));

  /** An order of the given kind, ready to be written. */
  async function order(kind: OrderKind) {
    composer.value = "order";
    draft.kind = kind;
    await focus(orderField);
  }

  /** A record from the hold goes into a task order. */
  async function studyRecord(slug: string) {
    const tasks = draft.tasks.split(/[\s,]+/).filter(Boolean);
    if (!tasks.includes(slug)) draft.tasks = [...tasks, slug].join(" ");
    await order("tasks");
  }

  const last = ref<{ command: string; copied: boolean } | null>(null);
  const lastField = ref<HTMLTextAreaElement | null>(null);

  async function send(command: string, after: () => void) {
    if (!command) return;
    let copied = false;
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(command);
      copied = true;
    } catch {
      copied = false;
    }
    last.value = { command, copied };
    after();
    if (!copied) {
      await nextTick();
      lastField.value?.focus();
      lastField.value?.select();
    }
  }

  function sendReply() {
    const study = target.value;
    // The say goes out only when there is a text for a study that can take it; otherwise the draft stays.
    const answered = !!reply.value && !!study && targetReach.value === "ok";
    void send(replyCommand.value, () => {
      decisions.value = [];
      if (answered && study) {
        drafts[studyKey(study)] = "";
        answers[turnKey(study)] = [];
        custom[turnKey(study)] = [];
      }
    });
  }

  function sendOrder() {
    const result = ordered.value;
    if ("error" in result) {
      orderError.value = result.error;
      return;
    }
    orderError.value = "";
    void send(orderLine.value, () => {
      decisions.value = [];
      draft.text = "";
      draft.tasks = "";
    });
  }

  return {
    studies,
    index,
    filed,
    openKey,
    openStudy,
    select,
    decisions,
    decided,
    decide,
    drop,
    chipName,
    lessonId,
    answersOf,
    customOf,
    choose,
    ownAnswer,
    free,
    composer,
    replyField,
    orderField,
    clarify,
    target,
    targetReach,
    reply,
    replyCommand,
    draft,
    ordered,
    orderLine,
    orderError,
    order,
    studyRecord,
    last,
    lastField,
    sendReply,
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

