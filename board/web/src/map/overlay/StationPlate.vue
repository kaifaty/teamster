<script setup lang="ts">
// A station's name in the open system and, where its berths are full, the count of the ships waiting there.
import type { Place } from "../placement";
import type { stationPlates } from "./system";

defineProps<{ plate: ReturnType<typeof stationPlates>[number] }>();
/** The count was pressed: the list of ships opens at this station. */
const emit = defineEmits<{ show: [place: Place] }>();
</script>

<template>
  <span class="plate-st" :class="plate.side" :style="plate.style">{{ plate.text.name }}<span> · {{ plate.text.note }}</span></span>
  <button
    v-if="plate.count"
    type="button"
    class="count"
    :class="{ hovered: plate.count.hovered }"
    :style="plate.count.style"
    :title="plate.count.title"
    :aria-label="`${plate.text.name}: ещё ${plate.count.ships}, показать в списке`"
    @click="emit('show', plate.place)"
  >
    +{{ plate.count.ships }}
  </button>
</template>

<style scoped src="./overlay.css"></style>

<style scoped>
/* A station's name next to it, away from its ships: under it, over it or left of it. */
.plate-st {
  padding: 0 7px;
  border: 1px solid rgba(214, 170, 96, 0.3);
  border-radius: 3px;
  background: rgba(8, 10, 15, 0.8);
  color: #f3c27a;
  font-weight: 650;
  line-height: 18px;
  white-space: nowrap;
}

.plate-st.above {
  transform: translate(-50%, -100%);
}

.plate-st.left {
  transform: translate(-100%, -50%);
}

.plate-st span {
  color: #9b907c;
  font-weight: 400;
}

/* The ships a station has no berth for: the count stands where the next of them would park. */
.count {
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  min-width: 30px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid rgba(243, 198, 78, 0.7);
  border-radius: 11px;
  background: rgba(14, 16, 22, 0.92);
  color: #f3c64e;
  font: inherit;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
  pointer-events: auto;
  cursor: pointer;
}

.count:hover,
.count.hovered {
  border-color: #f3c64e;
  background: rgba(60, 48, 20, 0.95);
}

.count:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

@media (max-width: 760px) {
  .plate-st {
    padding: 0 4px;
    font-size: 11.5px;
    line-height: 15px;
  }

  .plate-st span {
    display: none;
  }
}
</style>
