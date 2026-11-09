import { describe, expect, it } from "vitest";
import { ZOOM_NOTCH } from "../navigation";
import { CLICK_SLOP, WHEEL_GAP_MS, createInput, type InputDeps, type KeyInput, type WheelEventInput } from "./input";

/** The canvas starts at (10, 20) in the page; points in the tests are over the canvas. */
const ORIGIN = { x: 10, y: 20 };
const CAMERA = { zoom: 1, tx: 0, ty: 0 };

function setup() {
  const clock = { now: 1000 };
  const calls: unknown[][] = [];
  const deps: InputDeps = {
    now: () => clock.now,
    origin: () => ORIGIN,
    viewport: () => ({ width: 800, height: 600 }),
    onMap: (target) => target === "map",
    paused: () => false,
    camera: () => CAMERA,
    pan: (dx, dy) => calls.push(["pan", dx, dy]),
    drag: (from, dx, dy) => calls.push(["drag", from, dx, dy]),
    zoom: (factor, at, notch) => calls.push(["zoom", factor, at, notch]),
    fit: () => calls.push(["fit"]),
    stopGlide: () => {},
    click: (at) => calls.push(["click", at]),
    hover: (at) => calls.push(["hover", at]),
    leave: () => calls.push(["leave"]),
    capture: () => {},
    cursor: () => {},
  };
  return { input: createInput(deps), calls, clock };
}

const pointer = (pointerId: number, x: number, y: number) => ({ pointerId, button: 0, clientX: x + ORIGIN.x, clientY: y + ORIGIN.y });

function wheel(fields: Partial<WheelEventInput>): WheelEventInput & { prevented: boolean } {
  const event = {
    deltaMode: 0,
    deltaX: 0,
    deltaY: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    clientX: 300 + ORIGIN.x,
    clientY: 200 + ORIGIN.y,
    target: "map",
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    ...fields,
  };
  return event;
}

function key(name: string, modifiers: Partial<KeyInput> = {}): KeyInput & { prevented: boolean } {
  const event = {
    key: name,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    ...modifiers,
  };
  return event;
}

describe("the scene's input", () => {
  it("clicks where a press ends within CLICK_SLOP, and drags without a click further", () => {
    const near = setup();
    const step = (CLICK_SLOP - 1) / Math.SQRT2;
    near.input.down(pointer(1, 100, 100));
    near.input.move(pointer(1, 100 + step, 100 + step));
    near.input.up(pointer(1, 100 + step, 100 + step));
    expect(near.calls).toEqual([["click", { x: 100 + step, y: 100 + step }]]);

    const far = setup();
    far.input.down(pointer(1, 100, 100));
    far.input.move(pointer(1, 100 + CLICK_SLOP + 1, 100));
    far.input.up(pointer(1, 100 + CLICK_SLOP + 1, 100));
    expect(far.calls).toEqual([["drag", CAMERA, CLICK_SLOP + 1, 0]]);
  });

  it("pinches with two fingers around their middle, and drags on with the one left, without a click", () => {
    const { input, calls } = setup();
    input.down(pointer(1, 100, 100));
    input.down(pointer(2, 200, 100));
    expect(calls).toEqual([]);
    input.move(pointer(2, 300, 100));
    expect(calls).toEqual([
      ["pan", 50, 0],
      ["zoom", 2, { x: 200, y: 100 }, false],
    ]);
    calls.length = 0;
    input.up(pointer(2, 300, 100));
    input.move(pointer(1, 103, 100));
    input.up(pointer(1, 103, 100));
    expect(calls).toEqual([["drag", CAMERA, 3, 0]]);
  });

  it("zooms by a notch at the middle for + and -, fits for 0, pans for the arrows, and leaves keys with modifiers", () => {
    const { input, calls } = setup();
    const middle = { x: 400, y: 300 };
    const keys = ["+", "=", "-", "_", "0", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].map((name) => key(name));
    for (const event of keys) input.key(event);
    expect(keys.every((event) => event.prevented)).toBe(true);
    // 15% of the window's smaller side.
    expect(calls).toEqual([
      ["zoom", ZOOM_NOTCH, middle, true],
      ["zoom", ZOOM_NOTCH, middle, true],
      ["zoom", 1 / ZOOM_NOTCH, middle, true],
      ["zoom", 1 / ZOOM_NOTCH, middle, true],
      ["fit"],
      ["pan", 90, 0],
      ["pan", -90, 0],
      ["pan", 0, 90],
      ["pan", 0, -90],
    ]);
    calls.length = 0;
    const other = key("a");
    const held = [key("+", { altKey: true }), key("0", { ctrlKey: true }), key("ArrowLeft", { metaKey: true })];
    for (const event of [other, ...held]) input.key(event);
    expect(calls).toEqual([]);
    expect([other, ...held].some((event) => event.prevented)).toBe(false);
  });

  it("zooms by a notch for a mouse wheel, pans for a trackpad, pinches for the wheel with Ctrl, and leaves a wheel off the map", () => {
    const { input, calls, clock } = setup();
    const at = { x: 300, y: 200 };
    input.wheel(wheel({ deltaY: 100 }));
    clock.now += WHEEL_GAP_MS + 1;
    input.wheel(wheel({ deltaX: 1, deltaY: 3.5 }));
    clock.now += WHEEL_GAP_MS + 1;
    input.wheel(wheel({ deltaY: 10, ctrlKey: true }));
    expect(calls).toEqual([
      ["zoom", 1 / ZOOM_NOTCH, at, true],
      ["pan", -1, -3.5],
      ["zoom", Math.exp(-10 * 0.01), at, false],
    ]);
    calls.length = 0;
    const off = wheel({ deltaY: 100, target: "panel" });
    input.wheel(off);
    expect(calls).toEqual([]);
    expect(off.prevented).toBe(false);
  });

  it("ignores the wheel while Safari's pinch lasts", () => {
    const { input, calls } = setup();
    const map = { target: "map", preventDefault() {} };
    input.gestureStart(map);
    input.wheel(wheel({ deltaY: 100 }));
    input.gestureChange({ ...map, scale: 1.5, clientX: 300 + ORIGIN.x, clientY: 200 + ORIGIN.y });
    expect(calls).toEqual([["zoom", 1.5, { x: 300, y: 200 }, false]]);
    input.gestureEnd(map);
    input.wheel(wheel({ deltaY: 100 }));
    expect(calls.length).toBe(2);
  });
});
