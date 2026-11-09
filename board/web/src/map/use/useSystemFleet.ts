// The open star system: its ships for the scene, the stations' names and counts over it, and the list at the side.

import { computed } from "vue";
import { placement, systemTasks } from "../placement";
import type { ShipEntry } from "../scene";
import { fleetGroups, hiddenShips, stationPlates } from "../overlay/system";
import type { GalaxyModel } from "./useGalaxyModel";
import type { MapPanels } from "./useMapPanels";
import type { MapSources } from "./useMapSources";

export function useSystemFleet(sources: MapSources, model: GalaxyModel, panels: MapPanels) {
  const { mapNow, replay } = sources;
  const { repo } = panels;
  const system = computed(() => (repo.value ? systemTasks(sources.tasks.value, repo.value) : { shown: [], hidden: [] }));
  const entries = computed<ShipEntry[]>(() =>
    system.value.shown.map((task) => ({ task, placement: placement(task, mapNow.value, system.value.shown)! })),
  );
  const groups = computed(() => fleetGroups(entries.value, mapNow.value, replay.at !== null));
  const plates = computed(() => stationPlates(entries.value, model.systemWorld.value, panels.selected.value, panels.hovered.value));
  const hidden = computed(() => hiddenShips(system.value.hidden));
  return { entries, groups, plates, hidden };
}
