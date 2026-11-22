// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { nextTick, shallowRef } from "vue";
import { clampCamera, type Camera } from "./layout/camera";
import type { Point, Size } from "./layout/geometry";
import { ZOOM_NOTCH, wheelAction, wheelDevice, type WheelInput } from "./navigation";
import { layoutSurface, pickSurfaceSite } from "./surface/layout";
import type { SurfaceTask } from "./surface/types";
import { containSurfaceCamera, useSurfaceCamera } from "./surface/useSurfaceCamera";

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

it("keeps land visible after a long pan and every edge building reachable at detail zoom", async () => {
  const tasks: SurfaceTask[] = Array.from({ length: 240 }, (_, i) => ({
    id: String(i), project: i < 160 ? "core" : String(i % 19), title: "Task", status: "active", parent_id: null, depends_on: [], pull_requests: [],
  }));
  const atlas = layoutSurface(tasks);
  const zoom = 1.5;
  const visible = (site: Point, cam: Camera, view: Size) => {
    const x = site.x * cam.zoom + cam.tx, y = site.y * cam.zoom + cam.ty;
    return x >= 0 && y >= 0 && x <= view.width && y <= view.height;
  };
  for (const view of [{ width: 1280, height: 720 }, { width: 360, height: 560 }]) {
    for (const tx of [-1e8, 1e8]) {
      for (const ty of [-1e8, 1e8]) {
        const cam = containSurfaceCamera({ zoom, tx, ty }, atlas, view);
        expect(cam.zoom).toBe(zoom);
        expect([...atlas.sites.values()].some(site => visible(site, cam, view))).toBe(true);
        expect(clampCamera(cam, atlas.world, view)).toEqual(cam);
      }
    }
    for (const site of atlas.sites.values()) {
      const cam = containSurfaceCamera({ zoom, tx: view.width / 2 - site.x * zoom, ty: view.height / 2 - site.y * zoom }, atlas, view);
      expect(cam.zoom).toBe(zoom);
      expect(visible(site, cam, view)).toBe(true);
    }
  }
  const mounted = observeSurface(tasks);
  mounted.surface.focusTask(tasks[0]!.id);
  mounted.surface.zoomBy(zoom);
  mounted.field.dispatchEvent(new WheelEvent("wheel", { deltaX: -1e8, deltaY: -1e8 }));
  await nextFrame();
  const cam = mounted.surface.camera.value;
  expect(cam.zoom).toBe(zoom);
  expect([...atlas.sites.values()].some(site => visible(site, cam, mounted.view))).toBe(true);
  mounted.wrapper.unmount();

  const one = layoutSurface(tasks.slice(0, 1)), view = { width: 1200, height: 800 };
  expect(containSurfaceCamera({ zoom: 1, tx: -9000, ty: 7000 }, one, view)).toEqual({
    zoom: 1, tx: (view.width - one.world.width) / 2, ty: (view.height - one.world.height) / 2,
  });
});

function observeSurface(tasks: SurfaceTask[]) {
  const live = shallowRef(layoutSurface(tasks)), selected = shallowRef<string | null>(null);
  const view = { width: 360, height: 560 }, field = document.createElement("div");
  field.getBoundingClientRect = () => DOMRect.fromRect(view);
  let surface!: ReturnType<typeof useSurfaceCamera>;
  const wrapper = mount({
    setup() {
      surface = useSurfaceCamera(shallowRef(field), live, selected, () => {}, () => {});
      return () => null;
    },
  });
  return { field, live, selected, surface, view, wrapper };
}

const tasks: SurfaceTask[] = ["a", "b"].map(id => ({
  id, project: "A", title: id, status: "active", parent_id: null, depends_on: [], pull_requests: [],
}));
const extra = Array.from({ length: 24 }, (_, i) => ({ ...tasks[0]!, id: `extra-${i}`, project: "B" }));
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

it("pans between clearings in small steps and reclamps when the focused project disappears", async () => {
  const { field, live, surface, view, wrapper } = observeSurface(tasks);
  const pair = live.value;
  const [left, right] = [...pair.sites.values()].sort((a, b) => a.x - b.x);
  surface.focusTask(left!.task.id);
  surface.zoomBy(1.5);
  for (let i = 0; i < 30; i++) field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  await nextFrame();
  const rightX = right!.x * surface.camera.value.zoom + surface.camera.value.tx;
  expect(surface.camera.value.zoom).toBe(1.5);
  expect(rightX).toBeGreaterThanOrEqual(0);
  expect(rightX).toBeLessThan(view.width);

  live.value = layoutSurface([...tasks, ...extra]);
  await nextTick();
  const edge = live.value.regions.get("B")!.sites.reduce((a, b) => a.x > b.x ? a : b);
  surface.focusTask(edge.task.id);
  surface.zoomBy(1.5);
  await nextFrame();
  const before = surface.camera.value;
  live.value = pair;
  await nextTick();
  const after = surface.camera.value;
  expect(after).not.toEqual(before);
  expect(after.zoom).toBe(before.zoom);
  expect(after).toEqual(containSurfaceCamera(after, pair, view));
  wrapper.unmount();
});

it("refits a centred overview and keeps a visible selection in place during live growth", async () => {
  const { field, live, selected, surface, wrapper } = observeSurface(tasks);
  surface.zoomBy(ZOOM_NOTCH);
  surface.zoomBy(1 / ZOOM_NOTCH);
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  surface.zoomBy(1 / ZOOM_NOTCH);
  live.value = layoutSurface([...tasks, ...extra]);
  await nextTick();
  const afterGrowth = surface.camera.value;
  surface.home();
  expect(afterGrowth).toEqual(surface.camera.value);

  const id = extra[0]!.id;
  selected.value = id;
  surface.focusTask(id);
  // The selected building stays on screen while another building is closer to the centre.
  for (let i = 0; i < 3; i++) field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  await nextFrame();
  const position = () => {
    const site = live.value.sites.get(id)!, cam = surface.camera.value;
    return [site.x * cam.zoom + cam.tx, site.y * cam.zoom + cam.ty, cam.zoom];
  };
  const beforeGrowth = position();
  live.value = layoutSurface([...tasks, ...extra, { ...tasks[0]!, id: "c" }]);
  await nextTick();
  expect(position()).toEqual(beforeGrowth);
  wrapper.unmount();
});

it("picks visible art before overlapping touch padding, then the nearest building", () => {
  const size = { width: 100, height: 100 };
  const left = { id: "left", building: { x0: 32, x1: 42, y0: 48, y1: 56 }, priority: 0 };
  const right = { id: "right", building: { x0: 50, x1: 60, y0: 48, y1: 56 }, priority: 1 };
  const targets = [left, right];
  expect(pickSurfaceSite({ x: 41, y: 52 }, size, targets, true)).toBe("left");
  expect(pickSurfaceSite({ x: 45, y: 52 }, size, targets, true)).toBe("left");
  expect(pickSurfaceSite({ x: 48, y: 52 }, size, targets, true)).toBe("right");
  expect(pickSurfaceSite({ x: 45, y: 52 }, size, targets, true, left.building)).toBe("right");
});
