// Hull and route pictures shared by the run screens.

import flagship from "./art/flagship.png";
import gate from "./art/gate.png";
import planetRange from "./art/planet-range.png";
import planetRoadstead from "./art/planet-roadstead.png";
import shipBlue from "./art/ship-blue.png";
import shipBlueCruiser from "./art/ship-blue-cruiser.png";
import shipBlueFrigate from "./art/ship-blue-frigate.png";
import shipCopper from "./art/ship-copper.png";
import shipCopperCruiser from "./art/ship-copper-cruiser.png";
import shipCopperFrigate from "./art/ship-copper-frigate.png";
import shipScout from "./art/ship-scout.png";
import stationInspection from "./art/station-inspection.png";
import stationYard from "./art/station-yard.png";
import sun from "./art/sun.png";

export const ART = {
  flagship,
  gate,
  planetRange,
  planetRoadstead,
  shipBlue,
  shipBlueCruiser,
  shipBlueFrigate,
  shipCopper,
  shipCopperCruiser,
  shipCopperFrigate,
  shipScout,
  stationInspection,
  stationYard,
  sun,
};

export type ArtName = keyof typeof ART;
