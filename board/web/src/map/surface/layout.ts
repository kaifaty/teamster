import { hashName, type Point } from "../layout/geometry";
import type { BankPlacement } from "./placement";
import type { SurfaceTask } from "./types";

export type Biome = "forest" | "volcanic";
type CurrentTask = SurfaceTask & { status: Exclude<SurfaceTask["status"], "done" | "cancelled"> };

// The two terrain tiles meet at the river. A project grows down its bank in rows of three clearings.
export const BANK_WIDTH = 672;
const CLEARINGS = [{ x: 336, y: 200 }, { x: 133, y: 271 }, { x: 539, y: 310 }];

export interface Site extends Point {
  task: CurrentTask;
  slot: number;
  accepted: number;
  children: number;
  dependents: string[];
}

export interface Region {
  project: string;
  bank: number;
  biome: Biome;
  sites: Site[];
}

export interface SurfaceLayout {
  regions: Map<string, Region>;
  sites: Map<string, Site>;
  placement: BankPlacement[];
}

function biomeOf(project: string, overrides: Map<string, string>): Biome {
  const name = project.toLowerCase();
  const override = overrides.get(name);
  if (override === "forest" || override === "volcanic") return override;
  if (name === "teamster") return "volcanic";
  if (["готика", "gothic", "gothicai"].includes(name)) return "forest";
  return hashName(name) % 2 ? "volcanic" : "forest";
}

function append(groups: Map<string, CurrentTask[]>, key: string, task: CurrentTask) {
  const group = groups.get(key);
  if (group) group.push(task);
  else groups.set(key, [task]);
}

// Keep a new relative in the same row if possible, then look in the rows beside it.
function nearSlot(slot: number, occupied: Set<number>): number {
  const width = CLEARINGS.length;
  const row = Math.floor(slot / width);
  const x = CLEARINGS[slot % width]!.x;
  const columns = CLEARINGS.map((_, i) => i).sort((a, b) =>
    Math.abs(CLEARINGS[a]!.x - x) - Math.abs(CLEARINGS[b]!.x - x));
  for (let distance = 0; ; distance++) {
    for (const r of distance ? [row + distance, row - distance] : [row]) {
      if (r < 0) continue;
      for (const col of columns) {
        const candidate = r * width + col;
        if (!occupied.has(candidate)) return candidate;
      }
    }
  }
}

function placeRegion(region: Region, tasks: CurrentTask[], savedSlots: Record<string, number>) {
  const members = new Set(tasks.map(task => task.id));
  const slots = new Map<string, number>();
  const occupied = new Set<number>();
  const children = new Map<string, CurrentTask[]>();
  const familySlot = new Map<string, number>();
  for (const [id, slot] of Object.entries(savedSlots)) {
    if (!members.has(id)) continue;
    slots.set(id, slot);
    occupied.add(slot);
  }
  for (const task of tasks) {
    if (task.parent_id === null) continue;
    append(children, task.parent_id, task);
    const kept = slots.get(task.id);
    if (kept !== undefined) familySlot.set(task.parent_id, kept);
  }

  const roots = tasks.filter(task => task.parent_id === null || !members.has(task.parent_id));
  // Visit families together. The second pass also places cards whose parent chain has no root.
  const stack = [...roots, ...tasks].reverse();
  const visited = new Set<string>();
  let next = 0;
  while (stack.length) {
    const task = stack.pop()!;
    if (visited.has(task.id)) continue;
    visited.add(task.id);
    let slot = slots.get(task.id);
    if (slot === undefined) {
      const parent = task.parent_id;
      const parentSlot = parent === null ? undefined : slots.get(parent) ?? familySlot.get(parent);
      const relative = parentSlot ?? familySlot.get(task.id);
      while (occupied.has(next)) next++;
      slot = relative === undefined ? next : nearSlot(relative, occupied);
      slots.set(task.id, slot);
      occupied.add(slot);
    }
    if (task.parent_id !== null) familySlot.set(task.parent_id, slot);
    const clearing = CLEARINGS[slot % CLEARINGS.length]!;
    region.sites.push({
      task, slot, x: region.bank * BANK_WIDTH + clearing.x,
      y: Math.floor(slot / CLEARINGS.length) * 160 + (region.bank % 2 ? 500 - clearing.y : clearing.y),
      accepted: 0, children: 0, dependents: [],
    });
    const descendants = children.get(task.id) ?? [];
    for (let i = descendants.length - 1; i >= 0; i--) stack.push(descendants[i]!);
  }
  region.sites.sort((a, b) => a.slot - b.slot);
}

export function layoutSurface(tasks: readonly SurfaceTask[], biomes: Record<string, string> = {}, previous?: Pick<SurfaceLayout, "placement">): SurfaceLayout {
  const groups = new Map<string, CurrentTask[]>();
  for (const task of tasks) {
    if (task.status !== "done" && task.status !== "cancelled") append(groups, task.project, task as CurrentTask);
  }
  const overrides = new Map(Object.entries(biomes).map(([project, biome]) => [project.toLowerCase(), biome]));
  const regions = new Map<string, Region>();
  const sites = new Map<string, Site>();
  const saved = previous?.placement ?? [];
  const banks = new Map(saved.map(({ project }, bank) => [project, bank]));
  const placement: BankPlacement[] = saved.map(({ project }) => ({ project, slots: {} }));

  for (const project of [...groups.keys()].sort((a, b) => a.localeCompare(b, "ru"))) {
    const bank = banks.get(project) ?? placement.length;
    const region: Region = { project, biome: biomeOf(project, overrides), bank, sites: [] };
    placeRegion(region, groups.get(project)!.sort((a, b) => a.id.localeCompare(b.id)), saved[bank]?.slots ?? {});
    placement[bank] = { project, slots: Object.fromEntries(region.sites.map(site => [site.task.id, site.slot])) };
    regions.set(project, region);
    for (const site of region.sites) sites.set(site.task.id, site);
  }
  for (const task of tasks) {
    const parent = task.parent_id === null ? undefined : sites.get(task.parent_id);
    if (parent && task.status !== "cancelled") {
      parent.children++;
      if (task.status === "done") parent.accepted++;
    }
  }
  for (const { task } of sites.values()) {
    for (const id of new Set(task.depends_on)) {
      if (id !== task.id) sites.get(id)?.dependents.push(task.id);
    }
  }
  return { regions, sites, placement };
}
