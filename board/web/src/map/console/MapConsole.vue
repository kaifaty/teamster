<script setup lang="ts">
// The control panel at the map's bottom, across its whole width, in a cast frame: on the left wing the duty and the
// subscriptions, in the lower centre the events, on the right wing the machines and the reflection. The galaxy and a
// system are laid out above it. On a narrow window it folds to a strip, the duty and the newest event, and the wings open
// over the map on demand.
import { computed, nextTick, ref, watch } from "vue";
import type { Machines, LogEvent } from "../../types";
import type { Star, Tank } from "../fleet";
import type { Research } from "../research";
import ShipLog from "../ShipLog.vue";
import ConsoleDuty from "./ConsoleDuty.vue";
import ConsoleMachines from "./ConsoleMachines.vue";
import ConsoleReflection from "./ConsoleReflection.vue";
import ConsoleSubscriptions from "./ConsoleSubscriptions.vue";
import { PORTRAIT_URLS } from "./portraits";
import { dutyBlock, machineRow, portraitNames, reflectionNote, subscriptionRow } from "./texts";

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
/** Each subscription's portrait, by its key, and the duty's. */
const portraits = computed(() => new Map([...portraitNames(props.tanks)].flatMap(([key, name]) => (PORTRAIT_URLS[name] ? [[key, PORTRAIT_URLS[name]] as const] : []))));
const dutyPortrait = computed(() => (duty.value.key ? (portraits.value.get(duty.value.key) ?? null) : null));

/** On a narrow window: the wings stand open over the map. */
const sheetOpen = ref(false);
const moreButton = ref<HTMLButtonElement | null>(null);
watch(
  () => props.narrow,
  () => {
    sheetOpen.value = false;
  },
);
/**
 * The centre's height while the narrow window's whole log stands open over the map: the open log leaves the flow, and the
 * panel's box keeps its size, so that the galaxy is not fitted anew. Read before the log opens.
 */
const centre = ref<HTMLElement | null>(null);
const keptHeight = ref<number | null>(null);
// The wings and the whole log open over the same part of the map: one closes the other.
watch(
  logOpen,
  (open) => {
    keptHeight.value = open && props.narrow ? (centre.value?.offsetHeight ?? null) : null;
    if (open) sheetOpen.value = false;
  },
  { flush: "pre" },
);
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
      <ConsoleDuty :duty="duty" :portrait="dutyPortrait" compact @open="emit('openAccount', $event)" />
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
        <ConsoleDuty v-if="!narrow" :duty="duty" :portrait="dutyPortrait" @open="emit('openAccount', $event)" />
        <i class="console-divider" aria-hidden="true"></i>
        <ConsoleSubscriptions :rows="subscriptions" :portraits="portraits" :open="account" @open="emit('openAccount', $event)" />
      </div>
      <div class="console-wing console-right">
        <ConsoleMachines :rows="machineRows" :note="machines?.config_error || null" :open="machine" @open="(id, opener) => emit('machine', id, opener)" />
        <i class="console-divider" aria-hidden="true"></i>
        <ConsoleReflection :reflection="reflection" :research-open="researchOpen" @open="emit('openResearch')" />
      </div>
    </div>
    <div ref="centre" class="console-centre" :style="keptHeight ? { minHeight: `${keptHeight}px` } : undefined">
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
 * The panel's box is as tall as the wings, and the galaxy is fitted above it. The box takes no pointer itself, so the sky
 * above the low centre still moves the map. The wings are about 26 % of the window's height, within 28 % of a 1080-pixel
 * window and 34 % of a 720-pixel one, and no wider than a fifth of the window each.
 *
 * The wing's art (console-wing.png, 875×560) holds one dark compartment: x 46–782, its top at y 103 under the high
 * shoulder (up to x 390) and at y 135 past the step, its bottom at y 510; the body's right edge is at x 820, a pipe stub
 * reaches x 873 at y 160–200. The blocks stand inside it, placed in shares of the art so that they keep clear of the frame
 * at any size. The right wing is the same art mirrored; its blocks are placed as the mirror of the left wing's.
 */
.console {
  --wing-height: clamp(140px, min(26.5vh, 19.5vw), 300px);
  --wing-width: calc(var(--wing-height) * 875 / 560);
  /* The centre: 62 % of the wings, its strip's rails (console-strip.png, 2126×280: rails 72 high, end caps 52 wide). */
  --centre-height: calc(var(--wing-height) * 0.62);
  --rail-y: calc(var(--centre-height) * 72 / 280);
  --rail-x: calc(var(--centre-height) * 52 / 280);
  /* The centre starts under the wing's body, which ends at 820 / 875 of its width. */
  --centre-inset: calc(var(--wing-width) * 0.9);
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  box-sizing: border-box;
  height: var(--wing-height);
  pointer-events: none;
}

.console > *,
.console-sheet > * {
  pointer-events: auto;
}

/* On a wide window the sheet is no box of its own: its wings stand in the panel. */
.console-sheet {
  display: contents;
}

