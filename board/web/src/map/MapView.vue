<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { ArtIndex, LogEvent, TaskSummary } from "../types";
import { createBoard, useNow, type Board } from "../store/board";
import { formatAge, formatDuration, formatUntil } from "../lib/format";
import { ACTIVITY, EXECUTORS, PHASES, prLabel, problemLabel, taskTitle } from "../lib/labels";
import TaskPanel from "../components/TaskPanel.vue";
import frameLight from "./art/frame-light.png";
import DaySummary from "./DaySummary.vue";
import ReplayBar from "./ReplayBar.vue";
import ShipLog from "./ShipLog.vue";
import { depotEmpty, depots, depotPositions, refuelText, stars, supplyLines } from "./fleet";
import { cardPlace, starPositions, starRadius, systemFrame, worldSize, type Camera, type Size } from "./layout";
import { PLACES, placement, systemTasks, type Place, type Placement } from "./placement";
import { replayDepartures, replayFleet } from "./replay";
import { FLIGHT_SECONDS, createFleetScene, type FleetScene, type ShipEntry } from "./scene";
import { useReplay } from "./useReplay";

const props = defineProps<{ board: Board; active: boolean }>();
const emit = defineEmits<{ board: [] }>();

// The clock stops while the map is hidden, so a hidden map does not re-render every second.
const clock = useNow();
const now = ref(clock.value);
watch(clock, (value) => {
  if (props.active) now.value = value;
});

// In `dev:fixture` mode a scenario can stand in for the board's source.
const demo = import.meta.env.MODE === "fixture";
const sourceKind = ref<"board" | "scenario">("board");
const scenario = shallowRef<Board | null>(null);
watch(sourceKind, async (kind) => {
  repo.value = null;
  selected.value = null;
  if (kind !== "scenario" || scenario.value) return;
  // Written out so that a production build drops the scenario.
  if (import.meta.env.MODE === "fixture") {
    const { scenarioSource } = await import("./scenario");
    const board = createBoard(scenarioSource());
    board.start();
    scenario.value = board;
  }
});
const source = computed(() => (sourceKind.value === "scenario" && scenario.value ? scenario.value : props.board));
const liveTasks = computed(() => source.value.tasks.value);
const loaded = computed(() => source.value.state.value.loaded);

// Replay: the fleet of a past moment, rebuilt from the ship's log. Live updates keep coming into the board
// meanwhile; they reach the map again when it goes back on air.
const replay = useReplay(source, now);
/** The moment the map shows: the replay's, or now. */
const mapNow = computed(() => replay.at ?? now.value);
const tasks = computed(() => (replay.at !== null ? replayFleet(replay.events, replay.at, liveTasks.value) : liveTasks.value));
const departures = computed(() => (replay.at !== null ? replayDepartures(replay.events, replay.at) : undefined));

// Galaxy: one star per repository, one depot per account. Null means the whole galaxy is shown.
const repo = ref<string | null>(null);
const starList = computed(() => {
  if (replay.at === null) return stars(tasks.value);
  // Every system of the board and of the day keeps its star, so that the galaxy does not rearrange as it plays.
  const list = stars([...tasks.value, ...liveTasks.value.map((task) => ({ ...task, column: "closed" as const }))]);
  const known = new Set(list.map((star) => star.repo));
  for (const event of replay.events) {
    if (!event.repo || !event.slug || known.has(event.repo)) continue;
    known.add(event.repo);
    list.push({ repo: event.repo, live: 0, attention: 0, ready: 0, sleeping: 0, dots: [] });
  }
  return list.sort((a, b) => a.repo.localeCompare(b.repo));
});
// Tankers and depots stay live: the accounts' past is not recorded.
const depotList = computed(() => depots(source.value.state.value.accounts?.data ?? null, now.value));
const lines = computed(() => supplyLines(liveTasks.value, depotList.value));
const repoModel = computed({
  get: () => repo.value ?? "",
  set: (value: string) => {
    repo.value = value || null;
  },
});
watch(starList, (list) => {
  if (repo.value && !list.some((star) => star.repo === repo.value)) repo.value = null;
});

// Each repository may have its own pictures. They are looked up again whenever the map comes back, so new
// art shows up without a reload. Without them the map keeps its shared art.
const repoArt = shallowRef<ArtIndex>({});
async function loadArt() {
  const from = source.value.source;
  const art = await from.fetchArt().catch(() => repoArt.value);
  if (from === source.value.source && JSON.stringify(art) !== JSON.stringify(repoArt.value)) repoArt.value = art;
}
watch(source, loadArt, { immediate: true });
const emblemOf = (name: string | null) => (name ? (repoArt.value[name]?.emblem ?? null) : null);
const hideImage = (event: Event) => {
  (event.target as HTMLElement).hidden = true;
};

