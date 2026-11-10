<script setup lang="ts">
// The deck «Маршрут»: the stops from the yard to the sun with the ship's own lit, the loops of the fix rounds and CI
// repairs over them, and the cryo field beside them for a sleeping ship.
import { computed } from "vue";
import type { Cargo, TaskLimits, TaskSummary } from "../../types";
import { ART } from "../art";
import { loopsOf, routeOf } from "./bridge";

const props = defineProps<{ task: TaskSummary; limits: TaskLimits | null | undefined; cargo: Cargo | null | undefined; now: number }>();

const route = computed(() => routeOf(props.task, props.now));
const loops = computed(() => loopsOf(props.task, props.limits, props.cargo));
</script>

<template>
  <section class="deck route-deck" aria-labelledby="route-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">➝</span>
      <h3 id="route-deck">Маршрут</h3>
      <span class="aside">от верфи к солнцу, то есть к слиянию</span>
    </div>
    <p class="line" :class="{ ended: route.ended }" role="status">{{ route.line }}</p>
    <div class="track" :class="{ looped: loops.length, both: loops.length > 1 }">
      <ol class="route">
        <li
          v-for="stop in route.stops"
          :key="stop.id"
          class="stop"
          :class="stop.state"
          :aria-current="stop.state === 'here' ? 'step' : undefined"
        >
          <span class="icon"><img :src="ART[stop.art]" alt="" /></span>
          <span class="name">{{ stop.name }}</span>
          <span class="note">{{ stop.note }}</span>
        </li>
      </ol>
      <span v-for="loop in loops" :key="loop.kind" class="loop" :class="loop.kind"><span>{{ loop.text }}</span></span>
    </div>
    <div v-if="route.cryo" class="cryo here">
      <span class="icon"><img :src="ART.planetCryo" alt="" /></span>
      <span>
        <span class="name">Криополе</span>
        <span class="note">{{ route.cryo.wakes ? `проснётся в ${route.cryo.wakes}` : "проснётся после сброса лимита" }}</span>
      </span>
    </div>
  </section>
</template>

<style scoped>
.line {
  margin: 0;
  color: var(--sh-wait);
  font-size: 12.5px;
}

.line.ended {
  color: var(--sh-dim);
}

.track {
  position: relative;
}

.track.looped {
  padding-top: 26px;
}

.track.both {
  padding-top: 46px;
}

.route {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  margin: 0;
  padding: 0;
  list-style: none;
}

.stop {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
  text-align: center;
}

.stop::after {
  content: "";
  position: absolute;
  top: 27px;
  left: calc(50% + 28px);
  right: calc(-50% + 28px);
  border-top: 2px dotted rgba(214, 170, 96, 0.35);
}

.stop:last-child::after {
  display: none;
}

.icon {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border: 1px solid rgba(214, 170, 96, 0.2);
  border-radius: 50%;
  background: var(--sh-well);
  opacity: 0.45;
}

.icon img {
  width: 48px;
  height: 48px;
  object-fit: contain;
}

.stop.past .icon {
  opacity: 0.85;
}

.stop.past::after {
  border-top-style: solid;
  border-color: rgba(214, 170, 96, 0.55);
}

.here .icon {
  border: 2px solid var(--sh-wait);
  box-shadow: 0 0 0 4px rgba(243, 198, 78, 0.14), 0 0 18px rgba(243, 198, 78, 0.35);
  opacity: 1;
  animation: beacon 2.4s ease-in-out infinite;
}

@keyframes beacon {
  50% {
    box-shadow: 0 0 0 6px rgba(243, 198, 78, 0.08), 0 0 26px rgba(243, 198, 78, 0.5);
  }
}

.name {
  display: block;
  font-size: 12px;
}

.note {
  display: block;
  min-height: 15px;
  color: var(--sh-dim);
  font-size: 11px;
  line-height: 15px;
}

.here .note {
  color: var(--sh-wait);
}

/* The loops stand over the route: the fix loop from the inspection back to the yard, CI's from the gate. */
.loop {
  position: absolute;
  top: 6px;
  display: flex;
  justify-content: center;
  height: 18px;
  border: 1.5px dashed;
  border-bottom: 0;
  border-radius: 12px 12px 0 0;
  font-size: 11px;
}

.loop > span {
  padding: 0 6px;
  height: 15px;
  overflow: hidden;
  max-width: 100%;
  background: #090b10;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translateY(-11px);
}

.both .loop.fix {
  top: 26px;
}

.loop.fix {
  left: calc(100% / 12);
  width: calc(100% / 3);
  color: var(--sh-copper);
}

.loop.ci {
  left: calc(100% / 12);
  width: calc(100% / 2);
  color: var(--sh-blue);
}

.cryo {
  display: flex;
  align-items: center;
  gap: 10px;
  align-self: flex-start;
  padding: 6px 12px 6px 6px;
  border: 1px solid rgba(159, 216, 240, 0.35);
  border-radius: 999px;
  background: rgba(159, 216, 240, 0.06);
}

.cryo .icon {
  width: 44px;
  height: 44px;
  border-color: var(--sh-ice);
  box-shadow: 0 0 14px rgba(159, 216, 240, 0.35);
  animation: none;
}

.cryo .icon img {
  width: 38px;
  height: 38px;
}

.cryo .note {
  color: var(--sh-ice);
}

@media (max-width: 560px) {
  .icon {
    width: 40px;
    height: 40px;
  }

  .icon img {
    width: 34px;
    height: 34px;
  }

  .stop::after {
    top: 19px;
    left: calc(50% + 20px);
    right: calc(-50% + 20px);
  }

  .name {
    font-size: 11px;
  }

  .note {
    display: none;
  }

  .here .note {
    display: block;
  }

  .loop {
    font-size: 10px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .here .icon {
    animation: none;
  }
}
</style>
