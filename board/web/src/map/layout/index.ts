// Where things stand on the map, in world units. Pure numbers: the scene, the labels and the tests share it.
// x grows to the right, y downwards. The camera turns world units into screen pixels.

export type { Point, Size, Insets, View, Rect } from "./geometry";
export { worldSize, NO_INSETS, freeView, hashName } from "./geometry";
export type { Camera } from "./camera";
export { fitCamera, MAX_ZOOM, zoomCamera, limitZoom, refitCamera, clampCamera } from "./camera";
export { backdropOf, skyChoices } from "./sky";
export type { SystemFrame, PlateSide } from "./system";
export {
  systemWorldSize,
  systemFrame,
  STATIONS,
  stationOf,
  homeWorld,
  ROUTE,
  SUN_RADIUS,
  orbitPoint,
  SUN_CLEARANCE,
  stationAt,
  plateAt,
} from "./system";
export type { Parking } from "./parking";
export { plateRoom, COUNT_ROOM, parkingOf, CHECKPOINT, inCheckpoint, lanesOf, parkingOrder } from "./parking";
export { toolbarBand, defaultCovered } from "./chrome";
export type { StarShape, Galaxy, Groups, Lattice, LabelledLattice } from "./galaxy";
export {
  constellationKey,
  LABEL_ZOOM,
  LABEL_MAX_WIDTH,
  starLabelSize,
  starSize,
  labelDrop,
  stormRadius,
  starFootprint,
  starRadius,
} from "./galaxy";
export { centreChoices, galaxyLayout } from "./stars";
