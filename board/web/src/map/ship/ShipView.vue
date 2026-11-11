<script setup lang="ts">
// A ship's own screen, its bridge. Clicking a ship on the map opens it over the galaxy, as the science station's
// screen: a header, then «Сейчас» across the screen — the state in words, the route strip, the agent's full report and
// what is needed from you — and under it two columns: «Что сделано» and the voyage log; the ship's card, the other
// orders and the documents. A session is a flagship: «Сейчас» and its card only.
// The orders run at once through the board server; a board that only reads copies the equal command.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { postAction } from "../../lib/actions";
import { claudeLink, prLabel, taskTitle } from "../../lib/labels";
import type { BoardSource } from "../../lib/source";
import type { TaskDetail, TaskFile, TaskSummary } from "../../types";
import nebula from "../art/nebula.jpg";
import { bridgeView, stateOf } from "./bridge";
import { createShipDesk } from "./desk";
import "./ship.css";
import ShipDocs from "./ShipDocs.vue";
import ShipDocViewer from "./ShipDocViewer.vue";
import ShipDone from "./ShipDone.vue";
import ShipHull from "./ShipHull.vue";
import ShipJournal from "./ShipJournal.vue";
import ShipNow from "./ShipNow.vue";
import ShipOrders from "./ShipOrders.vue";

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
const link = computed(() => (shown.value ? claudeLink(shown.value) : null));
const letter = computed(() => (shown.value?.repo.replace(/[^\p{L}\p{N}]/gu, "").charAt(0) || "·").toUpperCase());

// The comms room and the order desk; after an order the task loads again at once.
const desk = createShipDesk({
  slug: toRef(props, "slug"),
  task: shown,
  detail: own,
  act: (route, body) => postAction(route, body, { send: props.source.act, refresh: loadDetail }),
});

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
                <span>репозиторий {{ shown.repo }}</span>
                <template v-if="shown.branch"> · ветка <span class="mono">{{ shown.branch }}</span></template>
              </template>
            </div>
          </div>
        </div>
        <span v-if="state" class="pill" :class="state.tone">{{ state.text }}</span>
        <nav class="links" aria-label="Переходы">
          <a v-if="shown?.pr" class="key" :href="shown.pr" target="_blank" rel="noopener">{{ prLabel(shown.pr) }} ↗</a>
          <a v-if="link" class="key" :href="link">Открыть в Claude</a>
          <button v-if="shown" type="button" class="key" title="Закрыть экран и показать задачу на карте её репозитория" @click="emit('show', shown.repo)">Показать на карте</button>
        </nav>
      </header>

      <p v-if="!task" class="note">{{ shown?.kind === "session" ? "Сессии" : "Задачи" }} больше нет на доске; показаны последние данные.</p>
      <p v-if="detailError" class="note bad">Не удалось загрузить задачу: {{ detailError }}</p>
      <p v-else-if="!shown && !loading" class="note">Задача не найдена.</p>

      <template v-if="shown">
        <ShipNow :task="shown" :detail="own" :desk="desk" :now="now" />
        <main class="grid" :class="{ session: !view.commands }">
          <div v-if="view.commands" class="col main-col">
            <ShipDone :task="shown" :cargo="cargo" :changes="own?.changes" :loading="loading" :now="now" />
            <ShipJournal :task="shown" :desk="desk" :messages="own?.messages ?? []" :cargo="cargo" :limits="limits" :source="source" :now="now" />
          </div>
          <div class="col side">
            <ShipHull :task="shown" :limits="limits" :cargo="cargo" :now="now" />
            <ShipOrders v-if="view.commands" :task="shown" :desk="desk" :limits="limits" :cargo="cargo" />
            <ShipDocs v-if="view.docs" :files="files" :loading="loading" @open="openDoc" />
          </div>
        </main>
      </template>
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

/* Under «Сейчас»: what is done and the voyage log, beside the ship's card, the other orders and the documents. */
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
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

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .grid > .side {
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    align-items: start;
  }
}

@media (max-width: 760px) {
  .grid > .side {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ship-screen {
    animation: none;
  }
}
</style>
