// The inspection's marks on its ships: the scanner over a ship in a lane, the findings it sends back to the yard and
// the verdict as a ship leaves.

import type { Graphics } from "pixi.js";
import { CHECKPOINT, lanesOf, stationAt, stationOf, type SystemFrame } from "../../layout";
import { FLEET, SPACE } from "../../palette";
import type { Clock } from "../layer";
import type { Ship } from "./hull";

/** How long a ship shows the inspection's verdict as it leaves, in seconds. */
const VERDICT_SECONDS = 1.8;
/** A ship that goes back to the yard with findings carries one red mark per finding, at most this many. */
export const MAX_FINDING_MARKS = 5;

/**
 * The checkpoint's scanner over a ship in its lane, in the reviewer's colour: the lane lit faintly, and a beam from
 * the lenses on one side of the frame to those on the other that sweeps up and down the hull.
 */
export function scan(systemFx: Graphics, item: Ship, frame: SystemFrame, { time, still }: Readonly<Clock>) {
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
export function findingMarks(systemFx: Graphics, item: Ship, count: number) {
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
export function verdictFx(systemFx: Graphics, item: Ship, { dt, still }: Readonly<Clock>) {
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
