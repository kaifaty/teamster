// The map's pictures, made by art/prepare.py. Vite turns the imports into URLs of hashed files.

import admiral from "./art/admiral.png";
import flagship from "./art/flagship.png";
import fuelCell from "./art/fuel-cell.png";
import fuelTank from "./art/fuel-tank.png";
import gate from "./art/gate.png";
import nebula from "./art/nebula.jpg";
import planetCryo from "./art/planet-cryo.png";
import planetRange from "./art/planet-range.png";
import planetRoadstead from "./art/planet-roadstead.png";
import planetYard from "./art/planet-yard.png";
import reactorCore from "./art/reactor-core.png";
import shipBlue from "./art/ship-blue.png";
import shipBlueCruiser from "./art/ship-blue-cruiser.png";
import shipBlueFrigate from "./art/ship-blue-frigate.png";
import shipCopper from "./art/ship-copper.png";
import shipCopperCruiser from "./art/ship-copper-cruiser.png";
import shipCopperFrigate from "./art/ship-copper-frigate.png";
import shipScout from "./art/ship-scout.png";
import stationCommand from "./art/station-command.png";
import stationInspection from "./art/station-inspection.png";
import stationResearch from "./art/station-research.png";
import stationYard from "./art/station-yard.png";
import sun from "./art/sun.png";

export const ART = {
  admiral,
  flagship,
  fuelCell,
  fuelTank,
  gate,
  nebula,
  planetCryo,
  planetRange,
  planetRoadstead,
  planetYard,
  reactorCore,
  shipBlue,
  shipBlueCruiser,
  shipBlueFrigate,
  shipCopper,
  shipCopperCruiser,
  shipCopperFrigate,
  shipScout,
  stationCommand,
  stationInspection,
  stationResearch,
  stationYard,
  sun,
};

export type ArtName = keyof typeof ART;

/** Skies of the star systems, in a fixed order; each loads when its system is opened. */
export const BACKDROPS: readonly string[] = Object.entries(
  import.meta.glob<string>("./art/backdrops/*.jpg", { eager: true, query: "?url", import: "default" }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url);
