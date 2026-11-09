// The system's places, under its ships: the home world, the charts of its orbits and routes, the sun with its corona
// and flare, the stations, the gate and the range's beams; and the system's dress, its own sky and planet.

import { Assets, Container, Graphics, Sprite, Texture } from "pixi.js";
import type { ArtIndex } from "../../../types";
import { BACKDROPS, type ArtName } from "../../art";
import {
  ROUTE,
  STATIONS,
  SUN_RADIUS,
  homeWorld,
  inCheckpoint,
  skyChoices,
  stationAt,
  stationOf,
  type Point,
  type SystemFrame,
} from "../../layout";
import { SPACE } from "../../palette";
import type { Place } from "../../placement";
import type { Kit } from "../kit";
import type { SystemLayer } from "../layer";
import { curvePoint } from "../math";
import { SUN_MARGIN, paintSun, sunKind } from "../suns";
import type { Ship } from "./hull";

/** The art is cropped a little wider than the ball, to keep its glow; see art/prepare.py. */
const BALL_MARGIN = 1.04;

const ROUTE_BEND = 0.14;
const FIX_BEND = -0.07;

export interface Places extends SystemLayer {
  /** Opens system `repo`: its sun's colour, its sky and planet from `art`. */
  open(repo: string, art: ArtIndex): void;
  /** Gives system `repo` its sky and planet from `art` again: the pictures changed. */
  dress(repo: string, art: ArtIndex): void;
  /** A ship dived into the sun: its corona flares. */
  flare(): void;
}

export interface PlacesDeps {
  /** The system's sky, on the stage behind the dust; `fit` sizes it to the window. */
  sky: Sprite;
  fit(sky: Sprite): void;
  ships: ReadonlyMap<string, Ship>;
}

export function createPlaces(kit: Kit, initial: SystemFrame, deps: PlacesDeps): Places {
  const { still, art, sprite, glow } = kit;
  const { sky: systemBackdrop, fit: fitBackdrop, ships } = deps;
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
  const root = new Container();
  root.addChild(homeBody, charts, corona, sun, stationLayer, gateGlow, gate, beams);
  let frame = initial;
  let flash = 0;
  let disposed = false;
  /** The focused system's own planet, its home world in place of the shared one. */
  let home: Texture | null = null;
  /** Counts the times a system was dressed, so that a late picture does not land on the next one. */
  let dressing = 0;

  /** The first of `urls` that loads, or null. */
  async function firstTexture(urls: string[]): Promise<Texture | null> {
    for (const url of urls) {
      const texture = await Assets.load<Texture>(url).catch(() => null);
      if (texture) return texture;
    }
    return null;
  }

  /** Gives system `name` its sky and planet; shared art stands in until they load, and stays if they cannot. */
  function dressSystem(name: string, repoArt: ArtIndex) {
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

  return {
    root,
    open(repo, repoArt) {
      paintSun(sun, repo);
      corona.tint = sunKind(repo).glow;
      dressSystem(repo, repoArt);
    },
    dress: dressSystem,
    flare() {
      flash = 1;
    },
    layout(next) {
      frame = next;
      drawCharts();
    },
    frame({ time, dt }) {
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
    },
    dispose() {
      disposed = true;
      root.destroy({ children: true });
    },
  };
}
