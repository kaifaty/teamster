import { describe, expect, it } from "vitest";
import { HULL_SIZE } from "./fleet";
import { PLACES } from "./placement";
import {
  COUNT_ROOM, MAX_ZOOM, ROUTE, STATIONS, SUN_RADIUS, backdropOf, clampCamera, depotPosition, fitCamera, freeView, parkingOf, parkingOrder,
  plateAt, plateRoom, skyChoices, stationOf, systemWorldSize,
  RESEARCH_SIZE, LABEL_MAX_WIDTH, galaxyKeepOuts, galaxyLayout, limitZoom, logCorner, refitCamera, researchPosition, starFootprint, starLabelSize,
  starRadius, starSize, stationAt, systemFrame, worldSize, zoomCamera, type Rect, type StarShape,
} from "./layout";

const SIZES = [
  { width: 1600, height: 1000 },
  { width: 1000, height: 1500 },
];

/** A system's worlds, from a window a little wider than tall to the widest, and a phone's. */
const SYSTEM_SIZES = [
  { width: 1500, height: 1000 },
  { width: 1750, height: 1000 },
  { width: 2400, height: 1000 },
  { width: 1000, height: 1250 },
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

  it("keeps the middle of the free part when a panel opens or closes", () => {
    const before = freeView({ width: 1000, height: 800 }, { top: 40, right: 0, bottom: 0, left: 0 });
    const after = freeView({ width: 1000, height: 800 }, { top: 40, right: 300, bottom: 0, left: 0 });
    const fitBefore = fitCamera(world, before);
    const fitAfter = fitCamera(world, after);
    expect(refitCamera(fitBefore, { fit: fitBefore, viewport: before }, fitAfter, after, world)).toEqual(fitAfter);
    const near = clampCamera(zoomCamera(fitBefore, 3, { x: 450, y: 420 }, fitBefore), world, before);
    // The middle of the free part: (500, 420) before the list opens, (350, 420) after.
    const looked = { x: (500 - near.tx) / near.zoom, y: (420 - near.ty) / near.zoom };
    const moved = refitCamera(near, { fit: fitBefore, viewport: before }, fitAfter, after, world);
    expect((350 - moved.tx) / moved.zoom).toBeCloseTo(looked.x);
    expect((420 - moved.ty) / moved.zoom).toBeCloseTo(looked.y);
  });

  it("shapes a system's world after the free part of the window", () => {
    expect(systemWorldSize({ width: 1700, height: 1000 })).toEqual({ width: 1700, height: 1000 });
    expect(systemWorldSize({ width: 900, height: 900 })).toEqual({ width: 1500, height: 1000 });
    expect(systemWorldSize({ width: 5000, height: 1000 })).toEqual({ width: 2400, height: 1000 });
    const phone = systemWorldSize({ width: 375, height: 420 });
    expect(phone.width).toBe(1000);
    expect(phone.height).toBeGreaterThan(phone.width);
    expect(systemWorldSize({ width: 300, height: 2000 }).height).toBe(1500);
  });
});

