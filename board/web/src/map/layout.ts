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

/** The galaxy is laid out for the shape of the window: wide on a desktop, tall on a phone. */
export function worldSize(viewport: Size): Size {
  return viewport.width >= viewport.height ? { width: 1600, height: 1000 } : { width: 1000, height: 1500 };
}

/** Screen pixels at each edge of the window that the map's own panels cover. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** A part of the window in screen pixels; without x and y it starts at the window's corner. */
export type View = Size & { x?: number; y?: number };

/** The part of the window that no panel covers. */
export function freeView(viewport: Size, insets: Insets): Required<View> {
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(1, viewport.width - insets.left - insets.right),
    height: Math.max(1, viewport.height - insets.top - insets.bottom),
  };
}

/**
 * A star system is laid out for the free part of the window: its world is as wide as that part on a desktop, between
 * one and a half and two and a half times as wide as tall, and tall on a phone. So the orbits spread over the screen
 * instead of leaving its sides empty; a narrower world would bring the yard's ships onto the roadstead.
 */
export function systemWorldSize(free: Size): Size {
  const aspect = free.width / Math.max(1, free.height);
  if (aspect >= 1) return { width: Math.round(Math.min(2400, Math.max(1500, 1000 * aspect))), height: 1000 };
  return { width: 1000, height: Math.round(Math.min(1500, Math.max(1250, 1000 / aspect))) };
}

/** The camera: a world point (x, y) is drawn at (x * zoom + tx, y * zoom + ty). */
export interface Camera {
  zoom: number;
  tx: number;
  ty: number;
}

