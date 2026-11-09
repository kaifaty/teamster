// Where the science station stands in the middle of the galaxy, clear of the machines' and the tanks' labels.

import { fuelRoom, type FuelColumn } from "./fuel";
import type { Point, Size } from "./geometry";
import { MACHINE_GAP, machineRoom, type MachineColumn } from "./machines";

/** The science station's label in pixels: on a wide window, and on a narrow one, where its font is smaller. */
const RESEARCH_LABEL_PX = { wide: { width: 200, height: 40 }, tall: { width: 176, height: 36 } } as const;
/** World units from the science station's centre down to its label: see MapView. */
export const RESEARCH_LABEL_DROP = 93;

/**
 * The science station watches every system, so it stands in the middle of the galaxy. When a machine's label would
 * meet the station or its label there, as it can on a narrow window, it moves left just far enough to keep clear, and
 * right of a tank's label the same way.
 */
export function researchPosition(size: Size, machines: MachineColumn | null = null, fuel: FuelColumn | null = null): Point {
  const middle = { x: size.width * 0.5, y: size.height * 0.49 };
  if (!machines?.places.size && !fuel?.places.size) return middle;
  const zoom = machines?.labelZoom ?? fuel!.labelZoom;
  const label = RESEARCH_LABEL_PX[size.width >= size.height ? "wide" : "tall"];
  // The station and its label, each as a half width and a band from the station's centre.
  const parts = [
    { half: RESEARCH_SIZE / 2, y0: middle.y - RESEARCH_SIZE / 2, y1: middle.y + RESEARCH_SIZE / 2 },
    { half: label.width / zoom / 2, y0: middle.y + RESEARCH_LABEL_DROP, y1: middle.y + RESEARCH_LABEL_DROP + label.height / zoom },
  ];
  let x = middle.x;
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
  return { x: Math.max(Math.max(...parts.map((part) => part.half)), x), y: middle.y };
}

/** The station's size in world units. */
export const RESEARCH_SIZE = 150;
