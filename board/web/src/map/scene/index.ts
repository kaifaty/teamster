// The map in PixiJS: a galaxy of repositories and a star system per repository, in painted art at the full
// resolution of the screen. Labels are HTML in MapView; the scene draws, moves the camera and reports what the
// pointer does.

import { AlphaFilter, Application, Assets, ColorMatrixFilter, Container, Graphics, Sprite, Texture, type ColorMatrix } from "pixi.js";
import type { ArtIndex, MachineStatus } from "../../types";
import { BACKDROPS, type ArtName } from "../art";
import type { Family, Hull } from "../fleet";
import { DAY_LAMPS, HULL_SIZE, hullOf, patchSpots } from "../fleet";
import {
  BADGE_RISE,
  CHECKPOINT,
  LAMP_GAP,
  LAMP_WIDTH,
  NO_INSETS,
  ROUTE,
  STATIONS,
  SUN_CLEARANCE,
  SUN_RADIUS,
  RESEARCH_SIZE,
  TANK_ASPECT,
  TANK_GLASS,
  hashName,
  homeWorld,
  inCheckpoint,
  lanesOf,
  parkingOf,
  parkingOrder,
  researchPosition,
  skyChoices,
  starSize,
  stormRadius,
  stationAt,
  stationOf,
  systemFrame,
  worldSize,
  type Camera,
  type Insets,
  type Point,
  type Size,
  type SystemFrame,
} from "../layout";
import { FLEET, RINGS, SPACE, SUN_KINDS } from "../palette";
import type { Place } from "../placement";
import { departureOf } from "../replay";
import { createCamera } from "./camera";
import { createInput, listen } from "./input";
import { createKit } from "./kit";
import { curvePoint, damageSpot, noise, onHull, turn } from "./math";
import { FLIGHT_SECONDS, type FleetScene, type GalaxyModel, type SceneOptions, type ShipEntry } from "./types";

export * from "./types";

/** The share of the flight spent falling towards the star; the rest brings up the system. */
const FALL = 0.55;
const MAX_SPEED = 300;
/** A working ship hovers this far around its berth, in world units, this fast. */
const HOVER = 3;
const HOVER_SPEED = 1.3;
/** The glow of a machine's reactor by its status: its halo and its heart; an overloaded one pulses up to these. */
const MACHINE_GLOW: Partial<Record<MachineStatus, { halo: number; core: number }>> = {
  free: { halo: 0.5, core: 0.55 },
  busy: { halo: 0.8, core: 0.85 },
  overloaded: { halo: 1, core: 1 },
};
/** How long a ship shows the inspection's verdict as it leaves, in seconds. */
const VERDICT_SECONDS = 1.8;
/** A ship that goes back to the yard with findings carries one red mark per finding, at most this many. */
const MAX_FINDING_MARKS = 5;
const PROBE_SIZE = 40;
/** Gold rings around the science station while its analyst waits for an answer. */
const WAVE_RINGS = 3;
/** World units a probe covers in a second. */
const PROBE_SPEED = 120;
/** Smoke puffs shared by all damaged ships: no puff is made after the scene starts. */
const SMOKE_PUFFS = 160;
/** Seconds between two puffs of one damaged ship, and how long a puff lives. */
const PUFF_EVERY = 0.15;
const PUFF_LIFE = 1.7;
/** The art is cropped a little wider than the ball, to keep its glow; see art/prepare.py. */
const BALL_MARGIN = 1.04;
const SUN_MARGIN = 1.5;
/** The share of the camera's move the sky follows; the sky is 15% larger than the window, see fitBackdrop. */
const SKY_DRIFT = 0.1;

const ROUTE_BEND = 0.14;
const FIX_BEND = -0.07;

/** The art's brightness in pale blue: a tint on the sprite would not survive a filter. */
const COLD_STAR: ColorMatrix = [
  0.32, 0.62, 0.12, 0, 0,
  0.39, 0.77, 0.14, 0, 0,
  0.51, 1.0, 0.19, 0, 0,
  0, 0, 0, 1, 0,
];

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
  /** The ship's berth, from its station's centre; a stowed ship waits behind its station's count, unseen. */
  berth: Point;
  stowed: boolean;
  /** 0 to 1: how far the ship is shown; it fades as it is stowed and back as it gets a berth. */
  shown: number;
  /** False until the ship has a berth: a ship that does not fly in starts on it. */
  placed: boolean;
  /** On its way: it turns along its course; on its berth it turns to its station's side. */
  travelling: boolean;
  arrive: boolean;
  /** Seconds to the next smoke puff. */
  smoke: number;
  /** The ship stands in a lane of the inspection's frame, under its scanner. */
  lane: boolean;
  /** What the inspection found, shown for VERDICT_SECONDS as the ship leaves it; null after. */
  verdict: Verdict | null;
  entry: ShipEntry;
  /** Set for a ship that left the map: it dives into the sun or fades out. */
  leaving: "dive" | "fade" | null;
}

