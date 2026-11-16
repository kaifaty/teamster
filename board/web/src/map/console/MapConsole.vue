<script setup lang="ts">
// The control panel at the map's bottom, across its whole width, in a cast frame: on the left wing the duty and the
// subscriptions, in the lower centre the events over the command row, on the right wing the machines and the reflection.
// The command row starts with the duty chat's field, and the conversation opens over the events. The galaxy and a system are laid out above it. On a narrow window it folds to a strip, the duty, the counters and the
// newest event, and the wings open over the map on demand; on a wide one the viewer may fold it to the same strip.
import { computed, nextTick, ref, watch } from "vue";
import { loadJson, saveJson } from "../../lib/storage";
import type { DutyChatHost } from "../../store/dutyChat";
import type { Machines, LogEvent, TaskSummary } from "../../types";
import type { Star, Tank } from "../fleet";
import type { Research } from "../research";
import ShipLog from "../ShipLog.vue";
import ConsoleChat from "./ConsoleChat.vue";
import ConsoleChatField from "./ConsoleChatField.vue";
import ConsoleCommands from "./ConsoleCommands.vue";
import ConsoleDuty from "./ConsoleDuty.vue";
import ConsoleMachines from "./ConsoleMachines.vue";
import ConsoleReflection from "./ConsoleReflection.vue";
import ConsoleSubscriptions from "./ConsoleSubscriptions.vue";
import { PORTRAIT_URLS } from "./portraits";
import { nextInQueue, queueOf, type QueueColumn } from "./queue";
import { dutyBlock, machineRow, portraitNames, reflectionNote, subscriptionRow } from "./texts";
import { useConsoleChat } from "./useConsoleChat";

/** Whether the viewer folded the wide window's panel to a strip. */
const FOLDED_KEY = "codex-board.console-folded.v1";
/** Whether the duty chat's conversation stands open over the events. */
const CHAT_OPEN_KEY = "codex-board.console-chat.v1";

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
  /** The tasks the systems' badges count, for the command row's counters. */
  tasks: readonly TaskSummary[];
  /** `dev:fixture`: the map's source can be switched from the menu. */
  demo: boolean;
  /** The map's source, whose duty chat the command row's field writes to. */
  chatHost: DutyChatHost;
}>();
const emit = defineEmits<{
  go: [event: LogEvent];
  /** A counter was pressed: the next task of its queue. */
  task: [repo: string, slug: string];
  openAccount: [key: string, opener: HTMLElement];
  machine: [id: string, opener: HTMLElement];
  openResearch: [];
}>();
/** The whole log, open over the map from the narrow strip. */
const logOpen = defineModel<boolean>("logOpen", { required: true });
const summaryOpen = defineModel<boolean>("summaryOpen", { required: true });
const sound = defineModel<boolean>("sound", { required: true });
const sourceKind = defineModel<"board" | "scenario">("sourceKind", { required: true });

const duty = computed(() => dutyBlock(props.tanks, props.stars, props.now));
const subscriptions = computed(() => props.tanks.map((tank) => subscriptionRow(tank, props.now)));
const machineRows = computed(() => (props.machines?.items ?? []).map((machine) => machineRow(machine, props.now)));
const reflection = computed(() => reflectionNote(props.station));
/** Each subscription's portrait, by its key, and the duty's. */
const portraits = computed(() => new Map([...portraitNames(props.tanks)].flatMap(([key, name]) => (PORTRAIT_URLS[name] ? [[key, PORTRAIT_URLS[name]] as const] : []))));
const dutyPortrait = computed(() => (duty.value.key ? (portraits.value.get(duty.value.key) ?? null) : null));

// The command row's queues: a counter opens the task after the one it opened last, round the queue.
const queues = computed(() => ({ review_me: queueOf(props.tasks, "review_me"), attention: queueOf(props.tasks, "attention") }));
const opened: Record<QueueColumn, string | null> = { review_me: null, attention: null };
function next(column: QueueColumn) {
  const task = nextInQueue(queues.value[column], opened[column]);
  if (!task) return;
  opened[column] = task.slug;
  emit("task", task.repo, task.slug);
}

