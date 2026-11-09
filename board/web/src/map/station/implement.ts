// The lessons' implementations: «Внедрить» starts a teamster task that makes a lesson's change and opens its PR,
// and the card answers that task's agent when it waits. Part of the station's console.

import { computed, reactive, watch, type Ref } from "vue";
import type { ActionSender, SayBody } from "../../lib/actions";
import { sayCommand } from "../../lib/commands";
import type { Lesson } from "../../types";
import type { Research } from "../research";
import { canImplement, implementBody, startPending } from "../station";
import type { CardState, Copied, Outcome, Stage } from "./console";

/** Why «Внедрить» is off on a board that only reads: it has no command to copy. */
export const IMPLEMENT_OFF = "Доска только читает: внедрение запускается только с доски, где действия включены";

/** The card's reply to its implementation's agent. */
export interface AgentReplyState {
  text: string;
  busy: boolean;
  error: string;
  copied: Copied | null;
  /** The task's turn the reply went to: the field stays off until the task moves on. */
  sent: { slug: string; updated_at: number } | null;
}

const BLANK_AGENT: Readonly<AgentReplyState> = Object.freeze({ text: "", busy: false, error: "", copied: null, sent: null });

/** What the console lends: its research, its actions and its lessons' cards. */
export interface ImplementContext {
  research: Ref<Research>;
  live: Readonly<Ref<boolean>>;
  act: ActionSender;
  run: (route: "say", body: SayBody, command: string) => Promise<Outcome>;
  cardOf: (lesson: Lesson) => Readonly<CardState>;
  edit: (lesson: Lesson) => CardState;
  listOf: (stage: Stage) => Lesson[];
  hold: (lesson: Lesson, stage: Stage, index: number) => void;
}

export function createImplementation({ research, live, act, run, cardOf, edit, listOf, hold }: ImplementContext) {
  /** «Внедрить» is off on a board that only reads, with the reason as its hint. */
  const implementOff = computed(() => (live.value ? null : IMPLEMENT_OFF));
  /** Whether the card offers «Внедрить»: not while its implementation goes, nor while the one it started does not show yet. */
  const offersImplement = (lesson: Lesson) => canImplement(lesson) && !startPending(lesson.implementation, cardOf(lesson).started);

  // A start the server named no slug for takes its task's slug once the lesson shows it, so that the card keeps
  // following that task after it closes.
  watch(research, () => {
    for (const lesson of [...listOf("proposed"), ...listOf("accepted")]) {
      const started = cardOf(lesson).started;
      const task = lesson.implementation;
      if (started && !started.slug && task && !task.archived) edit(lesson).started = { ...started, slug: task.slug };
    }
  });

  /** «Запустить»: the server builds the task from the lesson; a proposed lesson becomes accepted on the way. */
  async function implement(lesson: Lesson, stage: "proposed" | "accepted") {
    const state = edit(lesson);
    if (state.busy || !live.value || !state.repo) return;
    const entry = lesson.entry.trim();
    const index = listOf(stage).findIndex((item) => item.entry.trim() === entry);
    const repo = research.value.repos.find((item) => item.path === state.repo);
    Object.assign(state, { busy: "implement", error: "", copied: null });
    const result = await act("implement", implementBody(entry, state.repo, state.note));
    state.busy = null;
    if (!result.ok) {
      state.error = result.error;
      return;
    }
    Object.assign(state, { form: null, note: "", started: { slug: result.slug ?? "", repo: repo?.name ?? state.repo } });
    // A proposed lesson moves to «к внедрению»: it stays on its tab a moment, like an accepted one.
    if (stage === "proposed") hold(lesson, stage, index);
  }

  // ---- replies to an implementation's agent

  const agents = reactive<Record<string, AgentReplyState>>({});
  const agentOf = (lesson: Lesson): Readonly<AgentReplyState> => agents[lesson.entry.trim()] ?? BLANK_AGENT;
  function agentEdit(lesson: Lesson): AgentReplyState {
    const key = lesson.entry.trim();
    if (!agents[key]) agents[key] = { ...BLANK_AGENT };
    return agents[key]!;
  }
  function setAgentText(lesson: Lesson, text: string) {
    agentEdit(lesson).text = text;
  }
  /** The reply went to the agent's present turn: nothing more to send until the task moves on. */
  function agentSent(lesson: Lesson): boolean {
    const sent = agentOf(lesson).sent;
    const task = lesson.implementation;
    return !!sent && !!task && !task.alive && task.slug === sent.slug && task.updated_at === sent.updated_at;
  }

  /** «Ответить» the implementation's agent: its task takes a say like a study. */
  async function sayToAgent(lesson: Lesson) {
    const task = lesson.implementation;
    const state = agentEdit(lesson);
    const text = state.text.trim();
    if (!task || !text || state.busy || agentSent(lesson)) return;
    const sent = { slug: task.slug, updated_at: task.updated_at };
    Object.assign(state, { busy: true, error: "", copied: null });
    const outcome = await run("say", { slug: task.slug, text }, sayCommand(task.slug, text));
    state.busy = false;
    if (outcome.kind === "error") {
      state.error = outcome.error;
      return;
    }
    state.text = "";
    if (outcome.kind === "copied") state.copied = outcome.copied;
    else state.sent = sent;
  }
  return { implementOff, offersImplement, implement, agentOf, setAgentText, agentSent, sayToAgent };
}