const system = computed(() => (repo.value ? systemTasks(tasks.value, repo.value) : { shown: [], hidden: [] }));
const entries = computed<ShipEntry[]>(() =>
  system.value.shown.map((task) => ({ task, placement: placement(task, mapNow.value, system.value.shown)! })),
);

// Labels ------------------------------------------------------------------------------------------

const world = ref<Size>(worldSize({ width: 1600, height: 1000 }));
const glyph = (task: TaskSummary) => (task.executor === "codex" ? "◆" : "✳");

function phaseText(task: TaskSummary): string {
  switch (task.column) {
    case "sleeping":
      return task.sleeping_until !== null ? `сон ${formatUntil(task.sleeping_until, mapNow.value)}` : PHASES.sleeping;
    case "review_me":
      return "ждёт тебя";
    case "attention":
      return problemLabel(task) ?? "нужно внимание";
    default: {
      const ticking = task.alive && task.phase_started_at !== null;
      return ticking ? `${PHASES[task.phase]} · ${formatDuration(mapNow.value - task.phase_started_at!)}` : PHASES[task.phase];
    }
  }
}

/** The ship's line: its latest activity and how old it is, or why it no longer works. */
function activityLine(task: TaskSummary, where: Placement): string {
  if (task.column === "review_me") return task.pr ? `готово · ${prLabel(task.pr)}` : "готово";
  if (!task.alive) return `${task.summary ?? problemLabel(task) ?? "надзиратель не запущен"} · ${formatAge(task.updated_at, mapNow.value)}`;
  const activity = task.activity;
  if (!activity) return task.summary ? `${task.summary} · ${formatAge(task.updated_at, mapNow.value)}` : "нет активности";
  const age = where.stale && activity.at !== null ? ` · ${formatAge(activity.at, mapNow.value)}` : "";
  return `${ACTIVITY[activity.kind].icon} ${activity.text}${age}`;
}

const STATION_TEXT: Record<Place, { name: string; note: string }> = {
  command: { name: "Штаб", note: "твои сессии" },
  yard: { name: "Верфь", note: "работа и фиксы" },
  range: { name: "Полигон", note: "проверка" },
  inspection: { name: "Инспекция", note: "ревью" },
  gate: { name: "Гиперврата", note: "CI" },
  roadstead: { name: "Рейд", note: "ждёт тебя" },
  cryo: { name: "Криополе", note: "сон" },
};

/** Rows a station card shows before it folds the rest. */
const CARD_ROWS = 4;
const unfolded = ref<Place | null>(null);
watch(repo, () => {
  unfolded.value = null;
});

/** Where a label stands in the world; the camera's --tx, --ty and --zoom on the overlay turn it into pixels. */
const at = (x: number, y: number) => ({ "--x": Math.round(x), "--y": Math.round(y) });

const starLabels = computed(() => {
  const places = starPositions(starList.value.map((star) => star.repo), world.value);
  return starList.value.map((star) => {
    const point = places.get(star.repo)!;
    const notes = [
      star.attention ? `тревог ${star.attention}` : "",
      star.ready ? `ждут ${star.ready}` : "",
      star.sleeping ? `спят ${star.sleeping}` : "",
    ].filter(Boolean);
    return { star, style: at(point.x, point.y + starRadius(star.live) * 1.25 + 44), notes: notes.join(" · "), emblem: emblemOf(star.repo) };
  });
});

const depotLabels = computed(() => {
  const places = depotPositions(depotList.value, world.value);
  return depotList.value.map((depot) => {
    const point = places.get(depot.key)!;
    const top = depot.executor === "codex";
    return {
      depot,
      top,
      style: at(point.x, point.y + (top ? 76 : -66)),
      fuel: depot.status ?? (depot.fuel === null ? "нет данных" : `${depot.fuel}%`),
      low: depotEmpty(depot),
      refuel: depotEmpty(depot) ? refuelText(depot.refuelAt, now.value) : null,
    };
  });
});

