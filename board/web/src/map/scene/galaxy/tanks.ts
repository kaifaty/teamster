// The subscriptions' fuel tanks, their warning lights and day lamps.

import { Container, Graphics, type Sprite } from "pixi.js";
import { DAY_LAMPS } from "../../fleet";
import { BADGE_RISE, LAMP_GAP, LAMP_WIDTH, TANK_ASPECT, TANK_GLASS } from "../../layout";
import { FLEET, SPACE } from "../../palette";
import type { Kit } from "../kit";
import type { GalaxyLayer } from "../layer";

export function createTanks({ art, sprite, glow, greyFilter }: Kit): GalaxyLayer {
  const root = new Container();
  /** The warning lights of empty tanks, and the lamps of tanks that refill within a day: they blink. */
  let blinks: Sprite[] = [];
  let lampBlinks: Sprite[] = [];
  return {
    root,
    /**
     * A fuel tank for every subscription. The fuel stands in its glass as high as the week's limit left, in its family's
     * colour, red when little is left, and a warning light blinks beside an empty tank; a blocked one turns grey. The lamps
     * beside it burn one per day left until it refills, and the admiral's badge crowns the account kept for the
     * orchestrator, which new tasks skip.
     */
    draw({ model }) {
      root.removeChildren().forEach((child) => child.destroy());
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
          root.addChild(halo);
        }
        if (tank.low) {
          const light = glow(SPACE.empty, size * 1.25);
          light.position.set(point.x, point.y);
          light.alpha = 0.16;
          root.addChild(light);
          blinks.push(light);
        }
        const body = sprite(art("fuelTank"), size);
        body.position.set(point.x, point.y);
        if (tank.bad) body.filters = [greyFilter];
        root.addChild(body);
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
          root.addChild(liquid, shine);
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
          root.addChild(light);
          if (tank.soon) lampBlinks.push(light);
        }
        root.addChild(lamps);
        if (tank.admiral) {
          const badge = sprite(art("admiral"), size * 0.66);
          badge.position.set(point.x, top + size * (0.14 - BADGE_RISE));
          root.addChild(badge);
        }
      }
    },
    frame({ time, still }) {
      blinks.forEach((light, index) => {
        light.alpha = still ? 0.16 : 0.04 + 0.22 * Math.max(0, Math.sin(time * 2.2 + index * 1.3)) ** 2;
      });
      lampBlinks.forEach((light) => {
        light.alpha = still ? 0.6 : 0.15 + 0.6 * Math.max(0, Math.sin(time * 3)) ** 2;
      });
    },
    dispose() {
      blinks = [];
      lampBlinks = [];
      root.destroy({ children: true });
    },
  };
}
