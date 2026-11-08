// Replay: the fleet at a past moment, rebuilt from the ship's log alone (board/CONTRACT.md, LogEvent). The
// records look like live tasks, so that the map places and draws them as it does the live fleet.

import { describeEvent } from "../lib/events";
import type { Activity, LogEvent, Phase, TaskSummary } from "../types";

/** A task without events for this long, and without a verdict, has left the map. */
export const REPLAY_QUIET_SECONDS = 2 * 3600;

/** The window a day of replay covers, in Unix seconds. */
export interface ReplayWindow {
  since: number;
  until: number;
}

/** Outcomes the server counts as a failure (board/server store.py, FAILURES). */
export const REPLAY_FAILURES: ReadonlySet<string> = new Set([
  "failed", "stopped", "interrupted", "budget_exhausted", "conflict", "stuck",
  "refused", "unavailable", "exhausted", "running", "sleeping",
]);

/** Verdicts whose ship goes into the sun; the others fade out. */
const TO_SUN = new Set(["accepted", "revised"]);

/** CI outcomes that mean the ship went through the gate. */
const GATE = new Set(["pending", "passed", "failed", "timeout"]);

/** The map's phase of a journal phase. */
function phaseOf(phase: string | null): Phase {
  switch (phase) {
    case "fix":
      return "fix";
    case "check":
    case "base_check":
      return "check";
    case "review":
      return "review";
    default:
      return "turn"; // work, wrapup, scout
  }
}

const ACTIVITY_OF: Record<Phase, { kind: Activity["kind"]; text: string }> = {
  turn: { kind: "edit", text: "Работает над задачей" },
  fix: { kind: "edit", text: "Исправляет замечания" },
  check: { kind: "command", text: "Идёт проверка" },
  review: { kind: "thinking", text: "Идёт ревью" },
  ci: { kind: "message", text: "Ждёт CI" },
  sleeping: { kind: "message", text: "Спит" },
  idle: { kind: "message", text: "Простой" },
};

const isTurn = (event: LogEvent) => event.phase === "turn";
const isVerdict = (event: LogEvent) => event.kind === "verdict";
const family = (value: string | null): "codex" | "claude" | null => (value === "codex" || value === "claude" ? value : null);
const runs = (event: LogEvent, t: number) => event.started !== null && event.started <= t && t <= event.at;

/** The events of every task that can have a ship: those with a slug and a repository, by slug, in order. */
function bySlug(events: readonly LogEvent[]): Map<string, LogEvent[]> {
  const result = new Map<string, LogEvent[]>();
  for (const event of events) {
    if (!event.slug || !event.repo) continue;
    const list = result.get(event.slug) ?? [];
    list.push(event);
    result.set(event.slug, list);
  }
  for (const list of result.values()) list.sort((a, b) => a.at - b.at);
  return result;
}

interface Moment {
  column: TaskSummary["column"];
  phase: Phase;
  alive: boolean;
  fresh: boolean;
  /** The event that put the ship where it is. */
  event: LogEvent;
  since: number;
}

/** Where one task is at `t`, from its events in order; null when it has no ship then. */
function momentOf(list: readonly LogEvent[], t: number): Moment | null {
  const past = list.filter((event) => event.at <= t);
  const phases = list.filter((event) => !isTurn(event) && !isVerdict(event));

  // A phase in progress: the most recently started one.
  const running = phases.filter((event) => runs(event, t)).sort((a, b) => a.started! - b.started!).pop();
  if (running) return { column: "running", phase: phaseOf(running.phase), alive: true, fresh: true, event: running, since: running.started! };

  const turn = list.filter((event) => isTurn(event) && runs(event, t)).pop();
  const last = past[past.length - 1];
  if (turn) {
    // Inside a turn, between its phases: where the last phase of the turn ended.
    const done = phases.filter((event) => event.at <= t && event.at >= turn.started!).pop();
    if (!done) return { column: "running", phase: "turn", alive: true, fresh: true, event: turn, since: turn.started! };
    const later = phases.some((event) => (event.started ?? event.at) > t && event.at <= turn.at);
    // After the turn's last phase, a turn with CI waits at the gate.
    if (!later && turn.ci && GATE.has(turn.ci)) return { column: "running", phase: "ci", alive: true, fresh: false, event: done, since: done.at };
    return { column: "running", phase: phaseOf(done.phase), alive: true, fresh: false, event: done, since: done.at };
  }

  if (!last || isVerdict(last) || t - last.at > REPLAY_QUIET_SECONDS) return null;
  if (isTurn(last)) {
    const failed = (last.outcome !== null && REPLAY_FAILURES.has(last.outcome)) || last.result_status !== "done";
    return { column: failed ? "attention" : "review_me", phase: "idle", alive: false, fresh: false, event: last, since: last.at };
  }
  return { column: "running", phase: phaseOf(last.phase), alive: true, fresh: false, event: last, since: last.at };
}

/**
 * The fleet at `t` (Unix seconds), rebuilt from `events`: one record per task that had a ship then, shaped like a
 * live task. `live` are the board's current tasks; a task found there lends its model, effort and the like.
 */
