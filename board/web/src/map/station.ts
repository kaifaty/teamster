// The research station as a conversation: who speaks, which docket and which questions are live, and the one
// transmission that carries the human's decisions and answers. Pure data for ResearchPanel; the board only
// copies the command, it never runs it.

import { answerText, lessonCommand, reflectCommand, reflectSlug, sayCommand, transmission } from "../lib/commands";
import type { Lesson, Study, StudyMessage, StudyQuestion } from "../types";

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

/** The study the panel opens first: one that waits for the human, then one at work, then the newest. */
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

export type DecisionStatus = "accepted" | "declined";
export interface Decision {
  entry: string;
  /** The lesson id, for the chip. */
  id: string;
  status: DecisionStatus;
  note: string;
}

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
const SINCE = /^(\d{4}-\d{2}-\d{2}|\d{1,3}d)$/;

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
    if (since && !SINCE.test(since)) return { error: "Срок — дата ГГГГ-ММ-ДД или число дней, например 14d" };
    return { command: reflectCommand({ slug, order, since: since || undefined, repos: words(draft.repos) }) };
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
