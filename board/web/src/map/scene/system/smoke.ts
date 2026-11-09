// The sparks and smoke of damaged ships: the sparks drawn with the ship's marks, the smoke from one pool of puffs.

import { Container, type Graphics, type Sprite } from "pixi.js";
import type { Point } from "../../layout";
import { SPACE } from "../../palette";
import type { Kit } from "../kit";
import type { Clock } from "../layer";
import { noise, onHull } from "../math";
import type { Ship } from "./hull";

/** Smoke puffs shared by all damaged ships: no puff is made after the scene starts. */
const SMOKE_PUFFS = 160;
/** Seconds between two puffs of one damaged ship, and how long a puff lives. */
const PUFF_EVERY = 0.15;
const PUFF_LIFE = 1.7;

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

/** Now and then a short burst of sparks from a damaged hull; `spot` is scratch. */
export function sparks(systemFx: Graphics, item: Ship, time: number, spot: Point) {
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

export interface Smoke {
  readonly root: Container;
  /** Moves the smoke of `ships` after they moved this frame. */
  frame(ships: Iterable<Ship>, clock: Readonly<Clock>): void;
  dispose(): void;
}

export function createSmoke({ sprite, glowTexture }: Kit): Smoke {
  const smokeLayer = new Container();
  const puffs: Puff[] = Array.from({ length: SMOKE_PUFFS }, () => {
    const made = sprite(glowTexture, 10);
    made.tint = SPACE.smoke;
    made.visible = false;
    smokeLayer.addChild(made);
    return { sprite: made, owner: null, ox: 0, oy: 0, vx: 0, vy: 0, age: 0, size: 0 };
  });
  let nextPuff = 0;
  /** A scratch point, so that the frame makes no objects for its effects. */
  const spot: Point = { x: 0, y: 0 };

  /** Smoke from the damaged ships, from one pool of puffs; with reduced motion it hangs still. */
  function smoke(ships: Iterable<Ship>, { time, dt, still }: Readonly<Clock>) {
    if (still) {
      let index = 0;
      for (const item of ships) {
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
    for (const item of ships) {
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

  return {
    root: smokeLayer,
    frame: smoke,
    dispose() {
      for (const puff of puffs) puff.owner = null;
      smokeLayer.destroy({ children: true });
    },
  };
}
