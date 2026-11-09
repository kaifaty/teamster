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
  yard: { orbit: 0.9, angle: 180, radius: 120, side: 0, plate: "below", berths: 10 },
  range: { orbit: 0.74, angle: 238, radius: 84, side: 270, plate: "below", berths: 6 },
  inspection: { orbit: 0.64, angle: 320, radius: 138, side: 180, plate: "above", berths: 6 },
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

/**
 * The system's home world: the repository's own planet, large, at the left edge of the system, its sunlit side
 * turned to the sun. The shipyard hangs in orbit over its limb, and new ships fly in from it.
 */
export function homeWorld(frame: SystemFrame): Point & { radius: number } {
  const yard = stationAt("yard", frame);
  const radius = frame.tall ? 240 : 380;
  return { x: yard.x - radius, y: yard.y, radius };
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
  const { berths } = stationOf(place, frame);
  if (place !== "inspection") return arcParking(place, sizes, berths, frame);
  // The checkpoint fills its lanes first; the rest queue on its side.
  const lanes = lanesOf(frame).slice(0, sizes.length);
  const queue = arcParking(place, sizes.slice(lanes.length), berths - lanes.length, frame);
  return { berths: [...lanes, ...queue.berths], count: queue.count };
}

/**
 * The inspection is a checkpoint: an open frame, taller than wide, whose lanes run across it one above another. Its
 * ships stand in the lanes nose to the exit while they are inspected, and the rest queue before its entrance, on its
 * left, with its name over it like a sign. The station's
 * radius is half the art's height, mast to mast. `inside` is the frame's open middle between its scanner heads, as
 * shares of that radius, a little inside them, and `body` the frame's girders without the masts; a lane is at least
 * `lane` world units high.
 */
export const CHECKPOINT = { inside: { x: 0.33, y: 0.68 }, body: { x: 0.57, y: 0.87 }, lane: 60 } as const;

/** Whether `point` falls within the girders of the inspection's frame, masts left out: see CHECKPOINT. */
export function inCheckpoint(point: Point, frame: SystemFrame): boolean {
  const station = stationAt("inspection", frame);
  const { radius } = stationOf("inspection", frame);
  return Math.abs(point.x - station.x) <= radius * CHECKPOINT.body.x && Math.abs(point.y - station.y) <= radius * CHECKPOINT.body.y;
}

/** The lanes of the inspection's frame, as offsets from its centre, top first: as many as its open middle holds. */
export function lanesOf(frame: SystemFrame): Point[] {
  const height = 2 * stationOf("inspection", frame).radius * CHECKPOINT.inside.y;
  const count = Math.max(1, Math.floor(height / CHECKPOINT.lane));
  const pitch = height / count;
  return Array.from({ length: count }, (_, index) => ({ x: 0, y: -height / 2 + pitch * (index + 0.5) }));
}

