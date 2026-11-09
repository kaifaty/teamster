// The system's ships: they come, leave, park on their stations' berths, fly between them and are drawn with their
// marks over them; the smoke of damaged ones goes between the ships and their marks.

import { Container, Graphics } from "pixi.js";
import {
  SUN_CLEARANCE,
  SUN_RADIUS,
  lanesOf,
  parkingOf,
  parkingOrder,
  stationAt,
  stationOf,
  type Point,
  type SystemFrame,
} from "../../layout";
import { FLEET, SPACE } from "../../palette";
import type { Place } from "../../placement";
import { departureOf } from "../../replay";
import type { Kit } from "../kit";
import type { Clock, SystemLayer } from "../layer";
import { noise, turn } from "../math";
import type { ShipEntry } from "../types";
import { dressShip, makeShip, type Ship } from "./hull";
import { MAX_FINDING_MARKS, findingMarks, scan, verdictFx } from "./inspection";
import { createSmoke, sparks } from "./smoke";

const MAX_SPEED = 300;
/** A working ship hovers this far around its berth, in world units, this fast. */
const HOVER = 3;
const HOVER_SPEED = 1.3;

export interface Fleet extends SystemLayer {
  /** The ships shown, by slug, leaving ones too. */
  readonly ships: ReadonlyMap<string, Ship>;
  /** See FleetScene.setShips. */
  set(entries: ShipEntry[], departures?: ReadonlyMap<string, "dive" | "fade">): void;
  select(slug: string | null): void;
  hover(slug: string | null): void;
  /** Takes every ship away at once, for another system. */
  clear(): void;
  /** The ship nearest to a world point of the system within its reach, or null. */
  shipAt(point: Point): string | null;
}

export interface FleetDeps {
  /** A ship dived into the sun: it flares. */
  onDive(): void;
}

