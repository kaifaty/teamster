// The map in PixiJS: a galaxy of repositories and a star system per repository, in painted art at the full
// resolution of the screen. Labels are HTML in MapView; the scene draws, moves the camera and reports what the
// pointer does.

import { Application, Assets, ColorMatrixFilter, Container, Graphics, Sprite, Texture, type ColorMatrix } from "pixi.js";
import type { ArtIndex, TaskSummary } from "../types";
import { ART, BACKDROPS, type ArtName } from "./art";
import type { Depot, Family, Hull, Star, SupplyLine } from "./fleet";
import { HULL_SIZE, depotEmpty, depotPositions, hullOf, patchSpots } from "./fleet";
import {
  ROUTE,
  STATIONS,
  SUN_CLEARANCE,
  SUN_RADIUS,
  LIGHT_SHIP,
  RESEARCH_SIZE,
  clampCamera,
  fitCamera,
  hashName,
  ringPoint,
  ringsOf,
  researchPosition,
  skyChoices,
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
import { departureOf } from "./replay";

export interface ShipEntry {
  task: TaskSummary;
  placement: Placement;
}

/** What the research station shows: see research.ts. */
export interface ResearchMarks {
  running: boolean;
  /** Lessons that wait for a decision. */
  proposed: number;
  watched: { repo: string; count: number }[];
  probes: string[];
}

export interface GalaxyModel {
  stars: Star[];
  depots: Depot[];
  lines: SupplyLine[];
  /** null: no station, the server tells nothing about research. */
  research: ResearchMarks | null;
}

export interface SceneOptions {
  host: HTMLElement;
  onEnter: (repo: string) => void;
  onLeave: () => void;
  onPick: (slug: string) => void;
  onHover: (slug: string | null) => void;
  /** The research station was clicked. */
  onResearch: () => void;
  /** The world's shape and the camera over it, for the labels. */
  onCamera: (world: Size, camera: Camera) => void;
  onLost: () => void;
}

export interface FleetScene {
  setGalaxy(model: GalaxyModel): void;
  /** The repositories' own pictures; whatever is missing stays shared art. */
  setArt(art: ArtIndex): void;
  /** Shows system `repo`, or the galaxy for null, flying there unless motion is reduced. */
  setView(repo: string | null): void;
  /**
   * The ships to show. A ship missing from `entries` leaves: by `departures` when given (a slug it lacks fades),
   * otherwise into the sun from the roadstead and fading from anywhere else.
   */
  setShips(entries: ShipEntry[], departures?: ReadonlyMap<string, "dive" | "fade">): void;
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
const DEPOT_SIZE = 116;
const TANKER_SIZE = 40;
/** World units a tanker covers in a second. */
const TANKER_SPEED = 46;
const ESCORT_SIZE = 30;
const PROBE_SIZE = 40;
/** World units a probe covers in a second. */
const PROBE_SPEED = 120;
/** Smoke puffs shared by all damaged ships: no puff is made after the scene starts. */
const SMOKE_PUFFS = 160;
/** Seconds between two puffs of one damaged ship, and how long a puff lives. */
const PUFF_EVERY = 0.15;
const PUFF_LIFE = 1.7;
/** Pixels the pointer may move and still make a click. */
const CLICK_SLOP = 5;
const WHEEL_ZOOM = 0.0016;
const WHEEL_STEP = 80;
const WHEEL_PAUSE_MS = 900;
/** The art is cropped a little wider than the ball, to keep its glow; see art/prepare.py. */
const BALL_MARGIN = 1.04;
const SUN_MARGIN = 1.5;

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

/** A drone that circles a ship while it is under review, tinted for the reviewer's family. */
interface Escort {
  sprite: Sprite;
  angle: number;
  /** 0 to 1: the drone fades in, and out when the review ends. */
  shown: number;
  /** World units the drone has drifted out after the review ended. */
  out: number;
  leaving: boolean;
}

interface Ship {
  slug: string;
  body: Container;
  hull: Sprite;
  engine: Sprite;
  /** Plates of the fix rounds, drawn on the hull. */
  patches: Graphics;
  /** The red glow of a ship whose CI failed. */
  burn: Sprite;
  kind: Hull;
  size: number;
  /** The fix rounds the patches show. */
  patched: number;
  /** Stable per ship: when it sparks, and where it smokes and sparks, in shares of its size. */
  seed: number;
  hit: Point;
  sparkAt: Point;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** The ship's ring, its starting angle there, and where it is on it now. */
  radius: number;
  base: number;
  angle: number;
  /** The station and ring the angle belongs to; a new one sends the ship to its new place. */
  ring: string;
  /** False until the ship has a ring: a ship that does not fly in starts on it. */
  placed: boolean;
  arrive: boolean;
  /** Seconds to the next smoke puff. */
  smoke: number;
  escort: Escort | null;
  entry: ShipEntry;
  /** Set for a ship that left the map: it dives into the sun or fades out. */
  leaving: "dive" | "fade" | null;
}

interface Puff {
  sprite: Sprite;
  owner: Ship | null;
  /** Offset from the owner's centre, so that the smoke goes with the ship. */
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  age: number;
  size: number;
}

interface Storm {
  point: Point;
  radius: number;
  seed: number;
  layers: Sprite[];
  flash: Sprite;
}

/** The ship's own point of damage, in shares of its size from the centre, nose up. */
function damageSpot(seed: number): Point {
  return { x: (noise(seed) - 0.5) * 0.2, y: noise(seed + 1) * 0.28 - 0.1 };
}

/** A point of a ship's art in the world: `local` in shares of its size, turned with the ship. */
function onHull(item: { x: number; y: number; size: number; body: Container }, local: Point, out: Point): Point {
  const cos = Math.cos(item.body.rotation);
  const sin = Math.sin(item.body.rotation);
  const scale = item.size * item.body.scale.x;
  out.x = item.x + (local.x * cos - local.y * sin) * scale;
  out.y = item.y + (local.x * sin + local.y * cos) * scale;
  return out;
}

/** A dark cloud with curling arms and a thinner eye, for a storm over a star; its rims catch a cold light. */
function stormCloud(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d")!;
  // A body that is thin over the star and dense around it.
  const body = context.createRadialGradient(128, 128, 0, 128, 128, 124);
  body.addColorStop(0, "rgba(14,10,22,0)");
  body.addColorStop(0.3, "rgba(14,10,22,0.08)");
  body.addColorStop(0.45, "rgba(20,15,30,0.5)");
  body.addColorStop(0.75, "rgba(24,18,34,0.45)");
  body.addColorStop(1, "rgba(24,18,34,0)");
  context.fillStyle = body;
  context.fillRect(0, 0, 256, 256);
  // Spiral arms: a dark band each, soft-edged, with a thin lit rim along its outer side.
  const arm = (start: number, width: number, inner: number, outer: number, sweep: number) => {
    context.beginPath();
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      const angle = start + u * sweep;
      const distance = inner + (outer - inner) * u;
      const x = 128 + Math.cos(angle) * distance;
      const y = 128 + Math.sin(angle) * distance;
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.lineWidth = width;
    context.stroke();
  };
  context.lineCap = "round";
  context.lineJoin = "round";
  for (let i = 0; i < 4; i++) {
    const start = (i * Math.PI) / 2 + noise(i + 20) * 0.5;
    const sweep = 2.2 + noise(i + 30) * 0.8;
    context.filter = "blur(9px)";
    context.strokeStyle = "rgba(18,13,28,0.9)";
    arm(start, 38 - i * 3, 46, 116, sweep);
    arm(start, 38 - i * 3, 46, 116, sweep);
    context.filter = "blur(3px)";
    context.strokeStyle = "rgba(12,9,20,0.7)";
    arm(start, 14, 48, 114, sweep);
    context.filter = "blur(4px)";
    context.strokeStyle = "rgba(150,128,186,0.34)";
    arm(start - 0.16, 6, 60, 124, sweep);
  }
  context.filter = "none";
  return canvas;
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
  const stormTexture = Texture.from(stormCloud(), true);

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
  const tankerLayer = new Container();
  const starLayer = new Container();
  const stormLayer = new Container();
  const galaxyFx = new Graphics();
  const watchFx = new Graphics();
  const researchLayer = new Container();
  const probeLayer = new Container();
  galaxy.addChild(lanes, watchFx, depotLayer, tankerLayer, researchLayer, starLayer, stormLayer, probeLayer, galaxyFx);

  const system = new Container();
  const charts = new Graphics();
  const corona = glow("#ff9a3c", SUN_RADIUS * 7);
  const sun = sprite(art("sun"), SUN_RADIUS * 2 * SUN_MARGIN);
  const stationLayer = new Container();
  const gateGlow = glow(SPACE.gold, STATIONS.gate.radius * 2.4);
  const gate = sprite(art("gate"), STATIONS.gate.radius * 2.3);
  const beams = new Graphics();
  const shipLayer = new Container();
  const smokeLayer = new Container();
  const escortLayer = new Container();
  const systemFx = new Graphics();
  system.addChild(charts, corona, sun, stationLayer, gateGlow, gate, beams, shipLayer, smokeLayer, escortLayer, systemFx);
  const puffs: Puff[] = Array.from({ length: SMOKE_PUFFS }, () => {
    const made = sprite(glowTexture, 10);
    made.tint = SPACE.smoke;
    made.visible = false;
    smokeLayer.addChild(made);
    return { sprite: made, owner: null, ox: 0, oy: 0, vx: 0, vy: 0, age: 0, size: 0 };
  });
  let nextPuff = 0;

  const veil = new Graphics();
  app.stage.addChild(backdrop, systemBackdrop, dust, galaxy, system, veil);

  // State -----------------------------------------------------------------------------------------

  let world = worldSize(viewport);
  let fit = fitCamera(world, viewport);
  let camera = fit;
  let frame: SystemFrame = systemFrame(world);
  let model: GalaxyModel = { stars: [], depots: [], lines: [], research: null };
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
  let repoArt: ArtIndex = {};
  /** The focused system's own planet, in place of the shipyard's. */
  let home: Texture | null = null;
  /** Counts the times a system was dressed, so that a late picture does not land on the next one. */
  let dressing = 0;
  const ships = new Map<string, Ship>();
  const tankers = new Map<string, { sprite: Sprite; line: SupplyLine; seed: number }>();
  let blinks: Sprite[] = [];
  let station: { body: Sprite; halo: Sprite; beacon: Sprite } | null = null;
  const probes = new Map<string, { sprite: Container; seed: number }>();
  let storms: Storm[] = [];
  /** Scratch points, so that the frame makes no objects for its effects. */
  const spot: Point = { x: 0, y: 0 };
  const spot2: Point = { x: 0, y: 0 };

  const report = () => options.onCamera(world, repo ? camera : fit);

  // Drawing what changes rarely ---------------------------------------------------------------------

  function fitBackdrop(sky: Sprite) {
    const { width, height } = sky.texture;
    sky.scale.set(Math.max(viewport.width / width, viewport.height / height) * 1.15);
  }

  /** The first of `urls` that loads, or null. */
  async function firstTexture(urls: string[]): Promise<Texture | null> {
    for (const url of urls) {
      const texture = await Assets.load<Texture>(url).catch(() => null);
      if (texture) return texture;
    }
    return null;
  }

  /** Gives system `name` its sky and planet; shared art stands in until they load, and stays if they cannot. */
  function dressSystem(name: string) {
    const turn = ++dressing;
    const current = () => !disposed && turn === dressing;
    const own = repoArt[name];
    systemBackdrop.texture = art("nebula");
    fitBackdrop(systemBackdrop);
    void firstTexture(skyChoices(name, own?.sky, BACKDROPS)).then((texture) => {
      if (!texture || !current()) return;
      systemBackdrop.texture = texture;
      fitBackdrop(systemBackdrop);
    });
    home = null;
    drawStations();
    if (!own?.planet) return;
    void firstTexture([own.planet]).then((texture) => {
      if (!texture || !current()) return;
      home = texture;
      drawStations();
    });
  }

  function drawDepots() {
    depotLayer.removeChildren().forEach((child) => child.destroy());
    blinks = [];
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
      const low = depotEmpty(depot);
      if (depot.fuel) gauge.roundRect(left + 1, top + 1, ((width - 2) * depot.fuel) / 100, 7, 2).fill(low ? SPACE.alarm : FLEET[depot.executor].hull);
      depotLayer.addChild(body, gauge);
      if (low) {
        // An empty depot blinks a dim warning light.
        const light = glow(SPACE.empty, DEPOT_SIZE * 1.15);
        light.position.set(point.x, point.y);
        light.alpha = 0.16;
        depotLayer.addChild(light);
        blinks.push(light);
      }
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
    drawStorms();
  }

  /** A storm over every star with ships in trouble, kept above the star so that its label stays clear. */
  function drawStorms() {
    stormLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    storms = [];
    for (const star of model.stars) {
      const point = stars.get(star.repo);
      if (!point || !star.attention) continue;
      const radius = starRadius(star.live) * 1.25 + 62;
      const body = new Container();
      body.position.set(point.x, point.y - 14);
      body.scale.set(1, 0.72);
      const layers = [sprite(stormTexture, radius * 2), sprite(stormTexture, radius * 1.75)];
      layers[1]!.alpha = 0.8;
      layers[1]!.scale.x *= -1;
      const flash = glow(SPACE.lightning, radius * 1.6);
      flash.alpha = 0;
      body.addChild(...layers, flash);
      stormLayer.addChild(body);
      storms.push({ point: { x: point.x, y: point.y - 14 }, radius, seed: hashName(star.repo) % 997, layers, flash });
    }
  }

  /** One tanker on every active supply line; a line that stays keeps its tanker. */
  function syncTankers() {
    const wanted = new Map(model.lines.filter((line) => line.active).map((line) => [`${line.depot}|${line.repo}`, line]));
    for (const [key, tanker] of tankers) {
      if (wanted.has(key)) continue;
      tanker.sprite.destroy();
      tankers.delete(key);
    }
    for (const [key, line] of wanted) {
      const known = tankers.get(key);
      if (known) {
        known.line = line;
        continue;
      }
      const body = sprite(art("tanker"), TANKER_SIZE);
      tankerLayer.addChild(body);
      tankers.set(key, { sprite: body, line, seed: (hashName(key) % 100) / 100 });
    }
  }

  /** The research station in the middle of the galaxy: a teal glow, and a gold light while lessons wait. */
  function drawResearch() {
    researchLayer.removeChildren().forEach((child) => child.destroy());
    station = null;
    if (!model.research) return;
    const point = researchPosition(world);
    const halo = glow(SPACE.research, RESEARCH_SIZE * 2.6);
    const body = sprite(art("stationResearch"), RESEARCH_SIZE);
    const beacon = glow(SPACE.gold, RESEARCH_SIZE * 0.9);
    for (const part of [halo, body, beacon]) part.position.set(point.x, point.y);
    beacon.visible = model.research.proposed > 0;
    researchLayer.addChild(halo, body, beacon);
    station = { body, halo, beacon };
  }

  /** One probe for every system the running reflection reads. */
  function syncProbes() {
    const wanted = new Set(model.research?.probes ?? []);
    for (const [repoName, probe] of probes) {
      if (wanted.has(repoName)) continue;
      probe.sprite.destroy({ children: true });
      probes.delete(repoName);
    }
    for (const repoName of wanted) {
      if (probes.has(repoName)) continue;
      const body = new Container();
      const light = glow(SPACE.research, PROBE_SIZE * 1.6);
      light.alpha = 0.7;
      body.addChild(light, sprite(art("shipScout"), PROBE_SIZE));
      probeLayer.addChild(body);
      probes.set(repoName, { sprite: body, seed: (hashName(repoName) % 100) / 100 });
    }
  }

  function drawGalaxy() {
    stars = starPositions(model.stars.map((star) => star.repo), world);
    depotPoints = depotPositions(model.depots, world);
    drawLanes();
    drawDepots();
    drawStars();
    syncTankers();
    drawResearch();
    syncProbes();
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
    return sprite(place === "yard" && home ? home : art(name[place]), STATIONS[place].radius * 2 * BALL_MARGIN);
  }

  function drawStations() {
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

    drawStations();
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
      const point = ringPoint(stationAt(item.entry.placement.place, frame), item.radius, item.angle);
      item.x = point.x;
      item.y = point.y;
    }
    report();
  }

  // Ships -----------------------------------------------------------------------------------------

  function textureOf(family: Family, kind: Hull): Texture {
    switch (kind) {
      case "flagship":
        return art("flagship");
      case "scout":
        return art("shipScout");
      case "frigate":
        return art(family === "codex" ? "shipBlueFrigate" : "shipCopperFrigate");
      case "cruiser":
        return art(family === "codex" ? "shipBlueCruiser" : "shipCopperCruiser");
      default:
        return art(family === "codex" ? "shipBlue" : "shipCopper");
    }
  }

  /** Scouts and flagships keep the room of a light ship on their ring, as before the larger hulls. */
  const ringSize = (item: Ship) => (item.kind === "frigate" || item.kind === "cruiser" ? item.size : LIGHT_SHIP);

  /** Fits the ship's art to its task: the hull of its effort and family, and a patch per fix round. */
  function dress(item: Ship) {
    const { task } = item.entry;
    const kind = hullOf(task);
    const family = task.executor;
    const texture = textureOf(family, kind);
    if (kind !== item.kind || item.hull.texture !== texture) {
      item.kind = kind;
      item.size = HULL_SIZE[kind];
      item.hull.texture = texture;
      item.hull.scale.set(item.size / Math.max(texture.width, texture.height));
      item.engine.scale.set((item.size * 0.8) / 128);
      item.engine.position.set(0, item.size * 0.46);
      item.burn.scale.set((item.size * 0.8) / 128);
      item.burn.position.set(item.hit.x * item.size, item.hit.y * item.size);
      item.patched = -1;
    }
    if (item.patched === task.fix_round) return;
    item.patched = task.fix_round;
    const patches = item.patches.clear();
    const width = item.size * 0.13;
    const height = item.size * 0.09;
    for (const { x, y, angle } of patchSpots(task.slug, task.fix_round)) {
      const cx = x * item.size;
      const cy = y * item.size;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const at = (u: number, v: number) => [cx + u * cos - v * sin, cy + u * sin + v * cos] as const;
      const corners = [at(-width / 2, -height / 2), at(width / 2, -height / 2), at(width / 2, height / 2), at(-width / 2, height / 2)];
      patches.poly(corners.flat()).fill(SPACE.plate).stroke({ width: 1, color: SPACE.seam, alpha: 0.9 });
      // A lit upper edge, so that the plate stands off the hull.
      const [a, b] = [at(-width / 2 + 1, -height / 2 + 1), at(width / 2 - 1, -height / 2 + 1)];
      patches.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke({ width: 0.8, color: SPACE.rivet, alpha: 0.6 });
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const [rx, ry] = at(u * (width / 2 - 1.6), v * (height / 2 - 1.6));
        patches.circle(rx, ry, 0.7);
      }
      patches.fill(SPACE.rivet);
    }
  }

  function addShip(entry: ShipEntry, arrive: boolean): Ship {
    const body = new Container();
    const engine = glow(FLEET[entry.task.executor].engine, 128);
    const hull = new Sprite(Texture.EMPTY);
    hull.anchor.set(0.5);
    const patches = new Graphics();
    const burn = glow(SPACE.burn, 128);
    burn.visible = false;
    body.addChild(engine, hull, patches, burn);
    shipLayer.addChild(body);
    const station = stationAt(entry.placement.place, frame);
    const item: Ship = {
      slug: entry.task.slug,
      body,
      hull,
      engine,
      patches,
      burn,
      kind: "light",
      size: HULL_SIZE.light,
      patched: -1,
      seed: hashName(entry.task.slug) % 1000,
      hit: damageSpot(hashName(entry.task.slug) % 1000),
      sparkAt: damageSpot((hashName(entry.task.slug) % 1000) + 3),
      x: arrive ? -160 : station.x,
      y: station.y,
      vx: 0,
      vy: 0,
      radius: 0,
      base: 0,
      angle: 0,
      ring: "",
      placed: false,
      arrive,
      smoke: 0,
      escort: null,
      entry,
      leaving: null,
    };
    dress(item);
    ships.set(item.slug, item);
    return item;
  }

  function dropEscort(item: Ship) {
    item.escort?.sprite.destroy();
    item.escort = null;
  }

  function removeShip(item: Ship) {
    dropEscort(item);
    item.body.destroy({ children: true });
    ships.delete(item.slug);
  }

  function clearShips() {
    for (const item of [...ships.values()]) removeShip(item);
  }

  /** Puts the ships of every station on their rings, larger hulls given more room. */
  function arrange() {
    const byPlace = new Map<Place, Ship[]>();
    for (const item of ships.values()) {
      if (item.leaving) continue;
      const list = byPlace.get(item.entry.placement.place) ?? [];
      list.push(item);
      byPlace.set(item.entry.placement.place, list);
    }
    for (const [place, list] of byPlace) {
      list.sort((a, b) => a.entry.placement.slot - b.entry.placement.slot);
      const rings = ringsOf(place, list.map(ringSize));
      list.forEach((item, index) => {
        const { radius, angle } = rings[index]!;
        const ring = `${place}|${radius}|${angle}`;
        if (ring !== item.ring) {
          item.ring = ring;
          item.radius = radius;
          item.base = angle;
          item.angle = angle;
        }
        if (!item.placed) {
          item.placed = true;
          if (!item.arrive) {
            const point = ringPoint(stationAt(place, frame), radius, angle);
            item.x = point.x;
            item.y = point.y;
            item.body.rotation = angle + Math.PI;
          }
        }
      });
    }
  }

  function setShips(entries: ShipEntry[], departures?: ReadonlyMap<string, "dive" | "fade">) {
    const known = new Set(entries.map((entry) => entry.task.slug));
    for (const item of [...ships.values()]) {
      if (known.has(item.slug) || item.leaving) continue;
      item.leaving = departureOf(item.slug, item.entry.placement.place, departures);
      if (still) removeShip(item);
    }
    const first = ships.size === 0;
    for (const entry of entries) {
      const item = ships.get(entry.task.slug);
      if (!item) {
        addShip(entry, !first && !still);
        continue;
      }
      item.entry = entry;
      item.leaving = null;
      dress(item);
    }
    arrange();
  }

  function moveShip(item: Ship, dt: number) {
    if (item.leaving === "fade") {
      item.body.alpha -= dt * 1.5;
      if (item.body.alpha <= 0) removeShip(item);
      return;
    }
    const { place, working } = item.entry.placement;
    let target: Point;
    if (item.leaving === "dive") {
      target = { x: frame.cx, y: frame.cy };
    } else {
      if (working && !still) item.angle += dt * CIRCLING_SPEED;
      target = ringPoint(stationAt(place, frame), item.radius, item.angle);
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
    item.patches.tint = hull.tint;
    const damaged = entry.task.ci === "failed";
    item.burn.visible = damaged;
    if (damaged) {
      // The glow of a fire under the plating flickers unevenly; still, it only glows.
      const flicker = still ? 0.5 : 0.5 + 0.3 * Math.sin(time * 11 + item.seed) * Math.sin(time * 6.7 + item.seed * 0.37) + 0.2 * noise(Math.floor(time * 9) + item.seed);
      item.burn.alpha = 0.35 + 0.5 * flicker;
      if (!still && !item.leaving) sparks(item);
    }
    escort(item, dt);
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

  /** Now and then a short burst of sparks from a damaged hull. */
  function sparks(item: Ship) {
    const period = 1.6 + noise(item.seed + 5) * 1.8;
    const cycle = Math.floor((time + item.seed) / period);
    const age = (time + item.seed) % period;
    if (age > 0.16) return;
    onHull(item, item.sparkAt, spot);
    const reach = item.size * (0.08 + age * 1.2);
    for (let i = 0; i < 4; i++) {
      const angle = noise(cycle * 7 + i + item.seed) * Math.PI * 2;
      const near = reach * 0.35;
      systemFx.moveTo(spot.x + Math.cos(angle) * near, spot.y + Math.sin(angle) * near);
      systemFx.lineTo(spot.x + Math.cos(angle) * reach, spot.y + Math.sin(angle) * reach);
    }
    systemFx.stroke({ width: 1.4, color: SPACE.spark, alpha: 1 - age / 0.16 });
  }

  /** The reviewer's drone: it circles a ship under review and drifts off fading when the review ends. */
  function escort(item: Ship, dt: number) {
    const { place, placeWorking, companion } = item.entry.placement;
    const reviewing = !item.leaving && place === "inspection" && placeWorking;
    if (reviewing && (!item.escort || item.escort.leaving)) {
      dropEscort(item);
      const body = sprite(art("escort"), ESCORT_SIZE);
      escortLayer.addChild(body);
      item.escort = { sprite: body, angle: noise(item.seed + 9) * Math.PI * 2, shown: still ? 1 : 0, out: 0, leaving: false };
    }
    const drone = item.escort;
    if (!drone) return;
    if (!reviewing && !drone.leaving) drone.leaving = true;
    if (drone.leaving) {
      if (still) return dropEscort(item);
      drone.shown -= dt * 1.1;
      drone.out += dt * 70;
      if (drone.shown <= 0) return dropEscort(item);
    } else {
      drone.shown = Math.min(1, drone.shown + dt * 2);
    }
    if (!still) drone.angle += dt * 1.4;
    const orbit = item.size * 0.62 + 16 + drone.out;
    const cos = Math.cos(drone.angle);
    const sin = Math.sin(drone.angle);
    drone.sprite.position.set(item.x + cos * orbit, item.y + sin * orbit * 0.8);
    // Nose along its path round the ship.
    drone.sprite.rotation = Math.atan2(cos * 0.8, -sin) + Math.PI / 2;
    drone.sprite.alpha = drone.shown * item.body.alpha;
    drone.sprite.tint = companion ? FLEET[companion].escort : "#ffffff";
  }

  /** Smoke from the damaged ships, from one pool of puffs; with reduced motion it hangs still. */
  function smoke(dt: number) {
    if (still) {
      let index = 0;
      for (const item of ships.values()) {
        if (item.entry.task.ci !== "failed" || item.leaving) continue;
        for (let k = 0; k < 3 && index < puffs.length; k++, index++) {
          const puff = puffs[index]!;
          onHull(item, item.hit, spot);
          const size = item.size * (0.3 + k * 0.12);
          puff.sprite.visible = true;
          puff.sprite.position.set(spot.x + k * size * 0.35, spot.y - k * size * 0.3);
          puff.sprite.scale.set(size / 128);
          puff.sprite.alpha = 0.5 - k * 0.12;
        }
      }
      for (; index < puffs.length; index++) puffs[index]!.sprite.visible = false;
      return;
    }
    for (const item of ships.values()) {
      if (item.entry.task.ci !== "failed" || item.leaving) continue;
      item.smoke -= dt;
      if (item.smoke > 0) continue;
      item.smoke += PUFF_EVERY * (0.7 + noise(time * 13 + item.seed) * 0.6);
      const puff = puffs[nextPuff]!;
      nextPuff = (nextPuff + 1) % puffs.length;
      onHull(item, item.hit, spot);
      // Drifts back from the nose, a little to either side.
      const back = item.body.rotation;
      const side = (noise(time * 31 + item.seed) - 0.5) * 16;
      puff.owner = item;
      puff.ox = spot.x - item.x;
      puff.oy = spot.y - item.y;
      puff.vx = -Math.sin(back) * 34 + Math.cos(back) * side;
      puff.vy = Math.cos(back) * 34 + Math.sin(back) * side;
      puff.age = 0;
      puff.size = item.size;
    }
    for (const puff of puffs) {
      const owner = puff.owner;
      if (!owner || owner.body.destroyed || puff.age >= PUFF_LIFE) {
        puff.owner = null;
        puff.sprite.visible = false;
        continue;
      }
      puff.age += dt;
      puff.ox += puff.vx * dt;
      puff.oy += puff.vy * dt;
      const u = puff.age / PUFF_LIFE;
      puff.sprite.visible = true;
      puff.sprite.position.set(owner.x + puff.ox, owner.y + puff.oy);
      puff.sprite.scale.set((puff.size * (0.2 + u * 0.7)) / 128);
      puff.sprite.alpha = 0.7 * (1 - u) * Math.min(1, u * 8) * owner.body.alpha;
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
    for (const { sprite: body, line, seed } of tankers.values()) {
      const from = depotPoints.get(line.depot);
      const to = stars.get(line.repo);
      body.visible = !!from && !!to;
      if (!from || !to) continue;
      // From the depot's edge to the star's, nose ahead; it fades in on leaving and out on arrival.
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const start = DEPOT_SIZE / 2;
      const span = Math.max(1, length - start - 40);
      const u = still ? 0.5 : (seed + (time * TANKER_SPEED) / span) % 1;
      const d = start + span * u;
      body.position.set(from.x + ((to.x - from.x) * d) / length, from.y + ((to.y - from.y) * d) / length);
      body.rotation = Math.atan2(to.y - from.y, to.x - from.x) + Math.PI / 2;
      body.alpha = Math.min(1, u * 10, (1 - u) * 8);
    }
    blinks.forEach((light, index) => {
      light.alpha = still ? 0.16 : 0.04 + 0.22 * Math.max(0, Math.sin(time * 2.2 + index * 1.3)) ** 2;
    });
    for (const storm of storms) {
      const [outer, inner] = storm.layers;
      outer!.rotation = still ? storm.seed : storm.seed + time * 0.22;
      inner!.rotation = still ? -storm.seed : -storm.seed - time * 0.36;
      storm.flash.alpha = 0;
      outer!.tint = inner!.tint = "#ffffff";
      if (!still) lightning(storm);
    }
    frameResearch();
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
    }
  }

  /**
   * The station breathes while the reflection runs, its gold light blinks while lessons wait, a pulse runs
   * along a beam to every system with records for the next reflection, and probes fly to the systems it reads.
   */
  function frameResearch() {
    watchFx.clear();
    const marks = model.research;
    if (!marks || !station) return;
    const center = researchPosition(world);
    const { body, halo, beacon } = station;
    if (marks.running && !still) body.rotation = time * 0.12;
    halo.alpha = marks.running ? (still ? 0.5 : 0.38 + 0.18 * Math.sin(time * 2.4)) : 0.16;
    beacon.alpha = still ? 0.35 : 0.08 + 0.4 * Math.max(0, Math.sin(time * 1.8)) ** 2;
    for (const { repo: name, count } of marks.watched) {
      const to = stars.get(name);
      if (!to) continue;
      const length = Math.hypot(to.x - center.x, to.y - center.y);
      const end = length - starRadius(model.stars.find((star) => star.repo === name)?.live ?? 0) * 1.25 - 18;
      const size = 2.2 + Math.min(count, 4) * 0.45;
      const start = RESEARCH_SIZE * 0.55;
      if (end <= start) continue;
      watchFx.moveTo(center.x + ((to.x - center.x) * start) / length, center.y + ((to.y - center.y) * start) / length);
      watchFx.lineTo(center.x + ((to.x - center.x) * end) / length, center.y + ((to.y - center.y) * end) / length);
      watchFx.stroke({ width: 1.4, color: SPACE.research, alpha: 0.22 });
      for (let d = start; d < end; d += 13) {
        // A wave runs outwards along the beam, from the station to the star.
        const wave = still ? 0.5 : Math.max(0, Math.sin(d / 46 - time * 2.6)) ** 3;
        watchFx.circle(center.x + ((to.x - center.x) * d) / length, center.y + ((to.y - center.y) * d) / length, size * (0.7 + 0.5 * wave));
        watchFx.fill({ color: SPACE.research, alpha: 0.3 + 0.65 * wave });
      }
    }
    for (const [name, { sprite: probe, seed }] of probes) {
      const to = stars.get(name);
      probe.visible = !!to;
      if (!to) continue;
      // Out to the star and back, nose ahead; it fades at both ends.
      const length = Math.hypot(to.x - center.x, to.y - center.y);
      const start = RESEARCH_SIZE * 0.45;
      const span = Math.max(1, length - start - 46);
      const cycle = still ? 0.25 : (seed + (time * PROBE_SPEED) / (span * 2)) % 1;
      const out = cycle < 0.5;
      const u = out ? cycle * 2 : (1 - cycle) * 2;
      const d = start + span * u;
      probe.position.set(center.x + ((to.x - center.x) * d) / length, center.y + ((to.y - center.y) * d) / length);
      probe.rotation = Math.atan2(to.y - center.y, to.x - center.x) + (out ? Math.PI / 2 : -Math.PI / 2);
      probe.alpha = Math.min(1, u * 8, (1 - u) * 6 + 0.25);
    }
  }

  /** A rare flash in a storm: a forked bolt across the cloud that lights it up for a moment. */
  function lightning(storm: Storm) {
    const period = 2.4 + noise(storm.seed) * 2.2;
    const cycle = Math.floor((time + storm.seed) / period);
    const age = (time + storm.seed) % period;
    if (age > 0.22) return;
    // Two quick strokes in one flash.
    const strength = age < 0.07 ? 1 - age / 0.07 : age > 0.11 && age < 0.18 ? 0.7 : 0;
    if (strength <= 0) return;
    storm.flash.alpha = 0.35 * strength;
    storm.layers[0]!.tint = storm.layers[1]!.tint = "#b9a8d8";
    const { point, radius } = storm;
    const angle = noise(cycle + storm.seed * 3) * Math.PI * 2;
    spot.x = point.x + Math.cos(angle) * radius * 0.75;
    spot.y = point.y + Math.sin(angle) * radius * 0.75 * 0.72;
    galaxyFx.moveTo(spot.x, spot.y);
    for (let i = 1; i <= 4; i++) {
      const toward = angle + Math.PI + (noise(cycle * 5 + i + storm.seed) - 0.5) * 1.1;
      spot.x += Math.cos(toward) * radius * 0.2;
      spot.y += Math.sin(toward) * radius * 0.2 * 0.72;
      galaxyFx.lineTo(spot.x, spot.y);
      if (i === 2) {
        spot2.x = spot.x;
        spot2.y = spot.y;
      }
    }
    galaxyFx.stroke({ width: 1.8, color: SPACE.lightning, alpha: 0.9 * strength });
    // A short fork from the second bend.
    const fork = angle + Math.PI + (noise(cycle + 77) > 0.5 ? 0.9 : -0.9);
    galaxyFx.moveTo(spot2.x, spot2.y).lineTo(spot2.x + Math.cos(fork) * radius * 0.25, spot2.y + Math.sin(fork) * radius * 0.25 * 0.72);
    galaxyFx.stroke({ width: 1.1, color: SPACE.lightning, alpha: 0.7 * strength });
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
    smoke(dt);
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

  function researchAt(point: Point): boolean {
    if (!model.research) return false;
    const center = researchPosition(world);
    return Math.hypot(center.x - point.x, center.y - point.y) < RESEARCH_SIZE * 0.5;
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
    const found = repo ? shipAt(point) : (starAt(point) ?? (researchAt(point) ? "research" : null));
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
    else if (researchAt(point)) options.onResearch();
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
    setArt(next) {
      repoArt = next;
      if (focus) dressSystem(focus);
    },
    setView(next) {
      if (next === repo) return;
      if (next !== null) {
        clearShips();
        focus = next;
        camera = fit;
        paintSun(sun, next);
        corona.tint = sunKind(next).glow;
        dressSystem(next);
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
      stormTexture.destroy(true);
    },
  };
}