/** The inspection's verdict on a ship that leaves it: clean, or back to the yard with findings. */
interface Verdict {
  clean: boolean;
  /** Seconds since the ship left the inspection. */
  age: number;
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

export async function createFleetScene(options: SceneOptions): Promise<FleetScene> {
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
  const kit = await createKit();
  const { still, art, sprite, glow, glowTexture, cloudTexture, stormTexture, greyFilter } = kit;

  const canvas = app.canvas;
  canvas.className = "map-canvas";
  canvas.tabIndex = -1;
  options.host.prepend(canvas);

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
  const cloudLayer = new Container();
  const fuelLayer = new Container();
  const machineLayer = new Container();
  const starLayer = new Container();
  const stormLayer = new Container();
  const galaxyFx = new Graphics();
  const watchFx = new Graphics();
  const researchLayer = new Container();
  const probeLayer = new Container();
  galaxy.addChild(cloudLayer, watchFx, fuelLayer, machineLayer, researchLayer, starLayer, stormLayer, probeLayer, galaxyFx);

  const system = new Container();
  /** The repository's own planet, its home world, behind everything else at the system's left edge. */
  const homeBody = new Sprite(Texture.EMPTY);
  homeBody.anchor.set(0.5);
  const charts = new Graphics();
  const corona = glow("#ff9a3c", SUN_RADIUS * 7);
  const sun = sprite(art("sun"), SUN_RADIUS * 2 * SUN_MARGIN);
  const stationLayer = new Container();
  const gateGlow = glow(SPACE.gold, STATIONS.gate.radius * 2.4);
  const gate = sprite(art("gate"), STATIONS.gate.radius * 2.3);
  const beams = new Graphics();
  const shipLayer = new Container();
  const smokeLayer = new Container();
  const systemFx = new Graphics();
  system.addChild(homeBody, charts, corona, sun, stationLayer, gateGlow, gate, beams, shipLayer, smokeLayer, systemFx);
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

  const camera = createCamera(viewport, {
    still,
    now: () => performance.now(),
    flying: () => flight !== (repo ? 1 : 0),
    starAt: (point) => starAt(point),
    onEnter: (star) => options.onEnter(star),
    onLeave: () => options.onLeave(),
    onCamera: (worlds, view) => options.onCamera(worlds, view),
  });
  /** The parts of the window under the map's panels; a system is laid out in the rest. */
  let insets: Insets = NO_INSETS;
  let frame: SystemFrame = systemFrame(camera.systemWorld);
  let model: GalaxyModel = {
    stars: [],
    layout: { places: new Map(), spacing: 200, scale: 1, labelZoom: 0.75, world: worldSize(viewport), crowded: 0, groups: "" },
    tanks: [],
    fuel: null,
    constellations: [],
    research: null,
    machines: [],
    machineColumn: null,
  };
  let stars = new Map<string, Point>();
  let repo: string | null = null;
  let focus: string | null = null;
  let flight = 0;
  let time = 0;
  let flash = 0;
  let selected: string | null = null;
  let hovered: string | null = null;
  let disposed = false;
  let repoArt: ArtIndex = {};
  /** The focused system's own planet, its home world in place of the shared one. */
  let home: Texture | null = null;
  /** Counts the times a system was dressed, so that a late picture does not land on the next one. */
  let dressing = 0;
  const ships = new Map<string, Ship>();
  /** The warning lights of empty tanks, and the lamps of tanks that refill within a day: they blink. */
  let blinks: Sprite[] = [];
  let lampBlinks: Sprite[] = [];
  /** The glows of overloaded machines: they pulse like the light of an empty tank. */
  let alarms: Sprite[] = [];
  /** The rings of overloaded resources, which pulse too, and the reactors' cores, which turn faster the busier the CPU. */
  let hotRings: Graphics[] = [];
  let cores: { sprite: Sprite; speed: number; seed: number }[] = [];
  let machineSelected: string | null = null;
  let station: { body: Sprite; halo: Sprite; beacon: Sprite } | null = null;
  const probes = new Map<string, { sprite: Container; seed: number }>();
  let storms: Storm[] = [];
  /** Scratch points, so that the frame makes no objects for its effects. */
  const spot: Point = { x: 0, y: 0 };
  const spot2: Point = { x: 0, y: 0 };

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

  /**
   * A fuel tank for every subscription. The fuel stands in its glass as high as the week's limit left, in its family's
   * colour, red when little is left, and a warning light blinks beside an empty tank; a blocked one turns grey. The lamps
   * beside it burn one per day left until it refills, and the admiral's badge crowns the account kept for the
   * orchestrator, which new tasks skip.
   */
  function drawFuel() {
    fuelLayer.removeChildren().forEach((child) => child.destroy());
    blinks = [];
    lampBlinks = [];
    const column = model.fuel;
    if (!column) return;
    const size = column.size;
    const width = size * TANK_ASPECT;
    for (const tank of model.tanks) {
      const point = column.places.get(tank.key);
      if (!point) continue;
      const left = point.x - width / 2;
      const top = point.y - size / 2;
      if (tank.admiral) {
        const halo = glow(SPACE.gold, size * 1.3);
        halo.alpha = 0.3;
        halo.position.set(point.x, point.y);
        fuelLayer.addChild(halo);
      }
      if (tank.low) {
        const light = glow(SPACE.empty, size * 1.25);
        light.position.set(point.x, point.y);
        light.alpha = 0.16;
        fuelLayer.addChild(light);
        blinks.push(light);
      }
      const body = sprite(art("fuelTank"), size);
      body.position.set(point.x, point.y);
      if (tank.bad) body.filters = [greyFilter];
      fuelLayer.addChild(body);
      const glass = {
        x0: left + width * TANK_GLASS.x0,
        x1: left + width * TANK_GLASS.x1,
        y0: top + size * TANK_GLASS.y0,
        y1: top + size * TANK_GLASS.y1,
      };
      if (tank.fuel) {
        // The fuel from the bottom of the glass up, a bright line on its surface and a glow through the glass.
        const color = tank.low ? SPACE.alarm : FLEET[tank.executor].hull;
        const level = glass.y1 - ((glass.y1 - glass.y0) * Math.min(100, tank.fuel)) / 100;
        const liquid = new Graphics();
        const across = glass.x1 - glass.x0;
        liquid.roundRect(glass.x0, level, across, glass.y1 - level, Math.min(across * 0.3, (glass.y1 - level) / 2)).fill({ color, alpha: 0.82 });
        liquid.rect(glass.x0 + across * 0.12, level, across * 0.76, Math.max(1, size * 0.012)).fill({ color: "#ffffff", alpha: 0.6 });
        const shine = glow(color, Math.max(across * 2.2, (glass.y1 - level) * 1.1));
        shine.scale.x *= 0.55;
        shine.alpha = 0.45;
        shine.position.set((glass.x0 + glass.x1) / 2, (level + glass.y1) / 2);
        fuelLayer.addChild(liquid, shine);
      }
      // The day lamps, from the bottom up.
      const lamps = new Graphics();
      const lampX = left + width + size * LAMP_GAP + (size * LAMP_WIDTH) / 2;
      const radius = size * LAMP_WIDTH * 0.36;
      for (let day = 0; day < DAY_LAMPS; day++) {
        const y = glass.y1 - ((glass.y1 - glass.y0) * (day + 0.5)) / DAY_LAMPS;
        const lit = day < tank.lamps;
        lamps.circle(lampX, y, radius).fill(lit ? SPACE.gold : SPACE.gauge).stroke({ width: Math.max(0.6, radius * 0.35), color: "#000000", alpha: 0.6 });
        if (!lit) continue;
        const light = glow(SPACE.gold, radius * 5);
        light.position.set(lampX, y);
        light.alpha = 0.6;
        fuelLayer.addChild(light);
        if (tank.soon) lampBlinks.push(light);
      }
      fuelLayer.addChild(lamps);
      if (tank.admiral) {
        const badge = sprite(art("admiral"), size * 0.66);
        badge.position.set(point.x, top + size * (0.14 - BADGE_RISE));
        fuelLayer.addChild(badge);
      }
    }
  }

  /**
   * A reactor for every machine, in three rings, outside in: CPU, memory and the GPU. A ring's arc is the share in use and
   * its dark rest what is free; calm in its own colour, gold when busy, pulsing red when overloaded. A thin outer ring
   * shows the fullest disk while it runs low. The core's glow tells a free machine (green), a busy one (amber) and a
   * pulsing overloaded one (red), and it turns faster the busier the CPU; a machine without connection is grey, its last
   * numbers faint, one without data grey and faint. The open machine is marked like a selected ship.
   */
  function drawMachines() {
    machineLayer.removeChildren().forEach((child) => child.destroy());
    alarms = [];
    hotRings = [];
    cores = [];
    const column = model.machineColumn;
    if (!column) return;
    const size = column.size;
    // Three rings close together, room outside them for the disk's thin ring, and the core filling the middle.
    const width = size * 0.075;
    const step = width + size * 0.013;
    const outer = size / 2 - size * 0.04 - width / 2;
    const radii = { cpu: outer, memory: outer - step, gpu: outer - step * 2 } as const;
    const coreSize = (radii.gpu - width / 2 - size * 0.01) * 2;
    for (const machine of model.machines) {
      const point = column.places.get(machine.id);
      if (!point) continue;
      const faded = machine.status === "offline" || machine.status === "unknown";
      const color = machine.status === "free" ? SPACE.ok : machine.status === "busy" ? SPACE.fix : machine.status === "overloaded" ? SPACE.alarm : null;
      const glows = MACHINE_GLOW[machine.status];
      const halo = color && glows ? glow(color, size * 1.2) : null;
      if (halo) {
        halo.alpha = glows!.halo * 0.6;
        halo.position.set(point.x, point.y);
        machineLayer.addChild(halo);
      }
      const calm = new Graphics();
      const hot = new Graphics();
      let heated = false;
      const arc = (target: Graphics, radius: number, percent: number, line: number, tone: string, alpha: number) => {
        const start = -Math.PI / 2;
        const end = start + Math.PI * 2 * Math.max(0.015, Math.min(1, percent / 100));
        for (const [thick, shade] of [[line * 2.4, alpha * 0.22], [line, alpha]] as const) {
          target
            .moveTo(point.x + radius * Math.cos(start), point.y + radius * Math.sin(start))
            .arc(point.x, point.y, radius, start, end)
            .stroke({ width: thick, color: tone, alpha: shade, cap: "round" });
        }
      };
      for (const key of ["cpu", "memory", "gpu"] as const) {
        calm.circle(point.x, point.y, radii[key]).stroke({ width, color: SPACE.gauge, alpha: faded ? 0.5 : 0.9 });
        const ring = machine.rings[key];
        if (!ring) continue;
        const tone = faded ? SPACE.hover : ring.level === "bad" ? SPACE.alarm : ring.level === "warn" ? SPACE.gold : RINGS[key];
        const pulsing = ring.level === "bad" && !faded;
        heated ||= pulsing;
        arc(pulsing ? hot : calm, radii[key], ring.percent, width, tone, faded ? 0.3 : 1);
      }
      const disk = machine.rings.disk;
      if (disk && !faded) {
        const radius = size / 2 - size * 0.015;
        const line = size * 0.025;
        calm.circle(point.x, point.y, radius).stroke({ width: line, color: SPACE.gauge, alpha: 0.9 });
        heated ||= disk.level === "bad";
        arc(disk.level === "bad" ? hot : calm, radius, disk.percent, line, disk.level === "bad" ? SPACE.alarm : SPACE.gold, 1);
      }
      machineLayer.addChild(calm, hot);
      if (heated) hotRings.push(hot);
      // The reactor's core in the middle, its pale heart lit in the status's colour.
      const body = sprite(art("reactorCore"), coreSize);
      body.position.set(point.x, point.y);
      if (faded) body.filters = [greyFilter];
      if (machine.status === "unknown") body.alpha = 0.65;
      machineLayer.addChild(body);
      const busy = machine.rings.cpu?.percent ?? 0;
      cores.push({ sprite: body, speed: faded ? 0 : 0.04 + (busy / 100) * 0.9, seed: hashName(machine.id) % 6 });
      if (color && glows) {
        const heart = glow(color, coreSize * 0.75);
        heart.alpha = glows.core;
        heart.position.set(point.x, point.y);
        machineLayer.addChild(heart);
        if (machine.status === "overloaded") alarms.push(halo!, heart);
      }
      if (machine.id === machineSelected) {
        const mark = new Graphics();
        const half = size * 0.56;
        const armLength = half * 0.5;
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          const x = point.x + sx * half;
          const y = point.y + sy * half;
          mark.moveTo(x - sx * armLength, y).lineTo(x, y).lineTo(x, y - sy * armLength);
        }
        mark.stroke({ width: 2.2, color: SPACE.select, alpha: 0.95 });
        machineLayer.addChild(mark);
      }
    }
  }

