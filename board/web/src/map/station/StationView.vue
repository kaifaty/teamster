<script setup lang="ts">
// The science station's own screen. Clicking the station on the map opens it over the galaxy: a resource bar on
// top with the line «what next», then the decks — the core with the chronometer and the crew, the comms room with
// the order under it, the lab with the lessons and the archive hold. The station's buttons act at once through the board server;
// a board that only reads copies the equivalent command instead.
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, toRef } from "vue";
import { postAction } from "../../lib/actions";
import type { BoardSource } from "../../lib/source";
import nebula from "../art/nebula.jpg";
import stationArt from "../art/station-research.png";
import { plural, type Research } from "../research";
import { clockShort, stationClock } from "../schedule";
import { nextStep, stationCounts, workingSince } from "../station";
import { CONSOLE, createConsole, type Deck } from "./console";
import "./station.css";
import StationComms from "./StationComms.vue";
import StationCore from "./StationCore.vue";
import StationCrew from "./StationCrew.vue";
import StationHold from "./StationHold.vue";
import StationLab from "./StationLab.vue";
import StationOrder from "./StationOrder.vue";

const props = defineProps<{
  research: Research;
  now: number;
  frame: string;
  /** A task's card stands over the screen: Escape belongs to it. */
  covered: boolean;
  /** Where the station's actions go; the fixtures act on their own data. */
  source: BoardSource;
  /** Asks the server for the research again. */
  refresh: () => Promise<void>;
}>();
const emit = defineEmits<{ close: []; open: [slug: string] }>();

const desk = createConsole(toRef(props, "research"), toRef(props, "now"), {
  act: (route, body) => postAction(route, body, { send: props.source.act, refresh: props.refresh }),
  jump: (deck) => jump(deck),
});
provide(CONSOLE, desk);

const counts = computed(() => stationCounts(props.research));
const clock = computed(() => stationClock(props.research.schedule, props.now, workingSince(props.research)));

const next = computed(() => nextStep(props.research, props.now, clock.value));

async function act() {
  const action = next.value.action;
  if (!action) return;
  if (action.kind === "reply") return desk.answer(action.study);
  desk.showStage(action.kind === "review" ? "proposed" : "accepted");
  if (action.kind !== "review") return;
  await nextTick();
  root.value?.querySelector<HTMLElement>('[data-deck="lab"] .card')?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

interface Gauge {
  id: string;
  sigil: string;
  value: string;
  label: string;
  tone: "wait" | "gold" | "teal" | "green" | "amber" | "dim";
  deck: Deck;
  title: string;
}

const gauges = computed<Gauge[]>(() => {
  const c = counts.value;
  return [
    {
      id: "questions", sigil: "?", value: String(c.questions), label: plural(c.questions, "вопрос", "вопроса", "вопросов"),
      tone: c.questions ? "wait" : "dim", deck: "comms", title: "Вопросы аналитика, которые ждут ответа",
    },
    {
      id: "proposed", sigil: "◆", value: String(c.proposed), label: "на решение",
      tone: c.proposed ? "gold" : "dim", deck: "lab", title: "Предложенные уроки ждут твоего решения",
    },
    {
      id: "accepted", sigil: "◇", value: String(c.accepted), label: "к внедрению",
      tone: c.accepted ? "teal" : "dim", deck: "lab", title: "Принятые уроки, изменение ещё не сделано",
    },
    {
      id: "applied", sigil: "✓", value: String(c.applied), label: "внедрено",
      tone: c.applied ? "green" : "dim", deck: "lab", title: "Уроки, которые уже изменили правила",
    },
    {
      id: "hold", sigil: "▣", value: String(c.records), label: c.signals ? `в трюме · ${c.signals} ⚠` : "в трюме",
      tone: c.signals ? "amber" : "dim", deck: "hold", title: "Записи для следующего разбора и сколько из них с сигналом",
    },
    {
      id: "clock", sigil: "◷", value: clockShort(clock.value, props.now, props.research.schedule?.next_at), label: clock.value.state === "running" ? "разбор" : "до разбора",
      tone: clock.value.state === "running" ? "teal" : clock.value.state === "due" ? "gold" : "dim", deck: "core",
      title: clock.value.rule ? `Плановый разбор: ${clock.value.rule}` : "Плановых разборов нет",
    },
  ];
});

const root = ref<HTMLElement | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | undefined;
/** Brings a deck into view and lights its frame for a moment. */
function jump(deck: Deck) {
  const element = root.value?.querySelector<HTMLElement>(`[data-deck="${deck}"]`);
  if (!element) return;
  element.scrollIntoView({ block: "nearest", behavior: "smooth" });
  root.value?.querySelectorAll(".deck.flash").forEach((item) => item.classList.remove("flash"));
  element.classList.add("flash");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => element.classList.remove("flash"), 1200);
}

