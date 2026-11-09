// The science station as a conversation: who speaks, which docket and which questions are live, what the human
// should do next, and the bodies of the actions the station's buttons send. Pure data for the station's screen.

import type { ImplementBody, ReflectBody } from "../lib/actions";
import { answerText, reflectCommand, reflectSlug } from "../lib/commands";
import type { Implementation, Lesson, PendingRecord, ResearchRepo, Signal, Study, StudyMessage, StudyQuestion } from "../types";
import type { Research } from "./research";
import type { Clock } from "./schedule";

export type StudyState = "working" | "waiting" | "failed" | "idle" | "closed";

/** Turn outcomes after which the analyst did not answer. */
const FAILED = new Set(["failed", "unavailable", "budget_exhausted", "stuck", "refused", "unknown"]);

export function studyState(study: Study): StudyState {
  if (study.alive) return "working";
  if (study.waiting) return "waiting";
  if (study.outcome && FAILED.has(study.outcome)) return "failed";
  return study.archived ? "closed" : "idle";
}

export const STATE_TEXT: Record<StudyState, string> = {
  working: "аналитик работает",
  waiting: "ждёт ответа",
  failed: "ход прервался",
  idle: "ответ получен",
  closed: "закрыто",
};

/** The order's first line, or what a study without an order is. */
export function studyTitle(study: Study): string {
  const order = study.messages[0]?.from === "lead" ? study.messages[0].text : null;
  const line = order?.trim().split("\n")[0]?.trim();
  if (line) return line.length > 90 ? `${line.slice(0, 89)}…` : line;
  return study.mode === "batch" ? "Плановый разбор" : "Разбор по приказу";
}

/** A study's own key: a slug may be reused after its record was archived. */
export const studyKey = (study: Study) => `${study.slug}:${study.created}`;

/** The key of the analyst turn whose questions are open: answers belong to one turn, not to the study. */
export function turnKey(study: Study): string {
  const at = openQuestionsAt(study);
  return `${studyKey(study)}@${at >= 0 ? study.messages[at]!.at : "none"}`;
}

/** The channel the station opens first: one that waits for the human, then one at work, then the newest. */
export function firstStudy(studies: readonly Study[]): Study | null {
  return studies.find((study) => study.waiting) ?? studies.find((study) => study.alive) ?? studies[0] ?? null;
}

/** For every lesson id of a study, the index of the last message that carries it: its docket is shown there. */
export function docketPlacement(messages: readonly StudyMessage[]): Map<string, number> {
  const last = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const lesson of message.lessons) last.set(lesson.id, index);
  });
  return last;
}

/** The index of the analyst message whose questions wait for the human, or -1. */
export function openQuestionsAt(study: Study): number {
  if (!study.waiting) return -1;
  const index = study.messages.length - 1;
  const message = study.messages[index];
  return message?.from === "analyst" && message.questions.length ? index : -1;
}

/** Whether a say can reach the study now. */
export type Reach = "ok" | "working" | "closed";
export function reach(study: Study | null): Reach {
  if (!study || study.archived) return "closed";
  return study.alive ? "working" : "ok";
}

/** What goes to the analyst: one numbered line per answered question, then the free text. */
export function replyText(questions: readonly StudyQuestion[], answers: readonly string[], free: string): string {
  return [answerText([...questions], [...answers]), free.trim()].filter(Boolean).join("\n");
}

/** Cmd+Enter or Ctrl+Enter sends a reply. */
export const isSendKey = (event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "isComposing">) =>
  event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing;

export type OrderKind = "batch" | "tasks" | "question";

export interface OrderDraft {
  kind: OrderKind;
  /** Task slugs, separated by spaces or commas. */
  tasks: string;
  /** For a question: YYYY-MM-DD or Nd. */
  since: string;
  /** Repository names, separated by spaces or commas. */
  repos: string;
  text: string;
}

