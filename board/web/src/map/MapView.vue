<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { ArtIndex, LogEvent, ResearchView, TaskSummary } from "../types";
import { createBoard, useNow, type Board } from "../store/board";
import { formatDuration, formatUntil } from "../lib/format";
import { EXECUTORS, PHASES, problemLabel, shipLine, taskTitle } from "../lib/labels";
import TaskPanel from "../components/TaskPanel.vue";
import frameLight from "./art/frame-light.png";
import DaySummary from "./DaySummary.vue";
import ReplayBar from "./ReplayBar.vue";
import ShipLog from "./ShipLog.vue";
import { depotEmpty, depots, depotPositions, refuelText, stars, supplyLines, type Star } from "./fleet";
import { placeLabels, type StarLabel } from "./declutter";
import {
  RESEARCH_SIZE,
  cardPlace,
  fitCamera,
  galaxyKeepOuts,
  galaxyLayout,
  labelDrop,
  logCorner,
  researchPosition,
  starSize,
  systemFrame,
  worldSize,
  type Camera,
  type Galaxy,
  type Rect,
  type Size,
} from "./layout";
import ResearchPanel from "./ResearchPanel.vue";
import { isReflection, research, shortDate } from "./research";
import { PLACES, placement, systemTasks, type Place, type Placement } from "./placement";
import { replayExits, replayFleet } from "./replay";
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
// What the reflection learned. Runs of the reflection are the research station's own work, not a system's.
const researchView = shallowRef<ResearchView | null>(null);
async function loadResearch() {
  const from = source.value.source;
  const view = await from.fetchResearch().catch(() => researchView.value);
  if (from === source.value.source && JSON.stringify(view) !== JSON.stringify(researchView.value)) researchView.value = view;
}
const allTasks = computed(() => source.value.tasks.value);
const notReflection = (task: TaskSummary) => !isReflection(task, researchView.value);
const liveTasks = computed(() => allTasks.value.filter(notReflection));
const loaded = computed(() => source.value.state.value.loaded);

// Replay: the fleet of a past moment, rebuilt from the ship's log. Live updates keep coming into the board
// meanwhile; they reach the map again when it goes back on air.
const replay = useReplay(source, now);
/** The moment the map shows: the replay's, or now. */
const mapNow = computed(() => replay.at ?? now.value);
const tasks = computed(() =>
  replay.at !== null ? replayFleet(replay.events, replay.at, liveTasks.value).filter(notReflection) : liveTasks.value,
);
/** Whether the scene's ships were last the replay's: going back on air, the ships the live fleet lacks fade. */
let replayedShips = false;
function setShips(next: ShipEntry[]) {
  if (!scene) return;
  scene.setShips(next, replayExits(replay.at, replayedShips, replay.events));
  replayedShips = replay.at !== null;
}

// Galaxy: one star per repository, one depot per account. Null means the whole galaxy is shown.
const repo = ref<string | null>(null);
// The same list while nothing changes, so that a playing replay does not redraw the galaxy at every step.
let lastStars: Star[] = [];
const starList = computed(() => {
  const next = galaxyStars();
  if (JSON.stringify(next) === JSON.stringify(lastStars)) return lastStars;
  lastStars = next;
  return next;
});
function galaxyStars(): Star[] {
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
}
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
watch(source, () => {
  researchView.value = null;
  void loadResearch();
}, { immediate: true });
const emblemOf = (name: string | null) => (name ? (repoArt.value[name]?.emblem ?? null) : null);
const hideImage = (event: Event) => {
  (event.target as HTMLElement).hidden = true;
};

const station = computed(() => research(researchView.value, allTasks.value, starList.value.map((star) => star.repo)));
const researchMarks = computed(() =>
  station.value
    ? { running: station.value.running, proposed: station.value.proposed.length, watched: station.value.watched, probes: station.value.probes }
    : null,
);
// A finished run has written its report: read it at once rather than at the next refresh.
watch(() => station.value?.running ?? false, (running, was) => {
  if (was && !running) void loadResearch();
});
const researchOpen = ref(false);

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
const activityLine = (task: TaskSummary, where: Placement) => shipLine(task, where.stale, mapNow.value, replay.at !== null);

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

