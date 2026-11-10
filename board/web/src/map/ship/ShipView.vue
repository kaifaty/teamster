<script setup lang="ts">
// A ship's own screen, its bridge. Clicking a ship on the map opens it over the galaxy, as the science station's
// screen: a header with the line «what next», then the decks — the ship with its papers; its route, gauges and hull;
// the orders and the ship's documents. A session is a flagship: its papers and activity only.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import TaskCommands from "../../components/TaskCommands.vue";
import { claudeLink, prLabel, taskTitle } from "../../lib/labels";
import type { BoardSource } from "../../lib/source";
import type { TaskDetail, TaskFile, TaskSummary } from "../../types";
import nebula from "../art/nebula.jpg";
import { bridgeView, nextLine, stateOf } from "./bridge";
import "./ship.css";
import ShipDamage from "./ShipDamage.vue";
import ShipDocs from "./ShipDocs.vue";
import ShipDocViewer from "./ShipDocViewer.vue";
import ShipGauges from "./ShipGauges.vue";
import ShipHull from "./ShipHull.vue";
import ShipRoute from "./ShipRoute.vue";

const props = defineProps<{
  slug: string;
  /** The live summary from the board; null once the task is gone. */
  task: TaskSummary | null;
  source: BoardSource;
  now: number;
  frame: string;
  /** The system's emblem; null draws the repository's first letter. */
  emblem: string | null;
}>();
/** `show`: «Показать на карте», the screen gives way to the ship's system with the ship picked. */
const emit = defineEmits<{ close: []; show: [repo: string] }>();

const detail = ref<TaskDetail | null>(null);
const detailError = ref<string | null>(null);
const loading = ref(true);

let detailRequest = 0;
async function loadDetail() {
  const request = ++detailRequest;
  try {
    const result = await props.source.fetchDetail(props.slug);
    if (request !== detailRequest) return;
    detailError.value = null;
    if (result) detail.value = result;
  } catch (error) {
    if (request !== detailRequest) return;
    detailError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (request === detailRequest) loading.value = false;
  }
}

watch(
  () => props.slug,
  () => {
    detail.value = null;
    loading.value = true;
    doc.value = null;
    void loadDetail();
  },
);
// Refresh the detail when the task changes on the board.
watch(
  () => props.task?.updated_at,
  (next, previous) => {
    if (next !== undefined && previous !== undefined && next !== previous) void loadDetail();
  },
);

/** The detail of another task never shows here. */
const own = computed(() => (detail.value?.slug === props.slug ? detail.value : null));
const shown = computed<TaskSummary | null>(() => props.task ?? own.value);
const limits = computed(() => own.value?.limits);
const cargo = computed(() => own.value?.cargo ?? null);
const files = computed(() => own.value?.files ?? []);
const view = computed(() => bridgeView(shown.value ?? { kind: "work" }));
const heading = computed(() => (shown.value ? taskTitle(shown.value) : props.slug));
const state = computed(() => (shown.value ? stateOf(shown.value) : null));
const next = computed(() => (shown.value ? nextLine(shown.value, props.now) : null));
const link = computed(() => (shown.value ? claudeLink(shown.value) : null));
const letter = computed(() => (shown.value?.repo.replace(/[^\p{L}\p{N}]/gu, "").charAt(0) || "·").toUpperCase());

// The documents' viewer.
const doc = ref<TaskFile | null>(null);
let docOpener: HTMLElement | null = null;
function openDoc(name: TaskFile, opener: HTMLElement) {
  docOpener = opener;
  doc.value = name;
}
function closeDoc() {
  doc.value = null;
  void nextTick(() => docOpener?.focus());
}

