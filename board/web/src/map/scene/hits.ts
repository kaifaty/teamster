// What is under a point of the galaxy, without Pixi: the stars. The subscriptions, the machines and the reflection live
// in the control panel under the map, not in the galaxy.

import { starSize, type Point } from "../layout";
import type { Hit } from "./layer";
import type { GalaxyModel } from "./types";

/** The star whose ring of ship dots `point` is in, or null. */
export function starAt(model: GalaxyModel, point: Point): string | null {
  const stars = model.layout.places;
  for (const star of model.stars) {
    const at = stars.get(star.repo);
    const reach = Math.min(starSize(star.live, model.layout) * 1.25 + 34 * model.layout.scale, model.layout.spacing * 0.5);
    if (at && Math.hypot(at.x - point.x, at.y - point.y) < reach) return star.repo;
  }
  return null;
}

/** What is under `point` in the galaxy: a star, or nothing. */
export function galaxyAt(model: GalaxyModel, point: Point): Hit | null {
  const repo = starAt(model, point);
  return repo ? { kind: "star", repo } : null;
}

/** The star a hover tells MapView about: only a star, whatever its repository is called. */
export function hoveredStar(hit: Hit | null): string | null {
  return hit?.kind === "star" ? hit.repo : null;
}
