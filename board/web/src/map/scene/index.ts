// The map in PixiJS: a galaxy of repositories and a star system per repository, in painted art at the full
// resolution of the screen. Labels are HTML in MapView; the scene draws, moves the camera and reports what the
// pointer does. The drawing lives in layers, galaxy/ and system/; this module puts them together.

import { Application, Container, Graphics, Sprite } from "pixi.js";
import type { ArtIndex } from "../../types";
import { NO_INSETS, systemFrame, worldSize, type Camera, type Insets, type Point, type Size, type SystemFrame } from "../layout";
import { SPACE } from "../palette";
import { createCamera } from "./camera";
import { createClouds } from "./galaxy/clouds";
import { createReactors } from "./galaxy/reactors";
import { createResearch } from "./galaxy/research";
import { createStars } from "./galaxy/stars";
import { createStorms } from "./galaxy/storms";
import { createTanks } from "./galaxy/tanks";
import { galaxyAt, hoveredStar, starAt } from "./hits";
import { createInput, listen } from "./input";
import { createKit } from "./kit";
import type { Clock, GalaxyLayer, Hit, SystemLayer } from "./layer";
import { noise } from "./math";
import { createPlaces } from "./system/places";
import { createFleet } from "./system/ships";
import { FLIGHT_SECONDS, type FleetScene, type GalaxyModel, type SceneOptions } from "./types";

export * from "./types";

/** The share of the flight spent falling towards the star; the rest brings up the system. */
const FALL = 0.55;
/** The share of the camera's move the sky follows; the sky is 15% larger than the window, see fitBackdrop. */
const SKY_DRIFT = 0.1;

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
  const { still, art } = kit;

  const canvas = app.canvas;
  canvas.className = "map-canvas";
  canvas.tabIndex = -1;
  options.host.prepend(canvas);

  // State -----------------------------------------------------------------------------------------

  const camera = createCamera(viewport, {
    still,
    now: () => performance.now(),
    flying: () => flight !== (repo ? 1 : 0),
    starAt: (point) => starAt(model, point),
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
  let disposed = false;
  let repoArt: ArtIndex = {};
  /** The frame's clock, one object for the scene's life. */
  const clock: Clock = { time: 0, dt: 0, still };

  // Layers ----------------------------------------------------------------------------------------

  const backdrop = new Sprite(art("nebula"));
  backdrop.anchor.set(0.5);
  const systemBackdrop = new Sprite(art("nebula"));
  systemBackdrop.anchor.set(0.5);
  const dust = new Graphics();

  const research = createResearch(kit);
  const storms = createStorms(kit);
  const starLayers = createStars(kit);
  const reactors = createReactors(kit);
  /** The galaxy's layers, the bottom one first. */
  const galaxyLayers: GalaxyLayer[] = [
    createClouds(kit),
    research.waves,
    createTanks(kit),
    reactors,
    research.station,
    starLayers.bodies,
    storms.clouds,
    research.probes,
    storms.lightning,
    starLayers.dots,
  ];
  const galaxy = new Container();
  galaxy.addChild(...galaxyLayers.map((layer) => layer.root));

  const fleet = createFleet(kit, frame, { onDive: () => places.flare() });
  const places = createPlaces(kit, frame, { sky: systemBackdrop, fit: fitBackdrop, ships: fleet.ships });
  /** The system's layers, the bottom one first: the places under the ships. */
  const systemLayers: SystemLayer[] = [places, fleet];
  const system = new Container();
  system.addChild(...systemLayers.map((layer) => layer.root));

  const veil = new Graphics();
  app.stage.addChild(backdrop, systemBackdrop, dust, galaxy, system, veil);

  // Drawing what changes rarely ---------------------------------------------------------------------

  function fitBackdrop(sky: Sprite) {
    const { width, height } = sky.texture;
    sky.scale.set(Math.max(viewport.width / width, viewport.height / height) * 1.15);
  }

  function drawGalaxy() {
    stars = model.layout.places;
    const scene = { model, world: camera.world, stars };
    for (const layer of galaxyLayers) layer.draw(scene);
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
    for (const layer of systemLayers) layer.layout(frame);
    camera.report();
  }

  // Frames ----------------------------------------------------------------------------------------

  function drawDust() {
    dust.clear();
    if (still) return;
    const { time } = clock;
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

  function place(container: Container, view: Camera) {
    container.scale.set(view.zoom);
    container.position.set(view.tx, view.ty);
  }

  function onFrame(elapsed: number) {
    // Ships take small steps after a pause; the flight keeps to real time, so it ends even in a slow tab.
    const dt = Math.min(elapsed, 0.1);
    clock.time += dt;
    clock.dt = dt;
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
      for (const layer of galaxyLayers) layer.frame?.(clock);
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
      for (const layer of systemLayers) layer.frame(clock);
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

  // Pointer, wheel and keys -------------------------------------------------------------------------

  const worldPoint = (screen: Point): Point => camera.worldPoint(screen);

  /** What is under a screen point: a ship in a system, in the galaxy what galaxyAt finds. */
  function hitAt(at: Point, machines: boolean): Hit | null {
    const point = worldPoint(at);
    if (!repo) return galaxyAt(model, camera.world, point, machines);
    const slug = fleet.shipAt(point);
    return slug ? { kind: "ship", slug } : null;
  }

  let lastHover: string | null = null;
  let lastStar: string | null = null;
  /** The pointer over the map without a press: the cursor, and the ship or star under it. */
  const hover = (at: Point) => {
    const hit = hitAt(at, !!options.onMachine);
    canvas.style.cursor = hit ? "pointer" : camera.view().zoom > camera.fitOf().zoom * 1.001 ? "grab" : "";
    const slug = hit?.kind === "ship" ? hit.slug : null;
    if (slug !== lastHover) {
      lastHover = slug;
      options.onHover(slug);
    }
    const star = hoveredStar(hit);
    if (star !== lastStar) {
      lastStar = star;
      options.onHoverStar?.(star);
    }
  };

  const click = (at: Point) => {
    const hit = hitAt(at, true);
    if (hit?.kind === "ship") options.onPick(hit.slug);
    else if (hit?.kind === "star") options.onEnter(hit.repo);
    else if (hit?.kind === "research") options.onResearch();
    else if (hit?.kind === "machine") options.onMachine?.(hit.id);
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
      if (focus) places.dress(focus, repoArt);
    },
    setView(next) {
      if (next === repo) return;
      if (next !== null) {
        fleet.clear();
        focus = next;
        places.open(next, repoArt);
      }
      camera.show(next !== null);
      repo = next;
      lastHover = null;
      leave();
      camera.report();
    },
    setShips: (entries, departures) => fleet.set(entries, departures),
    setSelected: (slug) => fleet.select(slug),
    setMachine: (id) => reactors.select(id),
    setHovered: (slug) => fleet.hover(slug),
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
      for (const layer of [...galaxyLayers, ...systemLayers]) layer.dispose();
      // The textures stay in the Assets cache for the next scene.
      app.destroy({ removeView: true }, { children: true });
      kit.dispose();
    },
  };
}