  /**
   * A haze of the constellation's colour under its stars: a wide soft cloud around each of them, which run together where
   * the stars stand close, so that the haze takes the constellation's shape; and a faint glow over it.
   */
  function drawClouds() {
    cloudLayer.removeChildren().forEach((child) => child.destroy());
    const { spacing } = model.layout;
    for (const constellation of model.constellations) {
      // Drawn whole and then made faint, so that the clouds run together instead of piling up where they overlap.
      const haze = new Container();
      haze.filters = [new AlphaFilter({ alpha: 0.32 })];
      for (const name of constellation.repos) {
        const point = stars.get(name);
        if (!point) continue;
        const cloud = sprite(cloudTexture, spacing * 2.1);
        cloud.tint = constellation.color;
        cloud.position.set(point.x, point.y);
        const light = glow(constellation.color, spacing * 1.6);
        light.alpha = 0.35;
        light.position.set(point.x, point.y);
        haze.addChild(cloud);
        cloudLayer.addChild(light);
      }
      cloudLayer.addChildAt(haze, 0);
    }
  }

  function drawStars() {
    starLayer.removeChildren().forEach((child) => child.destroy());
    for (const star of model.stars) {
      const point = stars.get(star.repo);
      if (!point) continue;
      const radius = starSize(star.live, model.layout);
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
      const radius = stormRadius(star.live, model.layout);
      const lift = 14 * model.layout.scale;
      const body = new Container();
      body.position.set(point.x, point.y - lift);
      body.scale.set(1, 0.72);
      const layers = [sprite(stormTexture, radius * 2), sprite(stormTexture, radius * 1.75)];
      layers[1]!.alpha = 0.8;
      layers[1]!.scale.x *= -1;
      const flash = glow(SPACE.lightning, radius * 1.6);
      flash.alpha = 0;
      body.addChild(...layers, flash);
      stormLayer.addChild(body);
      storms.push({ point: { x: point.x, y: point.y - lift }, radius, seed: hashName(star.repo) % 997, layers, flash });
    }
  }

