// The stars' labels in the galaxy: a star's name, its ships and its badges.

import type { Star } from "../fleet";
import type { Point } from "../layout";
import { at } from "./style";

/** "repo: кораблей 3 · тревог 1 · ждут 1 · спят 1", or "repo: тихо" for a star without ships. */
export function starTitle(star: Star): string {
  const notes = [
    star.attention ? `тревог ${star.attention}` : "",
    star.ready ? `ждут ${star.ready}` : "",
    star.sleeping ? `спят ${star.sleeping}` : "",
  ].filter(Boolean);
  const ships = star.live ? `задач ${star.live}` : "тихо";
  return [`${star.repo}: ${ships}`, ...notes].join(" · ");
}

/** A label for each star, at the star's place in the galaxy. */
export function starLabels(stars: readonly Star[], places: ReadonlyMap<string, Point>, emblemOf: (name: string) => string | null) {
  return stars.map((star) => {
    const point = places.get(star.repo)!;
    return { star, style: at(point.x, point.y), title: starTitle(star), emblem: emblemOf(star.repo) };
  });
}
