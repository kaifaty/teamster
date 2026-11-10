// teamster commands, ready to paste into a terminal: a task's card copies them, and so do the science station and a
// ship's bridge when the board only reads.

import type { LessonStatus, StudyQuestion, TaskSummary } from "../types";
import type { ReviewBody, SayOptions } from "./actions";

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

/** The refit's flags in the server's order, each one `--option=value` word. */
export function optionFlags(options: SayOptions & Pick<ReviewBody, "effort"> = {}): string[] {
  const flags: string[] = [];
  const add = (name: string, value: string | number | undefined) => {
    if (value !== undefined) flags.push(shellWord(`--${name}=${value}`));
  };
  add("model", options.model);
  add("effort", options.effort);
  add("max-minutes", options.max_minutes);
  add("max-weekly", options.max_weekly);
  add("fix-rounds", options.fix_rounds);
  add("ci-rounds", options.ci_rounds);
  add("reviewer", options.reviewer);
  const angles = options.review_angles;
  add("review-angles", angles === undefined ? undefined : typeof angles === "string" ? angles : angles.join(","));
  return flags;
}

/** `teamster say` with the refit's flags and the message as one word. */
export function sayCommand(slug: string, text: string, options: SayOptions = {}): string {
  return ["teamster", "say", shellWord(commandSlug(slug)), ...optionFlags(options), shellQuote(text)].join(" ");
}

/** `teamster review` with effort, reviewer and angles, as the server orders them. */
export function reviewCommand({ slug, effort, reviewer, review_angles }: ReviewBody): string {
  const flags = optionFlags({ effort, reviewer, review_angles });
  return ["teamster", "review", shellWord(commandSlug(slug)), ...flags].join(" ");
}

export function stopCommand(slug: string): string {
  return `teamster stop ${shellWord(commandSlug(slug))}`;
}

/** `teamster clean`, keeping the branch unless told otherwise. */
export function cleanCommand(slug: string, keepBranch = true): string {
  const base = `teamster clean ${shellWord(commandSlug(slug))}`;
  return keepBranch ? `${base} --keep-branch` : base;
}

/** A short study name based on the UTC date and time, to the second: two orders in one minute stay apart. */
export function reflectSlug(now: Date): string {
  const pair = (value: number) => String(value).padStart(2, "0");
  return `reflect-${pair(now.getUTCMonth() + 1)}${pair(now.getUTCDate())}-${pair(now.getUTCHours())}${pair(now.getUTCMinutes())}${pair(now.getUTCSeconds())}`;
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

/** One numbered reply per answered analyst question, ready for `say`. */
export function answerText(questions: StudyQuestion[], answers: string[]): string {
  return questions.flatMap((question, index) => {
    const answer = answers[index]?.replace(/\s+/g, " ").trim();
    if (!answer) return [];
    const text = question.text.replace(/\s+/g, " ").trim().slice(0, 80);
    return [`${index + 1}. ${text}: ${answer}`];
  }).join("\n");
}