/** A wide window's panel folded by the viewer to the narrow window's strip; the choice outlives the page. */
const folded = ref(loadJson(FOLDED_KEY, false, (value): value is boolean => typeof value === "boolean"));
watch(folded, (value) => saveJson(FOLDED_KEY, value));
const foldedWide = computed(() => folded.value && !props.narrow);
/** The panel stands as a strip: a narrow window, or folded. */
const strip = computed(() => props.narrow || foldedWide.value);
const root = ref<HTMLElement | null>(null);
/** Folding moves the focus to «Развернуть панель», unfolding to the menu's button. */
function fold(value: boolean) {
  folded.value = value;
  void nextTick(() => root.value?.querySelector<HTMLElement>(value ? ".console-unfold" : ".console-row .menu-button")?.focus());
}

/** On a narrow window: the wings stand open over the map. */
const sheetOpen = ref(false);
const moreButton = ref<HTMLButtonElement | null>(null);
watch(strip, () => {
  sheetOpen.value = false;
  logOpen.value = false;
});

// «Сводка дня» gives the focus back to the button that shows: the row's, or the narrow window's sheet's.
const rowCommands = ref<InstanceType<typeof ConsoleCommands> | null>(null);
const sheetCommands = ref<InstanceType<typeof ConsoleCommands> | null>(null);
const summaryButton = computed(() => (props.narrow ? sheetCommands.value?.summaryButton : rowCommands.value?.summaryButton) ?? null);
defineExpose({ summaryButton });
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
    keptHeight.value = open && strip.value ? (centre.value?.offsetHeight ?? null) : null;
    if (open) sheetOpen.value = false;
  },
  { flush: "pre" },
);
watch(sheetOpen, (open) => {
  if (open) logOpen.value = false;
});

// The duty chat: its field heads the command row, or the narrow window's sheet; the conversation opens over the events,
// which the whole log and the conversation share.
const chatOpen = ref(loadJson(CHAT_OPEN_KEY, false, (value): value is boolean => typeof value === "boolean"));
watch(chatOpen, (value) => saveJson(CHAT_OPEN_KEY, value));
const chat = useConsoleChat(() => props.chatHost, () => props.now, () => props.tasks, () => (props.narrow ? sheetOpen.value : chatOpen.value && !strip.value));
const { draft, unavailable: chatOff } = chat;
const chatShown = computed(() => chatOpen.value && !strip.value && !chatOff.value);
const chatPanel = computed(() => ({
  rows: chat.rows.value, now: props.now, account: chat.view.value?.duty?.account ?? null, portrait: dutyPortrait.value, busy: chat.busy.value,
  runSeconds: chat.runSeconds.value, activity: chat.activity.value, lastError: chat.lastError.value, readError: chat.readError.value,
}));
/** How much the row's field grew above one line: the conversation stands above it. */
const fieldGrow = ref(0);
const rowField = ref<InstanceType<typeof ConsoleChatField> | null>(null);
watch(chatOpen, (open) => {
  if (open && !strip.value) logOpen.value = false;
});
watch(logOpen, (open) => {
  if (open && !strip.value) chatOpen.value = false;
});
/** A sent message shows at once: the conversation opens with it. */
function sendChat() {
  chat.sendDraft();
  if (!strip.value) chatOpen.value = true;
}
function closeChat() {
  chatOpen.value = false;
  void nextTick(() => rowField.value?.focusQuietly());
}

/** Escape folds what the strip opened before the map hears it. */
function onKey(event: KeyboardEvent) {
  if (event.key === "Escape" && chatShown.value) {
    event.stopPropagation();
    closeChat();
    return;
  }
  if (event.key !== "Escape" || !props.narrow || !sheetOpen.value) return;
  event.stopPropagation();
  sheetOpen.value = false;
  void nextTick(() => moreButton.value?.focus());
}
</script>

