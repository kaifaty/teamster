// The galaxy's labels over the canvas: the stars', the constellations', the science station's, the tanks' and the
// machines'. The builders in ../overlay make them; this keeps them up to date.

import { computed } from "vue";
import { constellationKeepOuts, constellationLabels } from "../overlay/constellations";
import { machineLabels as machineLabelsOf } from "../overlay/machines";
import { starLabels as starLabelsOf } from "../overlay/stars";
import { stationLabel as stationLabelOf } from "../overlay/station";
import { at } from "../overlay/style";
import { tankLabels as tankLabelsOf } from "../overlay/tanks";
import type { GalaxyModel } from "./useGalaxyModel";
import type { MapSources } from "./useMapSources";

export function useOverlayLabels(sources: MapSources, model: GalaxyModel) {
  const { now } = sources;
  const { world, galaxy, machineColumn, fuelColumn } = model;

  const starLabels = computed(() => starLabelsOf(model.starList.value, galaxy.value.places, sources.emblemOf));
  const constellations = computed(() =>
    constellationLabels(
      model.constellationList.value,
      galaxy.value,
      world.value,
      constellationKeepOuts(model.stationPoint.value, machineColumn.value, fuelColumn.value, model.coveredNow.value),
    ),
  );
  const stationLabel = computed(() => {
    const marks = model.station.value;
    return marks ? stationLabelOf(marks, model.stationPoint.value) : null;
  });
  const tankLabels = computed(() => tankLabelsOf(model.tankList.value, fuelColumn.value, now.value));
  const machineLabels = computed(() => machineLabelsOf(model.machinesData.value?.items ?? [], machineColumn.value, now.value));
  const machineNoteStyle = computed(() => {
    const note = machineColumn.value?.note;
    return note ? at(note.x, note.y) : null;
  });

  return { starLabels, constellationLabels: constellations, stationLabel, tankLabels, machineLabels, machineNoteStyle };
}

export type OverlayLabels = ReturnType<typeof useOverlayLabels>;
