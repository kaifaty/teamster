// What the map shows: the board or, in the demo mode, a scenario; its replay; and what the server keeps beside the tasks —
// the research, the repositories' art and the constellations — looked up again whenever the map comes back.

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { createBoard, useNow, type Board } from "../../store/board";
import type { ArtIndex, Constellations, ResearchView, TaskSummary } from "../../types";
import { replayFleet } from "../replay";
import { isReflection } from "../research";
import { useReplay } from "../useReplay";

/** The reflection writes rarely; a visible map asks again every minute. */
export const RESEARCH_REFRESH_MS = 60_000;

export function useMapSources(props: Readonly<{ board: Board; active: boolean }>) {
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
    if (kind !== "scenario" || scenario.value) return;
    // Written out so that a production build drops the scenario.
    if (import.meta.env.MODE === "fixture") {
      const { scenarioSource } = await import("../scenario");
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
  const emblemOf = (name: string | null) => (name ? (repoArt.value[name]?.emblem ?? null) : null);

  const events = computed(() => source.value.events.value);
  const eventsError = computed(() => source.value.eventsError.value);
  // The last day's history loads whenever the map opens; live events join it without duplicates.
  watch(
    [source, () => props.active],
    ([board, active]) => {
      if (active) void board.loadEvents();
    },
    { immediate: true },
  );

  watch(
    () => props.active,
    (active) => {
      if (active) {
        now.value = Date.now() / 1000;
        void loadArt();
        void loadConstellations();
        void loadResearch();
      } else replay.pause();
    },
  );
  let researchTimer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    researchTimer = setInterval(() => {
      if (props.active) void loadResearch();
    }, RESEARCH_REFRESH_MS);
  });
  onBeforeUnmount(() => {
    clearInterval(researchTimer);
    scenario.value?.stop();
  });

  return {
    now, demo, sourceKind, source, researchView, loadResearch, allTasks, liveTasks, loaded, replay, mapNow, tasks,
    repoArt, constellationData, emblemOf, events, eventsError,
  };
}

export type MapSources = ReturnType<typeof useMapSources>;