<template>
  <section
    ref="root"
    class="console"
    :class="{ strip, narrow, folded: foldedWide, 'sheet-open': narrow && sheetOpen }"
    :style="{ '--frame': `url(${frame})` }"
    aria-label="Панель управления"
    @keydown="onKey"
  >
    <div v-if="strip" class="console-strip">
      <ConsoleDuty :duty="duty" :portrait="dutyPortrait" compact @open="(key, opener) => emit('openAccount', key, opener)" />
      <ConsoleCommands mode="counters" :ready="queues.review_me.length" :alarms="queues.attention.length" :compact="narrow" @next="next" />
      <button
        v-if="narrow"
        ref="moreButton"
        type="button"
        class="console-more"
        :aria-expanded="sheetOpen"
        aria-controls="console-sheet"
        :aria-label="sheetOpen ? 'Скрыть подписки, машины, рефлексию и настройки' : 'Показать подписки, машины, рефлексию и настройки'"
        @click="sheetOpen = !sheetOpen"
      >
        Ещё <span aria-hidden="true">{{ sheetOpen ? "▾" : "▴" }}</span>
      </button>
      <button v-else type="button" class="console-more console-unfold" @click="fold(false)">Развернуть панель</button>
    </div>
    <div v-show="!strip || sheetOpen" id="console-sheet" class="console-sheet">
      <div v-if="narrow" class="console-chat">
        <ConsoleChat v-if="!chatOff" v-bind="chatPanel" sheet @choose="chat.send" @task="(repo, slug) => emit('task', repo, slug)" @retry="chat.retry" @dismiss="chat.dismiss" />
        <ConsoleChatField v-model="draft" sheet open :unavailable="chatOff" :busy="chat.busy.value" @send="chat.sendDraft" />
      </div>
      <div class="console-wing console-left">
        <ConsoleDuty v-if="!narrow" :duty="duty" :portrait="dutyPortrait" @open="(key, opener) => emit('openAccount', key, opener)" />
        <i class="console-divider" aria-hidden="true"></i>
        <ConsoleSubscriptions :rows="subscriptions" :portraits="portraits" :open="account" @open="(key, opener) => emit('openAccount', key, opener)" />
      </div>
      <div class="console-wing console-right">
        <ConsoleMachines :rows="machineRows" :note="machines?.config_error || null" :open="machine" @open="(id, opener) => emit('machine', id, opener)" />
        <i class="console-divider" aria-hidden="true"></i>
        <ConsoleReflection :reflection="reflection" :research-open="researchOpen" @open="emit('openResearch')" />
      </div>
      <ConsoleCommands
        v-if="narrow"
        ref="sheetCommands"
        v-model:summary-open="summaryOpen"
        v-model:sound="sound"
        v-model:source-kind="sourceKind"
        class="console-settings"
        mode="sheet"
        :ready="queues.review_me.length"
        :alarms="queues.attention.length"
        :demo="demo"
      />
    </div>
    <div ref="centre" class="console-centre" :style="{ minHeight: keptHeight ? `${keptHeight}px` : undefined, '--chat-grow': `${fieldGrow}px` }">
      <ConsoleChat
        v-if="chatShown"
        v-bind="chatPanel"
        @close="closeChat"
        @choose="chat.send"
        @task="(repo, slug) => emit('task', repo, slug)"
        @retry="chat.retry"
        @dismiss="chat.dismiss"
      />
      <div class="console-events" :class="{ covered: chatShown }">
        <ShipLog
          v-model:open="logOpen"
          :events="logEvents"
          :error="eventsError"
          :repo="repo"
          :frame="frame"
          :systems="systemNames"
          :emblem-of="emblemOf"
          :compact="strip"
          @go="emit('go', $event)"
        />
      </div>
      <ConsoleCommands
        v-if="!strip"
        ref="rowCommands"
        v-model:summary-open="summaryOpen"
        v-model:sound="sound"
        v-model:source-kind="sourceKind"
        class="console-row"
        mode="row"
        :ready="queues.review_me.length"
        :alarms="queues.attention.length"
        :demo="demo"
        foldable
        @next="next"
        @fold="fold(true)"
      >
        <ConsoleChatField
          ref="rowField"
          v-model="draft"
          :unavailable="chatOff"
          :busy="chat.busy.value"
          :open="chatShown"
          @send="sendChat"
          @open="chatOpen = true"
          @close="closeChat"
          @toggle="chatShown ? closeChat() : (chatOpen = true)"
          @grow="fieldGrow = $event"
        />
      </ConsoleCommands>
    </div>
  </section>
