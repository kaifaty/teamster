<script setup lang="ts">
// The galaxy's labels over the canvas, from useOverlayLabels: the stars' and the constellations'. Each kind is its own
// component with its own styles.
import type { constellationLabels } from "./constellations";
import ConstellationLabel from "./ConstellationLabel.vue";
import type { starLabels } from "./stars";
import StarLabel from "./StarLabel.vue";

defineProps<{
  starLabels: ReturnType<typeof starLabels>;
  constellationLabels: ReturnType<typeof constellationLabels>;
}>();
const emit = defineEmits<{ enter: [repo: string] }>();
</script>

<template>
  <StarLabel v-for="label in starLabels" :key="label.star.repo" :label="label" @enter="emit('enter', $event)" />
  <ConstellationLabel v-for="label in constellationLabels" :key="label.name" :label="label" />
</template>
