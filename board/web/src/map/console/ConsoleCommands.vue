<script setup lang="ts">
// The control panel's command row under the events: «Ждут тебя · N» and «Тревоги · N», each of which opens the next
// task of its queue, «Сводка дня» and the menu «≡» with the panel's settings, in cast bronze buttons on a second, lower
// copy of the centre's strip. `counters` is only the two counters, for the folded strip; `sheet` is the summary and the
// settings as plain buttons, for the narrow window's sheet.
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { taskCount, type QueueColumn } from "./queue";

const props = defineProps<{
  mode: "row" | "counters" | "sheet";
  /** The tasks that wait for your decision, and those with an alarm. */
  ready: number;
  alarms: number;
  /** The counters show only their badges: the narrow window's strip. */
  compact?: boolean;
  /** The menu offers «Свернуть панель»: a wide window. */
  foldable?: boolean;
  /** `dev:fixture`: the map's source can be switched. */
  demo?: boolean;
}>();
const emit = defineEmits<{ next: [column: QueueColumn]; fold: [] }>();
const summaryOpen = defineModel<boolean>("summaryOpen", { default: false });
const sound = defineModel<boolean>("sound", { default: false });
const sourceKind = defineModel<"board" | "scenario">("sourceKind", { default: "board" });

const counters = computed(() => [
  { column: "review_me" as const, word: "Ждут тебя", count: props.ready, badge: "b-ready", title: "Открыть следующую задачу, которая ждёт твоего решения" },
  { column: "attention" as const, word: "Тревоги", count: props.alarms, badge: "b-alarm", title: "Открыть следующую задачу с тревогой" },
]);

/** The day's summary gives the focus back to this button when it closes. */
const summaryButton = ref<HTMLButtonElement | null>(null);
defineExpose({ summaryButton });

// The menu: it drops up over its button, arrows walk its items, Escape and a press elsewhere close it.
const menuOpen = ref(false);
const menuButton = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const wrap = ref<HTMLElement | null>(null);
const items = () => [...(menu.value?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [])];

function openMenu(at: "first" | "last" = "first") {
  menuOpen.value = true;
  void nextTick(() => {
    const list = items();
    (at === "first" ? list[0] : list[list.length - 1])?.focus();
  });
}

function closeMenu(focus = true) {
  menuOpen.value = false;
  if (focus) void nextTick(() => menuButton.value?.focus());
}

function onButtonKey(event: KeyboardEvent) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  openMenu(event.key === "ArrowDown" ? "first" : "last");
}

function onMenuKey(event: KeyboardEvent) {
  const list = items();
  const at = list.indexOf(document.activeElement as HTMLElement);
  const go = (index: number) => list[(index + list.length) % list.length]?.focus();
  if (event.key === "ArrowDown") go(at + 1);
  else if (event.key === "ArrowUp") go(at - 1);
  else if (event.key === "Home") go(0);
  else if (event.key === "End") go(list.length - 1);
  else if (event.key === "Escape") closeMenu();
  else if (event.key === "Tab") {
    closeMenu(false);
    return;
  } else return;
  event.preventDefault();
  event.stopPropagation();
}

/** A press outside the menu and its button closes it; the focus comes back to the button unless it went somewhere. */
function onPressAway(event: PointerEvent) {
  if (wrap.value?.contains(event.target as Node)) return;
  menuOpen.value = false;
  void nextTick(() => {
    if (!document.activeElement || document.activeElement === document.body) menuButton.value?.focus({ preventScroll: true });
  });
}
watch(menuOpen, (open) => {
  if (open) document.addEventListener("pointerdown", onPressAway, true);
  else document.removeEventListener("pointerdown", onPressAway, true);
});
onBeforeUnmount(() => document.removeEventListener("pointerdown", onPressAway, true));

function fold() {
  menuOpen.value = false;
  emit("fold");
}

function pickSource(kind: "board" | "scenario") {
  sourceKind.value = kind;
  closeMenu();
}
</script>

