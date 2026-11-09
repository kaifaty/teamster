// The subscriptions' fuel tanks: a column along the left edge of a wide galaxy, a row along the top of a tall one.

import { columnSpan, defaultCovered } from "./chrome";
import { LABEL_ZOOM } from "./galaxy";
import type { Point, Rect, Size } from "./geometry";

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
