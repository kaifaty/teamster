import { describe, expect, it } from "vitest";
import { PLACES } from "./placement";
import {
  MAX_ZOOM, ROUTE, STATIONS, SUN_RADIUS, backdropOf, cardPlace, clampCamera, depotPosition, fitCamera, LIGHT_SHIP, ringOf, ringPoint, ringsOf, skyChoices,
  RESEARCH_SIZE, LABEL_MAX_WIDTH, galaxyKeepOuts, galaxyLayout, limitZoom, logCorner, refitCamera, researchPosition, starFootprint, starLabelSize,
  starRadius, starSize, stationAt, systemFrame, worldSize, zoomCamera, type Rect, type StarShape,
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

  it("tells how far a zoom asked past its limits", () => {
    expect(limitZoom(fit.zoom, 2, fit)).toEqual({ zoom: fit.zoom * 2, past: 0 });
    const out = limitZoom(fit.zoom * 1.5, 0.5, fit);
    expect(out.zoom).toBe(fit.zoom);
    expect(out.past).toBeCloseTo(Math.log(0.75));
    const near = limitZoom(fit.zoom * MAX_ZOOM, 1.5, fit);
    expect(near.zoom).toBe(fit.zoom * MAX_ZOOM);
    expect(near.past).toBeCloseTo(Math.log(1.5));
  });

  it("keeps what the camera looked at when the window changes size", () => {
    const near = clampCamera(zoomCamera(fit, 2, { x: 600, y: 300 }, fit), world, view);
    const looked = { x: (view.width / 2 - near.tx) / near.zoom, y: (view.height / 2 - near.ty) / near.zoom };
    const wider = { width: 1200, height: 800 };
    const wideFit = fitCamera(world, wider);
    const moved = refitCamera(near, { fit, viewport: view }, wideFit, wider, world);
    expect(moved.zoom).toBeCloseTo(wideFit.zoom * 2);
    expect((wider.width / 2 - moved.tx) / moved.zoom).toBeCloseTo(looked.x);
    expect((wider.height / 2 - moved.ty) / moved.zoom).toBeCloseTo(looked.y);
    expect(refitCamera(fit, { fit, viewport: view }, wideFit, wider, world)).toEqual(wideFit);
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
  const quiet = (repo: string): StarShape => ({ repo, live: 0, attention: 0, ready: 0, sleeping: 0 });
  /** `count` stars, four in ten busy, a few with alarms: like a board. */
  const fleet = (count: number): StarShape[] =>
    Array.from({ length: count }, (_, i) => {
      const live = i % 5 < 2 ? 1 + ((i * 7) % 16) : 0;
      return { repo: `repo-${i}`, live, attention: live && i % 4 === 0 ? 1 + (i % 3) : 0, ready: live ? Math.floor(live / 2) : 0, sleeping: 0 };
    });
  const blockedFor = (world: { width: number; height: number }) => {
    const depots = [0, 1].flatMap((i) => [depotPosition(i, 2, "top", world), depotPosition(i, 2, "bottom", world)]);
    return galaxyKeepOuts(world, depots, [logCorner(world)]);
  };
  const hit = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  it("spreads a few stars wide and many densely, drawing a crowd smaller", () => {
    const blocked = blockedFor(size);
    const few = galaxyLayout(fleet(6), size, blocked);
    const some = galaxyLayout(fleet(34), size, blocked);
    const many = galaxyLayout(fleet(100), size, blocked);
    expect(few.spacing).toBeGreaterThan(some.spacing);
    expect(some.spacing).toBeGreaterThan(many.spacing);
    expect(few.scale).toBe(1);
    expect(many.scale).toBeLessThan(1);
    const xs = [...few.places.values()].map((point) => point.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(size.width * 0.4);
  });

  it("never lets two stars overlap, nor the station, the depots or the log", () => {
    for (const world of SIZES) {
      const blocked = blockedFor(world);
      for (const count of [1, 6, 15, 34, 60, 100]) {
        const stars = fleet(count);
        const galaxy = galaxyLayout(stars, world, blocked);
        expect(galaxy.places.size).toBe(count);
        const cores = stars.map((star) => {
          const at = galaxy.places.get(star.repo)!;
          const glow = starSize(star.live, galaxy) * 1.15 + 4;
          return { x0: at.x - glow, y0: at.y - glow, x1: at.x + glow, y1: at.y + glow };
        });
        cores.forEach((core, i) => {
          for (const other of [...cores.slice(i + 1), ...blocked]) expect(hit(core, other), `${count} stars in ${world.width}x${world.height}`).toBe(false);
        });
      }
    }
  });

  it("gives busy labels their room on a desktop galaxy, nearly all of them up to a few dozen stars", () => {
    const blocked = blockedFor(size);
    for (const count of [1, 6, 15]) {
      const stars = fleet(count);
      const galaxy = galaxyLayout(stars, size, blocked);
      expect(galaxy.crowded).toBe(0);
      const rooms = stars.map((star) => starFootprint(star, galaxy.places.get(star.repo)!, galaxy));
      rooms.forEach((room, i) => {
        for (const other of [...rooms.slice(i + 1), ...blocked]) expect(hit(room, other), `${count} stars`).toBe(false);
      });
    }
    for (const count of [25, 34]) {
      const stars = fleet(count);
      expect(galaxyLayout(stars, size, blocked).crowded).toBeLessThanOrEqual(Math.ceil(stars.filter((star) => star.live).length / 4));
    }
  });

  it("places every star of a galaxy fuller than its room, inside the world", () => {
    const galaxy = galaxyLayout(fleet(150), size, blockedFor(size));
    expect(galaxy.places.size).toBe(150);
    for (const point of galaxy.places.values()) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(size.width);
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(size.height);
    }
  });

  it("is the same every time, and keeps the stars in place when a repository comes", () => {
    const blocked = blockedFor(size);
    const stars = fleet(30);
    const before = galaxyLayout(stars, size, blocked);
    expect(galaxyLayout(stars, size, blocked).places).toEqual(before.places);
    const after = galaxyLayout([...stars, quiet("new-repo")], size, blocked, before);
    const kept = stars.filter((star) => before.places.get(star.repo)!.x === after.places.get(star.repo)!.x);
    expect(kept.length).toBeGreaterThanOrEqual(stars.length * 0.9);
  });

  it("keeps the stars in their places while a system gets busy", () => {
    const blocked = blockedFor(size);
    const stars = fleet(30);
    const before = galaxyLayout(stars, size, blocked);
    const busier = stars.map((star) => (star.repo === "repo-3" ? { ...star, live: 4, ready: 2 } : star));
    const after = galaxyLayout(busier, size, blocked, before);
    const kept = stars.filter((star) => star.repo !== "repo-3" && before.places.get(star.repo)!.x === after.places.get(star.repo)!.x);
    expect(kept.length).toBeGreaterThanOrEqual(stars.length - 3);
  });

  it("leaves the middle to the research station, with room for its label below", () => {
    for (const world of SIZES) {
      for (const count of [1, 6, 12, 25, 60, 120]) {
        const station = researchPosition(world);
        for (const point of galaxyLayout(fleet(count), world, blockedFor(world)).places.values()) {
          const dx = Math.abs(point.x - station.x);
          const dy = point.y - station.y;
          const clear = dx > RESEARCH_SIZE * 0.5 + 60 || dy < -(RESEARCH_SIZE * 0.5 + 60) || dy > RESEARCH_SIZE * 0.5 + 110;
          expect(clear, `${count} repositories, star at ${point.x},${point.y}`).toBe(true);
        }
      }
    }
  });

  it("starts the bottom row of depots right of the ship's log on a wide window", () => {
    expect(depotPosition(0, 2, "bottom", size).x).toBeGreaterThan(logCorner(size).x1);
    expect(depotPosition(0, 2, "top", size).x).toBeLessThan(logCorner(size).x1);
    const tall = { width: 1000, height: 1500 };
    expect(depotPosition(0, 2, "bottom", tall).x).toBe(depotPosition(0, 2, "top", tall).x);
  });

  it("sizes a busy label by its name and badges, and a quiet one by its name", () => {
    const plain = starLabelSize({ ...quiet("teamster"), live: 3 });
    const troubled = starLabelSize({ ...quiet("teamster"), live: 3, attention: 1, ready: 2 });
    expect(troubled.width).toBeGreaterThan(plain.width);
    expect(starLabelSize(quiet("teamster")).height).toBeLessThan(plain.height);
    expect(starLabelSize({ ...quiet("x".repeat(80)), live: 1 }).width).toBe(LABEL_MAX_WIDTH);
  });

  it("grows a star with its ships, up to a limit", () => {
    expect(starRadius(0)).toBeLessThan(starRadius(1));
    expect(starRadius(1)).toBeLessThan(starRadius(9));
    expect(starRadius(500)).toBe(46);
  });
});