<template>
  <div class="commands" :class="[mode, { compact }]">
    <template v-if="mode !== 'sheet'">
      <button
        v-for="item in counters"
        :key="item.column"
        type="button"
        class="cast counter"
        :disabled="!item.count"
        :title="item.title"
        :aria-label="`${item.word}: ${taskCount(item.count)}`"
        @click="emit('next', item.column)"
      >
        <span v-if="!compact" class="word">{{ item.word }}</span>
        <span class="count num" :class="item.badge">{{ item.count }}</span>
      </button>
    </template>
    <template v-if="mode !== 'counters'">
      <span v-if="mode === 'row'" class="gap" aria-hidden="true"></span>
      <button ref="summaryButton" type="button" class="cast" :aria-expanded="summaryOpen" @click="summaryOpen = true">
        <svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M2 6.5h12M5 1.5v3M11 1.5v3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          <path d="M5 9h1.5M7.8 9h1.5M10.6 9h.6M5 11.5h1.5M7.8 11.5h1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        Сводка дня
      </button>
    </template>
    <div v-if="mode === 'row'" ref="wrap" class="menu-wrap">
      <button
        ref="menuButton"
        type="button"
        class="cast menu-button"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        aria-controls="console-menu"
        aria-label="Настройки панели"
        title="Настройки панели"
        @click="menuOpen ? closeMenu() : openMenu()"
        @keydown="onButtonKey"
      >
        <svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M2.5 4h11M2.5 8h11M2.5 12h11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      <div v-if="menuOpen" id="console-menu" ref="menu" class="menu" role="menu" aria-label="Настройки панели" @keydown="onMenuKey">
        <button v-if="foldable" type="button" role="menuitem" class="item" tabindex="-1" @click="fold">Свернуть панель</button>
        <button type="button" role="menuitemcheckbox" class="item" :aria-checked="sound" tabindex="-1" @click="sound = !sound">
          <span class="mark" aria-hidden="true">{{ sound ? "✓" : "" }}</span>Звук уведомлений
        </button>
        <div v-if="demo" role="group" aria-label="Источник карты">
          <button v-for="kind in (['board', 'scenario'] as const)" :key="kind" type="button" role="menuitemradio" class="item" :aria-checked="sourceKind === kind" tabindex="-1" @click="pickSource(kind)">
            <span class="mark" aria-hidden="true">{{ sourceKind === kind ? "●" : "" }}</span>Источник: {{ kind === "board" ? "доска" : "сценарий" }}
          </button>
        </div>
      </div>
    </div>
    <template v-if="mode === 'sheet'">
      <button type="button" class="cast" :aria-pressed="sound" @click="sound = !sound">
        <span class="mark" aria-hidden="true">{{ sound ? "✓" : "" }}</span>Звук уведомлений
      </button>
      <div v-if="demo" class="sources" role="group" aria-label="Источник карты">
        <button v-for="kind in (['board', 'scenario'] as const)" :key="kind" type="button" class="cast" :aria-pressed="sourceKind === kind" @click="sourceKind = kind">
          {{ kind === "board" ? "Доска" : "Сценарий" }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/*
 * The row stands on a lower copy of the centre's strip (console-strip.png, 2126×280: rails 72 high), one art pixel being
 * --row-u on the screen, set by the panel. Only the plain pipe of the rails at x 430–530 stretches; the end caps, the
 * lamps and the rivets keep their shape. The buttons stand in the strip's dark middle.
 */
.commands {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: #f6dfb0;
  font-size: 13px;
}

.commands.row {
  position: relative;
  isolation: isolate;
  box-sizing: border-box;
  height: 100%;
  padding: 0 calc(var(--row-u, 0.25px) * 64 + 6px);
}

.commands.row::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  box-sizing: border-box;
  border-style: solid;
  border-color: transparent;
  border-width: calc(var(--row-u, 0.25px) * 72) calc(var(--row-u, 0.25px) * 1596) calc(var(--row-u, 0.25px) * 72) calc(var(--row-u, 0.25px) * 430);
  border-image: url("../art/console-strip.png") 72 1596 72 430 fill / calc(var(--row-u, 0.25px) * 72) calc(var(--row-u, 0.25px) * 1596) calc(var(--row-u, 0.25px) * 72) calc(var(--row-u, 0.25px) * 430) stretch;
  pointer-events: none;
}

