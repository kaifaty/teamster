import type { Activity, Column, Phase, TaskFile, TaskSummary } from "../types";
import { formatAge } from "./format";

export type Tone = "ok" | "bad" | "warn" | "muted";

export const COLUMNS: { id: Column; title: string }[] = [
  { id: "running", title: "Работает" },
  { id: "sleeping", title: "Спит до сброса" },
  { id: "review_me", title: "Ждёт тебя" },
  { id: "attention", title: "Нужно внимание" },
  { id: "closed", title: "Закрыто" },
];

export const PHASES: Record<Phase, string> = {
  turn: "ход",
  check: "проверка",
  review: "ревью",
  fix: "исправление",
  ci: "CI",
  sleeping: "сон",
  idle: "простой",
};

export const EXECUTORS: Record<TaskSummary["executor"], string> = { codex: "Codex", claude: "Claude" };

export const KINDS: Record<TaskSummary["kind"], string> = {
  work: "работа",
  review: "ревью",
  scout: "разведка",
  reflect: "исследование",
  session: "сессия",
};

/** Heading of a card: a session's title, else the start of its uuid; the slug for a task. */
export function taskTitle(task: TaskSummary): string {
  if (task.kind !== "session") return task.slug;
  const title = task.title?.trim();
  return title ? title : task.slug.replace(/^local_/, "").slice(0, 8);
}

/** A session's link to the Claude app, only when it is a `claude://` link. */
export function claudeLink(task: TaskSummary): string | null {
  const link = task.link;
  return task.kind === "session" && typeof link === "string" && link.startsWith("claude://") ? link : null;
}

export type KindFilter = "all" | "tasks" | "sessions";

export const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "Всё" },
  { id: "tasks", label: "Задачи" },
  { id: "sessions", label: "Сессии" },
];

export const isKindFilter = (value: unknown): value is KindFilter =>
  value === "all" || value === "tasks" || value === "sessions";

export function matchesKind(task: TaskSummary, filter: KindFilter): boolean {
  if (filter === "all") return true;
  return (task.kind === "session") === (filter === "sessions");
}

export const ACTIVITY: Record<Activity["kind"], { icon: string; label: string }> = {
  command: { icon: "$", label: "команда" },
  edit: { icon: "✎", label: "правка" },
  message: { icon: "›", label: "сообщение" },
  tool: { icon: "⚙", label: "инструмент" },
  thinking: { icon: "…", label: "размышляет" },
};

export const CI: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "CI идёт", tone: "warn" },
  passed: { label: "CI прошёл", tone: "ok" },
  failed: { label: "CI упал", tone: "bad" },
  skipped: { label: "CI пропущен", tone: "muted" },
  timeout: { label: "CI: таймаут", tone: "bad" },
  none: { label: "без CI", tone: "muted" },
};

export const RESULT: Record<string, string> = {
  done: "готово",
  partial: "частично",
  needs_decision: "нужно решение",
  blocked: "заблокирована",
};

export const OUTCOMES: Record<string, string> = {
  running: "надзиратель умер",
  sleeping: "надзиратель умер во сне",
  failed: "сбой",
  stopped: "остановлена",
  budget_exhausted: "бюджет исчерпан",
  conflict: "конфликт",
  interrupted: "прервана",
  stuck: "зависла",
  refused: "отказ",
  unavailable: "недоступна",
  exhausted: "лимиты исчерпаны",
  error: "ошибка",
};

/** Outcomes of a task that finished normally. */
const SUCCESS_OUTCOMES = new Set(["done", "completed"]);

export const FILES: Record<TaskFile, string> = { brief: "Бриф", last: "Ответ", review: "Ревью", check: "Проверка" };

/** "#118" from a GitHub or Forgejo PR URL, else "PR". */
export function prLabel(url: string): string {
  const match = /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(url);
  return match ? `PR #${match[1]}` : "PR";
}

/**
 * Why a finished task needs attention, in words, or null when nothing went wrong: a failure outcome first,
 * then a result status other than "done", then an unknown outcome when there is no result status.
 */
export function problemLabel(task: TaskSummary): string | null {
  if (task.column !== "attention" && task.column !== "closed") return null;
  const outcome = task.outcome && !SUCCESS_OUTCOMES.has(task.outcome) ? task.outcome : null;
  if (outcome && OUTCOMES[outcome]) return OUTCOMES[outcome]!;
  if (task.result_status) return task.result_status === "done" ? null : (RESULT[task.result_status] ?? task.result_status);
  return outcome;
}

