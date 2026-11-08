import { describe, expect, it } from "vitest";
import { PLACES } from "./placement";
import {
  MAX_ZOOM, ROUTE, STATIONS, SUN_RADIUS, backdropOf, cardPlace, clampCamera, depotPosition, fitCamera, LIGHT_SHIP, ringOf, ringPoint, ringsOf, skyChoices,
  RESEARCH_SIZE, researchPosition, starPositions, starRadius, stationAt, systemFrame, worldSize, zoomCamera,
} from "./layout";

const SIZES = [
  { width: 1600, height: 1000 },
  { width: 1000, height: 1500 },
];

describe("skyChoices", () => {
  const backdrops = ["a.jpg", "b.jpg", "c.jpg"];
  const shared = backdrops[backdropOf("teamster", backdrops.length)!]!;

  it("tries the repository's own sky first and keeps its shared one to fall back on", () => {
    expect(skyChoices("teamster", "/api/art/teamster/sky.jpg", backdrops)).toEqual(["/api/art/teamster/sky.jpg", shared]);
  });

  it("gives a repository without its own sky the shared one", () => {
    expect(skyChoices("teamster", undefined, backdrops)).toEqual([shared]);
  });

  it("works with no shared skies at all", () => {
    expect(skyChoices("teamster", undefined, [])).toEqual([]);
    expect(skyChoices("teamster", "own.jpg", [])).toEqual(["own.jpg"]);
  });
});

describe("backdropOf", () => {
  it("keeps a repository's sky and spreads repositories over the skies", () => {
    expect(backdropOf("teamster", 10)).toBe(backdropOf("teamster", 10));
    const repos = Array.from({ length: 40 }, (_, i) => `repo-${i}`);
    const skies = new Set(repos.map((repo) => backdropOf(repo, 10)));
    expect(skies.size).toBeGreaterThan(6);
    for (const sky of skies) {
      expect(sky).toBeGreaterThanOrEqual(0);
      expect(sky).toBeLessThan(10);
    }
  });

  it("has no sky to give when there are none", () => {
    expect(backdropOf("teamster", 0)).toBeNull();
  });
});

