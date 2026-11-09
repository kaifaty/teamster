import { describe, expect, it } from "vitest";
import { MAX_ZOOM, clampCamera, type Size } from "../layout";
import { ZOOM_NOTCH } from "../navigation";
import { ENTER_BEYOND, LEAVE_BEYOND, WHEEL_PAUSE_MS, createCamera } from "./camera";

function setup(options: { still?: boolean; star?: string | null; viewport?: Size } = {}) {
  const clock = { now: 1000, flying: false };
  const events: string[] = [];
  const asked: { x: number; y: number }[] = [];
  const camera = createCamera(options.viewport ?? { width: 1600, height: 1000 }, {
    still: options.still ?? false,
    now: () => clock.now,
    flying: () => clock.flying,
    starAt: (point) => {
      asked.push(point);
      return options.star ?? null;
    },
    onEnter: (repo) => events.push(`enter ${repo}`),
    onLeave: () => events.push("leave"),
    onCamera: () => {},
  });
  const middle = { x: camera.viewport.width / 2, y: camera.viewport.height / 2 };
  return { camera, clock, events, asked, middle };
}

describe("the scene's camera", () => {
  it("stops a pan at the edge of the world as clampCamera does", () => {
    const { camera, middle } = setup();
    camera.panBy(500, 0);
    expect(camera.view()).toEqual(camera.fit);
    camera.zoomBy(2, middle, false);
    const before = camera.view();
    camera.panBy(10000, -10000);
    expect(camera.view()).toEqual(clampCamera({ ...before, tx: before.tx + 10000, ty: before.ty - 10000 }, camera.world, camera.viewport));
    expect(camera.view().tx).toBeLessThan(before.tx + 10000);
  });

  it("glides a notch of the wheel to its goal over several steps, and lands it at once with reduced motion", () => {
    const { camera, middle } = setup();
    const goal = camera.fit.zoom * ZOOM_NOTCH;
    camera.zoomBy(ZOOM_NOTCH, middle, true);
    expect(camera.view().zoom).toBe(camera.fit.zoom);
    camera.step(1 / 60);
    const first = camera.view().zoom;
    expect(first).toBeGreaterThan(camera.fit.zoom);
    expect(first).toBeLessThan(goal);
    for (let i = 0; i < 60; i++) camera.step(1 / 60);
    expect(camera.view().zoom).toBeCloseTo(goal, 9);

    const still = setup({ still: true });
    still.camera.zoomBy(ZOOM_NOTCH, still.middle, true);
    expect(still.camera.view().zoom).toBeCloseTo(still.camera.fit.zoom * ZOOM_NOTCH, 9);
  });

  it("ignores the zoom during the flight", () => {
    const { camera, clock, middle } = setup({ still: true });
    clock.flying = true;
    camera.zoomBy(2, middle, false);
    camera.zoomBy(ZOOM_NOTCH, middle, true);
    expect(camera.view()).toEqual(camera.fit);
  });

  it("leaves a system once for a zoom out past its fitted view, then ignores the zoom for the pause", () => {
    const { camera, clock, events, middle } = setup({ still: true });
    camera.show(true);
    camera.zoomBy(Math.exp(-LEAVE_BEYOND.notch + 0.01), middle, true);
    expect(events).toEqual([]);
    camera.show(true);
    camera.zoomBy(Math.exp(-LEAVE_BEYOND.notch - 0.001), middle, true);
    camera.zoomBy(1 / ZOOM_NOTCH, middle, true);
    expect(events).toEqual(["leave"]);
    clock.now += WHEEL_PAUSE_MS - 1;
    expect(camera.paused(clock.now)).toBe(true);
    camera.zoomBy(2, middle, false);
    expect(camera.view()).toEqual(camera.systemFit);
    clock.now += 1;
    expect(camera.paused(clock.now)).toBe(false);
    camera.zoomBy(2, middle, false);
    expect(camera.view().zoom).toBeCloseTo(camera.systemFit.zoom * 2, 9);
  });

  it("enters the star under a zoom in past the closest galaxy, and nothing elsewhere", () => {
    const over = setup({ still: true, star: "alpha" });
    over.camera.zoomBy(MAX_ZOOM, over.middle, false);
    expect(over.events).toEqual([]);
    over.camera.zoomBy(Math.exp(ENTER_BEYOND.notch + 0.001), over.middle, true);
    expect(over.events).toEqual(["enter alpha"]);
    expect(over.asked.at(-1)).toEqual(over.camera.worldPoint(over.middle));
    expect(over.camera.paused(over.clock.now)).toBe(true);

    const empty = setup({ still: true, star: null });
    empty.camera.zoomBy(MAX_ZOOM, empty.middle, false);
    empty.camera.zoomBy(Math.exp(ENTER_BEYOND.notch + 0.001), empty.middle, true);
    expect(empty.events).toEqual([]);
    expect(empty.camera.paused(empty.clock.now)).toBe(false);
    expect(empty.camera.view().zoom).toBeCloseTo(empty.camera.fit.zoom * MAX_ZOOM, 9);
  });

  it("keeps the point looked at in a new window of the same world, and shows a world of another shape whole", () => {
    const { camera, middle } = setup({ still: true });
    camera.zoomBy(2, { x: middle.x + 100, y: middle.y - 50 }, false);
    const looked = camera.worldPoint(middle);
    camera.layoutGalaxy({ width: 1200, height: 900 });
    expect(camera.worldPoint({ x: 600, y: 450 }).x).toBeCloseTo(looked.x, 6);
    expect(camera.worldPoint({ x: 600, y: 450 }).y).toBeCloseTo(looked.y, 6);
    expect(camera.view().zoom).toBeCloseTo(camera.fit.zoom * 2, 9);
    camera.layoutGalaxy({ width: 800, height: 1200 });
    expect(camera.world).toEqual({ width: 1000, height: 1500 });
    expect(camera.view()).toEqual(camera.fit);
  });

  it("goes back to the fitted view and drops a glide on its way", () => {
    const { camera, middle } = setup();
    camera.zoomBy(2, middle, false);
    camera.zoomBy(ZOOM_NOTCH, middle, true);
    camera.fitView();
    camera.step(1 / 60);
    expect(camera.view()).toEqual(camera.fit);
  });
});
