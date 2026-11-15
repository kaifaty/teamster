<script setup lang="ts">
// The control panel at the map's bottom, across its whole width: on the left wing the duty and the subscriptions, in the
// lower centre the events, on the right wing the machines and the reflection. The galaxy and a system are laid out above
// it. On a narrow window it folds to a strip, the duty and the newest event, and the wings open over the map on demand.
import { computed, nextTick, ref, watch } from "vue";
import type { Machines, LogEvent } from "../../types";
import type { Star, Tank } from "../fleet";
import type { Research } from "../research";
import ShipLog from "../ShipLog.vue";
import ConsoleDuty from "./ConsoleDuty.vue";
import ConsoleMachines from "./ConsoleMachines.vue";
import ConsoleReflection from "./ConsoleReflection.vue";
import ConsoleSubscriptions from "./ConsoleSubscriptions.vue";
import { dutyBlock, machineRow, reflectionNote, subscriptionRow } from "./texts";

const props = defineProps<{
  frame: string;
  now: number;
  tanks: readonly Tank[];
  stars: readonly Star[];
  machines: Machines | null;
  /** The machine whose card is open, or null. */
  machine: string | null;
  /** The subscription whose screen is open, or null. */
  account: string | null;
  station: Research | null;
  researchOpen: boolean;
  logEvents: readonly LogEvent[];
  eventsError: string | null;
  /** The open system; null means the whole galaxy is shown. */
  repo: string | null;
  systemNames: ReadonlySet<string>;
  emblemOf: (repo: string | null) => string | null;
  /** A phone-sized window: the panel folds to a strip. */
  narrow: boolean;
}>();
const emit = defineEmits<{
  go: [event: LogEvent];
  openAccount: [key: string];
  machine: [id: string, opener: HTMLElement];
  openResearch: [];
}>();
/** The whole log, open over the map from the narrow strip. */
const logOpen = defineModel<boolean>("logOpen", { required: true });

const duty = computed(() => dutyBlock(props.tanks, props.stars, props.now));
const subscriptions = computed(() => props.tanks.map((tank) => subscriptionRow(tank, props.now)));
const machineRows = computed(() => (props.machines?.items ?? []).map((machine) => machineRow(machine, props.now)));
const reflection = computed(() => reflectionNote(props.station));

/** On a narrow window: the wings stand open over the map. */
const sheetOpen = ref(false);
const moreButton = ref<HTMLButtonElement | null>(null);
watch(
  () => props.narrow,
  () => {
    sheetOpen.value = false;
  },
);
// The wings and the whole log open over the same part of the map: one closes the other.
watch(logOpen, (open) => {
  if (open) sheetOpen.value = false;
});
watch(sheetOpen, (open) => {
  if (open) logOpen.value = false;
});

/** Escape folds what the strip opened before the map hears it. */
function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || !props.narrow || !sheetOpen.value) return;
  event.stopPropagation();
  sheetOpen.value = false;
  void nextTick(() => moreButton.value?.focus());
}
</script>

<template>
  <section
    class="console"
    :class="{ narrow, 'sheet-open': narrow && sheetOpen }"
    :style="{ '--frame': `url(${frame})` }"
    aria-label="Панель управления"
    @keydown="onKey"
  >
    <div v-if="narrow" class="console-strip">
      <ConsoleDuty :duty="duty" compact @open="emit('openAccount', $event)" />
      <button
        ref="moreButton"
        type="button"
        class="console-more"
        :aria-expanded="sheetOpen"
        aria-controls="console-sheet"
        :aria-label="sheetOpen ? 'Скрыть подписки, машины и рефлексию' : 'Показать подписки, машины и рефлексию'"
        @click="sheetOpen = !sheetOpen"
      >
        Ещё <span aria-hidden="true">{{ sheetOpen ? "▾" : "▴" }}</span>
      </button>
    </div>
    <div v-show="!narrow || sheetOpen" id="console-sheet" class="console-sheet">
      <div class="console-wing console-left">
        <ConsoleDuty v-if="!narrow" :duty="duty" @open="emit('openAccount', $event)" />
        <ConsoleSubscriptions :rows="subscriptions" :open="account" @open="emit('openAccount', $event)" />
      </div>
      <div class="console-wing console-right">
        <ConsoleMachines :rows="machineRows" :note="machines?.config_error || null" :open="machine" @open="(id, opener) => emit('machine', id, opener)" />
        <ConsoleReflection :reflection="reflection" :research-open="researchOpen" @open="emit('openResearch')" />
      </div>
    </div>
    <div class="console-centre">
      <ShipLog
        v-model:open="logOpen"
        :events="logEvents"
        :error="eventsError"
        :repo="repo"
        :frame="frame"
        :systems="systemNames"
        :emblem-of="emblemOf"
        :compact="narrow"
        @go="emit('go', $event)"
      />
    </div>
  </section>