describe("camera", () => {
  const world = { width: 1600, height: 1000 };
  const view = { width: 800, height: 800 };
  const fit = fitCamera(world, view);

  it("fits and centres the world, and picks the shape of the world from the window", () => {
    expect(fit).toEqual({ zoom: 0.5, tx: 0, ty: 150 });
    expect(worldSize({ width: 1400, height: 800 }).width).toBeGreaterThan(worldSize({ width: 1400, height: 800 }).height);
    expect(worldSize({ width: 375, height: 800 }).width).toBeLessThan(worldSize({ width: 375, height: 800 }).height);
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
});

describe("system", () => {
  it("keeps every station inside the picture and apart from the others", () => {
    for (const size of SIZES) {
      const frame = systemFrame(size);
      const points = PLACES.map((place) => stationAt(place, frame));
      for (const point of points) {
        expect(point.x).toBeGreaterThan(0);
        expect(point.x).toBeLessThan(size.width);
        expect(point.y).toBeGreaterThan(0);
        expect(point.y).toBeLessThan(size.height);
      }
      points.forEach((a, i) => points.slice(i + 1).forEach((b) => expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(120)));
    }
  });

  it("keeps stations clear of the sun on a narrow screen too", () => {
    for (const size of SIZES) {
      const frame = systemFrame(size);
      for (const place of PLACES) {
        const point = stationAt(place, frame);
        expect(Math.hypot(point.x - frame.cx, point.y - frame.cy)).toBeGreaterThanOrEqual(SUN_RADIUS + STATIONS[place].radius);
      }
    }
  });

  it("brings the route closer to the sun at every step", () => {
    const orbits = ROUTE.map((place) => STATIONS[place].orbit);
    expect([...orbits].sort((x, y) => y - x)).toEqual(orbits);
    const frame = systemFrame(SIZES[0]!);
    const last = stationAt(ROUTE[ROUTE.length - 1]!, frame);
    expect(Math.hypot(last.x - frame.cx, last.y - frame.cy)).toBeGreaterThan(SUN_RADIUS);
  });

  it("gives every ship of a crowded station its own point", () => {
    const station = { x: 500, y: 500 };
    const points = Array.from({ length: 40 }, (_, slot) => {
      const { radius, angle } = ringOf("yard", slot);
      return ringPoint(station, radius, angle);
    });
    points.forEach((a, i) => points.slice(i + 1).forEach((b) => expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(40)));
  });

  it("keeps frigates and cruisers apart from each other and from the station", () => {
    const station = { x: 500, y: 500 };
    for (const place of PLACES) {
      const sizes = Array.from({ length: 30 }, (_, slot) => [LIGHT_SHIP, 92, 114][slot % 3]!);
      const ships = ringsOf(place, sizes).map(({ radius, angle }, slot) => ({ ...ringPoint(station, radius, angle), size: sizes[slot]! }));
      ships.forEach((a, i) => {
        expect(Math.hypot(a.x - station.x, (a.y - station.y) / 0.75)).toBeGreaterThan(STATIONS[place].radius + a.size * 0.4);
        ships.slice(i + 1).forEach((b) => expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(((a.size + b.size) / 2) * 0.8));
      });
    }
  });

  it("keeps a station's card clear of its ships and a long card inside the world", () => {
    const tallCard = 230;
    for (const size of SIZES) {
      const frame = systemFrame(size);
      for (const place of PLACES) {
        const card = cardPlace(place, frame);
        const { radius, angle } = ringOf(place, 2);
        const ship = ringPoint(stationAt(place, frame), radius, angle);
        if (card.side) expect(card.x).toBeGreaterThan(stationAt(place, frame).x + radius);
        else expect(card.y).toBeGreaterThan(ship.y);
      }
      expect(cardPlace("command", frame).y + tallCard).toBeLessThanOrEqual(size.height);
    }
  });
});

describe("galaxy", () => {
  const size = { width: 1600, height: 1000 };

  it("keeps stars apart, away from the depot rows and in place when another repository appears", () => {
    const repos = ["teamster", "demo-game", "demo-shop", "ml-lab", "demo-vault", "(no folder)"];
    const before = starPositions(repos, size);
    const points = [...before.values()];
    expect(points).toHaveLength(repos.length);
    points.forEach((a, i) => points.slice(i + 1).forEach((b) => expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(120)));
    for (const point of points) {
      expect(point.y).toBeGreaterThan(depotPosition(0, 1, "top", size).y + 60);
      expect(point.y).toBeLessThan(depotPosition(0, 1, "bottom", size).y - 60);
    }
    const after = starPositions([...repos, "new-repo"], size);
    expect(repos.filter((repo) => after.get(repo)!.x === before.get(repo)!.x).length).toBeGreaterThanOrEqual(repos.length - 1);
  });

  it("handles more repositories than any grid has cells", () => {
    const repos = Array.from({ length: 120 }, (_, i) => `repo-${i}`);
    expect(starPositions(repos, size).size).toBe(120);
  });

  it("leaves the middle to the research station, with room for its label below", () => {
    for (const world of SIZES) {
      for (const count of [1, 6, 12, 25, 60, 120]) {
        const repos = Array.from({ length: count }, (_, i) => `repo-${i}`);
        const station = researchPosition(world);
        for (const point of starPositions(repos, world).values()) {
          const dx = Math.abs(point.x - station.x);
          const dy = point.y - station.y;
          const clear = dx > RESEARCH_SIZE * 0.5 + 60 || dy < -(RESEARCH_SIZE * 0.5 + 60) || dy > RESEARCH_SIZE * 0.5 + 110;
          expect(clear, `${count} repositories, star at ${point.x},${point.y}`).toBe(true);
        }
      }
    }
  });

  it("grows a star with its ships, up to a limit", () => {
    expect(starRadius(0)).toBeLessThan(starRadius(1));
    expect(starRadius(1)).toBeLessThan(starRadius(9));
    expect(starRadius(500)).toBe(46);
  });
});
