// The command row's queues: the tasks that wait for your decision (`review_me`) and those with an alarm (`attention`),
// the one that has waited longest first, as the systems' badges count them; the next one round the queue; and the tasks
// that have just come into a queue, for the notification sound. Pure functions; the row only calls them.

import type { TaskSummary } from "../../types";

/** The columns the command row counts: «Ждут тебя» and «Тревоги». */
export type QueueColumn = "review_me" | "attention";

type Queued = Pick<TaskSummary, "slug" | "repo" | "column" | "phase_started_at" | "updated_at">;

/** Since when a task has waited in its column: the start of its phase, or its last change without one. */
const waitingSince = (task: Queued) => task.phase_started_at ?? task.updated_at;

/** The tasks in `column`, the one that has waited longest first; a tie goes by slug, so that the order holds. */
export function queueOf<T extends Queued>(tasks: readonly T[], column: QueueColumn): T[] {
  return tasks
    .filter((task) => task.column === column)
    .sort((a, b) => waitingSince(a) - waitingSince(b) || a.slug.localeCompare(b.slug));
}

/**
 * The task to open next: the one after `last` in the queue, round to the first past the end; the first when `last` is
 * null or has left the queue; null for an empty queue.
 */
export function nextInQueue<T extends Pick<TaskSummary, "slug">>(queue: readonly T[], last: string | null): T | null {
  if (!queue.length) return null;
  const at = last === null ? -1 : queue.findIndex((task) => task.slug === last);
  return queue[at < 0 ? 0 : (at + 1) % queue.length]!;
}

/** The slugs of the tasks in `column`. */
export function slugsIn(tasks: readonly Pick<TaskSummary, "slug" | "column">[], column: QueueColumn): Set<string> {
  return new Set(tasks.filter((task) => task.column === column).map((task) => task.slug));
}

/** The slugs in `now` that were not in `before`; none while there is nothing to compare with yet (the first snapshot). */
export function arrivals(before: ReadonlySet<string> | null, now: ReadonlySet<string>): string[] {
  if (!before) return [];
  return [...now].filter((slug) => !before.has(slug));
}

/** "1 задача", "3 задачи", "6 задач". */
export function taskCount(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  const word = tens >= 11 && tens <= 14 ? "задач" : ones === 1 ? "задача" : ones >= 2 && ones <= 4 ? "задачи" : "задач";
  return `${count} ${word}`;
}
