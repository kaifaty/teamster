// What the viewer opened over the map: the system, a ship's card, the science station's screen, the day's summary, the
// ships' list and the dock with the replay and the log. The list's and the replay's choice outlive the page.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { loadJson, saveJson } from "../../lib/storage";
import type { LogEvent } from "../../types";
import { systemTasks, type Place } from "../placement";
import { FLIGHT_SECONDS } from "../scene";
import type { GalaxyModel } from "./useGalaxyModel";
import type { MapSources } from "./useMapSources";

/** On a wide window the replay's scale shows or hides as the viewer last chose. */
export const REPLAY_KEY = "codex-board.replay-shown.v1";
/** On a wide window the list stands at the side of a system as the viewer last chose; on a narrow one it opens over it. */
export const FLEET_KEY = "codex-board.fleet-shown.v1";

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

export interface PanelOptions {
  props: Readonly<{ active: boolean; machine?: string | null }>;
  sources: MapSources;
  model: GalaxyModel;
  host: Readonly<Ref<HTMLElement | null>>;
  overlay: Readonly<Ref<HTMLElement | null>>;
  fleetPanel: Readonly<Ref<{ reveal(place: Place): void } | null>>;
  summaryButton: Readonly<Ref<HTMLButtonElement | null>>;
  /** A machine's reactor was clicked, with the label to give the focus back to. */
  onMachine: (id: string, opener: HTMLElement | null) => void;
  /** The map opened a task's card or the science station's screen, which replace the machine's card. */
  onPanel: () => void;
}

export function useMapPanels({ props, sources, model, host, overlay, fleetPanel, summaryButton, onMachine, onPanel }: PanelOptions) {
  const { replay } = sources;

  // The open system; null means the whole galaxy is shown.
  const repo = ref<string | null>(null);
  const selected = ref<string | null>(null);
  const hovered = ref<string | null>(null);
  const researchOpen = ref(false);
  const selectedTask = computed(() => (selected.value ? (sources.source.value.state.value.tasks[selected.value] ?? null) : null));

  // Another source has other systems and ships.
  watch(sources.sourceKind, () => {
    repo.value = null;
    selected.value = null;
  });
  const repoModel = computed({
    get: () => repo.value ?? "",
    set: (value: string) => {
      repo.value = value || null;
    },
  });
  watch(model.starList, (list) => {
    if (repo.value && !list.some((star) => star.repo === repo.value)) repo.value = null;
  });

  /** A task's card; over the station's screen it stands on top, and closing it returns there. */
  function open(slug: string) {
    selected.value = slug;
    onPanel();
  }

  /** From the station to a task's ship: its system, with the ship selected and its card open, while it is on the board. */
  function openShip(slug: string, name: string) {
    researchOpen.value = false;
    if (model.systemNames.value.has(name)) repo.value = name;
    selected.value = sources.allTasks.value.some((task) => task.slug === slug) ? slug : null;
    onPanel();
  }

  function openResearch() {
    selected.value = null;
    researchOpen.value = true;
    onPanel();
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

  function openMachine(id: string, opener: HTMLElement | null) {
    onMachine(id, opener);
  }

  function openMachineAt(id: string) {
    const label = overlay.value?.querySelector<HTMLElement>(`[data-machine="${CSS.escape(id)}"] button`) ?? null;
    openMachine(id, label);
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

  // Ship's log and the day's summary.

  /** The log's lines: the replayed day's while the map replays, else the live last day. */
  const logEvents = computed(() => {
    if (replay.at === null) return sources.events.value;
    const { since, until } = replay.window;
    return replay.events.filter((event) => event.at >= since && event.at <= until);
  });
  const replayClock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const replayTime = computed(() => (replay.at === null ? null : replayClock.format(new Date(replay.at * 1000))));

  /** To the event's system, with its ship selected while the ship is still on the map. */
  function goTo(event: LogEvent) {
    if (!event.repo) return;
    repo.value = event.repo;
    const ship = event.slug ? systemTasks(sources.tasks.value, event.repo).shown.find((task) => task.slug === event.slug) : undefined;
    selected.value = ship ? ship.slug : null;
  }

  /** A line of the log in replay: the scale moves to its time, and the map to its system. */
  function seekTo(event: LogEvent) {
    replay.seek(event.at);
    if (event.repo && model.systemNames.value.has(event.repo)) repo.value = event.repo;
  }

  const summaryOpen = ref(false);
  function closeSummary() {
    summaryOpen.value = false;
    void nextTick(() => summaryButton.value?.focus());
  }

  // The dock.

  /** A phone-sized window, as the `@media (max-width: 760px)` rules see it: the dock folds there to one line. */
  const narrowQuery = matchMedia("(max-width: 760px)");
  const narrow = ref(narrowQuery.matches);
  const onNarrow = (event: MediaQueryListEvent) => {
    narrow.value = event.matches;
  };
  const replayShown = ref(loadJson(REPLAY_KEY, true, isBoolean));
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
  // The dock changes its shape across the breakpoint and between the galaxy and a system: it folds.
  watch(compactDock, () => {
    replayOpen.value = false;
    logOpen.value = false;
  });

  // The ships' list.

  const fleetShown = ref(loadJson(FLEET_KEY, true, isBoolean));
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
  /** The count at a station was pressed: the list opens at that station. */
  function showStation(place: Place) {
    if (narrow.value) fleetOpen.value = true;
    else fleetShown.value = true;
    void nextTick(() => fleetPanel.value?.reveal(place));
  }

  // A hidden map closes what it opened.
  watch(
    () => props.active,
    (active) => {
      if (active) return;
      selected.value = null;
      summaryOpen.value = false;
      researchOpen.value = false;
    },
  );
  onMounted(() => {
    window.addEventListener("keydown", onKey);
    narrowQuery.addEventListener("change", onNarrow);
  });
  onBeforeUnmount(() => {
    clearTimeout(flightTimer);
    window.removeEventListener("keydown", onKey);
    narrowQuery.removeEventListener("change", onNarrow);
  });

  return {
    repo, repoModel, selected, hovered, selectedTask, researchOpen, open, openShip, openResearch, closeResearch, close, openMachine,
    openMachineAt, flying, enter, leave, logEvents, replayTime, goTo, seekTo, summaryOpen, closeSummary, narrow, replayShown,
    compactDock, replayOpen, logOpen, replayVisible, toggleReplay, dockFolded, fleetVisible, toggleFleet, showStation,
  };
}

export type MapPanels = ReturnType<typeof useMapPanels>;
