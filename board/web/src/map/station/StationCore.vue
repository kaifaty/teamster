<script setup lang="ts">
// The station's core: its own picture inside the chronometer's ring. The ring fills from the last planned run to
// the next one; the diamond at the top is the next run. Gold waves run out while the analyst waits for an answer,
// a teal sweep turns while a reflection works.
import { computed } from "vue";
import { formatAge } from "../../lib/format";
import stationArt from "../art/station-research.png";
import { shortDate, type Research } from "../research";
import type { Clock } from "../schedule";
import { useConsole } from "./console";

const props = defineProps<{ research: Research; clock: Clock; now: number }>();
const emit = defineEmits<{ open: [slug: string] }>();
const desk = useConsole();

const SIZE = 216;
const C = SIZE / 2;
const R = 98;
const LENGTH = 2 * Math.PI * R;
const TICKS = 24;

const ticks = computed(() =>
  Array.from({ length: TICKS }, (_, index) => {
    const angle = (index / TICKS) * 2 * Math.PI - Math.PI / 2;
    const inner = index % 6 === 0 ? 80 : 84;
    return {
      x1: C + inner * Math.cos(angle),
      y1: C + inner * Math.sin(angle),
      x2: C + 89 * Math.cos(angle),
      y2: C + 89 * Math.sin(angle),
      lit: index / TICKS < props.clock.progress,
      major: index % 6 === 0,
    };
  }),
);

/** Where the ring's arc ends: the station's place in the wait. */
const marker = computed(() => {
  const angle = props.clock.progress * 2 * Math.PI - Math.PI / 2;
  return { x: C + R * Math.cos(angle), y: C + R * Math.sin(angle) };
});

const LABEL: Record<Clock["state"], string> = {
  counting: "до планового разбора",
  due: "плановый разбор",
  running: "идёт разбор",
  off: "расписание",
  unknown: "следующий запуск",
  none: "плановых разборов нет",
};

const waiting = computed(() => props.research.waiting > 0);
const scheduleTitle = computed(() => {
  const schedule = props.research.schedule;
  if (!schedule) return "Сервер доски не знает плановой рефлексии: разбор идёт только по запросу.";
  return [schedule.name ?? "Плановая рефлексия", `cron ${schedule.cron}`, "Запланированная задача десктопа Claude"].join("\n");
});

const run = computed(() => props.research.run);
</script>

<template>
  <section class="deck core" data-deck="core" aria-labelledby="deck-core">
    <header class="deck-head">
      <span class="sigil" aria-hidden="true">◷</span>
      <h3 id="deck-core">Расписание</h3>
      <span class="aside" :title="scheduleTitle">{{ clock.rule ?? "без расписания" }}</span>
    </header>
    <div class="deck-body">
      <div class="dial" :class="[clock.state, { waiting }]" :style="{ '--size': `${SIZE}px` }">
        <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" aria-hidden="true">
          <circle class="track" :cx="C" :cy="C" :r="R" />
          <circle
            class="arc"
            :cx="C"
            :cy="C"
            :r="R"
            :stroke-dasharray="`${LENGTH * clock.progress} ${LENGTH}`"
            :transform="`rotate(-90 ${C} ${C})`"
          />
          <line
            v-for="(tick, index) in ticks"
            :key="index"
            class="tick"
            :class="{ lit: tick.lit, major: tick.major }"
            :x1="tick.x1"
            :y1="tick.y1"
            :x2="tick.x2"
            :y2="tick.y2"
          />
          <path v-if="clock.state === 'counting' || clock.state === 'due'" class="goal" :d="`M ${C} ${C - R - 9} l 6 9 l -6 9 l -6 -9 z`" />
          <circle v-if="clock.progress > 0 && clock.state !== 'due'" class="now" :cx="marker.x" :cy="marker.y" r="4.5" />
        </svg>
        <span class="sweep" aria-hidden="true"></span>
        <span class="wave w1" aria-hidden="true"></span>
        <span class="wave w2" aria-hidden="true"></span>
        <img class="station" :src="stationArt" alt="" />
      </div>

      <div class="readout" :title="scheduleTitle">
        <span class="label">{{ LABEL[clock.state] }}</span>
        <b class="big num" :class="clock.state">{{ clock.big }}</b>
        <span v-if="clock.when" class="when">{{ clock.state === "running" ? `следующий ${clock.when}` : clock.when }}</span>
        <span v-if="clock.state === 'unknown'" class="when dim">cron не разобран: {{ research.schedule?.cron }}</span>
      </div>

      <dl class="log">
        <template v-if="clock.last">
          <dt>Прошлый по плану</dt>
          <dd>{{ clock.last }}</dd>
        </template>
        <template v-if="run">
          <dt>Сессия десктопа</dt>
          <dd>
            {{ run.alive ? "работает" : formatAge(run.updated_at, now) }}
            <button type="button" class="link" @click="emit('open', run.slug)">открыть</button>
          </dd>
        </template>
        <dt>Последний пакет</dt>
        <dd v-if="research.batch">{{ shortDate(research.batch.date) }} · записей {{ research.batch.records }}</dd>
        <dd v-else class="dim">ещё не было</dd>
      </dl>

      <div class="levers">
        <button type="button" class="key gold" @click="desk.order('batch')">Внеочередной разбор</button>
        <button type="button" class="chip" @click="desk.order('question')">Вопрос к архиву</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.deck-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.dial {
  position: relative;
  flex: none;
  width: var(--size);
  height: var(--size);
  margin-top: 4px;
}

