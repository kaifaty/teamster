<script setup lang="ts">
// A ship's own screen, its bridge. Clicking a ship on the map opens it over the galaxy, as the science station's
// screen: a header with the line «what next», then the decks — the ship with its papers; its route, gauges and hull;
// the comms room and the order desk; under them the flight recorder, the telemetry and the ship's documents. A session
// is a flagship: its papers and telemetry only.
// The orders run at once through the board server; a board that only reads copies the equal command.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { postAction } from "../../lib/actions";
import { claudeLink, prLabel, taskTitle } from "../../lib/labels";
import type { BoardSource } from "../../lib/source";
import type { TaskDetail, TaskFile, TaskSummary } from "../../types";
import nebula from "../art/nebula.jpg";
import { bridgeView, nextLine, stateOf } from "./bridge";
import { createShipDesk } from "./desk";
import { mainOrder } from "./orders";
import "./ship.css";
import ShipComms from "./ShipComms.vue";
import ShipDamage from "./ShipDamage.vue";
import ShipDocs from "./ShipDocs.vue";
import ShipDocViewer from "./ShipDocViewer.vue";
import ShipGauges from "./ShipGauges.vue";
import ShipHull from "./ShipHull.vue";
import ShipOrders from "./ShipOrders.vue";
import ShipRecorder from "./ShipRecorder.vue";
import ShipRoute from "./ShipRoute.vue";
import ShipTelemetry from "./ShipTelemetry.vue";

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

// The comms room and the order desk; after an order the task loads again at once.
const desk = createShipDesk({
  slug: toRef(props, "slug"),
  task: shown,
  detail: own,
  act: (route, body) => postAction(route, body, { send: props.source.act, refresh: loadDetail }),
});
const main = computed(() => (shown.value ? mainOrder(shown.value, props.now) : null));
function runMain() {
  const order = main.value;
  if (order?.kind === "fill") void desk.fill(order.text);
  else if (order?.kind === "verdict") void desk.verdict("accepted");
}

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
              <template v-if="shown">
                <template v-if="shown.kind !== 'session'"><span class="mono">{{ shown.slug }}</span> · </template>
                <span>система {{ shown.repo }}</span>
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
        <button v-if="main" type="button" class="key main" :disabled="main.kind === 'verdict' && !!desk.groups.accept.busy" @click="runMain">{{ main.label }}</button>
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
        <div v-if="view.commands" class="col right">
          <ShipComms :task="shown" :desk="desk" :messages="own?.messages ?? []" :cargo="cargo" :now="now" />
          <ShipOrders :task="shown" :desk="desk" :limits="limits" :cargo="cargo" />
        </div>
      </main>
      <section v-if="shown" class="bottom" :class="{ session: !view.route }" aria-label="Самописец, телеметрия и документы">
        <ShipRecorder v-if="view.route" class="rec" :task="shown" :source="source" :messages="own?.messages ?? []" :limits="limits" :now="now" />
        <ShipTelemetry :task="shown" :log="own?.activity_log ?? []" :loaded="!!own" :now="now" />
        <ShipDocs v-if="view.docs" :files="files" :loading="loading" @open="openDoc" />
      </section>
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
  flex: 1 1 auto;
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

/* Under the columns: the recorder wide, the telemetry and the documents beside it. */
.bottom {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(220px, 0.7fr);
  align-items: start;
  gap: 10px;
}

.bottom.session {
  grid-template-columns: minmax(0, 420px);
  justify-content: center;
}

@media (max-width: 1180px) {
  .grid {
    grid-template-columns: minmax(240px, 280px) minmax(0, 1fr);
  }

  .bottom:not(.session) {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .bottom > .rec {
    grid-column: 1 / -1;
  }

  .grid > .right {
    grid-column: 1 / -1;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    align-items: start;
  }
}

@media (max-width: 760px) {
  .grid,
  .grid > .right,
  .bottom:not(.session) {
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
