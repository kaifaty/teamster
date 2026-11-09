<script setup lang="ts">
// A constellation's name beside its stars.
import type { constellationLabels } from "./constellations";

defineProps<{ label: ReturnType<typeof constellationLabels>[number] }>();
</script>

<template>
  <span class="constellation" :style="label.style" aria-hidden="true">{{ label.name }}</span>
</template>

<style scoped src="./overlay.css"></style>

<style scoped>
/* A constellation's name over its stars, in the colour of its cloud: quiet, under the stars' labels. */
.constellation {
  transform: translate(-50%, -50%);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.32em;
  line-height: 16px;
  text-transform: uppercase;
  white-space: nowrap;
  opacity: 0.8;
  text-shadow:
    0 0 4px #05070d,
    0 0 2px #05070d;
}
</style>
