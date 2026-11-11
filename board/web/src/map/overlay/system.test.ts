import { describe, expect, it } from "vitest";
import { PHASES } from "../../lib/labels";
import type { TaskSummary } from "../../types";
import { STATIONS, systemWorldSize } from "../layout";
import type { Place, Placement } from "../placement";
import type { ShipEntry } from "../scene";
import { STATION_TEXT, fleetGroups, hiddenShips, phaseText, stationPlates } from "./system";

const NOW = 1_800_000_000;
const WORLD = systemWorldSize({ width: 1600, height: 1000 });

function task(overrides: Partial<TaskSummary>): TaskSummary {
  return {
    slug: "t", kind: "work", title: null, link: null, repo: "repo", branch: null, task_type: null, executor: "codex",
    account: null, reviewer: "claude", model: null, effort: null, column: "running", phase: "ci",
    phase_started_at: NOW - 125, alive: true, turn: 1, fix_round: 0, outcome: "running", result_status: null, summary: null,
    pr: null, ci: null, sleeping_until: null, created: NOW, updated_at: NOW, activity: null, check: null, review: null, findings_left: 0, stop: null, left: 0,
    ...overrides,
  };
}

function ship(slug: string, place: Place, slot: number): ShipEntry {
  const placement: Placement = { place, slot, action: "wait", working: true, placeWorking: true, stale: false, beacon: false, fixing: false, companion: null };
  return { task: task({ slug }), placement };
}

describe("a system's labels", () => {
  it("name every station with its note", () => {
    const plates = stationPlates([], WORLD, null, null);
    expect(plates.map((plate) => [plate.text.name, plate.text.note].filter(Boolean).join(" · "))).toEqual([
      "Твои сессии",
      "Работа · ход и исправления",
      "Проверка",
      "Ревью",
      "CI",
      "Приёмка · ждёт тебя",
      "Сон · до сброса лимита",
    ]);
    expect(plates.every((plate) => plate.count === null)).toBe(true);
    expect(plates.find((plate) => plate.place === "gate")?.side).toBe(STATIONS.gate.plate);
  });

  it("count the ships a station has no berth for, and name them in the title", () => {
    const entries = Array.from({ length: STATIONS.gate.berths + 3 }, (_, index) => ship(`ship-${index}`, "gate", index));
    const gate = stationPlates(entries, WORLD, null, "ship-7").find((plate) => plate.place === "gate")!;
    const waiting = entries.slice(entries.length - gate.count!.ships).map((entry) => entry.task.slug);
    expect(gate.count).toMatchObject({ ships: 4, hovered: true });
    expect(gate.count!.title).toBe(["Ещё 4:", ...waiting].join("\n"));
    expect(waiting).toEqual(["ship-4", "ship-5", "ship-6", "ship-7"]);
    // The selected ship never waits behind the count.
    const chosen = stationPlates(entries, WORLD, "ship-7", null).find((plate) => plate.place === "gate")!;
    expect(chosen.count!.title).not.toContain("ship-7");
    expect(chosen.count!.hovered).toBe(false);
  });

  it("tell each ship's phase and line in the list", () => {
    expect(phaseText(task({}), NOW)).toBe(`${PHASES.ci} · 2 мин 05 с`);
    expect(phaseText(task({ phase: "fix", findings_left: 2, alive: false }), NOW)).toBe(`${PHASES.fix} · 2 замеч.`);
    expect(phaseText(task({ column: "review_me" }), NOW)).toBe("ждёт тебя");
    const [group] = fleetGroups([ship("a", "gate", 0)], NOW, false);
    expect(group).toMatchObject({ place: "gate", ...STATION_TEXT.gate, ships: [{ slug: "a", name: "a", beacon: false }] });
    expect(group!.ships[0]!.title.split("\n").slice(0, 3)).toEqual(["a", `${PHASES.ci} · 2 мин 05 с`, "Codex"]);
    expect(hiddenShips([task({ slug: "x" }), task({ slug: "y" })])).toEqual({ count: 2, title: "x\ny" });
  });
});
