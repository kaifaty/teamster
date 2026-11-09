// The machines' reactors: one column along the right edge of the galaxy, with their labels.

import { columnSpan, defaultCovered } from "./chrome";
import { LABEL_ZOOM } from "./galaxy";
import type { Point, Rect, Size } from "./geometry";

/**
 * A machine's reactor with its rings: their outer diameter in world units, larger in a tall world, which a phone shows at a
 * smaller zoom; and the least it shrinks to in a long column.
 */
export const MACHINE_SIZE = { wide: 108, tall: 150 } as const;
export const MACHINE_MIN_SIZE = 64;

/** The widest machine label, in pixels; MapView's CSS keeps it to this. */
export const MACHINE_LABEL_WIDTH_PX = 180;
/** A machine label's height in pixels: its name and what is free in a wide world, its name alone in a tall one. */
const MACHINE_LABEL_HEIGHT_PX = { wide: 34, tall: 20 } as const;
/** The line over the column that tells the machines' config could not be read, in pixels. */
export const MACHINE_NOTE_PX = { width: 280, height: 20 } as const;
/** The reactor with its rings is round: as tall as it is wide. */
const MACHINE_ASPECT = 1;
/** World units between the column's right side and the world's edge, between a station and its label, and between rows. */
const MACHINE_EDGE = 20;
export const MACHINE_GAP = 6;
const MACHINE_ROW_GAP = 10;

/**
 * What the column knows of a machine: its id, and the name and second line its label shows, what is free or why nothing
 * is known; a dot before each free resource counts as one character of the line.
 */
export interface MachineShape {
  id: string;
  name: string;
  status: string;
}

/**
 * A machine's label in pixels, from its text: the name, and in a wide world the second line under it, at most
 * MACHINE_LABEL_WIDTH_PX wide, where a long line ends with an ellipsis.
 */
export function machineLabelSize(machine: MachineShape, withStatus: boolean): Size {
  const text = Math.max(machine.name.length * 7.4, withStatus ? machine.status.length * 6.4 : 0);
  return {
    width: Math.min(MACHINE_LABEL_WIDTH_PX, Math.round(text + 16)),
    height: MACHINE_LABEL_HEIGHT_PX[withStatus ? "wide" : "tall"],
  };
}

/** The machines' reactors: one column along the right edge of the galaxy. */
export interface MachineColumn {
  places: Map<string, Point>;
  /** Each label's size in pixels: see machineLabelSize. */
  labels: Map<string, Size>;
  /** The labels show the status: in a wide world. In a tall one the glow tells it, the title and the card the rest. */
  status: boolean;
  /** The long side of every station's sprite, in world units. */
  size: number;
  /** The zoom the labels' room was reserved at: see Galaxy.labelZoom. */
  labelZoom: number;
  /** The right side of the column, where the stations end. */
  right: number;
  /** Where the line about a broken config stands, its right end: null without one. */
  note: Point | null;
}

/** The part of the right edge the column may use, top to bottom: clear of the panels and of the fuel row on a phone. */
export function machineSpan(size: Size, covered: readonly Rect[] = defaultCovered(size)): { top: number; bottom: number } {
  return columnSpan(size, covered, size.width - MACHINE_EDGE - MACHINE_SIZE.tall, size.width);
}

/**
 * Puts a reactor for each machine, in the order given, in one column along the right edge of the world, evenly
 * over the part of it no panel covers (see machineSpan), each with its label on its left at the height of its centre. A
 * row is as tall as the station or its label, whichever is taller. A long column draws its stations smaller, down to
 * MACHINE_MIN_SIZE, and then stays as it is: that is its limit. `note` reserves a line over the column for a broken
 * config. The labels' room is reserved at `labelZoom`, the zoom of the full view.
 */
