// The repositories' stars and, over everything else in the galaxy, the dots of their ships circling them.

import { Container, Graphics } from "pixi.js";
import { hashName, starSize } from "../../layout";
import { FLEET, SPACE } from "../../palette";
import type { Kit } from "../kit";
import type { GalaxyDraw, GalaxyLayer } from "../layer";
import { SUN_MARGIN, paintSun, sunKind } from "../suns";

export interface StarLayers {
  /** The stars themselves, under their storms. */
  bodies: GalaxyLayer;
  /** The ships' dots, the topmost layer of the galaxy. */
  dots: GalaxyLayer;
}

export function createStars({ art, sprite, glow }: Kit): StarLayers {
  const root = new Container();
  const galaxyFx = new Graphics();
  let last: GalaxyDraw | null = null;

  const bodies: GalaxyLayer = {
    root,
    draw({ model, stars }) {
      root.removeChildren().forEach((child) => child.destroy());
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
        root.addChild(halo, body);
      }
    },
    dispose() {
      root.destroy({ children: true });
    },
  };

  const dots: GalaxyLayer = {
    root: galaxyFx,
    draw(scene) {
      last = scene;
    },
    frame({ time, still }) {
      galaxyFx.clear();
      if (!last) return;
      const { model, stars } = last;
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
    },
    dispose() {
      last = null;
      galaxyFx.destroy();
    },
  };

  return { bodies, dots };
}
