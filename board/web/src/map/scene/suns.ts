// The painted sun of a repository, shared by its star in the galaxy and the sun of its system.

import { ColorMatrixFilter, type ColorMatrix, type Sprite } from "pixi.js";
import { hashName } from "../layout";
import { SUN_KINDS } from "../palette";

export const SUN_MARGIN = 1.5;

/** The art's brightness in pale blue: a tint on the sprite would not survive a filter. */
const COLD_STAR: ColorMatrix = [
  0.32, 0.62, 0.12, 0, 0,
  0.39, 0.77, 0.14, 0, 0,
  0.51, 1.0, 0.19, 0, 0,
  0, 0, 0, 1, 0,
];

export const sunKind = (repo: string) => SUN_KINDS[hashName(repo) % SUN_KINDS.length]!;

export const paintSun = (body: Sprite, repo: string) => {
  const { hue, cold } = sunKind(repo);
  if (hue === 0 && !cold) {
    body.filters = [];
    return;
  }
  const filter = new ColorMatrixFilter();
  if (cold) filter.matrix = COLD_STAR;
  else filter.hue(hue, false);
  body.filters = [filter];
};
