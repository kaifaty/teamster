<script setup lang="ts">
// The replay's scale over the ship's log: a day of the fleet, played back like a recording.
import { computed } from "vue";
import { replayDays, replayMarks } from "./replay";
import { REPLAY_SPEEDS, type Replay } from "./useReplay";

const props = defineProps<{ replay: Replay; frame: string; now: number }>();

const HINT =
  "Перемотка показывает задачи по журналу событий такими, какими они были в тот момент. " +
  "Аккаунты и машины показаны как сейчас: их прошлое не записано.";

const clock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayName = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short" });
const time = (at: number) => clock.format(new Date(at * 1000));

// The list of days changes only with the date, not with every tick of the clock.
const today = computed(() => new Date(props.now * 1000).toDateString());
const days = computed(() => {
  void today.value;
  return replayDays(props.now).map((day, index) => ({
    value: day,
    text: day === "" ? "последние 24 ч" : index === 1 ? "сегодня" : dayName.format(new Date(`${day}T12:00:00`)),
  }));
});

const marks = computed(() => replayMarks(props.replay.events, props.replay.window));
const value = computed(() => props.replay.at ?? props.replay.window.until);

function onInput(event: Event) {
  props.replay.seek(Number((event.target as HTMLInputElement).value));
}

function onDay(event: Event) {
  props.replay.choose((event.target as HTMLSelectElement).value);
}

const KIND_TEXT = { sun: "вердикт", verdict: "вердикт", ci: "CI упал" } as const;
</script>

<template>
  <section class="replay" :class="{ on: replay.active }" :style="{ '--frame': `url(${frame})` }" aria-label="Перемотка дня" :title="HINT">
    <div class="r-row">
      <button
        type="button"
        class="r-btn r-play"
        :aria-label="replay.playing ? 'Пауза' : 'Пуск'"
        :title="replay.playing ? 'Пауза' : 'Пуск'"
        @click="replay.playing ? replay.pause() : replay.play()"
      >
        {{ replay.playing ? "❚❚" : "▶" }}
      </button>
      <span class="r-now num" aria-live="off">{{ replay.at === null ? "сейчас" : time(replay.at) }}</span>
      <span class="r-seg" role="group" aria-label="Скорость">
        <button
          v-for="speed in REPLAY_SPEEDS"
          :key="speed"
          type="button"
          class="r-btn num"
          :aria-pressed="replay.speed === speed"
          @click="replay.speed = speed"
        >
          ×{{ speed }}
        </button>
      </span>
      <select class="r-day" aria-label="День" :value="replay.day" @change="onDay">
        <option v-for="day in days" :key="day.value" :value="day.value">{{ day.text }}</option>
      </select>
      <button type="button" class="r-btn r-live" :disabled="!replay.active" @click="replay.live()" title="Вернуться к текущему моменту">Сейчас</button>
      <span class="r-info" :title="HINT" aria-hidden="true">?</span>
      <span class="sr-only">{{ HINT }}</span>
    </div>
    <div class="r-scale">
      <div class="r-marks">
        <button
          v-for="mark in marks"
          :key="`${mark.kind}-${mark.at}`"
          type="button"
          class="r-mark"
          :class="mark.kind"
          :style="{ left: `${mark.share * 100}%` }"
          :title="`${time(mark.at)} · ${mark.text}`"
          :aria-label="`${time(mark.at)}, ${KIND_TEXT[mark.kind]}: ${mark.text}`"
          tabindex="-1"
          @click="replay.seek(mark.at)"
        ></button>
      </div>
      <input
        class="r-range"
        type="range"
        aria-label="Момент дня"
        :aria-valuetext="time(value)"
        :min="Math.floor(replay.window.since)"
        :max="Math.ceil(replay.window.until)"
        step="60"
        :value="value"
        @input="onInput"
      />
      <div class="r-ends num" aria-hidden="true">
        <span>{{ time(replay.window.since) }}</span>
        <span v-if="replay.error" class="r-error" :title="replay.error">журнал не загрузился</span>
        <span>{{ time(replay.window.until) }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Stands on the dark sky in both of the board's themes, like the ship's log under it. */
.replay {
  box-sizing: border-box;
  width: 100%;
  padding: 2px 4px 2px;
  border: 10px solid transparent;
  border-image: var(--frame) 30 / 10px / 0 stretch;
  background: rgba(8, 10, 15, 0.88);
  background-clip: padding-box;
  color: #e8e2d4;
  font-size: 12px;
  line-height: 16px;
}

.r-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  min-width: 0;
}

.r-btn,
.r-day {
  height: 22px;
  margin: 0;
  padding: 0 6px;
  border: 1px solid rgba(214, 170, 96, 0.35);
  border-radius: 2px;
  background: rgba(20, 22, 28, 0.9);
  color: #e8e2d4;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.r-btn:hover:not(:disabled),
.r-day:hover {
  border-color: rgba(243, 198, 78, 0.8);
}

.r-btn[aria-pressed="true"] {
  border-color: rgba(243, 198, 78, 0.9);
  background: rgba(243, 198, 78, 0.22);
  color: #f3c64e;
}

.r-btn:disabled {
  color: #6f6a60;
  cursor: default;
}

.r-btn:focus-visible,
.r-day:focus-visible,
.r-range:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.r-play {
  width: 28px;
  padding: 0;
  color: #f3c27a;
}

.r-now {
  min-width: 38px;
  color: #f3c27a;
  font-weight: 650;
}

.replay:not(.on) .r-now {
  color: #9b907c;
  font-weight: 400;
}

.r-seg {
  display: inline-flex;
}

.r-seg .r-btn {
  margin-left: -1px;
  border-radius: 0;
  padding: 0 5px;
}

.r-seg .r-btn:first-child {
  margin-left: 0;
  border-radius: 2px 0 0 2px;
}

.r-seg .r-btn:last-child {
  border-radius: 0 2px 2px 0;
}

.r-day {
  min-width: 0;
  max-width: 130px;
  padding: 0 2px;
  text-overflow: ellipsis;
}

.r-live {
  margin-left: auto;
}

.replay.on .r-live {
  border-color: rgba(255, 141, 122, 0.7);
  color: #ffb3a3;
}

.r-info {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: 1px solid rgba(214, 170, 96, 0.35);
  border-radius: 50%;
  color: #b8ad98;
  font-size: 10.5px;
  cursor: help;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.r-scale {
  position: relative;
  margin-top: 3px;
}

/* The marks stand over the track; the slider's thumb runs under them. */
.r-marks {
  position: relative;
  height: 9px;
  margin: 0 7px;
}

.r-mark {
  position: absolute;
  top: 0;
  width: 9px;
  height: 9px;
  margin: 0 0 0 -4.5px;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
}

.r-mark::before {
  content: "";
  position: absolute;
  left: 3.5px;
  top: 0;
  width: 2px;
  height: 9px;
  border-radius: 1px;
}

.r-mark.sun::before {
  background: #f3c64e;
}

.r-mark.verdict::before {
  background: #9aa3b4;
}

.r-mark.ci::before {
  background: #ff6f5b;
}

.r-range {
  display: block;
  width: 100%;
  height: 16px;
  margin: 0;
  accent-color: #d6aa60;
  cursor: pointer;
}

.replay:not(.on) .r-range {
  opacity: 0.6;
}

.r-ends {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  color: #9b907c;
  font-size: 10.5px;
  line-height: 12px;
}

.r-error {
  min-width: 0;
  overflow: hidden;
  color: #ff8d7a;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 760px) {
  .r-btn,
  .r-day {
    height: 26px;
  }

  .r-info {
    display: none;
  }
}
</style>
