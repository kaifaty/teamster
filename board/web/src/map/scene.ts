// The map in PixiJS: a galaxy of repositories and a star system per repository, in painted art at the full
// resolution of the screen. Labels are HTML in MapView; the scene draws, moves the camera and reports what the
// pointer does.

import { Application, Assets, ColorMatrixFilter, Container, Graphics, Sprite, Texture, type ColorMatrix } from "pixi.js";
import type { TaskSummary } from "../types";
import { ART, BACKDROPS, type ArtName } from "./art";
import type { Depot, Family, Star, SupplyLine } from "./fleet";
import { LOW_FUEL, depotPositions } from "./fleet";
import {
  ROUTE,
  STATIONS,
  SUN_CLEARANCE,
  SUN_RADIUS,
  backdropOf,
  clampCamera,
  fitCamera,
  hashName,
  ringOf,
  ringPoint,
  starPositions,
  starRadius,
  stationAt,
  systemFrame,
  worldSize,
  zoomCamera,
  type Camera,
  type Point,
  type Size,
  type SystemFrame,
} from "./layout";
import { FLEET, SPACE, SUN_KINDS } from "./palette";
import type { Place, Placement } from "./placement";

export interface ShipEntry {
  task: TaskSummary;
  placement: Placement;
}

export interface GalaxyModel {
  stars: Star[];
  depots: Depot[];
  lines: SupplyLine[];
}

export interface SceneOptions {
  host: HTMLElement;
  onEnter: (repo: string) => void;
  onLeave: () => void;
  onPick: (slug: string) => void;
  onHover: (slug: string | null) => void;
  /** The world's shape and the camera over it, for the labels. */
  onCamera: (world: Size, camera: Camera) => void;
  onLost: () => void;
}

export interface FleetScene {
  setGalaxy(model: GalaxyModel): void;
  /** Shows system `repo`, or the galaxy for null, flying there unless motion is reduced. */
  setView(repo: string | null): void;
  setShips(entries: ShipEntry[]): void;
  setSelected(slug: string | null): void;
  setHovered(slug: string | null): void;
  setActive(active: boolean): void;
  dispose(): void;
}

/** Seconds of the flight between the galaxy and a system. */
export const FLIGHT_SECONDS = 0.9;
/** The share of the flight spent falling towards the star; the rest brings up the system. */
const FALL = 0.55;
const MAX_SPEED = 300;
const CIRCLING_SPEED = 0.4;
const SHIP_SIZE: Record<Hull, number> = { ship: 74, scout: 46, flagship: 150 };
const DEPOT_SIZE = 116;
/** Pixels the pointer may move and still make a click. */
const CLICK_SLOP = 5;
const WHEEL_ZOOM = 0.0016;
const WHEEL_STEP = 80;
const WHEEL_PAUSE_MS = 900;
/** The art is cropped a little wider than the ball, to keep its glow; see art/prepare.py. */
const BALL_MARGIN = 1.04;
const SUN_MARGIN = 1.5;

type Hull = "ship" | "scout" | "flagship";

const ROUTE_BEND = 0.14;
const FIX_BEND = -0.07;

function curvePoint(a: Point, b: Point, bend: number, u: number): Point {
  const middle = { x: (a.x + b.x) / 2 + (b.y - a.y) * bend, y: (a.y + b.y) / 2 - (b.x - a.x) * bend };
  const v = 1 - u;
  return { x: v * v * a.x + 2 * v * u * middle.x + u * u * b.x, y: v * v * a.y + 2 * v * u * middle.y + u * u * b.y };
}

/** Stable pseudo-random number in [0, 1) from an index. */
function noise(index: number): number {
  const value = Math.sin(index * 127.1 + 3.3) * 43758.5453;
  return value - Math.floor(value);
}

