// The galaxy from the board's data: one star per repository, one fuel depot per account, and the supply
// lines between them.

import { parseAccounts } from "../lib/accounts";
import type { TaskSummary } from "../types";
import { depotPosition, type Point, type Size } from "./layout";

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

export interface Depot {
  key: string;
  name: string;
  executor: Family;
  /** Weekly limit left, in percent; null when the account does not report it. */
  fuel: number | null;
  /** Limited, exhausted or logged out: the depot gives nothing. */
  bad: boolean;
  status: string | null;
  duty: boolean;
  /** Unix seconds when the account's limit resets: its own limit first, else the weekly one; null when unknown. */
  refuelAt: number | null;
}

/** Below this share the depot is shown as low. */
export const LOW_FUEL = 20;

/** The depot gives nothing or almost nothing: it blinks on the map and its label tells when it refuels. */
export function depotEmpty(depot: Pick<Depot, "bad" | "fuel">): boolean {
  return depot.bad || (depot.fuel !== null && depot.fuel <= LOW_FUEL);
}

/** "заправка через N ч", or "через N мин" under an hour, until `at` (Unix seconds); null without a future time. */
export function refuelText(at: number | null, now: number): string | null {
  if (at === null || at <= now) return null;
  const minutes = Math.max(1, Math.ceil((at - now) / 60));
  return minutes < 60 ? `заправка через ${minutes} мин` : `заправка через ${Math.round(minutes / 60)} ч`;
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

/** A hull's size on the map, in world units: a frigate and a cruiser are clearly larger than a light ship. */
export const HULL_SIZE: Record<Hull, number> = { light: 74, frigate: 92, cruiser: 114, scout: 46, flagship: 150 };

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

export interface SupplyLine {
  depot: string;
  repo: string;
  /** A ship of this repository is working on this account right now. */
  active: boolean;
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

export function depots(data: unknown, now: number): Depot[] {
  const items = parseAccounts(data, now).items ?? [];
  const result: Depot[] = [];
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
      duty: row.duty !== null,
      refuelAt: row.limitedUntil ?? row.weeklyResetsAt,
    });
  }
  return result;
}

export function supplyLines(tasks: readonly TaskSummary[], known: readonly Depot[]): SupplyLine[] {
  const keys = new Set(known.map((depot) => depot.key));
  const lines = new Map<string, SupplyLine>();
  for (const task of tasks) {
    if (task.column === "closed" || !task.account) continue;
    const depot = `${task.executor}:${task.account}`;
    if (!keys.has(depot)) continue;
    const key = `${depot}|${task.repo}`;
    const line = lines.get(key) ?? { depot, repo: task.repo, active: false };
    line.active ||= task.alive;
    lines.set(key, line);
  }
  return [...lines.values()];
}

/** Each depot's place: Codex along the top edge, Claude along the bottom one, in the order given. */
export function depotPositions(known: readonly Depot[], size: Size): Map<string, Point> {
  const result = new Map<string, Point>();
  for (const [family, row] of [["codex", "top"], ["claude", "bottom"]] as const) {
    const list = known.filter((depot) => depot.executor === family);
    list.forEach((depot, index) => result.set(depot.key, depotPosition(index, list.length, row, size)));
  }
  return result;
}
