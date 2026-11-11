<script setup lang="ts">
// The deck «Корабль»: the hull as the scene draws it, with a hole per open review finding and a patch per fix round,
// its class, its papers with the plain word first, the meters that have something to show, and the rest of its papers
// under «Весь паспорт».
import { computed } from "vue";
import type { Cargo, TaskLimits, TaskSummary } from "../../types";
import { ART } from "../art";
import { damageLine, hullArt, hullClass, hullFrame, hullMarks, metersOf, papersOf, roundsOf } from "./bridge";

const props = defineProps<{ task: TaskSummary; limits: TaskLimits | null | undefined; cargo: Cargo | null | undefined; now: number }>();

const session = computed(() => props.task.kind === "session");
const holes = computed(() => (session.value ? 0 : props.task.findings_left));
const rounds = computed(() => (session.value ? 0 : roundsOf(props.task, props.limits)));
const art = computed(() => hullArt(props.task));
const frame = computed(() => hullFrame(art.value));
const marks = computed(() => hullMarks(props.task.slug, holes.value, rounds.value, frame.value));
const picture = computed(() => ART[art.value]);
const crew = computed(() => `${props.task.executor === "codex" ? "Codex" : "Claude"}${props.task.effort ? `, усилие ${props.task.effort}` : ""}`);
const alt = computed(() => `${hullClass(props.task)}: исполнитель ${crew.value}`);
const damage = computed(() => damageLine(holes.value, rounds.value));
const papers = computed(() => papersOf(props.task, props.limits, props.cargo, props.now));
const meters = computed(() => metersOf(props.task, props.limits, props.cargo, props.now));
</script>

<template>
  <section class="deck ship" aria-labelledby="ship-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">◈</span>
      <h3 id="ship-deck">Корабль</h3>
      <span v-if="task.turn > 0" class="aside num">ход {{ task.turn }}</span>
    </div>
    <div class="top">
      <div class="hangar" :class="{ alive: task.alive }">
        <img :src="picture" :alt="alt" :style="{ width: `${frame.size}%`, height: `${frame.size}%`, left: `${frame.left}%`, top: `${frame.top}%` }" />
        <span
          v-for="(mark, index) in marks"
          :key="index"
          class="mark"
          :class="mark.kind"
          :style="{ left: `${mark.left}%`, top: `${mark.top}%` }"
          :title="mark.title"
          aria-hidden="true"
          >{{ mark.kind === "hole" ? "!" : "" }}</span
        >
      </div>
      <div class="cls">
        <b>{{ hullClass(task) }}</b>
        <span class="dim">{{ crew }}</span>
        <span v-if="damage" class="dim" :title="'Пробоины — открытые находки ревью, заплаты — круги исправления'">{{ damage }}</span>
      </div>
    </div>
    <dl class="papers">
      <template v-for="row in papers.main" :key="row.label">
        <dt>{{ row.label }}<i v-if="row.meta"> · {{ row.meta }}</i></dt>
        <dd :class="{ mono: row.mono }" :title="row.title">{{ row.value }}</dd>
      </template>
    </dl>
    <div v-if="meters.length" class="meters">
      <div v-for="item in meters" :key="item.id" class="meter">
        <div class="line">
          <span class="dim">{{ item.label }}<i v-if="item.meta"> · {{ item.meta }}</i></span>
          <span class="num">{{ item.value }}</span>
        </div>
        <div v-if="item.share !== null" class="track" aria-hidden="true"><div class="fill" :class="item.tone" :style="{ width: `${Math.round(item.share * 100)}%` }"></div></div>
      </div>
    </div>
    <details v-if="papers.more.length" class="fold">
      <summary>Весь паспорт</summary>
      <dl class="papers">
        <template v-for="row in papers.more" :key="row.label">
          <dt>{{ row.label }}<i v-if="row.meta"> · {{ row.meta }}</i></dt>
          <dd :class="{ mono: row.mono }" :title="row.title">{{ row.value }}</dd>
        </template>
      </dl>
    </details>
  </section>
</template>

<style scoped>
.top {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}

/* The hangar is a small square; the ship's picture is laid out in its percent. */
.hangar {
  position: relative;
  aspect-ratio: 1;
  max-width: 100%;
  overflow: hidden;
  border: 1px solid rgba(214, 170, 96, 0.18);
  border-radius: 10px;
  background: radial-gradient(circle at 50% 55%, rgba(224, 145, 90, 0.16), transparent 62%), var(--sh-well);
}

.hangar img {
  position: absolute;
  object-fit: contain;
}

.hangar.alive img {
  animation: hover 4s ease-in-out infinite;
}

@keyframes hover {
  50% {
    transform: translateY(-3px);
  }
}

.mark {
  position: absolute;
  display: grid;
  place-items: center;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  font-size: 8px;
  font-weight: 700;
  transform: translate(-50%, -50%);
}

.mark.hole {
  border: 1.5px solid var(--sh-red);
  background: rgba(255, 141, 122, 0.25);
  color: var(--sh-red);
}

.mark.patch {
  width: 12px;
  height: 8px;
  border: 1px solid #b9b2a2;
  border-radius: 2px;
  background: #6d6a62;
}

.cls {
  display: grid;
  gap: 2px;
  font-size: 12.5px;
}

.cls b {
  color: var(--sh-copper);
  font-weight: 600;
}

.papers {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 5px 10px;
  margin: 0;
  font-size: 12.5px;
}

.papers dt {
  color: var(--sh-dim);
  white-space: nowrap;
}

.papers dt i,
.meter i {
  color: var(--sh-faint);
  font-size: 11px;
  font-style: normal;
}

.papers dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.meters {
  display: grid;
  gap: 7px;
}

.meter {
  display: grid;
  gap: 3px;
  font-size: 12px;
}

.meter .line {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.track {
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: rgba(214, 170, 96, 0.14);
}

.fill {
  height: 100%;
  border-radius: 3px;
  background: var(--sh-teal);
}

.fill.warn {
  background: var(--sh-wait);
}

.fill.bad {
  background: var(--sh-red);
}

.fold {
  padding-top: 8px;
  border-top: 1px solid rgba(214, 170, 96, 0.14);
}

.fold > summary {
  color: var(--sh-title);
  font-size: 12.5px;
  cursor: pointer;
}

.fold[open] > summary {
  margin-bottom: 8px;
}

@media (prefers-reduced-motion: reduce) {
  .hangar.alive img {
    animation: none;
  }
}
</style>
