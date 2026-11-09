import { describe, expect, it } from "vitest";
import type { Star } from "../fleet";
import { RESEARCH_SIZE, researchPosition, starSize, type FuelColumn, type MachineColumn, type Point } from "../layout";
import { galaxyAt, hoveredStar, machineAt, researchAt, starAt } from "./hits";
import type { GalaxyModel, ResearchMarks } from "./types";

const world = { width: 1600, height: 1000 };
const marks: ResearchMarks = { running: false, proposed: 0, waiting: 0, probes: [] };

const star = (repo: string, live = 4): Star => ({ repo, live, attention: 0, ready: 0, sleeping: 0, dots: [] });

function model(patch: Partial<GalaxyModel> & { places?: [string, Point][]; spacing?: number; scale?: number } = {}): GalaxyModel {
  const { places = [], spacing = 200, scale = 1, ...rest } = patch;
  return {
    stars: places.map(([repo]) => star(repo)),
    layout: { places: new Map(places), spacing, scale, labelZoom: 1, world, crowded: 0, groups: "" },
    tanks: [],
    fuel: null,
    constellations: [],
    research: null,
    machines: [],
    machineColumn: null,
    ...rest,
  };
}

function machines(at: Point, size = 200): Pick<GalaxyModel, "machines" | "machineColumn"> {
  const column: MachineColumn = { places: new Map([["m1", at]]), labels: new Map(), status: true, size, labelZoom: 1, right: at.x + size / 2, note: null };
  return { machines: [{ id: "m1", status: "free", rings: { cpu: null, memory: null, gpu: null, disk: null } }], machineColumn: column };
}

describe("what is under a point of the galaxy", () => {
  it("reaches a star within min(starSize·1.25 + 34·scale, spacing·0.5) of its centre", () => {
    for (const [spacing, scale] of [[200, 1], [100, 1], [400, 0.5]] as const) {
      const galaxy = model({ places: [["alpha", { x: 300, y: 300 }]], spacing, scale });
      const reach = Math.min(starSize(4, galaxy.layout) * 1.25 + 34 * scale, spacing * 0.5);
      expect(starAt(galaxy, { x: 300 + reach - 0.5, y: 300 })).toBe("alpha");
      expect(starAt(galaxy, { x: 300, y: 300 + reach + 0.5 })).toBeNull();
    }
  });

  it("catches the science station within RESEARCH_SIZE/2 of it, and nothing without research", () => {
    const center = researchPosition(world);
    const galaxy = model({ research: marks });
    expect(researchAt(galaxy, world, { x: center.x + RESEARCH_SIZE / 2 - 0.5, y: center.y })).toBe(true);
    expect(researchAt(galaxy, world, { x: center.x, y: center.y - RESEARCH_SIZE / 2 - 0.5 })).toBe(false);
    expect(researchAt(model(), world, center)).toBe(false);
    expect(galaxyAt(model(), world, center)).toBeNull();
  });

  it("catches a reactor within column.size/2 of it", () => {
    const galaxy = model(machines({ x: 1400, y: 300 }, 120));
    expect(machineAt(galaxy, { x: 1400 + 59.5, y: 300 })).toBe("m1");
    expect(machineAt(galaxy, { x: 1400, y: 300 - 60.5 })).toBeNull();
    expect(galaxyAt(galaxy, world, { x: 1400, y: 300 })).toEqual({ kind: "machine", id: "m1" });
    expect(galaxyAt(galaxy, world, { x: 1400, y: 300 }, false)).toBeNull();
  });

  it("picks a star before the station, and the station before a reactor", () => {
    const center = researchPosition(world);
    expect(galaxyAt(model({ research: marks, places: [["alpha", center]] }), world, center)).toEqual({ kind: "star", repo: "alpha" });

    // A tank pushes the station right, onto a reactor put where it lands.
    const fuel: FuelColumn = {
      places: new Map([["t1", { x: 700, y: 490 }]]),
      labels: new Map(),
      anchors: new Map([["t1", { x: 760, y: 490 }]]),
      row: false,
      size: 120,
      labelZoom: 1,
    };
    const landed = researchPosition(world, null, fuel);
    const galaxy = model({ research: marks, fuel, ...machines(landed) });
    expect(researchPosition(world, galaxy.machineColumn, fuel)).toEqual(landed);
    expect(machineAt(galaxy, landed)).toBe("m1");
    expect(galaxyAt(galaxy, world, landed)).toEqual({ kind: "research" });
  });

  it("takes a repository called research for a star, and tells it on hover", () => {
    const galaxy = model({ research: marks, places: [["research", { x: 300, y: 300 }]] });
    const hit = galaxyAt(galaxy, world, { x: 300, y: 300 });
    expect(hit).toEqual({ kind: "star", repo: "research" });
    expect(hoveredStar(hit)).toBe("research");
    expect(hoveredStar(galaxyAt(galaxy, world, researchPosition(world)))).toBeNull();
  });
});
