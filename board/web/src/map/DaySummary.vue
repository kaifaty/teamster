<script setup lang="ts">
// The day's summary: `teamster report` since the local midnight, and the lead's verdicts from the ship's log.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { BoardSource } from "../lib/source";
import type { LogEvent } from "../types";
import { daySummary, dayStart, localDate } from "../lib/report";

const props = defineProps<{ source: BoardSource; events: readonly LogEvent[]; frame: string }>();
const emit = defineEmits<{ close: [] }>();

const today = new Date();
const date = localDate(today);
const since = dayStart(today);
const title = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(today);

const state = ref<"loading" | "ready" | "error">("loading");
const error = ref<string | null>(null);
const data = ref<unknown>(null);
const summary = computed(() => (state.value === "ready" ? daySummary(data.value, props.events, since) : null));
const dialog = ref<HTMLElement | null>(null);

async function load() {
  state.value = "loading";
  error.value = null;
  try {
    const report = await props.source.fetchReport(date, "executor");
    data.value = report?.data ?? null;
    error.value = report?.error ?? null;
    state.value = report?.data == null && report?.error ? "error" : "ready";
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
    state.value = "error";
  }
}

const hours = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
const minutes = (value: number) => `${Math.round(value)} мин`;
const share = (value: number | null) => (value === null ? "—" : `${value}%`);
const rounds = (n: number) => (n === 0 ? "сразу" : `${n} ${n === 1 ? "круг" : n < 5 ? "круга" : "кругов"}`);

function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKey, true);
  void nextTick(() => dialog.value?.focus());
  void load();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <section
      ref="dialog"
      class="day"
      role="dialog"
      aria-modal="true"
      aria-labelledby="day-title"
      tabindex="-1"
      :style="{ '--frame': `url(${frame})` }"
    >
      <header class="d-head">
        <h2 id="day-title">Сводка дня <span>· {{ title }}</span></h2>
        <button type="button" class="d-close" title="Закрыть (Esc)" @click="emit('close')">
          <span aria-hidden="true">✕</span><span class="visually-hidden">Закрыть</span>
        </button>
      </header>

      <p v-if="state === 'loading'" class="d-note">Собираю отчёт за сегодня…</p>
      <p v-else-if="state === 'error'" class="d-note bad">
        Отчёт не собрался: {{ error }}. <a href="#" @click.prevent="load">Повторить</a>
      </p>
      <p v-else-if="!summary" class="d-note">Сегодня задач ещё не было: ни ходов, ни вердиктов.</p>
      <template v-else>
        <p v-if="error" class="d-note bad">Отчёт мог устареть: {{ error }}</p>
        <dl class="stats">
          <div><dt>Задачи</dt><dd class="num">{{ summary.tasks }}</dd></div>
          <div><dt>Ходы</dt><dd class="num">{{ summary.turns }}</dd></div>
          <div><dt>Активные часы</dt><dd class="num">{{ hours(summary.activeHours) }}</dd></div>
        </dl>

        <h3>Вердикты лида</h3>
        <ul class="verdicts num">
          <li class="ok">принято <b>{{ summary.verdicts.accepted }}</b></li>
          <li class="ok">с правками <b>{{ summary.verdicts.revised }}</b></li>
          <li class="bad">переделано <b>{{ summary.verdicts.redone }}</b></li>
          <li class="bad">отброшено <b>{{ summary.verdicts.dropped }}</b></li>
        </ul>

        <h3>Проверки и CI</h3>
        <div class="meters">
          <div class="meter">
            <span>Проверки</span>
            <span class="bar"><span :style="{ width: `${summary.checkPercent ?? 0}%` }"></span></span>
            <span class="num">{{ share(summary.checkPercent) }} <small>из {{ summary.checks }}</small></span>
          </div>
          <div class="meter">
            <span>CI</span>
            <span class="bar"><span :style="{ width: `${summary.ciPercent ?? 0}%` }"></span></span>
            <span class="num">{{ share(summary.ciPercent) }} <small>из {{ summary.ci }}</small></span>
          </div>
        </div>
        <p class="line num">
          Ревью: с замечаниями {{ summary.reviewsWithFindings }} из {{ summary.reviews }}<template v-if="summary.averageFindings !== null">,
            в среднем {{ summary.averageFindings.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) }} замечания</template>
        </p>
        <p v-if="summary.roundsToClean.length" class="line num">
          Круги до чистоты:
          <span v-for="([n, tasks], index) in summary.roundsToClean" :key="n">{{ index ? " · " : "" }}{{ rounds(n) }} — {{ tasks }}</span>
        </p>

        <template v-if="summary.executors.length">
          <h3>По исполнителям</h3>
          <table class="grid num">
            <thead>
              <tr><th>Исполнитель</th><th>Задачи</th><th>Готово</th><th>Медиана</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in summary.executors" :key="row.name">
                <td :class="row.name">{{ row.name === "codex" ? "◆ Codex" : row.name === "claude" ? "✳ Claude" : row.name }}</td>
                <td>{{ row.tasks }}</td>
                <td>{{ share(row.donePercent) }}</td>
                <td>{{ row.medianMinutes === null ? "—" : minutes(row.medianMinutes) }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <template v-if="summary.costly.length">
          <h3>Самые дорогие задачи</h3>
          <ol class="costly">
            <li v-for="task in summary.costly" :key="`${task.repo}/${task.slug}`">
              <span class="c-name" :title="`${task.slug} · ${task.repo}`">{{ task.slug }}<small> · {{ task.repo }}</small></span>
              <span class="num">{{ minutes(task.minutes) }} · ходов {{ task.turns }}</span>
            </li>
          </ol>
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  background: rgba(2, 3, 6, 0.55);
}

