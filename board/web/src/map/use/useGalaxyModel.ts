// The galaxy the scene draws: one star per repository, one fuel tank per subscription, a reactor per machine, the
// science station and the constellations, laid out for the world the scene reports and the panels that cover it.

import { computed, ref, shallowRef, watch } from "vue";
import type { Board } from "../../store/board";
import { machineRings } from "../../lib/machines";
import { constellationsOf } from "../constellations";
import { daysLeft, stars, tankEmpty, tanks, type Star } from "../fleet";
import {
  defaultCovered,
  fuelColumnRect,
  fuelPositions,
  galaxyKeepOuts,
  galaxyLayout,
  machinePositions,
  systemWorldSize,
  worldSize,
  type Galaxy,
  type MachineShape,
  type Rect,
  type Size,
  type TankShape,
} from "../layout";
import { research } from "../research";
import type { MachineMark, TankMark } from "../scene";
import { machineShape } from "../overlay/machines";
import { tankCells, tankInfo } from "../overlay/tanks";
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
  const { now, replay, tasks, liveTasks } = sources;

  // Galaxy: one star per repository, one fuel tank per subscription.
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
  const systemNames = computed(() => new Set(starList.value.map((star) => star.repo)));

  // The tanks stay live in a replay: the accounts' past is not recorded.
  const tankList = computed(steady(() => tanks(sources.source.value.state.value.accounts?.data ?? null, now.value)));
  const tankShapes = computed(
    steady<TankShape[]>(() =>
      tankList.value.map((tank) => ({ key: tank.key, executor: tank.executor, name: tank.name, info: tankInfo(tank, now.value), resets: tankCells(tank) })),
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

  const station = computed(() => research(sources.researchView.value, sources.allTasks.value, starList.value.map((star) => star.repo)));
  const researchMarks = computed(() =>
    station.value
      ? {
          running: station.value.running,
          proposed: station.value.proposed.length,
          waiting: station.value.waiting,
          probes: station.value.probes,
        }
      : null,
  );
  // A finished run has written its report: read it at once rather than at the next refresh.
  watch(() => station.value?.running ?? false, (running, was) => {
    if (was && !running) void sources.loadResearch();
  });

  /** The galaxy's world and the open system's, as the scene lays them out for the window. */
  const world = ref<Size>(worldSize({ width: 1600, height: 1000 }));
  const systemWorld = ref<Size>(systemWorldSize({ width: 1600, height: 1000 }));

  // Machines stand as reactors along the right edge. They are the board's own and stay live in a replay and a
  // scenario: the machines' past is not recorded.
  const machinesData = computed(() => props.board.state.value.machines ?? null);
  const machineMarks = computed(
    steady<MachineMark[]>(() => (machinesData.value?.items ?? []).map((machine) => ({ id: machine.id, status: machine.status, rings: machineRings(machine.metrics) }))),
  );
  const machineNote = computed(() => machinesData.value?.config_error || null);
  // What the labels show, so that the column knows their sizes; the same list while it does not change.
  let lastShapes: MachineShape[] = [];
  const machineShapes = computed(() => {
    const next = (machinesData.value?.items ?? []).map(machineShape);
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
  let previousGalaxy: Galaxy | null = null;
  const galaxy = computed(() => {
    const blocked = galaxyKeepOuts(world.value, coveredNow.value, machineColumn.value, fuelColumn.value);
    // The stars keep their places from the last layout while they fit there.
    const next = galaxyLayout(starList.value, world.value, blocked, previousGalaxy, fullZoom.value, memberOf.value);
    previousGalaxy = next;
    return next;
  });

  /** What the scene's galaxy draws: see FleetScene.setGalaxy. */
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
  /** The sources galaxyModel reads: a change of any of them redraws the galaxy. */
  const galaxySources = [starList, galaxy, tankMarks, fuelColumn, constellationList, researchMarks, machineMarks, machineColumn] as const;

  return {
    starList, systemNames, tankList, constellationList, pickerGroups, station, world, systemWorld, machinesData, machineNote,
    covered, fullZoom, coveredNow, fuelColumn, machineColumn, galaxy, galaxyModel, galaxySources,
  };
}

export type GalaxyModel = ReturnType<typeof useGalaxyModel>;
