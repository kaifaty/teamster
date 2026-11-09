<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { ArtIndex, Constellations, LogEvent, Machine, ResearchView, TaskSummary } from "../types";
import { createBoard, useNow, type Board } from "../store/board";
import { ADMIRAL_NOTE } from "../lib/accounts";
import { formatClock, formatDuration, formatUntil } from "../lib/format";
import { loadJson, saveJson } from "../lib/storage";
import { EXECUTORS, PHASES, problemLabel, shipLine, taskTitle } from "../lib/labels";
import { dataAge, errorLabel, freeItems, machineRings, statusLevel, statusText, type FreeItem, type Rings } from "../lib/machines";
import TaskPanel from "../components/TaskPanel.vue";
import frameLight from "./art/frame-light.png";
import fuelCell from "./art/fuel-cell.png";
import DaySummary from "./DaySummary.vue";
import FleetPanel, { type FleetGroup } from "./FleetPanel.vue";
import ReplayBar from "./ReplayBar.vue";
import ShipLog from "./ShipLog.vue";
import { HULL_SIZE, daysLeft, hullOf, stars, tankEmpty, tanks, untilText, type Star, type Tank } from "./fleet";
import { constellationsOf } from "./constellations";
import { placeLabels, type StarLabel } from "./declutter";
import {
  defaultCovered,
  fitCamera,
  fuelColumnRect,
  fuelPositions,
  galaxyKeepOuts,
  galaxyLayout,
  labelDrop,
  parkingOf,
  parkingOrder,
  plateAt,
  RESEARCH_LABEL_DROP,
  RESEARCH_SIZE,
  machineColumnRect,
  machineLabelAnchor,
  machinePositions,
  type MachineShape,
  researchPosition,
  starSize,
  stationAt,
  systemFrame,
  systemWorldSize,
  worldSize,
  type Camera,
  type Galaxy,
  type Insets,
  type Rect,
  type Size,
  type TankShape,
} from "./layout";
import StationView from "./station/StationView.vue";
import { isReflection, research, shortDate } from "./research";
import { PLACES, placement, systemTasks, type Place, type Placement } from "./placement";
import { replayExits, replayFleet } from "./replay";
import { RINGS } from "./palette";
import { FLIGHT_SECONDS, createFleetScene, type FleetScene, type MachineMark, type ShipEntry, type TankMark } from "./scene";
import { useReplay } from "./useReplay";

/** `machine`: the machine whose card is open over the map, or null. */
const props = defineProps<{ board: Board; active: boolean; machine?: string | null }>();
/**
 * `machine`: a machine's reactor was clicked, with the label to give the focus back to; `panel`: the map opened a
 * task's card or the science station's screen, which replace the machine's card.
 */
const emit = defineEmits<{ board: []; machine: [id: string, opener: HTMLElement | null]; panel: [] }>();

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
// What the reflection learned. Runs of the reflection are the science station's own work, not a system's.
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

// Galaxy: one star per repository, one fuel tank per subscription. Null means the whole galaxy is shown.
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
/** The same value while it does not change, so that the galaxy is not redrawn at every tick of the clock. */
function steady<T>(read: () => T): () => T {
  let last: T | undefined;
  let text = "";
  return () => {
    const next = read();
    const json = JSON.stringify(next);
    if (last !== undefined && json === text) return last;
    last = next;
    text = json;
    return next;
  };
}
// The tanks stay live in a replay: the accounts' past is not recorded.
const tankList = computed(steady(() => tanks(source.value.state.value.accounts?.data ?? null, now.value)));
/** A tank's second line: what is left, or why nothing is, and in how long it refills. */
function tankInfo(tank: Tank): string {
  const left = tank.bad ? (tank.status ?? "пусто") : tank.fuel !== null ? `${tank.fuel}%` : (tank.status ?? "нет данных");
  const until = untilText(tank.refillAt, now.value);
  return until ? `${left} · ↻ ${until}` : left;
}
const tankShapes = computed(
  steady<TankShape[]>(() =>
    tankList.value.map((tank) => ({ key: tank.key, executor: tank.executor, name: tank.name, info: tankInfo(tank), resets: Math.min(tank.resets?.count ?? 0, MAX_CELLS) })),
  ),
);
const tankMarks = computed(
  steady<TankMark[]>(() =>
    tankList.value.map((tank) => {
      const lamps = daysLeft(tank.refillAt, now.value);
      return { key: tank.key, executor: tank.executor, fuel: tank.fuel, low: tankEmpty(tank), bad: tank.bad, admiral: tank.admiral, lamps, soon: lamps === 1 };
    }),
  ),
);
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
// Constellations: repositories the galaxy draws together, from a file the server reads. Looked up again whenever the map
// comes back, like the art.
const constellationData = shallowRef<Constellations | null>(null);
async function loadConstellations() {
  const from = source.value.source;
  const data = await from.fetchConstellations().catch(() => constellationData.value);
  if (from === source.value.source && JSON.stringify(data) !== JSON.stringify(constellationData.value)) constellationData.value = data;
}
watch(source, loadConstellations, { immediate: true });
const constellationList = computed(steady(() => constellationsOf(constellationData.value, starList.value.map((star) => star.repo))));
/** Which constellation each repository is in. */
const memberOf = computed(() => new Map(constellationList.value.flatMap((item) => item.repos.map((name) => [name, item.name] as const))));
/** The system picker's choices, a group for each constellation and the rest after them. */
const pickerGroups = computed(() => {
  const byRepo = new Map(starList.value.map((star) => [star.repo, star]));
  const grouped = constellationList.value.map((item) => ({ name: item.name, stars: item.repos.flatMap((name) => byRepo.get(name) ?? []) }));
  const rest = starList.value.filter((star) => !memberOf.value.has(star.repo));
  return { grouped, rest };
});
const emblemOf = (name: string | null) => (name ? (repoArt.value[name]?.emblem ?? null) : null);
const hideImage = (event: Event) => {
  (event.target as HTMLElement).hidden = true;
};

