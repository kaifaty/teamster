// The research station: what the reflection learned from finished tasks, what waits for a decision, and which
// systems it watches. Pure data for the scene, the label and the panel.

import type { Lesson, PendingRecord, ResearchBatch, ResearchView, Signal, TaskSummary } from "../types";

/** The scheduled task of the reflection when the server does not name it. */
export const REFLECTION_TASK = "codex-batch-reflection";

/** At most this many probes fly out while the reflection runs. */
export const MAX_PROBES = 6;

export const SIGNALS: Record<Signal, string> = {
  blocked: "заблокирована",
  refused: "отказ",
  needs_decision: "ждала решения",
  escalate: "эскалация",
  round_cap: "лимит раундов",
  fix_rounds: "2+ раунда фиксов",
  check_failed: "упала проверка",
  ci_repair: "чинили CI",
  budget_exhausted: "кончился бюджет",
};

/** A run of the reflection: a desktop session started by its scheduled task. */
export function isReflection(task: Pick<TaskSummary, "kind" | "scheduled">, view: ResearchView | null): boolean {
  return task.kind === "session" && !!task.scheduled && task.scheduled === (view?.reflection_task ?? REFLECTION_TASK);
}

export interface Research {
  /** Lessons by status, newest first. */
  proposed: Lesson[];
  applied: Lesson[];
  declined: Lesson[];
  other: Lesson[];
  batch: ResearchBatch | null;
  pending: { records: number; signals: number; items: PendingRecord[] };
  /** The reflection's session: the one running now, else the latest. */
  run: TaskSummary | null;
  running: boolean;
  /** Systems on the map with records that wait for the next reflection, most first. */
  watched: { repo: string; count: number }[];
  /** Systems the probes visit while the reflection runs. */
  probes: string[];
}

const byCount = (counts: Record<string, number>, known: ReadonlySet<string>) =>
  Object.entries(counts)
    .filter(([repo, count]) => known.has(repo) && count > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([repo, count]) => ({ repo, count }));

/** The station's state; null when the server tells nothing about research. */
export function research(view: ResearchView | null, tasks: readonly TaskSummary[], starRepos: readonly string[]): Research | null {
  if (!view) return null;
  const newest = [...view.lessons].reverse();
  const runs = tasks.filter((task) => isReflection(task, view)).sort((a, b) => Number(b.alive) - Number(a.alive) || b.updated_at - a.updated_at);
  const run = runs[0] ?? null;
  const running = run?.alive ?? false;
  const known = new Set(starRepos);
  const watched = byCount(view.pending.repos, known);
  // A run reads the records gathered since the last one; with none known, the systems it read last time.
  const visited = watched.length ? watched : byCount(view.batch?.repos ?? {}, known);
  return {
    proposed: newest.filter((lesson) => lesson.status === "proposed"),
    applied: newest.filter((lesson) => lesson.status === "applied"),
    declined: newest.filter((lesson) => lesson.status === "declined"),
    other: newest.filter((lesson) => lesson.status === "other"),
    batch: view.batch,
    pending: { records: view.pending.records, signals: view.pending.signals, items: view.pending.items },
    run,
    running,
    watched,
    probes: running ? visited.slice(0, MAX_PROBES).map((item) => item.repo) : [],
  };
}

/** "11-07", or the date as written when it is not a date. */
export function shortDate(date: string | null): string {
  if (!date) return "—";
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(date);
  return match ? `${match[2]}.${match[1]}` : date;
}
