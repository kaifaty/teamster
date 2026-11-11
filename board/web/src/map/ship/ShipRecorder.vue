<script setup lang="ts">
// The flight recorder in the voyage log: the whole voyage as a tape of stops in time, with the lead's orders, the
// refuels, the verdicts and the failures over it, a time scale and the stops' colours under it, and the time summed up
// by what the ship did. The tape keeps its width and scrolls inside the log on a narrow screen.
import { computed, ref, watch } from "vue";
import type { BoardSource } from "../../lib/source";
import type { LogEvent, TaskLimits, TaskMessage, TaskSummary } from "../../types";
import { TAPE_STOPS, logSlug, recordedTape, recorderWindow, tapeSummary, tapeTicks } from "./recorder";

const props = defineProps<{
  task: TaskSummary;
  source: BoardSource;
  messages: readonly TaskMessage[];
  limits: TaskLimits | null | undefined;
  now: number;
}>();

const events = ref<LogEvent[] | null>(null);
const error = ref<string | null>(null);
const truncated = ref(false);

let request = 0;
async function load() {
  const asked = ++request;
  const slug = logSlug(props.task.slug);
  const { since, until } = recorderWindow(props.task.created, Date.now() / 1000);
  error.value = null;
  try {
    const result = await props.source.fetchEvents(since, until);
    if (asked !== request) return;
    events.value = result.events.filter((event) => event.slug === slug);
    truncated.value = result.truncated === true;
  } catch (failure) {
    if (asked !== request) return;
    error.value = failure instanceof Error ? failure.message : String(failure);
  }
}

watch(
  () => props.task.slug,
  () => {
    events.value = null;
    void load();
  },
  { immediate: true },
);
// The log grows as the task changes.
watch(
  () => props.task.updated_at,
  (next, previous) => {
    if (next !== previous) void load();
  },
);

const tape = computed(() => recordedTape(events.value, props.task, props.messages, props.limits?.rotations ?? [], props.now, truncated.value));
const ticks = computed(() => (tape.value ? tapeTicks(tape.value.start, tape.value.end, props.task.column !== "closed" && tape.value.end >= props.now) : []));
const colors = Object.fromEntries(TAPE_STOPS.map((stop) => [stop.id, stop.color]));
const lanes = computed(() => Math.max(1, ...(tape.value?.marks.map((mark) => mark.lane + 1) ?? [])));
</script>

<template>
  <div class="recorder">
    <p v-if="error && !tape" class="empty tone-bad">
      Не удалось прочитать журнал: {{ error }}
      <button type="button" class="key retry" @click="load">Повторить</button>
    </p>
    <p v-else-if="events === null" class="empty">Читаю журнал…</p>
    <p v-else-if="!tape" class="empty">Журнал пуст: рейс ещё не записан</p>
    <p v-if="tape?.truncated" class="empty">Журнал неполный: ранние события не вошли</p>
    <div v-if="tape" class="tape-wrap">
      <div class="tape">
        <div class="pins" :style="{ height: `${lanes * 16 + 2}px` }">
          <span
            v-for="(mark, index) in tape.marks"
            :key="`${mark.kind}-${mark.at}-${index}`"
            class="pin"
            :class="[mark.kind, { first: mark.left < 4, last: mark.left > 96 }]"
            :style="{ left: `${mark.left}%`, bottom: `${mark.lane * 16}px` }"
            :title="mark.title"
            tabindex="0"
            :aria-label="mark.title"
            >{{ mark.label }}</span
          >
        </div>
        <div class="bars" role="list" aria-label="Стоянки по времени">
          <i
            v-for="(segment, index) in tape.segments"
            :key="`${segment.stop}-${segment.from}-${index}`"
            role="listitem"
            :class="{ live: segment.live, failed: segment.failed, wait: segment.stop === 'wait' }"
            :style="{ left: `${segment.left}%`, width: `${segment.width}%`, backgroundColor: colors[segment.stop] }"
            :title="segment.title"
            :aria-label="segment.title"
          ></i>
        </div>
        <div class="ticks num" aria-hidden="true">
          <span v-for="tick in ticks" :key="tick.left" :class="{ first: tick.left === 0, last: tick.left === 100 }" :style="{ left: `${tick.left}%` }">{{ tick.label }}</span>
        </div>
      </div>
    </div>
    <div v-if="tape" class="legend">
      <span v-for="stop in TAPE_STOPS" :key="stop.id" :class="{ wait: stop.id === 'wait' }" :style="{ '--c': stop.color }">{{ stop.legend }}</span>
    </div>
    <p v-if="tape" class="sum">{{ tapeSummary(tape) }}</p>
    <p v-if="error && tape" class="empty tone-bad">
      Журнал не обновился: {{ error }}
      <button type="button" class="key retry" @click="load">Повторить</button>
    </p>
  </div>
</template>

<style scoped>
.recorder {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.sum {
  margin: 0;
  color: var(--sh-dim);
  font-size: 12.5px;
}

/* The time a stopped ship waited for you: hatched, apart from the stops where it worked. */
.bars i.wait {
  background-image: repeating-linear-gradient(-45deg, rgba(0, 0, 0, 0) 0 5px, rgba(0, 0, 0, 0.45) 5px 10px);
}

.legend span.wait::before {
  background-image: repeating-linear-gradient(-45deg, rgba(0, 0, 0, 0) 0 3px, rgba(0, 0, 0, 0.45) 3px 6px);
}

.retry {
  margin-left: 8px;
  padding: 2px 10px;
}

.tape-wrap {
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

.tape {
  display: grid;
  gap: 6px;
  min-width: 560px;
  padding: 0 2px 2px;
}

.pins {
  position: relative;
}

.pin {
  position: absolute;
  color: var(--sh-dim);
  font-size: 11px;
  line-height: 15px;
  white-space: nowrap;
  transform: translateX(-50%);
  cursor: default;
}

.pin.first {
  transform: none;
}

.pin.last {
  transform: translateX(-100%);
}

.pin.say {
  color: var(--sh-title);
}

.pin.fuel {
  color: var(--sh-teal);
}

.pin.verdict {
  color: var(--sh-green);
}

.pin.fail {
  color: var(--sh-red);
  font-weight: 700;
}

/* Gaps between the stops stay a thin grey line. */
.bars {
  position: relative;
  height: 26px;
  border: 1px solid rgba(214, 170, 96, 0.2);
  border-radius: 6px;
  overflow: hidden;
}

.bars::before {
  content: "";
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 2px;
  margin-top: -1px;
  background: rgba(155, 144, 124, 0.45);
}

.bars i {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 2px;
  border-right: 1px solid rgba(0, 0, 0, 0.6);
}

.bars i.live {
  background-image: repeating-linear-gradient(-45deg, transparent 0 6px, rgba(255, 255, 255, 0.16) 6px 12px);
}

.bars i.failed {
  box-shadow: inset 0 -3px 0 var(--sh-red);
}

.ticks {
  position: relative;
  height: 15px;
  color: var(--sh-faint);
  font-size: 11px;
  line-height: 15px;
}

.ticks span {
  position: absolute;
  white-space: nowrap;
  transform: translateX(-50%);
}

.ticks span.first {
  transform: none;
}

.ticks span.last {
  transform: translateX(-100%);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: var(--sh-dim);
  font-size: 11.5px;
}

.legend span::before {
  content: "";
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 5px;
  border-radius: 2px;
  background: var(--c);
  vertical-align: -1px;
}
</style>
