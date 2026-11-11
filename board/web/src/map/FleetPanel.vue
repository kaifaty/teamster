<script setup lang="ts">
// The open system's ships at the side of the map, by station: the map shows where they are, this list names them.
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Place } from "./placement";

export interface FleetRow {
  slug: string;
  executor: "codex" | "claude";
  name: string;
  phase: string;
  /** The ship needs attention. */
  beacon: boolean;
  title: string;
}

export interface FleetGroup {
  place: Place;
  name: string;
  note: string;
  ships: FleetRow[];
}

const props = defineProps<{
  groups: readonly FleetGroup[];
  total: number;
  /** Tasks of the system the map does not show, and their names. */
  hidden: { count: number; title: string };
  selected: string | null;
  hovered: string | null;
  frame: string;
}>();
const emit = defineEmits<{ pick: [slug: string]; hover: [slug: string | null]; close: [] }>();

const list = ref<HTMLElement | null>(null);
/** The station whose group was asked for from the map: it lights up for a moment. */
const lit = ref<Place | null>(null);
let litTimer: ReturnType<typeof setTimeout> | undefined;

/** Scrolls to station `place` and lights its group up. */
function reveal(place: Place) {
  void nextTick(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.value?.querySelector<HTMLElement>(`[data-place="${place}"]`)?.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
    lit.value = place;
    clearTimeout(litTimer);
    litTimer = setTimeout(() => {
      lit.value = null;
    }, 1400);
  });
}
defineExpose({ reveal });

// A ship picked on the map comes into view in the list.
watch(
  () => props.selected,
  (slug) => {
    if (!slug) return;
    void nextTick(() => list.value?.querySelector<HTMLElement>(`[data-ship="${CSS.escape(slug)}"]`)?.scrollIntoView({ block: "nearest" }));
  },
);

onBeforeUnmount(() => clearTimeout(litTimer));

const glyph = (row: FleetRow) => (row.executor === "codex" ? "◆" : "✳");
</script>

<template>
  <aside id="fleet-panel" class="fleet" :style="{ '--frame': `url(${frame})` }" aria-labelledby="fleet-title">
    <header class="f-head">
      <h2 id="fleet-title">Задачи репозитория<span class="num"> · {{ total }}</span></h2>
      <button type="button" class="f-close" aria-label="Скрыть список задач" title="Скрыть список задач" @click="emit('close')">
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    </header>
    <div ref="list" class="f-list">
      <section v-for="group in groups" :key="group.place" class="f-group" :class="{ lit: lit === group.place }" :data-place="group.place">
        <h3 class="f-station">
          <span class="f-name">{{ group.name }}<span v-if="group.note" class="f-note"> · {{ group.note }}</span></span>
          <span class="num f-count">{{ group.ships.length }}</span>
        </h3>
        <button
          v-for="ship in group.ships"
          :key="ship.slug"
          type="button"
          class="ship"
          :class="[ship.executor, { selected: selected === ship.slug, hovered: hovered === ship.slug, alarm: ship.beacon }]"
          :data-ship="ship.slug"
          :title="ship.title"
          @click="emit('pick', ship.slug)"
          @pointerenter="emit('hover', ship.slug)"
          @pointerleave="emit('hover', null)"
        >
          <span class="r-name"><span class="glyph" aria-hidden="true">{{ glyph(ship) }}</span>{{ ship.name }}</span>
          <span class="r-phase num">{{ ship.phase }}</span>
        </button>
      </section>
      <p v-if="!groups.length" class="f-quiet">Задач нет.</p>
      <p v-if="hidden.count" class="f-quiet" :title="hidden.title">Не показано на карте: {{ hidden.count }}</p>
    </div>
  </aside>
</template>

<style scoped>
/* Stands on the dark sky in both of the board's themes, like the map's other labels. */
.fleet {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-height: 0;
  padding: 2px 4px 4px;
  border: 10px solid transparent;
  border-image: var(--frame) 30 / 10px / 0 stretch;
  background: rgba(8, 10, 15, 0.88);
  background-clip: padding-box;
  color: #e8e2d4;
  font-size: 12px;
  line-height: 16px;
}

.f-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 3px 4px;
}

.f-head h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: #f3c27a;
  font-size: 12.5px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.f-head h2 .num {
  color: #9b907c;
  font-weight: 400;
}

.f-close {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(214, 170, 96, 0.35);
  border-radius: 2px;
  background: rgba(20, 22, 28, 0.9);
  color: #b8ad98;
  cursor: pointer;
}

.f-close:hover {
  border-color: rgba(243, 198, 78, 0.8);
  color: #f3c64e;
}

.f-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

.f-group {
  padding: 2px 0 6px;
  border-radius: 2px;
  transition: background-color 0.4s;
}

.f-group.lit {
  background: rgba(243, 198, 78, 0.16);
}

.f-station {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  padding: 2px 3px;
  background: rgba(8, 10, 15, 0.96);
  color: #f3c27a;
  font-size: 12px;
  font-weight: 650;
}

.f-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.f-note {
  color: #9b907c;
  font-weight: 400;
}

.f-count {
  flex: none;
  color: #b8ad98;
  font-weight: 400;
}

.ship {
  display: block;
  width: 100%;
  margin: 0;
  padding: 2px 3px 2px 14px;
  border: 0;
  border-radius: 2px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.ship:hover,
.ship.hovered {
  background: rgba(214, 170, 96, 0.18);
}

.ship.selected {
  background: rgba(243, 198, 78, 0.28);
}

.ship:focus-visible,
.f-close:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.r-name,
.r-phase {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.r-name {
  margin-left: -11px;
  font-weight: 600;
}

.r-phase {
  color: #a89c86;
  font-size: 11.5px;
}

.ship.alarm .r-phase {
  color: #ff8d7a;
}

.glyph {
  display: inline-block;
  width: 11px;
}

.ship.codex .glyph {
  color: #7ea6f5;
}

.ship.claude .glyph {
  color: #e59472;
}

.f-quiet {
  margin: 4px 3px;
  color: #a89c86;
}

/* A narrow window: rows tall enough for a finger. */
@media (max-width: 760px) {
  .ship {
    padding-top: 5px;
    padding-bottom: 5px;
  }

  .f-close {
    width: 32px;
    height: 32px;
  }
}
</style>
