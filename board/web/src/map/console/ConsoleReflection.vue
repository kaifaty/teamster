<script setup lang="ts">
// The reflection block: the science station's picture in a window, and its most pressing note. A click opens the
// reflection's screen; without data from the server there is nothing to open.
import stationArt from "../art/station-research.png";
import type { reflectionNote } from "./texts";

defineProps<{ reflection: ReturnType<typeof reflectionNote>; researchOpen: boolean }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <section class="console-block console-reflection" :class="{ live: reflection.running, waiting: reflection.waiting }">
    <button
      v-if="reflection.label"
      type="button"
      class="r-window c-press"
      :title="reflection.title"
      :aria-label="reflection.label"
      :aria-expanded="researchOpen"
      @click="emit('open')"
    >
      <img class="r-art" :src="stationArt" alt="" />
      <span class="r-name">Рефлексия</span>
      <span class="r-note c-text">{{ reflection.note }}</span>
    </button>
    <div v-else class="r-window off" :title="reflection.title">
      <img class="r-art" :src="stationArt" alt="" />
      <span class="r-name">Рефлексия</span>
      <span class="r-note c-text">{{ reflection.note }}</span>
    </div>
  </section>
</template>

<style scoped src="./console.css"></style>

<style scoped>
/* Teal, like the station's glow; a gold note while lessons wait for a decision. */
.console-reflection {
  padding: 0;
}

.r-window {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  min-height: 0;
  margin: 0;
  padding: 2px 6px 4px;
  border: 0;
  border-radius: 2px;
  background: radial-gradient(ellipse at 50% 40%, rgba(95, 214, 200, 0.12), transparent 70%);
  color: #bfeee6;
  font: inherit;
}

.r-window.off {
  opacity: 0.6;
}

.r-art {
  flex: 1 1 0;
  width: 100%;
  min-height: 0;
  object-fit: contain;
}

.r-name {
  flex: none;
  font-size: 13px;
  font-weight: 650;
}

.r-note {
  flex: none;
  max-width: 100%;
  color: #9cc2bc;
  font-size: 11.5px;
}

.console-reflection.live .r-note {
  color: #7ff0df;
}

.console-reflection.waiting .r-note {
  color: #f3c64e;
}

.r-window:focus-visible {
  outline-offset: -3px;
}

@media (prefers-reduced-motion: no-preference) {
  .console-reflection.live .r-art {
    animation: r-glow 2.4s ease-in-out infinite alternate;
  }
}

@keyframes r-glow {
  from {
    filter: drop-shadow(0 0 2px rgba(127, 240, 223, 0.2));
  }
  to {
    filter: drop-shadow(0 0 8px rgba(127, 240, 223, 0.7));
  }
}
</style>