/** The parts of the world under the map's own panels, measured for the window; the log's corner until then. */
const covered = shallowRef<Rect[] | null>(null);
/** The zoom of the full view in this window, at which the labels' room is reserved. */
const fullZoom = ref<number | undefined>(undefined);
let previousGalaxy: Galaxy | null = null;
const galaxy = computed(() => {
  const depotsAt = [...depotPositions(depotList.value, world.value).values()];
  const blocked = galaxyKeepOuts(world.value, depotsAt, covered.value ?? [logCorner(world.value)]);
  // The stars keep their places from the last layout while they fit there.
  const next = galaxyLayout(starList.value, world.value, blocked, previousGalaxy, fullZoom.value);
  previousGalaxy = next;
  return next;
});

const starLabels = computed(() => {
  const places = galaxy.value.places;
  return starList.value.map((star) => {
    const point = places.get(star.repo)!;
    const notes = [
      star.attention ? `тревог ${star.attention}` : "",
      star.ready ? `ждут ${star.ready}` : "",
      star.sleeping ? `спят ${star.sleeping}` : "",
    ].filter(Boolean);
    const ships = star.live ? `кораблей ${star.live}` : "тихо";
    return { star, style: at(point.x, point.y), title: [`${star.repo}: ${ships}`, ...notes].join(" · "), emblem: emblemOf(star.repo) };
  });
});