.console-wing {
  position: absolute;
  bottom: 0;
  z-index: 1;
  width: var(--wing-width);
  height: var(--wing-height);
}

.console-wing::before {
  content: "";
  position: absolute;
  inset: 0;
  background: url("../art/console-wing.png") center / 100% 100% no-repeat;
  pointer-events: none;
}

.console-left {
  left: 0;
}

.console-right {
  right: 0;
}

/* The right wing mirrors the art only, not its blocks. */
.console-right::before {
  transform: scaleX(-1);
}

.console-wing > :deep(.console-block) {
  position: absolute;
  height: auto;
}

/* The duty's and the reflection's windows: under the high shoulder, their outer corners following the compartment's. */
.console-left > :deep(.console-duty),
.console-right > :deep(.console-reflection) {
  top: 20.2%;
  width: 38.4%;
  height: 69.1%;
}

.console-left > :deep(.console-duty) {
  left: 6.4%;
  --window-radius: 25% 4px 4px 16% / 21.7% 4px 4px 14%;
}

.console-right > :deep(.console-reflection) {
  left: 55.2%;
  --window-radius: 4px 25% 16% 4px / 4px 21.7% 14% 4px;
}

/* The lists: past the step, below its lower top. */
.console-left > :deep(.console-subscriptions),
.console-right > :deep(.console-machines) {
  top: 26.2%;
  width: 39.5%;
  height: 62.7%;
}

.console-left > :deep(.console-subscriptions) {
  left: 46.9%;
}

.console-right > :deep(.console-machines) {
  left: 13.6%;
}

/* A thin amber divider between the blocks of a compartment, in the tone of the frame's inner kant. */
.console-divider {
  position: absolute;
  top: 27%;
  width: 1px;
  height: 61%;
  background: linear-gradient(to bottom, transparent, rgba(240, 165, 70, 0.7) 18%, rgba(240, 165, 70, 0.7) 82%, transparent);
  box-shadow: 0 0 4px rgba(240, 150, 50, 0.45);
}

.console-left > .console-divider {
  left: 45.7%;
}

.console-right > .console-divider {
  left: 54.3%;
}

/* The low centre: the strip's rails and end caps keep their shape, its middle stretches; it starts under the wings. */
.console-centre {
  position: absolute;
  left: var(--centre-inset);
  right: var(--centre-inset);
  bottom: 0;
  z-index: 0;
  box-sizing: border-box;
  height: var(--centre-height);
  padding: 2px 4px;
  border-style: solid;
  border-color: transparent;
  border-width: var(--rail-y) var(--rail-x);
  border-image: url("../art/console-strip.png") 72 52 fill / var(--rail-y) var(--rail-x) round;
}

.console-centre > :deep(.log) {
  height: 100%;
}

.console-centre > :deep(.log:not(.open)) {
  padding: 0;
  border: 0;
  border-image: none;
  background: none;
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
  padding: 4px 6px;
  border: 1px solid rgba(240, 165, 70, 0.6);
  border-image: none;
  border-radius: 6px;
  background: rgba(6, 9, 16, 0.97);
}

/*
 * A narrow window: a strip in the centre's rails with the duty and the newest event; the wings open over the map above
 * it, their blocks one under another.
 */
.console.narrow {
  --strip-rail-y: 16px;
  --strip-rail-x: 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  height: auto;
  padding: 2px;
  border-style: solid;
  border-color: transparent;
  border-width: var(--strip-rail-y) var(--strip-rail-x);
  border-image: url("../art/console-strip.png") 72 52 fill / var(--strip-rail-y) var(--strip-rail-x) round;
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
  min-height: 40px;
  padding: 0 10px;
  border: 1px solid rgba(240, 165, 70, 0.55);
  border-radius: 4px;
  background: rgba(6, 9, 16, 0.9);
  color: #f3c27a;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}

.console-more:hover {
  border-color: rgba(243, 198, 78, 0.85);
}

.console-more:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.console.narrow .console-centre {
  position: relative;
  left: auto;
  right: auto;
  height: auto;
  padding: 0;
  border: 0;
  border-image: none;
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
  left: 0;
  right: 0;
  bottom: calc(100% + var(--strip-rail-y) + 2px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: calc(var(--stage-height, 100vh) - var(--below-toolbar, 46px) - var(--console-room, 0px) - 4px);
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* Over the map the wings keep their whole height, the sheet scrolls, and the sky does not show through. */
.console.narrow .console-wing {
  position: static;
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 4px;
  width: auto;
  height: auto;
}

.console.narrow .console-wing::before,
.console.narrow .console-divider {
  display: none;
}

.console.narrow .console-wing > :deep(.console-block) {
  position: static;
  width: auto;
  height: auto;
  padding: 4px 6px;
  border: 1px solid rgba(240, 165, 70, 0.55);
  border-radius: 6px;
  background-color: rgba(6, 9, 16, 0.98);
}

.console.narrow .console-wing > :deep(.console-reflection) {
  height: 150px;
  padding: 0;
  --window-radius: 6px;
}
</style>
