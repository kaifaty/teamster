// The science station in the middle of the galaxy: its hull, halo and beacon; the gold waves while its analyst waits,
// under the tanks; and the probes it sends to the systems it reads, over the storms.

import { Container, Graphics, type Sprite } from "pixi.js";
import { RESEARCH_SIZE, hashName, researchPosition, type Point } from "../../layout";
import { SPACE } from "../../palette";
import type { Kit } from "../kit";
import type { GalaxyLayer } from "../layer";
import type { ResearchMarks } from "../types";

const PROBE_SIZE = 40;
/** Gold rings around the science station while its analyst waits for an answer. */
const WAVE_RINGS = 3;
/** World units a probe covers in a second. */
const PROBE_SPEED = 120;

export interface ResearchLayers {
  /** The gold rings, under the tanks. */
  waves: GalaxyLayer;
  /** The station: its halo, hull and beacon. */
  station: GalaxyLayer;
  probes: GalaxyLayer;
}

export function createResearch({ art, sprite, glow }: Kit): ResearchLayers {
  const watchFx = new Graphics();
  const researchLayer = new Container();
  const probeLayer = new Container();
  let station: { body: Sprite; halo: Sprite; beacon: Sprite } | null = null;
  const probes = new Map<string, { sprite: Container; seed: number }>();
  /** What the station shows, where it stands and where the stars stand, as last drawn. */
  let marks: ResearchMarks | null = null;
  let center: Point = { x: 0, y: 0 };
  let stars: ReadonlyMap<string, Point> = new Map();

  const waves: GalaxyLayer = {
    root: watchFx,
    draw() {},
    frame({ time, still }) {
      watchFx.clear();
      if (!marks || !station) return;
      if (marks.waiting > 0) {
        // A question waits for the human: gold rings run out from the dish, like a call on the air.
        for (let k = 0; k < WAVE_RINGS; k++) {
          const phase = still ? (k + 0.5) / WAVE_RINGS : (time * 0.42 + k / WAVE_RINGS) % 1;
          watchFx.circle(center.x, center.y, RESEARCH_SIZE * (0.55 + 1.45 * phase));
          watchFx.stroke({ width: 1.4 + 3.2 * (1 - phase), color: SPACE.gold, alpha: (still ? 0.55 : 0.9) * (1 - phase) ** 1.1 });
        }
      }
    },
    dispose() {
      watchFx.destroy();
    },
  };

  const stationLayer: GalaxyLayer = {
    root: researchLayer,
    /** The science station in the middle of the galaxy: a teal glow, and a gold light while lessons wait. */
    draw({ model, world, stars: places }) {
      researchLayer.removeChildren().forEach((child) => child.destroy());
      station = null;
      marks = model.research;
      stars = places;
      if (!model.research) return;
      const point = researchPosition(world, model.machineColumn, model.fuel);
      center = point;
      const halo = glow(SPACE.research, RESEARCH_SIZE * 2.6);
      const body = sprite(art("stationResearch"), RESEARCH_SIZE);
      const beacon = glow(SPACE.gold, RESEARCH_SIZE * 0.9);
      for (const part of [halo, body, beacon]) part.position.set(point.x, point.y);
      beacon.visible = model.research.proposed > 0;
      researchLayer.addChild(halo, body, beacon);
      station = { body, halo, beacon };
    },
    /**
     * The station breathes while the reflection runs, its gold light blinks while lessons wait, gold rings run out
     * while the analyst waits for an answer, and probes fly to the systems it reads.
     */
    frame({ time, still }) {
      if (!marks || !station) return;
      const { body, halo, beacon } = station;
      if (marks.running && !still) body.rotation = time * 0.12;
      halo.alpha = marks.running ? (still ? 0.5 : 0.38 + 0.18 * Math.sin(time * 2.4)) : 0.16;
      beacon.alpha = still ? 0.35 : 0.08 + 0.4 * Math.max(0, Math.sin(time * 1.8)) ** 2;
    },
    dispose() {
      station = null;
      marks = null;
      researchLayer.destroy({ children: true });
    },
  };

  const probesLayer: GalaxyLayer = {
    root: probeLayer,
    /** One probe for every system the running reflection reads. */
    draw({ model }) {
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
    },
    frame({ time, still }) {
      if (!marks || !station) return;
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
    },
    dispose() {
      probes.clear();
      probeLayer.destroy({ children: true });
    },
  };

  return { waves, station: stationLayer, probes: probesLayer };
}
