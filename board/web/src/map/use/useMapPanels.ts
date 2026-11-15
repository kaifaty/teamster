// What the viewer opened over the map: the system, a ship's bridge, the science station's screen, a subscription's screen,
// the day's summary, the ships' list and the control panel's log. The list's choice outlives the page.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { loadJson, saveJson } from "../../lib/storage";
import type { LogEvent } from "../../types";
import { systemTasks, type Place } from "../placement";
import { FLIGHT_SECONDS } from "../scene";
import type { GalaxyModel } from "./useGalaxyModel";
import type { MapSources } from "./useMapSources";

/** On a wide window the list stands at the side of a system as the viewer last chose; on a narrow one it opens over it. */
export const FLEET_KEY = "codex-board.fleet-shown.v1";

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

export interface PanelOptions {
  props: Readonly<{ active: boolean; machine?: string | null }>;
  sources: MapSources;
  model: GalaxyModel;
  host: Readonly<Ref<HTMLElement | null>>;
  fleetPanel: Readonly<Ref<{ reveal(place: Place): void } | null>>;
  summaryButton: Readonly<Ref<HTMLButtonElement | null>>;
  /** A machine was clicked in the control panel, with the button to give the focus back to. */
  onMachine: (id: string, opener: HTMLElement | null) => void;
  /** The map opened a ship's bridge or the science station's screen, which replace the machine's card. */
  onPanel: () => void;
}

export function useMapPanels({ props, sources, model, host, fleetPanel, summaryButton, onMachine, onPanel }: PanelOptions) {
  // The open system; null means the whole galaxy is shown.
  const repo = ref<string | null>(null);
  /** The ship picked in its system; its bridge stands over the map while `shipOpen`. */
  const selected = ref<string | null>(null);
  const shipOpen = ref(false);
  const hovered = ref<string | null>(null);
  const researchOpen = ref(false);
  /** The subscription whose screen stands over the map, by its key; null when none is open. */
  const account = ref<string | null>(null);
  const selectedTask = computed(() => (selected.value ? (sources.source.value.state.value.tasks[selected.value] ?? null) : null));
  /** The first element of the map's stage that matches `selector` and shows, to give the focus back to. */
  const visibleIn = (selector: string) =>
    [...(host.value?.querySelectorAll<HTMLElement>(selector) ?? [])].find((el) => el.offsetParent !== null) ?? null;

  // Another source has other systems and ships.
  watch(sources.sourceKind, () => {
    repo.value = null;
    selected.value = null;
    shipOpen.value = false;
    account.value = null;
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

  /** A ship's bridge; over the station's screen it stands on top, and closing it returns there. */
  function open(slug: string) {
    selected.value = slug;
    shipOpen.value = true;
    onPanel();
  }

  /**
   * From the station to a task's ship: its bridge over the station while the task is on the board, else its system.
   * «Показать на карте» on the bridge then leaves the station for the system.
   */
  function openShip(slug: string, name: string) {
    if (sources.allTasks.value.some((task) => task.slug === slug)) {
      open(slug);
      return;
    }
    researchOpen.value = false;
    if (model.systemNames.value.has(name)) repo.value = name;
    selected.value = null;
    shipOpen.value = false;
    onPanel();
  }

  function openResearch() {
    selected.value = null;
    shipOpen.value = false;
    account.value = null;
    researchOpen.value = true;
    onPanel();
  }

  /**
   * A subscription's screen, from the control panel; a task's bridge opened from it stands on top, and closing it returns
   * there.
   */
  function openAccount(key: string) {
    selected.value = null;
    shipOpen.value = false;
    researchOpen.value = false;
    account.value = key;
    onPanel();
  }

  function closeAccount() {
    const key = account.value;
    account.value = null;
    void nextTick(() => {
      const row = key ? visibleIn(`[data-account="${CSS.escape(key)}"]`) : null;
      (row ?? host.value?.querySelector<HTMLElement>("canvas"))?.focus();
    });
  }

  // A machine's card and the map's own panels replace each other, as on the board.
  watch(
    () => props.machine,
    (id) => {
      if (!id) return;
      selected.value = null;
      shipOpen.value = false;
      researchOpen.value = false;
      account.value = null;
    },
  );

  function closeResearch() {
    researchOpen.value = false;
    void nextTick(() => (visibleIn(".console-reflection button") ?? host.value?.querySelector<HTMLElement>("canvas"))?.focus());
  }

  /** The focus goes back to the ship's row in the list, or to the map. */
  function focusShip(slug: string | null) {
    void nextTick(() => {
      const row = slug ? host.value?.querySelector<HTMLElement>(`.fleet [data-ship="${CSS.escape(slug)}"]`) : null;
      (row ?? host.value?.querySelector<HTMLElement>("canvas"))?.focus();
    });
  }

  function close() {
    const slug = selected.value;
    selected.value = null;
    shipOpen.value = false;
    if (researchOpen.value || account.value) {
      const back = researchOpen.value ? ".station-screen .back" : ".account-screen .back";
      void nextTick(() => document.querySelector<HTMLElement>(back)?.focus());
      return;
    }
    focusShip(slug);
  }

  /** «Показать на карте»: the bridge closes, leaving its ship picked in its system, the station closed. */
  function showOnMap(name: string) {
    shipOpen.value = false;
    researchOpen.value = false;
    account.value = null;
    if (model.systemNames.value.has(name)) repo.value = name;
    focusShip(selected.value);
  }

  function openMachine(id: string, opener: HTMLElement | null) {
    onMachine(id, opener);
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
    shipOpen.value = false;
  }

  /** Escape lets go of a ship picked without its bridge, then leaves the system. */
  function onKey(event: KeyboardEvent) {
    if (event.key !== "Escape" || !props.active || !repo.value || shipOpen.value || researchOpen.value || account.value || props.machine) return;
    if (selected.value) selected.value = null;
    else leave();
  }

  // Ship's log and the day's summary.

  /** To the event's system, with its ship selected while the ship is still on the map. */
  function goTo(event: LogEvent) {
    if (!event.repo) return;
    repo.value = event.repo;
    const ship = event.slug ? systemTasks(sources.tasks.value, event.repo).shown.find((task) => task.slug === event.slug) : undefined;
    if (ship) open(ship.slug);
    else {
      selected.value = null;
      shipOpen.value = false;
    }
  }

  const summaryOpen = ref(false);
  function closeSummary() {
    summaryOpen.value = false;
    void nextTick(() => summaryButton.value?.focus());
  }

  // The control panel.

  /** A phone-sized window, as the `@media (max-width: 760px)` rules see it: the control panel folds there to a strip. */
  const narrowQuery = matchMedia("(max-width: 760px)");
  const narrow = ref(narrowQuery.matches);
  const onNarrow = (event: MediaQueryListEvent) => {
    narrow.value = event.matches;
  };
  /** On a narrow window the log folds to one line, and the whole log opens over the map on demand. */
  const logOpen = ref(false);
  // The control panel changes its shape across the breakpoint: the log folds.
  watch(narrow, () => {
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
      shipOpen.value = false;
      summaryOpen.value = false;
      researchOpen.value = false;
      account.value = null;
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
    repo, repoModel, selected, shipOpen, hovered, selectedTask, researchOpen, open, openShip, openResearch, closeResearch, close, showOnMap, openMachine,
    account, openAccount, closeAccount,
    flying, enter, leave, goTo, summaryOpen, closeSummary, narrow,
    logOpen, fleetVisible, toggleFleet, showStation,
  };
}

export type MapPanels = ReturnType<typeof useMapPanels>;
