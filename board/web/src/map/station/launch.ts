// What the lesson's thread and the lab's rows show beside the research: the steps of a start the server runs in the
// background, the row's label, decisions shown before the server confirms them, and the channels of studies just
// ordered. Pure data for the station's console.

import type { Implementation, Launch, LaunchStage, Lesson, LessonStatus, Phase, Study } from "../../types";
import type { Research } from "../research";
import { implementationLine, outsideOf, startPending, type Started } from "../station";

// ---- the steps of a start

const STEP_TEXT: Record<Exclude<LaunchStage, "done" | "failed" | "starting">, [string, string]> = {
  accepting: ["Принимаю урок", "Урок принят"],
  fetching: ["Обновляю репозиторий", "Репозиторий обновлён"],
  worktree: ["Создаю рабочую копию", "Рабочая копия создана"],
  preparing: ["Собираю записи", "Записи собраны"],
};
const STARTING: Record<Launch["kind"], [string, string]> = {
  implement: ["Запускаю агента", "Агент запущен"],
  reflect: ["Запускаю аналитика", "Аналитик запущен"],
};

export const terminal = (stage: LaunchStage) => stage === "done" || stage === "failed";

/** One line of a start: `running` goes on, `failed` is the step the start broke at. */
export interface LaunchStep {
  stage: LaunchStage;
  text: string;
  state: "done" | "running" | "failed";
  /** How long the step went, or has gone so far. */
  seconds: number;
}

/** The steps of a start in their order, each with how long it went; a stage the server skipped has no line. */
export function launchSteps(launch: Launch, now: number): LaunchStep[] {
  const steps = [...launch.steps];
  // The last step is the stage; a start known only by its stage stands at its beginning.
  if (steps.at(-1)?.stage !== launch.stage) steps.push({ stage: launch.stage, at: steps.at(-1)?.at ?? launch.started_at });
  const out: LaunchStep[] = [];
  steps.forEach((step, index) => {
    if (terminal(step.stage)) return;
    const next = steps[index + 1];
    const [going, done] = step.stage === "starting" ? STARTING[launch.kind] : STEP_TEXT[step.stage as keyof typeof STEP_TEXT];
    const state = !next ? "running" : next.stage === "failed" ? "failed" : "done";
    out.push({ stage: step.stage, text: state === "done" ? done : going, state, seconds: Math.max(0, (next?.at ?? now) - step.at) });
  });
  return out;
}

