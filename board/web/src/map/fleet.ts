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
}

/** Below this share the depot is shown as low. */
export const LOW_FUEL = 20;

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
