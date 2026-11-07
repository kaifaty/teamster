// Where a task's ship is in its star system, from the task alone. The scene only draws the result.

import type { TaskSummary } from "../types";

/**
 * The stations of a system. The route runs towards the sun: yard, range, inspection, gate, roadstead.
 * "cryo" is the sleeping field outside it, "command" is where the lead's own sessions stay.
 */
export type Place = "yard" | "range" | "inspection" | "gate" | "roadstead" | "cryo" | "command";

export const PLACES: readonly Place[] = ["command", "yard", "range", "inspection", "gate", "roadstead", "cryo"];

export type Action =
  | "work" // the ship circles its station: the task is alive and its activity is fresh
  | "wait" // waits for the station: a check, a review or CI
  | "idle" // stands still at its station
  | "sleep" // sleeps until its limit resets
  | "ready"; // waits for the lead

export interface Placement {
  place: Place;
  /** The ship's position at its station, distinct among peers, earliest arrival first. */
  slot: number;
  action: Action;
  /** The ship may circle: the task is alive and its activity is fresh. */
  working: boolean;
  /** The station works for this task: the range during a check, the gate during CI. */
  placeWorking: boolean;
  /** The activity is missing or older than FRESH_SECONDS; the label then shows its age. */
  stale: boolean;
  /** A distress beacon over the ship: the task needs attention. */
  beacon: boolean;
  /** The ship came back to the yard for a fix round. */
  fixing: boolean;
  /** Family of the inspector working with the ship. */
  companion: "codex" | "claude" | null;
}

/** Activity older than this does not move the ship. */
export const FRESH_SECONDS = 60;

/** More ships than this in one system are listed as hidden. */
export const MAX_SHIPS = 40;

/** Whether the task's latest activity is at most FRESH_SECONDS old at `now`. */
export function isFresh(task: TaskSummary, now: number): boolean {
  const at = task.activity?.at;
  return at !== null && at !== undefined && now - at <= FRESH_SECONDS;
}

/** The station of a task that is shown on the map; null for a closed task. */
export function placeOf(task: TaskSummary): Place | null {
  if (task.column === "closed") return null;
  if (task.kind === "session") return "command";
  if (task.column === "sleeping") return "cryo";
  if (task.column === "review_me") return "roadstead";
  // A task in trouble stays where it stopped.
  switch (task.phase) {
    case "check":
      return "range";
    case "review":
      return "inspection";
    case "ci":
      return "gate";
    case "sleeping":
      return "cryo";
    default:
      return "yard"; // turn, fix, idle
  }
}

/** When the ship came to its station: the order of the ships there. */
function arrivedAt(task: TaskSummary): number {
  return task.alive ? (task.phase_started_at ?? task.updated_at) : task.updated_at;
}

function byArrival(a: TaskSummary, b: TaskSummary): number {
  return arrivedAt(a) - arrivedAt(b) || a.slug.localeCompare(b.slug);
}

/**
 * Where `task`'s ship is and what it does at `now` (Unix seconds). `peers` are the ships of its system; they
 * share out the slots of the stations. Returns null for a closed task, which is not on the map.
 */
export function placement(task: TaskSummary, now: number, peers: readonly TaskSummary[] = [task]): Placement | null {
  const place = placeOf(task);
  if (place === null) return null;
  const list = peers.some((peer) => peer.slug === task.slug) ? peers : [...peers, task];
  const slot = list
    .filter((peer) => placeOf(peer) === place)
    .sort(byArrival)
    .findIndex((peer) => peer.slug === task.slug);

  const fresh = task.alive && isFresh(task, now);
  const result: Placement = {
    place,
    slot,
    action: "idle",
    working: false,
    placeWorking: false,
    stale: !isFresh(task, now),
    beacon: task.column === "attention",
    fixing: false,
    companion: null,
  };

  if (task.column === "attention") return result;
  if (task.column === "review_me") return { ...result, action: "ready" };
  if (place === "cryo") return { ...result, action: "sleep" };
  if (place === "range" || place === "gate") return { ...result, action: "wait", placeWorking: task.alive };
  if (place === "inspection") return { ...result, action: "wait", placeWorking: task.alive, companion: task.reviewer };

  const fixing = task.phase === "fix";
  return fresh ? { ...result, action: "work", working: true, fixing } : { ...result, fixing };
}

const COLUMN_RANK: Record<TaskSummary["column"], number> = { running: 0, attention: 1, sleeping: 2, review_me: 3, closed: 4 };

/**
 * The ships of system `repo`, closed tasks left out. At most MAX_SHIPS are shown, running ones first and
 * then the rest by column and most recent update; `shown` is oldest first, `hidden` are the rest.
 */
export function systemTasks(tasks: readonly TaskSummary[], repo: string): { shown: TaskSummary[]; hidden: TaskSummary[] } {
  const live = tasks.filter((task) => task.repo === repo && task.column !== "closed");
  const ranked = [...live].sort(
    (a, b) => COLUMN_RANK[a.column] - COLUMN_RANK[b.column] || b.updated_at - a.updated_at || a.slug.localeCompare(b.slug),
  );
  const shown = ranked
    .slice(0, MAX_SHIPS)
    .sort((a, b) => (a.created ?? a.updated_at) - (b.created ?? b.updated_at) || a.slug.localeCompare(b.slug));
  return { shown, hidden: ranked.slice(MAX_SHIPS) };
}
