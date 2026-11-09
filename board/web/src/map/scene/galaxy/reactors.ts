// The machines' reactors: their rings, cores and glows, the alarms of overloaded ones and the mark of the open one.

import { Container, Graphics, type Sprite } from "pixi.js";
import type { MachineStatus } from "../../../types";
import { hashName } from "../../layout";
import { RINGS, SPACE } from "../../palette";
import type { Kit } from "../kit";
import type { GalaxyDraw, GalaxyLayer } from "../layer";

/** The glow of a machine's reactor by its status: its halo and its heart; an overloaded one pulses up to these. */
const MACHINE_GLOW: Partial<Record<MachineStatus, { halo: number; core: number }>> = {
  free: { halo: 0.5, core: 0.55 },
  busy: { halo: 0.8, core: 0.85 },
  overloaded: { halo: 1, core: 1 },
};

export interface ReactorLayer extends GalaxyLayer {
  /** The machine whose card is open, marked like a selected ship; the reactors are drawn afresh when it changes. */
  select(id: string | null): void;
}

export function createReactors({ art, sprite, glow, greyFilter }: Kit): ReactorLayer {
  const root = new Container();
  /** The glows of overloaded machines: they pulse like the light of an empty tank. */
  let alarms: Sprite[] = [];
  /** The rings of overloaded resources, which pulse too, and the reactors' cores, which turn faster the busier the CPU. */
  let hotRings: Graphics[] = [];
  let cores: { sprite: Sprite; speed: number; seed: number }[] = [];
  let machineSelected: string | null = null;
  let last: GalaxyDraw | null = null;

  /**
   * A reactor for every machine, in three rings, outside in: CPU, memory and the GPU. A ring's arc is the share in use and
   * its dark rest what is free; calm in its own colour, gold when busy, pulsing red when overloaded. A thin outer ring
   * shows the fullest disk while it runs low. The core's glow tells a free machine (green), a busy one (amber) and a
   * pulsing overloaded one (red), and it turns faster the busier the CPU; a machine without connection is grey, its last
   * numbers faint, one without data grey and faint. The open machine is marked like a selected ship.
   */
  function drawMachines({ model }: GalaxyDraw) {
    root.removeChildren().forEach((child) => child.destroy());
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
        root.addChild(halo);
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
      root.addChild(calm, hot);
      if (heated) hotRings.push(hot);
      // The reactor's core in the middle, its pale heart lit in the status's colour.
      const body = sprite(art("reactorCore"), coreSize);
      body.position.set(point.x, point.y);
      if (faded) body.filters = [greyFilter];
      if (machine.status === "unknown") body.alpha = 0.65;
      root.addChild(body);
      const busy = machine.rings.cpu?.percent ?? 0;
      cores.push({ sprite: body, speed: faded ? 0 : 0.04 + (busy / 100) * 0.9, seed: hashName(machine.id) % 6 });
      if (color && glows) {
        const heart = glow(color, coreSize * 0.75);
        heart.alpha = glows.core;
        heart.position.set(point.x, point.y);
        root.addChild(heart);
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
        root.addChild(mark);
      }
    }
  }

  return {
    root,
    draw(scene) {
      last = scene;
      drawMachines(scene);
    },
    select(id) {
      if (id === machineSelected) return;
      machineSelected = id;
      if (last) drawMachines(last);
    },
    frame({ time, still }) {
      // An overloaded machine pulses in the same beat, from plain to bright, and never fades out: halo and heart in pairs.
      alarms.forEach((light, index) => {
        const peak = (index % 2 ? MACHINE_GLOW.overloaded!.core : MACHINE_GLOW.overloaded!.halo * 0.6);
        light.alpha = still ? peak * 0.85 : peak * (0.55 + 0.45 * Math.max(0, Math.sin(time * 2.2 + Math.floor(index / 2) * 1.3)) ** 2);
      });
      hotRings.forEach((ring, index) => {
        ring.alpha = still ? 1 : 0.5 + 0.5 * Math.max(0, Math.sin(time * 2.2 + index * 1.3)) ** 2;
      });
      for (const core of cores) core.sprite.rotation = still ? core.seed : core.seed + time * core.speed;
    },
    dispose() {
      alarms = [];
      hotRings = [];
      cores = [];
      last = null;
      root.destroy({ children: true });
    },
  };
}
