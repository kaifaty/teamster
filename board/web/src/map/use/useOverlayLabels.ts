// The galaxy's labels over the canvas: the stars' and the constellations'. The builders in ../overlay make them; this
// keeps them up to date.

import { computed } from "vue";
import { constellationLabels } from "../overlay/constellations";
import { starLabels as starLabelsOf } from "../overlay/stars";
import type { GalaxyModel } from "./useGalaxyModel";
import type { MapSources } from "./useMapSources";

export function useOverlayLabels(sources: MapSources, model: GalaxyModel) {
  const { world, galaxy } = model;

  const starLabels = computed(() => starLabelsOf(model.starList.value, galaxy.value.places, sources.emblemOf));
  const constellations = computed(() => constellationLabels(model.constellationList.value, galaxy.value, world.value, model.coveredNow.value));

  return { starLabels, constellationLabels: constellations };
}

export type OverlayLabels = ReturnType<typeof useOverlayLabels>;
