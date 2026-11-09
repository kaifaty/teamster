// The storms over stars with ships in trouble, and the lightning in them over the probes.

import { Container, Graphics, type Sprite } from "pixi.js";
import { hashName, stormRadius, type Point } from "../../layout";
import { SPACE } from "../../palette";
import type { Kit } from "../kit";
import type { GalaxyLayer } from "../layer";
import { noise } from "../math";

interface Storm {
  point: Point;
  radius: number;
  seed: number;
  layers: Sprite[];
  flash: Sprite;
}

export interface StormLayers {
  /** The clouds, over the stars. */
  clouds: GalaxyLayer;
  /** The bolts, over the probes; the clouds' frame draws them. */
  lightning: GalaxyLayer;
}

export function createStorms({ sprite, glow, stormTexture }: Kit): StormLayers {
  const stormLayer = new Container();
  const bolts = new Graphics();
  let storms: Storm[] = [];
  /** Scratch points, so that the frame makes no objects for its effects. */
  const spot: Point = { x: 0, y: 0 };
  const spot2: Point = { x: 0, y: 0 };

  /** A rare flash in a storm: a forked bolt across the cloud that lights it up for a moment. */
  function lightning(storm: Storm, time: number) {
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
    bolts.moveTo(spot.x, spot.y);
    for (let i = 1; i <= 4; i++) {
      const toward = angle + Math.PI + (noise(cycle * 5 + i + storm.seed) - 0.5) * 1.1;
      spot.x += Math.cos(toward) * radius * 0.2;
      spot.y += Math.sin(toward) * radius * 0.2 * 0.72;
      bolts.lineTo(spot.x, spot.y);
      if (i === 2) {
        spot2.x = spot.x;
        spot2.y = spot.y;
      }
    }
    bolts.stroke({ width: 1.8, color: SPACE.lightning, alpha: 0.9 * strength });
    // A short fork from the second bend.
    const fork = angle + Math.PI + (noise(cycle + 77) > 0.5 ? 0.9 : -0.9);
    bolts.moveTo(spot2.x, spot2.y).lineTo(spot2.x + Math.cos(fork) * radius * 0.25, spot2.y + Math.sin(fork) * radius * 0.25 * 0.72);
    bolts.stroke({ width: 1.1, color: SPACE.lightning, alpha: 0.7 * strength });
  }

  const clouds: GalaxyLayer = {
    root: stormLayer,
    /** A storm over every star with ships in trouble, kept above the star so that its label stays clear. */
    draw({ model, stars }) {
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
    },
    frame({ time, still }) {
      bolts.clear();
      for (const storm of storms) {
        const [outer, inner] = storm.layers;
        outer!.rotation = still ? storm.seed : storm.seed + time * 0.22;
        inner!.rotation = still ? -storm.seed : -storm.seed - time * 0.36;
        storm.flash.alpha = 0;
        outer!.tint = inner!.tint = "#ffffff";
        if (!still) lightning(storm, time);
      }
    },
    dispose() {
      storms = [];
      stormLayer.destroy({ children: true });
    },
  };

  const lightningLayer: GalaxyLayer = {
    root: bolts,
    draw() {},
    dispose() {
      bolts.destroy();
    },
  };

  return { clouds, lightning: lightningLayer };
}
