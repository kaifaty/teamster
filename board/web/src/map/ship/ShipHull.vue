<script setup lang="ts">
// The deck «Корабль»: the hull as the scene draws it, with a hole per open review finding and a patch per fix round,
// what the ship does now, and its papers.
import { computed } from "vue";
import type { Cargo, TaskLimits, TaskSummary } from "../../types";
import { ART } from "../art";
import { damageLine, hangarCaption, hullArt, hullClass, hullFrame, hullMarks, papersOf, roundsOf } from "./bridge";

const props = defineProps<{ task: TaskSummary; limits: TaskLimits | null | undefined; cargo: Cargo | null | undefined; now: number }>();

const session = computed(() => props.task.kind === "session");
const holes = computed(() => (session.value ? 0 : props.task.findings_left));
const rounds = computed(() => (session.value ? 0 : roundsOf(props.task, props.limits)));
const art = computed(() => hullArt(props.task));
const frame = computed(() => hullFrame(art.value));
const marks = computed(() => hullMarks(props.task.slug, holes.value, rounds.value, frame.value));
const picture = computed(() => ART[art.value]);
const alt = computed(() => `${hullClass(props.task)}: исполнитель ${props.task.executor === "codex" ? "Codex" : "Claude"}${props.task.effort ? `, форсаж ${props.task.effort}` : ""}`);
const damage = computed(() => damageLine(holes.value, rounds.value));
const caption = computed(() => hangarCaption(props.task, props.now));
const papers = computed(() => papersOf(props.task, props.limits, props.cargo, props.now));
</script>

<template>
  <section class="deck ship" aria-labelledby="ship-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">◈</span>
      <h3 id="ship-deck">Корабль</h3>
      <span class="aside num">ход {{ task.turn }}</span>
    </div>
    <div class="hangar" :class="{ alive: task.alive }">
      <div class="bay">
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
      <p class="now" :class="{ live: task.alive }" role="status" :title="`${caption.label} · ${caption.text}`">
        <span class="dim">{{ caption.label }} ·</span> {{ caption.text }}
      </p>
    </div>
    <div class="cls">
      <span><b>{{ hullClass(task) }}</b></span>
      <span v-if="damage">{{ damage }}</span>
    </div>
    <dl class="papers">
      <template v-for="row in papers" :key="row.label">
        <dt>{{ row.label }}</dt>
        <dd :class="{ mono: row.mono }" :title="row.title">{{ row.value }}</dd>
      </template>
    </dl>
  </section>
</template>

<style scoped>
/* The hangar is square, and no taller than 240 px on a narrow window; the bay inside it is the largest square that
   fits, centred, and the ship's picture is laid out in the bay's percent. */
.hangar {
  position: relative;
  container-type: size;
  aspect-ratio: 1;
  max-width: 100%;
  overflow: hidden;
  border: 1px solid rgba(214, 170, 96, 0.18);
  border-radius: 10px;
  background: radial-gradient(circle at 50% 55%, rgba(224, 145, 90, 0.16), transparent 62%), var(--sh-well);
}

.bay {
  position: absolute;
  left: 50%;
  top: 0;
  width: 100cqmin;
  height: 100cqmin;
  transform: translateX(-50%);
}

.bay img {
  position: absolute;
  object-fit: contain;
}

.hangar.alive .bay img {
  animation: hover 4s ease-in-out infinite;
}

@keyframes hover {
  50% {
    transform: translateY(-4px);
  }
}

.mark {
  position: absolute;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  font-size: 9px;
  font-weight: 700;
  transform: translate(-50%, -50%);
}

.mark.hole {
  border: 1.5px solid var(--sh-red);
  background: rgba(255, 141, 122, 0.25);
  color: var(--sh-red);
}

.mark.patch {
  width: 16px;
  height: 11px;
  border: 1px solid #b9b2a2;
  border-radius: 2px;
  background: #6d6a62;
}

/* The caption keeps to two lines in the hangar's bottom band, under the hull; the full text is in its title. */
.now {
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 6px;
  display: -webkit-box;
  max-height: 25%;
  margin: 0;
  padding: 4px 8px;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  border: 1px solid rgba(214, 170, 96, 0.25);
  border-radius: 6px;
  background: rgba(3, 5, 8, 0.85);
  font-size: 11.5px;
  line-height: 15px;
}

.now.live {
  border-color: rgba(95, 214, 200, 0.35);
  color: #bfeee6;
}

.cls {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 8px;
  color: var(--sh-dim);
  font-size: 12px;
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
}

.papers dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

@media (max-width: 760px) {
  .hangar {
    max-height: 240px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hangar.alive .bay img {
    animation: none;
  }
}
</style>