const cards = computed(() => {
  const frame = systemFrame(world.value);
  return PLACES.map((place) => {
    const ships = entries.value
      .filter((entry) => entry.placement.place === place)
      .sort((a, b) => Number(b.placement.beacon) - Number(a.placement.beacon) || a.placement.slot - b.placement.slot)
      .map(({ task, placement: where }) => ({
        task,
        name: taskTitle(task),
        phase: phaseText(task),
        beacon: where.beacon,
        title: [taskTitle(task), phaseText(task), `${EXECUTORS[task.executor]}${task.account ? ` · ${task.account}` : ""}`, activityLine(task, where)].join("\n"),
      }));
    const point = cardPlace(place, frame);
    const open = unfolded.value === place;
    return {
      place,
      text: STATION_TEXT[place],
      ships: open ? ships : ships.slice(0, CARD_ROWS),
      folded: open ? 0 : Math.max(0, ships.length - CARD_ROWS),
      side: point.side,
      style: at(point.x, point.y),
    };
  });
});

const hiddenTitle = computed(() => system.value.hidden.map(taskTitle).join("\n"));

// Panel -------------------------------------------------------------------------------------------

const selected = ref<string | null>(null);
const hovered = ref<string | null>(null);
const selectedTask = computed(() => (selected.value ? (source.value.state.value.tasks[selected.value] ?? null) : null));

function open(slug: string) {
  selected.value = slug;
}

function close() {
  const slug = selected.value;
  selected.value = null;
  void nextTick(() => {
    const row = slug ? overlay.value?.querySelector<HTMLElement>(`[data-ship="${CSS.escape(slug)}"]`) : null;
    (row ?? host.value?.querySelector<HTMLElement>("canvas"))?.focus();
  });
}

// The labels of the place the map flies to wait for it to arrive.
const flying = ref(false);
let flightTimer: ReturnType<typeof setTimeout> | undefined;
watch(repo, () => {
  clearTimeout(flightTimer);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  flying.value = true;
  flightTimer = setTimeout(() => {
    flying.value = false;
  }, FLIGHT_SECONDS * 1000);
});

function enter(name: string) {
  repo.value = name;
}

function leave() {
  repo.value = null;
  selected.value = null;
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape" && props.active && repo.value && !selected.value) leave();
}

// Ship's log and the day's summary -----------------------------------------------------------------

const events = computed(() => source.value.events.value);
/** The log's lines: the replayed day's while the map replays, else the live last day. */
const logEvents = computed(() => {
  if (replay.at === null) return events.value;
  const { since, until } = replay.window;
  return replay.events.filter((event) => event.at >= since && event.at <= until);
});
const replayClock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const systemNames = computed(() => new Set(starList.value.map((star) => star.repo)));
const eventsError = computed(() => source.value.eventsError.value);
// The last day's history loads whenever the map opens; live events join it without duplicates.
watch(
  [source, () => props.active],
  ([board, active]) => {
    if (active) void board.loadEvents();
  },
  { immediate: true },
);

/** To the event's system, with its ship selected while the ship is still on the map. */
function goTo(event: LogEvent) {
  if (!event.repo) return;
  repo.value = event.repo;
  const ship = event.slug ? systemTasks(tasks.value, event.repo).shown.find((task) => task.slug === event.slug) : undefined;
  selected.value = ship ? ship.slug : null;
}

/** A line of the log in replay: the scale moves to its time, and the map to its system. */
function seekTo(event: LogEvent) {
  replay.seek(event.at);
  if (event.repo && systemNames.value.has(event.repo)) repo.value = event.repo;
}

const summaryOpen = ref(false);
const summaryButton = ref<HTMLButtonElement | null>(null);
function closeSummary() {
  summaryOpen.value = false;
  void nextTick(() => summaryButton.value?.focus());
}

// Scene -------------------------------------------------------------------------------------------

const host = ref<HTMLElement | null>(null);
const overlay = ref<HTMLElement | null>(null);
const failure = ref<"webgl" | "lost" | null>(null);
let scene: FleetScene | null = null;
let unmounted = false;

function feed() {
  if (!scene) return;
  scene.setGalaxy({ stars: starList.value, depots: depotList.value, lines: lines.value });
  scene.setArt(repoArt.value);
  scene.setView(repo.value);
  scene.setShips(entries.value, departures.value);
  scene.setSelected(selected.value);
  scene.setHovered(hovered.value);
  scene.setActive(props.active);
}

function applyCamera(camera: Camera) {
  const style = overlay.value?.style;
  style?.setProperty("--tx", `${camera.tx}px`);
  style?.setProperty("--ty", `${camera.ty}px`);
  style?.setProperty("--zoom", `${camera.zoom}`);
}

