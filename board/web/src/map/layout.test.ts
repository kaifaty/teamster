import { describe, expect, it } from "vitest";
import { MAX_ZOOM, clampCamera, fitCamera, freeView, zoomCamera } from "./layout";
import { layoutSurface } from "./surface/layout";
import type { SurfaceTask } from "./surface/types";

describe("camera", () => {
  const world = { width: 1600, height: 1000 };
  const view = { width: 800, height: 800 };
  const fit = fitCamera(world, view);

  it("fits and centres the world", () => {
    expect(fit).toEqual({ zoom: 0.5, tx: 0, ty: 150 });
  });

  it("zooms around the pointer and stays within its limits", () => {
    const at = { x: 400, y: 400 };
    const near = zoomCamera(fit, 2, at, fit);
    expect(near.zoom).toBe(1);
    const worldX = (at.x - fit.tx) / fit.zoom;
    expect(worldX * near.zoom + near.tx).toBeCloseTo(at.x);
    expect(zoomCamera(fit, 100, at, fit).zoom).toBe(fit.zoom * MAX_ZOOM);
    expect(zoomCamera(fit, 0.1, at, fit).zoom).toBe(fit.zoom);
  });

  it("never shows past the world's edge and centres a world smaller than the window", () => {
    const near = { zoom: 1, tx: 500, ty: -5000 };
    expect(clampCamera(near, world, view)).toEqual({ zoom: 1, tx: 0, ty: -200 });
    expect(clampCamera({ ...fit, ty: 999 }, world, view).ty).toBe(150);
  });

  it("fits the world into the part of the window no panel covers, and brings every edge of it there", () => {
    const free = freeView({ width: 1000, height: 800 }, { top: 40, right: 400, bottom: 60, left: 0 });
    expect(free).toEqual({ x: 0, y: 40, width: 600, height: 700 });
    const fitted = fitCamera(world, free);
    expect(fitted.zoom).toBe(600 / 1600);
    expect(fitted.tx).toBe(0);
    expect(fitted.ty).toBeCloseTo(40 + (700 - 1000 * fitted.zoom) / 2);
    // Zoomed in, the world's edges stop at the free part's edges, not under the panels.
    expect(clampCamera({ zoom: 1, tx: 500, ty: 900 }, world, free)).toEqual({ zoom: 1, tx: 0, ty: 40 });
    expect(clampCamera({ zoom: 1, tx: -5000, ty: -5000 }, world, free)).toEqual({ zoom: 1, tx: 600 - 1600, ty: 740 - 1000 });
    expect(clampCamera({ ...fitted, ty: 999 }, world, free)).toEqual(fitted);
  });

});

const trail: SurfaceTask = {
  id: "parent", project: "Gothic", title: "Trail", status: "active", parent_id: null, depends_on: [], pull_requests: [],
};

it("keeps country borders and buildings in place across status changes and reordered snapshots", () => {
  const child: SurfaceTask = { ...trail, id: "child", status: "needs_input", parent_id: trail.id, depends_on: [trail.id] };
  const sibling: SurfaceTask = { ...trail, id: "sibling", parent_id: trail.id };
  const other: SurfaceTask = { ...trail, id: "other", project: "TEAMSTER", status: "ready" };
  const cards: SurfaceTask[] = [other, child, trail, sibling, { ...child, id: "accepted", status: "done" }, { ...child, id: "dropped", status: "cancelled" }];
  const before = layoutSurface(cards);
  const after = layoutSurface([...cards].reverse().map(task => task === child ? { ...task, status: "blocked" } : task));
  expect([...after.sites.keys()]).toEqual([...before.sites.keys()]);
  expect(after.sites.size).toBe(4);
  expect(after.sites.get(trail.id)).toMatchObject({ accepted: 1, children: 3, dependents: [child.id] });
  for (const [id, { x, y }] of before.sites) expect(after.sites.get(id)).toMatchObject({ x, y });
  for (const [name, { outline, label }] of before.regions) expect(after.regions.get(name)).toMatchObject({ outline, label });
  expect(after.regions.get(trail.project)?.biome).toBe("forest");
  expect(after.regions.get(other.project)?.biome).toBe("volcanic");
});