.day {
  box-sizing: border-box;
  width: min(560px, 100%);
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  padding: 6px 12px 12px;
  border: 12px solid transparent;
  border-image: var(--frame) 30 / 12px / 0 stretch;
  background: rgba(10, 12, 18, 0.97);
  background-clip: padding-box;
  color: #e8e2d4;
  font-size: 12.5px;
  line-height: 18px;
  outline: none;
}

.d-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.d-head h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: #f3c27a;
  font-size: 15px;
  font-weight: 650;
}

.d-head h2 span {
  color: #9b907c;
  font-weight: 400;
}

.d-close {
  flex: none;
  padding: 2px 7px;
  border: 1px solid rgba(214, 170, 96, 0.3);
  border-radius: 3px;
  background: none;
  color: #b8ad98;
  font: inherit;
  cursor: pointer;
}

.d-close:hover {
  color: #f3c64e;
}

.d-close:focus-visible {
  outline: 2px solid #f3c64e;
}

h3 {
  margin: 12px 0 4px;
  color: #c9b38a;
  font-size: 11.5px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.d-note {
  margin: 10px 0 2px;
  color: #b8ad98;
}

.d-note.bad {
  color: #ff8d7a;
}

.d-note a {
  color: #f3c64e;
}

.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin: 10px 0 0;
}

.stats div {
  padding: 4px 8px;
  border: 1px solid rgba(214, 170, 96, 0.2);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.03);
}

.stats dt {
  color: #9b907c;
  font-size: 11.5px;
}

.stats dd {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  line-height: 24px;
}

.verdicts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.verdicts .ok b {
  color: #9fd8a8;
}

.verdicts .bad b {
  color: #ffb3a3;
}

.meters {
  display: grid;
  gap: 4px;
}

.meter {
  display: grid;
  grid-template-columns: 9.5em minmax(40px, 1fr) 7.5em;
  align-items: center;
  gap: 8px;
}

.bar {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.bar span {
  display: block;
  height: 100%;
  background: #c99a4b;
}

small {
  color: #9b907c;
  font-size: 11px;
}

.line {
  margin: 4px 0 0;
}

.grid {
  width: 100%;
  border-collapse: collapse;
}

.grid th {
  color: #9b907c;
  font-weight: 400;
  text-align: left;
}

.grid th,
.grid td {
  padding: 2px 6px 2px 0;
  border-bottom: 1px solid rgba(214, 170, 96, 0.12);
}

.grid .codex {
  color: #7ea6f5;
}

.grid .claude {
  color: #e59472;
}

.costly {
  margin: 0;
  padding: 0 0 0 18px;
}

.costly li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.c-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.costly .num {
  flex: none;
  color: #b8ad98;
}

@media (max-width: 480px) {
  .meter {
    grid-template-columns: minmax(0, 1fr) 6.5em;
  }

  .meter .bar {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>
