// The camera: how world units turn into screen pixels, and how it zooms, pans and refits.

import type { Point, Size, View } from "./geometry";

/** The camera: a world point (x, y) is drawn at (x * zoom + tx, y * zoom + ty). */
export interface Camera {
  zoom: number;
  tx: number;
  ty: number;
}

/** The whole world in `view`, centred. */
export function fitCamera(world: Size, view: View): Camera {
  const zoom = Math.min(view.width / world.width, view.height / world.height);
  return { zoom, tx: (view.x ?? 0) + (view.width - world.width * zoom) / 2, ty: (view.y ?? 0) + (view.height - world.height * zoom) / 2 };
}

/** How far the camera may zoom in, as a multiple of the fitted zoom. */
export const MAX_ZOOM = 3;

/** Zoom around a screen point, from the fitted view up to the closest view. */
export function zoomCamera(camera: Camera, factor: number, at: Point, fit: Camera, closest = fit.zoom * MAX_ZOOM): Camera {
  const zoom = Math.min(closest, Math.max(fit.zoom, camera.zoom * factor));
  const scale = zoom / camera.zoom;
  return { zoom, tx: at.x - (at.x - camera.tx) * scale, ty: at.y - (at.y - camera.ty) * scale };
}

/**
 * `camera` kept so that the world covers `view` and every edge of the world can be brought into it; a world smaller
 * than the view stays centred in it.
 */
export function clampCamera(camera: Camera, world: Size, view: View): Camera {
  const axis = (offset: number, worldLength: number, start: number, viewLength: number) => {
    const length = worldLength * camera.zoom;
    if (length <= viewLength) return start + (viewLength - length) / 2;
    return Math.min(start, Math.max(start + viewLength - length, offset));
  };
  return {
    zoom: camera.zoom,
    tx: axis(camera.tx, world.width, view.x ?? 0, view.width),
    ty: axis(camera.ty, world.height, view.y ?? 0, view.height),
  };
}
