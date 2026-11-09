<script setup lang="ts">
// A star's label in the galaxy: its emblem, its name with the count of its ships, and the counts of those that need you.
import type { starLabels } from "./stars";

defineProps<{ label: ReturnType<typeof starLabels>[number] }>();
const emit = defineEmits<{ enter: [repo: string] }>();

const hideImage = (event: Event) => {
  (event.target as HTMLElement).hidden = true;
};
</script>

<template>
  <button
    type="button"
    class="star"
    :class="{ quiet: !label.star.live, alarm: label.star.attention }"
    :style="label.style"
    :data-star="label.star.repo"
    :title="label.title"
    :aria-label="label.title"
    @click="emit('enter', label.star.repo)"
  >
    <img v-if="label.emblem && label.star.live" :key="label.emblem" class="emblem" :src="label.emblem" alt="" @error="hideImage" />
    <span class="s-name">{{ label.star.repo }}<span v-if="label.star.live" class="num"> · {{ label.star.live }}</span></span>
    <span v-if="label.star.attention || label.star.ready || label.star.sleeping" class="badges" aria-hidden="true">
      <b v-if="label.star.attention" class="badge b-alarm">{{ label.star.attention }}</b>
      <b v-if="label.star.ready" class="badge b-ready">{{ label.star.ready }}</b>
      <b v-if="label.star.sleeping" class="badge b-sleep">{{ label.star.sleeping }}</b>
    </span>
  </button>
</template>

<style scoped src="./overlay.css"></style>

<style scoped>
/*
 * A star's label: one line, around its star where placeStarLabels finds room (--dx and --dy from the star's centre);
 * hidden until it is placed, and while it waits for the zoom.
 */
.star {
  left: calc(var(--tx) + var(--x) * var(--zoom) * 1px + var(--dx, 0px));
  top: calc(var(--ty) + var(--y) * var(--zoom) * 1px + var(--dy, 0px));
  transform: none;
  visibility: hidden;
  display: flex;
  align-items: center;
  gap: 5px;
  box-sizing: border-box;
  max-width: 220px;
  padding: 1px 7px;
  border: 1px solid rgba(214, 170, 96, 0.28);
  border-radius: 3px;
  background: rgba(8, 11, 18, 0.8);
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  line-height: 19px;
  white-space: nowrap;
  pointer-events: auto;
  cursor: pointer;
}

.star:has(.emblem) {
  padding-left: 2px;
}

.star.alarm {
  border-color: rgba(255, 141, 122, 0.55);
}

.star:hover {
  border-color: rgba(243, 198, 78, 0.8);
  background: rgba(26, 28, 34, 0.92);
}

.star:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.star.quiet {
  padding: 0 3px;
  border-color: transparent;
  background: none;
  color: #9aa3b4;
  font-size: 11.5px;
  line-height: 15px;
  text-shadow:
    0 0 3px #05070d,
    0 0 2px #05070d;
}

.star .emblem {
  width: 19px;
  height: 19px;
  padding: 0;
}

/* The counts of a star's ships in trouble, waiting for you and asleep, in the colours of their dots. */
.badges {
  display: flex;
  flex: none;
  gap: 3px;
}

.s-name {
  max-width: 100%;
  overflow: hidden;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.s-name .num {
  font-weight: 400;
  color: #b8ad98;
}
</style>
