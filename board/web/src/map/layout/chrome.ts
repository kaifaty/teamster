// The parts of the world the map's own panels cover until the map measures them, and the room they leave the columns.

import type { Rect, Size } from "./geometry";

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
