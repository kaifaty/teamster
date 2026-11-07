// Where things stand on the map, in world units. Pure numbers: the scene, the labels and the tests share it.
// x grows to the right, y downwards. The camera turns world units into screen pixels.

import type { Place } from "./placement";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The world is laid out for the shape of the window: wide on a desktop, tall on a phone. */
export function worldSize(viewport: Size): Size {
  return viewport.width >= viewport.height ? { width: 1600, height: 1000 } : { width: 1000, height: 1500 };
}

/** The camera: a world point (x, y) is drawn at (x * zoom + tx, y * zoom + ty). */
export interface Camera {
  zoom: number;
  tx: number;
  ty: number;
}

/** The whole world in the window, centred. */
export function fitCamera(world: Size, viewport: Size): Camera {
  const zoom = Math.min(viewport.width / world.width, viewport.height / world.height);
  return { zoom, tx: (viewport.width - world.width * zoom) / 2, ty: (viewport.height - world.height * zoom) / 2 };
}

/** How far the camera may zoom in, as a multiple of the fitted zoom. */
export const MAX_ZOOM = 3;

/** `camera` zoomed by `factor` around the screen point `at`, within the fitted zoom and MAX_ZOOM. */
export function zoomCamera(camera: Camera, factor: number, at: Point, fit: Camera): Camera {
  const zoom = Math.min(fit.zoom * MAX_ZOOM, Math.max(fit.zoom, camera.zoom * factor));
  const scale = zoom / camera.zoom;
  return { zoom, tx: at.x - (at.x - camera.tx) * scale, ty: at.y - (at.y - camera.ty) * scale };
}

/** `camera` kept so that the world covers the window; a world smaller than the window stays centred. */
export function clampCamera(camera: Camera, world: Size, viewport: Size): Camera {
  const axis = (offset: number, worldLength: number, viewLength: number) => {
    const length = worldLength * camera.zoom;
    if (length <= viewLength) return (viewLength - length) / 2;
    return Math.min(0, Math.max(viewLength - length, offset));
  };
  return { zoom: camera.zoom, tx: axis(camera.tx, world.width, viewport.width), ty: axis(camera.ty, world.height, viewport.height) };
}

/** Stable, well spread number from a name. */
export function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Which of `count` skies system `repo` has; the same every time, or null when there are none. */
export function backdropOf(repo: string, count: number): number | null {
  return count > 0 ? hashName(repo) % count : null;
}

/** The skies to try for system `repo`, best first: its own, then its shared one. */
export function skyChoices(repo: string, own: string | undefined, backdrops: readonly string[]): string[] {
  const index = backdropOf(repo, backdrops.length);
  return [...(own ? [own] : []), ...(index === null ? [] : [backdrops[index]!])];
}

// System ------------------------------------------------------------------------------------------

