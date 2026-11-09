// The pointer, two-finger pinches, the wheel, Safari's gestures and the keys, turned into what they ask of the map:
// a pan, a zoom at a point, a click or a hover at a point, the fitted view. The gestures are read from plain event
// objects, so that the tests can give them; `listen` hangs them on the canvas and the host.

import type { Camera, Point, Size } from "../layout";
import { ZOOM_NOTCH, wheelAction, wheelDevice, type WheelDevice, type WheelInput } from "../navigation";

/** Pixels the pointer may move and still make a click. */
export const CLICK_SLOP = 5;
/** Milliseconds without the wheel that end a gesture; the device is told again at the next one. */
export const WHEEL_GAP_MS = 250;

/** The fields of a pointer event the map reads. */
export interface PointerInput {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
}

/** An event the map may take over: over the map it is not the page's. */
export interface MapEventInput {
  target: unknown;
  preventDefault(): void;
}

export interface WheelEventInput extends WheelInput, MapEventInput {
  clientX: number;
  clientY: number;
}

/** Safari's gesturechange: the scale since the pinch began, around a point. */
export interface GestureInput extends MapEventInput {
  scale: number;
  clientX: number;
  clientY: number;
}

export interface KeyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
}

/** What the input reads of the scene and asks of it. Points are screen pixels over the canvas. */
export interface InputDeps {
  /** Milliseconds of a steady clock, performance.now() in the browser. */
  now(): number;
  /** The canvas's top left corner in client pixels. */
  origin(): Point;
  viewport(): Size;
  /** Whether `target` is the canvas or a label on it: the wheel there moves the camera. */
  onMap(target: unknown): boolean;
  /** Whether the wheel and pinches are ignored at `nowMs`. */
  paused(nowMs: number): boolean;
  camera(): Camera;
  pan(dx: number, dy: number): void;
  /** The camera `from` moved by (dx, dy): a drag from where it began. */
  drag(from: Camera, dx: number, dy: number): void;
  zoom(factor: number, at: Point, notch: boolean): void;
  fit(): void;
  stopGlide(): void;
  click(at: Point): void;
  /** The pointer moves over the map without a press. */
  hover(at: Point): void;
  /** The pointer left the canvas. */
  leave(): void;
  capture(pointerId: number): void;
  cursor(style: string): void;
}

export interface Input {
  down(event: PointerInput): void;
  move(event: PointerInput): void;
  up(event: PointerInput): void;
  cancel(event: PointerInput): void;
  leave(): void;
  wheel(event: WheelEventInput): void;
  gestureStart(event: MapEventInput): void;
  gestureChange(event: GestureInput): void;
  gestureEnd(event: MapEventInput): void;
  key(event: KeyInput): void;
}