.gap {
  flex: 1;
}

/* A cast bronze button: a warm gradient with a light upper bevel and a dark foot, cream letters. */
.cast {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 7px;
  box-sizing: border-box;
  height: var(--cast-height, 30px);
  min-width: var(--cast-height, 30px);
  margin: 0;
  padding: 0 11px;
  border: 1px solid #1f1205;
  border-radius: 5px;
  background: linear-gradient(to bottom, #9a6a2c 0%, #6b4316 9%, #45290c 52%, #2f1b07 90%, #7a501c 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 220, 160, 0.5),
    inset 0 0 0 1px rgba(214, 150, 70, 0.55),
    inset 0 -2px 2px rgba(0, 0, 0, 0.45),
    0 1px 3px rgba(0, 0, 0, 0.75);
  color: #f6dfb0;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  line-height: 1;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.85);
  white-space: nowrap;
  cursor: pointer;
  transition: filter 0.12s;
}

.cast:hover:not(:disabled) {
  filter: brightness(1.18);
  color: #ffe9bd;
}

.cast:active:not(:disabled),
.cast[aria-expanded="true"],
.cast[aria-pressed="true"] {
  background: linear-gradient(to bottom, #2a1806 0%, #3c230a 40%, #573512 92%, #7a501c 100%);
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.7),
    inset 0 0 0 1px rgba(214, 150, 70, 0.45);
}

.cast:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 2px;
}

.cast:disabled {
  color: #9b8a6c;
  filter: saturate(0.35) brightness(0.75);
  cursor: default;
}

.icon {
  flex: none;
  color: #f3c27a;
}

/* The count in a round badge, in the colours of the toolbar's legend. */
.count {
  box-sizing: border-box;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 10px;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.6),
    0 0 5px rgba(0, 0, 0, 0.5);
  font-size: 12px;
  font-weight: 750;
  line-height: 20px;
  text-align: center;
  text-shadow: none;
}

.b-ready {
  background: #f3c64e;
  color: #1a1408;
}

.b-alarm {
  background: #e0533c;
  color: #fff4ef;
}

.commands.compact .counter {
  padding: 0 8px;
}

.menu-wrap {
  position: relative;
  flex: none;
}

.menu-button {
  padding: 0;
}

/* The menu drops up over its button, clear of the map's toolbar. */
.menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 3;
  display: flex;
  flex-direction: column;
  min-width: 220px;
  padding: 4px;
  border: 1px solid rgba(240, 165, 70, 0.65);
  border-radius: 6px;
  background: rgba(10, 8, 5, 0.97);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.7);
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  width: 100%;
  min-height: 32px;
  padding: 0 10px 0 6px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: #f0dfbd;
  font: inherit;
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.item:hover,
.item:focus-visible {
  background: rgba(214, 170, 96, 0.2);
  outline: none;
}

.item:focus-visible {
  box-shadow: inset 0 0 0 2px #f3c64e;
}

.mark {
  display: inline-block;
  flex: none;
  width: 14px;
  color: #f3c64e;
  text-align: center;
}

.commands.sheet {
  flex-wrap: wrap;
}

.sources {
  display: flex;
  gap: 4px;
}

/* A finger needs taller items: on a narrow window and on a touch screen; the panel sets the buttons' --cast-height. */
@media (max-width: 760px), (pointer: coarse) {
  .item {
    min-height: 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cast {
    transition: none;
  }
}
</style>
