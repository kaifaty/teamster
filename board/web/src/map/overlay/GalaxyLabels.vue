<script setup lang="ts">
// The galaxy's labels over the canvas, from useOverlayLabels: the stars', the science station's, the machines', the
// constellations' and the tanks'. Each kind is its own component with its own styles.
import type { constellationLabels } from "./constellations";
import ConstellationLabel from "./ConstellationLabel.vue";
import type { machineLabels } from "./machines";
import MachineLabels from "./MachineLabels.vue";
import type { starLabels } from "./stars";
import StarLabel from "./StarLabel.vue";
import type { stationLabel } from "./station";
import StationLabel from "./StationLabel.vue";
import type { at } from "./style";
import type { tankLabels } from "./tanks";
import TankLabel from "./TankLabel.vue";

defineProps<{
  starLabels: ReturnType<typeof starLabels>;
  stationLabel: ReturnType<typeof stationLabel> | null;
  researchOpen: boolean;
  machineLabels: ReturnType<typeof machineLabels>;
  /** The machine whose card is open, or null. */
  machine?: string | null;
  machineNoteStyle: ReturnType<typeof at> | null;
  machineNote: string | null;
  constellationLabels: ReturnType<typeof constellationLabels>;
  tankLabels: ReturnType<typeof tankLabels>;
}>();
const emit = defineEmits<{ enter: [repo: string]; openResearch: []; openMachine: [id: string, opener: HTMLElement] }>();
</script>

<template>
  <StarLabel v-for="label in starLabels" :key="label.star.repo" :label="label" @enter="emit('enter', $event)" />
  <StationLabel v-if="stationLabel" :label="stationLabel" :research-open="researchOpen" @open="emit('openResearch')" />
  <MachineLabels
    :machine-labels="machineLabels"
    :machine="machine"
    :machine-note-style="machineNoteStyle"
    :machine-note="machineNote"
    @open="(id, opener) => emit('openMachine', id, opener)"
  />
  <ConstellationLabel v-for="label in constellationLabels" :key="label.name" :label="label" />
  <TankLabel v-for="label in tankLabels" :key="label.tank.key" :label="label" />
</template>
