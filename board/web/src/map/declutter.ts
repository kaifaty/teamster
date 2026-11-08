// Where each star's label stands on the screen, so that no two labels overlap. Labels go in the order of their
// priority, each to the first free spot of eight around its star, below first; a label with no free spot hides until
// the zoom makes room. Pure numbers in screen pixels.

import type { Rect } from "./layout";

export interface StarLabel {
  id: string;
  /** The star's centre on the screen. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The star with its ring of ships on the screen, and the distance from its centre down to a label below. */
  radius: number;
  drop: number;
  /** Higher goes first. */
  priority: number;
  /** Shown even with no free spot: over other labels, clear of the panels where it can be, else below the star. */
  forced: boolean;
  /** Other labels keep off this star; a quiet star's dot may be covered. */
  solid: boolean;
}

/** The label's top left corner from the star's centre, or null for a label that waits for the zoom. */
export type Spot = { dx: number; dy: number } | null;

const GAP = 4;

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** The spots a label may take around its star, best first. */
export function labelSpots(label: StarLabel): { dx: number; dy: number }[] {
  const { width: w, height: h, radius: r } = label;
  const d = r * 0.72 + GAP;
  return [
    { dx: -w / 2, dy: label.drop },
    { dx: -w / 2, dy: -r - GAP - h },
    { dx: r + GAP, dy: -h / 2 },
    { dx: -r - GAP - w, dy: -h / 2 },
    { dx: d, dy: d },
    { dx: -d - w, dy: d },
    { dx: d, dy: -d - h },
    { dx: -d - w, dy: -d - h },
  ];
}

/** Places the labels inside `bounds`, clear of each other, of the `obstacles` and of the solid stars. */
export function placeLabels(labels: readonly StarLabel[], obstacles: readonly Rect[], bounds: Rect): Map<string, Spot> {
  const result = new Map<string, Spot>();
  const taken: Rect[] = [...obstacles];
  const discs = labels
    .filter((label) => label.solid)
    .map((label) => ({ id: label.id, rect: { x0: label.x - label.radius, y0: label.y - label.radius, x1: label.x + label.radius, y1: label.y + label.radius } }));
  const order = [...labels].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const label of order) {
    const boxAt = (spot: { dx: number; dy: number }): Rect => ({
      x0: label.x + spot.dx,
      y0: label.y + spot.dy,
      x1: label.x + spot.dx + label.width,
      y1: label.y + spot.dy + label.height,
    });
    const spots = labelSpots(label);
    let chosen: Spot = null;
    for (const spot of spots) {
      const box = boxAt(spot);
      if (box.x0 < bounds.x0 || box.y0 < bounds.y0 || box.x1 > bounds.x1 || box.y1 > bounds.y1) continue;
      if (taken.some((other) => overlaps(box, other))) continue;
      if (discs.some((disc) => disc.id !== label.id && overlaps(box, disc.rect))) continue;
      chosen = spot;
      break;
    }
    // A forced label without a free spot still keeps clear of the panels and the screen's edge where it can.
    if (!chosen && label.forced) {
      const clear = (spot: { dx: number; dy: number }) => {
        const box = boxAt(spot);
        return box.x0 >= bounds.x0 && box.y0 >= bounds.y0 && box.x1 <= bounds.x1 && box.y1 <= bounds.y1 && !obstacles.some((other) => overlaps(box, other));
      };
      chosen = spots.find(clear) ?? spots[0]!;
    }
    if (chosen) taken.push(boxAt(chosen));
    result.set(label.id, chosen);
  }
  return result;
}