</template>

<style scoped>
/*
 * The panel's box is as tall as the wings, and the galaxy is fitted above it. The box takes no pointer itself, so the sky
 * above the low centre still moves the map.
 *
 * The wings are about 26.5 % of the window's height, and at least 250 px while that stays within about 34 % of it (a
 * 720-pixel window gets 33.8 %); a 1080-pixel window keeps 26.5 %. Each wing is about 31 % of the window's width, no
 * wider than 620 px, and never narrower than its art at that height.
 *
 * The wing's art (console-wing.png, 875×560) holds one dark compartment: x 46–782, its top at y 103 under the high
 * shoulder (up to x 390) and at y 135 past the step, its bottom at y 510; the body's right edge is at x 820, a pipe stub
 * reaches x 873 at y 160–200. A wider wing stretches only the columns x 612–616, where the rails are plain: no lamp,
 * rivet or engraving there. Everything left of them keeps its place from the wing's left edge, everything right of them
 * from its right edge, so the blocks are placed in the art's pixels (--u, one of them on the screen) from those edges.
 * The right wing is the same art mirrored; its blocks are placed as the mirror of the left wing's.
 */
.console {
  --wing-height: min(max(26.5vh, min(250px, 33.8vh)), 19vw);
  --u: calc(var(--wing-height) / 560);
  --wing-width: max(calc(var(--u) * 875), min(31vw, 620px));
  /* The centre starts under the wing's body, which ends 55 art pixels before the wing's outer edge. */
  --centre-inset: calc(var(--wing-width) - var(--u) * 87);
  /*
   * The centre: 86 % of the wings, the events over the command row, each in a copy of the strip (console-strip.png,
   * 2126×280: rails 72 high, end caps 52 wide). The row's strip is as low as its buttons let it be, at its own scale
   * (--row-u, one art pixel on the screen), no larger than the centre's width allows: its fixed parts are 2026 pixels
   * wide. The events' strip takes the rest.
   */
  --centre-height: calc(var(--wing-height) * 0.86);
  --cast-height: 30px;
  --row-u: min(calc((var(--cast-height) + 6px) / 136), calc((100vw - 2 * var(--centre-inset) - 24px) / 2100));
  --row-height: calc(var(--row-u) * 144 + var(--cast-height) + 6px);
  --events-height: calc(var(--centre-height) - var(--row-height));
  --rail-y: calc(var(--events-height) * 72 / 280);
  --rail-x: calc(var(--events-height) * 52 / 280);
  /* The row's buttons start past the wings' boxes, which reach 87 art pixels into the centre's ends. */
  --row-inset: calc(var(--u) * 87 + 6px);
  /* The room the events' list has: what the rails, the padding and its heading leave. */
  --log-room: calc(var(--events-height) - 2 * var(--rail-y) - 4px - 18px);
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

/* The art: 612 columns on the left and 259 on the right at their own scale, the plain rail between them stretched. */
.console-wing::before {
  content: "";
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  border-style: solid;
  border-color: transparent;
  border-width: 0 calc(var(--u) * 259) 0 calc(var(--u) * 612);
  border-image: url("../art/console-wing.png") 0 259 0 612 fill / 0 calc(var(--u) * 259) 0 calc(var(--u) * 612) stretch;
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

/*
 * The duty's and the reflection's windows: under the high shoulder, x 56–392 and y 113–500 of the art, their outer
 * corners following the compartment's.
 */
.console-left > :deep(.console-duty),
.console-right > :deep(.console-reflection) {
  top: calc(var(--u) * 113);
  width: calc(var(--u) * 336);
  height: calc(var(--u) * 387);
}

.console-left > :deep(.console-duty) {
  left: calc(var(--u) * 56);
  --window-radius: calc(var(--u) * 84) 4px 4px calc(var(--u) * 55);
}

.console-right > :deep(.console-reflection) {
  right: calc(var(--u) * 56);
  --window-radius: 4px calc(var(--u) * 84) calc(var(--u) * 55) 4px;
}

/* The lists: past the step, from x 410 to 125 art pixels before the outer edge, y 141–500, clear of the right corners. */
.console-left > :deep(.console-subscriptions),
.console-right > :deep(.console-machines) {
  top: calc(var(--u) * 141);
  height: calc(var(--u) * 359);
}

.console-left > :deep(.console-subscriptions) {
  left: calc(var(--u) * 410);
  right: calc(var(--u) * 125);
}

.console-right > :deep(.console-machines) {
  left: calc(var(--u) * 125);
  right: calc(var(--u) * 410);
}

/* A thin amber divider between the blocks of a compartment, in the tone of the frame's inner kant. */
.console-divider {
  position: absolute;
  top: calc(var(--u) * 150);
  width: 1px;
  height: calc(var(--u) * 340);
  background: linear-gradient(to bottom, transparent, rgba(240, 165, 70, 0.7) 18%, rgba(240, 165, 70, 0.7) 82%, transparent);
  box-shadow: 0 0 4px rgba(240, 150, 50, 0.45);
}

.console-left > .console-divider {
  left: calc(var(--u) * 400);
}

.console-right > .console-divider {
  right: calc(var(--u) * 400);
}

/* A finger needs taller buttons: on a narrow window and on a touch screen. */
@media (max-width: 760px), (pointer: coarse) {
  .console {
    --cast-height: 38px;
  }
}

/* The lower centre, under the wings' ends: the events, and the command row under them. */
.console-centre {
  position: absolute;
  left: var(--centre-inset);
  right: var(--centre-inset);
  bottom: 0;
  z-index: 0;
  display: flex;
  flex-direction: column;
  height: var(--centre-height);
}

/*
 * The events' strip: its rails and end caps keep their shape, its middle stretches. The wing's body and its pipe stub
 * reach 87 art pixels into the centre's ends at the height of the heading: the text starts past them.
 */
.console-events {
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  padding: 2px max(4px, calc(var(--u) * 87 - var(--rail-x) + 6px));
  border-style: solid;
  border-color: transparent;
  border-width: var(--rail-y) var(--rail-x);
  border-image: url("../art/console-strip.png") 72 52 fill / var(--rail-y) var(--rail-x) round;
}

.console-centre > .console-row {
  flex: none;
  height: var(--row-height);
}

.console-events > :deep(.log) {
  height: 100%;
}

/* The open conversation stands over the events. */
.console-events.covered {
  visibility: hidden;
}

.console-events > :deep(.log:not(.open)) {
  padding: 0;
  border: 0;
  border-image: none;
  background: none;
}

/* Whole rows only: the list is as tall as the rows that fit, and the rail never cuts one. */
.console-events > :deep(.log:not(.open)) .l-rows {
  flex: none;
  height: max(var(--row), round(down, var(--log-room), var(--row)));
  min-height: 0;
}

/*
 * «развернуть»: the long list opens over the map from the centre, up to the toolbar, clear of the wings: it starts past
 * their bodies, which reach into the centre's ends.
 */
.console-events > :deep(.log.open) {
  position: absolute;
  left: calc(var(--u) * 30);
  right: calc(var(--u) * 30);
  bottom: 0;
  width: auto;
  height: min(62vh, calc(var(--stage-height, 100vh) - var(--below-toolbar, 46px) - 8px));
  padding: 4px 6px;
  border: 1px solid rgba(240, 165, 70, 0.6);
  border-image: none;
  border-radius: 6px;
  background: rgba(6, 9, 16, 0.97);
}
</style>
<style scoped src="./strip.css"></style>