const words = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** A period `teamster reflect --since` accepts: a real calendar date or a number of days. */
export function validSince(value: string): boolean {
  if (/^\d{1,3}d$/.test(value)) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A new order as the board server takes it, with the equivalent `teamster reflect` command, or why it cannot go yet. */
export function orderAction(draft: OrderDraft, now: Date): { body: ReflectBody; command: string } | { error: string } {
  const order = draft.text.trim() || undefined;
  let body: ReflectBody;
  if (draft.kind === "tasks") {
    const tasks = words(draft.tasks);
    if (!tasks.length) return { error: "Назови хотя бы одну задачу" };
    body = { tasks };
  } else if (draft.kind === "question") {
    if (!order) return { error: "Сформулируй вопрос" };
    const since = draft.since.trim();
    const repos = words(draft.repos);
    if (since && !validSince(since)) return { error: "Срок — дата ГГГГ-ММ-ДД или число дней, например 14d" };
    // Without a period or projects teamster would run a batch and move its through: stamp.
    if (!since && !repos.length) return { error: "Укажи срок или проекты" };
    body = {};
    if (since) body.since = since;
    if (repos.length) body.repos = repos;
  } else body = {};
  if (order) body.order = order;
  return { body, command: reflectBodyCommand(body, now) };
}

/** The `teamster reflect` command that does what the body asks. */
export const reflectBodyCommand = (body: ReflectBody, now: Date) => reflectCommand({ slug: reflectSlug(now), ...body });

/** The file of a lesson's report: its index entry without the lesson id. */
export function lessonFile(entry: string): string {
  const words = entry.trim().split(/\s+/);
  return words.length > 1 ? words.slice(0, -1).join(" ") : entry.trim();
}

/** The order of a new study that discusses a lesson; the human's question follows after an empty line. */
export function discussOrder(lesson: Pick<Lesson, "entry" | "cue" | "title">, question: string): string {
  const entry = lesson.entry.trim();
  const order =
    `Обсуждаем урок ${entry} («${lesson.title?.trim() || lesson.cue}»). Прочитай его раздел в файле ${lessonFile(entry)} и записи из его доказательств. ` +
    "Ответь на вопрос ниже; если урок стоит уточнить или переписать — предложи новую редакцию.";
  return question.trim() ? `${order}\n\n${question.trim()}` : order;
}

/** The lesson of the index behind a docket, by its entry. */
export function lessonsByEntry(lists: readonly (readonly Lesson[])[]): Map<string, Lesson> {
  const map = new Map<string, Lesson>();
  for (const list of lists) for (const lesson of list) map.set(lesson.entry.trim(), lesson);
  return map;
}

export const LESSON_STATE: Record<Lesson["status"], string> = {
  proposed: "ждёт решения",
  accepted: "принят, ждёт внедрения",
  applied: "внедрён",
  declined: "отклонён",
  other: "",
};

/** What the station's top bar counts. */
export interface StationCounts {
  /** Questions the analyst waits to have answered, over every waiting study. */
  questions: number;
  waiting: number;
  proposed: number;
  accepted: number;
  applied: number;
  declined: number;
  records: number;
  signals: number;
}

export function stationCounts(research: Research): StationCounts {
  const questions = research.studies.reduce((sum, study) => {
    const at = openQuestionsAt(study);
    return sum + (at >= 0 ? study.messages[at]!.questions.length : 0);
  }, 0);
  return {
    questions,
    waiting: research.waiting,
    proposed: research.proposed.length,
    accepted: research.accepted.length,
    applied: research.applied.length,
    declined: research.declined.length,
    records: research.pending.records,
    signals: research.pending.signals,
  };
}

/** A lesson as the analyst filed it: the newest docket with this entry, and the study it stands in. */
export interface Filed {
  study: Study;
  id: string;
  lesson: string | null;
  proposal: string | null;
}

/** For every lesson entry, the newest docket that carries it; studies come newest first. */
export function filedLessons(studies: readonly Study[]): Map<string, Filed> {
  const filed = new Map<string, Filed>();
  for (const study of studies) {
    for (let at = study.messages.length - 1; at >= 0; at--) {
      for (const lesson of study.messages[at]!.lessons) {
        const entry = lesson.entry.trim();
        if (!filed.has(entry)) filed.set(entry, { study, id: lesson.id, lesson: lesson.lesson, proposal: lesson.proposal });
      }
    }
  }
  return filed;
}

/** How many records carry each signal, most first. */
export function signalTally(items: readonly PendingRecord[]): { signal: Signal; count: number }[] {
  const counts = new Map<Signal, number>();
  for (const item of items) for (const signal of new Set(item.signals)) counts.set(signal, (counts.get(signal) ?? 0) + 1);
  return [...counts].map(([signal, count]) => ({ signal, count })).sort((a, b) => b.count - a.count || a.signal.localeCompare(b.signal));
}

/** The analyst's post: at work in a study, waiting for an answer, stopped by a failed turn, or free. */
export type AnalystState = "working" | "waiting" | "failed" | "free";

export function analystOnDuty(studies: readonly Study[]): { state: AnalystState; study: Study | null } {
  const working = studies.find((study) => study.alive);
  if (working) return { state: "working", study: working };
  const waiting = studies.find((study) => study.waiting);
  if (waiting) return { state: "waiting", study: waiting };
  // Only the newest study tells whether the analyst is stuck: an older failure was followed by other work.
  const newest = studies[0] ?? null;
  if (newest && studyState(newest) === "failed") return { state: "failed", study: newest };
  return { state: "free", study: newest };
}

/** When the work going on at the station started: the live study's last turn, or the legacy session's phase. */
export function workingSince(research: Research): number | null {
  const study = research.studies.find((item) => item.alive);
  if (study) return study.messages[study.messages.length - 1]?.at ?? study.created;
  const run = research.run;
  if (run?.alive) return run.phase_started_at ?? run.created ?? run.updated_at;
  return null;
}

/** The lesson's id in its report: the entry's last word, «U1» of «batch-2026-11-06.md U1». */
export function lessonId(entry: string): string {
  return entry.trim().split(/\s+/).at(-1) ?? entry.trim();
}

/** What «Внедрить» sends: the note only when there is one. */
export function implementBody(entry: string, repo: string, note: string): ImplementBody {
  const body: ImplementBody = { entry: entry.trim(), repo };
  if (note.trim()) body.note = note.trim();
  return body;
}

/**
 * The repository «Где внедрять» starts with, as its path: a domain lesson's first named repository the board knows, any
 * other lesson's `teamster`; empty when there is none, and the human picks one.
 */
export function defaultRepo(lesson: Pick<Lesson, "scope" | "repos">, repos: readonly ResearchRepo[]): string {
  const named = (name: string) => repos.find((repo) => repo.name === name)?.path;
  if (lesson.scope === "domain") {
    for (const name of lesson.repos) {
      const path = named(name);
      if (path) return path;
    }
    return "";
  }
  return named("teamster") ?? "";
}

/** «Внедрить» is offered while the lesson has no implementation, or only a closed one. */
export const canImplement = (lesson: Pick<Lesson, "implementation">) => !lesson.implementation || lesson.implementation.archived;

/** «PR #12» for a pull request's URL, «PR» when the URL has no number. */
export function prLabel(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `PR #${number}` : "PR";
}

/** The line of a lesson's implementation on its card; `answer`: the card takes a reply for the agent. */
export type ImplementationLine =
  | { kind: "started"; text: string; answer: false }
  | { kind: "working"; text: string; answer: false }
  | { kind: "decision"; text: "Агенту нужно решение"; questions: string[]; answer: true }
  | { kind: "pr"; pr: string; label: string; before: "PR готов: "; after: ". Проверь и смёржи, затем отметь «Внедрено»."; answer: false }
  | { kind: "stopped"; text: string; summary: string | null; answer: true }
  | { kind: "closed"; text: "Задача закрыта"; pr: string | null; label: string | null; answer: false };

/**
 * How the implementation goes, by the first state that fits: the agent works, needs a decision, opened a PR, stopped,
 * or the task is closed. `started`: the task the card just started, shown until the research carries it.
 */
export function implementationLine(implementation: Implementation | null | undefined, started: { slug: string; repo: string } | null = null): ImplementationLine | null {
  const task = implementation ?? null;
  if (started && task?.slug !== started.slug) return { kind: "started", text: `Внедряется: ${started.slug} · ${started.repo}`, answer: false };
  if (!task) return null;
  if (task.alive) return { kind: "working", text: `Агент работает · ${task.repo}`, answer: false };
  // A closed task takes no reply: its questions stay unanswered.
  if (task.result_status === "needs_decision" && !task.archived) {
    return { kind: "decision", text: "Агенту нужно решение", questions: task.questions, answer: true };
  }
  if (task.result_status === "done" && task.pr) {
    return { kind: "pr", pr: task.pr, label: prLabel(task.pr), before: "PR готов: ", after: ". Проверь и смёржи, затем отметь «Внедрено».", answer: false };
  }
  if (task.result_status && !task.archived) {
    return { kind: "stopped", text: `Агент остановился (${task.result_status})`, summary: task.summary, answer: true };
  }
  if (task.archived) return { kind: "closed", text: "Задача закрыта", pr: task.pr, label: task.pr ? prLabel(task.pr) : null, answer: false };
  // Started, before its first turn ended.
  return { kind: "started", text: `Внедряется: ${task.slug} · ${task.repo}`, answer: false };
}

/** What the human can do next, as the line under the station's title: one sentence and at most one button. */
export interface NextStep {
  text: string;
  /**
   * «Ответить» opens the waiting channel, or the card whose agent needs a decision; «Разобрать» the lessons to decide;
   * «Показать» the card of a ready PR, or the accepted lessons.
   */
  action:
    | { kind: "reply"; label: "Ответить"; study: Study }
    | { kind: "agent"; label: "Ответить"; lesson: Lesson }
    | { kind: "review"; label: "Разобрать" }
    | { kind: "pr"; label: "Показать"; lesson: Lesson }
    | { kind: "accepted"; label: "Показать" }
    | null;
  tone: "wait" | "gold" | "live" | "teal" | "";
}

export function nextStep(research: Research, now: number, clock: Pick<Clock, "state" | "when">): NextStep {
  const waiting = research.studies.find((study) => study.waiting);
  if (waiting) {
    return { text: `Аналитик ждёт ответа: ${studyTitle(waiting)}`, action: { kind: "reply", label: "Ответить", study: waiting }, tone: "wait" };
  }
  // The implementations of the accepted lessons: an applied lesson's task is no longer the human's concern.
  const lineOf = (lesson: Lesson) => implementationLine(lesson.implementation);
  const asking = research.accepted.find((lesson) => lineOf(lesson)?.kind === "decision");
  if (asking) {
    return { text: `Агенту нужно решение: урок ${lessonId(asking.entry)}`, action: { kind: "agent", label: "Ответить", lesson: asking }, tone: "wait" };
  }
  if (research.proposed.length) {
    return { text: `Уроков ждут решения: ${research.proposed.length}`, action: { kind: "review", label: "Разобрать" }, tone: "gold" };
  }
  const since = workingSince(research);
  if (research.running || since !== null) {
    const live = research.studies.find((study) => study.alive);
    const minutes = since !== null ? ` · ${Math.max(0, Math.floor((now - since) / 60))} мин` : "";
    return { text: `Аналитик работает: ${live ? studyTitle(live) : "Плановый разбор"}${minutes}`, action: null, tone: "live" };
  }
  const agents = research.accepted.filter((lesson) => lineOf(lesson)?.kind === "working");
  if (agents.length) {
    const text = agents.length > 1 ? `Агенты внедряют уроки: ${agents.length}` : `Агент внедряет урок ${lessonId(agents[0]!.entry)}`;
    return { text, action: null, tone: "live" };
  }
  const ready = research.accepted.find((lesson) => lineOf(lesson)?.kind === "pr");
  if (ready) {
    return { text: `PR готов по уроку ${lessonId(ready.entry)}`, action: { kind: "pr", label: "Показать", lesson: ready }, tone: "teal" };
  }
  if (research.accepted.length) {
    return { text: `Приняты и ждут внедрения: ${research.accepted.length}`, action: { kind: "accepted", label: "Показать" }, tone: "teal" };
  }
  const when = clock.when ?? (clock.state === "off" ? "выключен" : "не назначен");
  return { text: `Всё разобрано. Плановый разбор ${when}`, action: null, tone: "" };
}
