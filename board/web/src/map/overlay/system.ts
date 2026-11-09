// The labels of an open star system: the stations' names, the count of the ships each has no berth for, and the ships'
// list at the side.

import { formatDuration, formatUntil } from "../../lib/format";
import { EXECUTORS, PHASES, problemLabel, shipLine, taskTitle } from "../../lib/labels";
import type { TaskSummary } from "../../types";
import type { FleetGroup } from "../FleetPanel.vue";
import { HULL_SIZE, hullOf } from "../fleet";
import { parkingOf, parkingOrder, plateAt, stationAt, systemFrame, type Size } from "../layout";
import { PLACES, type Place } from "../placement";
import type { ShipEntry } from "../scene";
import { at } from "./style";

export const STATION_TEXT: Record<Place, { name: string; note: string }> = {
  command: { name: "Штаб", note: "твои сессии" },
  yard: { name: "Верфь", note: "работа и фиксы" },
  range: { name: "Полигон", note: "проверка" },
  inspection: { name: "Инспекция", note: "ревью" },
  gate: { name: "Гиперврата", note: "CI" },
  roadstead: { name: "Рейд", note: "ждёт тебя" },
  cryo: { name: "Криополе", note: "сон" },
};

/** What a ship is doing, at `now`: its phase and for how long, why it waits, or until when it sleeps. */
export function phaseText(task: TaskSummary, now: number): string {
  switch (task.column) {
    case "sleeping":
      return task.sleeping_until !== null ? `сон ${formatUntil(task.sleeping_until, now)}` : PHASES.sleeping;
    case "review_me":
      return "ждёт тебя";
    case "attention":
      return problemLabel(task) ?? "нужно внимание";
    default: {
      const ticking = task.alive && task.phase_started_at !== null;
      // A ship back from the inspection tells how many findings it fixes, as its red marks do.
      const phase = task.phase === "fix" && task.findings_left > 0 ? `${PHASES.fix} · ${task.findings_left} замеч.` : PHASES[task.phase];
      return ticking ? `${phase} · ${formatDuration(now - task.phase_started_at!)}` : phase;
    }
  }
}

const shipKey = (entry: ShipEntry) => ({ slug: entry.task.slug, ...entry.placement });

/** The open system's ships by station, in the order they park: for the list at the side. `replaying`: the map replays. */
export function fleetGroups(entries: readonly ShipEntry[], now: number, replaying: boolean): FleetGroup[] {
  return PLACES.map((place) => {
    const here = entries.filter((entry) => entry.placement.place === place);
    const ships = parkingOrder(here, shipKey, place, null).map(({ task, placement: where }) => ({
      slug: task.slug,
      executor: task.executor,
      name: taskTitle(task),
      phase: phaseText(task, now),
      beacon: where.beacon,
      // The ship's line: its latest activity and how old it is, or why it no longer works.
      title: [taskTitle(task), phaseText(task, now), `${EXECUTORS[task.executor]}${task.account ? ` · ${task.account}` : ""}`, shipLine(task, where.stale, now, replaying)].join("\n"),
    }));
    return { place, ...STATION_TEXT[place], ships };
  }).filter((group) => group.ships.length);
}

/**
 * The stations' names on the map, and the count of the ships each one has no berth for: they park as the scene parks
 * them, see parkingOf.
 */
export function stationPlates(entries: readonly ShipEntry[], world: Size, selected: string | null, hovered: string | null) {
  const frame = systemFrame(world);
  return PLACES.map((place) => {
    const here = entries.filter((entry) => entry.placement.place === place);
    const order = parkingOrder(here, shipKey, place, selected);
    const parking = parkingOf(place, order.map((entry) => HULL_SIZE[hullOf(entry.task)]), frame);
    const station = stationAt(place, frame);
    const plate = plateAt(place, frame);
    const waiting = order.slice(parking.berths.length);
    const count = parking.count && {
      ships: parking.count.ships,
      style: at(station.x + parking.count.at.x, station.y + parking.count.at.y),
      title: [`Ещё ${parking.count.ships}:`, ...waiting.map((entry) => taskTitle(entry.task))].join("\n"),
      hovered: waiting.some((entry) => entry.task.slug === hovered),
    };
    return { place, text: STATION_TEXT[place], side: plate.side, style: at(plate.x, plate.y), count };
  });
}

/** The ships the system has no room for: their count and names. */
export function hiddenShips(hidden: readonly TaskSummary[]) {
  return { count: hidden.length, title: hidden.map(taskTitle).join("\n") };
}
