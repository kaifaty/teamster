// The day's summary from `teamster report --json` (passed through by GET /api/report) and the day's verdicts.
// The report is the worker's own output, so every field is read defensively.

import type { LogEvent } from "../types";
import { VERDICTS, type Verdict } from "./commands";

export interface DaySummary {
  tasks: number;
  turns: number;
  activeHours: number;
  /** Latest verdict per task given today. */
  verdicts: Record<Verdict, number>;
  /** 0–100, or null without samples. */
  checkPercent: number | null;
  checks: number;
  ciPercent: number | null;
  ci: number;
  reviews: number;
  reviewsWithFindings: number;
  averageFindings: number | null;
  /** Fix rounds a task needed before a clean review, as [rounds, tasks], fewest first. */
  roundsToClean: [number, number][];
  executors: { name: string; tasks: number; donePercent: number | null; medianMinutes: number | null }[];
  /** The day's five tasks with the most active minutes. */
  costly: { slug: string; repo: string; minutes: number; turns: number }[];
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const count = (value: unknown): number => number(value) ?? 0;
const percent = (fraction: unknown): number | null => {
  const value = number(fraction);
  return value === null ? null : Math.round(value * 100);
};

/** Local date as YYYY-MM-DD, the form the report takes. */
export function localDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Unix seconds of the local midnight that starts the day of `at`. */
export function dayStart(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() / 1000;
}

/** The latest verdict each task got at or after `since`. */
export function dayVerdicts(events: readonly LogEvent[], since: number): Record<Verdict, number> {
  const latest = new Map<string, LogEvent>();
  for (const event of events) {
    if (event.kind !== "verdict" || event.at < since) continue;
    const key = `${event.repo ?? ""}\n${event.slug ?? ""}`;
    const known = latest.get(key);
    if (!known || known.at <= event.at) latest.set(key, event);
  }
  const counts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, 0])) as Record<Verdict, number>;
  for (const event of latest.values()) {
    if ((VERDICTS as readonly string[]).includes(event.verdict ?? "")) counts[event.verdict as Verdict] += 1;
  }
  return counts;
}

/** The summary to show, or null when the day has nothing in it. */
export function daySummary(data: unknown, events: readonly LogEvent[], since: number): DaySummary | null {
  const report = object(data);
  const summary = object(report.summary);
  const checks = object(summary.checks);
  const ci = object(summary.ci);
  const reviews = object(summary.reviews);
  const verdicts = dayVerdicts(events, since);
  const roundsToClean = Object.entries(object(summary.fix_rounds_to_clean))
    .map(([rounds, tasks]) => [Number(rounds), count(tasks)] as [number, number])
    .filter(([rounds, tasks]) => Number.isInteger(rounds) && tasks > 0)
    .sort((a, b) => a[0] - b[0]);
  const executors = (Array.isArray(report.groups) ? report.groups : []).map(object).map((group) => ({
    name: typeof group.executor === "string" ? group.executor : "unknown",
    tasks: count(group.tasks),
    donePercent: percent(group.done_fraction),
    medianMinutes: number(group.median_active_minutes),
  }));
  const costly = (Array.isArray(report.tasks) ? report.tasks : [])
    .map(object)
    .map((task) => ({
      slug: typeof task.slug === "string" ? task.slug : "?",
      repo: typeof task.repo === "string" ? task.repo : "",
      minutes: count(task.active_minutes),
      turns: count(task.turns),
    }))
    .filter((task) => task.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 5);
  const result: DaySummary = {
    tasks: count(summary.tasks),
    turns: count(summary.turns),
    activeHours: count(summary.active_hours),
    verdicts,
    checkPercent: percent(checks.pass_fraction),
    checks: count(checks.total),
    ciPercent: percent(ci.pass_fraction),
    ci: count(ci.total),
    reviews: count(reviews.total),
    reviewsWithFindings: count(reviews.with_defects),
    averageFindings: number(reviews.average_findings),
    roundsToClean,
    executors,
    costly,
  };
  const judged = VERDICTS.some((verdict) => verdicts[verdict] > 0);
  return result.tasks || result.turns || judged ? result : null;
}