export function createFleet(kit: Kit, initial: SystemFrame, deps: FleetDeps): Fleet {
  const { still } = kit;
  const shipLayer = new Container();
  const smokes = createSmoke(kit);
  const systemFx = new Graphics();
  const root = new Container();
  root.addChild(shipLayer, smokes.root, systemFx);
  const ships = new Map<string, Ship>();
  let frame = initial;
  let selected: string | null = null;
  let hovered: string | null = null;
  let time = 0;
  /** A scratch point, so that the frame makes no objects for its effects. */
  const spot: Point = { x: 0, y: 0 };

  /** A ship's berth in the world. */
  function berthPoint(item: Ship): Point {
    const station = stationAt(item.entry.placement.place, frame);
    return { x: station.x + item.berth.x, y: station.y + item.berth.y };
  }

  /**
   * Parked ships face their station's side, all one way, like a fleet in formation; at the inspection they face its
   * exit, to the right, in its lanes and in the queue.
   */
  const headingOf = (place: Place) => (place === "inspection" ? Math.PI / 2 : ((stationOf(place, frame).side + 90) * Math.PI) / 180);

  function addShip(entry: ShipEntry, arrive: boolean): Ship {
    const item = makeShip(kit, entry, arrive, stationAt(entry.placement.place, frame));
    shipLayer.addChild(item.body);
    ships.set(item.slug, item);
    return item;
  }

  function removeShip(item: Ship) {
    item.body.destroy({ children: true });
    ships.delete(item.slug);
  }

  function clearShips() {
    for (const item of [...ships.values()]) removeShip(item);
  }

  /** Puts the ships of every station on its berths, in parkingOrder; those past the berths wait behind the count. */
  function arrange() {
    const byPlace = new Map<Place, Ship[]>();
    for (const item of ships.values()) {
      if (item.leaving) continue;
      const list = byPlace.get(item.entry.placement.place) ?? [];
      list.push(item);
      byPlace.set(item.entry.placement.place, list);
    }
    for (const [place, list] of byPlace) {
      const order = parkingOrder(list, (item) => ({ slug: item.slug, ...item.entry.placement }), place, selected);
      const parking = parkingOf(place, order.map((item) => item.size), frame);
      const lanes = place === "inspection" ? lanesOf(frame).length : 0;
      order.forEach((item, index) => {
        item.lane = index < lanes;
        item.stowed = index >= parking.berths.length;
        item.berth = item.stowed ? parking.count!.at : parking.berths[index]!;
        if (item.placed) return;
        item.placed = true;
        item.shown = item.stowed ? 0 : 1;
        if (item.arrive) return;
        const point = berthPoint(item);
        item.x = point.x;
        item.y = point.y;
        item.body.rotation = headingOf(place);
      });
    }
  }

  function setShips(entries: ShipEntry[], departures?: ReadonlyMap<string, "dive" | "fade">) {
    const known = new Set(entries.map((entry) => entry.task.slug));
    for (const item of [...ships.values()]) {
      if (known.has(item.slug) || item.leaving) continue;
      item.leaving = departureOf(item.slug, item.entry.placement.place, departures);
      // A ship that waited behind the count comes out to leave where it can be seen.
      item.stowed = false;
      if (still) removeShip(item);
    }
    const first = ships.size === 0;
    for (const entry of entries) {
      const item = ships.get(entry.task.slug);
      if (!item) {
        addShip(entry, !first && !still);
        continue;
      }
      if (item.entry.placement.place === "inspection" && entry.placement.place !== "inspection" && entry.task.review !== null) {
        item.verdict = { clean: entry.task.review === "clean", age: 0 };
      }
      item.entry = entry;
      item.leaving = null;
      dressShip(kit, item);
    }
    arrange();
  }

  function moveShip(item: Ship, dt: number) {
    if (item.leaving === "fade") {
      item.body.alpha -= dt * 1.5;
      if (item.body.alpha <= 0) removeShip(item);
      return;
    }
    const { working } = item.entry.placement;
    let target: Point;
    if (item.leaving === "dive") {
      target = { x: frame.cx, y: frame.cy };
    } else {
      target = berthPoint(item);
      // A working ship hovers on its berth.
      if (working && !still && !item.stowed) {
        target.x += Math.cos(time * HOVER_SPEED + item.seed) * HOVER;
        target.y += Math.sin(time * HOVER_SPEED * 1.4 + item.seed * 0.7) * HOVER;
      }
    }
    item.shown = still ? Number(!item.stowed) : Math.min(1, Math.max(0, item.shown + (item.stowed ? -dt : dt) * 2));
    const dx = target.x - item.x;
    const dy = target.y - item.y;
    const distance = Math.hypot(dx, dy);
    item.travelling = item.leaving !== null || distance > HOVER * 4;
    const step = still ? distance : Math.min(distance, Math.min(MAX_SPEED, distance * 2.4 + 20) * dt);
    const previous = { x: item.x, y: item.y };
    if (distance > 0) {
      item.x += (dx / distance) * step;
      item.y += (dy / distance) * step;
    }
    if (item.leaving === "dive") {
      item.body.scale.set(Math.min(1, Math.max(0.2, distance / 200)));
      if (distance < SUN_RADIUS * 0.6) {
        deps.onDive();
        removeShip(item);
      }
      return;
    }
    // Ships fly around the sun, not through it.
    const fromSun = Math.hypot(item.x - frame.cx, item.y - frame.cy);
    if (fromSun < SUN_CLEARANCE && fromSun > 0) {
      item.x = frame.cx + ((item.x - frame.cx) / fromSun) * SUN_CLEARANCE;
      item.y = frame.cy + ((item.y - frame.cy) / fromSun) * SUN_CLEARANCE;
    }
    item.vx = (item.x - previous.x) / Math.max(dt, 0.001);
    item.vy = (item.y - previous.y) / Math.max(dt, 0.001);
  }

  function drawShip(item: Ship, clock: Readonly<Clock>) {
    const { dt } = clock;
    const { body, hull, engine, entry } = item;
    const where = entry.placement;
    const speed = Math.hypot(item.vx, item.vy);
    body.position.set(item.x, item.y);
    if (item.travelling && speed > 3) body.rotation += turn(body.rotation, Math.atan2(item.vy, item.vx) + Math.PI / 2) * Math.min(1, dt * 6);
    else if (!item.travelling) body.rotation += turn(body.rotation, headingOf(where.place)) * (still ? 1 : Math.min(1, dt * 3));
    const seen = item.shown > 0.5;

    const blink = Math.floor(time * 3) % 2 === 0;
    hull.tint = where.beacon && blink ? "#ff9d90" : where.action === "sleep" ? SPACE.sleep : "#ffffff";
    item.patches.tint = hull.tint;
    const damaged = entry.task.ci === "failed";
    item.burn.visible = damaged;
    if (damaged) {
      // The glow of a fire under the plating flickers unevenly; still, it only glows.
      const flicker = still ? 0.5 : 0.5 + 0.3 * Math.sin(time * 11 + item.seed) * Math.sin(time * 6.7 + item.seed * 0.37) + 0.2 * noise(Math.floor(time * 9) + item.seed);
      item.burn.alpha = 0.35 + 0.5 * flicker;
      if (!still && !item.leaving && seen) sparks(systemFx, item, time, spot);
    }
    if (item.leaving !== "fade") body.alpha = (where.action === "sleep" ? 0.75 : 1) * item.shown;
    body.visible = item.shown > 0;
    const burning = where.working || speed > 30;
    engine.alpha = burning ? 0.75 + 0.25 * Math.sin(time * 18 + item.x) : 0.08;
    engine.tint = where.fixing ? SPACE.fix : FLEET[entry.task.executor].engine;

    if (speed > 60 && seen) {
      const color = where.fixing ? SPACE.fix : FLEET[entry.task.executor].engine;
      for (let i = 1; i <= 7; i++) {
        const back = item.size * 0.5 + i * 9;
        systemFx.circle(item.x - (item.vx / speed) * back, item.y - (item.vy / speed) * back, 3.4 - i * 0.35);
        systemFx.fill({ color, alpha: 0.5 - i * 0.06 });
      }
    }
    if (where.beacon && seen) {
      // Within the ship's own room, so that the beacons of a row of ships do not run into each other.
      const pulse = (time * 0.7) % 1;
      systemFx.circle(item.x, item.y, item.size * (0.55 + pulse * 0.4));
      systemFx.stroke({ width: 2, color: SPACE.alarm, alpha: 1 - pulse });
    }
    const { task } = entry;
    if (where.fixing && task.review === "defects" && task.findings_left > 0 && seen) findingMarks(systemFx, item, Math.min(task.findings_left, MAX_FINDING_MARKS));
    if (item.verdict) verdictFx(systemFx, item, clock);
    if ((item.slug === selected || item.slug === hovered) && seen) {
      const half = item.size * 0.72;
      const arm = half * 0.4;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const x = item.x + sx * half;
        const y = item.y + sy * half;
        systemFx.moveTo(x - sx * arm, y).lineTo(x, y).lineTo(x, y - sy * arm);
      }
      systemFx.stroke({ width: 2.2, color: item.slug === selected ? SPACE.select : SPACE.hover, alpha: 0.95 });
    }
  }

  return {
    root,
    ships,
    set: setShips,
    select(slug) {
      selected = slug;
      arrange();
    },
    hover(slug) {
      hovered = slug;
    },
    clear: clearShips,
    shipAt(point) {
      let best: string | null = null;
      let bestDistance = Infinity;
      for (const item of ships.values()) {
        const distance = Math.hypot(item.x - point.x, item.y - point.y);
        if (!item.leaving && !item.stowed && distance < item.size * 0.7 && distance < bestDistance) {
          bestDistance = distance;
          best = item.slug;
        }
      }
      return best;
    },
    /** Puts the ships on their berths at once. */
    layout(next) {
      frame = next;
      arrange();
      for (const item of ships.values()) {
        const point = berthPoint(item);
        item.x = point.x;
        item.y = point.y;
      }
    },
    frame(clock) {
      time = clock.time;
      const entries = [...ships.values()];
      systemFx.clear();
      for (const item of entries) {
        if (item.entry.placement.place === "inspection" && !item.leaving && item.entry.placement.placeWorking && item.lane && !item.travelling) scan(systemFx, item, frame, clock);
      }
      for (const item of entries) {
        moveShip(item, clock.dt);
        if (ships.has(item.slug)) drawShip(item, clock);
      }
      smokes.frame(ships.values(), clock);
    },
    dispose() {
      ships.clear();
      smokes.dispose();
      root.destroy({ children: true });
    },
  };
}