const stationLabel = computed(() => {
  const marks = station.value;
  if (!marks) return null;
  const point = researchPosition(world.value);
  const last = marks.batch ? `разбор ${shortDate(marks.batch.date)}` : "разборов не было";
  const proposed = marks.proposed.length;
  // One note under the name, the most pressing one; the panel has the rest.
  const note = marks.running ? "идёт разбор" : proposed ? `ждут решения ${proposed}` : last;
  const title = [marks.running ? "идёт разбор" : last, `ждут решения ${proposed}`, `с сигналом ${marks.pending.signals} из ${marks.pending.records}`].join("\n");
  return { style: at(point.x, point.y + RESEARCH_SIZE * 0.5 + 18), note, title, running: marks.running, waiting: !marks.running && proposed > 0 };
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
  researchOpen.value = false;
  selected.value = slug;
}

function openResearch() {
  selected.value = null;
  researchOpen.value = true;
}

function closeResearch() {
  researchOpen.value = false;
  void nextTick(() => overlay.value?.querySelector<HTMLElement>(".station")?.focus());
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
  if (event.key === "Escape" && props.active && repo.value && !selected.value && !researchOpen.value) leave();
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
const replayTime = computed(() => (replay.at === null ? null : replayClock.format(new Date(replay.at * 1000))));
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

// Star labels -------------------------------------------------------------------------------------

/** A quiet star shows its name once a step of the galaxy's lattice is this many pixels on the screen. */
const QUIET_NAMES_PX = 110;
const hoveredStar = ref<string | null>(null);
let lastCamera: Camera | null = null;
let labelFrame = 0;
/** The labels' sizes in pixels, measured when they change; the camera does not change them. */
const labelSizes = new Map<string, Size>();

function measureLabels() {
  labelSizes.clear();
  for (const el of overlay.value?.querySelectorAll<HTMLElement>("[data-star]") ?? []) {
    labelSizes.set(el.dataset.star!, { width: el.offsetWidth, height: el.offsetHeight });
  }
  scheduleLabels();
}

function scheduleLabels() {
  cancelAnimationFrame(labelFrame);
  labelFrame = requestAnimationFrame(placeStarLabels);
}

/**
 * Places the star labels for the camera, the most pressing first: alarms, then systems waiting for you, then the
 * busiest. Each stands around its star where it covers no other label, busy star or panel; one with no room waits for
 * the zoom, except an alarm's or the one under the pointer.
 */
function placeStarLabels() {
  const box = overlay.value;
  const camera = lastCamera;
  if (!box || !camera || repo.value) return;
  const frame = box.getBoundingClientRect();
  const relative = (rect: DOMRect): Rect => ({ x0: rect.left - frame.left, y0: rect.top - frame.top, x1: rect.right - frame.left, y1: rect.bottom - frame.top });
  const root = box.closest(".map") ?? box;
  const obstacles = [...root.querySelectorAll<HTMLElement>(".toolbar, .dock, .overlay .station, .overlay .depot")]
    .filter((el) => el.offsetParent !== null)
    .map((el) => relative(el.getBoundingClientRect()));
  const layout = galaxy.value;
  const names = layout.spacing * camera.zoom >= QUIET_NAMES_PX;
  const labels: StarLabel[] = [];
  for (const star of starList.value) {
    const point = layout.places.get(star.repo);
    const size = labelSizes.get(star.repo);
    const pointed = hoveredStar.value === star.repo;
    if (!point || !size || (!star.live && !names && !pointed)) continue;
    const x = camera.tx + point.x * camera.zoom;
    const y = camera.ty + point.y * camera.zoom;
    // A star off the screen has no label: there is nothing for it to name.
    if (x < 0 || y < 0 || x > frame.width || y > frame.height) continue;
    const ring = star.live ? starSize(star.live, layout) * 1.25 + 26 * layout.scale : starSize(0, layout) * 1.15;
    labels.push({
      id: star.repo,
      x,
      y,
      ...size,
      radius: ring * camera.zoom,
      drop: (star.live ? labelDrop(star.live, layout) : ring + 4) * camera.zoom,
      priority: pointed ? 1e9 : star.attention ? 1e6 + star.attention * 100 + star.live : star.ready ? 1e4 + star.ready * 10 + star.live : star.live,
      forced: pointed || star.attention > 0,
      solid: star.live > 0,
    });
  }
  const spots = placeLabels(labels, obstacles, { x0: 0, y0: 0, x1: frame.width, y1: frame.height });
  for (const el of box.querySelectorAll<HTMLElement>("[data-star]")) {
    const spot = spots.get(el.dataset.star!) ?? null;
    el.style.visibility = spot ? "visible" : "hidden";
    if (!spot) continue;
    el.style.setProperty("--dx", `${spot.dx}px`);
    el.style.setProperty("--dy", `${spot.dy}px`);
  }
}

watch([starLabels, repo], () => void nextTick(measureLabels), { flush: "post" });
watch(hoveredStar, scheduleLabels);

// The dock on a narrow window -----------------------------------------------------------------------

/** A phone-sized window, as the `@media (max-width: 760px)` rules see it: the dock folds there to one line. */
const narrowQuery = matchMedia("(max-width: 760px)");
const narrow = ref(narrowQuery.matches);
const onNarrow = (event: MediaQueryListEvent) => {
  narrow.value = event.matches;
};
/** On a narrow window, the replay's scale and the whole log open over the map on demand. */
const replayOpen = ref(false);
const logOpen = ref(false);
const dockFolded = computed(() => !narrow.value || (!replayOpen.value && !logOpen.value));
// Across the breakpoint the dock changes its shape: it folds and is measured again.
watch(narrow, () => {
  replayOpen.value = false;
  logOpen.value = false;
  coveredFor = "";
  void nextTick(measureCovered);
});
// The open dock covers the map. Once it folds, a resize made meanwhile is measured and the star labels come back.
watch(dockFolded, (folded) => {
  if (!folded) return;
  void nextTick(() => {
    measureCovered();
    scheduleLabels();
  });
});

/**
 * Measures, for the window, the part of the world under the ship's log, where no star stands, and the full view's zoom.
 * A narrow dock is measured folded: what opens over the map does not move the stars.
 */
let coveredFor = "";
function measureCovered() {
  if (!dockFolded.value) return;
  const stage = host.value?.getBoundingClientRect();
  const dock = host.value?.querySelector<HTMLElement>(".dock")?.getBoundingClientRect();
  if (!stage || !dock || !stage.width || !stage.height) return;
  const key = `${Math.round(stage.width)}x${Math.round(stage.height)}/${world.value.width}`;
  if (key === coveredFor) return;
  coveredFor = key;
  const fit = fitCamera(world.value, { width: stage.width, height: stage.height });
  const margin = 12;
  const toWorld = (x: number, y: number) => ({ x: (x - stage.left - fit.tx) / fit.zoom, y: (y - stage.top - fit.ty) / fit.zoom });
  const from = toWorld(dock.left - margin, dock.top - margin);
  const to = toWorld(dock.right + margin, dock.bottom + margin);
  covered.value = [{ x0: from.x, y0: from.y, x1: to.x, y1: to.y }];
  fullZoom.value = fit.zoom;
}
watch(world, () => void nextTick(measureCovered));
let stageObserver: ResizeObserver | null = null;

// Scene -------------------------------------------------------------------------------------------

const host = ref<HTMLElement | null>(null);
const overlay = ref<HTMLElement | null>(null);
const failure = ref<"webgl" | "lost" | null>(null);
let scene: FleetScene | null = null;
let unmounted = false;

function feed() {
  if (!scene) return;
  scene.setGalaxy(galaxyModel());
  scene.setArt(repoArt.value);
  scene.setView(repo.value);
  setShips(entries.value);
  scene.setSelected(selected.value);
  scene.setHovered(hovered.value);
  scene.setActive(props.active);
}

function applyCamera(camera: Camera) {
  lastCamera = camera;
  scheduleLabels();
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
      onResearch: openResearch,
      onHover: (slug) => {
        hovered.value = slug;
      },
      onHoverStar: (name) => {
        hoveredStar.value = name;
      },
      onCamera: (next, camera) => {
        world.value = next;
        applyCamera(camera);
      },
      labels: overlay.value ?? undefined,
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

function galaxyModel() {
  return { stars: starList.value, layout: galaxy.value, depots: depotList.value, lines: lines.value, research: researchMarks.value };
}
watch([starList, galaxy, depotList, lines, researchMarks], () => scene?.setGalaxy(galaxyModel()));
watch(repoArt, (art) => scene?.setArt(art));
watch(repo, (name) => scene?.setView(name), { flush: "sync" });
watch(entries, setShips);
watch(selected, (slug) => scene?.setSelected(slug));
watch(hovered, (slug) => scene?.setHovered(slug));
watch(
  () => props.active,
  (active) => {
    if (active) {
      now.value = Date.now() / 1000;
      void loadArt();
      void loadResearch();
    }
    scene?.setActive(active);
    if (!active) {
      replay.pause();
      selected.value = null;
      summaryOpen.value = false;
      researchOpen.value = false;
    }
  },
);
// The reflection writes rarely; a visible map asks again every minute.
const RESEARCH_REFRESH_MS = 60_000;
let researchTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  window.addEventListener("keydown", onKey);
  narrowQuery.addEventListener("change", onNarrow);
  if (host.value) {
    stageObserver = new ResizeObserver(() => measureCovered());
    stageObserver.observe(host.value);
  }
  void mount();
  researchTimer = setInterval(() => {
    if (props.active) void loadResearch();
  }, RESEARCH_REFRESH_MS);
});
onBeforeUnmount(() => {
  unmounted = true;
  clearInterval(researchTimer);
  clearTimeout(flightTimer);
  window.removeEventListener("keydown", onKey);
  narrowQuery.removeEventListener("change", onNarrow);
  stageObserver?.disconnect();
  cancelAnimationFrame(labelFrame);
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
        <template v-if="!repo">
          <span class="key"><i class="badge b-alarm" />тревоги</span>
          <span class="key"><i class="badge b-ready" />ждут тебя</span>
          <span class="key"><i class="badge b-sleep" />спят</span>
        </template>
      </span>
      <span class="hint">{{ repo ? "Колесо назад, щипок или Esc — к галактике" : "Нажми на звезду · колесо или щипок — масштаб · тяни — обзор" }}</span>
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
            :data-star="label.star.repo"
            :title="label.title"
            :aria-label="label.title"
            @click="enter(label.star.repo)"
          >
            <img v-if="label.emblem && label.star.live" :key="label.emblem" class="emblem" :src="label.emblem" alt="" @error="hideImage" />
            <span class="s-name">{{ label.star.repo }}<span v-if="label.star.live" class="num"> · {{ label.star.live }}</span></span>
            <span v-if="label.star.attention || label.star.ready || label.star.sleeping" class="badges" aria-hidden="true">
              <b v-if="label.star.attention" class="badge b-alarm">{{ label.star.attention }}</b>
              <b v-if="label.star.ready" class="badge b-ready">{{ label.star.ready }}</b>
              <b v-if="label.star.sleeping" class="badge b-sleep">{{ label.star.sleeping }}</b>
            </span>
          </button>
          <button
            v-if="stationLabel"
            type="button"
            class="station"
            :class="{ live: stationLabel.running, waiting: stationLabel.waiting }"
            :style="stationLabel.style"
            :title="stationLabel.title"
            :aria-expanded="researchOpen"
            @click="openResearch"
          >
            <span class="st-name">Исследовательский центр</span>
            <span class="st-notes">{{ stationLabel.note }}</span>
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
        <p v-if="replayTime" class="plate in-dock num" aria-hidden="true">Перемотка · {{ replayTime }}</p>
        <ReplayBar v-show="!narrow || replayOpen" id="replay-scale" :replay="replay" :frame="frameLight" :now="now" />
        <ShipLog
          v-model:open="logOpen"
          :events="logEvents"
          :error="replay.at === null ? eventsError : replay.error"
          :repo="repo"
          :frame="frameLight"
          :systems="systemNames"
          :emblem-of="emblemOf"
          :at="replay.at"
          :compact="narrow"
          @go="goTo"
          @seek="seekTo"
        >
          <template v-if="narrow" #head>
            <button
              type="button"
              class="dock-replay"
              :class="{ on: replay.active }"
              aria-controls="replay-scale"
              :aria-expanded="replayOpen"
              aria-label="Перемотка дня"
              title="Перемотка дня"
              @click="replayOpen = !replayOpen"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
                <path d="M1 6.4l1.5 1.8L4 6.4" />
                <path d="M8 5v3.2l2.2 1.4" />
              </svg>
            </button>
          </template>
        </ShipLog>
      </div>
      <p v-if="replayTime" class="plate on-sky num" role="status">Перемотка · {{ replayTime }}</p>
      <p v-if="!loaded" class="status">Жду первый снимок доски…</p>
      <p v-else-if="!starList.length" class="status">Пока ни одной задачи: галактика пуста.</p>
      <p v-else-if="repo && !entries.length" class="status">
        {{ replay.at === null ? "В этой системе сейчас никого: все задачи закрыты." : "В этот момент в системе никого." }}
      </p>
    </div>

    <ResearchPanel v-if="researchOpen && active && station" :research="station" :now="now" @close="closeResearch" @open="open" />
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

/* On a narrow window, the button at the head of the folded log that opens the replay's scale. */
.dock-replay {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  margin: 0;
  padding: 0;
  border: 1px solid rgba(214, 170, 96, 0.35);
  border-radius: 2px;
  background: rgba(20, 22, 28, 0.9);
  color: #b8ad98;
  cursor: pointer;
}

.dock-replay.on {
  color: #f3c64e;
}

.dock-replay[aria-expanded="true"] {
  border-color: rgba(243, 198, 78, 0.9);
  background: rgba(243, 198, 78, 0.22);
  color: #f3c64e;
}

.dock-replay:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

/* Over the map while it replays; the sky's own labels stay clear under it. */
.plate {
  margin: 0;
  padding: 3px 12px;
  border: 1px solid rgba(243, 198, 78, 0.6);
  border-radius: 3px;
  background: rgba(8, 10, 15, 0.86);
  color: #f3c64e;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.02em;
  pointer-events: none;
  white-space: nowrap;
}

.plate.on-sky {
  position: absolute;
  left: 50%;
  top: 46px;
  z-index: 2;
  transform: translateX(-50%);
}

/* On a phone the toolbar takes the top of the map: the plate stands over the scale instead. */
.plate.in-dock {
  display: none;
  align-self: center;
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
.station,
.depot,
.card {
  position: absolute;
  left: calc(var(--tx) + var(--x) * var(--zoom) * 1px);
  top: calc(var(--ty) + var(--y) * var(--zoom) * 1px);
  transform: translateX(-50%);
}

/*
 * A star's label: one line, around its star where placeStarLabels finds room (--dx and --dy from the star's centre);
 * hidden until it is placed, and while it waits for the zoom.
 */
.star {
  left: calc(var(--tx) + var(--x) * var(--zoom) * 1px + var(--dx, 0px));
  top: calc(var(--ty) + var(--y) * var(--zoom) * 1px + var(--dy, 0px));
  transform: none;
  visibility: hidden;
  display: flex;
  align-items: center;
  gap: 5px;
  box-sizing: border-box;
  max-width: 220px;
  padding: 1px 7px;
  border: 1px solid rgba(214, 170, 96, 0.28);
  border-radius: 3px;
  background: rgba(8, 11, 18, 0.8);
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  line-height: 19px;
  white-space: nowrap;
  pointer-events: auto;
  cursor: pointer;
}

.star:has(.emblem) {
  padding-left: 2px;
}

.star.alarm {
  border-color: rgba(255, 141, 122, 0.55);
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
  padding: 0 3px;
  border-color: transparent;
  background: none;
  color: #9aa3b4;
  font-size: 11.5px;
  line-height: 15px;
  text-shadow:
    0 0 3px #05070d,
    0 0 2px #05070d;
}

.star .emblem {
  width: 19px;
  height: 19px;
  padding: 0;
}

/* The counts of a star's ships in trouble, waiting for you and asleep, in the colours of their dots. */
.badges {
  display: flex;
  flex: none;
  gap: 3px;
}

.badge {
  box-sizing: border-box;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 11px;
  font-style: normal;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  text-align: center;
}

.b-alarm {
  background: #e0533c;
  color: #fff4ef;
}

.b-ready {
  background: #f3c64e;
  color: #1a1408;
}

.b-sleep {
  background: #a9cdf0;
  color: #0b1626;
}

.legend .key {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-weight: 500;
}

.legend .key .badge {
  min-width: 9px;
  height: 9px;
  padding: 0;
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

/* The research station's label: teal, like its glow; a gold note while lessons wait for a decision. */
.station {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 260px;
  padding: 2px 10px;
  border: 1px solid rgba(95, 214, 200, 0.35);
  border-radius: 3px;
  background: rgba(8, 14, 18, 0.78);
  color: #bfeee6;
  font: inherit;
  font-size: 13px;
  line-height: 17px;
  pointer-events: auto;
  cursor: pointer;
}

.station:hover {
  border-color: rgba(95, 214, 200, 0.85);
  background: rgba(14, 26, 30, 0.92);
}

.station:focus-visible {
  outline: 2px solid #5fd6c8;
  outline-offset: 1px;
}

.st-name {
  font-weight: 650;
  white-space: nowrap;
}

.st-notes {
  color: #9cc2bc;
  font-size: 11.5px;
  white-space: nowrap;
}

.station.live .st-notes {
  color: #7ff0df;
}

.station.waiting .st-notes {
  color: #f3c64e;
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

  .plate.on-sky {
    display: none;
  }

  .plate.in-dock {
    display: block;
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

  .station {
    padding: 1px 6px;
    font-size: 11.5px;
    line-height: 15px;
  }

  .st-notes {
    font-size: 11px;
  }
}
</style>
