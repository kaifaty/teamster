// teamster commands for a task, ready to paste into a terminal. The board never runs them.

import type { LessonStatus, StudyQuestion, TaskSummary } from "../types";

export const VERDICTS = ["accepted", "revised", "redone", "dropped"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type CommandId = "status" | "wait" | "stop" | "review" | "clean";

export interface TaskCommand {
  id: CommandId;
  /** What the button says. */
  label: string;
  command: string;
}

/** `text` as one POSIX shell word in single quotes: nothing inside expands; a quote becomes '\''. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A name as a shell word: bare when it is plainly safe, otherwise quoted. */
export const shellWord = (text: string) => (/^[A-Za-z0-9_.@%+=,-]+$/.test(text) ? text : shellQuote(text));

/** The name teamster knows the task by: an archived record's folder ends in `-YYYYMMDDTHHMMSSZ`. */
export function commandSlug(slug: string): string {
  return slug.replace(/-\d{8}T\d{6}Z$/, "");
}

const LABELS: Record<CommandId, string> = {
  status: "Статус",
  wait: "Ждать",
  stop: "Остановить",
  review: "Ревью",
  clean: "Убрать",
};

/**
 * The plain commands the task offers, in order. A desktop session has none: teamster does not run it.
 * A scout cannot be reviewed or judged, so it only gets status, wait, stop and clean.
 */
export function taskCommands(task: Pick<TaskSummary, "slug" | "kind">): TaskCommand[] {
  if (task.kind === "session") return [];
  const ids: CommandId[] = task.kind === "scout" ? ["status", "wait", "stop", "clean"] : ["status", "wait", "stop", "review", "clean"];
  const slug = shellWord(commandSlug(task.slug));
  return ids.map((id) => ({ id, label: LABELS[id], command: `teamster ${id} ${slug}` }));
}

/** Whether the task takes `say` and `verdict`: not a session and not a scout. */
export function takesWords(task: Pick<TaskSummary, "kind">): boolean {
  return task.kind !== "session" && task.kind !== "scout";
}

/** `teamster verdict`, with the note only when it has text. */
export function verdictCommand(slug: string, verdict: Verdict, note = ""): string {
  const base = `teamster verdict ${shellWord(commandSlug(slug))} ${verdict}`;
  return note.trim() ? `${base} --note ${shellQuote(note.trim())}` : base;
}

/** `teamster say` with the message as one word. */
export function sayCommand(slug: string, text: string): string {
  return `teamster say ${shellWord(commandSlug(slug))} ${shellQuote(text)}`;
}

/** A short study name based on the UTC date and time. */
export function reflectSlug(now: Date): string {
  const pair = (value: number) => String(value).padStart(2, "0");
  return `reflect-${pair(now.getUTCMonth() + 1)}${pair(now.getUTCDate())}-${pair(now.getUTCHours())}${pair(now.getUTCMinutes())}`;
}

/** Start a reflection of named tasks, or select its material by time and repositories. */
export function reflectCommand({ slug, order, tasks = [], since, repos = [] }: {
  slug: string;
  order?: string;
  tasks?: string[];
  since?: string;
  repos?: string[];
}): string {
  if (tasks.length && (since !== undefined || repos.length)) {
    throw new Error("Tasks cannot be combined with since or repositories");
  }
  const words = ["teamster", "reflect", shellWord(slug)];
  for (const task of tasks) words.push("--task", shellWord(task));
  if (since !== undefined) words.push("--since", shellWord(since));
  for (const repo of repos) words.push("--repo", shellWord(repo));
  if (order?.trim()) words.push(shellQuote(order));
  return words.join(" ");
}

/** Mark an indexed lesson, with a note only when it has text. */
export function lessonCommand(entry: string, status: Exclude<LessonStatus, "other">, note = ""): string {
  const base = `teamster lesson ${shellQuote(entry)} ${shellWord(status)}`;
  return note.trim() ? `${base} --note ${shellQuote(note.trim())}` : base;
}

/** Commands copied together run in order while each previous command succeeds. */
export function transmission(commands: string[]): string {
  return commands.filter((command) => command.trim()).join(" && ");
}

/** One numbered reply per answered analyst question, ready for `say`. */
export function answerText(questions: StudyQuestion[], answers: string[]): string {
  return questions.flatMap((question, index) => {
    const answer = answers[index]?.replace(/\s+/g, " ").trim();
    if (!answer) return [];
    const text = question.text.replace(/\s+/g, " ").trim().slice(0, 80);
    return [`${index + 1}. ${text}: ${answer}`];
  }).join("\n");
}