async function mount() {
  if (!host.value) return;
  let made: FleetScene;
  try {
    made = await createFleetScene({
      host: host.value,
      onEnter: enter,
      onLeave: leave,
      onPick: open,
      onHover: (slug) => {
        hovered.value = slug;
      },
      onCamera: (next, camera) => {
        world.value = next;
        applyCamera(camera);
      },
      onLost: () => {
        failure.value = "lost";
        scene?.dispose();
        scene = null;
      },
    });
  } catch (error) {
    console.error(error);
    failure.value = "webgl";
    return;
  }
  if (unmounted) {
    made.dispose();
    return;
  }
  failure.value = null;
  scene = made;
  feed();
}

function retry() {
  failure.value = null;
  void nextTick(mount);
}

watch([starList, depotList, lines], () => scene?.setGalaxy({ stars: starList.value, depots: depotList.value, lines: lines.value }));
watch(repoArt, (art) => scene?.setArt(art));
watch(repo, (name) => scene?.setView(name), { flush: "sync" });
watch(entries, (next) => scene?.setShips(next, departures.value));
watch(selected, (slug) => scene?.setSelected(slug));
watch(hovered, (slug) => scene?.setHovered(slug));
watch(
  () => props.active,
  (active) => {
    if (active) {
      now.value = Date.now() / 1000;
      void loadArt();
    }
    scene?.setActive(active);
    if (!active) {
      replay.pause();
      selected.value = null;
      summaryOpen.value = false;
    }
  },
);
onMounted(() => {
  window.addEventListener("keydown", onKey);
  void mount();
});
onBeforeUnmount(() => {
  unmounted = true;
  clearTimeout(flightTimer);
  window.removeEventListener("keydown", onKey);
  scene?.dispose();
  scene = null;
  scenario.value?.stop();
});
</script>

