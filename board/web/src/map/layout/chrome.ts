// The part of the galaxy's world the map's toolbar covers until the map measures it. The control panel at the bottom
// takes no part of the world: the galaxy is fitted into the window above it.

import type { Rect, Size } from "./geometry";

/** The part of the world under the map's toolbar, until the map measures it: a band along the top. */
export function toolbarBand(size: Size): Rect {
  return { x0: 0, y0: 0, x1: size.width, y1: size.width >= size.height ? 90 : 300 };
}

/** The parts of the world under the map's panels until the map measures them: the toolbar. */
export function defaultCovered(size: Size): Rect[] {
  return [toolbarBand(size)];
}
