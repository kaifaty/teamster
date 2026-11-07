// The map's pictures, made by art/prepare.py. Vite turns the imports into URLs of hashed files.

import depot from "./art/depot.png";
import flagship from "./art/flagship.png";
import gate from "./art/gate.png";
import nebula from "./art/nebula.jpg";
import planetCryo from "./art/planet-cryo.png";
import planetInspection from "./art/planet-inspection.png";
import planetRange from "./art/planet-range.png";
import planetRoadstead from "./art/planet-roadstead.png";
import planetYard from "./art/planet-yard.png";
import shipBlue from "./art/ship-blue.png";
import shipCopper from "./art/ship-copper.png";
import shipScout from "./art/ship-scout.png";
import stationCommand from "./art/station-command.png";
import sun from "./art/sun.png";

export const ART = {
  depot,
  flagship,
  gate,
  nebula,
  planetCryo,
  planetInspection,
  planetRange,
  planetRoadstead,
  planetYard,
  shipBlue,
  shipCopper,
  shipScout,
  stationCommand,
  sun,
};

export type ArtName = keyof typeof ART;

/** Skies of the star systems, in a fixed order; each loads when its system is opened. */
export const BACKDROPS: readonly string[] = Object.entries(
  import.meta.glob<string>("./art/backdrops/*.jpg", { eager: true, query: "?url", import: "default" }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url);
