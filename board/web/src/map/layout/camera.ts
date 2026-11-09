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

/** `camera` zoomed by `factor` around the screen point `at`, within the fitted zoom and MAX_ZOOM. */
export function zoomCamera(camera: Camera, factor: number, at: Point, fit: Camera): Camera {
  const zoom = Math.min(fit.zoom * MAX_ZOOM, Math.max(fit.zoom, camera.zoom * factor));
  const scale = zoom / camera.zoom;
  return { zoom, tx: at.x - (at.x - camera.tx) * scale, ty: at.y - (at.y - camera.ty) * scale };
}

/**
 * A zoom from `zoom` by `factor`, kept within the fitted zoom and MAX_ZOOM; `past` is how far it asked beyond them,
 * as a natural logarithm: below zero past the fitted view, above zero past the closest one.
 */
export function limitZoom(zoom: number, factor: number, fit: Camera): { zoom: number; past: number } {
  const wanted = zoom * factor;
  const kept = Math.min(fit.zoom * MAX_ZOOM, Math.max(fit.zoom, wanted));
  return { zoom: kept, past: Math.log(wanted / kept) };
}

/**
 * `camera` carried over to a view of another size: the same share of the fitted zoom, around the same world point
 * in the middle of the view.
 */
export function refitCamera(camera: Camera, before: { fit: Camera; viewport: View }, fit: Camera, viewport: View, world: Size): Camera {
  const zoom = fit.zoom * (camera.zoom / before.fit.zoom);
  const x = ((before.viewport.x ?? 0) + before.viewport.width / 2 - camera.tx) / camera.zoom;
  const y = ((before.viewport.y ?? 0) + before.viewport.height / 2 - camera.ty) / camera.zoom;
  const middle = { x: (viewport.x ?? 0) + viewport.width / 2, y: (viewport.y ?? 0) + viewport.height / 2 };
  return clampCamera({ zoom, tx: middle.x - x * zoom, ty: middle.y - y * zoom }, world, viewport);
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
