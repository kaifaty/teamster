// What is under a point of the galaxy, without Pixi: the stars, the science station and the machines' reactors.

import { RESEARCH_SIZE, starSize, type Point } from "../layout";
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

export function researchAt(model: GalaxyModel, point: Point): boolean {
  if (!model.research) return false;
  const center = model.research.at;
  return Math.hypot(center.x - point.x, center.y - point.y) < RESEARCH_SIZE * 0.5;
}

export function machineAt(model: GalaxyModel, point: Point): string | null {
  const column = model.machineColumn;
  if (!column) return null;
  for (const machine of model.machines) {
    const at = column.places.get(machine.id);
    if (at && Math.hypot(at.x - point.x, at.y - point.y) < column.size * 0.5) return machine.id;
  }
  return null;
}

/** What is under `point` in the galaxy: a star before the station, the station before a reactor, reactors if `machines`. */
export function galaxyAt(model: GalaxyModel, point: Point, machines = true): Hit | null {
  const repo = starAt(model, point);
  if (repo) return { kind: "star", repo };
  if (researchAt(model, point)) return { kind: "research" };
  const id = machines ? machineAt(model, point) : null;
  return id ? { kind: "machine", id } : null;
}

/** The star a hover tells MapView about: only a star, whatever its repository is called. */
export function hoveredStar(hit: Hit | null): string | null {
  return hit?.kind === "star" ? hit.repo : null;
}
