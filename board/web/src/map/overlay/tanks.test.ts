import { describe, expect, it } from "vitest";
import { ADMIRAL_NOTE } from "../../lib/accounts";
import { formatClock, formatUntil } from "../../lib/format";
import type { Tank } from "../fleet";
import { MAX_CELLS, tankCells, tankInfo, tankLabels, tankTitle } from "./tanks";

const NOW = 1_800_000_000;
const tank = (overrides: Partial<Tank>): Tank => ({
  key: "codex:main", name: "main", executor: "codex", fuel: 41, bad: false, status: null, admiral: false,
  refillAt: null, resets: null, burst: null, ...overrides,
});
const when = (time: number) => `${formatClock(time, NOW)} (${formatUntil(time, NOW)})`;

describe("tank labels", () => {
  it("tell what is left and in how long the tank refills", () => {
    expect(tankInfo(tank({ refillAt: NOW + 3 * 3600 }), NOW)).toBe("41% · ↻ 3 ч");
    expect(tankInfo(tank({}), NOW)).toBe("41%");
    expect(tankInfo(tank({ fuel: null }), NOW)).toBe("нет данных");
    expect(tankInfo(tank({ bad: true, status: "лимит", refillAt: NOW + 600 }), NOW)).toBe("лимит · ↻ 10 мин");
    expect(tankInfo(tank({ bad: true }), NOW)).toBe("пусто");
  });

  it("put everything the tank knows in the title", () => {
    const resetsAt = NOW + 7200;
    const expires = [NOW + 86_400, NOW + 2 * 86_400];
    const title = tankTitle(
      tank({ admiral: true, status: "доступна", refillAt: NOW + 3600, burst: { percent: 37.4, resetsAt }, resets: { count: 2, expires } }),
      NOW,
    );
    expect(title).toBe(
      [
        "main · Codex",
        ADMIRAL_NOTE,
        "Неделя: осталось 41%",
        "Состояние: доступна",
        `Сброс недели: ${when(NOW + 3600)}`,
        `5 часов: занято 37%, сброс ${formatClock(resetsAt, NOW)}`,
        `Бесплатных сбросов: 2 · сгорают ${expires.map((time) => formatClock(time, NOW)).join(", ")}`,
        "Лампы у бака: дни до сброса",
      ].join("\n"),
    );
  });

  it("call a spent tank's refill a refuel and leave out what it does not know", () => {
    const title = tankTitle(tank({ executor: "claude", fuel: null, bad: true, refillAt: NOW + 600, burst: { percent: 80, resetsAt: null }, resets: { count: 0, expires: [] } }), NOW);
    expect(title).toBe(
      ["main · Claude", "Неделя: нет данных", `Заправка: ${when(NOW + 600)}`, "5 часов: занято 80%", "Бесплатных сбросов: 0", "Лампы у бака: дни до сброса"].join("\n"),
    );
  });

  it("show no more than four spare cells", () => {
    expect(MAX_CELLS).toBe(4);
    expect(tankCells(tank({ resets: { count: 7, expires: [] } }))).toBe(4);
    expect(tankCells(tank({ resets: { count: 2, expires: [] } }))).toBe(2);
    expect(tankCells(tank({}))).toBe(0);
  });

  it("stand at their anchors, as wide as the column lets them", () => {
    const column = {
      places: new Map(), labels: new Map([["codex:main", { width: 150, height: 30 }]]), anchors: new Map([["codex:main", { x: 10, y: 20 }]]),
      row: false, size: 96, labelZoom: 1,
    };
    const [label] = tankLabels([tank({ fuel: 10 }), tank({ key: "other" })], column, NOW);
    expect(label).toMatchObject({ info: "10%", cells: 0, low: true, row: false, style: { "--x": 10, "--y": 20, maxWidth: "150px" } });
    expect(tankLabels([tank({})], null, NOW)).toEqual([]);
  });
});