/** The whole world in `view`, centred. */
export function fitCamera(world: Size, view: View): Camera {
  const zoom = Math.min(view.width / world.width, view.height / world.height);
  return { zoom, tx: (view.x ?? 0) + (view.width - world.width * zoom) / 2, ty: (view.y ?? 0) + (view.height - world.height * zoom) / 2 };
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
 * `camera` carried over to a view of another size: the same share of the fitted zoom, around the same world point
 * in the middle of the view.
 */
export function refitCamera(camera: Camera, before: { fit: Camera; viewport: View }, fit: Camera, viewport: View, world: Size): Camera {
  const zoom = fit.zoom * (camera.zoom / before.fit.zoom);
  const x = ((before.viewport.x ?? 0) + before.viewport.width / 2 - camera.tx) / camera.zoom;
  const y = ((before.viewport.y ?? 0) + before.viewport.height / 2 - camera.ty) / camera.zoom;
  const middle = { x: (viewport.x ?? 0) + viewport.width / 2, y: (viewport.y ?? 0) + viewport.height / 2 };
  return clampCamera({ zoom, tx: middle.x - x * zoom, ty: middle.y - y * zoom }, world, viewport);
}

/**
 * `camera` kept so that the world covers `view` and every edge of the world can be brought into it; a world smaller
 * than the view stays centred in it.
 */
export function clampCamera(camera: Camera, world: Size, view: View): Camera {
  const axis = (offset: number, worldLength: number, start: number, viewLength: number) => {
    const length = worldLength * camera.zoom;
    if (length <= viewLength) return start + (viewLength - length) / 2;
    return Math.min(start, Math.max(start + viewLength - length, offset));
  };
  return {
    zoom: camera.zoom,
    tx: axis(camera.tx, world.width, view.x ?? 0, view.width),
    ty: axis(camera.ty, world.height, view.y ?? 0, view.height),
  };
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

/** The ellipse of the outermost orbit; a tall one, on a phone, is narrow. */
export interface SystemFrame {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  tall: boolean;
}

/** The system's orbits, in the middle of its world: the panels are outside it. */
export function systemFrame(size: Size): SystemFrame {
  const ry = size.height / 2 - 120;
  return { cx: size.width / 2, cy: size.height / 2, rx: Math.min(size.width / 2 - 150, ry * 2.6), ry, tall: size.height > size.width };
}

/** Where a station's name stands next to it. */
export type PlateSide = "below" | "above" | "left";

/**
 * Stations never move, so the eye learns them: `orbit` is a share of the frame, `angle` is in degrees. A station's
 * ships park on its `side`, in degrees from its centre (0 is to the right, 90 below), and its name stands apart from
 * them, `plate`. `berths` is how many ships it shows; the rest wait behind a count.
 */
export const STATIONS: Record<Place, { orbit: number; angle: number; radius: number; side: number; plate: PlateSide; berths: number }> = {
  yard: { orbit: 0.9, angle: 180, radius: 140, side: 0, plate: "below", berths: 10 },
  range: { orbit: 0.74, angle: 238, radius: 84, side: 270, plate: "below", berths: 6 },
  inspection: { orbit: 0.64, angle: 320, radius: 116, side: 270, plate: "below", berths: 6 },
  gate: { orbit: 0.46, angle: 62, radius: 70, side: 0, plate: "below", berths: 5 },
  roadstead: { orbit: 0.3, angle: 170, radius: 54, side: 120, plate: "above", berths: 5 },
  cryo: { orbit: 0.97, angle: 345, radius: 88, side: 90, plate: "above", berths: 6 },
  command: { orbit: 0.9, angle: 128, radius: 92, side: 30, plate: "left", berths: 5 },
};

/**
 * A tall system's orbits are narrow, so its stations are smaller and some park their ships elsewhere: the yard on its
 * outer side, on one arc that stays inside the world; the roadstead fewer and below it, clear of the yard and the sun;
 * the sleeping field to its right, clear of the inspection.
 */
const TALL_SCALE = 0.65;
const TALL: Partial<Record<Place, { side: number; berths?: number }>> = {
  yard: { side: 180, berths: 6 },
  roadstead: { side: 90, berths: 3 },
  cryo: { side: 0 },
};

/** A station as `frame` draws it: see STATIONS. */
export function stationOf(place: Place, frame: SystemFrame): (typeof STATIONS)[Place] {
  const station = STATIONS[place];
  if (!frame.tall) return station;
  return { ...station, radius: Math.round(station.radius * TALL_SCALE), ...TALL[place] };
}

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
  const { orbit, angle, radius } = stationOf(place, frame);
  const point = orbitPoint(frame, orbit, angle);
  const distance = Math.hypot(point.x - frame.cx, point.y - frame.cy);
  const least = SUN_RADIUS + radius + 36;
  if (distance >= least) return point;
  return { x: frame.cx + ((point.x - frame.cx) / distance) * least, y: frame.cy + ((point.y - frame.cy) / distance) * least };
}

/** Ships park this far from a station's edge; a second arc, if any, this far outside the first. */
const PARK_GAP = 22;
const ROW_GAP = 10;
/** The share of its size a ship's art fills, and the room left between two ships on an arc. */
const FOOTPRINT = 0.8;
const SHIP_GAP = 10;
/** The widest arc of parked ships, in radians: they stay on their side of the station. */
const PARK_SPAN = (170 * Math.PI) / 180;
/**
 * The room a station's name takes, in world units: about its pixels at the zoom of a laptop's full view; on a phone
 * the name is shorter, without its note, and the zoom smaller. Ships keep out of it.
 */
export function plateRoom(frame: SystemFrame): Size {
  return frame.tall ? { width: 170, height: 50 } : { width: 260, height: 36 };
}
/** The step, in radians, an arc turns by to clear a station's name. */
const CLEAR_STEP = (2 * Math.PI) / 180;
/** The share of a station's radius its art fills to the edge of the ball. */
const BALL_SHARE = 0.96;
/** The room the count of the ships that wait takes on the arc, in world units. */
export const COUNT_ROOM = 40;

/** Where a station's ships park, as offsets from its centre; the count of the rest stands after the last of them. */
export interface Parking {
  berths: Point[];
  /** null when every ship has its berth. */
  count: { at: Point; ships: number } | null;
}

/**
 * The berths of a station's ships, `sizes` in their order: an arc on the station's side, centred on it, with SHIP_GAP
 * between neighbours. When the arc would pass PARK_SPAN, a second one starts outside it. A station shows `berths`
 * ships at most; with more, the last berth goes to the count of the rest. An arc starts at its end nearer the station's
 * name and turns off it until its first ship clears the name's room, so that the ships and the count stay clear of it.
 */
export function parkingOf(place: Place, sizes: readonly number[], frame: SystemFrame): Parking {
  const { radius, side, berths, plate } = stationOf(place, frame);
  const crowded = sizes.length > berths;
  const shown = crowded ? berths - 1 : sizes.length;
  const items = crowded ? [...sizes.slice(0, shown), COUNT_ROOM] : [...sizes];
  const width = (size: number) => size * FOOTPRINT + SHIP_GAP;
  // The angle between neighbours a and b on an arc of radius r: their chord is half their widths.
  const step = (a: number, b: number, r: number) => 2 * Math.asin(Math.min(1, (width(a) + width(b)) / 4 / r));
  const centre = (side * Math.PI) / 180;
  /** The direction of the station's name from its centre, and the name's room along it and across it. */
  const name = { below: Math.PI / 2, above: -Math.PI / 2, left: Math.PI }[plate];
  const room = plateRoom(frame);
  const [deep, wide] = plate === "left" ? [room.width, room.height] : [room.height, room.width];
  const nameFrom = radius * BALL_SHARE + 10;
  /** Whether a ship of `size` at angle `a` on an arc of radius `r` would cover the name. */
  const covers = (a: number, size: number, r: number) => {
    const toward = r * Math.cos(a - name);
    const across = r * Math.sin(a - name);
    const half = (size * FOOTPRINT) / 2;
    return Math.abs(across) < wide / 2 + half && toward + half > nameFrom && toward - half < nameFrom + deep;
  };
  const points: Point[] = [];
  let inner = radius + PARK_GAP;
  let first = 0;
  while (first < items.length) {
    let last = first + 1;
    let largest = items[first]!;
    while (last < items.length) {
      const next = Math.max(largest, items[last]!);
      const r = inner + next / 2;
      let span = 0;
      for (let index = first + 1; index <= last; index++) span += step(items[index - 1]!, items[index]!, r);
      if (span > PARK_SPAN) break;
      largest = next;
      last += 1;
    }
    const r = inner + largest / 2;
    const angles = [0];
    for (let index = first + 1; index < last; index++) angles.push(angles[angles.length - 1]! + step(items[index - 1]!, items[index]!, r));
    const half = angles[angles.length - 1]! / 2;
    // The arc runs from its end nearer the name, clockwise or back, and turns off the name while its first ship covers it.
    const nearer = (a: number, b: number) => Math.cos(a - name) > Math.cos(b - name) + 1e-6;
    const turn = nearer(centre + half, centre - half) ? -1 : 1;
    let start = centre - turn * half;
    for (let tries = 0; tries < 60 && covers(start, items[first]!, r); tries++) start += turn * CLEAR_STEP;
    for (const angle of angles) points.push({ x: r * Math.cos(start + turn * angle), y: r * Math.sin(start + turn * angle) });
    inner = r + largest / 2 + ROW_GAP;
    first = last;
  }
  return { berths: points.slice(0, shown), count: crowded ? { at: points[shown]!, ships: sizes.length - shown } : null };
}

/**
 * The order of a station's ships on its berths: a ship in trouble first, then by arrival; the selected ship never
 * waits behind the count.
 */
export function parkingOrder<T>(
  ships: readonly T[],
  keyOf: (ship: T) => { slug: string; beacon: boolean; slot: number },
  place: Place,
  selected: string | null,
): T[] {
  const order = [...ships].sort((a, b) => {
    const [x, y] = [keyOf(a), keyOf(b)];
    return Number(y.beacon) - Number(x.beacon) || x.slot - y.slot;
  });
  const { berths } = STATIONS[place];
  const index = order.findIndex((ship) => keyOf(ship).slug === selected);
  if (order.length > berths && index >= berths - 1) order.splice(berths - 2, 0, ...order.splice(index, 1));
  return order;
}

/**
 * Where a station's name stands, away from its ships: the middle of the name's edge that faces the station, under it,
 * over it or left of it.
 */
export function plateAt(place: Place, frame: SystemFrame): Point & { side: PlateSide } {
  const station = stationAt(place, frame);
  const { radius, plate } = stationOf(place, frame);
  const off = radius * BALL_SHARE + 10;
  if (plate === "left") return { x: station.x - off, y: station.y, side: plate };
  return { x: station.x, y: station.y + (plate === "above" ? -off : off), side: plate };
}

// Galaxy ------------------------------------------------------------------------------------------

/** The research station's label in pixels: on a wide window, and on a narrow one, where its font is smaller. */
const RESEARCH_LABEL_PX = { wide: { width: 200, height: 40 }, tall: { width: 176, height: 36 } } as const;
/** World units from the research station's centre down to its label: see MapView. */
export const RESEARCH_LABEL_DROP = 93;

/**
 * The research station watches every system, so it stands in the middle of the galaxy. When a machine's label would
 * meet the station or its label there, as it can on a narrow window, it moves left just far enough to keep clear.
 */
export function researchPosition(size: Size, machines: MachineColumn | null = null): Point {
  const middle = { x: size.width * 0.5, y: size.height * 0.49 };
  if (!machines?.places.size) return middle;
  const zoom = machines.labelZoom;
  const label = RESEARCH_LABEL_PX[size.width >= size.height ? "wide" : "tall"];
  // The station and its label, each as a half width and a band from the station's centre.
  const parts = [
    { half: RESEARCH_SIZE / 2, y0: middle.y - RESEARCH_SIZE / 2, y1: middle.y + RESEARCH_SIZE / 2 },
    { half: label.width / zoom / 2, y0: middle.y + RESEARCH_LABEL_DROP, y1: middle.y + RESEARCH_LABEL_DROP + label.height / zoom },
  ];
  let x = middle.x;
  for (const id of machines.places.keys()) {
    const room = machineRoom(id, machines);
    for (const part of parts) {
      if (room.y0 < part.y1 && part.y0 < room.y1) x = Math.min(x, room.x0 - part.half - MACHINE_GAP * 2);
    }
  }
  return { x: Math.max(Math.max(...parts.map((part) => part.half)), x), y: middle.y };
}

/** The station's size in world units. */
export const RESEARCH_SIZE = 150;

/**
 * A machine's power station: the long side of its sprite in world units, as large as a depot in a wide world and larger
 * in a tall one, which a phone shows at a smaller zoom; and the least it shrinks to in a long column.
 */
export const MACHINE_SIZE = { wide: 116, tall: 150 } as const;
export const MACHINE_MIN_SIZE = 72;

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
  const station = researchPosition(size, machines);
  const result: Rect[] = [
    { x0: station.x - 150, y0: station.y - RESEARCH_SIZE / 2 - 40, x1: station.x + 150, y1: station.y + RESEARCH_SIZE / 2 + 85 },
  ];
  for (const depot of depots) {
    const top = depot.y < size.height / 2;
    result.push(
      top ? { x0: depot.x - 120, y0: 0, x1: depot.x + 120, y1: depot.y + 165 } : { x0: depot.x - 120, y0: depot.y - 170, x1: depot.x + 120, y1: size.height },
    );
  }
  // The whole column, the gaps between its rows too: a star there could never show its label, see MapView.
  const column = machines ? machineColumnRect(machines) : null;
  if (column) result.push(column);
  const note = machines ? machineNoteRoom(machines) : null;
  if (note) result.push(note);
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
/** The widest machine label, in pixels; MapView's CSS keeps it to this. */
export const MACHINE_LABEL_WIDTH_PX = 150;
/** A machine label's height in pixels: its name and its status in a wide world, its name alone in a tall one. */
const MACHINE_LABEL_HEIGHT_PX = { wide: 34, tall: 20 } as const;
/** The line over the column that tells the machines' config could not be read, in pixels. */
export const MACHINE_NOTE_PX = { width: 280, height: 20 } as const;
/** The power station's art is wider than tall by this ratio. */
const MACHINE_ASPECT = 170 / 256;
/** World units between the column's right side and the world's edge, between a station and its label, and between rows. */
const MACHINE_EDGE = 20;
const MACHINE_GAP = 6;
const MACHINE_ROW_GAP = 10;

/** What the column knows of a machine: its id, and the name and status its label shows. */
export interface MachineShape {
  id: string;
  name: string;
  status: string;
}

/**
 * A machine's label in pixels, from its text: the name, and in a wide world the status under it, at most
 * MACHINE_LABEL_WIDTH_PX wide, where a long status ends with an ellipsis.
 */
export function machineLabelSize(machine: MachineShape, withStatus: boolean): Size {
  const text = Math.max(machine.name.length * 7.4, withStatus ? machine.status.length * 6.4 : 0);
  return {
    width: Math.min(MACHINE_LABEL_WIDTH_PX, Math.round(text + 16)),
    height: MACHINE_LABEL_HEIGHT_PX[withStatus ? "wide" : "tall"],
  };
}

/** The power stations of the machines: one column along the right edge of the galaxy. */
export interface MachineColumn {
  places: Map<string, Point>;
  /** Each label's size in pixels: see machineLabelSize. */
  labels: Map<string, Size>;
  /** The labels show the status: in a wide world. In a tall one the glow tells it, the title and the card the rest. */
  status: boolean;
  /** The long side of every station's sprite, in world units. */
  size: number;
  /** The zoom the labels' room was reserved at: see Galaxy.labelZoom. */
  labelZoom: number;
  /** The right side of the column, where the stations end. */
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
 * between the rows of depots, each with its label on its left at the height of its centre. A row is as tall as the
 * station or its label, whichever is taller. A long column draws its stations smaller, down to MACHINE_MIN_SIZE, and
 * then stays as it is: that is its limit. `note` reserves a line over the column for a broken config. The labels' room
 * is reserved at `labelZoom`, the zoom of the full view.
 */
export function machinePositions(machines: readonly MachineShape[], size: Size, labelZoom = LABEL_ZOOM, note = false): MachineColumn {
  const wide = size.width >= size.height;
  const span = machineSpan(size, labelZoom);
  const right = size.width - MACHINE_EDGE;
  const noteAt = note ? { x: right, y: span.top } : null;
  const top = note ? span.top + MACHINE_NOTE_PX.height / labelZoom + MACHINE_GAP : span.top;
  const label = MACHINE_LABEL_HEIGHT_PX[wide ? "wide" : "tall"] / labelZoom;
  const count = Math.max(1, machines.length);
  const step = (span.bottom - top) / count;
  const largest = MACHINE_SIZE[wide ? "wide" : "tall"];
  const stationSize = Math.max(MACHINE_MIN_SIZE, Math.min(largest, (step - MACHINE_ROW_GAP) / MACHINE_ASPECT));
  const row = Math.max(stationSize * MACHINE_ASPECT, label) + MACHINE_ROW_GAP;
  // Each row stands in the middle of its share of the column. Past the column's limit the rows close up instead, the
  // first at its top and the last at its bottom, so that the column stays between the depots.
  const crowded = step < row && count > 1;
  const pitch = crowded ? (span.bottom - top - row) / (count - 1) : step;
  const first = top + (crowded ? row : step) / 2;
  const places = new Map<string, Point>();
  const labels = new Map<string, Size>();
  machines.forEach((machine, index) => {
    places.set(machine.id, { x: right - stationSize / 2, y: first + pitch * index });
    labels.set(machine.id, machineLabelSize(machine, wide));
  });
  return { places, labels, status: wide, size: stationSize, labelZoom, right, note: noteAt };
}

/** Where a station's label ends on the right, at the height of the station's centre. */
export function machineLabelAnchor(id: string, column: MachineColumn): Point | null {
  const at = column.places.get(id);
  return at ? { x: at.x - column.size / 2 - MACHINE_GAP, y: at.y } : null;
}

/** The room of a station's row: the station and its label on its left, as tall as the taller of them. */
export function machineRoom(id: string, column: MachineColumn): Rect {
  const at = column.places.get(id)!;
  const label = column.labels.get(id) ?? { width: MACHINE_LABEL_WIDTH_PX, height: MACHINE_LABEL_HEIGHT_PX.wide };
  const half = Math.max(column.size * MACHINE_ASPECT, label.height / column.labelZoom) / 2;
  const left = at.x - column.size / 2 - MACHINE_GAP - label.width / column.labelZoom;
  return { x0: left, y0: at.y - half, x1: column.right, y1: at.y + half };
}

/**
 * The whole column as one rect, in world units: from the top of the first row to the bottom of the last, and from the
 * left side of the widest label's room to the column's right side, gaps between the rows included. The line about a
 * broken config is not part of it. Null without machines.
 */
export function machineColumnRect(column: MachineColumn): Rect | null {
  const rooms = [...column.places.keys()].map((id) => machineRoom(id, column));
  if (!rooms.length) return null;
  return {
    x0: Math.min(...rooms.map((room) => room.x0)),
    y0: Math.min(...rooms.map((room) => room.y0)),
    x1: Math.max(...rooms.map((room) => room.x1)),
    y1: Math.max(...rooms.map((room) => room.y1)),
  };
}

/** The room of the line over the column about a broken config: null without one. */
export function machineNoteRoom(column: MachineColumn): Rect | null {
  if (!column.note) return null;
  const { x, y } = column.note;
  return { x0: x - MACHINE_NOTE_PX.width / column.labelZoom, y0: y, x1: x, y1: y + MACHINE_NOTE_PX.height / column.labelZoom };
}

/** The rooms of every station and of the line over the column. */
export function machineRooms(column: MachineColumn): Rect[] {
  const rooms = [...column.places.keys()].map((id) => machineRoom(id, column));
  const note = machineNoteRoom(column);
  if (note) rooms.push(note);
  return rooms;
}