const back = ref<HTMLButtonElement | null>(null);
const onKey = (event: KeyboardEvent) => {
  if (event.key !== "Escape" || event.isComposing || props.covered) return;
  // Escape in a field leaves the field; the next one leaves the station. Drafts live only while it is open.
  const field = event.target instanceof HTMLElement && event.target.closest("input, textarea, select");
  if (field) {
    (field as HTMLElement).blur();
    return;
  }
  emit("close");
};
onMounted(() => {
  back.value?.focus();
  window.addEventListener("keydown", onKey);
});
// While the analyst works, or a study just ordered has not shown up yet, the screen asks for news more often.
const WATCH_MS = 10_000;
let watchTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  watchTimer = setInterval(() => {
    if (props.research.running || desk.awaiting.value) void props.refresh();
  }, WATCH_MS);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  clearTimeout(flashTimer);
  clearInterval(watchTimer);
  desk.dispose();
});
</script>

<template>
  <section
    ref="root"
    class="station-screen"
    role="dialog"
    aria-modal="false"
    aria-labelledby="station-title"
    :style="{ '--frame': `url(${frame})`, '--sky': `url(${nebula})` }"
  >
    <header class="hud">
      <button ref="back" type="button" class="back" title="Вернуться к галактике (Esc)" @click="emit('close')">← Галактика</button>
      <div class="ident">
        <img class="emblem" :src="stationArt" alt="" />
        <span class="titles">
          <h2 id="station-title">Научная станция</h2>
          <span class="next" role="status">
            <span class="headline" :class="next.tone">{{ next.text }}</span>
            <button v-if="next.action" type="button" class="next-key" :class="next.tone" @click="act">{{ next.action.label }}</button>
          </span>
        </span>
      </div>
      <nav class="gauges" aria-label="Показатели станции">
        <button
          v-for="gauge in gauges"
          :key="gauge.id"
          type="button"
          class="gauge"
          :class="gauge.tone"
          :title="gauge.title"
          @click="jump(gauge.deck)"
        >
          <span class="g-sigil" aria-hidden="true">{{ gauge.sigil }}</span>
          <b class="g-value num">{{ gauge.value }}</b>
          <span class="g-label">{{ gauge.label }}</span>
        </button>
      </nav>
    </header>

    <div class="decks">
      <div class="side">
        <div class="col left">
          <StationCore :research="research" :clock="clock" :now="now" @open="emit('open', $event)" />
          <StationCrew :research="research" :now="now" />
        </div>
        <div class="col right">
          <StationLab :research="research" @jump="jump" />
          <StationHold :research="research" />
        </div>
      </div>
      <div class="col center">
        <StationComms :research="research" :now="now" />
        <StationOrder />
      </div>
    </div>
  </section>
</template>

<style scoped>
.station-screen {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(ellipse at 50% 30%, rgba(5, 7, 13, 0.45), rgba(5, 7, 13, 0.9) 75%),
    var(--sky) center / cover no-repeat,
    #05070d;
  animation: open 0.32s ease-out;
}

@keyframes open {
  from {
    opacity: 0;
    transform: scale(0.985);
  }
}

/* The resource bar. */
.hud {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--st-line);
  background: linear-gradient(180deg, rgba(8, 10, 15, 0.96), rgba(8, 10, 15, 0.78));
}

.back {
  flex: none;
  padding: 4px 10px;
  border: 1px solid rgba(214, 170, 96, 0.4);
  border-radius: 2px;
  background: rgba(20, 22, 28, 0.9);
  color: #d4cab5;
  font: inherit;
  cursor: pointer;
}

.back:hover {
  border-color: var(--st-wait);
  color: var(--st-wait);
}