it("grows and reclaims adjoining land with the current workload, including the last project", () => {
  function area(outline: string, edges?: Set<string>) {
    let sum = 0, x = 0, y = 0;
    for (const [, op, coords] of outline.matchAll(/([MLQ])([^MLQZ]+)/g)) {
      const [a, b, c, d] = coords!.split(" ").map(Number) as [number, number, number, number];
      const start = `${x} ${y}`;
      if (op === "Q") {
        // Signed area under a quadratic Bézier from (x,y) to (c,d) through control point (a,b).
        sum += (2 * (x * b - y * a + a * d - b * c) + x * d - y * c) / 3;
        x = c; y = d;
      } else {
        if (op === "L") sum += x * b - y * a;
        x = a; y = b;
      }
      if (edges && op !== "M") {
        const end = `${x} ${y}`, segment = op === "Q" ? ` Q${a} ${b} ` : " L ";
        // Remove each shared border when its neighbour traces the same curve backwards.
        if (!edges.delete(end + segment + start)) edges.add(start + segment + end);
      }
    }
    return sum / 2;
  }
  const tasks = [1, 4, 16].flatMap((count, project) => Array.from({ length: count }, (_, i) =>
    ({ ...trail, id: `${project}-${i}`, project: String(project) })));
  const overrides = { "0": "forest", "1": "forest", "2": "forest" };
  const initialSize = { ...layoutSurface(tasks.slice(0, 1)).world };
  const full = layoutSurface(tasks, overrides);
  expect(full.world.width).toBeGreaterThan(initialSize.width);
  expect(full.world.height).toBeGreaterThan(initialSize.height);
  const regions = [...full.regions.values()];
  expect(regions.map(r => r.sites.length)).toEqual([1, 4, 16]);
  expect(new Set(regions.flatMap(r => r.sites.map(s => `${s.x},${s.y}`))).size).toBe(21);
  for (const r of regions) {
    expect(r.biome).toBe("forest");
    expect(r.outline.match(/M/g)).toHaveLength(1);
  }
  const countryEdges = new Set<string>(), coastEdges = new Set<string>();
  const [small, medium, large] = regions.map(r => area(r.outline, countryEdges)) as [number, number, number];
  expect(medium).toBeGreaterThan(2 * small);
  expect(large).toBeGreaterThan(2 * medium);
  expect(full.coastline.match(/M/g)).toHaveLength(1);
  expect(small + medium + large).toBeCloseTo(area(full.coastline, coastEdges), 6);
  expect(countryEdges).toEqual(coastEdges);

  const less = tasks.map(task => task.id === "2-0" ? { ...task, status: "done" as const } : task);
  const closed = layoutSurface(less);
  expect(area(closed.regions.get("2")!.outline)).toBeLessThan(large);
  expect(area(closed.coastline)).toBeLessThan(area(full.coastline));
  const cancelled = layoutSurface(tasks.map(t => t.id === "2-0" ? { ...t, status: "cancelled" } : t));
  const removed = layoutSurface(tasks.filter(t => t.id !== "2-0"));
  expect(cancelled.regions.get("2")!.outline).toBe(removed.regions.get("2")!.outline);
  const last = layoutSurface(tasks.map(t => t.project === "0" ? t : { ...t, status: "cancelled" }));
  expect([...last.regions.keys()]).toEqual(["0"]);
  expect(last.world).toEqual(initialSize);
  expect(layoutSurface([{ ...trail, status: "done" }])).toMatchObject({ world: { width: 0, height: 0 }, coastline: "", regions: new Map(), sites: new Map() });
});