</template>

<style scoped>
/*
 * The panel's box: the wings stand taller than the centre, whose top leaves the sky between them. The box takes no
 * pointer itself, so the sky above the centre still moves the map. Its height stays within 28 % of a 1080-pixel window
 * and 34 % of a 720-pixel one.
 */
.console {
  --wing-height: clamp(150px, 21vh, 214px);
  --centre-height: calc(var(--wing-height) - 36px);
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 1.1fr) minmax(0, 1fr);
  align-items: end;
  gap: 4px;
  box-sizing: border-box;
  height: var(--wing-height);
  padding: 0 4px 4px;
  pointer-events: none;
}

.console > *,
.console-sheet > * {
  pointer-events: auto;
}

/* On a wide window the sheet is no box of its own: its wings stand in the panel's grid. */
.console-sheet {
  display: contents;
}

.console-wing {
  display: grid;
  gap: 4px;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.console-left {
  grid-column: 1;
  grid-row: 1;
  grid-template-columns: minmax(130px, 0.8fr) minmax(150px, 1fr);
}

.console-right {
  grid-column: 3;
  grid-row: 1;
  grid-template-columns: minmax(150px, 1fr) minmax(110px, 0.7fr);
}

.console-centre {
  position: relative;
  grid-column: 2;
  grid-row: 1;
  height: var(--centre-height);
  min-width: 0;
}

.console-centre > :deep(.log) {
  height: 100%;
}

.console-centre > :deep(.log:not(.open)) .l-rows {
  flex: 1;
  height: auto;
  min-height: 0;
}

/* «развернуть»: the long list opens over the map from the centre, up to the toolbar. */
.console-centre > :deep(.log.open) {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: min(62vh, calc(var(--stage-height, 100vh) - var(--below-toolbar, 46px) - 8px));
}

/* A middling window: the duty keeps its text and drops its portrait's room first. */
@media (max-width: 1180px) {
  .console {
    grid-template-columns: minmax(0, 1fr) minmax(240px, 0.9fr) minmax(0, 1fr);
  }

  .console-left {
    grid-template-columns: minmax(110px, 0.8fr) minmax(130px, 1fr);
  }

  .console-right {
    grid-template-columns: minmax(130px, 1fr) minmax(96px, 0.7fr);
  }
}

/* A narrow window: a strip with the duty and the newest event; the wings open over the map above it. */
.console.narrow {
  display: flex;
  flex-direction: column;
  gap: 2px;
  height: auto;
  padding: 0 4px 4px;
}

.console-strip {
  display: flex;
  gap: 4px;
  min-width: 0;
}

.console-strip > :deep(.console-duty) {
  flex: 1;
  min-width: 0;
}

.console-more {
  flex: none;
  min-width: 64px;
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid rgba(214, 170, 96, 0.45);
  border-radius: 3px;
  background: rgba(8, 10, 15, 0.9);
  color: #f3c27a;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}

.console-more:hover {
  border-color: rgba(243, 198, 78, 0.8);
}

.console-more:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.console.narrow .console-centre {
  height: auto;
}

.console.narrow .console-centre > :deep(.log) {
  height: auto;
}

/* The narrow window's whole log opens over the map, above the strip and under the toolbar. */
.console.narrow .console-centre > :deep(.log.open) {
  height: calc(var(--stage-height, 100vh) - var(--below-toolbar, 46px) - 8px);
  max-height: 62vh;
}

.console.narrow .console-sheet {
  position: absolute;
  left: 4px;
  right: 4px;
  bottom: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: calc(var(--stage-height, 100vh) - var(--below-toolbar, 46px) - var(--console-room, 0px) - 4px);
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* Over the map the wings keep their whole height, the sheet scrolls, and the sky does not show through. */
.console.narrow .console-wing {
  flex: none;
  grid-template-columns: none;
  grid-auto-rows: auto;
  height: auto;
}

.console.narrow .console-wing > :deep(.console-block) {
  height: auto;
  background-color: rgba(8, 10, 15, 0.98);
}

.console.narrow .console-wing > :deep(.console-reflection) {
  height: 150px;
}
</style>