describe("system", () => {
  const frames = SYSTEM_SIZES.map((size) => ({ size, frame: systemFrame(size) }));
  const plateRect = (place: (typeof PLACES)[number], frame: ReturnType<typeof systemFrame>): Rect => {
    const plate = plateAt(place, frame);
    const room = plateRoom(frame);
    if (plate.side === "left") return { x0: plate.x - room.width, y0: plate.y - room.height / 2, x1: plate.x, y1: plate.y + room.height / 2 };
    const top = plate.side === "above" ? plate.y - room.height : plate.y;
    return { x0: plate.x - room.width / 2, y0: top, x1: plate.x + room.width / 2, y1: top + room.height };
  };

  it("keeps every station inside the picture, clear of the sun and of the others", () => {
    for (const { size, frame } of frames) {
      const discs = PLACES.map((place) => ({ ...stationAt(place, frame), r: stationOf(place, frame).radius }));
      for (const disc of discs) {
        expect(disc.x - disc.r).toBeGreaterThan(0);
        expect(disc.x + disc.r).toBeLessThan(size.width);
        expect(disc.y - disc.r).toBeGreaterThan(0);
        expect(disc.y + disc.r).toBeLessThan(size.height);
        expect(Math.hypot(disc.x - frame.cx, disc.y - frame.cy)).toBeGreaterThanOrEqual(SUN_RADIUS + disc.r);
      }
      discs.forEach((a, i) => discs.slice(i + 1).forEach((b) => expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r + 20)));
    }
  });

  it("brings the route closer to the sun at every step", () => {
    const orbits = ROUTE.map((place) => STATIONS[place].orbit);
    expect([...orbits].sort((x, y) => y - x)).toEqual(orbits);
    const frame = systemFrame(SYSTEM_SIZES[1]!);
    const last = stationAt(ROUTE[ROUTE.length - 1]!, frame);
    expect(Math.hypot(last.x - frame.cx, last.y - frame.cy)).toBeGreaterThan(SUN_RADIUS);
  });

  it("parks full stations clear of every station, the sun, the names, the world's edge and each other", () => {
    for (const { size, frame } of frames) {
      const ships: { x: number; y: number; r: number; place: string }[] = [];
      for (const place of PLACES) {
        const station = stationAt(place, frame);
        const hulls = place === "command" ? [HULL_SIZE.flagship] : [HULL_SIZE.cruiser, HULL_SIZE.light, HULL_SIZE.frigate];
        const sizes = Array.from({ length: 20 }, (_, slot) => hulls[slot % hulls.length]!);
        const { berths, count } = parkingOf(place, sizes, frame);
        const items = [...berths.map((berth, slot) => ({ ...berth, size: sizes[slot]! })), { ...count!.at, size: COUNT_ROOM }];
        for (const item of items) ships.push({ x: station.x + item.x, y: station.y + item.y, r: item.size * 0.4, place });
      }
      const where = (ship: (typeof ships)[number]) => `${size.width}x${size.height} ${ship.place} at ${Math.round(ship.x)},${Math.round(ship.y)}`;
      for (const ship of ships) {
        expect(ship.x - ship.r, where(ship)).toBeGreaterThanOrEqual(0);
        expect(ship.x + ship.r, where(ship)).toBeLessThanOrEqual(size.width);
        expect(ship.y - ship.r, where(ship)).toBeGreaterThanOrEqual(0);
        expect(ship.y + ship.r, where(ship)).toBeLessThanOrEqual(size.height);
        expect(Math.hypot(ship.x - frame.cx, ship.y - frame.cy), where(ship)).toBeGreaterThan(SUN_RADIUS * 1.3 + ship.r);
        for (const place of PLACES) {
          const station = stationAt(place, frame);
          expect(Math.hypot(ship.x - station.x, ship.y - station.y), `${where(ship)} near ${place}`).toBeGreaterThan(stationOf(place, frame).radius + ship.r);
          const plate = plateRect(place, frame);
          const covers = ship.x + ship.r > plate.x0 && ship.x - ship.r < plate.x1 && ship.y + ship.r > plate.y0 && ship.y - ship.r < plate.y1;
          expect(covers, `${where(ship)} over the name of ${place}`).toBe(false);
        }
      }
      ships.forEach((a, i) =>
        ships.slice(i + 1).forEach((b) => expect(Math.hypot(a.x - b.x, a.y - b.y), `${where(a)} and ${where(b)}`).toBeGreaterThan(a.r + b.r)),
      );
    }
  });

  it("gives every ship a berth while they fit, and the last berth to the count of the rest", () => {
    const frame = systemFrame(SYSTEM_SIZES[1]!);
    const { berths } = STATIONS.yard;
    const all = parkingOf("yard", Array.from({ length: berths }, () => HULL_SIZE.light), frame);
    expect(all.berths).toHaveLength(berths);
    expect(all.count).toBeNull();
    const crowded = parkingOf("yard", Array.from({ length: berths + 4 }, () => HULL_SIZE.light), frame);
    expect(crowded.berths).toHaveLength(berths - 1);
    expect(crowded.count!.ships).toBe(5);
    // The count stands at the far end, away from the station's name below it.
    expect(crowded.count!.at.y).toBeLessThan(Math.min(...crowded.berths.map((berth) => berth.y)) + 1);
    expect(parkingOf("yard", [], frame)).toEqual({ berths: [], count: null });
  });

  it("parks the ships in trouble first, then by arrival, and never stows the selected one", () => {
    const ships = Array.from({ length: 8 }, (_, slot) => ({ slug: `s${slot}`, beacon: slot === 5, slot }));
    const key = (ship: (typeof ships)[number]) => ship;
    expect(parkingOrder(ships, key, "range", null).map((ship) => ship.slug)).toEqual(["s5", "s0", "s1", "s2", "s3", "s4", "s6", "s7"]);
    const berths = STATIONS.range.berths;
    const order = parkingOrder(ships, key, "range", "s7").map((ship) => ship.slug);
    expect(order.indexOf("s7")).toBe(berths - 2);
    expect(order).toHaveLength(ships.length);
    // A selected ship that already has a berth keeps it.
    expect(parkingOrder(ships, key, "range", "s1").map((ship) => ship.slug)).toEqual(parkingOrder(ships, key, "range", null).map((ship) => ship.slug));
  });

  it("draws a phone's stations smaller and parks the yard's ships on its outer side", () => {
    const wide = systemFrame(SYSTEM_SIZES[1]!);
    const tall = systemFrame(SYSTEM_SIZES[3]!);
    expect(stationOf("yard", wide)).toBe(STATIONS.yard);
    expect(stationOf("yard", tall).radius).toBeLessThan(STATIONS.yard.radius);
    expect(parkingOf("yard", [HULL_SIZE.light], tall).berths[0]!.x).toBeLessThan(0);
    expect(parkingOf("yard", [HULL_SIZE.light], wide).berths[0]!.x).toBeGreaterThan(0);
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