.ident {
  display: flex;
  flex: 1 1 260px;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.emblem {
  flex: none;
  width: 40px;
  height: 40px;
  object-fit: contain;
  filter: drop-shadow(0 0 8px rgba(95, 214, 200, 0.45));
}

.titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

h2 {
  margin: 0;
  color: var(--st-title);
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.next {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.headline {
  overflow: hidden;
  color: var(--st-dim);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.headline.live,
.headline.teal {
  color: var(--st-teal);
}

.headline.wait,
.headline.gold {
  color: var(--st-wait);
}

.next-key {
  flex: none;
  padding: 1px 10px;
  border: 1px solid var(--st-teal);
  border-radius: 2px;
  background: rgba(95, 214, 200, 0.16);
  color: #dffaf5;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

.next-key.wait,
.next-key.gold {
  border-color: var(--st-wait);
  background: rgba(243, 198, 78, 0.16);
  color: #ffe9a8;
}

.next-key:hover {
  filter: brightness(1.25);
}

.gauges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.gauge {
  display: grid;
  grid-template-columns: auto auto;
  grid-template-areas:
    "sigil value"
    "label label";
  align-items: baseline;
  justify-content: center;
  gap: 0 6px;
  min-width: 86px;
  padding: 3px 10px 4px;
  border: 1px solid rgba(155, 144, 124, 0.3);
  border-radius: 3px;
  background: rgba(10, 12, 16, 0.85);
  color: var(--st-dim);
  font: inherit;
  cursor: pointer;
}

.gauge:hover {
  border-color: rgba(243, 198, 78, 0.7);
}

.g-sigil {
  grid-area: sigil;
  font-size: 12px;
}

.g-value {
  grid-area: value;
  font-size: 18px;
  line-height: 22px;
}

.g-label {
  grid-area: label;
  font-size: 11px;
  line-height: 13px;
  text-align: center;
  white-space: nowrap;
}

.gauge.wait {
  border-color: rgba(243, 198, 78, 0.75);
  background: rgba(243, 198, 78, 0.12);
  color: var(--st-wait);
  box-shadow: 0 0 12px rgba(243, 198, 78, 0.25);
}

.gauge.gold {
  border-color: rgba(243, 194, 122, 0.55);
  color: var(--st-title);
}

.gauge.teal {
  border-color: rgba(95, 214, 200, 0.5);
  color: var(--st-teal);
}

.gauge.green {
  border-color: rgba(111, 207, 143, 0.45);
  color: var(--st-green);
}

.gauge.amber {
  border-color: rgba(255, 141, 122, 0.5);
  color: #ffb39e;
}

/* The decks: core and crew; the comms room in the middle with the order under it, since an order opens a channel
   there; lab and hold. */
.decks {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(270px, 300px) minmax(0, 1fr) minmax(320px, 460px);
  grid-template-rows: minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
  padding: 10px;
}

.side {
  display: contents;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.left {
  grid-column: 1;
  grid-row: 1;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

.left > :deep(.core) {
  flex: none;
}

.left > :deep(.crew) {
  flex: 1 0 auto;
}

.center {
  grid-column: 2;
  grid-row: 1;
}

.center > :deep(.comms) {
  flex: 1 1 auto;
  min-height: 260px;
}

.center > :deep(.order) {
  flex: none;
}

.right {
  grid-column: 3;
  grid-row: 1;
}

.right > :deep(.lab) {
  flex: 3 1 0;
}

.right > :deep(.hold) {
  flex: 2 1 0;
}

/* A medium window: the side decks share one scrolling column beside the comms room. */
@media (max-width: 1279px) {
  .decks {
    grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: 10px;
    grid-column: 1;
    grid-row: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
  }

  .left,
  .right {
    flex: none;
    overflow: visible;
  }

  .side :deep(.deck) {
    flex: none !important;
  }

  .side :deep(.deck-body) {
    overflow: visible;
  }
}

/* A phone: one column, the page scrolls. */
@media (max-width: 859px) {
  .station-screen {
    overflow-y: auto;
  }

  .decks {
    display: flex;
    flex: none;
    flex-direction: column;
  }

  .side {
    display: contents;
  }

  .left {
    order: 1;
  }

  .center {
    order: 2;
  }

  .right {
    order: 3;
  }

  .center > :deep(.comms) {
    min-height: 560px;
  }

  .gauges {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    width: 100%;
  }

  .gauge {
    min-width: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .station-screen {
    animation: none;
  }
}
</style>
