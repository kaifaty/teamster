// The constellations' clouds, under everything else in the galaxy.

import { AlphaFilter, Container } from "pixi.js";
import type { Kit } from "../kit";
import type { GalaxyLayer } from "../layer";

export function createClouds({ sprite, glow, cloudTexture }: Kit): GalaxyLayer {
  const root = new Container();
  return {
    root,
    /**
     * A haze of the constellation's colour under its stars: a wide soft cloud around each of them, which run together where
     * the stars stand close, so that the haze takes the constellation's shape; and a faint glow over it.
     */
    draw({ model, stars }) {
      root.removeChildren().forEach((child) => child.destroy());
      const { spacing } = model.layout;
      for (const constellation of model.constellations) {
        // Drawn whole and then made faint, so that the clouds run together instead of piling up where they overlap.
        const haze = new Container();
        haze.filters = [new AlphaFilter({ alpha: 0.32 })];
        for (const name of constellation.repos) {
          const point = stars.get(name);
          if (!point) continue;
          const cloud = sprite(cloudTexture, spacing * 2.1);
          cloud.tint = constellation.color;
          cloud.position.set(point.x, point.y);
          const light = glow(constellation.color, spacing * 1.6);
          light.alpha = 0.35;
          light.position.set(point.x, point.y);
          haze.addChild(cloud);
          root.addChild(light);
        }
        root.addChildAt(haze, 0);
      }
    },
    dispose() {
      root.destroy({ children: true });
    },
  };
}
