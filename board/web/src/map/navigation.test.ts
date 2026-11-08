import { describe, expect, it } from "vitest";
import { ZOOM_NOTCH, wheelAction, wheelDevice, type WheelInput } from "./navigation";

const wheel = (fields: Partial<WheelInput>): WheelInput => ({
  deltaMode: 0,
  deltaX: 0,
  deltaY: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...fields,
});

describe("wheel device", () => {
  it("tells a mouse wheel", () => {
    // Firefox in lines, Chrome on Windows, Chrome on macOS and Firefox without the legacy deltas.
    expect(wheelDevice(wheel({ deltaMode: 1, deltaY: 3 }))).toBe("mouse");
    expect(wheelDevice(wheel({ deltaY: 100, wheelDeltaY: -120 }))).toBe("mouse");
    expect(wheelDevice(wheel({ deltaY: -4.000244140625, wheelDeltaY: 120 }))).toBe("mouse");
    expect(wheelDevice(wheel({ deltaY: 4.000244140625 * 3 }))).toBe("mouse");
    expect(wheelDevice(wheel({ deltaY: 100 }))).toBe("mouse");
    // Shift turns the wheel sideways; the legacy delta still counts notches.
    expect(wheelDevice(wheel({ deltaX: 4.000244140625, wheelDeltaX: -120 }))).toBe("mouse");
  });

  it("tells a trackpad", () => {
    // Chrome and Safari on macOS, also with the page zoomed, and a trackpad without the legacy deltas.
    expect(wheelDevice(wheel({ deltaY: 3, wheelDeltaY: -9 }))).toBe("trackpad");
    expect(wheelDevice(wheel({ deltaX: -7, deltaY: 2, wheelDeltaX: 21, wheelDeltaY: -6 }))).toBe("trackpad");
    expect(wheelDevice(wheel({ deltaY: 2.5, wheelDeltaY: -8 }))).toBe("trackpad");
    expect(wheelDevice(wheel({ deltaY: 6.36, wheelDeltaY: -21 }))).toBe("trackpad");
    expect(wheelDevice(wheel({ deltaY: 7 }))).toBe("trackpad");
    expect(wheelDevice(wheel({ deltaX: 12, deltaY: 1 }))).toBe("trackpad");
  });
});

describe("wheel action", () => {
  it("zooms by a notch of the mouse wheel, more for a fast spin, and never past three", () => {
    expect(wheelAction(wheel({ deltaY: -100 }), "mouse")).toEqual({ kind: "zoom", factor: ZOOM_NOTCH, notch: true });
    expect(wheelAction(wheel({ deltaY: 4.000244140625 }), "mouse")).toEqual({ kind: "zoom", factor: 1 / ZOOM_NOTCH, notch: true });
    expect(wheelAction(wheel({ deltaMode: 1, deltaY: -3 }), "mouse")).toMatchObject({ factor: ZOOM_NOTCH ** 1.2 });
    expect(wheelAction(wheel({ deltaY: -2000 }), "mouse")).toMatchObject({ factor: ZOOM_NOTCH ** 3 });
  });

  it("moves the map sideways with Shift or a tilted mouse wheel", () => {
    expect(wheelAction(wheel({ deltaY: 100, shiftKey: true }), "mouse")).toEqual({ kind: "pan", dx: -90, dy: 0 });
    expect(wheelAction(wheel({ deltaX: -4.000244140625 }), "mouse")).toEqual({ kind: "pan", dx: 90, dy: 0 });
  });

  it("moves the map with two fingers on a trackpad, in every direction", () => {
    expect(wheelAction(wheel({ deltaX: 12, deltaY: -5 }), "trackpad")).toEqual({ kind: "pan", dx: -12, dy: 5 });
  });

  it("zooms with a pinch, by its size whatever the device, and by notches with Ctrl and the wheel", () => {
    const apart = wheelAction(wheel({ deltaY: -4, ctrlKey: true, wheelDeltaY: 120 }), "mouse");
    expect(apart).toMatchObject({ kind: "zoom", notch: false });
    expect(apart.kind === "zoom" && apart.factor).toBeCloseTo(Math.exp(0.04));
    const together = wheelAction(wheel({ deltaY: 2.5, ctrlKey: true }), "trackpad");
    expect(together.kind === "zoom" && together.factor).toBeCloseTo(Math.exp(-0.025));
    // One event counts no more than about a notch.
    const jump = wheelAction(wheel({ deltaY: -100, ctrlKey: true, wheelDeltaY: 120 }), "mouse");
    expect(jump).toMatchObject({ kind: "zoom", notch: true });
    expect(jump.kind === "zoom" && jump.factor).toBeCloseTo(Math.exp(0.25));
    expect(wheelAction(wheel({ deltaY: -4.000244140625, ctrlKey: true }), "mouse")).toEqual({ kind: "zoom", factor: ZOOM_NOTCH, notch: true });
    expect(wheelAction(wheel({ deltaMode: 1, deltaY: 3, metaKey: true }), "mouse")).toMatchObject({ factor: ZOOM_NOTCH ** -1.2 });
  });
});
