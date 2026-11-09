import { describe, expect, it } from "vitest";
import { fuelColumnRect, fuelPositions, machineColumnRect, machinePositions, researchPosition, type Rect } from "../layout";
import { constellationKeepOuts, constellationLabels } from "./constellations";

const WORLD = { width: 1000, height: 1000 };
const item = { name: "Альфа", color: "#8f7cf0", repos: ["a", "b"] };
const layout = (y: number, x = 500) => ({ places: new Map([["a", { x, y }], ["b", { x: x + 100, y }]]), spacing: 100, labelZoom: 1 });
// The label is 68 × 18 at this zoom, 60 apart from its stars: its middle above, below, left and right of them.
const ABOVE: Rect = { x0: 540, y0: 425, x1: 560, y1: 435 };
const BELOW: Rect = { x0: 540, y0: 585, x1: 560, y1: 595 };
const LEFT: Rect = { x0: 400, y0: 495, x1: 410, y1: 505 };
const side = (keepOuts: Rect[], y = 500, x = 500) => constellationLabels([item], layout(y, x), WORLD, keepOuts)[0]?.side;

describe("constellation labels", () => {
  it("stands above the stars when nothing is there", () => {
    const [label] = constellationLabels([item], layout(500), WORLD, []);
    expect(label).toEqual({ name: "Альфа", side: "above", style: { "--x": 550, "--y": 431, color: "#8f7cf0" } });
  });

  it("goes below, then left, then right of what stands above", () => {
    expect(side([ABOVE])).toBe("below");
    expect(side([ABOVE, BELOW])).toBe("left");
    expect(side([ABOVE, BELOW, LEFT])).toBe("right");
  });

  it("does not leave the world", () => {
    expect(side([], 50)).toBe("below");
    // At the left edge, with the room above and below taken, the left side is outside the world.
    const shift = (rect: Rect): Rect => ({ ...rect, x0: rect.x0 - 480, x1: rect.x1 - 480 });
    expect(side([shift(ABOVE), shift(BELOW)], 500, 20)).toBe("right");
  });

  it("keeps off the science station", () => {
    const station = researchPosition(WORLD);
    const keepOuts = constellationKeepOuts(WORLD, null, null, []);
    // The stars stand under the station, close enough for the label above them to touch its keep-out.
    expect(side(keepOuts, keepOuts[0]!.y1 + 60, station.x - 50)).toBe("below");
    expect(constellationKeepOuts(WORLD, null, null, [ABOVE])).toContainEqual(ABOVE);
  });

  it("keeps off the reactors' column and the tanks' column", () => {
    const machines = machinePositions([{ id: "m", name: "m", status: "в порядке" }], WORLD);
    const fuel = fuelPositions([{ key: "t", executor: "codex", name: "t", info: "83%", resets: 0 }], WORLD);
    const cases = [
      { rect: machineColumnRect(machines)!, keepOuts: constellationKeepOuts(WORLD, machines, null, []) },
      { rect: fuelColumnRect(fuel)!, keepOuts: constellationKeepOuts(WORLD, null, fuel, []) },
    ];
    for (const { rect, keepOuts } of cases) {
      expect(keepOuts).toContainEqual(rect);
      // The stars stand under the column's middle, so that the label above them would stand on it.
      const x = Math.round((rect.x0 + rect.x1) / 2) - 50;
      const y = Math.round((rect.y0 + rect.y1) / 2) + 69;
      const others = keepOuts.filter((keepOut) => JSON.stringify(keepOut) !== JSON.stringify(rect));
      expect(side(others, y, x)).toBe("above");
      expect(side(keepOuts, y, x)).not.toBe("above");
    }
  });

  it("stays above when no side is free, and skips a constellation without stars", () => {
    expect(side([{ x0: 0, y0: 0, x1: 1000, y1: 1000 }])).toBe("above");
    expect(constellationLabels([{ ...item, repos: ["z"] }], layout(500), WORLD, [])).toEqual([]);
  });
});
