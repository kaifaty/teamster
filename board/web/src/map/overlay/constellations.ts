// The constellations' names in the galaxy, each on the first free side of its stars.

import type { Constellation } from "../constellations";
import {
  fuelColumnRect,
  machineColumnRect,
  RESEARCH_LABEL_DROP,
  RESEARCH_SIZE,
  type FuelColumn,
  type Galaxy,
  type MachineColumn,
  type Point,
  type Rect,
  type Size,
} from "../layout";
import { at } from "./style";

/**
 * What a constellation's name must not cover: the science station standing at `station` with its label, the panels and
 * the columns.
 */
export function constellationKeepOuts(station: Point, machines: MachineColumn | null, fuel: FuelColumn | null, covered: readonly Rect[]): Rect[] {
  return [
    { x0: station.x - RESEARCH_SIZE / 2 - 20, y0: station.y - RESEARCH_SIZE / 2 - 20, x1: station.x + RESEARCH_SIZE / 2 + 20, y1: station.y + RESEARCH_SIZE / 2 + RESEARCH_LABEL_DROP + 50 },
    ...covered,
    ...[machines ? machineColumnRect(machines) : null, fuel ? fuelColumnRect(fuel) : null].filter((rect): rect is Rect => !!rect),
  ];
}

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