/** «0,4 с», «12 с», «1 мин 5 с». */
export function stepTime(seconds: number): string {
  if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1).replace(".", ",")} с`;
  if (seconds < 60) return `${Math.round(seconds)} с`;
  const whole = Math.round(seconds);
  const rest = whole % 60;
  return `${Math.floor(whole / 60)} мин${rest ? ` ${rest} с` : ""}`;
}

/** The stage a start shows before the server answers: a proposed lesson is accepted first. */
export function firstStage(kind: Launch["kind"], status: LessonStatus | null): LaunchStage {
  if (kind === "reflect") return "preparing";
  return status === "proposed" ? "accepting" : "fetching";
}

/** A start as the screen shows it before the server answered. */
export function localLaunch(kind: Launch["kind"], stage: LaunchStage, at: number, patch: Partial<Launch> = {}): Launch {
  return { slug: "", kind, entry: null, repo: null, stage, steps: [{ stage, at }], error: null, started_at: at, ...patch };
}

const progress = (launch: Launch) => [launch.started_at, launch.steps.at(-1)?.at ?? launch.started_at, launch.steps.length] as const;
/** Whether `a` is the later news of a start than `b`. */
function later(a: Launch, b: Launch): boolean {
  const [x, y] = [progress(a), progress(b)];
  for (let index = 0; index < x.length; index++) if (x[index] !== y[index]) return x[index]! > y[index]!;
  return false;
}

/** The starts of `research.launches` and the `launch` messages, the latest news of each slug. */
export function mergeLaunches(...lists: readonly (readonly Launch[])[]): Launch[] {
  const bySlug = new Map<string, Launch>();
  for (const list of lists) {
    for (const launch of list) {
      const known = bySlug.get(launch.slug);
      if (!known || later(launch, known)) bySlug.set(launch.slug, launch);
    }
  }
  return [...bySlug.values()];
}

/** The newest start of a lesson's implementation. */
export function lessonLaunch(launches: readonly Launch[], entry: string): Launch | null {
  const key = entry.trim();
  let found: Launch | null = null;
  for (const launch of launches) {
    if (launch.kind === "implement" && launch.entry?.trim() === key && (!found || launch.started_at > found.started_at)) found = launch;
  }
  return found;
}

// ---- the row of a lesson

export type Badge = "запускается" | "агент работает" | "нужен ответ" | "PR готов" | "правка готова" | "остановился" | "не запустился";

export const BADGE_TONE: Record<Badge, "teal" | "wait" | "green" | "red"> = {
  запускается: "teal",
  "агент работает": "teal",
  "нужен ответ": "wait",
  "PR готов": "green",
  "правка готова": "green",
  остановился: "wait",
  "не запустился": "red",
};

/** What the lesson's start is: sent and not answered yet, the server's start, or an older server's `started`. */
export interface LessonStart {
  sending: boolean;
  launch: Launch | null;
  started: Started | null;
}

/** Whether the research shows the task the start made as the lesson's implementation, open or closed by now. */
const startedTask = (implementation: Implementation | null | undefined, launch: Launch) => !!implementation && implementation.slug === launch.slug;

/** The label on the right of a lesson's row, or none. */
export function lessonBadge(lesson: Lesson, start: LessonStart): Badge | null {
  const task = lesson.implementation;
  if (start.sending) return "запускается";
  const launch = start.launch;
  if (launch && !startedTask(task, launch)) {
    if (launch.stage === "failed") return "не запустился";
    // Started, until the research shows the task.
    return "запускается";
  }
  if (lesson.status !== "proposed" && lesson.status !== "accepted") return null;
  const line = implementationLine(task, start.started, outsideOf(lesson));
  switch (line?.kind) {
    case "started":
      return "запускается";
    case "working":
      return "агент работает";
    case "decision":
      return "нужен ответ";
    case "pr":
      return "PR готов";
    case "outside":
      return "правка готова";
    case "stopped":
      return "остановился";
    default:
      return null;
  }
}

/** Whether the lesson's start still goes: «Внедрить» waits for it. */
export function launching(lesson: Pick<Lesson, "implementation">, start: LessonStart): boolean {
  if (start.sending) return true;
  if (start.launch) return start.launch.stage !== "failed" && !startedTask(lesson.implementation, start.launch);
  return startPending(lesson.implementation, start.started);
}

/** The task's phase in plain words while its agent works. */
export function phaseText(phase: Phase | null | undefined): string | null {
  if (phase === "turn" || phase === "fix") return "Работа";
  if (phase === "check") return "Проверка";
  if (phase === "review") return "Ревью";
  if (phase === "ci") return "CI";
  return null;
}

// ---- decisions shown at once

/** A decision sent to the server; `confirmed`: the server took it, and the next research is the truth. */
export interface Decision {
  status: LessonStatus;
  note: string;
  confirmed: boolean;
}

type Lists = Pick<Research, "proposed" | "accepted" | "applied" | "declined" | "other">;
const STATUSES = ["proposed", "accepted", "applied", "declined", "other"] as const;

/** The lessons as they stand once the decisions in flight land: each one moves to its new status's list. */
export function withDecisions(lists: Lists, decisions: Readonly<Record<string, Decision>>): Lists {
  if (!Object.keys(decisions).length) return lists;
  const out = Object.fromEntries(STATUSES.map((status) => [status, [] as Lesson[]])) as unknown as Lists;
  const moved: Lesson[] = [];
  for (const status of STATUSES) {
    for (const lesson of lists[status]) {
      const decision = decisions[lesson.entry.trim()];
      if (!decision || decision.status === lesson.status) out[status].push(lesson);
      else moved.push({ ...lesson, status: decision.status, status_text: decision.note ? `${decision.status}: ${decision.note}` : decision.status });
    }
  }
  // Newest first, like the research's lists.
  for (const lesson of moved) {
    const list = out[lesson.status];
    const at = list.findIndex((item) => item.date < lesson.date);
    list.splice(at < 0 ? list.length : at, 0, lesson);
  }
  return out;
}

// ---- studies just ordered

/** A study ordered from this screen, shown as a channel until the research has it. */
export interface PendingStudy {
  id: string;
  /** The order's text; null for a planned batch without one. */
  order: string | null;
  mode: Study["mode"];
  at: number;
  /** Named by the server's answer. */
  slug: string | null;
  /** The server's start; null before its answer, and from an older server. */
  launch: Launch | null;
}

export const pendingKey = (study: Pick<PendingStudy, "id">) => `pending:${study.id}`;

/** Which waiting channels the research now shows as studies, and which still wait. */
export function settlePending(pending: readonly PendingStudy[], studies: readonly Study[]): { left: PendingStudy[]; found: { pending: PendingStudy; study: Study }[] } {
  const left: PendingStudy[] = [];
  const found: { pending: PendingStudy; study: Study }[] = [];
  for (const item of pending) {
    const study = item.slug ? studies.find((candidate) => candidate.slug === item.slug && !candidate.archived) : undefined;
    if (study) found.push({ pending: item, study });
    else left.push(item);
  }
  return { left, found };
}
