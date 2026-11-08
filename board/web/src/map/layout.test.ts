import { describe, expect, it } from "vitest";
import { PLACES } from "./placement";
import {
  MAX_ZOOM, ROUTE, STATIONS, SUN_RADIUS, backdropOf, cardPlace, clampCamera, depotPosition, fitCamera, LIGHT_SHIP, ringOf, ringPoint, ringsOf, skyChoices,
  RESEARCH_SIZE, LABEL_MAX_WIDTH, DEPOT_LABEL_DROP, MACHINE_MIN_SIZE, MACHINE_SIZE, machineColumnRect, machineLabelAnchor, machinePositions, machineRoom, machineRooms, galaxyKeepOuts, galaxyLayout, limitZoom, logCorner, refitCamera, researchPosition, starFootprint, starLabelSize,
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
  /** A depot with its fuel gauge and its label of three lines, as wide as its CSS lets it be, at `zoom`. */
  const depotRoom = (at: { x: number; y: number }, top: boolean, zoom: number): Rect => {
    const half = Math.max(58, 85 / zoom);
    const label = 46 / zoom;
    return top
      ? { x0: at.x - half, y0: at.y - 58, x1: at.x + half, y1: at.y + DEPOT_LABEL_DROP.top + label }
      : { x0: at.x - half, y0: at.y - DEPOT_LABEL_DROP.bottom - label, x1: at.x + half, y1: at.y + 58 };
  };
  const depotsFor = (world: { width: number; height: number }) =>
    [1, 2, 3, 4].flatMap((count) =>
      Array.from({ length: count }, (_, i) => [
        { at: depotPosition(i, count, "top", world), top: true },
        { at: depotPosition(i, count, "bottom", world), top: false },
      ]).flat(),
    );
  /** The sprite alone: the art is about two thirds as tall as it is wide. */
  const body = (at: { x: number; y: number }, size: number): Rect => ({ x0: at.x - size / 2, y0: at.y - size / 3, x1: at.x + size / 2, y1: at.y + size / 3 });

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

  it("draws the stations as large as a depot, larger on a phone, and smaller in a long column down to its least size", () => {
    expect(machinePositions(machines(1), WIDE).size).toBe(MACHINE_SIZE.wide);
    expect(machinePositions(machines(1), TALL).size).toBe(MACHINE_SIZE.tall);
    expect(machinePositions(machines(12), WIDE).size).toBe(MACHINE_MIN_SIZE);
    // The fixture's five machines in the full view: at least 80 pixels on a 1400×900 window, 48 on a 390×844 phone.
    expect(machinePositions(FIXTURE, WIDE, 0.855).size * 0.855).toBeGreaterThanOrEqual(80);
    expect(machinePositions(FIXTURE, TALL, 0.39).size * 0.39).toBeGreaterThanOrEqual(48);
  });

  it("puts the name and the status on the left of a station in a wide world, the name alone in a tall one", () => {
    for (const world of SIZES) {
      const column = machinePositions(FIXTURE, world);
      expect(column.status).toBe(world === WIDE);
      for (const machine of FIXTURE) {
        const anchor = machineLabelAnchor(machine.id, column)!;
        const at = column.places.get(machine.id)!;
        expect(anchor.y).toBe(at.y);
        expect(anchor.x).toBeLessThan(at.x - column.size / 2);
        expect(column.labels.get(machine.id)!.width).toBeLessThanOrEqual(150);
      }
    }
    const long = { id: "x", name: "x", status: "перегружена: процессор, память, GPU, видеопамять, диск /data" };
    expect(machinePositions([long], WIDE).labels.get("x")!.width).toBe(150);
  });

  it("keeps the stations with their labels inside the world, apart from each other and clear of the depots with their labels", () => {
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
            for (const depot of depotsFor(world)) expect(hit(room, depotRoom(depot.at, depot.top, zoom)), what).toBe(false);
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

  it("moves the research station only as far as a machine's label makes it", () => {
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
      const depots = [0, 1].flatMap((i) => [depotPosition(i, 2, "top", world), depotPosition(i, 2, "bottom", world)]);
      for (const machineCount of [1, 2, 4, 5, 12]) {
        const list = machineCount === 5 ? FIXTURE : machines(machineCount);
        const column = machinePositions(list, world, zoom);
        const rect = machineColumnRect(column)!;
        const blocked = galaxyKeepOuts(world, depots, [logCorner(world)], column);
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