export function createInput(deps: InputDeps): Input {
  const screenPoint = (event: { clientX: number; clientY: number }): Point => {
    const origin = deps.origin();
    return { x: event.clientX - origin.x, y: event.clientY - origin.y };
  };

  /** The pointers pressed on the canvas: one drags the map, two pinch it. */
  const pointers = new Map<number, Point>();
  /** The press that may still be a click: where it began, and the camera then. */
  let press: { at: Point; camera: Camera; dragged: boolean } | null = null;
  let pinch: { distance: number; middle: Point } | null = null;

  const pinchOf = () => {
    const [a, b] = [...pointers.values()] as [Point, Point];
    return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };
  const pressFrom = (at: Point, dragged: boolean) => {
    press = { at, camera: deps.camera(), dragged };
  };

  const down = (event: PointerInput) => {
    if (event.button !== 0 || pointers.size >= 2) return;
    pointers.set(event.pointerId, screenPoint(event));
    deps.capture(event.pointerId);
    deps.stopGlide();
    if (pointers.size === 1) {
      pressFrom(screenPoint(event), false);
      return;
    }
    // A second finger: a pinch, and no click.
    press = null;
    pinch = pinchOf();
  };

  const move = (event: PointerInput) => {
    const at = screenPoint(event);
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, at);
      if (pinch && pointers.size === 2) {
        // The world under the fingers follows their middle, then grows or shrinks around it.
        const next = pinchOf();
        deps.pan(next.middle.x - pinch.middle.x, next.middle.y - pinch.middle.y);
        deps.zoom(next.distance / pinch.distance, next.middle, false);
        pinch = next;
      } else if (press) {
        const dx = at.x - press.at.x;
        const dy = at.y - press.at.y;
        if (Math.hypot(dx, dy) > CLICK_SLOP) press.dragged = true;
        if (press.dragged) {
          deps.drag(press.camera, dx, dy);
          deps.cursor("grabbing");
        }
      }
      return;
    }
    deps.hover(at);
  };

  const up = (event: PointerInput) => {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size === 1) {
      // The finger left of a pinch drags on from where it is.
      pinch = null;
      pressFrom([...pointers.values()][0]!, true);
      return;
    }
    const wasDragged = press?.dragged ?? true;
    press = null;
    deps.cursor("");
    if (wasDragged) return;
    deps.click(screenPoint(event));
  };

  const cancel = (event: PointerInput) => {
    if (!pointers.delete(event.pointerId)) return;
    pinch = null;
    press = null;
    if (pointers.size === 1) pressFrom([...pointers.values()][0]!, true);
  };

  // A mouse wheel zooms by notches; a trackpad moves the map with two fingers and zooms it with a pinch (the wheel with
  // Ctrl). The device is told at the start of each gesture: a trackpad's slow first event can pass for a notch.
  let gesture: { device: WheelDevice; last: number } | null = null;
  const wheel = (event: WheelEventInput) => {
    if (!deps.onMap(event.target)) return;
    event.preventDefault();
    const nowMs = deps.now();
    const device = wheelDevice(event);
    if (!gesture || nowMs - gesture.last > WHEEL_GAP_MS) {
      gesture = { device, last: nowMs };
    } else {
      if (device === "trackpad") gesture.device = "trackpad";
      gesture.last = nowMs;
    }
    if (deps.paused(nowMs) || safariPinch || pointers.size) return;
    const action = wheelAction(event, gesture.device);
    if (action.kind === "pan") deps.pan(action.dx, action.dy);
    else deps.zoom(action.factor, screenPoint(event), action.notch);
  };

  // Safari tells a pinch on the trackpad by its own gesture events, with the scale since the pinch began.
  let safariPinch: { scale: number } | null = null;
  const gestureStart = (event: MapEventInput) => {
    if (!deps.onMap(event.target)) return;
    event.preventDefault();
    if (pointers.size >= 2) return;
    safariPinch = { scale: 1 };
    deps.stopGlide();
  };
  const gestureChange = (event: GestureInput) => {
    if (!deps.onMap(event.target)) return;
    event.preventDefault();
    const { scale } = event;
    if (!safariPinch || pointers.size >= 2 || !scale) return;
    const factor = scale / safariPinch.scale;
    safariPinch.scale = scale;
    deps.zoom(factor, screenPoint(event), false);
  };
  const gestureEnd = (event: MapEventInput) => {
    safariPinch = null;
    if (deps.onMap(event.target)) event.preventDefault();
  };

  const key = (event: KeyInput) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const viewport = deps.viewport();
    const middle = { x: viewport.width / 2, y: viewport.height / 2 };
    const step = Math.round(Math.min(viewport.width, viewport.height) * 0.15);
    switch (event.key) {
      case "+":
      case "=":
        deps.zoom(ZOOM_NOTCH, middle, true);
        break;
      case "-":
      case "_":
        deps.zoom(1 / ZOOM_NOTCH, middle, true);
        break;
      case "0":
        deps.fit();
        break;
      case "ArrowLeft":
        deps.pan(step, 0);
        break;
      case "ArrowRight":
        deps.pan(-step, 0);
        break;
      case "ArrowUp":
        deps.pan(0, step);
        break;
      case "ArrowDown":
        deps.pan(0, -step);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return { down, move, up, cancel, leave: deps.leave, wheel, gestureStart, gestureChange, gestureEnd, key };
}

/**
 * Hangs `input` on the canvas, for the pointer and the keys, and on the host, for the wheel and Safari's gestures over
 * the canvas and its labels. Returns what takes them off again.
 */
export function listen(canvas: HTMLElement, host: HTMLElement, input: Input): () => void {
  const onGestureChange = (event: Event) => input.gestureChange(event as Event & GestureInput);
  canvas.addEventListener("pointerdown", input.down);
  canvas.addEventListener("pointermove", input.move);
  canvas.addEventListener("pointerup", input.up);
  canvas.addEventListener("pointercancel", input.cancel);
  canvas.addEventListener("pointerleave", input.leave);
  canvas.addEventListener("keydown", input.key);
  host.addEventListener("wheel", input.wheel, { passive: false });
  host.addEventListener("gesturestart", input.gestureStart);
  host.addEventListener("gesturechange", onGestureChange);
  host.addEventListener("gestureend", input.gestureEnd);
  return () => {
    canvas.removeEventListener("pointerdown", input.down);
    canvas.removeEventListener("pointermove", input.move);
    canvas.removeEventListener("pointerup", input.up);
    canvas.removeEventListener("pointercancel", input.cancel);
    canvas.removeEventListener("pointerleave", input.leave);
    canvas.removeEventListener("keydown", input.key);
    host.removeEventListener("wheel", input.wheel);
    host.removeEventListener("gesturestart", input.gestureStart);
    host.removeEventListener("gesturechange", onGestureChange);
    host.removeEventListener("gestureend", input.gestureEnd);
  };
}
