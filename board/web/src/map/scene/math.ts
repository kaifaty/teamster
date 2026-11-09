// Pure helpers of the scene's drawing: curves, stable noise, turns and points on a ship's hull.

import type { Point } from "../layout";

export function curvePoint(a: Point, b: Point, bend: number, u: number): Point {
  const middle = { x: (a.x + b.x) / 2 + (b.y - a.y) * bend, y: (a.y + b.y) / 2 - (b.x - a.x) * bend };
  const v = 1 - u;
  return { x: v * v * a.x + 2 * v * u * middle.x + u * u * b.x, y: v * v * a.y + 2 * v * u * middle.y + u * u * b.y };
}

/** Stable pseudo-random number in [0, 1) from an index. */
export function noise(index: number): number {
  const value = Math.sin(index * 127.1 + 3.3) * 43758.5453;
  return value - Math.floor(value);
}

/** The shortest turn from one angle to another. */
export function turn(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** The ship's own point of damage, in shares of its size from the centre, nose up. */
export function damageSpot(seed: number): Point {
  return { x: (noise(seed) - 0.5) * 0.2, y: noise(seed + 1) * 0.28 - 0.1 };
}

/** A point of a ship's art in the world: `local` in shares of its size, turned with the ship. */
export function onHull(item: { x: number; y: number; size: number; body: { rotation: number; scale: { x: number } } }, local: Point, out: Point): Point {
  const cos = Math.cos(item.body.rotation);
  const sin = Math.sin(item.body.rotation);
  const scale = item.size * item.body.scale.x;
  out.x = item.x + (local.x * cos - local.y * sin) * scale;
  out.y = item.y + (local.x * sin + local.y * cos) * scale;
  return out;
}
