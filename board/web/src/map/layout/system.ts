// A star system: its world, its orbits, and where its stations and their names stand.

import type { Place } from "../placement";
import type { Point, Size } from "./geometry";

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

/** The share of a station's radius its art fills to the edge of the ball. */
export const BALL_SHARE = 0.96;

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