.dial svg {
  position: absolute;
  inset: 0;
  overflow: visible;
}

.track {
  fill: none;
  stroke: rgba(95, 214, 200, 0.12);
  stroke-width: 7;
}

.arc {
  fill: none;
  stroke: var(--st-teal);
  stroke-linecap: round;
  stroke-width: 7;
  filter: drop-shadow(0 0 5px rgba(95, 214, 200, 0.55));
  transition: stroke-dasharray 1s linear;
}

.due .arc {
  stroke: var(--st-wait);
  filter: drop-shadow(0 0 6px rgba(243, 198, 78, 0.7));
}

.off .arc,
.none .arc,
.unknown .arc {
  stroke: none;
}

.tick {
  stroke: rgba(155, 144, 124, 0.35);
  stroke-width: 1.2;
}

.tick.major {
  stroke-width: 2;
}

.tick.lit {
  stroke: rgba(95, 214, 200, 0.85);
}

.goal {
  fill: var(--st-wait);
  stroke: #1b1408;
  stroke-width: 1;
  filter: drop-shadow(0 0 4px rgba(243, 198, 78, 0.8));
}

.now {
  fill: #e9fffb;
  stroke: var(--st-teal);
  stroke-width: 2;
}

.station {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 62%;
  height: 62%;
  object-fit: contain;
  transform: translate(-50%, -50%);
  filter: drop-shadow(0 0 14px rgba(95, 214, 200, 0.35));
}

.off .station,
.none .station {
  filter: grayscale(0.6) brightness(0.7);
}

/* A reflection at work: a teal beam turns round the station. */
.sweep {
  position: absolute;
  inset: 13%;
  border-radius: 50%;
  opacity: 0;
  background: conic-gradient(from 0deg, transparent 0 78%, rgba(95, 214, 200, 0.45) 96%, transparent 100%);
}

.running .sweep {
  opacity: 1;
  animation: turn 3.2s linear infinite;
}

/* The analyst waits: gold waves run out from the core. */
.wave {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 40%;
  height: 40%;
  border: 2px solid rgba(243, 198, 78, 0.8);
  border-radius: 50%;
  opacity: 0;
  transform: translate(-50%, -50%);
}

.waiting .wave {
  animation: wave 2.6s ease-out infinite;
}

.waiting .w2 {
  animation-delay: 1.3s;
}

@keyframes turn {
  to {
    transform: rotate(360deg);
  }
}

@keyframes wave {
  0% {
    opacity: 0.9;
    width: 36%;
    height: 36%;
  }

  100% {
    opacity: 0;
    width: 100%;
    height: 100%;
  }
}

.readout {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  text-align: center;
}

.label {
  color: var(--st-dim);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.big {
  color: var(--st-teal-text);
  font-size: 30px;
  font-weight: 600;
  line-height: 36px;
  letter-spacing: 0.04em;
  text-shadow: 0 0 12px rgba(95, 214, 200, 0.45);
}

.big.due {
  color: #ffe9a8;
  text-shadow: 0 0 12px rgba(243, 198, 78, 0.55);
}

.big.off,
.big.none,
.big.unknown {
  color: var(--st-dim);
  font-size: 22px;
  text-shadow: none;
}

.when {
  color: #d4cab5;
}

.log {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 12px;
  width: 100%;
  margin: 2px 0 0;
  padding: 8px 4px 0;
  border-top: 1px solid rgba(214, 170, 96, 0.16);
  font-size: 12.5px;
}

.log dt {
  color: var(--st-dim);
}

.log dd {
  margin: 0;
  min-width: 0;
}

.log .link {
  margin-left: 6px;
}

.levers {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding-bottom: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .running .sweep,
  .waiting .wave {
    animation: none;
  }

  .waiting .w1 {
    opacity: 0.6;
    width: 70%;
    height: 70%;
  }

  .arc {
    transition: none;
  }
}
</style>
