// The galaxy the scene draws, one star per repository and the constellations, laid out for the world the scene reports
// and the toolbar over it; and what the control panel under the map shows: the subscriptions, the machines and the
// reflection.

import { computed, ref, shallowRef, watch } from "vue";
import type { Board } from "../../store/board";
import { constellationsOf } from "../constellations";
import { stars, tanks } from "../fleet";
import { defaultCovered, galaxyLayout, systemWorldSize, worldSize, type Galaxy, type Rect, type Size } from "../layout";
import { research } from "../research";
import type { MapSources } from "./useMapSources";

/** The same value while it does not change, so that the galaxy is not redrawn at every tick of the clock. */
export function steady<T>(read: () => T): () => T {
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

export function useGalaxyModel(props: Readonly<{ board: Board }>, sources: MapSources) {
  const { now, tasks } = sources;

  // Galaxy: one star per repository.
  const starList = computed(steady(() => stars(tasks.value)));
  const systemNames = computed(() => new Set(starList.value.map((star) => star.repo)));

  /** The subscriptions, for the control panel. */
  const tankList = computed(steady(() => tanks(sources.source.value.state.value.accounts?.data ?? null, now.value)));

  const constellationList = computed(steady(() => constellationsOf(sources.constellationData.value, starList.value.map((star) => star.repo))));
  /** Which constellation each repository is in. */
  const memberOf = computed(() => new Map(constellationList.value.flatMap((item) => item.repos.map((name) => [name, item.name] as const))));
  /** The system picker's choices, a group for each constellation and the rest after them. */
  const pickerGroups = computed(() => {
    const byRepo = new Map(starList.value.map((star) => [star.repo, star]));
    const grouped = constellationList.value.map((item) => ({ name: item.name, stars: item.repos.flatMap((name) => byRepo.get(name) ?? []) }));
    const rest = starList.value.filter((star) => !memberOf.value.has(star.repo));
    return { grouped, rest };
  });

  /** The reflection, for the control panel; null when the server tells nothing about research. */
  const station = computed(() => research(sources.researchView.value, sources.allTasks.value, starList.value.map((star) => star.repo)));
  // A finished run has written its report: read it at once rather than at the next refresh.
  watch(() => station.value?.running ?? false, (running, was) => {
    if (was && !running) void sources.loadResearch();
  });

  /** The galaxy's world and the open system's, as the scene lays them out for the window. */
  const world = ref<Size>(worldSize({ width: 1600, height: 1000 }));
  const systemWorld = ref<Size>(systemWorldSize({ width: 1600, height: 1000 }));

  // The machines are the board's own, including in a scenario.
  const machinesData = computed(() => props.board.state.value.machines ?? null);

  /** The parts of the world under the map's toolbar, measured for the window; a band along the top until then. */
  const covered = shallowRef<Rect[] | null>(null);
  /** The zoom of the full view in this window, at which the labels' room is reserved. */
  const fullZoom = ref<number | undefined>(undefined);
  const coveredNow = computed(() => covered.value ?? defaultCovered(world.value));
  let previousGalaxy: Galaxy | null = null;
  const galaxy = computed(() => {
    // The stars keep their places from the last layout while they fit there.
    const next = galaxyLayout(starList.value, world.value, coveredNow.value, previousGalaxy, fullZoom.value, memberOf.value);
    previousGalaxy = next;
    return next;
  });

  /** What the scene's galaxy draws: see FleetScene.setGalaxy. */
  function galaxyModel() {
    return { stars: starList.value, layout: galaxy.value, constellations: constellationList.value };
  }
  /** The sources galaxyModel reads: a change of any of them redraws the galaxy. */
  const galaxySources = [starList, galaxy, constellationList] as const;

  return {
    starList, systemNames, tankList, constellationList, pickerGroups, station, world, systemWorld, machinesData,
    covered, fullZoom, coveredNow, galaxy, galaxyModel, galaxySources,
  };
}

export type GalaxyModel = ReturnType<typeof useGalaxyModel>;