/** The berths on an arc on the station's side for `sizes`, at most `berths` of them: see parkingOf. */
function arcParking(place: Place, sizes: readonly number[], berths: number, frame: SystemFrame): Parking {
  const { radius, side, plate } = stationOf(place, frame);
  if (sizes.length === 0) return { berths: [], count: null };
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
 * waits behind the count. At the inspection the ships under review come first, so that they get its lanes.
 */
export function parkingOrder<T>(
  ships: readonly T[],
  keyOf: (ship: T) => { slug: string; beacon: boolean; slot: number; placeWorking?: boolean },
  place: Place,
  selected: string | null,
): T[] {
  const order = [...ships].sort((a, b) => {
    const [x, y] = [keyOf(a), keyOf(b)];
    const inspected = place === "inspection" ? Number(!!y.placeWorking) - Number(!!x.placeWorking) : 0;
    return inspected || Number(y.beacon) - Number(x.beacon) || x.slot - y.slot;
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
 * meet the station or its label there, as it can on a narrow window, it moves left just far enough to keep clear, and
 * right of a tank's label the same way.
 */
export function researchPosition(size: Size, machines: MachineColumn | null = null, fuel: FuelColumn | null = null): Point {
  const middle = { x: size.width * 0.5, y: size.height * 0.49 };
  if (!machines?.places.size && !fuel?.places.size) return middle;
  const zoom = machines?.labelZoom ?? fuel!.labelZoom;
  const label = RESEARCH_LABEL_PX[size.width >= size.height ? "wide" : "tall"];
  // The station and its label, each as a half width and a band from the station's centre.
  const parts = [
    { half: RESEARCH_SIZE / 2, y0: middle.y - RESEARCH_SIZE / 2, y1: middle.y + RESEARCH_SIZE / 2 },
    { half: label.width / zoom / 2, y0: middle.y + RESEARCH_LABEL_DROP, y1: middle.y + RESEARCH_LABEL_DROP + label.height / zoom },
  ];
  let x = middle.x;
  for (const id of machines?.places.keys() ?? []) {
    const room = machineRoom(id, machines!);
    for (const part of parts) {
      if (room.y0 < part.y1 && part.y0 < room.y1) x = Math.min(x, room.x0 - part.half - MACHINE_GAP * 2);
    }
  }
  for (const key of fuel?.places.keys() ?? []) {
    const room = fuelRoom(key, fuel!);
    for (const part of parts) {
      if (room.y0 < part.y1 && part.y0 < room.y1) x = Math.max(x, room.x1 + part.half + MACHINE_GAP * 2);
    }
  }
  return { x: Math.max(Math.max(...parts.map((part) => part.half)), x), y: middle.y };
}

/** The station's size in world units. */
export const RESEARCH_SIZE = 150;

/**
 * A machine's reactor with its rings: their outer diameter in world units, larger in a tall world, which a phone shows at a
 * smaller zoom; and the least it shrinks to in a long column.
 */
export const MACHINE_SIZE = { wide: 108, tall: 150 } as const;
export const MACHINE_MIN_SIZE = 64;

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
 * The parts of the galaxy where no star stands: the research station, the fuel tanks and the machines' reactors
 * with their labels, and the parts `covered` by the map's own panels.
 */
export function galaxyKeepOuts(size: Size, covered: readonly Rect[], machines: MachineColumn | null = null, fuel: FuelColumn | null = null): Rect[] {
  const station = researchPosition(size, machines, fuel);
  const result: Rect[] = [
    { x0: station.x - 150, y0: station.y - RESEARCH_SIZE / 2 - 40, x1: station.x + 150, y1: station.y + RESEARCH_SIZE / 2 + 85 },
  ];
  // Each whole column, the gaps between its rows too: a star there could never show its label, see MapView.
  for (const rect of [machines ? machineColumnRect(machines) : null, machines ? machineNoteRoom(machines) : null, fuel ? fuelColumnRect(fuel) : null]) {
    if (rect) result.push(rect);
  }
  return [...result, ...covered];
}

/** The part of the world under the map's toolbar, until the map measures it: a band along the top. */
export function toolbarBand(size: Size): Rect {
  return { x0: 0, y0: 0, x1: size.width, y1: size.width >= size.height ? 90 : 300 };
}

/** The parts of the world under the map's panels until the map measures them: the toolbar and the ship's log. */
export function defaultCovered(size: Size): Rect[] {
  return [toolbarBand(size), logCorner(size)];
}

/** World units the columns at the edges keep from the world's edge and from the panels. */
const COLUMN_EDGE = 20;
const COLUMN_GAP = 12;

/**
 * The part of the world's height a column between x0 and x1 may use: below what covers the top edge there and above what
 * covers the bottom edge.
 */
export function columnSpan(size: Size, covered: readonly Rect[], x0: number, x1: number): { top: number; bottom: number } {
  let top = COLUMN_EDGE;
  let bottom = size.height - COLUMN_EDGE;
  for (const rect of covered) {
    if (rect.x1 <= x0 || rect.x0 >= x1) continue;
    if (rect.y0 <= 1) top = Math.max(top, rect.y1 + COLUMN_GAP);
    else if (rect.y1 >= size.height - 1) bottom = Math.min(bottom, rect.y0 - COLUMN_GAP);
  }
  return { top, bottom };
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

/** The region the stars stand in, a little in from the edges; the keep-outs take the panels and the columns. */
function galaxyRegion(size: Size): Rect {
  return { x0: 50, y0: 40, x1: size.width - 50, y1: size.height - 30 };
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

/** Stars of another constellation, or one in a constellation and one in none, keep this many steps apart when they can. */
const STRANGER_STEPS = 1.5;
/** A constellation's stars look this many steps around its middle for a place. */
const GATHER_STEPS = 6;

/** The reach a constellation of `count` stars needs around its middle, in world units. */
const reachOf = (count: number, spacing: number) => spacing * (1.2 + Math.sqrt(count) * 0.7);

/**
 * Where constellation `name` of `count` stars may have its middle, the most open first, at most `limit` of them: free
 * nodes with the most free room around them within its reach, the nearest nodes counting most, so that it settles in open
 * sky rather than around the research station, along a column or at the edge; and away from the middles in `taken`, so
 * that two constellations do not run into each other. Equal nodes go by the constellation's name.
 */
export function centreChoices(
  name: string,
  count: number,
  nodes: readonly Point[],
  spacing: number,
  taken: ReadonlyMap<Point, number>,
  limit = 24,
): Point[] {
  const reach = reachOf(count, spacing);
  const scored = nodes.map((node, index) => {
    let room = 0;
    for (const other of nodes) {
      const distance = Math.hypot(other.x - node.x, other.y - node.y);
      if (distance < reach) room += 1 - distance / reach;
    }
    for (const [at, size] of taken) {
      const apart = reach + reachOf(size, spacing);
      const gap = Math.hypot(at.x - node.x, at.y - node.y);
      if (gap < apart) room -= nodes.length * (1 - gap / apart);
    }
    return { node, score: room + unit(`${name}#${index}`) * 0.01 };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.node);
}

/**
 * Places the stars on one lattice. A star takes the nearest node to its home, within a few steps, where it and its
 * label fit; failing that, the nearest node where the star itself fits, its label left to wait for the zoom, which
 * `crowded` counts. The stars of a constellation come first, gathered around its middle; every star keeps
 * STRANGER_STEPS from the stars it does not share a constellation with, where it can.
 */
function placeStars(
  stars: readonly StarShape[],
  region: Rect,
  blocked: readonly Rect[],
  lattice: LabelledLattice,
  previous: ReadonlyMap<string, Point> | null,
  groups: Groups = new Map(),
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
  const groupOf = (star: StarShape) => groups.get(star.repo) ?? "";
  // A constellation's stars first, a constellation at a time; the largest first within each, and among the rest.
  const order = [...stars].sort(
    (a, b) => +!groupOf(a) - +!groupOf(b) || groupOf(a).localeCompare(groupOf(b)) || area(b) - area(a) || a.repo.localeCompare(b.repo),
  );
  const members = new Map<string, StarShape[]>();
  for (const star of order) if (groupOf(star)) members.set(groupOf(star), [...(members.get(groupOf(star)) ?? []), star]);
  // A constellation's stars stand on a lattice of half the step, so that they and their labels pack close together.
  const fine = members.size ? latticeNodes(region, blocked, spacing / 2) : [];
  const homeOf = (star: StarShape): Point => ({
    x: region.x0 + unit(star.repo) * (region.x1 - region.x0),
    y: region.y0 + unit(`${star.repo}#y`) * (region.y1 - region.y0),
  });
  /** The node stands at least STRANGER_STEPS from every placed star of another constellation, or none when `star` has one. */
  const apart = (star: StarShape, at: Point) => {
    if (!members.size) return true;
    const group = groupOf(star);
    for (const [repo, place] of places) {
      const other = groups.get(repo) ?? "";
      if (other === group || Math.hypot(place.x - at.x, place.y - at.y) >= spacing * STRANGER_STEPS) continue;
      return false;
    }
    return true;
  };
  // A star keeps its place while it still fits there.
  for (const star of order) {
    const before = previous?.get(star.repo);
    if (before && fits(star, before)) put(star, before, true);
  }
  /**
   * A constellation's star with its label stands this far from what stands inside the galaxy, the research station, so
   * that the cloud does not take it in; the panels and the columns along the edges need no more than the label's room.
   */
  const margin = spacing * 0.6;
  const inner = blocked.filter((rect) => rect.x0 > region.x0 && rect.y0 > region.y0 && rect.x1 < region.x1 && rect.y1 < region.y1);
  const clear = (star: StarShape, at: Point) => {
    const room = starFootprint(star, at, lattice);
    const wide = { x0: room.x0 - margin, y0: room.y0 - margin, x1: room.x1 + margin, y1: room.y1 + margin };
    return !inner.some((rect) => overlaps(wide, rect));
  };
  /**
   * Puts `list` around `centre`, each star on the free spot of the fine lattice nearest it, and tells how far they spread:
   * the sum of their squared distances from their own middle, more for every star close to the research station, and a
   * great deal for every star left without a spot.
   */
  const gather = (list: readonly StarShape[], centre: Point): number => {
    const spots = fine
      .map((node) => ({ node, distance: Math.hypot(node.x - centre.x, node.y - centre.y) }))
      .filter((item) => item.distance <= spacing * GATHER_STEPS)
      .sort((a, b) => a.distance - b.distance);
    const placed: Point[] = [];
    let left = 0;
    let close = 0;
    for (const star of list) {
      const spot = spots.find((item) => fits(star, item.node) && apart(star, item.node));
      if (!spot) {
        left++;
        continue;
      }
      if (!clear(star, spot.node)) close++;
      put(star, spot.node, true);
      placed.push(spot.node);
    }
    if (!placed.length) return left * 1e12;
    const middle = { x: placed.reduce((sum, at) => sum + at.x, 0) / placed.length, y: placed.reduce((sum, at) => sum + at.y, 0) / placed.length };
    return placed.reduce((sum, at) => sum + (at.x - middle.x) ** 2 + (at.y - middle.y) ** 2, 0) + close * spacing ** 2 * 2 + left * 1e12;
  };
  // The constellations first, the largest first: each tries the most open middles and keeps the one where its stars
  // stand closest together.
  const taken = new Map<Point, number>();
  for (const [name, list] of [...members].sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))) {
    const waiting = list.filter((star) => !places.has(star.repo));
    if (!waiting.length) continue;
    let best: { centre: Point; spread: number } | null = null;
    for (const centre of centreChoices(name, list.length, nodes, spacing, taken)) {
      const mark = { rooms: rooms.length, cores: cores.length };
      const spread = gather(waiting, centre);
      for (const star of waiting) places.delete(star.repo);
      rooms.length = mark.rooms;
      cores.length = mark.cores;
      if (!best || spread < best.spread) best = { centre, spread };
    }
    if (!best) continue;
    gather(waiting, best.centre);
    taken.set(best.centre, list.length);
  }
  let crowded = 0;
  for (const star of order) {
    if (places.has(star.repo)) continue;
    const home = homeOf(star);
    const nearest = nodes
      .map((node) => ({ node, distance: Math.hypot((node.x - home.x) / 1.4, node.y - home.y) }))
      .sort((a, b) => a.distance - b.distance);
    const near = nearest.filter((item) => item.distance <= spacing * 3.5).map((item) => item.node);
    // Apart from strangers near home, else apart anywhere, nearest first, else wherever it fits near home.
    const node =
      near.find((candidate) => fits(star, candidate) && apart(star, candidate)) ??
      (members.size ? nearest.find((item) => fits(star, item.node) && apart(star, item.node))?.node : undefined) ??
      near.find((candidate) => fits(star, candidate));
    if (node) {
      const off = { x: node.x + (unit(`${star.repo}#jx`) - 0.5) * NODE_JITTER * spacing, y: node.y + (unit(`${star.repo}#jy`) - 0.5) * NODE_JITTER * spacing * 0.8 };
      put(star, fits(star, off) ? off : node, true);
      continue;
    }
    const keepOuts = rooms.slice(0, blocked.length);
    const room = nearest.find((item) => free(starCore(star, item.node, lattice), cores) && free(starCore(star, item.node, lattice), keepOuts));
    // A busy star without its label's room waits for the zoom; any star without room for itself makes the lattice
    // narrow too. In a galaxy fuller than its room it may touch another star, but never a panel or the station.
    if (star.live || !room) crowded++;
    const squeezed = room ?? nearest.find((item) => free(starCore(star, item.node, lattice), keepOuts));
    put(star, squeezed?.node ?? nearest[0]?.node ?? home, false);
  }
  return { places, crowded };
}

/**
 * The stars of the repositories on a lattice that follows their count: every star gets an equal share of the free part
 * of the galaxy with some to spare, so a few stars stand wide apart and many fill it densely, without clumps or empty
 * patches. The rows of the lattice are shifted by half a step, so a label below a star falls between the stars of the
 * next row. A busy star claims the room of its label as well. Each star takes the free node nearest its home, a point
 * from its name, the largest first; the stars of a constellation (`groups`) come first and gather around its middle, and
 * the others keep a little apart from them. A star keeps its place from `previous` while it fits there and the lattice
 * and the constellations hold. When
 * busy labels find no room, the step narrows, to about three quarters; what still does not fit waits for the zoom. A
 * crowded galaxy also draws its stars smaller. The labels' room is reserved at `labelZoom`, the zoom of the full view.
 */
export function galaxyLayout(
  stars: readonly StarShape[],
  size: Size,
  blocked: readonly Rect[],
  previous: Galaxy | null = null,
  labelZoom = LABEL_ZOOM,
  groups: Groups = new Map(),
): Galaxy {
  const key = constellationKey(groups);
  const region = galaxyRegion(size);
  const ideal = Math.sqrt(freeArea(region, blocked) / (Math.max(1, stars.length) * SPARE));
  const rungOf = (spacing: number) => Math.round(Math.log(spacing) / Math.log(SPACING_LADDER));
  const top = rungOf(ideal);
  const attempt = (rung: number, previousPlaces: ReadonlyMap<string, Point> | null): Galaxy => {
    const spacing = SPACING_LADDER ** rung;
    const scale = Math.min(1, Math.max(0.6, spacing / 120));
    const placed = placeStars(stars, region, blocked, { spacing, scale, labelZoom }, previousPlaces, groups);
    return { places: placed.places, spacing, scale, labelZoom, world: size, crowded: placed.crowded, groups: key };
  };
  // The lattice of the previous layout, with the stars in their places, while it is near the ideal one and crowds no
  // more labels out than a fresh layout would: then a star moves only when it must.
  const kept = previous && previous.world.width === size.width && previous.world.height === size.height && previous.groups === key ? previous : null;
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

// Machines ------------------------------------------------------------------------------------------

/** The widest machine label, in pixels; MapView's CSS keeps it to this. */
export const MACHINE_LABEL_WIDTH_PX = 180;
/** A machine label's height in pixels: its name and what is free in a wide world, its name alone in a tall one. */
const MACHINE_LABEL_HEIGHT_PX = { wide: 34, tall: 20 } as const;
/** The line over the column that tells the machines' config could not be read, in pixels. */
export const MACHINE_NOTE_PX = { width: 280, height: 20 } as const;
/** The reactor with its rings is round: as tall as it is wide. */
const MACHINE_ASPECT = 1;
/** World units between the column's right side and the world's edge, between a station and its label, and between rows. */
const MACHINE_EDGE = 20;
const MACHINE_GAP = 6;
const MACHINE_ROW_GAP = 10;

/**
 * What the column knows of a machine: its id, and the name and second line its label shows, what is free or why nothing
 * is known; a dot before each free resource counts as one character of the line.
 */
export interface MachineShape {
  id: string;
  name: string;
  status: string;
}

/**
 * A machine's label in pixels, from its text: the name, and in a wide world the second line under it, at most
 * MACHINE_LABEL_WIDTH_PX wide, where a long line ends with an ellipsis.
 */
export function machineLabelSize(machine: MachineShape, withStatus: boolean): Size {
  const text = Math.max(machine.name.length * 7.4, withStatus ? machine.status.length * 6.4 : 0);
  return {
    width: Math.min(MACHINE_LABEL_WIDTH_PX, Math.round(text + 16)),
    height: MACHINE_LABEL_HEIGHT_PX[withStatus ? "wide" : "tall"],
  };
}

/** The machines' reactors: one column along the right edge of the galaxy. */
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

/** The part of the right edge the column may use, top to bottom: clear of the panels and of the fuel row on a phone. */
export function machineSpan(size: Size, covered: readonly Rect[] = defaultCovered(size)): { top: number; bottom: number } {
  return columnSpan(size, covered, size.width - MACHINE_EDGE - MACHINE_SIZE.tall, size.width);
}

/**
 * Puts a reactor for each machine, in the order given, in one column along the right edge of the world, evenly
 * over the part of it no panel covers (see machineSpan), each with its label on its left at the height of its centre. A
 * row is as tall as the station or its label, whichever is taller. A long column draws its stations smaller, down to
 * MACHINE_MIN_SIZE, and then stays as it is: that is its limit. `note` reserves a line over the column for a broken
 * config. The labels' room is reserved at `labelZoom`, the zoom of the full view.
 */
export function machinePositions(
  machines: readonly MachineShape[],
  size: Size,
  labelZoom = LABEL_ZOOM,
  note = false,
  covered: readonly Rect[] = defaultCovered(size),
): MachineColumn {
  const wide = size.width >= size.height;
  const span = machineSpan(size, covered);
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
  // first at its top and the last at its bottom, so that the column stays clear of the panels.
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

// Fuel ----------------------------------------------------------------------------------------------

/** What the fuel column knows of a tank: its key, its family and its label's two lines, and its free resets. */
export interface TankShape {
  key: string;
  executor: "codex" | "claude";
  name: string;
  /** The label's second line: what is left and when it refills. */
  info: string;
  /** The free resets the label shows as spare cells. */
  resets: number;
}

/** The tank's art is narrower than tall by this ratio. */
export const TANK_ASPECT = 140 / 256;
/** The tank's glass window, as shares of its sprite: the fuel shows there. */
export const TANK_GLASS = { x0: 0.37, x1: 0.625, y0: 0.215, y1: 0.725 } as const;
/**
 * A tank's height in world units: in a wide world, where tanks stand in a column on the left, and in a tall one, where they
 * stand in a row along the top and a phone shows them at a smaller zoom; and the least it shrinks to in a long column.
 */
export const TANK_SIZE = { wide: 96, tall: 170 } as const;
export const TANK_MIN_SIZE = 56;
/** The admiral's badge rises this share of the tank's height above it. */
export const BADGE_RISE = 0.16;
/** The day lamps' column beside a tank: its gap from the tank and its width, as shares of the tank's height. */
export const LAMP_GAP = 0.05;
export const LAMP_WIDTH = 0.08;
/** The widest tank label, in pixels; MapView's CSS keeps it to this. */
export const FUEL_LABEL_WIDTH_PX = 150;
/** A tank label's height in pixels: the name, and what is left with when it refills. */
const FUEL_LABEL_HEIGHT_PX = 34;
/** A spare cell in the label, in pixels with its gap. */
const CELL_PX = 12;
/** World units between the column and the world's edge, between a tank's lamps and its label, between rows and families. */
const FUEL_EDGE = 20;
const FUEL_GAP = 8;
const FUEL_ROW_GAP = 12;
const FAMILY_GAP = 16;

/** A tank's label in pixels, from its text, at most FUEL_LABEL_WIDTH_PX wide, where a long line ends with an ellipsis. */
export function tankLabelSize(tank: TankShape): Size {
  const text = Math.max(tank.name.length * 7.4 + 14, tank.info.length * 6.4 + tank.resets * CELL_PX + (tank.resets ? 4 : 0));
  return { width: Math.min(FUEL_LABEL_WIDTH_PX, Math.round(text + 16)), height: FUEL_LABEL_HEIGHT_PX };
}

/** The width of a tank with its day lamps, in world units, for a tank `size` tall. */
export function tankGear(size: number): number {
  return size * (TANK_ASPECT + LAMP_GAP + LAMP_WIDTH);
}

/** The subscriptions' fuel tanks: a column along the left edge of a wide galaxy, a row along the top of a tall one. */
export interface FuelColumn {
  /** Each tank's centre. */
  places: Map<string, Point>;
  /** Each label's size in pixels: see tankLabelSize; in a row no wider than its tank's share of the row. */
  labels: Map<string, Size>;
  /** Where each label stands: its left middle in a column, its top middle in a row. */
  anchors: Map<string, Point>;
  /** The tanks stand in a row, their labels below them; in a column the labels stand on their right. */
  row: boolean;
  /** Every tank's height in world units. */
  size: number;
  /** The zoom the labels' room was reserved at: see Galaxy.labelZoom. */
  labelZoom: number;
}

/**
 * Puts a fuel tank for each subscription, in the order given. In a wide world they stand in one column along the left
 * edge, over the part of it no panel covers, Codex and Claude apart, each with its label on its right at the height of
 * its centre; a long column draws them smaller, down to TANK_MIN_SIZE, and then closes up, like the machines'. In a tall
 * one, where the column would leave the stars no room, they stand in one row under the toolbar, each label under its
 * tank. The labels' room is reserved at `labelZoom`, the zoom of the full view.
 */
export function fuelPositions(
  tanks: readonly TankShape[],
  size: Size,
  labelZoom = LABEL_ZOOM,
  covered: readonly Rect[] = defaultCovered(size),
): FuelColumn {
  const row = size.width < size.height;
  const places = new Map<string, Point>();
  const anchors = new Map<string, Point>();
  const labels = new Map(tanks.map((tank) => [tank.key, tankLabelSize(tank)]));
  const count = Math.max(1, tanks.length);
  const labelHeight = FUEL_LABEL_HEIGHT_PX / labelZoom;
  if (row) {
    const top = columnSpan(size, covered, 0, size.width).top;
    const slot = (size.width - FUEL_EDGE * 2) / count;
    const tank = Math.max(TANK_MIN_SIZE, Math.min(TANK_SIZE.tall, (slot * 0.8) / (TANK_ASPECT + LAMP_GAP + LAMP_WIDTH)));
    tanks.forEach((shape, index) => {
      const middle = FUEL_EDGE + slot * (index + 0.5);
      const y = top + tank * BADGE_RISE + tank / 2;
      places.set(shape.key, { x: middle - tankGear(tank) / 2 + (tank * TANK_ASPECT) / 2, y });
      anchors.set(shape.key, { x: middle, y: y + tank / 2 + FUEL_GAP });
      const label = labels.get(shape.key)!;
      labels.set(shape.key, { width: Math.min(label.width, Math.floor((slot - FUEL_GAP) * labelZoom)), height: label.height });
    });
    return { places, labels, anchors, row, size: tank, labelZoom };
  }
  const span = columnSpan(size, covered, 0, FUEL_EDGE + tankGear(TANK_SIZE.wide) + FUEL_GAP + FUEL_LABEL_WIDTH_PX / labelZoom);
  const breaks = tanks.filter((tank, index) => index > 0 && tank.executor !== tanks[index - 1]!.executor).length;
  const free = span.bottom - span.top - breaks * FAMILY_GAP;
  const step = free / count;
  const tank = Math.max(TANK_MIN_SIZE, Math.min(TANK_SIZE.wide, (step - FUEL_ROW_GAP) / (1 + BADGE_RISE)));
  const height = Math.max(tank * (1 + BADGE_RISE), labelHeight) + FUEL_ROW_GAP;
  // Past the column's limit the rows close up, the first at its top and the last at its bottom, as the machines' do.
  const crowded = step < height && count > 1;
  const pitch = crowded ? (free - height) / (count - 1) : step;
  const first = span.top + (crowded ? height : step) / 2;
  let gaps = 0;
  tanks.forEach((shape, index) => {
    if (index > 0 && shape.executor !== tanks[index - 1]!.executor) gaps++;
    // The tank with its badge stands in the middle of its row.
    const y = first + pitch * index + gaps * FAMILY_GAP + (tank * BADGE_RISE) / 2;
    places.set(shape.key, { x: FUEL_EDGE + (tank * TANK_ASPECT) / 2, y });
    anchors.set(shape.key, { x: FUEL_EDGE + tankGear(tank) + FUEL_GAP, y });
  });
  return { places, labels, anchors, row, size: tank, labelZoom };
}

/** The room of a tank: the tank with its badge and lamps, and its label. */
export function fuelRoom(key: string, fuel: FuelColumn): Rect {
  const at = fuel.places.get(key)!;
  const anchor = fuel.anchors.get(key)!;
  const label = fuel.labels.get(key) ?? { width: FUEL_LABEL_WIDTH_PX, height: FUEL_LABEL_HEIGHT_PX };
  const width = label.width / fuel.labelZoom;
  const height = label.height / fuel.labelZoom;
  const gear = { x0: at.x - (fuel.size * TANK_ASPECT) / 2, y0: at.y - fuel.size / 2 - fuel.size * BADGE_RISE, y1: at.y + fuel.size / 2 };
  if (fuel.row) {
    return {
      x0: Math.min(gear.x0, anchor.x - width / 2),
      y0: gear.y0,
      x1: Math.max(gear.x0 + tankGear(fuel.size), anchor.x + width / 2),
      y1: anchor.y + height,
    };
  }
  return { x0: gear.x0, y0: Math.min(gear.y0, anchor.y - height / 2), x1: anchor.x + width, y1: Math.max(gear.y1, anchor.y + height / 2) };
}

/** All the tanks as one rect, the gaps between them too; null without tanks. */
export function fuelColumnRect(fuel: FuelColumn): Rect | null {
  const rooms = [...fuel.places.keys()].map((key) => fuelRoom(key, fuel));
  if (!rooms.length) return null;
  return {
    x0: Math.min(...rooms.map((room) => room.x0)),
    y0: Math.min(...rooms.map((room) => room.y0)),
    x1: Math.max(...rooms.map((room) => room.x1)),
    y1: Math.max(...rooms.map((room) => room.y1)),
  };
}
