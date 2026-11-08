import { describe, expect, it } from "vitest";
import { placeLabels, type StarLabel } from "./declutter";

const bounds = { x0: 0, y0: 0, x1: 800, y1: 600 };
const label = (id: string, x: number, y: number, fields: Partial<StarLabel> = {}): StarLabel => ({
  id,
  x,
  y,
  width: 120,
  height: 22,
  radius: 20,
  drop: 30,
  priority: 1,
  forced: false,
  solid: true,
  ...fields,
});

describe("star labels", () => {
  it("puts a label below its star when there is room", () => {
    expect(placeLabels([label("a", 400, 300)], [], bounds).get("a")).toEqual({ dx: -60, dy: 30 });
  });

  it("moves a label aside rather than over another, the more important one keeping its spot", () => {
    const spots = placeLabels([label("low", 400, 300), label("high", 400, 340, { priority: 5 })], [], bounds);
    expect(spots.get("high")).toEqual({ dx: -60, dy: 30 });
    expect(spots.get("low")).not.toEqual({ dx: -60, dy: 30 });
    expect(spots.get("low")).not.toBeNull();
  });

  it("keeps clear of the panels and inside the screen, and hides a label with no room", () => {
    const spots = placeLabels([label("edge", 790, 590)], [], bounds);
    const spot = spots.get("edge")!;
    expect(790 + spot.dx + 120).toBeLessThanOrEqual(800);
    expect(590 + spot.dy + 22).toBeLessThanOrEqual(600);
    const walled = placeLabels([label("walled", 400, 300)], [{ x0: 0, y0: 0, x1: 800, y1: 600 }], bounds);
    expect(walled.get("walled")).toBeNull();
  });

  it("always shows a forced label, and lets labels cover a quiet star but not a busy one", () => {
    const walls = [{ x0: 0, y0: 0, x1: 800, y1: 600 }];
    expect(placeLabels([label("alarm", 400, 300, { forced: true })], walls, bounds).get("alarm")).toEqual({ dx: -60, dy: 30 });
    // Every spot but the top ones under a panel, and those taken by a more important label: over that label, not the panel.
    const crowd = [label("first", 400, 300, { priority: 9, width: 400, solid: false }), label("alarm", 400, 300, { forced: true, solid: false })];
    const panel = [{ x0: 0, y0: 290, x1: 800, y1: 600 }];
    const spot = placeLabels(crowd, panel, bounds).get("alarm")!;
    expect(300 + spot.dy + 22).toBeLessThanOrEqual(290);
    const quiet = placeLabels([label("busy", 400, 300, { priority: 5 }), label("dot", 400, 340, { solid: false, priority: 0 })], [], bounds);
    expect(quiet.get("busy")).toEqual({ dx: -60, dy: 30 });
    const busy = placeLabels([label("busy", 400, 300, { priority: 5 }), label("other", 400, 340, { priority: 6 })], [], bounds);
    expect(busy.get("busy")).not.toEqual({ dx: -60, dy: 30 });
  });
});
