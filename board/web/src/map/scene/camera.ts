// The scene's camera, without Pixi and without the DOM: the worlds of the galaxy and of the open system fitted to the
// window, the cameras over them, and how the wheel, the fingers and the keys move them. Entering and leaving a system
// is told to the caller, which also knows the stars.

import {
  NO_INSETS,
  clampCamera,
  fitCamera,
  freeView,
  limitZoom,
  refitCamera,
  systemWorldSize,
  worldSize,
  zoomCamera,
  type Camera,
  type Insets,
  type Point,
  type Size,
  type View,
} from "../layout";

/** Milliseconds the wheel and pinches are ignored after they entered or left a system, so that one gesture does one. */
export const WHEEL_PAUSE_MS = 900;
/**
 * How far zooming out past the fitted system goes back to the galaxy, and zooming in past the closest galaxy over a
 * star enters its system, as natural logarithms: by notches of the wheel or keys, one notch out and two in; by a
 * pinch, which easily runs on a little, further.
 */
export const LEAVE_BEYOND = { notch: 0.2, pinch: 0.5 };
export const ENTER_BEYOND = { notch: 0.4, pinch: 0.6 };
/** How fast a zoom by the wheel or a key glides to its goal, per second. */
export const GLIDE_RATE = 14;

export interface CameraDeps {
  /** Motion is reduced: a zoom by notches lands at once. */
  still: boolean;
  /** Milliseconds of a steady clock, performance.now() in the browser. */
  now(): number;
  /** Whether the flight between the galaxy and a system is under way: the zoom waits for it. */
  flying(): boolean;
  /** The star at a world point of the galaxy, or null. */
  starAt(point: Point): string | null;
  onEnter(repo: string): void;
  onLeave(): void;
  /** The shapes of the galaxy's world and of the system's, and the camera over the one shown. */
  onCamera(worlds: { galaxy: Size; system: Size }, camera: Camera): void;
}

export interface SceneCamera {
  readonly viewport: Size;
  /** The galaxy's world and its fitted camera. */
  readonly world: Size;
  readonly fit: Camera;
  /** The part of the window no panel covers, and the system's world laid out in it with its fitted camera. */
  readonly free: View;
  readonly systemWorld: Size;
  readonly systemFit: Camera;
  /** The cameras over the galaxy and over the system shown; the galaxy's stays while a system is open. */
  readonly galaxyView: Camera;
  readonly systemView: Camera;
  /** A system is shown, not the galaxy. */
  readonly inSystem: boolean;
  /** The camera, world and fitted camera of what is shown. */
  view(): Camera;
  worldOf(): Size;
  fitOf(): Camera;
  /** The world point under the screen point `screen`. */
  worldPoint(screen: Point): Point;
  /** Lays the galaxy out for a window of `viewport`. */
  layoutGalaxy(viewport: Size): void;
  /** Lays the system out in the part of the window `insets` leave free. */
  layoutSystem(insets: Insets): void;
  /** Shows a system or the galaxy; a system shown starts from its fitted view. */
  show(system: boolean): void;
  /** Tells the caller the camera: see CameraDeps.onCamera. */
  report(): void;
  /** Sets the camera of what is shown. */
  put(next: Camera): void;
  /** Moves the world by (dx, dy) screen pixels. */
  panBy(dx: number, dy: number): void;
  /** Puts `from`, a camera of what is shown, moved by (dx, dy) screen pixels: a drag from where it began. */
  dragFrom(from: Camera, dx: number, dy: number): void;
  /**
   * Zooms by `factor` around the screen point `at`: by a notch, gliding there, or following a pinch. Zooming on past
   * the fitted system goes back to the galaxy, and past the closest galaxy over a star enters its system.
   */
  zoomBy(factor: number, at: Point, notch: boolean): void;
  /** Back to the fitted view of what is shown. */
  fitView(): void;
  /** Stops a zoom gliding to its goal. */
  stopGlide(): void;
  /** Glides a zoom by notches on by `dt` seconds. */
  step(dt: number): void;
  /** Whether the wheel and pinches are ignored at `nowMs`: see WHEEL_PAUSE_MS. */
  paused(nowMs: number): boolean;
}

