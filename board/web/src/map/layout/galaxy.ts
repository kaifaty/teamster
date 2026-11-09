// The galaxy's stars as the layout knows them: their shapes, their sizes and the room each takes.

import type { Point, Rect, Size } from "./geometry";

/** What the galaxy's layout knows of a star: its name and its ships. */
export interface StarShape {
  repo: string;
  live: number;
  attention: number;
  ready: number;
  sleeping: number;
}

/** Where the stars stand, and the lattice they stand on. */
export interface Galaxy {
  places: Map<string, Point>;
  /** The step of the lattice, in world units. */
  spacing: number;
  /** How much smaller the stars are drawn in a crowded galaxy. */
  scale: number;
  /** The zoom, in pixels per world unit, the labels' room was reserved at: the window's full view. */
  labelZoom: number;
  /** The world the layout was made for. */
  world: Size;
  /** Busy stars whose labels found no room of their own, which wait for the zoom, and stars that found no room at all. */
  crowded: number;
  /** The constellations the layout gathered, as `constellationKey` gives them: a change lays the stars out afresh. */
  groups: string;
}

/** Which constellation each repository is in, by repository; a repository in none is absent. */
export type Groups = ReadonlyMap<string, string>;

/** The constellations as one text, so that two layouts can tell whether they gathered the same stars. */
export function constellationKey(groups: Groups): string {
  return JSON.stringify([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

/** The zoom of the full view on a laptop: the labels' room is reserved at it until the map knows its window. */
export const LABEL_ZOOM = 0.75;

/** The widest label of a star, in pixels. */
export const LABEL_MAX_WIDTH = 220;

/** A star's label in pixels: the emblem, the name, the ships and a badge for each kind of trouble; a quiet star's is its name. */
export function starLabelSize(star: StarShape): Size {
  if (!star.live) return { width: Math.round(star.repo.length * 6.6 + 8), height: 17 };
  const digits = (count: number) => String(count).length;
  const badges = [star.attention, star.ready, star.sleeping].filter(Boolean).reduce((sum, count) => sum + digits(count) * 7 + 16, 0);
  return { width: Math.min(LABEL_MAX_WIDTH, Math.round(star.repo.length * 7.3 + digits(star.live) * 7 + 52 + badges)), height: 23 };
}

/** The step of the lattice and the scale of the stars on it. */
export type Lattice = Pick<Galaxy, "spacing" | "scale">;
/** The lattice and the zoom the labels' room is reserved at. */
export type LabelledLattice = Pick<Galaxy, "spacing" | "scale" | "labelZoom">;

/** A star's radius as the galaxy draws it: by its ships, at the galaxy's scale, and never wider than a third of a step. */
export function starSize(live: number, lattice: Lattice): number {
  return Math.min(starRadius(live) * lattice.scale, lattice.spacing * 0.36);
}

/** World units from a star's centre down to the top of its label, below the ring of its ship dots. */
export function labelDrop(live: number, lattice: Lattice): number {
  return starSize(live, lattice) * 1.25 + 22 * lattice.scale;
}

/** The radius of the storm over a star with ships in trouble, in world units. */
export function stormRadius(live: number, lattice: Lattice): number {
  return starSize(live, lattice) * 1.25 + 62 * lattice.scale;
}

/** The room a star takes: itself, its storm and its label below. The lattice keeps the stars a step apart. */
export function starFootprint(star: StarShape, at: Point, lattice: LabelledLattice): Rect {
  const glow = starSize(star.live, lattice) * 1.15 + 4;
  const storm = star.attention ? stormRadius(star.live, lattice) * 0.75 : 0;
  const label = starLabelSize(star);
  // A quiet star's name shows only where there is room for it, so it claims none.
  const half = Math.max(glow, storm, star.live ? label.width / lattice.labelZoom / 2 + 8 : 0);
  const below = star.live ? labelDrop(star.live, lattice) + label.height / lattice.labelZoom + 8 : glow;
  return { x0: at.x - half, y0: at.y - glow, x1: at.x + half, y1: at.y + below };
}

/** A star grows with the number of its ships; a star without ships stays small. */
export function starRadius(live: number): number {
  return live === 0 ? 16 : Math.min(46, 18 + Math.round(Math.sqrt(live) * 9));
}
