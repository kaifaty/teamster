import { describe, expect, it } from "vitest";
import type { Star } from "../fleet";
import { starSize, type Point } from "../layout";
import { galaxyAt, hoveredStar, starAt } from "./hits";
import type { GalaxyModel } from "./types";

const world = { width: 1600, height: 1000 };

const star = (repo: string, live = 4): Star => ({ repo, live, attention: 0, ready: 0, sleeping: 0, dots: [] });

function model(patch: Partial<GalaxyModel> & { places?: [string, Point][]; spacing?: number; scale?: number } = {}): GalaxyModel {
  const { places = [], spacing = 200, scale = 1, ...rest } = patch;
  return {
    stars: places.map(([repo]) => star(repo)),
    layout: { places: new Map(places), spacing, scale, labelZoom: 1, world, crowded: 0, groups: "" },
    constellations: [],
    ...rest,
  };
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

  it("takes a repository called research for a star, tells it on hover, and finds nothing between the stars", () => {
    const galaxy = model({ places: [["research", { x: 300, y: 300 }]] });
    const hit = galaxyAt(galaxy, { x: 300, y: 300 });
    expect(hit).toEqual({ kind: "star", repo: "research" });
    expect(hoveredStar(hit)).toBe("research");
    expect(galaxyAt(galaxy, { x: 1300, y: 800 })).toBeNull();
    expect(hoveredStar(null)).toBeNull();
  });
});