export function createCamera(initial: Size, deps: CameraDeps): SceneCamera {
  let viewport = initial;
  let world = worldSize(viewport);
  let fit = fitCamera(world, viewport);
  /** The parts of the window under the map's panels; a system is laid out in the rest, `free`, with its own world. */
  let insets: Insets = NO_INSETS;
  let free: View = freeView(viewport, insets);
  let systemWorld = systemWorldSize(free);
  let systemFit = fitCamera(systemWorld, free);
  /** The cameras over the galaxy and over the system shown; the galaxy's stays while a system is open. */
  let galaxyView = fit;
  let systemView = systemFit;
  /** The fitted cameras and the views they were last laid out for. */
  let fitted = { fit, viewport };
  let systemFitted: { fit: Camera; viewport: View } = { fit: systemFit, viewport: free };
  let inSystem = false;
  /** Where a zoom by the wheel or a key glides to; a trackpad and fingers move the camera at once. */
  let glide: { zoom: number; at: Point } | null = null;
  /** How far the zoom asked past its limit since it reached it, as a natural logarithm: see limitZoom. */
  let beyond = 0;
  /** Until when the wheel and pinches are ignored, in performance.now() milliseconds. */
  let pausedUntil = 0;

  const view = (): Camera => (inSystem ? systemView : galaxyView);
  const worldOf = (): Size => (inSystem ? systemWorld : world);
  const fitOf = (): Camera => (inSystem ? systemFit : fit);
  /** `camera` kept over the world shown: see clampCamera. A system is kept within the free part of the window. */
  const clampView = (camera: Camera): Camera => clampCamera(camera, worldOf(), inSystem ? free : viewport);
  const report = () => deps.onCamera({ galaxy: world, system: systemWorld }, view());

  function worldPoint(screen: Point): Point {
    const { zoom, tx, ty } = view();
    return { x: (screen.x - tx) / zoom, y: (screen.y - ty) / zoom };
  }

  function layoutGalaxy(next: Size) {
    viewport = next;
    const shaped = worldSize(viewport);
    const reshaped = shaped.width !== world.width || shaped.height !== world.height;
    world = shaped;
    fit = fitCamera(world, viewport);
    // A new window keeps what the cameras looked at; a world of another shape starts from the whole of it.
    galaxyView = reshaped ? fit : refitCamera(galaxyView, fitted, fit, viewport, world);
    fitted = { fit, viewport };
  }

  function layoutSystem(next: Insets) {
    insets = next;
    free = freeView(viewport, insets);
    const shaped = systemWorldSize(free);
    const reshaped = shaped.width !== systemWorld.width || shaped.height !== systemWorld.height;
    systemWorld = shaped;
    systemFit = fitCamera(systemWorld, free);
    systemView = reshaped ? systemFit : refitCamera(systemView, systemFitted, systemFit, free, systemWorld);
    systemFitted = { fit: systemFit, viewport: free };
    glide = null;
  }

  function show(system: boolean) {
    if (system) systemView = systemFit;
    inSystem = system;
    glide = null;
    beyond = 0;
  }

  function put(next: Camera) {
    if (inSystem) systemView = next;
    else galaxyView = next;
    report();
  }

  function panBy(dx: number, dy: number) {
    glide = null;
    const current = view();
    put(clampView({ ...current, tx: current.tx + dx, ty: current.ty + dy }));
  }

  function dragFrom(from: Camera, dx: number, dy: number) {
    glide = null;
    put(clampView({ ...from, tx: from.tx + dx, ty: from.ty + dy }));
  }

  function zoomBy(factor: number, at: Point, notch: boolean) {
    const nowMs = deps.now();
    if (nowMs < pausedUntil || deps.flying()) return;
    const { zoom, past } = limitZoom(glide ? glide.zoom : view().zoom, factor, fitOf());
    beyond = past === 0 || Math.sign(past) !== Math.sign(beyond) ? past : beyond + past;
    const kind = notch ? "notch" : "pinch";
    if (inSystem && beyond <= -LEAVE_BEYOND[kind]) {
      beyond = 0;
      pausedUntil = nowMs + WHEEL_PAUSE_MS;
      deps.onLeave();
      return;
    }
    if (!inSystem && beyond >= ENTER_BEYOND[kind]) {
      beyond = 0;
      const star = deps.starAt(worldPoint(at));
      if (star) {
        pausedUntil = nowMs + WHEEL_PAUSE_MS;
        deps.onEnter(star);
        return;
      }
    }
    if (notch && !deps.still) {
      glide = { zoom, at };
      return;
    }
    glide = null;
    const current = view();
    put(clampView(zoomCamera(current, zoom / current.zoom, at, fitOf())));
  }

  function glideStep(dt: number) {
    const target = glide!;
    const current = view();
    const ratio = target.zoom / current.zoom;
    const done = Math.abs(Math.log(ratio)) < 0.002;
    put(clampView(zoomCamera(current, done ? ratio : ratio ** (1 - Math.exp(-dt * GLIDE_RATE)), target.at, fitOf())));
    if (done) glide = null;
  }

  return {
    get viewport() {
      return viewport;
    },
    get world() {
      return world;
    },
    get fit() {
      return fit;
    },
    get free() {
      return free;
    },
    get systemWorld() {
      return systemWorld;
    },
    get systemFit() {
      return systemFit;
    },
    get galaxyView() {
      return galaxyView;
    },
    get systemView() {
      return systemView;
    },
    get inSystem() {
      return inSystem;
    },
    view,
    worldOf,
    fitOf,
    worldPoint,
    layoutGalaxy,
    layoutSystem,
    show,
    report,
    put,
    panBy,
    dragFrom,
    zoomBy,
    fitView() {
      glide = null;
      put(fitOf());
    },
    stopGlide() {
      glide = null;
    },
    step(dt) {
      if (glide) glideStep(dt);
    },
    paused(nowMs) {
      return nowMs < pausedUntil;
    },
  };
}