  /** The science station in the middle of the galaxy: a teal glow, and a gold light while lessons wait. */
  function drawResearch() {
    researchLayer.removeChildren().forEach((child) => child.destroy());
    station = null;
    if (!model.research) return;
    const point = researchPosition(camera.world, model.machineColumn, model.fuel);
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
    stars = model.layout.places;
    drawClouds();
    drawFuel();
    drawMachines();
    drawStars();
    drawResearch();
    syncProbes();
  }

  function stationSprite(place: Exclude<Place, "gate">): Sprite {
    const name: Record<typeof place, ArtName> = {
      yard: "stationYard",
      range: "planetRange",
      inspection: "stationInspection",
      roadstead: "planetRoadstead",
      cryo: "planetCryo",
      command: "stationCommand",
    };
    // The checkpoint's radius is half its art's height; the other stations' art is cropped a little wider.
    const size = stationOf(place, frame).radius * 2;
    return sprite(art(name[place]), place === "inspection" ? size : size * BALL_MARGIN);
  }

  function drawStations() {
    stationLayer.removeChildren().forEach((child) => child.destroy());
    for (const place of ["yard", "range", "inspection", "roadstead", "cryo", "command"] as const) {
      const body = stationSprite(place);
      const point = stationAt(place, frame);
      body.position.set(point.x, point.y);
      if (place === "yard") {
        // The dock's slipways open towards its ships.
        if (Math.cos((stationOf(place, frame).side * Math.PI) / 180) < 0) body.scale.x *= -1;
      } else if (place !== "command" && place !== "inspection") {
        // The art is lit from the upper left: mirror each planet so that its bright side faces the sun.
        if (point.x < frame.cx) body.scale.x *= -1;
        if (point.y < frame.cy) body.scale.y *= -1;
      }
      stationLayer.addChild(body);
    }
    drawHome();
  }