export function replayFleet(events: readonly LogEvent[], t: number, live: readonly TaskSummary[] = []): TaskSummary[] {
  const known = new Map(live.map((task) => [task.slug, task]));
  const fleet: TaskSummary[] = [];
  for (const [slug, list] of bySlug(events)) {
    const moment = momentOf(list, t);
    if (!moment) continue;
    const task = known.get(slug);
    const seen = list.filter((event) => event.at <= t || runs(event, t));
    const latest = <K extends keyof LogEvent>(key: K, from = seen) => {
      for (let i = from.length - 1; i >= 0; i--) if (from[i]![key] !== null) return from[i]![key];
      return null;
    };
    const event = moment.event;
    const work = seen.filter((item) => !isVerdict(item) && item.phase !== "review");
    const turnNumber = (latest("turn") as number | null) ?? task?.turn ?? 0;
    const fixes = seen.filter((item) => item.phase === "fix" && item.turn === turnNumber && item.round !== null);
    const first = list[0]!;
    const kind = list.find((item) => !isVerdict(item))?.kind;
    fleet.push({
      slug,
      kind: kind === "work" || kind === "review" || kind === "scout" ? kind : (task?.kind ?? "work"),
      title: null,
      link: null,
      repo: event.repo!,
      branch: task?.branch ?? null,
      task_type: (latest("task_type") as string | null) ?? task?.task_type ?? null,
      executor: family(latest("provider", work) as string | null) ?? family(latest("provider") as string | null) ?? task?.executor ?? "codex",
      account: (latest("account", work) as string | null) ?? null,
      reviewer: family(moment.phase === "review" ? event.reviewer : (latest("reviewer") as string | null)) ?? task?.reviewer ?? null,
      model: task?.model ?? null,
      effort: task?.effort ?? null,
      column: moment.column,
      phase: moment.phase,
      phase_started_at: moment.since,
      alive: moment.alive,
      turn: turnNumber,
      fix_round: moment.phase === "fix" ? (event.round ?? 0) : Math.max(0, ...fixes.map((item) => item.round!)),
      outcome: moment.alive ? "running" : event.outcome,
      result_status: moment.alive ? null : event.result_status,
      summary: moment.fresh || moment.column === "attention" ? null : describeEvent(event).text,
      pr: null,
      // CI is known only once its turn has ended.
      ci: latest("ci", seen.filter((item) => item.at <= t)) as string | null,
      sleeping_until: null,
      created: first.started ?? first.at,
      updated_at: moment.since,
      activity: moment.fresh ? { at: t, ...ACTIVITY_OF[moment.phase] } : null,
      // The journal does not carry the cargo.
      check: null,
      review: null,
      findings_left: 0,
      stop: null,
      left: 0,
    });
  }
  return fleet;
}

/**
 * How each ship that is gone at `t` left: into the sun after an accepted or revised verdict, otherwise it fades.
 * Only slugs whose latest event by `t` is a verdict are listed.
 */
export function replayDepartures(events: readonly LogEvent[], t: number): Map<string, "dive" | "fade"> {
  const result = new Map<string, "dive" | "fade">();
  for (const [slug, list] of bySlug(events)) {
    const past = list.filter((event) => event.at <= t);
    const last = past[past.length - 1];
    if (last && isVerdict(last)) result.set(slug, TO_SUN.has(last.verdict ?? "") ? "dive" : "fade");
  }
  return result;
}

/**
 * How the scene's missing ships leave on this update: at a replay moment `at`, as `replayDepartures` says; on the
 * first live update after a replay (`replayed`), every ship the live fleet lacks fades, since none of them went
 * into the sun just now; otherwise undefined, and the live map keeps its own rule.
 */
export function replayExits(at: number | null, replayed: boolean, events: readonly LogEvent[]): ReadonlyMap<string, "dive" | "fade"> | undefined {
  if (at !== null) return replayDepartures(events, at);
  return replayed ? new Map() : undefined;
}

/**
 * How a ship that left the map at `place` goes: by `departures` when given, where a slug it lacks fades; otherwise
 * into the sun from the roadstead and fading from anywhere else.
 */
export function departureOf(slug: string, place: string, departures?: ReadonlyMap<string, "dive" | "fade">): "dive" | "fade" {
  if (departures) return departures.get(slug) ?? "fade";
  return place === "roadstead" ? "dive" : "fade";
}

export interface ReplayMark {
  at: number;
  /** Share of the window, 0 to 1. */
  share: number;
  kind: "sun" | "verdict" | "ci";
  text: string;
}

/** Marks on the scale: the verdicts and the CI failures inside `window`. */
export function replayMarks(events: readonly LogEvent[], window: ReplayWindow): ReplayMark[] {
  const span = Math.max(1, window.until - window.since);
  const marks: ReplayMark[] = [];
  for (const event of events) {
    if (event.at < window.since || event.at > window.until) continue;
    const verdict = isVerdict(event);
    if (!verdict && event.ci !== "failed") continue;
    marks.push({
      at: event.at,
      share: (event.at - window.since) / span,
      kind: verdict ? (TO_SUN.has(event.verdict ?? "") ? "sun" : "verdict") : "ci",
      text: describeEvent(event).text,
    });
  }
  return marks;
}

/** Days the replay can show, newest first: the last 24 hours (""), then today and each of the 31 days before it. */
export function replayDays(now: number): string[] {
  const today = new Date(now * 1000);
  const days = [""];
  for (let back = 0; back <= 31; back++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    days.push(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`);
  }
  return days;
}

/** The window of `day` (local YYYY-MM-DD, or "" for the last 24 hours), never past `now`. */
export function replayWindow(day: string, now: number): ReplayWindow {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return { since: now - 24 * 3600, until: now };
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const since = new Date(year, month, date).getTime() / 1000;
  const until = new Date(year, month, date + 1).getTime() / 1000;
  return { since: Math.min(since, now), until: Math.min(until, now) };
}
