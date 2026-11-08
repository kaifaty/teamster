// How the map reads the wheel: whether an event came from a notched mouse wheel or from a trackpad, and what it
// asks of the camera. The mouse wheel zooms by notches; on a trackpad two fingers move the map and a pinch zooms it,
// which Chrome, Edge and Firefox send as the wheel with Ctrl held.

/** The fields of a WheelEvent the map reads; wheelDeltaX and wheelDeltaY are the legacy ones of Chrome and Safari. */
export interface WheelInput {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  wheelDeltaX?: number;
  wheelDeltaY?: number;
}

export type WheelDevice = "mouse" | "trackpad";

/** A zoom by notches glides to its goal; a pinch follows the fingers. */
export type WheelAction = { kind: "zoom"; factor: number; notch: boolean } | { kind: "pan"; dx: number; dy: number };

/** The zoom of one notch of the mouse wheel, and of one press of + or -. */
export const ZOOM_NOTCH = 1.25;
/**
 * The zoom of one pixel of a pinch, and the most pixels one event of it counts: about a notch, which is also what
 * Ctrl with a mouse wheel that reports 100 pixels a notch gives.
 */
const PINCH_ZOOM = 0.01;
const PINCH_LIMIT = 25;
/** Pixels the map moves sideways for one notch of the wheel with Shift. */
const NOTCH_PAN = 90;
const LINE_PIXELS = 40;
const PAGE_PIXELS = 800;
/** Chrome on macOS reports a notch of a mouse wheel as a multiple of this many pixels. */
const MAC_NOTCH = 4.000244140625;
/** A legacy delta of a mouse wheel is a multiple of this. */
const LEGACY_NOTCH = 120;

/** Which device a wheel event most likely came from. */
export function wheelDevice(event: WheelInput): WheelDevice {
  // deltaMode is read first: Firefox then reports a mouse wheel in lines.
  if (event.deltaMode !== 0) return "mouse";
  const { deltaX, deltaY } = event;
  const legacyX = event.wheelDeltaX ?? 0;
  const legacyY = event.wheelDeltaY ?? 0;
  if (legacyX || legacyY) {
    // Chrome and Safari give a trackpad's legacy delta as three times its pixels, and a mouse's as 120 a notch.
    if (Math.abs(legacyX + 3 * deltaX) < 1.5 && Math.abs(legacyY + 3 * deltaY) < 1.5) return "trackpad";
    return legacyX % LEGACY_NOTCH === 0 && legacyY % LEGACY_NOTCH === 0 ? "mouse" : "trackpad";
  }
  if (deltaX === 0 && macNotch(deltaY)) return "mouse";
  if (deltaX !== 0) return "trackpad";
  return Number.isInteger(deltaY) && Math.abs(deltaY) >= 50 ? "mouse" : "trackpad";
}

/** What a wheel event from `device` asks of the camera; a pan is in screen pixels the world moves. */
export function wheelAction(event: WheelInput, device: WheelDevice): WheelAction {
  const unit = event.deltaMode === 1 ? LINE_PIXELS : event.deltaMode === 2 ? PAGE_PIXELS : 1;
  const dx = event.deltaX * unit;
  const dy = event.deltaY * unit;
  if (event.ctrlKey || event.metaKey) {
    // A pinch is told by its size, not by the device: Chrome may give it the legacy delta of a notch.
    if (event.deltaMode !== 0 || macNotch(event.deltaY)) return { kind: "zoom", factor: ZOOM_NOTCH ** -notches(dy), notch: true };
    const factor = Math.exp(-Math.max(-PINCH_LIMIT, Math.min(PINCH_LIMIT, dy)) * PINCH_ZOOM);
    return { kind: "zoom", factor, notch: Math.abs(dy) >= PINCH_LIMIT };
  }
  if (device === "trackpad") return { kind: "pan", dx: -dx, dy: -dy };
  // A mouse: with Shift, or tilted, the wheel moves the map sideways.
  if (event.shiftKey || Math.abs(dx) > Math.abs(dy)) return { kind: "pan", dx: -notches(dx || dy) * NOTCH_PAN, dy: 0 };
  return { kind: "zoom", factor: ZOOM_NOTCH ** -notches(dy), notch: true };
}

function macNotch(delta: number): boolean {
  return delta !== 0 && Math.abs(delta) % MAC_NOTCH === 0;
}

/** Notches in a mouse wheel's delta, signed: one at least, three at most however fast the wheel spins. */
function notches(delta: number): number {
  if (delta === 0) return 0;
  return Math.sign(delta) * Math.min(3, Math.max(1, Math.abs(delta) / 100));
}
