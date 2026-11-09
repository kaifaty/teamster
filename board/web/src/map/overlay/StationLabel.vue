<script setup lang="ts">
// The science station's label in the galaxy; it opens the station's screen.
import type { stationLabel } from "./station";

defineProps<{ label: ReturnType<typeof stationLabel>; researchOpen: boolean }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <button
    type="button"
    class="station"
    :class="{ live: label.running, waiting: label.waiting }"
    :style="label.style"
    :title="label.title"
    :aria-expanded="researchOpen"
    @click="emit('open')"
  >
    <span class="st-name">Научная станция</span>
    <span class="st-notes">{{ label.note }}</span>
  </button>
</template>

<style scoped src="./overlay.css"></style>

<style scoped>
/* The science station's label: teal, like its glow; a gold note while lessons wait for a decision. */
.station {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 260px;
  padding: 2px 10px;
  border: 1px solid rgba(95, 214, 200, 0.35);
  border-radius: 3px;
  background: rgba(8, 14, 18, 0.78);
  color: #bfeee6;
  font: inherit;
  font-size: 13px;
  line-height: 17px;
  pointer-events: auto;
  cursor: pointer;
}

.station:hover {
  border-color: rgba(95, 214, 200, 0.85);
  background: rgba(14, 26, 30, 0.92);
}

.station:focus-visible {
  outline: 2px solid #5fd6c8;
  outline-offset: 1px;
}

.st-name {
  font-weight: 650;
  white-space: nowrap;
}

.st-notes {
  color: #9cc2bc;
  font-size: 11.5px;
  white-space: nowrap;
}

.station.live .st-notes {
  color: #7ff0df;
}

.station.waiting .st-notes {
  color: #f3c64e;
}

@media (max-width: 760px) {
  .station {
    padding: 1px 6px;
    font-size: 11.5px;
    line-height: 15px;
  }

  .st-notes {
    font-size: 11px;
  }
}
</style>
