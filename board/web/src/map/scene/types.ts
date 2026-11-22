// Shared data for star placement, hit testing and system labels.

import type { TaskSummary } from "../../types";
import type { Constellation } from "../constellations";
import type { Star } from "../fleet";
import type { Galaxy } from "../layout";
import type { Placement } from "../placement";

export interface ShipEntry {
  task: TaskSummary;
  placement: Placement;
}

export interface GalaxyModel {
  stars: Star[];
  /** Where the stars stand and how large they are drawn: see galaxyLayout. */
  layout: Galaxy;
  /** Stars drawn together under a faint cloud of their own colour. */
  constellations: Constellation[];
}
