import type { Camera } from "../layout/camera";

import { hashName, type Point, type Rect, type Size } from "../layout/geometry";
import { placeTerritories } from "./placement";
import { isCurrent, type CurrentTask, type SurfaceTask } from "./types";

export type Biome = "forest" | "volcanic";

export interface Site extends Point {
  task: CurrentTask;
  accepted: number;
  children: number;
  dependents: string[];
}

export interface Region {
  project: string;
  biome: Biome;
  outline: string;
  label: Point;
  labelWidth: number;
  bounds: Rect;
  sites: Site[];
}

export interface SurfaceLayout {
  regions: Map<string, Region>;
  sites: Map<string, Site>;
  world: Size;
  landRows: Rect[];
  coastline: string;
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

function placeSites(tasks: CurrentTask[], clearings: Point[]) {
  const members = new Set(tasks.map(task => task.id));
  const children = new Map<string, CurrentTask[]>();
  for (const task of tasks) {
    if (task.parent_id !== null) append(children, task.parent_id, task);
  }
  const roots = tasks.filter(task => task.parent_id === null || !members.has(task.parent_id));
  const stack = [...roots, ...tasks].reverse();
  const placed = new Map<string, Site>();
  while (stack.length) {
    const task = stack.pop()!;
    if (placed.has(task.id)) continue;
    const parent = task.parent_id === null ? undefined : placed.get(task.parent_id);
    let nearest = 0;
    if (parent) {
      const distance = (p: Point) => Math.hypot(p.x - parent.x, p.y - parent.y);
      for (let i = 1; i < clearings.length; i++) {
        if (distance(clearings[i]!) < distance(clearings[nearest]!)) nearest = i;
      }
    }
    const point = clearings.splice(nearest, 1)[0]!;
    placed.set(task.id, { task, ...point, accepted: 0, children: 0, dependents: [] });
    const descendants = children.get(task.id) ?? [];
    for (let i = descendants.length - 1; i >= 0; i--) stack.push(descendants[i]!);
  }
  return [...placed.values()];
}

export function layoutSurface(tasks: readonly SurfaceTask[], biomes: Record<string, string> = {}): SurfaceLayout {
  const groups = new Map<string, CurrentTask[]>();
  for (const task of tasks) {
    if (isCurrent(task)) append(groups, task.project, task);
  }
  const projects = [...groups.keys()].sort();
  const { world, landRows, coastline, territories } = placeTerritories(projects.map(project => groups.get(project)!.length));
  const overrides = new Map(Object.entries(biomes).map(([project, biome]) => [project.toLowerCase(), biome]));
  const regions = new Map<string, Region>();
  const sites = new Map<string, Site>();
  projects.forEach((project, index) => {
    const { clearings, ...territory } = territories[index]!;
    const group = groups.get(project)!.sort((a, b) => {
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
    const members = placeSites(group, clearings);
    regions.set(project, { project, biome: biomeOf(project, overrides), ...territory, sites: members });
    for (const site of members) sites.set(site.task.id, site);
  });
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
  return { regions, sites, world, landRows, coastline };
}

export const BUILDING_WIDTH = 76;
export const BUILDING_HEIGHT = 52;

export function buildingRect(site: Point, { tx, ty, zoom }: Camera): Rect {
  const x = tx + site.x * zoom, y = ty + site.y * zoom;
  const halfWidth = BUILDING_WIDTH * zoom / 2;
  return { x0: x - halfWidth, x1: x + halfWidth, y0: y - BUILDING_HEIGHT * zoom, y1: y };
}

export function overlaps(a: Rect, b: Rect) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

export function pickSurfaceSite(at: Point, size: Size, targets: readonly {
  id: string; building: Rect; plate?: Rect; priority: number;
}[], coarse: boolean, covered?: Rect) {
  const contains = (rect: Rect) => at.x >= rect.x0 && at.x <= rect.x1 && at.y >= rect.y0 && at.y <= rect.y1;
  if (!contains({ x0: 0, y0: 0, x1: size.width, y1: size.height }) || (covered && contains(covered))) return null;
  let front: string | null = null, frontPriority = -1;
  let nearest: string | null = null, distance = Infinity;
  for (const { id, building, plate, priority } of targets) {
    if (contains(building) || (plate && contains(plate))) {
      if (priority >= frontPriority) {
        front = id;
        frontPriority = priority;
      }
    } else if (coarse && front === null) {
      const { x0, y0, x1, y1 } = building;
      const left = Math.max(0, x0), right = Math.min(size.width, x1);
      const top = Math.max(0, y0), bottom = Math.min(size.height, y1);
      if (left >= right || top >= bottom) continue;
      if (covered && covered.x0 <= left && covered.x1 >= right && covered.y0 <= top && covered.y1 >= bottom) continue;
      const dx = at.x - (x0 + x1) / 2, dy = at.y - (y0 + y1) / 2;
      if (Math.abs(dx) > Math.max(22, (x1 - x0) / 2) || Math.abs(dy) > Math.max(22, (y1 - y0) / 2)) continue;
      const squared = dx * dx + dy * dy;
      if (squared < distance) {
        distance = squared;
        nearest = id;
      }
    }
  }
  return front ?? nearest;
}
