// The constellations' names in the galaxy, each on the first free side of its stars.

import type { Constellation } from "../constellations";
import type { Galaxy, Rect, Size } from "../layout";
import { at } from "./style";

/**
 * A constellation's name beside its stars, centred on them: above them, or else below, left or right of them, on the
 * first side where it meets none of `keepOuts`, nor leaves the world.
 */
export function constellationLabels(
  list: readonly Constellation[],
  layout: Pick<Galaxy, "places" | "spacing" | "labelZoom">,
  world: Size,
  keepOuts: readonly Rect[],
) {
  return list.flatMap((item) => {
    const points = item.repos.flatMap((name) => layout.places.get(name) ?? []);
    if (!points.length) return [];
    const width = (item.name.length * 12 + 8) / layout.labelZoom;
    const height = 18 / layout.labelZoom;
    const x0 = Math.min(...points.map((point) => point.x));
    const x1 = Math.max(...points.map((point) => point.x));
    const y0 = Math.min(...points.map((point) => point.y));
    const y1 = Math.max(...points.map((point) => point.y));
    const middle = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    const gap = layout.spacing * 0.6;
    // The label's middle on each side, and its box there.
    const sides = [
      { side: "above", x: middle.x, y: y0 - gap - height / 2 },
      { side: "below", x: middle.x, y: y1 + gap + height / 2 + 20 / layout.labelZoom },
      { side: "left", x: x0 - gap - width / 2, y: middle.y },
      { side: "right", x: x1 + gap + width / 2, y: middle.y },
    ] as const;
    const open = (spot: { x: number; y: number }) => {
      const box = { x0: spot.x - width / 2, y0: spot.y - height / 2, x1: spot.x + width / 2, y1: spot.y + height / 2 };
      const inside = box.x0 >= 0 && box.y0 >= 0 && box.x1 <= world.width && box.y1 <= world.height;
      return inside && !keepOuts.some((rect) => box.x0 < rect.x1 && rect.x0 < box.x1 && box.y0 < rect.y1 && rect.y0 < box.y1);
    };
    const spot = sides.find(open) ?? sides[0];
    return [{ name: item.name, side: spot.side, style: { ...at(spot.x, spot.y), color: item.color } }];
  });
}
