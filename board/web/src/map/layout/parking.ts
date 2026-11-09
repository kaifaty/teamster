// Where a station's ships park: the arcs on its side, the inspection's lanes and the order of the ships.

import type { Place } from "../placement";
import type { Point, Size } from "./geometry";
import { BALL_SHARE, STATIONS, stationAt, stationOf, type SystemFrame } from "./system";

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
