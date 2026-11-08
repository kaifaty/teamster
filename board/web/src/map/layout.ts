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

/**
 * A zoom from `zoom` by `factor`, kept within the fitted zoom and MAX_ZOOM; `past` is how far it asked beyond them,
 * as a natural logarithm: below zero past the fitted view, above zero past the closest one.
 */
export function limitZoom(zoom: number, factor: number, fit: Camera): { zoom: number; past: number } {
  const wanted = zoom * factor;
  const kept = Math.min(fit.zoom * MAX_ZOOM, Math.max(fit.zoom, wanted));
  return { zoom: kept, past: Math.log(wanted / kept) };
}

/**
 * `camera` carried over to a window of another size: the same share of the fitted zoom, around the same world point
 * in the middle of the window.
 */
export function refitCamera(camera: Camera, before: { fit: Camera; viewport: Size }, fit: Camera, viewport: Size, world: Size): Camera {
  const zoom = fit.zoom * (camera.zoom / before.fit.zoom);
  const x = (before.viewport.width / 2 - camera.tx) / camera.zoom;
  const y = (before.viewport.height / 2 - camera.ty) / camera.zoom;
  return clampCamera({ zoom, tx: viewport.width / 2 - x * zoom, ty: viewport.height / 2 - y * zoom }, world, viewport);
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

/** The research station watches every system, so it stands in the middle of the galaxy. */
export function researchPosition(size: Size): Point {
  return { x: size.width * 0.5, y: size.height * 0.49 };
}

/** The station's size in world units. */
export const RESEARCH_SIZE = 150;

/** A machine's power station: the long side of its sprite in world units, and the least it shrinks to in a long column. */
export const MACHINE_SIZE = 96;
export const MACHINE_MIN_SIZE = 56;

/** A rectangle in world units. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

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
  /** Busy stars whose labels found no room of their own; they wait for the zoom. */
  crowded: number;
}

/** The zoom of the full view on a laptop: the labels' room is reserved at it until the map knows its window. */
export const LABEL_ZOOM = 0.75;
/** Two steps of the lattice differ by this ratio, so that a galaxy that gains or loses a star usually keeps its lattice. */
const SPACING_LADDER = 1.08;
/** The stars share the free part of the galaxy with a quarter more room than they take, so that it fills evenly. */
const SPARE = 1.25;
/** The share of a step a star stands off its node, so that the rows do not look ruled. */
const NODE_JITTER = 0.12;
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

/**
 * The parts of the galaxy where no star stands: the research station, the depots and the machines' power stations with
 * their labels, and the parts `covered` by the map's own panels.
 */
export function galaxyKeepOuts(size: Size, depots: readonly Point[], covered: readonly Rect[], machines: MachineColumn | null = null): Rect[] {
  const station = researchPosition(size);
  const result: Rect[] = [
    { x0: station.x - 150, y0: station.y - RESEARCH_SIZE / 2 - 40, x1: station.x + 150, y1: station.y + RESEARCH_SIZE / 2 + 85 },
  ];
  for (const depot of depots) {
    const top = depot.y < size.height / 2;
    result.push(
      top ? { x0: depot.x - 120, y0: 0, x1: depot.x + 120, y1: depot.y + 165 } : { x0: depot.x - 120, y0: depot.y - 170, x1: depot.x + 120, y1: size.height },
    );
  }
  if (machines) result.push(...machineRooms(machines));
  return [...result, ...covered];
}

