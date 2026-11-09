import { describe, expect, it } from "vitest";
import { HULL_SIZE } from "./fleet";
import { PLACES } from "./placement";
import {
  CHECKPOINT, COUNT_ROOM, MAX_ZOOM, ROUTE, inCheckpoint, lanesOf, STATIONS, SUN_RADIUS, backdropOf, clampCamera, defaultCovered, fitCamera, freeView, parkingOf, parkingOrder,
  homeWorld, plateAt, plateRoom, skyChoices, stationOf, systemWorldSize, toolbarBand, columnSpan,
  TANK_ASPECT, TANK_MIN_SIZE, TANK_SIZE, BADGE_RISE, fuelColumnRect, fuelPositions, fuelRoom, tankGear, tankLabelSize, type TankShape,
  RESEARCH_SIZE, LABEL_MAX_WIDTH, MACHINE_LABEL_WIDTH_PX, MACHINE_MIN_SIZE, MACHINE_SIZE, machineColumnRect, machineLabelAnchor, machinePositions, machineRoom, machineRooms, galaxyKeepOuts, galaxyLayout, limitZoom, logCorner, refitCamera, researchPosition, starFootprint, starLabelSize,
  starRadius, starSize, stationAt, systemFrame, worldSize, zoomCamera, LABEL_ZOOM as LABEL_ZOOM_FULL, type Rect, type StarShape,
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
      const ships: { x: number; y: number; r: number; place: string; lane: boolean }[] = [];
      for (const place of PLACES) {
        const station = stationAt(place, frame);
        const hulls = place === "command" ? [HULL_SIZE.flagship] : [HULL_SIZE.cruiser, HULL_SIZE.light, HULL_SIZE.frigate];
        const sizes = Array.from({ length: 20 }, (_, slot) => hulls[slot % hulls.length]!);
        const { berths, count } = parkingOf(place, sizes, frame);
        const lanes = place === "inspection" ? lanesOf(frame).length : 0;
        const items = [...berths.map((berth, slot) => ({ ...berth, size: sizes[slot]!, lane: slot < lanes })), { ...count!.at, size: COUNT_ROOM, lane: false }];
        for (const item of items) ships.push({ x: station.x + item.x, y: station.y + item.y, r: item.size * 0.4, place, lane: item.lane });
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
          if (ship.lane && place === ship.place) {
            // A ship in a lane of the checkpoint stands inside its open middle, between the scanners.
            const radius = stationOf(place, frame).radius;
            expect(Math.abs(ship.x - station.x) + ship.r, `${where(ship)} across the frame`).toBeLessThanOrEqual(radius * CHECKPOINT.inside.x);
            expect(Math.abs(ship.y - station.y) + ship.r, `${where(ship)} along the frame`).toBeLessThanOrEqual(radius * CHECKPOINT.inside.y);
            continue;
          }
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

  it("puts the home world at the left edge, its limb behind the yard's dock, clear of the other stations and their ships", () => {
    for (const { size, frame } of frames) {
      const home = homeWorld(frame);
      const yard = stationAt("yard", frame);
      const dock = stationOf("yard", frame).radius;
      expect(home.x, `${size.width}x${size.height}`).toBeLessThan(0);
      expect(home.x + home.radius).toBeGreaterThan(yard.x - dock);
      expect(home.x + home.radius).toBeLessThan(yard.x + dock);
      for (const place of PLACES.filter((name) => name !== "yard")) {
        const station = stationAt(place, frame);
        const radius = stationOf(place, frame).radius;
        expect(Math.hypot(station.x - home.x, station.y - home.y), place).toBeGreaterThan(home.radius + radius);
        const sizes = Array.from({ length: 20 }, () => HULL_SIZE.cruiser);
        const { berths, count } = parkingOf(place, sizes, frame);
        for (const berth of [...berths, count!.at]) {
          const ship = { x: station.x + berth.x, y: station.y + berth.y };
          expect(Math.hypot(ship.x - home.x, ship.y - home.y), `${place} ship`).toBeGreaterThan(home.radius + HULL_SIZE.cruiser * 0.4);
        }
      }
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
    // The arc runs from the station's name below it to the count at its far end.
    expect(crowded.count!.at.y).toBeLessThan(crowded.berths[0]!.y);
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

  it("stands the ships under review in the checkpoint's lanes and queues the rest before its entrance", () => {
    const wide = systemFrame(SYSTEM_SIZES[1]!);
    const tall = systemFrame(SYSTEM_SIZES[3]!);
    expect(lanesOf(wide)).toHaveLength(3);
    expect(lanesOf(tall)).toHaveLength(2);
    const lanes = lanesOf(wide);
    // One above another through the middle of the frame, top first.
    expect(lanes.every((lane) => lane.x === 0)).toBe(true);
    expect(lanes.map((lane) => lane.y)).toEqual(lanes.map((lane) => lane.y).sort((a, b) => a - b));
    expect(parkingOf("inspection", [HULL_SIZE.light, HULL_SIZE.cruiser], wide)).toEqual({ berths: lanes.slice(0, 2), count: null });
    const { berths, radius } = STATIONS.inspection;
    const crowded = parkingOf("inspection", Array.from({ length: berths + 3 }, () => HULL_SIZE.light), wide);
    expect(crowded.berths.slice(0, lanes.length)).toEqual(lanes);
    expect(crowded.berths).toHaveLength(berths - 1);
    expect(crowded.count!.ships).toBe(4);
    for (const berth of [...crowded.berths.slice(lanes.length), crowded.count!.at]) expect(berth.x).toBeLessThan(-radius);
    // The routes hide inside the frame: its lanes are in it, the queue and the masts' tips are not.
    const station = stationAt("inspection", wide);
    const at = (point: { x: number; y: number }) => ({ x: station.x + point.x, y: station.y + point.y });
    expect(lanes.every((lane) => inCheckpoint(at(lane), wide))).toBe(true);
    expect(crowded.berths.slice(lanes.length).some((berth) => inCheckpoint(at(berth), wide))).toBe(false);
    expect(inCheckpoint(at({ x: 0, y: -radius }), wide)).toBe(false);
  });

  it("gives the checkpoint's lanes to the ships under review first, ahead of a ship in trouble", () => {
    const ships = [
      { slug: "trouble", beacon: true, slot: 0, placeWorking: false },
      { slug: "reviewed", beacon: false, slot: 1, placeWorking: true },
      { slug: "stopped", beacon: false, slot: 2, placeWorking: false },
    ];
    expect(parkingOrder(ships, (ship) => ship, "inspection", null).map((ship) => ship.slug)).toEqual(["reviewed", "trouble", "stopped"]);
    expect(parkingOrder(ships, (ship) => ship, "range", null).map((ship) => ship.slug)).toEqual(["trouble", "reviewed", "stopped"]);
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
  const blockedFor = (world: { width: number; height: number }) => galaxyKeepOuts(world, defaultCovered(world));
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

  it("never lets two stars overlap, nor the station, the toolbar or the log", () => {
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

  it("leaves the middle to the science station, with room for its label below", () => {
    for (const world of SIZES) {
      for (const count of [1, 6, 12, 25, 60, 120]) {
        const station = researchPosition(world);
        for (const point of galaxyLayout(fleet(count), world, blockedFor(world)).places.values()) {
          const dx = Math.abs(point.x - station.x);
          const dy = point.y - station.y;
          // Below the station its label, down to the keep-out's bottom edge.
          const clear = dx > RESEARCH_SIZE * 0.5 + 60 || dy < -(RESEARCH_SIZE * 0.5 + 60) || dy > RESEARCH_SIZE * 0.5 + 85;
          expect(clear, `${count} repositories, star at ${point.x},${point.y}`).toBe(true);
        }
      }
    }
  });

  it("gives a column the height between what covers the top edge and the bottom edge over it", () => {
    const covered = defaultCovered(size);
    expect(columnSpan(size, covered, 0, 200)).toEqual({ top: toolbarBand(size).y1 + 12, bottom: logCorner(size).y0 - 12 });
    expect(columnSpan(size, covered, size.width - 200, size.width)).toEqual({ top: toolbarBand(size).y1 + 12, bottom: size.height - 20 });
    expect(columnSpan(size, [], 0, 200)).toEqual({ top: 20, bottom: size.height - 20 });
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

describe("machines", () => {
  /** The fixture's machines, with the statuses their labels show. */
  const FIXTURE = [
    { id: "lapka", name: "lapka", status: "перегружена: память, GPU" },
    { id: "kedr", name: "kedr", status: "свободна" },
    { id: "sosna", name: "sosna", status: "занята: видеопамять" },
    { id: "olha", name: "olha", status: "нет связи: не отвечает" },
    { id: "yasen", name: "yasen", status: "нет данных" },
  ];
  const machines = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `machine-${i}`, name: `machine-${i}`, status: "занята: видеопамять" }));
  const [WIDE, TALL] = SIZES as [{ width: number; height: number }, { width: number; height: number }];
  /** The full view's zoom of a 1400×900 window and of a 390×844 phone, and others around them. */
  const ZOOMS = new Map([[WIDE, [0.75, 0.855, 0.9]], [TALL, [0.39, 0.5]]]);
  const hit = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  /** The reactor with its rings: as tall as it is wide. */
  const body = (at: { x: number; y: number }, size: number): Rect => ({ x0: at.x - size / 2, y0: at.y - size / 2, x1: at.x + size / 2, y1: at.y + size / 2 });

  it("is the same every time, keeps the order and stands in one column along the right edge", () => {
    for (const world of SIZES) {
      const column = machinePositions(FIXTURE, world);
      expect(machinePositions(FIXTURE, world)).toEqual(column);
      const points = [...column.places.values()];
      expect([...column.places.keys()]).toEqual(FIXTURE.map((machine) => machine.id));
      expect(new Set(points.map((point) => point.x)).size).toBe(1);
      expect(points[0]!.x + column.size / 2).toBeLessThanOrEqual(world.width);
      expect(points[0]!.x).toBeGreaterThan(world.width * 0.85);
      points.slice(1).forEach((point, i) => expect(point.y).toBeGreaterThan(points[i]!.y));
    }
  });

  it("draws the stations larger on a phone, and smaller in a long column down to its least size", () => {
    expect(machinePositions(machines(1), WIDE).size).toBe(MACHINE_SIZE.wide);
    expect(machinePositions(machines(1), TALL).size).toBe(MACHINE_SIZE.tall);
    expect(machinePositions(machines(16), WIDE).size).toBe(MACHINE_MIN_SIZE);
    // The fixture's five machines in the full view: at least 80 pixels on a 1400×900 window, 48 on a 390×844 phone.
    expect(machinePositions(FIXTURE, WIDE, 0.855).size * 0.855).toBeGreaterThanOrEqual(80);
    expect(machinePositions(FIXTURE, TALL, 0.39).size * 0.39).toBeGreaterThanOrEqual(48);
  });

  it("puts the name and what is free on the left of a reactor in a wide world, the name alone in a tall one", () => {
    for (const world of SIZES) {
      const column = machinePositions(FIXTURE, world);
      expect(column.status).toBe(world === WIDE);
      for (const machine of FIXTURE) {
        const anchor = machineLabelAnchor(machine.id, column)!;
        const at = column.places.get(machine.id)!;
        expect(anchor.y).toBe(at.y);
        expect(anchor.x).toBeLessThan(at.x - column.size / 2);
        expect(column.labels.get(machine.id)!.width).toBeLessThanOrEqual(MACHINE_LABEL_WIDTH_PX);
      }
    }
    const long = { id: "x", name: "x", status: "перегружена: процессор, память, GPU, видеопамять, диск /data" };
    expect(machinePositions([long], WIDE).labels.get("x")!.width).toBe(MACHINE_LABEL_WIDTH_PX);
  });

  it("keeps the stations with their labels inside the world, apart from each other and clear of the toolbar and the log", () => {
    for (const world of SIZES) {
      for (const zoom of ZOOMS.get(world)!) {
        for (const list of [machines(1), machines(4), FIXTURE, machines(12)]) {
          const column = machinePositions(list, world, zoom, true);
          const what = `${list.length} machines in ${world.width}x${world.height} at ${zoom}`;
          const rooms = machineRooms(column);
          const bodies = [...column.places.values()].map((at) => body(at, column.size));
          for (const room of [...rooms, ...bodies]) {
            expect(room.x0, what).toBeGreaterThanOrEqual(0);
            expect(room.y0, what).toBeGreaterThanOrEqual(0);
            expect(room.x1, what).toBeLessThanOrEqual(world.width);
            expect(room.y1, what).toBeLessThanOrEqual(world.height);
            for (const panel of defaultCovered(world)) expect(hit(room, panel), what).toBe(false);
          }
          // Up to the column's limit every row has its own room, and a label keeps clear of every station.
          if (list.length < 12) expect(column.size, what).toBeGreaterThan(MACHINE_MIN_SIZE);
          if (column.size > MACHINE_MIN_SIZE) {
            rooms.forEach((a, i) => rooms.slice(i + 1).forEach((b) => expect(hit(a, b), what).toBe(false)));
            for (const { id } of list) {
              const anchor = machineLabelAnchor(id, column)!;
              const size = column.labels.get(id)!;
              const label = { x0: anchor.x - size.width / zoom, y0: anchor.y - size.height / zoom / 2, x1: anchor.x, y1: anchor.y + size.height / zoom / 2 };
              for (const station of bodies) expect(hit(label, station), what).toBe(false);
            }
          }
        }
      }
    }
  });

  it("covers the whole column with one rect, the gaps between its rows included, and not the config's line", () => {
    expect(machineColumnRect(machinePositions([], WIDE))).toBeNull();
    for (const world of SIZES) {
      for (const list of [machines(1), FIXTURE, machines(12)]) {
        const column = machinePositions(list, world, ZOOMS.get(world)![0], true);
        const rect = machineColumnRect(column)!;
        const ids = [...column.places.keys()];
        const rooms = ids.map((id) => machineRoom(id, column));
        for (const room of rooms) {
          expect(rect.x0).toBeLessThanOrEqual(room.x0);
          expect(rect.x1).toBeGreaterThanOrEqual(room.x1);
          expect(rect.y0).toBeLessThanOrEqual(room.y0);
          expect(rect.y1).toBeGreaterThanOrEqual(room.y1);
        }
        // Each gap between two rows, as wide as the widest label's room.
        rooms.slice(1).forEach((room, i) => {
          const gap = { x0: Math.min(...rooms.map((r) => r.x0)), y0: rooms[i]!.y1, x1: column.right, y1: room.y0 };
          expect(rect.x0).toBeLessThanOrEqual(gap.x0);
          expect(rect.y0).toBeLessThanOrEqual(gap.y0);
          expect(rect.y1).toBeGreaterThanOrEqual(gap.y1);
        });
        expect(rect.x1).toBe(column.right);
        expect(rect.y0).toBeGreaterThan(column.note!.y);
      }
    }
  });

  it("keeps the stations above the ship's log that spans a tall window", () => {
    for (const room of machineRooms(machinePositions(FIXTURE, TALL, 0.39))) expect(room.y1).toBeLessThanOrEqual(logCorner(TALL).y0);
  });

  it("moves the science station only as far as a machine's label makes it", () => {
    expect(researchPosition(WIDE, machinePositions(FIXTURE, WIDE, 0.855))).toEqual(researchPosition(WIDE));
    expect(researchPosition(TALL, machinePositions([{ id: "x", name: "kedr", status: "" }], TALL, 0.39))).toEqual(researchPosition(TALL));
    const column = machinePositions(FIXTURE, TALL, 0.39);
    const station = researchPosition(TALL, column);
    expect(station.x).toBeLessThan(researchPosition(TALL).x);
    const sprite = { x0: station.x - RESEARCH_SIZE / 2, y0: station.y - RESEARCH_SIZE / 2, x1: station.x + RESEARCH_SIZE / 2, y1: station.y + RESEARCH_SIZE / 2 };
    const label = { x0: station.x - 88 / 0.39, y0: station.y + 93, x1: station.x + 88 / 0.39, y1: station.y + 93 + 36 / 0.39 };
    expect(label.x0).toBeGreaterThanOrEqual(0);
    for (const room of machineRooms(column)) {
      expect(hit(label, room)).toBe(false);
      expect(hit(sprite, room)).toBe(false);
    }
  });

  it("lets no star stand in the machines' column, the gaps between its rows included", () => {
    const inside = (at: { x: number; y: number }, r: Rect) => at.x >= r.x0 && at.x <= r.x1 && at.y >= r.y0 && at.y <= r.y1;
    for (const [world, zoom] of [[WIDE, 0.855], [TALL, 0.39]] as const) {
      for (const machineCount of [1, 2, 4, 5, 12]) {
        const list = machineCount === 5 ? FIXTURE : machines(machineCount);
        const column = machinePositions(list, world, zoom);
        const rect = machineColumnRect(column)!;
        const blocked = galaxyKeepOuts(world, defaultCovered(world), column);
        for (const count of [6, 34, 150]) {
          const stars = Array.from({ length: count }, (_, i) => ({ repo: `repo-${i}`, live: i % 3 ? 0 : 1 + (i % 7), attention: 0, ready: 0, sleeping: 0 }));
          const galaxy = galaxyLayout(stars, world, blocked, null, zoom);
          const what = `${machineCount} machines, ${count} stars in ${world.width}x${world.height}`;
          for (const at of galaxy.places.values()) expect(inside(at, rect), what).toBe(false);
        }
      }
    }
  });
});

describe("fuel tanks", () => {
  const [WIDE, TALL] = SIZES as [{ width: number; height: number }, { width: number; height: number }];
  const ZOOMS = new Map([[WIDE, [0.75, 0.855, 1.06]], [TALL, [0.375, 0.5]]]);
  const hit = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const tank = (key: string, executor: "codex" | "claude" = "codex", resets = 0): TankShape => ({ key, executor, name: key, info: "83% · ↻ 5 д", resets });
  /** The board's subscriptions: two Codex accounts with free resets and three Claude ones. */
  const BOARD: TankShape[] = [
    tank("main", "codex", 2),
    tank("second", "codex", 2),
    tank("default", "claude"),
    tank("kaifaty-self", "claude"),
    tank("my-corp", "claude"),
  ];
  const many = (count: number) => Array.from({ length: count }, (_, i) => tank(`account-${i}`, i % 2 ? "claude" : "codex"));
  /** The tank with its badge and lamps. */
  const gear = (at: { x: number; y: number }, size: number): Rect => ({
    x0: at.x - (size * TANK_ASPECT) / 2,
    y0: at.y - size / 2 - size * BADGE_RISE,
    x1: at.x - (size * TANK_ASPECT) / 2 + tankGear(size),
    y1: at.y + size / 2,
  });

  it("stands in a column on the left of a wide galaxy, in order, each label on the right of its tank", () => {
    const fuel = fuelPositions(BOARD, WIDE, 0.855);
    expect(fuel.row).toBe(false);
    expect(fuelPositions(BOARD, WIDE, 0.855)).toEqual(fuel);
    const points = BOARD.map((shape) => fuel.places.get(shape.key)!);
    expect(new Set(points.map((point) => point.x)).size).toBe(1);
    expect(points[0]!.x).toBeLessThan(WIDE.width * 0.1);
    points.slice(1).forEach((point, i) => expect(point.y).toBeGreaterThan(points[i]!.y));
    // Codex and Claude stand a little apart.
    expect(points[2]!.y - points[1]!.y).toBeGreaterThan(points[1]!.y - points[0]!.y);
    for (const shape of BOARD) {
      const anchor = fuel.anchors.get(shape.key)!;
      expect(anchor.y).toBe(fuel.places.get(shape.key)!.y);
      expect(anchor.x).toBeGreaterThan(gear(fuel.places.get(shape.key)!, fuel.size).x1);
    }
  });

  it("stands in a row under the toolbar of a tall galaxy, each label under its tank and no wider than its share", () => {
    const fuel = fuelPositions(BOARD, TALL, 0.375);
    expect(fuel.row).toBe(true);
    const points = BOARD.map((shape) => fuel.places.get(shape.key)!);
    expect(new Set(points.map((point) => point.y)).size).toBe(1);
    points.slice(1).forEach((point, i) => expect(point.x).toBeGreaterThan(points[i]!.x));
    const share = (TALL.width - 40) / BOARD.length;
    for (const shape of BOARD) {
      expect(fuel.anchors.get(shape.key)!.y).toBeGreaterThan(fuel.places.get(shape.key)!.y + fuel.size / 2);
      expect(fuel.labels.get(shape.key)!.width / 0.375).toBeLessThanOrEqual(share);
    }
  });

  it("keeps the tanks with their labels inside the world, apart from each other and clear of the toolbar and the log", () => {
    for (const world of SIZES) {
      for (const zoom of ZOOMS.get(world)!) {
        for (const list of [[tank("solo")], BOARD, many(9)]) {
          const fuel = fuelPositions(list, world, zoom);
          const what = `${list.length} tanks in ${world.width}x${world.height} at ${zoom}`;
          const rooms = list.map((shape) => fuelRoom(shape.key, fuel));
          for (const room of rooms) {
            expect(room.x0, what).toBeGreaterThanOrEqual(0);
            expect(room.y0, what).toBeGreaterThanOrEqual(0);
            expect(room.x1, what).toBeLessThanOrEqual(world.width);
            expect(room.y1, what).toBeLessThanOrEqual(world.height);
            for (const panel of defaultCovered(world)) expect(hit(room, panel), what).toBe(false);
          }
          if (fuel.size > TANK_MIN_SIZE) rooms.forEach((a, i) => rooms.slice(i + 1).forEach((b) => expect(hit(a, b), what).toBe(false)));
        }
      }
    }
  });

  it("draws the tanks larger on a phone, and smaller in a long column down to their least size", () => {
    expect(fuelPositions([tank("solo")], WIDE).size).toBe(TANK_SIZE.wide);
    expect(fuelPositions([tank("solo")], TALL, 0.375).size).toBe(TANK_SIZE.tall);
    expect(fuelPositions(many(14), WIDE).size).toBe(TANK_MIN_SIZE);
    // The board's five tanks in the full view: at least 60 pixels tall on a 1400×900 window, 48 on a phone.
    expect(fuelPositions(BOARD, WIDE, 0.855).size * 0.855).toBeGreaterThanOrEqual(60);
    expect(fuelPositions(BOARD, TALL, 0.375).size * 0.375).toBeGreaterThanOrEqual(48);
  });

  it("sizes a label by its name, its line and its spare cells, up to its widest", () => {
    expect(tankLabelSize(tank("main", "codex", 2)).width).toBeGreaterThan(tankLabelSize(tank("main")).width);
    expect(tankLabelSize({ ...tank("x".repeat(60)) }).width).toBe(150);
  });

  it("lets no star stand among the tanks, and moves the science station clear of their labels", () => {
    const inside = (at: { x: number; y: number }, r: Rect) => at.x >= r.x0 && at.x <= r.x1 && at.y >= r.y0 && at.y <= r.y1;
    for (const [world, zoom] of [[WIDE, 0.855], [TALL, 0.375]] as const) {
      const fuel = fuelPositions(BOARD, world, zoom);
      const rect = fuelColumnRect(fuel)!;
      for (const shape of BOARD) {
        const room = fuelRoom(shape.key, fuel);
        expect(rect.x0).toBeLessThanOrEqual(room.x0);
        expect(rect.y1).toBeGreaterThanOrEqual(room.y1);
      }
      const blocked = galaxyKeepOuts(world, defaultCovered(world), null, fuel);
      for (const count of [6, 34]) {
        const stars = Array.from({ length: count }, (_, i) => ({ repo: `repo-${i}`, live: i % 3 ? 0 : 1 + (i % 7), attention: 0, ready: 0, sleeping: 0 }));
        for (const at of galaxyLayout(stars, world, blocked, null, zoom).places.values()) expect(inside(at, rect)).toBe(false);
      }
      const station = researchPosition(world, null, fuel);
      const sprite = { x0: station.x - RESEARCH_SIZE / 2, y0: station.y - RESEARCH_SIZE / 2, x1: station.x + RESEARCH_SIZE / 2, y1: station.y + RESEARCH_SIZE / 2 };
      for (const shape of BOARD) expect(hit(sprite, fuelRoom(shape.key, fuel))).toBe(false);
    }
    expect(fuelColumnRect(fuelPositions([], WIDE))).toBeNull();
  });

  it("starts a phone's machine column under the row of tanks", () => {
    const fuel = fuelPositions(BOARD, TALL, 0.375);
    const rect = fuelColumnRect(fuel)!;
    const column = machinePositions([{ id: "a", name: "a", status: "" }, { id: "b", name: "b", status: "" }], TALL, 0.375, false, [...defaultCovered(TALL), { ...rect, y0: 0 }]);
    for (const room of machineRooms(column)) expect(room.y0).toBeGreaterThan(rect.y1);
  });
});

describe("constellations in the galaxy", () => {
  const size = { width: 1600, height: 1000 };
  const blocked = galaxyKeepOuts(size, defaultCovered(size));
  /** A board of `count` stars, some busy; the first `members` of every fifth one form a constellation. */
  const board = (count: number): StarShape[] =>
    Array.from({ length: count }, (_, i) => ({ repo: `repo-${String(i).padStart(2, "0")}`, live: i % 3 ? 0 : 1 + (i % 5), attention: 0, ready: 0, sleeping: 0 }));
  const groupOf = (stars: readonly StarShape[], every: number) =>
    new Map(stars.filter((_, i) => i % every === 0).map((star) => [star.repo, "Wallet"]));
  const spread = (points: { x: number; y: number }[]) => {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
  };

  it("gathers a constellation's stars far closer than the same stars stand without it", () => {
    for (const count of [12, 24]) {
      const stars = board(count);
      const groups = groupOf(stars, 4);
      const apart = galaxyLayout(stars, size, blocked);
      const together = galaxyLayout(stars, size, blocked, null, LABEL_ZOOM_FULL, groups);
      const members = [...groups.keys()];
      expect(spread(members.map((repo) => together.places.get(repo)!))).toBeLessThan(spread(members.map((repo) => apart.places.get(repo)!)) * 0.75);
      expect(together.places.size).toBe(count);
    }
  });

  it("keeps the other stars a step and more from a constellation's stars, where there is room", () => {
    const stars = board(14);
    const groups = groupOf(stars, 3);
    const galaxy = galaxyLayout(stars, size, blocked, null, LABEL_ZOOM_FULL, groups);
    for (const star of stars) {
      if (groups.has(star.repo)) continue;
      const at = galaxy.places.get(star.repo)!;
      for (const member of groups.keys()) {
        const other = galaxy.places.get(member)!;
        expect(Math.hypot(at.x - other.x, at.y - other.y), `${star.repo} by ${member}`).toBeGreaterThanOrEqual(galaxy.spacing);
      }
    }
  });

  it("lays the stars out afresh when the constellations change, and the same way every time", () => {
    const stars = board(20);
    const groups = groupOf(stars, 4);
    const before = galaxyLayout(stars, size, blocked);
    const after = galaxyLayout(stars, size, blocked, before, LABEL_ZOOM_FULL, groups);
    expect(after.groups).not.toBe(before.groups);
    expect(galaxyLayout(stars, size, blocked, null, LABEL_ZOOM_FULL, groups).places).toEqual(after.places);
    expect([...groups.keys()].some((repo) => before.places.get(repo)!.x !== after.places.get(repo)!.x)).toBe(true);
    // Once laid out with them, the stars keep their places.
    const again = galaxyLayout(stars, size, blocked, after, LABEL_ZOOM_FULL, groups);
    expect(again.places).toEqual(after.places);
  });
});
