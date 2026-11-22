// Operational data for the control panel and its detail screens.
import { computed, ref, shallowRef, watch } from "vue";
import { useNow, type Board } from "../../store/board";
import type { ArtIndex, ResearchView } from "../../types";
import { isReflection } from "../research";

export function useMapSources(props: Readonly<{ board: Board; active: boolean }>) {
  const clock = useNow();
  const now = ref(clock.value);
  watch(clock, (value) => {
    if (props.active) now.value = value;
  });
  const source = computed(() => props.board);
  const allTasks = computed(() => props.board.tasks.value);
  const researchView = shallowRef<ResearchView | null>(null);
  const repoArt = shallowRef<ArtIndex>({});
  const tasks = computed(() => allTasks.value.filter((task) => !isReflection(task, researchView.value)));
  async function loadResearch() {
    const view = await props.board.source.fetchResearch().catch(() => researchView.value);
    if (JSON.stringify(view) !== JSON.stringify(researchView.value)) researchView.value = view;
  }

  watch(() => props.active, (active, _, onCleanup) => {
    if (!active) return;
    now.value = Date.now() / 1000;
    void props.board.loadEvents();
    void props.board.source.fetchArt().then((art) => { repoArt.value = art; }).catch(() => {});
    void loadResearch();
    const timer = setInterval(loadResearch, 60_000);
    onCleanup(() => clearInterval(timer));
  }, { immediate: true });

  return {
    now, source, allTasks, researchView, loadResearch, tasks, repoArt,
    loaded: computed(() => props.board.state.value.loaded),
    emblemOf: (name: string | null) => name ? repoArt.value[name]?.emblem ?? null : null,
  };
}

export type MapSources = ReturnType<typeof useMapSources>;
