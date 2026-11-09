// A ship of the system: what the scene keeps of it, and its art fitted to its task.

import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { Family, Hull } from "../../fleet";
import { HULL_SIZE, hullOf, patchSpots } from "../../fleet";
import { hashName, type Point } from "../../layout";
import { FLEET, SPACE } from "../../palette";
import type { Kit } from "../kit";
import { damageSpot } from "../math";
import type { ShipEntry } from "../types";

export interface Ship {
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
export interface Verdict {
  clean: boolean;
  /** Seconds since the ship left the inspection. */
  age: number;
}

function textureOf({ art }: Kit, family: Family, kind: Hull): Texture {
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

/** Fits the ship's art to its task: the hull of its effort and family, and a patch per fix round. */
export function dressShip(kit: Kit, item: Ship) {
  const { task } = item.entry;
  const kind = hullOf(task);
  const family = task.executor;
  const texture = textureOf(kit, family, kind);
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

/** A new ship of `entry` at its station `station`, or flying in from the left when it arrives; dressed for its task. */
export function makeShip(kit: Kit, entry: ShipEntry, arrive: boolean, station: Point): Ship {
  const { glow } = kit;
  const body = new Container();
  const engine = glow(FLEET[entry.task.executor].engine, 128);
  const hull = new Sprite(Texture.EMPTY);
  hull.anchor.set(0.5);
  const patches = new Graphics();
  const burn = glow(SPACE.burn, 128);
  burn.visible = false;
  body.addChild(engine, hull, patches, burn);
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
  dressShip(kit, item);
  return item;
}
