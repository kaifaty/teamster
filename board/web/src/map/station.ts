// The science station as a conversation: who speaks, which docket and which questions are live, and the one
// transmission that carries the human's decisions and answers. Pure data for the station's screen; the board only
// copies the command, it never runs it.

import { answerText, lessonCommand, reflectCommand, reflectSlug, sayCommand, transmission } from "../lib/commands";
import type { Lesson, PendingRecord, Signal, Study, StudyMessage, StudyQuestion } from "../types";
import type { Research } from "./research";

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

/** A proposed lesson is accepted or declined; an accepted one is marked applied once its change landed. */
export type DecisionStatus = "accepted" | "declined" | "applied";
export interface Decision {
  entry: string;
  /** The lesson id, for the chip. */
  id: string;
  status: DecisionStatus;
  /** Why it was declined, or where it was applied. */
  note: string;
}

export const DECISION_TEXT: Record<DecisionStatus, string> = { accepted: "принять", declined: "отклонить", applied: "внедрено" };

/** What goes to the analyst: one numbered line per answered question, then the free text. */
export function replyText(questions: readonly StudyQuestion[], answers: readonly string[], free: string): string {
  return [answerText([...questions], [...answers]), free.trim()].filter(Boolean).join("\n");
}

/**
 * One command for the terminal: every decision on a lesson, then the say to the open study. A say goes only to a
 * study that can take it; without a text there is no say.
 */
export function transmissionFor(decisions: readonly Decision[], study: Study | null, text: string): string {
  const commands = decisions.map((decision) => lessonCommand(decision.entry, decision.status, decision.note));
  if (text.trim() && study && reach(study) === "ok") commands.push(sayCommand(study.slug, text));
  return transmission(commands);
}

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

/** The `teamster reflect` command of a new order, or why it cannot be built yet. */
export function orderCommand(draft: OrderDraft, now: Date): { command: string } | { error: string } {
  const slug = reflectSlug(now);
  const order = draft.text.trim() || undefined;
  if (draft.kind === "tasks") {
    const tasks = words(draft.tasks);
    if (!tasks.length) return { error: "Назови хотя бы одну задачу" };
    return { command: reflectCommand({ slug, tasks, order }) };
  }
  if (draft.kind === "question") {
    if (!order) return { error: "Сформулируй вопрос" };
    const since = draft.since.trim();
    const repos = words(draft.repos);
    if (since && !validSince(since)) return { error: "Срок — дата ГГГГ-ММ-ДД или число дней, например 14d" };
    // Without a period or projects teamster would run a batch and move its through: stamp.
    if (!since && !repos.length) return { error: "Укажи срок или проекты" };
    return { command: reflectCommand({ slug, order, since: since || undefined, repos }) };
  }
  return { command: reflectCommand({ slug, order }) };
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