  /** The home world, mirrored so that its bright side faces the sun. */
  function drawHome() {
    const planet = homeWorld(frame);
    homeBody.texture = home ?? art("planetYard");
    homeBody.scale.set((planet.radius * 2 * BALL_MARGIN) / Math.max(homeBody.texture.width, homeBody.texture.height));
    homeBody.scale.x *= -1;
    homeBody.position.set(planet.x, planet.y);
  }

  function drawCharts() {
    charts.clear();
    const orbits = [...new Set(ROUTE.map((place) => STATIONS[place].orbit))];
    for (const orbit of orbits) charts.ellipse(frame.cx, frame.cy, orbit * frame.rx, orbit * frame.ry);
    charts.stroke({ width: 1.2, color: SPACE.orbit, alpha: 0.16 });

    // The routes run to the stations' centres; the open frame of the inspection would show them inside it.
    const dots = (a: Point, b: Point, bend: number, gap: number, radius: number) => {
      const steps = Math.round(Math.hypot(b.x - a.x, b.y - a.y) / gap);
      for (let i = 1; i < steps; i++) {
        const point = curvePoint(a, b, bend, i / steps);
        if (!inCheckpoint(point, frame)) charts.circle(point.x, point.y, radius);
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
    const gateRadius = stationOf("gate", frame).radius;
    gate.scale.set((gateRadius * 2.3) / Math.max(gate.texture.width, gate.texture.height));
    gateGlow.scale.set((gateRadius * 2.4) / Math.max(gateGlow.texture.width, gateGlow.texture.height));
    gate.position.set(point.x, point.y);
    gateGlow.position.copyFrom(gate.position);
    sun.position.set(frame.cx, frame.cy);
    corona.position.copyFrom(sun.position);
  }

  function layoutAll() {
    camera.layoutGalaxy(viewport);
    fitBackdrop(backdrop);
    fitBackdrop(systemBackdrop);
    drawGalaxy();
    layoutSystem();
  }

  /** Lays the system out in the free part of the window, its ships on their berths at once. */
  function layoutSystem() {
    camera.layoutSystem(insets);
    frame = systemFrame(camera.systemWorld);
    drawCharts();
    arrange();
    for (const item of ships.values()) {
      const point = berthPoint(item);
      item.x = point.x;
      item.y = point.y;
    }
    camera.report();
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
      berth: { x: 0, y: 0 },
      stowed: false,
      shown: 1,
      placed: false,
      travelling: arrive,
      arrive,
      smoke: 0,
      lane: false,
      verdict: null,
      entry,
      leaving: null,
    };
    dress(item);
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
      if (!still && !item.leaving && seen) sparks(item);
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
    if (where.fixing && task.review === "defects" && task.findings_left > 0 && seen) findingMarks(item, Math.min(task.findings_left, MAX_FINDING_MARKS));
    if (item.verdict) verdictFx(item, dt);
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

  /**
   * The checkpoint's scanner over a ship in its lane, in the reviewer's colour: the lane lit faintly, and a beam from
   * the lenses on one side of the frame to those on the other that sweeps up and down the hull.
   */
  function scan(item: Ship) {
    const { companion } = item.entry.placement;
    const color = companion ? FLEET[companion].hull : SPACE.route;
    const station = stationAt("inspection", frame);
    const radius = stationOf("inspection", frame).radius;
    const pitch = (2 * radius * CHECKPOINT.inside.y) / lanesOf(frame).length;
    const reach = radius * CHECKPOINT.inside.x;
    const lane = station.y + item.berth.y;
    systemFx.rect(station.x - reach, lane - pitch / 2 + 2, reach * 2, pitch - 4);
    systemFx.fill({ color, alpha: 0.08 });
    const phase = time * 2.2 + item.seed;
    const y = lane + (still ? 0.3 : Math.sin(phase)) * pitch * 0.36;
    // A short fading trail behind the beam, against its way.
    const back = still ? 0 : -Math.sign(Math.cos(phase));
    for (let i = 1; i <= 3; i++) {
      systemFx.moveTo(station.x - reach, y + back * i * 2.4).lineTo(station.x + reach, y + back * i * 2.4);
      systemFx.stroke({ width: 1.2, color, alpha: 0.4 - i * 0.1 });
    }
    systemFx.moveTo(station.x - reach, y).lineTo(station.x + reach, y);
    systemFx.stroke({ width: 2, color, alpha: 0.95 });
    systemFx.circle(station.x - reach, y, 2.6).circle(station.x + reach, y, 2.6);
    systemFx.fill({ color: "#ffffff", alpha: 0.9 });
  }

  /** Red marks over a ship that goes back to the yard with findings, one per finding, in a row over its hull. */
  function findingMarks(item: Ship, count: number) {
    const gap = 12;
    const y = item.y - item.size * 0.62 - 3;
    const first = item.x - ((count - 1) * gap) / 2;
    for (let i = 0; i < count; i++) {
      const x = first + i * gap;
      systemFx.poly([x, y - 5.6, x + 4.4, y, x, y + 5.6, x - 4.4, y]);
    }
    systemFx.fill({ color: SPACE.alarm, alpha: 0.95 }).stroke({ width: 1, color: "#3a0d08", alpha: 0.9 });
  }

  /**
   * The inspection's verdict as a ship leaves it: a ring that widens and fades, green with a tick over the hull when the
   * review is clean, red when the ship goes back with findings.
   */
  function verdictFx(item: Ship, dt: number) {
    const verdict = item.verdict!;
    verdict.age += dt;
    if (verdict.age > VERDICT_SECONDS) {
      item.verdict = null;
      return;
    }
    const share = verdict.age / VERDICT_SECONDS;
    const color = verdict.clean ? SPACE.ok : SPACE.alarm;
    const fade = 1 - share * share;
    systemFx.circle(item.x, item.y, item.size * (0.6 + (still ? 0.2 : share * 0.7)));
    systemFx.stroke({ width: 2.4, color, alpha: fade });
    if (!verdict.clean) return;
    const r = item.size * 0.24;
    const cx = item.x;
    const cy = item.y - item.size * 0.78;
    systemFx.circle(cx, cy, r).fill({ color, alpha: fade });
    systemFx.moveTo(cx - r * 0.5, cy + r * 0.02).lineTo(cx - r * 0.12, cy + r * 0.4).lineTo(cx + r * 0.52, cy - r * 0.36);
    systemFx.stroke({ width: 2.4, color: "#0d2a1a", alpha: fade, cap: "round", join: "round" });
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

  /** Smoke from the damaged ships, from one pool of puffs; with reduced motion it hangs still. */
  function smoke(dt: number) {
    if (still) {
      let index = 0;
      for (const item of ships.values()) {
        if (item.entry.task.ci !== "failed" || item.leaving || item.stowed) continue;
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
      if (item.entry.task.ci !== "failed" || item.leaving || item.stowed) continue;
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
    blinks.forEach((light, index) => {
      light.alpha = still ? 0.16 : 0.04 + 0.22 * Math.max(0, Math.sin(time * 2.2 + index * 1.3)) ** 2;
    });
    lampBlinks.forEach((light) => {
      light.alpha = still ? 0.6 : 0.15 + 0.6 * Math.max(0, Math.sin(time * 3)) ** 2;
    });
    // An overloaded machine pulses in the same beat, from plain to bright, and never fades out: halo and heart in pairs.
    alarms.forEach((light, index) => {
      const peak = (index % 2 ? MACHINE_GLOW.overloaded!.core : MACHINE_GLOW.overloaded!.halo * 0.6);
      light.alpha = still ? peak * 0.85 : peak * (0.55 + 0.45 * Math.max(0, Math.sin(time * 2.2 + Math.floor(index / 2) * 1.3)) ** 2);
    });
    hotRings.forEach((ring, index) => {
      ring.alpha = still ? 1 : 0.5 + 0.5 * Math.max(0, Math.sin(time * 2.2 + index * 1.3)) ** 2;
    });
    for (const core of cores) core.sprite.rotation = still ? core.seed : core.seed + time * core.speed;
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
      const { scale } = model.layout;
      const radius = starSize(star.live, model.layout);
      star.dots.forEach((dot, index) => {
        const ring = radius * 1.25 + (16 + (index % 2) * 10) * scale;
        const angle = (still ? 0 : time * (dot.state === "work" ? 0.45 : 0.08)) + (index * Math.PI * 2) / star.dots.length;
        const color = dot.state === "attention" ? SPACE.alarm : dot.state === "ready" ? SPACE.gold : dot.state === "sleep" ? SPACE.sleep : FLEET[dot.executor].hull;
        galaxyFx.circle(point.x + ring * Math.cos(angle), point.y + ring * 0.72 * Math.sin(angle), 4.5 * Math.max(0.75, scale));
        galaxyFx.fill(color);
      });
    }
  }

  /**
   * The station breathes while the reflection runs, its gold light blinks while lessons wait, gold rings run out
   * while the analyst waits for an answer, and probes fly to the systems it reads.
   */
  function frameResearch() {
    watchFx.clear();
    const marks = model.research;
    if (!marks || !station) return;
    const center = researchPosition(camera.world, model.machineColumn, model.fuel);
    const { body, halo, beacon } = station;
    if (marks.running && !still) body.rotation = time * 0.12;
    halo.alpha = marks.running ? (still ? 0.5 : 0.38 + 0.18 * Math.sin(time * 2.4)) : 0.16;
    beacon.alpha = still ? 0.35 : 0.08 + 0.4 * Math.max(0, Math.sin(time * 1.8)) ** 2;
    if (marks.waiting > 0) {
      // A question waits for the human: gold rings run out from the dish, like a call on the air.
      for (let k = 0; k < WAVE_RINGS; k++) {
        const phase = still ? (k + 0.5) / WAVE_RINGS : (time * 0.42 + k / WAVE_RINGS) % 1;
        watchFx.circle(center.x, center.y, RESEARCH_SIZE * (0.55 + 1.45 * phase));
        watchFx.stroke({ width: 1.4 + 3.2 * (1 - phase), color: SPACE.gold, alpha: (still ? 0.55 : 0.9) * (1 - phase) ** 1.1 });
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

    systemFx.clear();
    for (const item of here("inspection")) {
      if (item.entry.placement.placeWorking && item.lane && !item.travelling) scan(item);
    }
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
    camera.step(dt);
    const { world, fit, galaxyView, systemView, systemWorld, systemFit } = camera;

    drawDust();
    const inGalaxy = flight < FALL;
    // The veil is opaque at the turn of the flight, so the skies change unseen.
    galaxy.visible = backdrop.visible = inGalaxy;
    system.visible = systemBackdrop.visible = !inGalaxy;
    let veilAlpha: number;
    if (inGalaxy) {
      const u = flight / FALL;
      const star = (focus && stars.get(focus)) || { x: world.width / 2, y: world.height / 2 };
      const zoom = galaxyView.zoom * (1 + u * u * 5);
      const screen = { x: star.x * galaxyView.zoom + galaxyView.tx, y: star.y * galaxyView.zoom + galaxyView.ty };
      const target = { x: screen.x + (viewport.width / 2 - screen.x) * u, y: screen.y + (viewport.height / 2 - screen.y) * u };
      place(galaxy, { zoom, tx: target.x - star.x * zoom, ty: target.y - star.y * zoom });
      frameGalaxy();
      veilAlpha = u * u;
    } else {
      const v = (flight - FALL) / (1 - FALL);
      const zoom = systemView.zoom * (0.82 + 0.18 * v);
      const middle = { x: viewport.width / 2, y: viewport.height / 2 };
      place(system, {
        zoom,
        tx: middle.x - ((middle.x - systemView.tx) / systemView.zoom) * zoom,
        ty: middle.y - ((middle.y - systemView.ty) / systemView.zoom) * zoom,
      });
      frameSystem(dt);
      veilAlpha = 1 - v;
    }
    veil.clear();
    if (veilAlpha > 0) veil.rect(0, 0, viewport.width, viewport.height).fill({ color: SPACE.void, alpha: veilAlpha });

    // The sky drifts a little behind the camera, never further than its margin past the window.
    const looked = worldPoint({ x: viewport.width / 2, y: viewport.height / 2 });
    const sky = inGalaxy ? backdrop : systemBackdrop;
    const [skyWorld, skyFit] = inGalaxy ? [world, fit] : [systemWorld, systemFit];
    sky.position.set(
      viewport.width / 2 - (looked.x - skyWorld.width / 2) * skyFit.zoom * SKY_DRIFT,
      viewport.height / 2 - (looked.y - skyWorld.height / 2) * skyFit.zoom * SKY_DRIFT,
    );
  }

  // Pointer ---------------------------------------------------------------------------------------

  const worldPoint = (screen: Point): Point => camera.worldPoint(screen);

  function starAt(point: Point): string | null {
    for (const star of model.stars) {
      const at = stars.get(star.repo);
      const reach = Math.min(starSize(star.live, model.layout) * 1.25 + 34 * model.layout.scale, model.layout.spacing * 0.5);
      if (at && Math.hypot(at.x - point.x, at.y - point.y) < reach) return star.repo;
    }
    return null;
  }

  function researchAt(point: Point): boolean {
    if (!model.research) return false;
    const center = researchPosition(camera.world, model.machineColumn, model.fuel);
    return Math.hypot(center.x - point.x, center.y - point.y) < RESEARCH_SIZE * 0.5;
  }

  function machineAt(point: Point): string | null {
    const column = model.machineColumn;
    if (!column) return null;
    for (const machine of model.machines) {
      const at = column.places.get(machine.id);
      if (at && Math.hypot(at.x - point.x, at.y - point.y) < column.size * 0.5) return machine.id;
    }
    return null;
  }

  function shipAt(point: Point): string | null {
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
  }

  // Pointer, wheel and keys -------------------------------------------------------------------------

  let lastHover: string | null = null;
  let lastStar: string | null = null;
  /** The pointer over the map without a press: the cursor, and the ship or star under it. */
  const hover = (at: Point) => {
    const point = worldPoint(at);
    const found = repo ? shipAt(point) : (starAt(point) ?? (researchAt(point) ? "research" : null));
    const machine = !repo && !found && options.onMachine ? machineAt(point) : null;
    canvas.style.cursor = found || machine ? "pointer" : camera.view().zoom > camera.fitOf().zoom * 1.001 ? "grab" : "";
    const slug = repo ? found : null;
    if (slug !== lastHover) {
      lastHover = slug;
      options.onHover(slug);
    }
    const star = !repo && found !== "research" ? found : null;
    if (star !== lastStar) {
      lastStar = star;
      options.onHoverStar?.(star);
    }
  };

  const click = (at: Point) => {
    const point = worldPoint(at);
    if (repo) {
      const slug = shipAt(point);
      if (slug) options.onPick(slug);
      return;
    }
    const star = starAt(point);
    if (star) options.onEnter(star);
    else if (researchAt(point)) options.onResearch();
    else {
      const machine = machineAt(point);
      if (machine) options.onMachine?.(machine);
    }
  };

  const leave = () => {
    if (lastStar === null) return;
    lastStar = null;
    options.onHoverStar?.(null);
  };

  const input = createInput({
    now: () => performance.now(),
    origin: () => {
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    },
    viewport: () => viewport,
    /** Over the canvas or a label on it: the wheel there moves the camera; over the log and the panels it scrolls them. */
    onMap: (target) => target === canvas || (target instanceof Node && !!options.labels?.contains(target)),
    paused: (nowMs) => camera.paused(nowMs),
    camera: () => camera.view(),
    pan: (dx, dy) => camera.panBy(dx, dy),
    drag: (from, dx, dy) => camera.dragFrom(from, dx, dy),
    zoom: (factor, at, notch) => camera.zoomBy(factor, at, notch),
    fit: () => camera.fitView(),
    stopGlide: () => camera.stopGlide(),
    click,
    hover,
    leave,
    capture: (pointerId) => canvas.setPointerCapture(pointerId),
    cursor: (style) => {
      canvas.style.cursor = style;
    },
  });

  const onContextLost = (event: Event) => {
    event.preventDefault();
    options.onLost();
  };

  const unlisten = listen(canvas, options.host, input);
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
        paintSun(sun, next);
        corona.tint = sunKind(next).glow;
        dressSystem(next);
      }
      camera.show(next !== null);
      repo = next;
      lastHover = null;
      leave();
      camera.report();
    },
    setShips,
    setSelected(slug) {
      selected = slug;
      arrange();
    },
    setMachine(id) {
      if (id === machineSelected) return;
      machineSelected = id;
      drawMachines();
    },
    setHovered(slug) {
      hovered = slug;
    },
    setInsets(next) {
      if (next.top === insets.top && next.right === insets.right && next.bottom === insets.bottom && next.left === insets.left) return;
      insets = next;
      layoutSystem();
    },
    setActive(active) {
      if (active) app.start();
      else app.stop();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      resize.disconnect();
      unlisten();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      // The textures stay in the Assets cache for the next scene.
      app.destroy({ removeView: true }, { children: true });
      kit.dispose();
    },
  };
}
