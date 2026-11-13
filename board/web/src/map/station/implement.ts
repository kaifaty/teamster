// The lessons' implementations: «Внедрить» starts a teamster task that makes a lesson's change and opens its PR, and
// the lesson's thread follows it — the request, the start's steps, the agent's state with its phase and last action —
// and answers the agent when it waits. Part of the station's console.

import { computed, reactive, watch, type Ref } from "vue";
import type { ActionSender, SayBody } from "../../lib/actions";
import { sayCommand } from "../../lib/commands";
import type { Launch, LaunchStage, Lesson, TaskSummary } from "../../types";
import type { Research } from "../research";
import { canImplement, implementBody, startPending } from "../station";
import type { CardState, Stage } from "./cards";
import type { Copied, Outcome } from "./console";
import { firstStage, launching, lessonBadge, lessonLaunch, localLaunch, phaseText, type LessonStart } from "./launch";

/** Why «Внедрить» is off on a board that only reads: it has no command to copy. */
export const IMPLEMENT_OFF = "Доска только читает: внедрение запускается только с доски, где действия включены";

/** A reply to the agent, shown in the thread at once: `sending` until the server answers. */
export interface Said {
  text: string;
  at: number;
  state: "sending" | "sent" | "failed";
  error: string;
}

/** The thread's reply to its implementation's agent. */
export interface AgentReplyState {
  text: string;
  busy: boolean;
  error: string;
  copied: Copied | null;
  /** The task's turn the reply went to: the field stays off until the task moves on. */
  sent: { slug: string; updated_at: number } | null;
  said: Said[];
}

const BLANK_AGENT: Readonly<AgentReplyState> = Object.freeze({ text: "", busy: false, error: "", copied: null, sent: null, said: [] });

/** «Запустить» from this tab: what was asked, and what the server answered. */
export interface ImplementRequest {
  at: number;
  /** The repository's name, and its path for «Запустить снова». */
  repo: string;
  path: string;
  note: string;
  /** The stage shown before the server answers. */
  stage: LaunchStage;
  sending: boolean;
  /** The server's start; null before its answer and from an older server. */
  launch: Launch | null;
}

/** What the station's screen lends the console to leave for the map. */
export interface ShipOptions {
  /** Opens the system of the task `slug` on the map, with its card. */
  openShip?: (slug: string, repo: string) => void;
}

/** What the console lends: its research, its actions and its lessons' cards. */
export interface ImplementContext extends ShipOptions {
  research: Ref<Research>;
  now: Readonly<Ref<number>>;
  live: Readonly<Ref<boolean>>;
  act: ActionSender;
  run: (route: "say", body: SayBody, command: string) => Promise<Outcome>;
  /** Every start the server reported, the latest news of each. */
  launches: Readonly<Ref<readonly Launch[]>>;
  /** The board's tasks by slug, with their phase and last action. */
  tasks: Readonly<Ref<Readonly<Record<string, TaskSummary>>>>;
  cardOf: (lesson: Lesson) => Readonly<CardState>;
  edit: (lesson: Lesson) => CardState;
  openForm: (lesson: Lesson, form: "implement") => void;
  listOf: (stage: Stage) => Lesson[];
  hold: (lesson: Lesson, stage: Stage, index: number) => void;
}