/** The part of the world under the ship's log, until the map measures it: the lower left corner, or the bottom on a phone. */
export function logCorner(size: Size): Rect {
  return size.width >= size.height
    ? { x0: 0, y0: size.height * 0.64, x1: size.width * 0.37, y1: size.height }
    : { x0: 0, y0: size.height * 0.8, x1: size.width, y1: size.height };
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

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
/**
 * A number in [0, 1) from a name, its bits mixed well: names that differ in their last letter, like art-1 and art-2,
 * land far apart.
 */
function unit(name: string): number {
  let hash = hashName(name);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 2 ** 32;
}

/** The region the stars stand in: clear of the depots' rows at the edges. */
function galaxyRegion(size: Size): Rect {
  return { x0: 60, y0: 140, x1: size.width - 60, y1: size.height - 30 };
}

function freeArea(region: Rect, blocked: readonly Rect[]): number {
  let area = 0;
  for (let x = region.x0 + 10; x < region.x1; x += 20) {
    for (let y = region.y0 + 10; y < region.y1; y += 20) {
      if (!blocked.some((rect) => x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1)) area += 400;
    }
  }
  return area;
}

/** The nodes of a hexagonal lattice over the region, each row shifted by half a step; none inside `blocked`. */
function latticeNodes(region: Rect, blocked: readonly Rect[], spacing: number): Point[] {
  const nodes: Point[] = [];
  const rowStep = (spacing * Math.sqrt(3)) / 2;
  for (let row = 0, y = region.y0 + rowStep / 2; y < region.y1; row++, y += rowStep) {
    for (let x = region.x0 + spacing / 2 + (row % 2 ? spacing / 2 : 0); x < region.x1; x += spacing) {
      if (!blocked.some((rect) => x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1)) nodes.push({ x, y });
    }
  }
  return nodes;
}

/** The star alone, without its label: no two of these overlap, nor the keep-outs. */
function starCore(star: StarShape, at: Point, lattice: Lattice): Rect {
  const glow = starSize(star.live, lattice) * 1.15 + 4;
  return { x0: at.x - glow, y0: at.y - glow, x1: at.x + glow, y1: at.y + glow };
}

/**
 * Places the stars on one lattice. A star takes the nearest node to its home, within a few steps, where it and its
 * label fit; failing that, the nearest node where the star itself fits, its label left to wait for the zoom, which
 * `crowded` counts.
 */
function placeStars(
  stars: readonly StarShape[],
  region: Rect,
  blocked: readonly Rect[],
  lattice: LabelledLattice,
  previous: ReadonlyMap<string, Point> | null,
): { places: Map<string, Point>; crowded: number } {
  const { spacing } = lattice;
  const slack = 30;
  const inside = (rect: Rect) => rect.x0 >= region.x0 - slack && rect.y0 >= region.y0 - slack && rect.x1 <= region.x1 + slack && rect.y1 <= region.y1 + slack;
  const nodes = latticeNodes(region, blocked, spacing);
  const rooms: Rect[] = [...blocked];
  const cores: Rect[] = [...blocked];
  const places = new Map<string, Point>();
  const free = (rect: Rect, taken: Rect[]) => inside(rect) && !taken.some((other) => overlaps(rect, other));
  const fits = (star: StarShape, at: Point) => free(starFootprint(star, at, lattice), rooms);
  const put = (star: StarShape, at: Point, labelled: boolean) => {
    places.set(star.repo, at);
    cores.push(starCore(star, at, lattice));
    rooms.push(labelled ? starFootprint(star, at, lattice) : starCore(star, at, lattice));
  };
  // The largest first: they need the most room.
  const area = (star: StarShape) => {
    const rect = starFootprint(star, { x: 0, y: 0 }, lattice);
    return (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
  };
  const order = [...stars].sort((a, b) => area(b) - area(a) || a.repo.localeCompare(b.repo));
  // A star keeps its place while it still fits there.
  for (const star of order) {
    const before = previous?.get(star.repo);
    if (before && fits(star, before)) put(star, before, true);
  }
  let crowded = 0;
  for (const star of order) {
    if (places.has(star.repo)) continue;
    const home = { x: region.x0 + unit(star.repo) * (region.x1 - region.x0), y: region.y0 + unit(`${star.repo}#y`) * (region.y1 - region.y0) };
    const nearest = nodes
      .map((node) => ({ node, distance: Math.hypot((node.x - home.x) / 1.4, node.y - home.y) }))
      .sort((a, b) => a.distance - b.distance);
    const near = nearest.filter((item) => item.distance <= spacing * 3.5).map((item) => item.node);
    const node = near.find((candidate) => fits(star, candidate));
    if (node) {
      const off = { x: node.x + (unit(`${star.repo}#jx`) - 0.5) * NODE_JITTER * spacing, y: node.y + (unit(`${star.repo}#jy`) - 0.5) * NODE_JITTER * spacing * 0.8 };
      put(star, fits(star, off) ? off : node, true);
      continue;
    }
    if (star.live) crowded++;
    const room = nearest.find((item) => free(starCore(star, item.node, lattice), cores) && free(starCore(star, item.node, lattice), rooms.slice(0, blocked.length)));
    put(star, room?.node ?? nearest[0]?.node ?? home, false);
  }
  return { places, crowded };
}

/**
 * The stars of the repositories on a lattice that follows their count: every star gets an equal share of the free part
 * of the galaxy with some to spare, so a few stars stand wide apart and many fill it densely, without clumps or empty
 * patches. The rows of the lattice are shifted by half a step, so a label below a star falls between the stars of the
 * next row. A busy star claims the room of its label as well. Each star takes the free node nearest its home, a point
 * from its name, the largest first, and keeps its place from `previous` while it fits there and the lattice holds. When
 * busy labels find no room, the step narrows, to about three quarters; what still does not fit waits for the zoom. A
 * crowded galaxy also draws its stars smaller. The labels' room is reserved at `labelZoom`, the zoom of the full view.
 */
export function galaxyLayout(
  stars: readonly StarShape[],
  size: Size,
  blocked: readonly Rect[],
  previous: Galaxy | null = null,
  labelZoom = LABEL_ZOOM,
): Galaxy {
  const region = galaxyRegion(size);
  const ideal = Math.sqrt(freeArea(region, blocked) / (Math.max(1, stars.length) * SPARE));
  const rungOf = (spacing: number) => Math.round(Math.log(spacing) / Math.log(SPACING_LADDER));
  const top = rungOf(ideal);
  const attempt = (rung: number, previousPlaces: ReadonlyMap<string, Point> | null): Galaxy => {
    const spacing = SPACING_LADDER ** rung;
    const scale = Math.min(1, Math.max(0.6, spacing / 120));
    const placed = placeStars(stars, region, blocked, { spacing, scale, labelZoom }, previousPlaces);
    return { places: placed.places, spacing, scale, labelZoom, world: size, crowded: placed.crowded };
  };
  // The lattice of the previous layout, with the stars in their places, while it is near the ideal one and crowds no
  // more labels out than a fresh layout would: then a star moves only when it must.
  const kept = previous && previous.world.width === size.width && previous.world.height === size.height ? previous : null;
  const keptRung = kept ? rungOf(kept.spacing) : null;
  const sticky = keptRung !== null && keptRung <= top + 1 && keptRung >= top - 4 ? attempt(keptRung, kept!.places) : null;
  if (sticky && !sticky.crowded) return sticky;
  let best: Galaxy | null = null;
  for (let rung = top; rung >= top - 4; rung--) {
    const fresh = attempt(rung, null);
    if (!best || fresh.crowded < best.crowded) best = fresh;
    if (!fresh.crowded) break;
  }
  const result = sticky && sticky.crowded <= best!.crowded ? sticky : best;
  return result!;
}

/** A star grows with the number of its ships; a star without ships stays small. */
export function starRadius(live: number): number {
  return live === 0 ? 16 : Math.min(46, 18 + Math.round(Math.sqrt(live) * 9));
}

/**
 * Codex depots stand along the top edge, Claude depots along the bottom one; on a wide window the bottom row starts
 * right of the ship's log in the lower left corner.
 */
export function depotPosition(index: number, count: number, row: "top" | "bottom", size: Size): Point {
  const start = row === "bottom" && size.width >= size.height ? logCorner(size).x1 : 0;
  return {
    x: start + ((size.width - start) * (index + 0.5)) / Math.max(1, count),
    y: row === "top" ? 125 : size.height - 90,
  };
}

// Machines ------------------------------------------------------------------------------------------

/** World units from a depot's centre to its label, below the top row and above the bottom one: see MapView. */
export const DEPOT_LABEL_DROP = { top: 76, bottom: 66 } as const;
/** A depot's label at its tallest, in pixels: its name, its fuel and when it refuels. */
const DEPOT_LABEL_PX = 46;
/** A machine's label at its tallest, in pixels: its name, its status and how old its data is. */
export const MACHINE_LABEL_PX = 50;
/** The widest machine label, in pixels; MapView's CSS keeps it to this. */
export const MACHINE_LABEL_WIDTH_PX = 132;
/** The line over the column that tells the machines' config could not be read, in pixels. */
export const MACHINE_NOTE_PX = { width: 280, height: 20 } as const;
/** The power station's art is wider than tall by this ratio. */
const MACHINE_ASPECT = 170 / 256;
/** World units between the column's right side and the world's edge, and between a station and its label. */
const MACHINE_EDGE = 20;
const MACHINE_GAP = 6;

/** The power stations of the machines: one column along the right edge of the galaxy. */
export interface MachineColumn {
  places: Map<string, Point>;
  /** The long side of every station's sprite, in world units. */
  size: number;
  /** The zoom the labels' room was reserved at: see Galaxy.labelZoom. */
  labelZoom: number;
  /** The right side of the column, where the stations and their labels end. */
  right: number;
  /** Where the line about a broken config stands, its right end: null without one. */
  note: Point | null;
}

/**
 * The part of the right edge the column may use, top to bottom: below the top row of depots with their labels and
 * above the bottom row with theirs, and on a tall window above the ship's log, which spans the whole width there.
 */
export function machineSpan(size: Size, labelZoom = LABEL_ZOOM): { top: number; bottom: number } {
  const depotLabel = DEPOT_LABEL_PX / labelZoom;
  const top = depotPosition(0, 1, "top", size).y + DEPOT_LABEL_DROP.top + depotLabel + MACHINE_GAP * 2;
  let bottom = depotPosition(0, 1, "bottom", size).y - DEPOT_LABEL_DROP.bottom - depotLabel - MACHINE_GAP * 2;
  const log = logCorner(size);
  if (log.x1 >= size.width) bottom = Math.min(bottom, log.y0 - MACHINE_GAP * 2);
  return { top, bottom };
}

/**
 * Puts a power station for each machine, in the order given, in one column along the right edge of the world, evenly
 * between the rows of depots. Each station stands with its label below it; a long column draws its stations smaller,
 * down to MACHINE_MIN_SIZE, and then stays as it is: that is its limit. `note` reserves a line over the column for a
 * broken config. The labels' room is reserved at `labelZoom`, the zoom of the full view.
 */
export function machinePositions(ids: readonly string[], size: Size, labelZoom = LABEL_ZOOM, note = false): MachineColumn {
  const span = machineSpan(size, labelZoom);
  const right = size.width - MACHINE_EDGE;
  const noteAt = note ? { x: right, y: span.top } : null;
  const top = note ? span.top + MACHINE_NOTE_PX.height / labelZoom + MACHINE_GAP : span.top;
  const label = MACHINE_GAP + MACHINE_LABEL_PX / labelZoom;
  const count = Math.max(1, ids.length);
  const step = (span.bottom - top) / count;
  // A gap under every label, so that the next station keeps clear of it.
  const stationSize = Math.max(MACHINE_MIN_SIZE, Math.min(MACHINE_SIZE, (step - label - MACHINE_GAP) / MACHINE_ASPECT));
  const height = stationSize * MACHINE_ASPECT;
  const unit = height + label + MACHINE_GAP;
  // Each station with its label stands in the middle of its share of the column. Past the column's limit they close up
  // instead, the first at its top and the last at its bottom, so that the column stays between the depots.
  const crowded = step < unit && count > 1;
  const pitch = crowded ? (span.bottom - top - unit) / (count - 1) : step;
  const first = crowded ? top : top + (step - unit) / 2;
  const places = new Map<string, Point>();
  ids.forEach((id, index) => places.set(id, { x: right - stationSize / 2, y: first + pitch * index + height / 2 }));
  return { places, size: stationSize, labelZoom, right, note: noteAt };
}

/** Where a station's label starts below its centre, in world units. */
export function machineLabelDrop(column: Pick<MachineColumn, "size">): number {
  return (column.size * MACHINE_ASPECT) / 2 + MACHINE_GAP;
}

/** The room a station takes with its label: the label is as wide as it may grow, flush with the column's right side. */
export function machineRoom(at: Point, column: MachineColumn): Rect {
  const half = (column.size * MACHINE_ASPECT) / 2;
  const width = Math.max(column.size, MACHINE_LABEL_WIDTH_PX / column.labelZoom);
  return { x0: column.right - width, y0: at.y - half, x1: column.right, y1: at.y + machineLabelDrop(column) + MACHINE_LABEL_PX / column.labelZoom };
}

/** The rooms of every station and of the line over the column. */
export function machineRooms(column: MachineColumn): Rect[] {
  const rooms = [...column.places.values()].map((at) => machineRoom(at, column));
  if (column.note) {
    const { x, y } = column.note;
    rooms.push({ x0: x - MACHINE_NOTE_PX.width / column.labelZoom, y0: y, x1: x, y1: y + MACHINE_NOTE_PX.height / column.labelZoom });
  }
  return rooms;
}