const back = ref<HTMLButtonElement | null>(null);
function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing) return;
  event.preventDefault();
  if (doc.value) return closeDoc();
  // Escape in a field leaves the field; the next one leaves the bridge.
  const field = event.target instanceof HTMLElement && event.target.closest("input, textarea, select");
  if (field) {
    (field as HTMLElement).blur();
    return;
  }
  emit("close");
}
onMounted(() => {
  void loadDetail();
  back.value?.focus();
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <section class="ship-screen" role="dialog" aria-modal="false" aria-labelledby="ship-title" :style="{ '--frame': `url(${frame})`, '--sky': `url(${nebula})` }">
    <div class="bridge">
      <header class="head">
        <button ref="back" type="button" class="key back" title="Вернуться к карте (Esc)" @click="emit('close')">← К карте</button>
        <div class="who">
          <img v-if="emblem" class="emblem" :src="emblem" alt="" />
          <span v-else class="emblem letter" aria-hidden="true">{{ letter }}</span>
          <div class="names">
            <h2 id="ship-title">{{ heading }}</h2>
            <div class="sub">
              <span v-if="shown && shown.kind !== 'session'" class="mono">{{ shown.slug }}</span>
              <template v-if="shown">
                <span> · система {{ shown.repo }}</span>
                <template v-if="shown.branch"> · ветка <span class="mono">{{ shown.branch }}</span></template>
              </template>
            </div>
          </div>
        </div>
        <span v-if="state" class="pill" :class="state.tone">{{ state.text }}</span>
        <nav class="links" aria-label="Переходы">
          <a v-if="shown?.pr" class="key" :href="shown.pr" target="_blank" rel="noopener">{{ prLabel(shown.pr) }} ↗</a>
          <a v-if="link" class="key" :href="link">Открыть в Claude</a>
          <button v-if="shown" type="button" class="key" title="Закрыть экран и показать корабль в его системе" @click="emit('show', shown.repo)">Показать на карте</button>
        </nav>
      </header>

      <section v-if="next" class="next" :class="next.tone" aria-live="polite">
        <span class="lamp" aria-hidden="true"></span>
        <p>{{ next.text }}</p>
      </section>
      <p v-if="!task" class="note">{{ shown?.kind === "session" ? "Сессии" : "Задачи" }} больше нет на доске; показаны последние данные.</p>
      <p v-if="detailError" class="note bad">Не удалось загрузить задачу: {{ detailError }}</p>
      <p v-else-if="!shown && !loading" class="note">Задача не найдена.</p>

      <main v-if="shown" class="grid" :class="{ session: !view.route }">
        <div class="col left">
          <ShipHull :task="shown" :limits="limits" :cargo="cargo" :now="now" />
        </div>
        <div v-if="view.route" class="col center">
          <ShipRoute :task="shown" :limits="limits" :cargo="cargo" :now="now" />
          <ShipGauges v-if="view.gauges" :task="shown" :limits="limits" :cargo="cargo" :now="now" />
          <ShipDamage v-if="view.hull" :cargo="cargo" :now="now" :loading="loading" />
        </div>
        <div v-if="view.commands || view.docs" class="col right">
          <section v-if="view.commands" class="deck orders" aria-labelledby="orders-deck">
            <div class="deck-head">
              <span class="sigil" aria-hidden="true">⌘</span>
              <h3 id="orders-deck">Команды</h3>
            </div>
            <TaskCommands :task="shown" :now="now" :cargo="cargo" />
          </section>
          <ShipDocs v-if="view.docs" :files="files" :loading="loading" @open="openDoc" />
        </div>
      </main>
    </div>
    <ShipDocViewer v-if="doc && shown" :source="source" :slug="slug" :name="doc" :version="shown.updated_at" @close="closeDoc" />
  </section>
</template>

<style scoped>
.ship-screen {
  position: absolute;
  inset: 0;
  z-index: 14;
  overflow: hidden;
  background:
    radial-gradient(ellipse at 50% 30%, rgba(5, 7, 13, 0.4), rgba(5, 7, 13, 0.88) 75%),
    var(--sky) center top / cover no-repeat,
    #05070d;
  animation: open 0.32s ease-out;
}

@keyframes open {
  from {
    opacity: 0;
    transform: scale(0.985);
  }
}

.bridge {
  display: grid;
  align-content: start;
  gap: 10px;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 12px max(12px, env(safe-area-inset-right, 0px)) 32px max(12px, env(safe-area-inset-left, 0px));
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

.bridge > * {
  width: 100%;
  max-width: 1480px;
  margin: 0 auto;
}

/* Header: back, emblem, name, state, links. */
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
}

.back {
  flex: none;
  color: var(--sh-title);
}

.who {
  display: flex;
  flex: 1 1 320px;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.emblem {
  flex: none;
  width: 34px;
  height: 34px;
  border: 1px solid var(--sh-line);
  border-radius: 50%;
  object-fit: cover;
}

.emblem.letter {
  display: grid;
  place-items: center;
  background: #1b2a3a;
  color: var(--sh-teal);
  font-weight: 700;
}

.names {
  min-width: 0;
}

h2 {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--sh-text);
  font-size: 19px;
  font-weight: 600;
  line-height: 24px;
}

.sub {
  overflow-wrap: anywhere;
  color: var(--sh-dim);
  font-size: 12px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.pill::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.pill.work {
  color: var(--sh-teal);
}

.pill.wait {
  color: var(--sh-wait);
}

.pill.ready {
  color: var(--sh-green);
}

.pill.sleep {
  color: var(--sh-ice);
}

.pill.bad {
  color: var(--sh-red);
}

.pill.dim {
  color: var(--sh-dim);
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* What next: one sentence in the tone of the order the state calls for. */
.next {
  display: flex;
  align-items: center;
  gap: 10px 14px;
  padding: 10px 14px;
  border: 1px solid var(--sh-line);
  border-radius: 10px;
  background: rgba(7, 9, 14, 0.92);
}

.next p {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
}

.lamp {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--sh-teal);
  box-shadow: 0 0 10px var(--sh-teal);
}

.next.ok .lamp {
  background: var(--sh-green);
  box-shadow: 0 0 10px var(--sh-green);
}

.next.warn .lamp {
  background: var(--sh-wait);
  box-shadow: 0 0 10px var(--sh-wait);
  animation: pulse 1.6s ease-in-out infinite;
}

.next.bad .lamp {
  background: var(--sh-red);
  box-shadow: 0 0 10px var(--sh-red);
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.note {
  margin: 0;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(7, 9, 14, 0.85);
  color: var(--sh-dim);
}

.note.bad {
  color: var(--sh-red);
}

/* Columns: the ship; its route, gauges and hull; the orders and documents. */
.grid {
  display: grid;
  grid-template-columns: minmax(250px, 290px) minmax(0, 1fr) minmax(300px, 390px);
  align-items: start;
  gap: 10px;
}

.grid.session {
  grid-template-columns: minmax(0, 420px);
  justify-content: center;
}

.col {
  display: grid;
  gap: 10px;
  min-width: 0;
}

/* The orders keep the board's own block: the deck gives it the station's dark colours. */
.orders {
  --surface: rgba(10, 12, 16, 0.85);
  --surface-2: rgba(214, 170, 96, 0.1);
  --surface-3: rgba(4, 6, 9, 0.9);
  --border: rgba(214, 170, 96, 0.3);
  --border-strong: rgba(243, 198, 78, 0.7);
  --text: #e8e2d4;
  --muted: #9b907c;
  --faint: #7d7566;
  --link: #8fd8ff;
  --focus: #f3c64e;
  --ok: #6fcf8f;
  --ok-soft: rgba(111, 207, 143, 0.12);
  --warn: #f3c64e;
  --warn-soft: rgba(243, 198, 78, 0.12);
  --bad: #ff8d7a;
  --bad-soft: rgba(255, 141, 122, 0.12);
}

.orders :deep(.commands) {
  margin: 0;
}

.orders :deep(.commands > h3) {
  display: none;
}

@media (max-width: 1180px) {
  .grid {
    grid-template-columns: minmax(240px, 280px) minmax(0, 1fr);
  }

  .grid > .right {
    grid-column: 1 / -1;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    align-items: start;
  }
}

@media (max-width: 760px) {
  .grid,
  .grid > .right {
    grid-template-columns: minmax(0, 1fr);
  }

  .next {
    padding: 8px 10px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ship-screen,
  .next .lamp {
    animation: none;
  }
}
</style>
