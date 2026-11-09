<script setup lang="ts">
// The open system's labels over the canvas, from useSystemFleet: each station's name and count.
import type { Place } from "../placement";
import StationPlate from "./StationPlate.vue";
import type { stationPlates } from "./system";

defineProps<{ plates: ReturnType<typeof stationPlates> }>();
const emit = defineEmits<{ showStation: [place: Place] }>();
</script>

<template>
  <StationPlate v-for="plate in plates" :key="plate.place" :plate="plate" @show="emit('showStation', $event)" />
</template>