<template>
  <section class="map" aria-label="Карта флота">
    <div class="toolbar">
      <button v-if="repo" type="button" class="btn" @click="leave">← Галактика</button>
      <label class="picker">
        <img v-if="emblemOf(repo)" :key="emblemOf(repo)!" class="emblem" :src="emblemOf(repo)!" alt="" @error="hideImage" />
        <span>Система</span>
        <select v-model="repoModel" class="btn" :disabled="!starList.length">
          <option value="">вся галактика</option>
          <option v-for="star in starList" :key="star.repo" :value="star.repo">{{ star.repo }} · {{ star.live }}</option>
        </select>
      </label>
      <div v-if="demo" class="seg" role="group" aria-label="Источник карты">
        <button type="button" class="btn" :aria-pressed="sourceKind === 'board'" @click="sourceKind = 'board'">Доска</button>
        <button type="button" class="btn" :aria-pressed="sourceKind === 'scenario'" @click="sourceKind = 'scenario'">Сценарий</button>
      </div>
      <button ref="summaryButton" type="button" class="btn" :aria-expanded="summaryOpen" @click="summaryOpen = true">Сводка дня</button>
      <span class="legend" aria-hidden="true">
        <span class="codex">◆ Codex</span>
        <span class="claude">✳ Claude</span>
      </span>
      <span class="hint">{{ repo ? "Колесо назад или Esc — к галактике" : "Нажми на звезду или прокрути к ней колесо" }}</span>
    </div>

    <div v-if="failure" class="fallback" role="alert">
      <p v-if="failure === 'webgl'">Карта не смогла запустить графику в этом браузере. Задачи видны на доске.</p>
      <p v-else>Видеокарта сбросила карту. Можно попробовать ещё раз или перейти на доску.</p>
      <p>
        <a href="#" @click.prevent="emit('board')">Открыть доску</a>
        <template v-if="failure === 'lost'"> · <a href="#" @click.prevent="retry">Повторить</a></template>
      </p>
    </div>

    <div v-show="!failure" ref="host" class="stage">
      <div ref="overlay" class="overlay" :class="{ flying }" :style="{ '--frame': `url(${frameLight})` }">
        <template v-if="!repo">
          <button
            v-for="label in starLabels"
            :key="label.star.repo"
            type="button"
            class="star"
            :class="{ quiet: !label.star.live, alarm: label.star.attention }"
            :style="label.style"
            @click="enter(label.star.repo)"
          >
            <img v-if="label.emblem" :key="label.emblem" class="emblem" :src="label.emblem" alt="" @error="hideImage" />
            <span class="s-text">
              <span class="s-name">{{ label.star.repo }}<span class="num"> · {{ label.star.live || "тихо" }}</span></span>
              <span v-if="label.notes" class="s-notes">{{ label.notes }}</span>
            </span>
          </button>
          <span
            v-for="label in depotLabels"
            :key="label.depot.key"
            class="depot"
            :class="{ up: !label.top, low: label.low }"
            :style="label.style"
            :title="label.depot.name"
          >
            <span class="d-name">{{ label.depot.name }}</span>
            <span class="num">{{ label.fuel }}{{ label.depot.duty ? " · дежурный" : "" }}</span>
            <span v-if="label.refuel" class="num d-refuel">{{ label.refuel }}</span>
          </span>
        </template>
        <template v-else>
          <div v-for="card in cards" :key="card.place" class="card" :class="{ empty: !card.ships.length, side: card.side }" :style="card.style">
            <div class="c-head">{{ card.text.name }}<span> · {{ card.text.note }}</span></div>
            <button
              v-for="ship in card.ships"
              :key="ship.task.slug"
              type="button"
              class="ship"
              :class="[ship.task.executor, { selected: selected === ship.task.slug, hovered: hovered === ship.task.slug, alarm: ship.beacon }]"
              :data-ship="ship.task.slug"
              :title="ship.title"
              @click="open(ship.task.slug)"
              @pointerenter="hovered = ship.task.slug"
              @pointerleave="hovered = null"
            >
              <span class="r-name"><span class="glyph" aria-hidden="true">{{ glyph(ship.task) }}</span>{{ ship.name }}</span>
              <span class="r-phase num">{{ ship.phase }}</span>
            </button>
            <button v-if="card.folded" type="button" class="more" @click="unfolded = card.place">ещё {{ card.folded }}</button>
          </div>
          <span v-if="system.hidden.length" class="hidden-count" :title="hiddenTitle">не показано {{ system.hidden.length }}</span>
        </template>
      </div>
      <div class="dock">
        <ReplayBar :replay="replay" :frame="frameLight" :now="now" />
        <ShipLog
          :events="logEvents"
          :error="replay.at === null ? eventsError : replay.error"
          :repo="repo"
          :frame="frameLight"
          :systems="systemNames"
          :emblem-of="emblemOf"
          :at="replay.at"
          @go="goTo"
          @seek="seekTo"
        />
      </div>
      <p v-if="replay.at !== null" class="plate num" role="status">Перемотка · {{ replayClock.format(new Date(replay.at * 1000)) }}</p>
      <p v-if="!loaded" class="status">Жду первый снимок доски…</p>
      <p v-else-if="!starList.length" class="status">Пока ни одной задачи: галактика пуста.</p>
      <p v-else-if="repo && !entries.length" class="status">
        {{ replay.at === null ? "В этой системе сейчас никого: все задачи закрыты." : "В этот момент в системе никого." }}
      </p>
    </div>

    <TaskPanel
      v-if="selected && active"
      :slug="selected"
      :task="selectedTask"
      :source="source.source"
      :now="now"
      @close="close"
    />
    <DaySummary v-if="summaryOpen && active" :source="source.source" :events="events" :frame="frameLight" @close="closeSummary" />
  </section>
</template>

<style scoped>
.map {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #05070d;
}

.stage :deep(.map-canvas) {
  position: absolute;
  left: 0;
  top: 0;
  display: block;
  touch-action: none;
  outline: none;
}

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

/* The ship's log and, over it, the replay's scale. */
.dock {
  position: absolute;
  left: 10px;
  bottom: 8px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  width: min(540px, calc(100% - 20px));
  max-height: 62%;
}

.dock > :deep(.log) {
  flex: 0 1 auto;
}

.dock > :deep(.replay) {
  flex: none;
}

/* Over the map while it replays; the sky's own labels stay clear under it. */
.plate {
  position: absolute;
  left: 50%;
  top: 46px;
  z-index: 2;
  margin: 0;
  padding: 3px 12px;
  border: 1px solid rgba(243, 198, 78, 0.6);
  border-radius: 3px;
  background: rgba(8, 10, 15, 0.86);
  color: #f3c64e;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.02em;
  transform: translateX(-50%);
  pointer-events: none;
  white-space: nowrap;
}

.status,
.fallback {
  max-width: min(440px, calc(100% - 32px));
  margin: 0;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--muted);
  text-align: center;
  box-shadow: var(--shadow);
}

