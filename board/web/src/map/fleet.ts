// The galaxy from the board's data: one star per repository and one fuel tank per account.

import { parseAccounts } from "../lib/accounts";
import type { TaskSummary } from "../types";

export type Family = "codex" | "claude";

export interface Star {
  repo: string;
  live: number;
  attention: number;
  ready: number;
  sleeping: number;
  /** What the small dots around the star show, one per ship. */
  dots: { executor: Family; state: "work" | "attention" | "ready" | "sleep" }[];
}

/** A subscription as a fuel tank at the galaxy's edge. */
export interface Tank {
  key: string;
  name: string;
  executor: Family;
  /** Weekly limit left, in percent; null when the account does not report it. */
  fuel: number | null;
  /** Limited, exhausted or logged out: the tank gives nothing. */
  bad: boolean;
  status: string | null;
  /** The account kept for the orchestrator (teamster's duty account): new tasks skip it. */
  admiral: boolean;
  /**
   * Unix seconds when the tank refills: an exhausted or limited account at the end of its limit, any other at the weekly
   * reset; null when unknown or when the account needs a login or a token rather than a reset.
   */
  refillAt: number | null;
  /** Free resets left (Codex reset credits) and when each expires; null when the account has none to tell. */
  resets: { count: number; expires: number[] } | null;
  /** The five-hour window in percent used, and when it resets; null when not reported. */
  burst: { percent: number; resetsAt: number | null } | null;
}

/** Below this share the tank is shown as low. */
export const LOW_FUEL = 20;

/** The tank gives nothing or almost nothing: its glass runs red and it blinks a warning light. */
export function tankEmpty(tank: Pick<Tank, "bad" | "fuel">): boolean {
  return tank.bad || (tank.fuel !== null && tank.fuel <= LOW_FUEL);
}

/** How long until `at` (Unix seconds), short: "3 д", "10 ч", "25 мин"; null without a future time. */
export function untilText(at: number | null, now: number): string | null {
  if (at === null || at <= now) return null;
  const minutes = Math.max(1, Math.ceil((at - now) / 60));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} ч` : `${Math.round(hours / 24)} д`;
}

/** The lamps beside a tank, one per day of the week: as many burn as days are left until it refills, 0 to 7. */
export const DAY_LAMPS = 7;
export function daysLeft(at: number | null, now: number): number {
  if (at === null || at <= now) return 0;
  return Math.min(DAY_LAMPS, Math.ceil((at - now) / 86400));
}

/**
 * A ship's hull: sessions are flagships and scouts stay scouts; a task's ship grows with its effort, a light
 * ship up to medium, a frigate at high and a cruiser above it.
 */
export type Hull = "light" | "frigate" | "cruiser" | "scout" | "flagship";

export function hullOf(task: Pick<TaskSummary, "kind" | "effort">): Hull {
  if (task.kind === "session") return "flagship";
  if (task.kind === "scout") return "scout";
  switch (task.effort) {
    case "high":
      return "frigate";
    case "xhigh":
    case "max":
    case "ultra":
      return "cruiser";
    default:
      return "light";
  }
}

/**
 * A hull's size on the map, in world units: a frigate and a cruiser are clearly larger than a light ship, and every
 * ship is small next to its station, so that a crowded station still reads as a planet with its fleet.
 */
export const HULL_SIZE: Record<Hull, number> = { light: 46, frigate: 54, cruiser: 64, scout: 32, flagship: 72 };

/** A ship shows at most this many patches, one per fix round. */
export const MAX_PATCHES = 3;

/** Spots on the middle of every hull, in shares of the ship's size from its centre, nose up. */
const PATCH_SPOTS: readonly { x: number; y: number }[] = [
  { x: -0.1, y: -0.08 },
  { x: 0.09, y: -0.02 },
  { x: -0.07, y: 0.13 },
  { x: 0.08, y: 0.18 },
  { x: 0.01, y: 0.05 },
  { x: -0.02, y: -0.17 },
];

function hashSlug(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/**
 * Where the patches of `slug`'s ship sit after `fixRound` fix rounds: one per round, at most MAX_PATCHES, at
 * distinct spots that depend only on the slug, so that a patch stays where it was put.
 */
export function patchSpots(slug: string, fixRound: number): { x: number; y: number; angle: number }[] {
  const count = Math.max(0, Math.min(MAX_PATCHES, Math.floor(fixRound)));
  const free = [...PATCH_SPOTS];
  const result: { x: number; y: number; angle: number }[] = [];
  for (let i = 0; i < count; i++) {
    const hash = hashSlug(`${slug}#${i}`);
    const spot = free.splice(hash % free.length, 1)[0]!;
    result.push({ x: spot.x, y: spot.y, angle: (((hash >>> 8) % 100) / 100 - 0.5) * 1.2 });
  }
  return result;
}

export function stars(tasks: readonly TaskSummary[]): Star[] {
  const byRepo = new Map<string, Star>();
  for (const task of tasks) {
    const star = byRepo.get(task.repo) ?? { repo: task.repo, live: 0, attention: 0, ready: 0, sleeping: 0, dots: [] };
    byRepo.set(task.repo, star);
    if (task.column === "closed") continue;
    star.live += 1;
    const state =
      task.column === "attention" ? "attention" : task.column === "review_me" ? "ready" : task.column === "sleeping" ? "sleep" : "work";
    if (state === "attention") star.attention += 1;
    if (state === "ready") star.ready += 1;
    if (state === "sleep") star.sleeping += 1;
    star.dots.push({ executor: task.executor, state });
  }
  return [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

export function tanks(data: unknown, now: number): Tank[] {
  const items = parseAccounts(data, now).items ?? [];
  const result: Tank[] = [];
  for (const item of items) {
    if (item.kind !== "row") continue;
    const { row } = item;
    result.push({
      key: `${row.executor}:${row.name}`,
      name: row.name,
      executor: row.executor,
      fuel: row.weeklyPercent === null ? null : Math.max(0, Math.round(100 - row.weeklyPercent)),
      bad: row.bad,
      status: row.status,
      admiral: row.duty !== null,
      refillAt: row.bad ? row.limitedUntil : row.weeklyResetsAt,
      resets: row.resets,
      burst: row.burst,
    });
  }
  return result;
}