/** The ellipse of the outermost orbit. */
export interface SystemFrame {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export function systemFrame(size: Size): SystemFrame {
  const ry = size.height / 2 - 130;
  return { cx: size.width / 2, cy: size.height / 2 + 24, rx: Math.min(size.width / 2 - 150, ry * 2.6), ry };
}

/** Stations never move, so the eye learns them: `orbit` is a share of the frame, `angle` is in degrees. */
export const STATIONS: Record<Place, { orbit: number; angle: number; radius: number }> = {
  yard: { orbit: 0.9, angle: 180, radius: 110 },
  range: { orbit: 0.74, angle: 238, radius: 64 },
  inspection: { orbit: 0.64, angle: 320, radius: 96 },
  gate: { orbit: 0.46, angle: 62, radius: 58 },
  roadstead: { orbit: 0.3, angle: 170, radius: 46 },
  cryo: { orbit: 0.97, angle: 345, radius: 70 },
  command: { orbit: 0.9, angle: 128, radius: 76 },
};

/** The way a task goes, towards the sun. */
export const ROUTE: readonly Place[] = ["yard", "range", "inspection", "gate", "roadstead"];

export const SUN_RADIUS = 78;

export function orbitPoint(frame: SystemFrame, orbit: number, degrees: number): Point {
  const angle = (degrees * Math.PI) / 180;
  return { x: frame.cx + orbit * frame.rx * Math.cos(angle), y: frame.cy + orbit * frame.ry * Math.sin(angle) };
}

/** Ships keep out of the sun by this distance from its centre. */
export const SUN_CLEARANCE = SUN_RADIUS + 44;

/** A station's point. On a narrow screen the inner orbits squeeze, so a station is kept clear of the sun. */
export function stationAt(place: Place, frame: SystemFrame): Point {
  const { orbit, angle, radius } = STATIONS[place];
  const point = orbitPoint(frame, orbit, angle);
  const distance = Math.hypot(point.x - frame.cx, point.y - frame.cy);
  const least = SUN_RADIUS + radius + 36;
  if (distance >= least) return point;
  return { x: frame.cx + ((point.x - frame.cx) / distance) * least, y: frame.cy + ((point.y - frame.cy) / distance) * least };
}

/** Ships circle this far from a station's edge; further rings follow, each clear of the one inside it. */
const RING_GAP = 46;
/** The size of a light ship; a larger ship's ring moves out so that it keeps the same clearance. */
export const LIGHT_SHIP = 74;
/** The share of its size a ship's art fills, and the room left between two ships on a ring. */
const FOOTPRINT = 0.8;
const SHIP_GAP = 12;

/**
 * The rings of a station's ships, `sizes` in slot order: each ship gets the `radius` of its ring from the
 * station's centre and its starting `angle` in radians. A ring takes ships in order while they fit around it
 * with SHIP_GAP between them even where the ring is flattened; a ring of larger ships moves out, so that the
 * ships keep clear of the station and of the ring inside.
 */
export function ringsOf(place: Place, sizes: readonly number[]): { radius: number; angle: number }[] {
  const result: { radius: number; angle: number }[] = [];
  const width = (size: number) => size * FOOTPRINT + SHIP_GAP;
  let first = 0;
  let ring = 0;
  let inner: { radius: number; largest: number } | null = null;
  const radiusFor = (largest: number) =>
    inner === null
      ? STATIONS[place].radius + RING_GAP + Math.max(0, largest - LIGHT_SHIP) / 2
      : inner.radius + ((inner.largest + largest) / 2) * (FOOTPRINT / RING_FLATTENING);
  while (first < sizes.length) {
    let last = first + 1;
    let largest = sizes[first]!;
    let used = width(largest);
    while (last < sizes.length) {
      const next = Math.max(largest, sizes[last]!);
      if (used + width(sizes[last]!) > Math.PI * 2 * RING_FLATTENING * radiusFor(next)) break;
      largest = next;
      used += width(sizes[last]!);
      last += 1;
    }
    const radius = radiusFor(largest);
    // Neighbours stand half their widths apart, measured where the ring is flattened most.
    let angle = ring * 0.4;
    for (let index = first; index < last; index++) {
      if (index > first) angle += (width(sizes[index - 1]!) + width(sizes[index]!)) / 2 / (RING_FLATTENING * radius);
      result.push({ radius, angle });
    }
    inner = { radius, largest };
    first = last;
    ring += 1;
  }
  return result;
}

/** Light ship `slot` of a station with light ships only: see ringsOf. */
export function ringOf(place: Place, slot: number): { radius: number; angle: number } {
  return ringsOf(place, Array.from({ length: slot + 1 }, () => LIGHT_SHIP))[slot]!;
}

/** A ship's point on its ring; the rings are flattened a little, like the orbits. */
export function ringPoint(station: Point, radius: number, angle: number): Point {
  return { x: station.x + radius * Math.cos(angle), y: station.y + radius * RING_FLATTENING * Math.sin(angle) };
}

const RING_FLATTENING = 0.75;

/**
 * Where a station's card stands: centred under the first ring of its ships. The command station is low on the
 * map, so its card starts beside the ring instead, and a long list still fits.
 */
export function cardPlace(place: Place, frame: SystemFrame): Point & { side: boolean } {
  const station = stationAt(place, frame);
  const reach = STATIONS[place].radius + RING_GAP;
  if (place === "command") return { x: station.x + reach + 30, y: station.y - 18, side: true };
  return { x: station.x, y: station.y + reach * RING_FLATTENING + 34, side: false };
}

// Galaxy ------------------------------------------------------------------------------------------

const GRIDS: readonly (readonly [number, number])[] = [
  [6, 3],
  [8, 4],
  [10, 5],
  [14, 7],
];

/**
 * Stars of the repositories. Each takes a cell of a grid by the hash of its name, so a star stays in place
 * when other repositories come and go, and two stars never share a cell while the grid has room.
 */
export function starPositions(repos: readonly string[], size: Size): Map<string, Point> {
  const [columns, rows] = GRIDS.find(([c, r]) => c * r >= repos.length * 1.5) ?? GRIDS[GRIDS.length - 1]!;
  const count = columns * rows;
  const taken = new Set<number>();
  const result = new Map<string, Point>();
  for (const repo of [...repos].sort((a, b) => a.localeCompare(b))) {
    const hash = hashName(repo);
    let cell = hash % count;
    for (let tries = 0; tries < count && taken.has(cell); tries++) cell = (cell + 1) % count;
    taken.add(cell);
    const jitterX = ((hash >>> 8) % 100) / 100 - 0.5;
    const jitterY = ((hash >>> 16) % 100) / 100 - 0.5;
    const column = (cell % columns) + 0.5 + jitterX * 0.4;
    const row = Math.floor(cell / columns) + 0.5 + jitterY * 0.4;
    result.set(repo, { x: size.width * (0.08 + (0.84 * column) / columns), y: size.height * (0.26 + (0.46 * row) / rows) });
  }
  return result;
}

/** A star grows with the number of its ships; a star without ships stays small. */
export function starRadius(live: number): number {
  return live === 0 ? 16 : Math.min(46, 18 + Math.round(Math.sqrt(live) * 9));
}

/** Codex depots stand along the top edge, Claude depots along the bottom one. */
export function depotPosition(index: number, count: number, row: "top" | "bottom", size: Size): Point {
  return {
    x: (size.width * (index + 0.5)) / Math.max(1, count),
    y: row === "top" ? 125 : size.height - 90,
  };
}