export function machinePositions(
  machines: readonly MachineShape[],
  size: Size,
  labelZoom = LABEL_ZOOM,
  note = false,
  covered: readonly Rect[] = defaultCovered(size),
): MachineColumn {
  const wide = size.width >= size.height;
  const span = machineSpan(size, covered);
  const right = size.width - MACHINE_EDGE;
  const noteAt = note ? { x: right, y: span.top } : null;
  const top = note ? span.top + MACHINE_NOTE_PX.height / labelZoom + MACHINE_GAP : span.top;
  const label = MACHINE_LABEL_HEIGHT_PX[wide ? "wide" : "tall"] / labelZoom;
  const count = Math.max(1, machines.length);
  const step = (span.bottom - top) / count;
  const largest = MACHINE_SIZE[wide ? "wide" : "tall"];
  const stationSize = Math.max(MACHINE_MIN_SIZE, Math.min(largest, (step - MACHINE_ROW_GAP) / MACHINE_ASPECT));
  const row = Math.max(stationSize * MACHINE_ASPECT, label) + MACHINE_ROW_GAP;
  // Each row stands in the middle of its share of the column. Past the column's limit the rows close up instead, the
  // first at its top and the last at its bottom, so that the column stays clear of the panels.
  const crowded = step < row && count > 1;
  const pitch = crowded ? (span.bottom - top - row) / (count - 1) : step;
  const first = top + (crowded ? row : step) / 2;
  const places = new Map<string, Point>();
  const labels = new Map<string, Size>();
  machines.forEach((machine, index) => {
    places.set(machine.id, { x: right - stationSize / 2, y: first + pitch * index });
    labels.set(machine.id, machineLabelSize(machine, wide));
  });
  return { places, labels, status: wide, size: stationSize, labelZoom, right, note: noteAt };
}

/** Where a station's label ends on the right, at the height of the station's centre. */
export function machineLabelAnchor(id: string, column: MachineColumn): Point | null {
  const at = column.places.get(id);
  return at ? { x: at.x - column.size / 2 - MACHINE_GAP, y: at.y } : null;
}

/** The room of a station's row: the station and its label on its left, as tall as the taller of them. */
export function machineRoom(id: string, column: MachineColumn): Rect {
  const at = column.places.get(id)!;
  const label = column.labels.get(id) ?? { width: MACHINE_LABEL_WIDTH_PX, height: MACHINE_LABEL_HEIGHT_PX.wide };
  const half = Math.max(column.size * MACHINE_ASPECT, label.height / column.labelZoom) / 2;
  const left = at.x - column.size / 2 - MACHINE_GAP - label.width / column.labelZoom;
  return { x0: left, y0: at.y - half, x1: column.right, y1: at.y + half };
}

/**
 * The whole column as one rect, in world units: from the top of the first row to the bottom of the last, and from the
 * left side of the widest label's room to the column's right side, gaps between the rows included. The line about a
 * broken config is not part of it. Null without machines.
 */
export function machineColumnRect(column: MachineColumn): Rect | null {
  const rooms = [...column.places.keys()].map((id) => machineRoom(id, column));
  if (!rooms.length) return null;
  return {
    x0: Math.min(...rooms.map((room) => room.x0)),
    y0: Math.min(...rooms.map((room) => room.y0)),
    x1: Math.max(...rooms.map((room) => room.x1)),
    y1: Math.max(...rooms.map((room) => room.y1)),
  };
}

/** The room of the line over the column about a broken config: null without one. */
export function machineNoteRoom(column: MachineColumn): Rect | null {
  if (!column.note) return null;
  const { x, y } = column.note;
  return { x0: x - MACHINE_NOTE_PX.width / column.labelZoom, y0: y, x1: x, y1: y + MACHINE_NOTE_PX.height / column.labelZoom };
}

/** The rooms of every station and of the line over the column. */
export function machineRooms(column: MachineColumn): Rect[] {
  const rooms = [...column.places.keys()].map((id) => machineRoom(id, column));
  const note = machineNoteRoom(column);
  if (note) rooms.push(note);
  return rooms;
}
