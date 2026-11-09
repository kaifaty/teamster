<script setup lang="ts">
// The map's toolbar: the way back to the galaxy, the system's picker, the demo's source, the day's summary, the ships'
// list, the legend and the hint.
import { ref } from "vue";
import type { ShipEntry } from "./scene";
import type { GalaxyModel } from "./use/useGalaxyModel";

defineProps<{
  /** The open system; null means the whole galaxy is shown. */
  repo: string | null;
  emblemOf: (name: string | null) => string | null;
  starList: GalaxyModel["starList"]["value"];
  pickerGroups: GalaxyModel["pickerGroups"]["value"];
  demo: boolean;
  fleetVisible: boolean;
  /** The open system's ships. */
  entries: readonly ShipEntry[];
}>();
const emit = defineEmits<{ leave: []; toggleFleet: [] }>();
/** The picked system, "" for the whole galaxy. */
const repoModel = defineModel<string>("repoModel", { required: true });
const sourceKind = defineModel<"board" | "scenario">("sourceKind", { required: true });
const summaryOpen = defineModel<boolean>("summaryOpen", { required: true });

/** The day's summary gives the focus back to its button when it closes. */
const summaryButton = ref<HTMLButtonElement | null>(null);
defineExpose({ summaryButton });

const hideImage = (event: Event) => {
  (event.target as HTMLElement).hidden = true;
};
</script>

<template>
  <div class="toolbar">
    <button v-if="repo" type="button" class="btn" @click="emit('leave')">← Галактика</button>
    <label class="picker">
      <img v-if="emblemOf(repo)" :key="emblemOf(repo)!" class="emblem" :src="emblemOf(repo)!" alt="" @error="hideImage" />
      <span>Система</span>
      <select v-model="repoModel" class="btn" :disabled="!starList.length">
        <option value="">вся галактика</option>
        <optgroup v-for="group in pickerGroups.grouped" :key="group.name" :label="group.name">
          <option v-for="star in group.stars" :key="star.repo" :value="star.repo">{{ star.repo }} · {{ star.live }}</option>
        </optgroup>
        <option v-for="star in pickerGroups.rest" :key="star.repo" :value="star.repo">{{ star.repo }} · {{ star.live }}</option>
      </select>
    </label>
    <div v-if="demo" class="seg" role="group" aria-label="Источник карты">
      <button type="button" class="btn" :aria-pressed="sourceKind === 'board'" @click="sourceKind = 'board'">Доска</button>
      <button type="button" class="btn" :aria-pressed="sourceKind === 'scenario'" @click="sourceKind = 'scenario'">Сценарий</button>
    </div>
    <button ref="summaryButton" type="button" class="btn" :aria-expanded="summaryOpen" @click="summaryOpen = true">Сводка дня</button>
    <button
      v-if="repo"
      type="button"
      class="btn"
      :aria-expanded="fleetVisible"
      aria-controls="fleet-panel"
      :title="fleetVisible ? 'Скрыть список кораблей' : 'Показать список кораблей'"
      @click="emit('toggleFleet')"
    >
      Корабли · {{ entries.length }}
    </button>
    <span class="legend" aria-hidden="true">
      <span class="codex">◆ Codex</span>
      <span class="claude">✳ Claude</span>
      <template v-if="!repo">
        <span class="key"><i class="badge b-alarm" />тревоги</span>
        <span class="key"><i class="badge b-ready" />ждут тебя</span>
        <span class="key"><i class="badge b-sleep" />спят</span>
      </template>
    </span>
    <span class="hint">{{ repo ? "Колесо назад, щипок или Esc — к галактике" : "Нажми на звезду · колесо или щипок — масштаб · тяни — обзор" }}</span>
  </div>
</template>

<style scoped src="./overlay/overlay.css"></style>

<style scoped>
.toolbar {
  position: absolute;
  top: 8px;
  left: 10px;
  right: 10px;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  pointer-events: none;
}

.toolbar > * {
  pointer-events: auto;
}

.picker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 3px 2px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  font-weight: 600;
  min-width: 0;
}

.picker select {
  max-width: 260px;
  padding: 1px 6px;
  text-overflow: ellipsis;
  font-weight: 400;
}

.seg {
  display: inline-flex;
}

.seg .btn {
  border-radius: 0;
  margin-left: -1px;
}

.seg .btn:first-child {
  border-radius: var(--radius) 0 0 var(--radius);
  margin-left: 0;
}

.seg .btn:last-child {
  border-radius: 0 var(--radius) var(--radius) 0;
}

.legend {
  display: inline-flex;
  gap: 8px;
  padding: 2px 8px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--surface) 85%, transparent);
  font-size: 12px;
  font-weight: 650;
}

.legend .codex {
  color: var(--codex);
}

.legend .claude {
  color: var(--claude);
}

.hint {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  color: var(--muted);
  font-size: 11.5px;
}

.legend .key {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-weight: 500;
}

.legend .key .badge {
  min-width: 9px;
  height: 9px;
  padding: 0;
}

.picker .emblem {
  width: 24px;
  height: 24px;
  margin-left: -6px;
}

@media (max-width: 760px) {
  .hint {
    display: none;
  }
  .picker select {
    max-width: 52vw;
  }
}
</style>