export function createImplementation(context: ImplementContext) {
  const { research, now, live, act, run, launches, tasks, cardOf, edit, listOf, hold, openShip } = context;
  /** «Внедрить» is off on a board that only reads, with the reason as its hint. */
  const implementOff = computed(() => (live.value ? null : IMPLEMENT_OFF));

  const requests = reactive<Record<string, ImplementRequest>>({});
  const requestOf = (lesson: Lesson): Readonly<ImplementRequest> | null => requests[lesson.entry.trim()] ?? null;

  /** The lesson's start: the one asked from this tab, or the newest the server reports. */
  function launchOf(lesson: Lesson): Launch | null {
    const request = requestOf(lesson);
    const entry = lesson.entry.trim();
    if (request?.sending) return localLaunch("implement", request.stage, request.at, { entry, repo: request.repo });
    if (request?.launch) return launches.value.find((launch) => launch.slug === request.launch!.slug) ?? request.launch;
    // An older server's start has no steps.
    if (request) return null;
    return lessonLaunch(launches.value, entry);
  }
  const startOf = (lesson: Lesson): LessonStart => ({ sending: !!requestOf(lesson)?.sending, launch: launchOf(lesson), started: cardOf(lesson).started });
  const badgeOf = (lesson: Lesson) => lessonBadge(lesson, startOf(lesson));
  /** Whether the lesson's start still goes. */
  const startGoes = (lesson: Lesson) => launching(lesson, startOf(lesson));
  /** Whether the lesson offers «Внедрить»: not while its implementation goes, nor while a start does. */
  const offersImplement = (lesson: Lesson) => canImplement(lesson) && !startGoes(lesson);

  // A start an older server named no slug for takes its task's slug once the lesson shows it, so that the thread keeps
  // following that task after it closes.
  watch(research, () => {
    for (const lesson of [...listOf("proposed"), ...listOf("accepted")]) {
      const started = cardOf(lesson).started;
      const task = lesson.implementation;
      if (started && !started.slug && task && !task.archived) edit(lesson).started = { ...started, slug: task.slug };
    }
  });

  /**
   * «Запустить»: the form closes and the request with its first step shows at once; the server builds the task from
   * the lesson, and a proposed lesson becomes accepted on the way. The server's refusal brings the form back.
   */
  async function implement(lesson: Lesson, stage: "proposed" | "accepted") {
    const state = edit(lesson);
    const entry = lesson.entry.trim();
    if (state.busy || !live.value || !state.repo || requests[entry]?.sending) return;
    const index = listOf(stage).findIndex((item) => item.entry.trim() === entry);
    const path = state.repo;
    const note = state.note;
    const repo = research.value.repos.find((item) => item.path === path)?.name ?? path;
    requests[entry] = { at: now.value, repo, path, note: note.trim(), stage: firstStage("implement", lesson.status), sending: true, launch: null };
    Object.assign(state, { form: null, note: "", error: "", copied: null });
    // A proposed lesson moves to «к внедрению»: it stays on its tab a moment, like an accepted one.
    if (stage === "proposed") hold(lesson, stage, index);
    const result = await act("implement", implementBody(entry, path, note));
    const request = requests[entry]!;
    if (!result.ok) {
      delete requests[entry];
      Object.assign(state, { form: "implement", repo: path, note, error: result.error });
      return;
    }
    request.sending = false;
    request.launch = result.launch ?? null;
    // An older server answers once the task has started, without its steps: the lesson moves only now, and its row
    // stays on the tab a moment from this answer.
    if (!result.launch) {
      state.started = { slug: result.slug ?? "", repo };
      if (stage === "proposed") hold(lesson, stage, index);
    }
  }

  /** «Запустить снова»: the form with the repository of the start that failed. */
  function retry(lesson: Lesson) {
    const launch = launchOf(lesson);
    const path = requestOf(lesson)?.path ?? research.value.repos.find((repo) => repo.name === launch?.repo)?.path;
    context.openForm(lesson, "implement");
    const state = edit(lesson);
    if (path && state.form === "implement") state.repo = path;
  }

  /** The ship that implements the lesson: its task's slug and system, while the task is open. */
  function shipOf(lesson: Lesson): { slug: string; repo: string } | null {
    const started = cardOf(lesson).started;
    const task = lesson.implementation;
    const launch = launchOf(lesson);
    if (launch?.slug && launch.repo && launch.stage === "done" && task?.slug !== launch.slug) return { slug: launch.slug, repo: launch.repo };
    if (started && startPending(task, started)) return started.slug ? { slug: started.slug, repo: started.repo } : null;
    return task && !task.archived ? { slug: task.slug, repo: task.repo } : null;
  }

  /** «Посмотреть»: the station gives way to the ship's system on the map, with the ship's card open. */
  function watchAgent(lesson: Lesson) {
    const ship = shipOf(lesson);
    if (ship) openShip?.(ship.slug, ship.repo);
  }

  /** While the agent works: the task's phase in plain words and its last action, live from the board. */
  function workOf(lesson: Lesson): { phase: string | null; activity: string | null } | null {
    const task = lesson.implementation;
    if (!task?.alive) return null;
    const summary = tasks.value[task.slug];
    return { phase: phaseText(summary?.phase) ?? "Работа", activity: summary?.alive ? (summary.activity?.text ?? null) : null };
  }

  // ---- replies to an implementation's agent

  const agents = reactive<Record<string, AgentReplyState>>({});
  const agentOf = (lesson: Lesson): Readonly<AgentReplyState> => agents[lesson.entry.trim()] ?? BLANK_AGENT;
  function agentEdit(lesson: Lesson): AgentReplyState {
    const key = lesson.entry.trim();
    if (!agents[key]) agents[key] = { ...BLANK_AGENT, said: [] };
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

  /** «Ответить» the implementation's agent: the reply shows in the thread at once, and its text comes back on an error. */
  async function sayToAgent(lesson: Lesson) {
    const task = lesson.implementation;
    const state = agentEdit(lesson);
    const text = state.text.trim();
    if (!task || !text || state.busy || agentSent(lesson)) return;
    const sent = { slug: task.slug, updated_at: task.updated_at };
    Object.assign(state, { busy: true, error: "", copied: null });
    let said: Said | null = null;
    if (live.value) {
      state.said.push({ text, at: now.value, state: "sending", error: "" });
      said = state.said.at(-1)!;
      state.text = "";
    }
    const outcome = await run("say", { slug: task.slug, text }, sayCommand(task.slug, text));
    state.busy = false;
    if (outcome.kind === "error") {
      if (said) Object.assign(said, { state: "failed", error: outcome.error });
      else state.error = outcome.error;
      if (!state.text.trim()) state.text = text;
      return;
    }
    state.text = "";
    if (said) said.state = "sent";
    if (outcome.kind === "copied") state.copied = outcome.copied;
    else state.sent = sent;
  }
  return {
    implementOff, offersImplement, startGoes, requestOf, launchOf, badgeOf, implement, retry, shipOf, watchAgent, workOf,
    agentOf, setAgentText, agentSent, sayToAgent,
  };
}
