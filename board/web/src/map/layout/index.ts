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
export { toolbarBand, defaultCovered, columnSpan, logCorner } from "./chrome";
export { RESEARCH_LABEL_DROP, researchPosition, RESEARCH_SIZE } from "./research";
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
export { galaxyKeepOuts, centreChoices, galaxyLayout } from "./stars";
export type { MachineShape, MachineColumn } from "./machines";
export {
  MACHINE_SIZE,
  MACHINE_MIN_SIZE,
  MACHINE_LABEL_WIDTH_PX,
  MACHINE_NOTE_PX,
  machineLabelSize,
  machineSpan,
  machinePositions,
  machineLabelAnchor,
  machineRoom,
  machineColumnRect,
  machineNoteRoom,
  machineRooms,
} from "./machines";
export type { TankShape, FuelColumn } from "./fuel";
export {
  TANK_ASPECT,
  TANK_GLASS,
  TANK_SIZE,
  TANK_MIN_SIZE,
  BADGE_RISE,
  LAMP_GAP,
  LAMP_WIDTH,
  FUEL_LABEL_WIDTH_PX,
  tankLabelSize,
  tankGear,
  fuelPositions,
  fuelRoom,
  fuelColumnRect,
} from "./fuel";
