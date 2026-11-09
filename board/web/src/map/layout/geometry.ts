// The plain shapes of the map in world units, and the small helpers every part of the layout shares.

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The galaxy is laid out for the shape of the window: wide on a desktop, tall on a phone. */
export function worldSize(viewport: Size): Size {
  return viewport.width >= viewport.height ? { width: 1600, height: 1000 } : { width: 1000, height: 1500 };
}

/** Screen pixels at each edge of the window that the map's own panels cover. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** A part of the window in screen pixels; without x and y it starts at the window's corner. */
export type View = Size & { x?: number; y?: number };

/** The part of the window that no panel covers. */
export function freeView(viewport: Size, insets: Insets): Required<View> {
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(1, viewport.width - insets.left - insets.right),
    height: Math.max(1, viewport.height - insets.top - insets.bottom),
  };
}

/** A rectangle in world units. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Stable, well spread number from a name. */
export function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
