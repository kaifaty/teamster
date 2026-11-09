// Where the science station stands: apart, in the lower right corner of the galaxy, clear of the columns and panels.

import { columnSpan, defaultCovered } from "./chrome";
import { fuelRoom, type FuelColumn } from "./fuel";
import { LABEL_ZOOM } from "./galaxy";
import type { Point, Rect, Size } from "./geometry";
import { MACHINE_GAP, machineRoom, type MachineColumn } from "./machines";

/** The science station's label in pixels: on a wide window, and on a narrow one, where its font is smaller. */
const RESEARCH_LABEL_PX = { wide: { width: 200, height: 40 }, tall: { width: 176, height: 36 } } as const;
/** World units from the science station's centre down to its label: see MapView. */
export const RESEARCH_LABEL_DROP = 93;
/** World units between the station with its label and the world's right edge. */
const RESEARCH_EDGE = 24;

/**
 * The science station stands apart from the systems it studies, in the lower right corner of the galaxy: as low as the
 * panels over the bottom edge let its label stand, and left of the machines' reactors and their labels in its rows. A
 * tank's label in its rows pushes it right the same way.
 */
export function researchPosition(
  size: Size,
  covered: readonly Rect[] = defaultCovered(size),
  machines: MachineColumn | null = null,
  fuel: FuelColumn | null = null,
): Point {
  const zoom = machines?.labelZoom ?? fuel?.labelZoom ?? LABEL_ZOOM;
  const label = RESEARCH_LABEL_PX[size.width >= size.height ? "wide" : "tall"];
  const labelHalf = label.width / zoom / 2;
  const half = Math.max(RESEARCH_SIZE / 2, labelHalf);
  const below = RESEARCH_LABEL_DROP + label.height / zoom;
  /** The station's centre height for a station centred at x: its label's bottom on the lowest free line there. */
  const heightAt = (x: number) => {
    const span = columnSpan(size, covered, x - half, x + half);
    return Math.max(span.top + RESEARCH_SIZE / 2, span.bottom - below);
  };
  let x = size.width - RESEARCH_EDGE - half;
  const y = heightAt(x);
  // The station and its label, each as a half width and a band from the station's centre.
  const parts = [
    { half: RESEARCH_SIZE / 2, y0: y - RESEARCH_SIZE / 2, y1: y + RESEARCH_SIZE / 2 },
    { half: labelHalf, y0: y + RESEARCH_LABEL_DROP, y1: y + below },
  ];
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
  x = Math.max(half, x);
  return { x, y: Math.min(y, heightAt(x)) };
}

/** The station's size in world units. */
export const RESEARCH_SIZE = 150;