/** The shortest turn from one angle to another. */
function turn(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** The art's brightness in pale blue: a tint on the sprite would not survive a filter. */
const COLD_STAR: ColorMatrix = [
  0.32, 0.62, 0.12, 0, 0,
  0.39, 0.77, 0.14, 0, 0,
  0.51, 1.0, 0.19, 0, 0,
  0, 0, 0, 1, 0,
];

function softDisc(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.45)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return canvas;
}

interface Ship {
  slug: string;
  body: Container;
  hull: Sprite;
  engine: Sprite;
  size: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Where the ship is on its ring. */
  angle: number;
  entry: ShipEntry;
  /** Set for a ship that left the map: it dives into the sun or fades out. */
  leaving: "dive" | "fade" | null;
}

export async function createFleetScene(options: SceneOptions): Promise<FleetScene> {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const viewportOf = (): Size => ({ width: Math.max(1, options.host.clientWidth), height: Math.max(1, options.host.clientHeight) });

  let viewport = viewportOf();
  const app = new Application();
  await app.init({
    width: viewport.width,
    height: viewport.height,
    background: SPACE.void,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    preference: "webgl",
    autoStart: false,
    sharedTicker: false,
  });
  const loaded = (await Assets.load(Object.values(ART))) as Record<string, Texture>;
  const art = (name: ArtName): Texture => loaded[ART[name]]!;
  const glowTexture = Texture.from(softDisc(), true);

  const canvas = app.canvas;
  canvas.className = "map-canvas";
  canvas.tabIndex = -1;
  options.host.prepend(canvas);

  const sprite = (texture: Texture, size: number): Sprite => {
    const made = new Sprite(texture);
    made.anchor.set(0.5);
    made.scale.set(size / Math.max(texture.width, texture.height));
    return made;
  };
  const glow = (color: string, size: number): Sprite => {
    const made = sprite(glowTexture, size);
    made.tint = color;
    made.blendMode = "add";
    return made;
  };
  const sunKind = (repo: string) => SUN_KINDS[hashName(repo) % SUN_KINDS.length]!;
  const paintSun = (body: Sprite, repo: string) => {
    const { hue, cold } = sunKind(repo);
    if (hue === 0 && !cold) {
      body.filters = [];
      return;
    }
    const filter = new ColorMatrixFilter();
    if (cold) filter.matrix = COLD_STAR;
    else filter.hue(hue, false);
    body.filters = [filter];
  };

  // Layers ----------------------------------------------------------------------------------------

  const backdrop = new Sprite(art("nebula"));
  backdrop.anchor.set(0.5);
  const systemBackdrop = new Sprite(art("nebula"));
  systemBackdrop.anchor.set(0.5);
  const dust = new Graphics();

  const galaxy = new Container();
  const lanes = new Graphics();
  const depotLayer = new Container();
  const starLayer = new Container();
  const galaxyFx = new Graphics();
  galaxy.addChild(lanes, depotLayer, starLayer, galaxyFx);

  const system = new Container();
  const charts = new Graphics();
  const corona = glow("#ff9a3c", SUN_RADIUS * 7);
  const sun = sprite(art("sun"), SUN_RADIUS * 2 * SUN_MARGIN);
  const stationLayer = new Container();
  const gateGlow = glow(SPACE.gold, STATIONS.gate.radius * 2.4);
  const gate = sprite(art("gate"), STATIONS.gate.radius * 2.3);
  const beams = new Graphics();
  const shipLayer = new Container();
  const systemFx = new Graphics();
  system.addChild(charts, corona, sun, stationLayer, gateGlow, gate, beams, shipLayer, systemFx);

  const veil = new Graphics();
  app.stage.addChild(backdrop, systemBackdrop, dust, galaxy, system, veil);

  // State -----------------------------------------------------------------------------------------

  let world = worldSize(viewport);
  let fit = fitCamera(world, viewport);
  let camera = fit;
  let frame: SystemFrame = systemFrame(world);
  let model: GalaxyModel = { stars: [], depots: [], lines: [] };
  let stars = new Map<string, Point>();
  let depotPoints = new Map<string, Point>();
  let repo: string | null = null;
  let focus: string | null = null;
  let flight = 0;
  let time = 0;
  let flash = 0;
  let selected: string | null = null;
  let hovered: string | null = null;
  let disposed = false;
  const ships = new Map<string, Ship>();

  const report = () => options.onCamera(world, repo ? camera : fit);

  // Drawing what changes rarely ---------------------------------------------------------------------

  function fitBackdrop(sky: Sprite) {
    const { width, height } = sky.texture;
    sky.scale.set(Math.max(viewport.width / width, viewport.height / height) * 1.15);
  }

  /** The sky of system `name`; the galaxy's sky stands in until it has loaded. */
  function showSky(name: string) {
    const index = backdropOf(name, BACKDROPS.length);
    systemBackdrop.texture = art("nebula");
    fitBackdrop(systemBackdrop);
    if (index === null) return;
    void Assets.load<Texture>(BACKDROPS[index]!).then((texture) => {
      if (disposed || focus !== name) return;
      systemBackdrop.texture = texture;
      fitBackdrop(systemBackdrop);
    });
  }

  function drawDepots() {
    depotLayer.removeChildren().forEach((child) => child.destroy());
    for (const depot of model.depots) {
      const point = depotPoints.get(depot.key);
      if (!point) continue;
      const body = sprite(art("depot"), DEPOT_SIZE);
      body.position.set(point.x, point.y);
      body.rotation = (hashName(depot.key) % 6) * 1.047;
      if (depot.bad) body.tint = "#8a8a94";
      const gauge = new Graphics();
      const width = 112;
      const left = point.x - width / 2;
      const top = point.y + DEPOT_SIZE / 2 + 4;
      gauge.roundRect(left, top, width, 9, 3).fill(SPACE.gauge);
      const low = depot.bad || (depot.fuel !== null && depot.fuel < LOW_FUEL);
      if (depot.fuel) gauge.roundRect(left + 1, top + 1, ((width - 2) * depot.fuel) / 100, 7, 2).fill(low ? SPACE.alarm : FLEET[depot.executor].hull);
      depotLayer.addChild(body, gauge);
      if (depot.duty) {
        const mark = glow(SPACE.gold, 46);
        mark.position.set(point.x, point.y);
        depotLayer.addChild(mark);
      }
    }
  }

  function drawLanes() {
    lanes.clear();
    for (const line of model.lines) {
      const from = depotPoints.get(line.depot);
      const to = stars.get(line.repo);
      if (!from || !to) continue;
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      for (let d = DEPOT_SIZE / 2; d < length - 30; d += 11) {
        lanes.circle(from.x + ((to.x - from.x) * d) / length, from.y + ((to.y - from.y) * d) / length, 1.5);
      }
      lanes.fill({ color: SPACE.lane, alpha: line.active ? 0.8 : 0.35 });
    }
  }

  function drawStars() {
    starLayer.removeChildren().forEach((child) => child.destroy());
    for (const star of model.stars) {
      const point = stars.get(star.repo);
      if (!point) continue;
      const radius = starRadius(star.live);
      const halo = glow(sunKind(star.repo).glow, radius * 6);
      const body = sprite(art("sun"), radius * 2 * SUN_MARGIN);
      paintSun(body, star.repo);
      body.rotation = hashName(star.repo) % 6;
      halo.alpha = star.live ? 0.55 : 0.15;
      body.alpha = star.live ? 1 : 0.55;
      halo.position.set(point.x, point.y);
      body.position.set(point.x, point.y);
      starLayer.addChild(halo, body);
    }
  }

  function drawGalaxy() {
    stars = starPositions(model.stars.map((star) => star.repo), world);
    depotPoints = depotPositions(model.depots, world);
    drawLanes();
    drawDepots();
    drawStars();
  }

  function stationSprite(place: Exclude<Place, "gate">): Sprite {
    const name: Record<typeof place, ArtName> = {
      yard: "planetYard",
      range: "planetRange",
      inspection: "planetInspection",
      roadstead: "planetRoadstead",
      cryo: "planetCryo",
      command: "stationCommand",
    };
    return sprite(art(name[place]), STATIONS[place].radius * 2 * BALL_MARGIN);
  }

  function drawCharts() {
    charts.clear();
    const orbits = [...new Set(ROUTE.map((place) => STATIONS[place].orbit))];
    for (const orbit of orbits) charts.ellipse(frame.cx, frame.cy, orbit * frame.rx, orbit * frame.ry);
    charts.stroke({ width: 1.2, color: SPACE.orbit, alpha: 0.16 });

    const dots = (a: Point, b: Point, bend: number, gap: number, radius: number) => {
      const steps = Math.round(Math.hypot(b.x - a.x, b.y - a.y) / gap);
      for (let i = 1; i < steps; i++) {
        const point = curvePoint(a, b, bend, i / steps);
        charts.circle(point.x, point.y, radius);
      }
    };
    ROUTE.slice(1).forEach((place, index) => dots(stationAt(ROUTE[index]!, frame), stationAt(place, frame), ROUTE_BEND, 15, 1.7));
    charts.fill({ color: SPACE.route, alpha: 0.5 });
    dots(stationAt("roadstead", frame), { x: frame.cx, y: frame.cy }, 0.1, 13, 2);
    charts.fill({ color: SPACE.gold, alpha: 0.8 });
    dots(stationAt("inspection", frame), stationAt("yard", frame), FIX_BEND, 19, 2);
    charts.fill({ color: SPACE.fix, alpha: 0.7 });

    stationLayer.removeChildren().forEach((child) => child.destroy());
    for (const place of ["yard", "range", "inspection", "roadstead", "cryo", "command"] as const) {
      const body = stationSprite(place);
      const point = stationAt(place, frame);
      body.position.set(point.x, point.y);
      // The art is lit from the upper left: mirror each planet so that its bright side faces the sun.
      if (place !== "command") {
        if (point.x < frame.cx) body.scale.x *= -1;
        if (point.y < frame.cy) body.scale.y *= -1;
      }
      stationLayer.addChild(body);
    }
    const point = stationAt("gate", frame);
    gate.position.set(point.x, point.y);
    gateGlow.position.copyFrom(gate.position);
    sun.position.set(frame.cx, frame.cy);
    corona.position.copyFrom(sun.position);
  }

  function layoutAll() {
    world = worldSize(viewport);
    fit = fitCamera(world, viewport);
    camera = fit;
    frame = systemFrame(world);
    fitBackdrop(backdrop);
    fitBackdrop(systemBackdrop);
    drawGalaxy();
    drawCharts();
    for (const item of ships.values()) {
      const { place, slot } = item.entry.placement;
      const point = ringPoint(stationAt(place, frame), ringOf(place, slot).radius, item.angle);
      item.x = point.x;
      item.y = point.y;
    }
    report();
  }

  // Ships -----------------------------------------------------------------------------------------

  function hullOf(task: TaskSummary): Hull {
    return task.kind === "session" ? "flagship" : task.kind === "scout" ? "scout" : "ship";
  }

  function textureOf(family: Family, hull: Hull): Texture {
    if (hull === "flagship") return art("flagship");
    if (hull === "scout") return art("shipScout");
    return art(family === "codex" ? "shipBlue" : "shipCopper");
  }

  function addShip(entry: ShipEntry, arrive: boolean): Ship {
    const kind = hullOf(entry.task);
    const size = SHIP_SIZE[kind];
    const body = new Container();
    const engine = glow(FLEET[entry.task.executor].engine, size * 0.8);
    engine.position.set(0, size * 0.46);
    const hull = sprite(textureOf(entry.task.executor, kind), size);
    body.addChild(engine, hull);
    shipLayer.addChild(body);
    const station = stationAt(entry.placement.place, frame);
    const { radius, angle } = ringOf(entry.placement.place, entry.placement.slot);
    const start = arrive ? { x: -160, y: station.y } : ringPoint(station, radius, angle);
    const item: Ship = { slug: entry.task.slug, body, hull, engine, size, x: start.x, y: start.y, vx: 0, vy: 0, angle, entry, leaving: null };
    body.rotation = angle + Math.PI;
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

  function setShips(entries: ShipEntry[]) {
    const known = new Set(entries.map((entry) => entry.task.slug));
    for (const item of [...ships.values()]) {
      if (known.has(item.slug) || item.leaving) continue;
      item.leaving = item.entry.placement.place === "roadstead" ? "dive" : "fade";
      if (still) removeShip(item);
    }
    const first = ships.size === 0;
    for (const entry of entries) {
      const item = ships.get(entry.task.slug);
      if (!item) {
        addShip(entry, !first && !still);
        continue;
      }
      const moved = item.entry.placement.place !== entry.placement.place || item.entry.placement.slot !== entry.placement.slot;
      item.entry = entry;
      item.leaving = null;
      if (moved) item.angle = ringOf(entry.placement.place, entry.placement.slot).angle;
    }
  }

  function moveShip(item: Ship, dt: number) {
    if (item.leaving === "fade") {
      item.body.alpha -= dt * 1.5;
      if (item.body.alpha <= 0) removeShip(item);
      return;
    }
    const { place, slot, working } = item.entry.placement;
    let target: Point;
    if (item.leaving === "dive") {
      target = { x: frame.cx, y: frame.cy };
    } else {
      if (working && !still) item.angle += dt * CIRCLING_SPEED;
      target = ringPoint(stationAt(place, frame), ringOf(place, slot).radius, item.angle);
    }
    const dx = target.x - item.x;
    const dy = target.y - item.y;
    const distance = Math.hypot(dx, dy);
    const step = still ? distance : Math.min(distance, Math.min(MAX_SPEED, distance * 2.4 + 20) * dt);
    const previous = { x: item.x, y: item.y };
    if (distance > 0) {
      item.x += (dx / distance) * step;
      item.y += (dy / distance) * step;
    }
    if (item.leaving === "dive") {
      item.body.scale.set(Math.min(1, Math.max(0.2, distance / 200)));
      if (distance < SUN_RADIUS * 0.6) {
        flash = 1;
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

  function drawShip(item: Ship, dt: number) {
    const { body, hull, engine, entry } = item;
    const where = entry.placement;
    const speed = Math.hypot(item.vx, item.vy);
    body.position.set(item.x, item.y);
    if (speed > 3) body.rotation += turn(body.rotation, Math.atan2(item.vy, item.vx) + Math.PI / 2) * Math.min(1, dt * 6);

    const blink = Math.floor(time * 3) % 2 === 0;
    hull.tint = where.beacon && blink ? "#ff9d90" : where.action === "sleep" ? SPACE.sleep : "#ffffff";
    if (item.leaving !== "fade") body.alpha = where.action === "sleep" ? 0.75 : 1;
    const burning = where.working || speed > 30;
    engine.alpha = burning ? 0.75 + 0.25 * Math.sin(time * 18 + item.x) : 0.08;
    engine.tint = where.fixing ? SPACE.fix : FLEET[entry.task.executor].engine;

    if (speed > 60) {
      const color = where.fixing ? SPACE.fix : FLEET[entry.task.executor].engine;
      for (let i = 1; i <= 7; i++) {
        const back = item.size * 0.5 + i * 9;
        systemFx.circle(item.x - (item.vx / speed) * back, item.y - (item.vy / speed) * back, 3.4 - i * 0.35);
        systemFx.fill({ color, alpha: 0.5 - i * 0.06 });
      }
    }
    if (where.beacon) {
      const pulse = (time * 0.7) % 1;
      systemFx.circle(item.x, item.y, item.size * (0.7 + pulse * 0.8));
      systemFx.stroke({ width: 2.5, color: SPACE.alarm, alpha: 1 - pulse });
    }
    if (item.slug === selected || item.slug === hovered) {
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

  // Frames ----------------------------------------------------------------------------------------

  function drawDust() {
    dust.clear();
    if (still) return;
    const count = Math.round((viewport.width * viewport.height) / 16000);
    for (let band = 0; band < 3; band++) {
      for (let i = band; i < count; i += 3) {
        if (Math.sin(time * (0.5 + noise(i + 11)) + i) > 0.3) {
          dust.circle(noise(i + 300) * viewport.width, noise(i + 600) * viewport.height, 0.7 + band * 0.3);
        }
      }
      dust.fill({ color: SPACE.star, alpha: 0.35 + band * 0.25 });
    }
  }

  function frameGalaxy() {
    galaxyFx.clear();
    for (const line of model.lines) {
      const depot = model.depots.find((item) => item.key === line.depot);
      const from = depotPoints.get(line.depot);
      const to = stars.get(line.repo);
      if (!depot || !from || !to || !line.active || depot.bad) continue;
      for (const lag of [0, 0.5]) {
        const u = (time * 0.14 + lag + (hashName(line.repo + line.depot) % 100) / 100) % 1;
        galaxyFx.circle(from.x + (to.x - from.x) * u, from.y + (to.y - from.y) * u, 3.5);
        galaxyFx.fill(FLEET[depot.executor].hull);
      }
    }
    for (const star of model.stars) {
      const point = stars.get(star.repo);
      if (!point) continue;
      const radius = starRadius(star.live);
      star.dots.forEach((dot, index) => {
        const ring = radius * 1.25 + 16 + (index % 2) * 10;
        const angle = (still ? 0 : time * (dot.state === "work" ? 0.45 : 0.08)) + (index * Math.PI * 2) / star.dots.length;
        const color = dot.state === "attention" ? SPACE.alarm : dot.state === "ready" ? SPACE.gold : dot.state === "sleep" ? SPACE.sleep : FLEET[dot.executor].hull;
        galaxyFx.circle(point.x + ring * Math.cos(angle), point.y + ring * 0.72 * Math.sin(angle), 4.5);
        galaxyFx.fill(color);
      });
      if (star.attention) {
        const pulse = (time * 0.6) % 1;
        galaxyFx.circle(point.x, point.y, radius * 1.25 + 30 + pulse * 14);
        galaxyFx.stroke({ width: 2.5, color: SPACE.alarm, alpha: 0.9 * (1 - pulse) });
      }
    }
  }

  function frameSystem(dt: number) {
    const entries = [...ships.values()];
    const here = (place: Place) => entries.filter((item) => item.entry.placement.place === place && !item.leaving);
    const on = Math.sin(time * 5) > 0;

    if (!still) sun.rotation += dt * 0.012;
    corona.alpha = 0.34 + 0.06 * Math.sin(time * 1.1) + flash * 0.6;
    corona.scale.set((SUN_RADIUS * 7 * (1 + flash * 0.35)) / 128);
    flash = Math.max(0, flash - dt * 1.4);

    const running = here("gate").some((item) => item.entry.placement.placeWorking);
    const failed = here("gate").some((item) => item.entry.task.ci === "failed");
    if (running && !still) gate.rotation += dt * 0.5;
    gate.tint = failed ? "#ff9d90" : "#ffffff";
    gateGlow.tint = failed ? SPACE.alarm : SPACE.gold;
    gateGlow.alpha = running || failed ? 0.45 + 0.2 * Math.sin(time * 3) : 0.06;

    beams.clear();
    const range = stationAt("range", frame);
    for (const item of here("range")) {
      if (!item.entry.placement.placeWorking) continue;
      beams.moveTo(range.x, range.y).lineTo(item.x, item.y);
      beams.stroke({ width: 1.6, color: SPACE.fix, alpha: on ? 0.75 : 0.25 });
    }
    const inspection = stationAt("inspection", frame);
    for (const item of here("inspection")) {
      const { companion, placeWorking } = item.entry.placement;
      if (!placeWorking) continue;
      beams.moveTo(inspection.x, inspection.y).lineTo(item.x, item.y);
      beams.stroke({ width: 1.6, color: companion ? FLEET[companion].hull : SPACE.route, alpha: on ? 0.75 : 0.3 });
    }

    systemFx.clear();
    for (const item of entries) {
      moveShip(item, dt);
      if (ships.has(item.slug)) drawShip(item, dt);
    }
  }

  function place(container: Container, view: Camera) {
    container.scale.set(view.zoom);
    container.position.set(view.tx, view.ty);
  }

  function onFrame(elapsed: number) {
    // Ships take small steps after a pause; the flight keeps to real time, so it ends even in a slow tab.
    const dt = Math.min(elapsed, 0.1);
    time += dt;
    const goal = repo ? 1 : 0;
    const step = still ? 1 : elapsed / FLIGHT_SECONDS;
    flight = goal > flight ? Math.min(goal, flight + step) : Math.max(goal, flight - step);

    drawDust();
    const inGalaxy = flight < FALL;
    // The veil is opaque at the turn of the flight, so the skies change unseen.
    galaxy.visible = backdrop.visible = inGalaxy;
    system.visible = systemBackdrop.visible = !inGalaxy;
    let veilAlpha: number;
    if (inGalaxy) {
      const u = flight / FALL;
      const star = (focus && stars.get(focus)) || { x: world.width / 2, y: world.height / 2 };
      const zoom = fit.zoom * (1 + u * u * 5);
      const screen = { x: star.x * fit.zoom + fit.tx, y: star.y * fit.zoom + fit.ty };
      const target = { x: screen.x + (viewport.width / 2 - screen.x) * u, y: screen.y + (viewport.height / 2 - screen.y) * u };
      place(galaxy, { zoom, tx: target.x - star.x * zoom, ty: target.y - star.y * zoom });
      frameGalaxy();
      veilAlpha = u * u;
    } else {
      const v = (flight - FALL) / (1 - FALL);
      const zoom = camera.zoom * (0.82 + 0.18 * v);
      const middle = { x: viewport.width / 2, y: viewport.height / 2 };
      place(system, { zoom, tx: middle.x - ((middle.x - camera.tx) / camera.zoom) * zoom, ty: middle.y - ((middle.y - camera.ty) / camera.zoom) * zoom });
      frameSystem(dt);
      veilAlpha = 1 - v;
    }
    veil.clear();
    if (veilAlpha > 0) veil.rect(0, 0, viewport.width, viewport.height).fill({ color: SPACE.void, alpha: veilAlpha });

    // The sky drifts a little behind the camera.
    const view = repo ? camera : fit;
    const sky = inGalaxy ? backdrop : systemBackdrop;
    sky.position.set(viewport.width / 2 + (view.tx - fit.tx) * 0.06, viewport.height / 2 + (view.ty - fit.ty) * 0.06);
  }

  // Pointer ---------------------------------------------------------------------------------------

  function screenPoint(event: MouseEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function worldPoint(screen: Point): Point {
    const view = repo ? camera : fit;
    return { x: (screen.x - view.tx) / view.zoom, y: (screen.y - view.ty) / view.zoom };
  }

  function starAt(point: Point): string | null {
    for (const star of model.stars) {
      const at = stars.get(star.repo);
      if (at && Math.hypot(at.x - point.x, at.y - point.y) < starRadius(star.live) * 1.25 + 34) return star.repo;
    }
    return null;
  }

  function shipAt(point: Point): string | null {
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const item of ships.values()) {
      const distance = Math.hypot(item.x - point.x, item.y - point.y);
      if (!item.leaving && distance < item.size * 0.7 && distance < bestDistance) {
        bestDistance = distance;
        best = item.slug;
      }
    }
    return best;
  }

  let press: { at: Point; camera: Camera; dragged: boolean } | null = null;

  const onDown = (event: PointerEvent) => {
    press = { at: screenPoint(event), camera, dragged: false };
    canvas.setPointerCapture(event.pointerId);
  };

  let lastHover: string | null = null;
  const onMove = (event: PointerEvent) => {
    const at = screenPoint(event);
    if (press) {
      const dx = at.x - press.at.x;
      const dy = at.y - press.at.y;
      if (Math.hypot(dx, dy) > CLICK_SLOP) press.dragged = true;
      if (press.dragged && repo) {
        camera = clampCamera({ ...press.camera, tx: press.camera.tx + dx, ty: press.camera.ty + dy }, world, viewport);
        report();
      }
      return;
    }
    const point = worldPoint(at);
    const found = repo ? shipAt(point) : starAt(point);
    canvas.style.cursor = found ? "pointer" : repo && camera.zoom > fit.zoom ? "grab" : "";
    const slug = repo ? found : null;
    if (slug !== lastHover) {
      lastHover = slug;
      options.onHover(slug);
    }
  };

  const onUp = (event: PointerEvent) => {
    const wasDragged = press?.dragged ?? true;
    press = null;
    if (wasDragged) return;
    const point = worldPoint(screenPoint(event));
    if (repo) {
      const slug = shipAt(point);
      if (slug) options.onPick(slug);
      return;
    }
    const star = starAt(point);
    if (star) options.onEnter(star);
  };

  const onCancel = () => {
    press = null;
  };

  // In a system the wheel zooms; past the fitted view it goes back to the galaxy. In the galaxy, forward
  // over a star enters it.
  let wheel = 0;
  let wheelAt = 0;
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const nowMs = performance.now();
    if (nowMs - wheelAt < WHEEL_PAUSE_MS) return;
    const at = screenPoint(event);
    if (repo && (event.deltaY < 0 || camera.zoom > fit.zoom * 1.001)) {
      wheel = 0;
      camera = clampCamera(zoomCamera(camera, Math.exp(-event.deltaY * WHEEL_ZOOM), at, fit), world, viewport);
      report();
      return;
    }
    wheel += event.deltaY;
    if (Math.abs(wheel) < WHEEL_STEP) return;
    const forward = wheel < 0;
    wheel = 0;
    if (repo && !forward) {
      wheelAt = nowMs;
      options.onLeave();
    } else if (!repo && forward) {
      const star = starAt(worldPoint(at));
      if (star) {
        wheelAt = nowMs;
        options.onEnter(star);
      }
    }
  };

  const onContextLost = (event: Event) => {
    event.preventDefault();
    options.onLost();
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("webglcontextlost", onContextLost);

  const resize = new ResizeObserver(() => {
    const next = viewportOf();
    if (next.width === viewport.width && next.height === viewport.height) return;
    viewport = next;
    app.renderer.resize(viewport.width, viewport.height);
    layoutAll();
  });
  resize.observe(options.host);

  layoutAll();
  app.ticker.add((ticker) => onFrame(ticker.elapsedMS / 1000));

  return {
    setGalaxy(next) {
      model = next;
      drawGalaxy();
    },
    setView(next) {
      if (next === repo) return;
      if (next !== null) {
        clearShips();
        focus = next;
        camera = fit;
        paintSun(sun, next);
        corona.tint = sunKind(next).glow;
        showSky(next);
      }
      repo = next;
      lastHover = null;
      report();
    },
    setShips,
    setSelected(slug) {
      selected = slug;
    },
    setHovered(slug) {
      hovered = slug;
    },
    setActive(active) {
      if (active) app.start();
      else app.stop();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      resize.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      // The textures stay in the Assets cache for the next scene.
      app.destroy({ removeView: true }, { children: true });
      glowTexture.destroy(true);
    },
  };
}