.status {
  position: absolute;
  left: 50%;
  top: 40%;
  z-index: 2;
  transform: translate(-50%, -50%);
}

.fallback {
  margin: 72px auto 0;
  color: var(--text);
}

.fallback p {
  margin: 4px 0;
}

/* Labels stand on the dark sky in both of the board's themes, so their colours are fixed. */
.overlay {
  --tx: 0px;
  --ty: 0px;
  --zoom: 1;
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  pointer-events: none;
  color: #e8e2d4;
  font-size: 12px;
  line-height: 16px;
}

.overlay.flying {
  visibility: hidden;
}

.star,
.depot,
.card {
  position: absolute;
  left: calc(var(--tx) + var(--x) * var(--zoom) * 1px);
  top: calc(var(--ty) + var(--y) * var(--zoom) * 1px);
  transform: translateX(-50%);
}

.star {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 2px 9px;
  border: 1px solid rgba(214, 170, 96, 0.28);
  border-radius: 3px;
  background: rgba(8, 11, 18, 0.74);
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 17px;
  pointer-events: auto;
  cursor: pointer;
}

.star:hover {
  border-color: rgba(243, 198, 78, 0.8);
  background: rgba(26, 28, 34, 0.92);
}

.star:focus-visible,
.ship:focus-visible,
.more:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.star.quiet {
  border-color: transparent;
  background: none;
  color: #9aa3b4;
}

.s-text {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 0;
}

/* A repository's own mark. It stands on dark in both of the board's themes, like the rest of the map. */
.emblem {
  flex: none;
  box-sizing: border-box;
  width: 30px;
  height: 30px;
  padding: 1px;
  border-radius: 3px;
  background: #0b0e15;
  object-fit: contain;
}

.picker .emblem {
  width: 24px;
  height: 24px;
  margin-left: -6px;
}

.s-name {
  max-width: 100%;
  overflow: hidden;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.s-name .num {
  font-weight: 400;
  color: #b8ad98;
}

.s-notes {
  color: #b8ad98;
  font-size: 11.5px;
  white-space: nowrap;
}

.star.alarm .s-notes {
  color: #ff8d7a;
}

.depot {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 170px;
  color: #b8ad98;
  font-size: 11.5px;
  line-height: 15px;
  white-space: nowrap;
}

.depot.up {
  transform: translate(-50%, -100%);
}

.depot.low .num {
  color: #ff8d7a;
}
.depot.low .d-refuel {
  color: #d9c08a;
}

.d-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card {
  box-sizing: border-box;
  width: 200px;
  padding: 3px 4px 4px;
  border: 10px solid transparent;
  border-image: var(--frame) 30 / 10px / 0 stretch;
  background: rgba(8, 10, 15, 0.86);
  background-clip: padding-box;
}

.card.side {
  transform: none;
}

.card.empty {
  width: auto;
  padding: 1px 6px;
  white-space: nowrap;
}

.c-head {
  padding: 0 3px;
  color: #f3c27a;
  font-weight: 650;
  white-space: nowrap;
}

.c-head span {
  color: #9b907c;
  font-weight: 400;
}

.ship,
.more {
  display: block;
  width: 100%;
  margin: 0;
  padding: 2px 3px;
  border: 0;
  border-radius: 2px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  pointer-events: auto;
  cursor: pointer;
}

.ship:hover,
.ship.hovered {
  background: rgba(214, 170, 96, 0.18);
}

.ship.selected {
  background: rgba(243, 198, 78, 0.28);
}

.r-name,
.r-phase {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.r-name {
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
  margin-right: 4px;
}

.ship.codex .glyph {
  color: #7ea6f5;
}

.ship.claude .glyph {
  color: #e59472;
}

.more {
  color: #b8ad98;
}

.hidden-count {
  position: absolute;
  right: 10px;
  bottom: 8px;
  color: #b8ad98;
}

@media (max-width: 760px) {
  .hint {
    display: none;
  }

  .dock {
    left: 4px;
    bottom: 4px;
    width: calc(100% - 8px);
  }

  .plate {
    top: 84px;
  }

  .picker select {
    max-width: 52vw;
  }

  /* There is no room for the rows: the ships are picked on the map. */
  .ship,
  .more {
    display: none;
  }

  .card {
    width: auto;
    padding: 0 3px;
    white-space: nowrap;
  }

  .c-head span {
    display: none;
  }
}
</style>