/** Why the automatic fix loop stopped (state.auto_fix_stop), in words. */
export const STOPS: Record<string, { label: string; tone: Tone }> = {
  clean: { label: "ревью чистое", tone: "ok" },
  "only P3": { label: "остались только P3", tone: "warn" },
  "check failed": { label: "упала проверка", tone: "bad" },
  "check timeout": { label: "проверка не уложилась во время", tone: "bad" },
  "base conflict": { label: "конфликт с базой", tone: "bad" },
  escalate: { label: "эскалация", tone: "bad" },
  budget: { label: "бюджет исчерпан", tone: "warn" },
  budget_exhausted: { label: "бюджет исчерпан", tone: "warn" },
  "result partial": { label: "результат частичный", tone: "warn" },
  "result blocked": { label: "задача заблокирована", tone: "bad" },
  "result needs_decision": { label: "нужно решение", tone: "warn" },
  "review unknown": { label: "ревью без результата", tone: "warn" },
  "review refused": { label: "ревью отказалось", tone: "bad" },
  rounds_exhausted: { label: "раунды исправлений исчерпаны", tone: "warn" },
  stopped: { label: "остановлена", tone: "muted" },
};

/** The fix loop's stop in words; an unknown value as it is. */
export function stopLabel(stop: string): { label: string; tone: Tone } {
  return STOPS[stop] ?? { label: stop, tone: "muted" };
}

/** "1 замечание", "3 замечания", "5 замечаний". */
export function findingsLabel(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  const word = tens >= 11 && tens <= 14 ? "замечаний" : ones === 1 ? "замечание" : ones >= 2 && ones <= 4 ? "замечания" : "замечаний";
  return `${count} ${word}`;
}

/** The first mark of what a task on the roadstead came back with, for its ship's line; null when there is none. */
export function cargoMark(task: TaskSummary): string | null {
  if (task.stop === "base conflict") return "конфликт с базой";
  if (task.check === "failed" || task.check === "timeout") return "проверка упала";
  if (task.ci === "failed" || task.ci === "timeout") return "CI упал";
  if (task.findings_left > 0) return `${task.findings_left} замеч.`;
  if (task.left > 0) return `осталось ${task.left}`;
  if (task.review === "clean") return "чисто";
  return null;
}

/** CI chip of a card. A task whose supervisor is gone can no longer wait for a pending CI. */
export function ciChip(task: TaskSummary): { label: string; tone: Tone } | null {
  if (!task.ci) return null;
  if (task.ci === "pending" && !task.alive) return { label: "CI не дождались", tone: "muted" };
  return CI[task.ci] ?? { label: `CI: ${task.ci}`, tone: "muted" };
}

/** Length of the card highlight animation; `.flash` in TaskCard.vue uses the same value. */
export const FLASH_MS = 2400;

/** Whether a change at `changedAt` (ms) is still being highlighted at `nowMs`, so a card that comes back
 * through a filter later does not replay an old highlight. */
export function isFlashing(changedAt: number | undefined, nowMs: number): boolean {
  return changedAt !== undefined && nowMs - changedAt < FLASH_MS;
}

/** The browser tab's title: the count of tasks that need attention goes first while there are any. */
export function tabTitle(base: string, alarms: number): string {
  return alarms > 0 ? `(${alarms}) ${base}` : base;
}

/**
 * A ship's line on the map at `now`: its latest activity and how old it is (when `stale`), or why it no longer
 * works. `replayed` marks a record rebuilt by the replay, whose summary stands in for activity it does not have.
 */
export function shipLine(task: TaskSummary, stale: boolean, now: number, replayed: boolean): string {
  if (task.column === "review_me") {
    return ["готово", task.pr ? prLabel(task.pr) : null, cargoMark(task)].filter(Boolean).join(" · ");
  }
  if (!task.alive) return `${task.summary ?? problemLabel(task) ?? "надзиратель не запущен"} · ${formatAge(task.updated_at, now)}`;
  const activity = task.activity;
  if (!activity) return replayed && task.summary ? `${task.summary} · ${formatAge(task.updated_at, now)}` : "нет активности";
  const age = stale && activity.at !== null ? ` · ${formatAge(activity.at, now)}` : "";
  return `${ACTIVITY[activity.kind].icon} ${activity.text}${age}`;
}