const station = computed(() => research(researchView.value, allTasks.value, starList.value.map((star) => star.repo)));
const researchMarks = computed(() =>
  station.value
    ? {
        running: station.value.running,
        proposed: station.value.proposed.length,
        waiting: station.value.waiting,
        probes: station.value.probes,
        at: stationPoint.value,
      }
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

/** The galaxy's world and the open system's, as the scene lays them out for the window. */
const world = ref<Size>(worldSize({ width: 1600, height: 1000 }));
const systemWorld = ref<Size>(systemWorldSize({ width: 1600, height: 1000 }));

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
      // A ship back from the inspection tells how many findings it fixes, as its red marks do.
      const phase = task.phase === "fix" && task.findings_left > 0 ? `${PHASES.fix} · ${task.findings_left} замеч.` : PHASES[task.phase];
      return ticking ? `${phase} · ${formatDuration(mapNow.value - task.phase_started_at!)}` : phase;
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

/** Where a label stands in the world; the camera's --tx, --ty and --zoom on the overlay turn it into pixels. */
const at = (x: number, y: number) => ({ "--x": Math.round(x), "--y": Math.round(y) });

// Machines stand as reactors along the right edge. They are the board's own and stay live in a replay and a
// scenario: the machines' past is not recorded.
const machinesData = computed(() => props.board.state.value.machines ?? null);
const machineMarks = computed(
  steady<MachineMark[]>(() => (machinesData.value?.items ?? []).map((machine) => ({ id: machine.id, status: machine.status, rings: machineRings(machine.metrics) }))),
);
/** What a machine's label tells under its name: what is free, ring by ring; why nothing is known when it is offline. */
function freeOf(machine: Machine): FreeItem[] {
  return machine.status === "offline" || machine.status === "unknown" ? [] : freeItems(machine.metrics);
}
const machineNote = computed(() => machinesData.value?.config_error || null);
// What the labels show, so that the column knows their sizes; the same list while it does not change.
let lastShapes: MachineShape[] = [];
const machineShapes = computed(() => {
  const next = (machinesData.value?.items ?? []).map((machine) => {
    const free = freeOf(machine);
    // A dot before each free resource counts as one character of the line.
    return { id: machine.id, name: machine.name, status: free.length ? free.map((item) => `● ${item.text}`).join(" ") : statusText(machine) };
  });
  if (JSON.stringify(next) === JSON.stringify(lastShapes)) return lastShapes;
  lastShapes = next;
  return next;
});

/** The parts of the world under the map's own panels, measured for the window; the log's corner until then. */
const covered = shallowRef<Rect[] | null>(null);
/** The zoom of the full view in this window, at which the labels' room is reserved. */
const fullZoom = ref<number | undefined>(undefined);
const coveredNow = computed(() => covered.value ?? defaultCovered(world.value));
/** The subscriptions' tanks: a column on the left, a row on top of a phone's galaxy; null without subscriptions. */
const fuelColumn = computed(() => (tankShapes.value.length ? fuelPositions(tankShapes.value, world.value, fullZoom.value, coveredNow.value) : null));
/** The machines' column; null without machines and without a broken config, and then it takes no room. */
const machineColumn = computed(() => {
  if (!machineShapes.value.length && !machineNote.value) return null;
  // On a phone the tanks' row runs along the top, under the toolbar: the column starts below it, as below the toolbar.
  const fuel = fuelColumn.value?.row ? fuelColumnRect(fuelColumn.value) : null;
  return machinePositions(machineShapes.value, world.value, fullZoom.value, !!machineNote.value, fuel ? [...coveredNow.value, { ...fuel, y0: 0 }] : coveredNow.value);
});
/** Where the science station stands: in the galaxy's lower right corner, see researchPosition. */
const stationPoint = computed(() => researchPosition(world.value, coveredNow.value, machineColumn.value, fuelColumn.value));
let previousGalaxy: Galaxy | null = null;
const galaxy = computed(() => {
  const blocked = galaxyKeepOuts(world.value, coveredNow.value, machineColumn.value, fuelColumn.value);
  // The stars keep their places from the last layout while they fit there.
  const next = galaxyLayout(starList.value, world.value, blocked, previousGalaxy, fullZoom.value, memberOf.value);
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

/**
 * A constellation's name beside its stars, centred on them: above them, or else below, left or right of them, on the
 * first side where it meets neither the science station nor the columns and panels, nor leaves the world.
 */
const constellationLabels = computed(() => {
  const layout = galaxy.value;
  const station = stationPoint.value;
  const keepOuts = [
    { x0: station.x - RESEARCH_SIZE / 2 - 20, y0: station.y - RESEARCH_SIZE / 2 - 20, x1: station.x + RESEARCH_SIZE / 2 + 20, y1: station.y + RESEARCH_SIZE / 2 + RESEARCH_LABEL_DROP + 50 },
    ...coveredNow.value,
    ...[machineColumn.value ? machineColumnRect(machineColumn.value) : null, fuelColumn.value ? fuelColumnRect(fuelColumn.value) : null].filter((rect): rect is Rect => !!rect),
  ];
  return constellationList.value.flatMap((item) => {
    const points = item.repos.flatMap((name) => layout.places.get(name) ?? []);
    if (!points.length) return [];
    const width = (item.name.length * 12 + 8) / layout.labelZoom;
    const height = 18 / layout.labelZoom;
    const x0 = Math.min(...points.map((point) => point.x));
    const x1 = Math.max(...points.map((point) => point.x));
    const y0 = Math.min(...points.map((point) => point.y));
    const y1 = Math.max(...points.map((point) => point.y));
    const middle = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    const gap = layout.spacing * 0.6;
    // The label's middle on each side, and its box there.
    const sides = [
      { side: "above", x: middle.x, y: y0 - gap - height / 2 },
      { side: "below", x: middle.x, y: y1 + gap + height / 2 + 20 / layout.labelZoom },
      { side: "left", x: x0 - gap - width / 2, y: middle.y },
      { side: "right", x: x1 + gap + width / 2, y: middle.y },
    ] as const;
    const open = (spot: { x: number; y: number }) => {
      const box = { x0: spot.x - width / 2, y0: spot.y - height / 2, x1: spot.x + width / 2, y1: spot.y + height / 2 };
      const inside = box.x0 >= 0 && box.y0 >= 0 && box.x1 <= world.value.width && box.y1 <= world.value.height;
      return inside && !keepOuts.some((rect) => box.x0 < rect.x1 && rect.x0 < box.x1 && box.y0 < rect.y1 && rect.y0 < box.y1);
    };
    const spot = sides.find(open) ?? sides[0];
    return [{ name: item.name, style: { ...at(spot.x, spot.y), color: item.color } }];
  });
});

const stationLabel = computed(() => {
  const marks = station.value;
  if (!marks) return null;
  const point = stationPoint.value;
  const last = marks.batch ? `разбор ${shortDate(marks.batch.date)}` : "разборов не было";
  const proposed = marks.proposed.length;
  const asks = marks.waiting;
  // One note under the name, the most pressing one; the station's screen has the rest. A question waits on the human
  // before anything else.
  const note = asks ? `ждёт ответа ${asks}` : marks.running ? "идёт разбор" : proposed ? `ждут решения ${proposed}` : last;
  const title = [
    marks.running ? "идёт разбор" : last,
    ...(asks ? [`ждут ответа ${asks}`] : []),
    `ждут решения ${proposed}`,
    `с сигналом ${marks.pending.signals} из ${marks.pending.records}`,
  ].join("\n");
  return {
    style: at(point.x, point.y + RESEARCH_LABEL_DROP),
    note,
    title,
    running: marks.running && !asks,
    waiting: asks > 0 || (!marks.running && proposed > 0),
  };
});

/** A label shows at most this many spare cells, one per free reset; the title has the count. */
const MAX_CELLS = 4;
/** Everything a tank knows, for its label's title. */
function tankTitle(tank: Tank): string {
  const at = (time: number) => `${formatClock(time, now.value)} (${formatUntil(time, now.value)})`;
  const resets = tank.resets;
  return [
    `${tank.name} · ${tank.executor === "codex" ? "Codex" : "Claude"}`,
    tank.admiral ? ADMIRAL_NOTE : null,
    tank.fuel !== null ? `Неделя: осталось ${tank.fuel}%` : "Неделя: нет данных",
    tank.status ? `Состояние: ${tank.status}` : null,
    tank.refillAt !== null ? `${tank.bad ? "Заправка" : "Сброс недели"}: ${at(tank.refillAt)}` : null,
    tank.burst ? `5 часов: занято ${Math.round(tank.burst.percent)}%${tank.burst.resetsAt !== null ? `, сброс ${formatClock(tank.burst.resetsAt, now.value)}` : ""}` : null,
    resets ? `Бесплатных сбросов: ${resets.count}${resets.expires.length ? ` · сгорают ${resets.expires.map((time) => formatClock(time, now.value)).join(", ")}` : ""}` : null,
    "Лампы у бака: дни до сброса",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A tank's label, on the right of its tank or under it in a row: its name, what is left and when it refills. */
const tankLabels = computed(() => {
  const column = fuelColumn.value;
  if (!column) return [];
  return tankList.value.flatMap((tank) => {
    const anchor = column.anchors.get(tank.key);
    const size = column.labels.get(tank.key);
    if (!anchor || !size) return [];
    return [{
      tank,
      info: tankInfo(tank),
      cells: Math.min(tank.resets?.count ?? 0, MAX_CELLS),
      low: tankEmpty(tank),
      row: column.row,
      title: tankTitle(tank),
      style: { ...at(anchor.x, anchor.y), maxWidth: `${size.width}px` },
    }];
  });
});

const machineLabels = computed(() => {
  const column = machineColumn.value;
  if (!column) return [];
  return (machinesData.value?.items ?? []).flatMap((machine) => {
    const anchor = machineLabelAnchor(machine.id, column);
    if (!anchor) return [];
    const status = statusText(machine);
    // A failed probe that has not yet made the machine offline, and data that is not fresh: in the title, as the card has them.
    const mark = machine.error && machine.status !== "offline" ? `⚠ ${errorLabel(machine.error)}` : null;
    const extra = [mark, dataAge(machine, now.value)].filter(Boolean).join(" · ") || null;
    const rings = machineRings(machine.metrics);
    const free = freeOf(machine).map((item) => ({ ...item, color: RINGS[item.key], level: ringLevel(rings, item.key) }));
    return [{
      machine,
      status,
      free,
      level: statusLevel(machine.status) ?? "muted",
      showStatus: column.status,
      title: [machine.role ? `${machine.name} · ${machine.role}` : machine.name, status, freeTitle(free), RING_NOTE, extra].filter(Boolean).join("\n"),
      style: at(anchor.x, anchor.y),
    }];
  });
});
/** How pressing the ring of a free resource is, for the colour of its figure: none when calm. */
function ringLevel(rings: Rings, key: FreeItem["key"]): "warn" | "bad" | null {
  const level = rings[key]?.level;
  return level === "warn" || level === "bad" ? level : null;
}
/** "Свободно: 28 ядер, памяти 24 ГБ, видеопамяти 8 ГБ" for a label's title. */
function freeTitle(free: readonly FreeItem[]): string | null {
  if (!free.length) return null;
  const words: Record<FreeItem["key"], (text: string) => string> = {
    cpu: (text) => text,
    memory: (text) => `памяти ${text}`,
    gpu: (text) => (text.endsWith("%") ? `GPU ${text}` : `видеопамяти ${text}`),
  };
  return `Свободно: ${free.map((item) => words[item.key](item.text)).join(", ")}`;
}
const RING_NOTE = "Кольца снаружи внутрь: CPU, память, GPU; дуга — занято";

const machineNoteStyle = computed(() => {
  const note = machineColumn.value?.note;
  return note ? at(note.x, note.y) : null;
});

function openMachine(id: string, opener: HTMLElement | null) {
  emit("machine", id, opener);
}

function openMachineAt(id: string) {
  const label = overlay.value?.querySelector<HTMLElement>(`[data-machine="${CSS.escape(id)}"] button`) ?? null;
  openMachine(id, label);
}

/** The open system's ships by station, in the order they park: for the list at the side. */
const groups = computed<FleetGroup[]>(() =>
  PLACES.map((place) => {
    const here = entries.value.filter((entry) => entry.placement.place === place);
    const ships = parkingOrder(here, (entry) => ({ slug: entry.task.slug, ...entry.placement }), place, null).map(({ task, placement: where }) => ({
      slug: task.slug,
      executor: task.executor,
      name: taskTitle(task),
      phase: phaseText(task),
      beacon: where.beacon,
      title: [taskTitle(task), phaseText(task), `${EXECUTORS[task.executor]}${task.account ? ` · ${task.account}` : ""}`, activityLine(task, where)].join("\n"),
    }));
    return { place, ...STATION_TEXT[place], ships };
  }).filter((group) => group.ships.length),
);

/**
 * The stations' names on the map, and the count of the ships each one has no berth for: they park as the scene parks
 * them, see parkingOf.
 */
const plates = computed(() => {
  const frame = systemFrame(systemWorld.value);
  return PLACES.map((place) => {
    const here = entries.value.filter((entry) => entry.placement.place === place);
    const order = parkingOrder(here, (entry) => ({ slug: entry.task.slug, ...entry.placement }), place, selected.value);
    const parking = parkingOf(place, order.map((entry) => HULL_SIZE[hullOf(entry.task)]), frame);
    const station = stationAt(place, frame);
    const plate = plateAt(place, frame);
    const waiting = order.slice(parking.berths.length);
    const count = parking.count && {
      ships: parking.count.ships,
      style: at(station.x + parking.count.at.x, station.y + parking.count.at.y),
      title: [`Ещё ${parking.count.ships}:`, ...waiting.map((entry) => taskTitle(entry.task))].join("\n"),
      hovered: waiting.some((entry) => entry.task.slug === hovered.value),
    };
    return { place, text: STATION_TEXT[place], side: plate.side, style: at(plate.x, plate.y), count };
  });
});

const hidden = computed(() => ({ count: system.value.hidden.length, title: system.value.hidden.map(taskTitle).join("\n") }));

// Panel -------------------------------------------------------------------------------------------

const selected = ref<string | null>(null);
const hovered = ref<string | null>(null);
const selectedTask = computed(() => (selected.value ? (source.value.state.value.tasks[selected.value] ?? null) : null));

/** A task's card; over the station's screen it stands on top, and closing it returns there. */
function open(slug: string) {
  selected.value = slug;
  emit("panel");
}

function openResearch() {
  selected.value = null;
  researchOpen.value = true;
  emit("panel");
}

// A machine's card and the map's own panels replace each other, as on the board.
watch(
  () => props.machine,
  (id) => {
    if (!id) return;
    selected.value = null;
    researchOpen.value = false;
  },
);

function closeResearch() {
  researchOpen.value = false;
  void nextTick(() => overlay.value?.querySelector<HTMLElement>(".station")?.focus());
}

function close() {
  const slug = selected.value;
  selected.value = null;
  if (researchOpen.value) {
    void nextTick(() => document.querySelector<HTMLElement>(".station-screen .back")?.focus());
    return;
  }
  void nextTick(() => {
    const row = slug ? host.value?.querySelector<HTMLElement>(`.fleet [data-ship="${CSS.escape(slug)}"]`) : null;
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
  if (event.key === "Escape" && props.active && repo.value && !selected.value && !researchOpen.value && !props.machine) leave();
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
  const obstacles = [...root.querySelectorAll<HTMLElement>(".toolbar, .dock, .overlay .station, .overlay .tank, .overlay .machine, .overlay .machine-note, .overlay .constellation")]
    .filter((el) => el.offsetParent !== null)
    .map((el) => relative(el.getBoundingClientRect()));
  // The machines' stations and the tanks are drawn on the canvas: each whole column keeps the labels off, the gaps between
  // its rows too, so that no star's label stands across a station's wings or a tank's lamps.
  const column = machineColumn.value;
  const fuel = fuelColumn.value;
  for (const rect of [column ? machineColumnRect(column) : null, fuel ? fuelColumnRect(fuel) : null]) {
    if (!rect) continue;
    obstacles.push({
      x0: camera.tx + rect.x0 * camera.zoom,
      y0: camera.ty + rect.y0 * camera.zoom,
      x1: camera.tx + rect.x1 * camera.zoom,
      y1: camera.ty + rect.y1 * camera.zoom,
    });
  }
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
// The machines', the tanks' and the constellations' labels are obstacles for the stars' ones.
watch([machineLabels, machineNoteStyle, tankLabels, constellationLabels], () => void nextTick(scheduleLabels), { flush: "post" });
watch(hoveredStar, scheduleLabels);

// The dock ------------------------------------------------------------------------------------------

/** A phone-sized window, as the `@media (max-width: 760px)` rules see it: the dock folds there to one line. */
const narrowQuery = matchMedia("(max-width: 760px)");
const narrow = ref(narrowQuery.matches);
const onNarrow = (event: MediaQueryListEvent) => {
  narrow.value = event.matches;
};
/** On a wide window the replay's scale shows or hides as the viewer last chose. */
const REPLAY_KEY = "codex-board.replay-shown.v1";
const replayShown = ref(loadJson(REPLAY_KEY, true, (v): v is boolean => typeof v === "boolean"));
watch(replayShown, (value) => saveJson(REPLAY_KEY, value));
/**
 * The dock folds to one line on a narrow window, and in a star system, where the map needs the room: the replay's scale
 * and the whole log then open over the map on demand.
 */
const compactDock = computed(() => narrow.value || repo.value !== null);
const replayOpen = ref(false);
const logOpen = ref(false);
const replayVisible = computed(() => (compactDock.value ? replayOpen.value : replayShown.value));
function toggleReplay() {
  if (compactDock.value) replayOpen.value = !replayOpen.value;
  else replayShown.value = !replayShown.value;
}
const dockFolded = computed(() => !compactDock.value || (!replayOpen.value && !logOpen.value));
// On a wide window the scale is part of the dock's shape: hidden, it leaves its corner to the stars.
watch(replayShown, () => {
  if (compactDock.value) return;
  coveredFor = "";
  void nextTick(() => {
    measureCovered();
    scheduleLabels();
  });
});
// The dock changes its shape across the breakpoint and between the galaxy and a system: it folds and is measured again.
watch(compactDock, () => {
  replayOpen.value = false;
  logOpen.value = false;
});
watch([narrow, repo], () => {
  coveredFor = "";
  void nextTick(() => {
    measureCovered();
    measureInsets();
  });
});
// The open dock covers the map. Once it folds, a resize made meanwhile is measured and the star labels come back.
watch(dockFolded, (folded) => {
  if (!folded) return;
  void nextTick(() => {
    measureCovered();
    measureInsets();
    scheduleLabels();
  });
});

// The ships' list -------------------------------------------------------------------------------------

/** On a wide window the list stands at the side of a system as the viewer last chose; on a narrow one it opens over it. */
const FLEET_KEY = "codex-board.fleet-shown.v1";
const fleetShown = ref(loadJson(FLEET_KEY, true, (v): v is boolean => typeof v === "boolean"));
watch(fleetShown, (value) => saveJson(FLEET_KEY, value));
const fleetOpen = ref(false);
const fleetVisible = computed(() => repo.value !== null && (narrow.value ? fleetOpen.value : fleetShown.value));
watch([narrow, repo], () => {
  fleetOpen.value = false;
});
function toggleFleet() {
  if (narrow.value) fleetOpen.value = !fleetOpen.value;
  else fleetShown.value = !fleetShown.value;
}
const fleetPanel = ref<InstanceType<typeof FleetPanel> | null>(null);
/** The count at a station was pressed: the list opens at that station. */
function showStation(place: Place) {
  if (narrow.value) fleetOpen.value = true;
  else fleetShown.value = true;
  void nextTick(() => fleetPanel.value?.reveal(place));
}
watch(fleetVisible, () => void nextTick(measureInsets));

/**
 * Measures the parts of the window the panels cover, for the scene to lay a system out in the rest: the toolbar, the
 * list at the side and the folded dock. What opens over the map does not move the system.
 */
let insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
function measureInsets() {
  const stage = host.value?.getBoundingClientRect();
  const root = host.value?.closest(".map");
  if (!stage || !root || !stage.width || !stage.height) return;
  const toolbar = root.querySelector<HTMLElement>(".toolbar")?.getBoundingClientRect();
  const top = toolbar ? Math.max(0, Math.round(toolbar.bottom - stage.top + 6)) : 0;
  host.value!.style.setProperty("--below-toolbar", `${top}px`);
  if (!repo.value) return;
  const panel = fleetVisible.value && !narrow.value ? root.querySelector<HTMLElement>(".fleet")?.getBoundingClientRect() : null;
  const dock = dockFolded.value ? root.querySelector<HTMLElement>(".dock")?.getBoundingClientRect() : null;
  insets = {
    top,
    right: panel ? Math.max(0, Math.round(stage.right - panel.left + 6)) : 0,
    bottom: dock ? Math.max(0, Math.round(stage.bottom - dock.top + 6)) : insets.bottom,
    left: 0,
  };
  scene?.setInsets(insets);
}

/**
 * Measures, for the window, the part of the world under the ship's log, where no star stands, and the full view's zoom.
 * A narrow dock is measured folded: what opens over the map does not move the stars. The galaxy's dock is measured
 * only while the galaxy shows: a system folds it.
 */
let coveredFor = "";
function measureCovered() {
  if (!dockFolded.value || repo.value) return;
  const stage = host.value?.getBoundingClientRect();
  const dock = host.value?.querySelector<HTMLElement>(".dock")?.getBoundingClientRect();
  const toolbar = host.value?.closest(".map")?.querySelector<HTMLElement>(".toolbar")?.getBoundingClientRect();
  if (!stage || !dock || !stage.width || !stage.height) return;
  const key = `${Math.round(stage.width)}x${Math.round(stage.height)}/${world.value.width}/${Math.round(toolbar?.bottom ?? 0)}`;
  if (key === coveredFor) return;
  coveredFor = key;
  const fit = fitCamera(world.value, { width: stage.width, height: stage.height });
  const margin = 12;
  const toWorld = (x: number, y: number) => ({ x: (x - stage.left - fit.tx) / fit.zoom, y: (y - stage.top - fit.ty) / fit.zoom });
  const from = toWorld(dock.left - margin, dock.top - margin);
  const to = toWorld(dock.right + margin, dock.bottom + margin);
  const parts: Rect[] = [{ x0: from.x, y0: from.y, x1: to.x, y1: Math.max(to.y, world.value.height) }];
  // The toolbar runs along the top: the columns at the edges start under it.
  if (toolbar) parts.push({ x0: 0, y0: 0, x1: world.value.width, y1: Math.max(0, toWorld(0, toolbar.bottom + margin).y) });
  covered.value = parts;
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
  measureInsets();
  scene.setGalaxy(galaxyModel());
  scene.setArt(repoArt.value);
  scene.setView(repo.value);
  setShips(entries.value);
  scene.setSelected(selected.value);
  scene.setMachine(props.machine ?? null);
  scene.setHovered(hovered.value);
  scene.setActive(props.active && !researchOpen.value);
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
      onMachine: openMachineAt,
      onHover: (slug) => {
        hovered.value = slug;
      },
      onHoverStar: (name) => {
        hoveredStar.value = name;
      },
      onCamera: (worlds, camera) => {
        if (worlds.galaxy.width !== world.value.width || worlds.galaxy.height !== world.value.height) world.value = worlds.galaxy;
        if (worlds.system.width !== systemWorld.value.width || worlds.system.height !== systemWorld.value.height) systemWorld.value = worlds.system;
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
  return {
    stars: starList.value,
    layout: galaxy.value,
    tanks: tankMarks.value,
    fuel: fuelColumn.value,
    constellations: constellationList.value,
    research: researchMarks.value,
    machines: machineMarks.value,
    machineColumn: machineColumn.value,
  };
}
watch([starList, galaxy, tankMarks, fuelColumn, constellationList, researchMarks, machineMarks, machineColumn], () => scene?.setGalaxy(galaxyModel()));
watch(() => props.machine, (id) => scene?.setMachine(id ?? null));
watch(repoArt, (art) => scene?.setArt(art));
// The station's screen covers the whole map: the galaxy under it stops drawing until it closes.
watch(researchOpen, (open) => scene?.setActive(props.active && !open));
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
      void loadConstellations();
      void loadResearch();
    }
    scene?.setActive(active && !researchOpen.value);
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
    stageObserver = new ResizeObserver(() => {
      measureCovered();
      measureInsets();
    });
    stageObserver.observe(host.value);
    // The toolbar wraps on a narrower window: the list and a system start below it.
    const toolbar = host.value.closest(".map")?.querySelector(".toolbar");
    if (toolbar) stageObserver.observe(toolbar);
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
          <optgroup v-for="group in pickerGroups.grouped" :key="group.name" :label="group.name">
            <option v-for="star in group.stars" :key="star.repo" :value="star.repo">{{ star.repo }} · {{ star.live }}</option>
          </optgroup>
          <option v-for="star in pickerGroups.rest" :key="star.repo" :value="star.repo">{{ star.repo }} · {{ star.live }}</option>
        </select>
      </label>
      <div v-if="demo" class="seg" role="group" aria-label="Источник карты">
        <button type="button" class="btn" :aria-pressed="sourceKind === 'board'" @click="sourceKind = 'board'">Доска</button>
        <button type="button" class="btn" :aria-pressed="sourceKind === 'scenario'" @click="sourceKind = 'scenario'">Сценарий</button>
      </div>
      <button ref="summaryButton" type="button" class="btn" :aria-expanded="summaryOpen" @click="summaryOpen = true">Сводка дня</button>
      <button
        v-if="repo"
        type="button"
        class="btn"
        :aria-expanded="fleetVisible"
        aria-controls="fleet-panel"
        :title="fleetVisible ? 'Скрыть список кораблей' : 'Показать список кораблей'"
        @click="toggleFleet"
      >
        Корабли · {{ entries.length }}
      </button>
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
            <span class="st-name">Научная станция</span>
            <span class="st-notes">{{ stationLabel.note }}</span>
          </button>
          <div
            v-for="label in machineLabels"
            :key="label.machine.id"
            class="machine"
            :class="{ open: machine === label.machine.id }"
            :style="label.style"
            :data-machine="label.machine.id"
          >
            <button
              type="button"
              class="m-label"
              :class="label.machine.status"
              :title="label.title"
              :aria-pressed="machine === label.machine.id"
              @click="openMachine(label.machine.id, $event.currentTarget as HTMLElement)"
            >
              <span class="m-name">{{ label.machine.name }}</span>
              <span v-if="label.showStatus && label.free.length" class="m-free num">
                <span v-for="item in label.free" :key="item.key" class="m-item" :class="item.level"><i class="m-dot" :style="{ background: item.color }" aria-hidden="true" />{{ item.text }}</span>
              </span>
              <span v-else-if="label.showStatus" class="m-status" :class="label.level">{{ label.status }}</span>
            </button>
          </div>
          <p v-if="machineNoteStyle" class="machine-note" :style="machineNoteStyle" :title="machineNote ?? ''">
            Конфиг машин не прочитан: {{ machineNote }}
          </p>
          <span v-for="label in constellationLabels" :key="label.name" class="constellation" :style="label.style" aria-hidden="true">{{ label.name }}</span>
          <div
            v-for="label in tankLabels"
            :key="label.tank.key"
            class="tank"
            :class="[label.tank.executor, { row: label.row, low: label.low, admiral: label.tank.admiral }]"
            :style="label.style"
            :title="label.title"
          >
            <span class="t-name"><span class="glyph" aria-hidden="true">{{ label.tank.executor === "codex" ? "◆" : "✳" }}</span>{{ label.tank.name }}</span>
            <span class="t-info num">
              <span class="t-text">{{ label.info }}</span>
              <img v-for="cell in label.cells" :key="cell" class="cell" :src="fuelCell" alt="" />
              <span v-if="label.cells" class="visually-hidden">, бесплатных сбросов {{ label.cells }}</span>
              <span v-if="label.tank.admiral" class="visually-hidden">, адмирал</span>
            </span>
          </div>
        </template>
        <template v-else>
          <template v-for="plate in plates" :key="plate.place">
            <span class="plate-st" :class="plate.side" :style="plate.style">{{ plate.text.name }}<span> · {{ plate.text.note }}</span></span>
            <button
              v-if="plate.count"
              type="button"
              class="count"
              :class="{ hovered: plate.count.hovered }"
              :style="plate.count.style"
              :title="plate.count.title"
              :aria-label="`${plate.text.name}: ещё ${plate.count.ships}, показать в списке`"
              @click="showStation(plate.place)"
            >
              +{{ plate.count.ships }}
            </button>
          </template>
        </template>
      </div>
      <FleetPanel
        v-if="fleetVisible"
        ref="fleetPanel"
        :groups="groups"
        :total="entries.length"
        :hidden="hidden"
        :selected="selected"
        :hovered="hovered"
        :frame="frameLight"
        @pick="open"
        @hover="hovered = $event"
        @close="toggleFleet"
      />
      <div class="dock">
        <p v-if="replayTime" class="plate in-dock num" aria-hidden="true">Перемотка · {{ replayTime }}</p>
        <ReplayBar v-show="replayVisible" id="replay-scale" :replay="replay" :frame="frameLight" :now="now" />
        <ShipLog
          v-model:open="logOpen"
          :events="logEvents"
          :error="replay.at === null ? eventsError : replay.error"
          :repo="repo"
          :frame="frameLight"
          :systems="systemNames"
          :emblem-of="emblemOf"
          :at="replay.at"
          :compact="compactDock"
          @go="goTo"
          @seek="seekTo"
        >
          <template #head>
            <button
              type="button"
              class="dock-replay"
              :class="{ on: replay.active }"
              aria-controls="replay-scale"
              :aria-expanded="replayVisible"
              aria-label="Перемотка дня"
              :title="replayVisible ? 'Скрыть перемотку дня' : 'Показать перемотку дня'"
              @click="toggleReplay"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
                <path d="M1 6.4l1.5 1.8L4 6.4" />
                <path d="M8 5v3.2l2.2 1.4" />
              </svg>
            </button>
            <!-- The way back to the live map while the scale with its own button is hidden. -->
            <button v-if="replay.active && !replayVisible" type="button" class="dock-live" @click="replay.live()">В эфир</button>
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

    <StationView
      v-if="researchOpen && active && station"
      :research="station"
      :now="now"
      :frame="frameLight"
      :covered="!!selected || !!machine"
      @close="closeResearch"
      @open="open"
    />
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

/* At the head of the log: the button that shows or hides the replay's scale, and the way back to the live map. */
.dock-replay,
.dock-live {
  flex: none;
  align-self: center;
  box-sizing: border-box;
  height: 22px;
  margin: 0;
  border: 1px solid rgba(214, 170, 96, 0.35);
  border-radius: 2px;
  background: rgba(20, 22, 28, 0.9);
  color: #b8ad98;
  cursor: pointer;
}

.dock-replay {
  display: inline-grid;
  place-items: center;
  width: 22px;
  padding: 0;
}

.dock-replay:hover,
.dock-live:hover {
  border-color: rgba(243, 198, 78, 0.8);
}

.dock-replay.on {
  color: #f3c64e;
}

.dock-replay[aria-expanded="true"] {
  border-color: rgba(243, 198, 78, 0.9);
  background: rgba(243, 198, 78, 0.22);
  color: #f3c64e;
}

.dock-live {
  padding: 0 6px;
  border-color: rgba(255, 141, 122, 0.7);
  color: #ffb3a3;
  font: inherit;
  font-size: 11.5px;
}

.dock-replay:focus-visible,
.dock-live:focus-visible {
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
.constellation,
.tank,
.machine,
.machine-note,
.plate-st,
.count {
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

.star:focus-visible {
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

/* The science station's label: teal, like its glow; a gold note while lessons wait for a decision. */
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

/*
 * A machine's label on the left of its reactor, at the height of its centre. The status takes the board's level
 * colours at their dark values: the sky is dark in both themes. The line about a broken config stands over the column.
 */
.machine,
.machine-note {
  --ok: #5fc48c;
  --warn: #e0b04f;
  --bad: #f07f76;
  --muted: #9aa3b0;
  transform: translateX(-100%);
}

.machine {
  transform: translate(-100%, -50%);
}

.m-label {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  box-sizing: border-box;
  max-width: 180px;
  margin: 0;
  padding: 1px 7px;
  border: 1px solid rgba(214, 170, 96, 0.28);
  border-radius: 3px;
  background: rgba(8, 11, 18, 0.8);
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  line-height: 14px;
  text-align: right;
  white-space: nowrap;
  pointer-events: auto;
  cursor: pointer;
}

.m-label:hover {
  border-color: rgba(243, 198, 78, 0.8);
  background: rgba(26, 28, 34, 0.92);
}

.m-label:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.machine.open .m-label {
  border-color: #ffffff;
  background: rgba(26, 28, 34, 0.92);
}

.m-label.overloaded {
  border-color: rgba(255, 141, 122, 0.55);
}

.m-label.unknown {
  opacity: 0.8;
}

.m-name,
.m-status {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.m-name {
  font-size: 12px;
  font-weight: 650;
  line-height: 15px;
}

.m-status.ok {
  color: var(--ok);
}

.m-status.warn {
  color: var(--warn);
}

.m-status.bad {
  color: var(--bad);
}

.m-status.muted {
  color: var(--muted);
}

/* What is free on the machine, each figure after a dot of its ring's colour; gold or red while its ring is pressed. */
.m-free {
  display: flex;
  gap: 7px;
  max-width: 100%;
  overflow: hidden;
  color: #c9c1b0;
}

.m-item {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
}

.m-item.warn {
  color: var(--warn);
}

.m-item.bad {
  color: var(--bad);
}

.m-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.machine-note {
  max-width: 280px;
  margin: 0;
  overflow: hidden;
  color: var(--bad);
  font-size: 11.5px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow:
    0 0 3px #05070d,
    0 0 2px #05070d;
  pointer-events: auto;
}

/* A constellation's name over its stars, in the colour of its cloud: quiet, under the stars' labels. */
.constellation {
  transform: translate(-50%, -50%);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.32em;
  line-height: 16px;
  text-transform: uppercase;
  white-space: nowrap;
  opacity: 0.8;
  text-shadow:
    0 0 4px #05070d,
    0 0 2px #05070d;
}

/*
 * A tank's label on the right of its tank, at the height of its centre; under it in a row on a phone. The admiral's is
 * gold, like the badge on its tank; an empty tank's second line is red.
 */
.tank {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  max-width: 150px;
  padding: 1px 7px;
  border: 1px solid rgba(214, 170, 96, 0.28);
  border-radius: 3px;
  background: rgba(8, 11, 18, 0.8);
  font-size: 11.5px;
  line-height: 14px;
  white-space: nowrap;
  transform: translateY(-50%);
  pointer-events: auto;
  cursor: help;
}

.tank.row {
  align-items: center;
  transform: translateX(-50%);
}

.tank.admiral {
  border-color: rgba(243, 198, 78, 0.75);
}

.t-name,
.t-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.t-name {
  max-width: 100%;
  font-size: 12px;
  font-weight: 650;
  line-height: 15px;
}

.tank.admiral .t-name {
  color: #f3c64e;
}

.tank .glyph {
  display: inline-block;
  width: 12px;
}

.tank.codex .glyph {
  color: #7ea6f5;
}

.tank.claude .glyph {
  color: #e59472;
}

.t-info {
  display: flex;
  align-items: center;
  max-width: 100%;
  color: #b8ad98;
}

.tank.low .t-text {
  color: #ff8d7a;
}

/* A free reset: a spare cell of fuel. */
.cell {
  flex: none;
  width: 8px;
  height: 12px;
  margin-left: 3px;
}

.cell + .cell {
  margin-left: 2px;
}

/* A station's name next to it, away from its ships: under it, over it or left of it. */
.plate-st {
  padding: 0 7px;
  border: 1px solid rgba(214, 170, 96, 0.3);
  border-radius: 3px;
  background: rgba(8, 10, 15, 0.8);
  color: #f3c27a;
  font-weight: 650;
  line-height: 18px;
  white-space: nowrap;
}

.plate-st.above {
  transform: translate(-50%, -100%);
}

.plate-st.left {
  transform: translate(-100%, -50%);
}

.plate-st span {
  color: #9b907c;
  font-weight: 400;
}

/* The ships a station has no berth for: the count stands where the next of them would park. */
.count {
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  min-width: 30px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid rgba(243, 198, 78, 0.7);
  border-radius: 11px;
  background: rgba(14, 16, 22, 0.92);
  color: #f3c64e;
  font: inherit;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
  pointer-events: auto;
  cursor: pointer;
}

.count:hover,
.count.hovered {
  border-color: #f3c64e;
  background: rgba(60, 48, 20, 0.95);
}

.count:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

/* The open system's ships, at the right side of the map under the toolbar. */
.stage > .fleet {
  position: absolute;
  top: var(--below-toolbar, 46px);
  right: 10px;
  z-index: 2;
  width: 300px;
  max-height: calc(100% - var(--below-toolbar, 46px) - 8px);
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

  .dock-replay,
  .dock-live {
    height: 32px;
  }

  .dock-replay {
    width: 32px;
  }

  .picker select {
    max-width: 52vw;
  }

  /* The list opens over the map, above the dock's line. */
  .stage > .fleet {
    left: 4px;
    right: 4px;
    width: auto;
    max-height: calc(100% - var(--below-toolbar, 46px) - 52px);
  }

  .plate-st {
    padding: 0 4px;
    font-size: 11.5px;
    line-height: 15px;
  }

  .plate-st span {
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
