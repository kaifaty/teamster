// The fuel tanks' labels: a subscription's name, what is left, when it refills, and its spare cells.

import { ADMIRAL_NOTE } from "../../lib/accounts";
import { formatClock, formatUntil } from "../../lib/format";
import { tankEmpty, untilText, type Tank } from "../fleet";
import type { FuelColumn } from "../layout";
import { at } from "./style";

/** A label shows at most this many spare cells, one per free reset; the title has the count. */
export const MAX_CELLS = 4;

/** The spare cells a tank's label shows. */
export function tankCells(tank: Tank): number {
  return Math.min(tank.resets?.count ?? 0, MAX_CELLS);
}

/** A tank's second line: what is left, or why nothing is, and in how long it refills. */
export function tankInfo(tank: Tank, now: number): string {
  const left = tank.bad ? (tank.status ?? "пусто") : tank.fuel !== null ? `${tank.fuel}%` : (tank.status ?? "нет данных");
  const until = untilText(tank.refillAt, now);
  return until ? `${left} · ↻ ${until}` : left;
}

/** Everything a tank knows, for its label's title. */
export function tankTitle(tank: Tank, now: number): string {
  const when = (time: number) => `${formatClock(time, now)} (${formatUntil(time, now)})`;
  const resets = tank.resets;
  return [
    `${tank.name} · ${tank.executor === "codex" ? "Codex" : "Claude"}`,
    tank.admiral ? ADMIRAL_NOTE : null,
    tank.fuel !== null ? `Неделя: осталось ${tank.fuel}%` : "Неделя: нет данных",
    tank.status ? `Состояние: ${tank.status}` : null,
    tank.refillAt !== null ? `${tank.bad ? "Заправка" : "Сброс недели"}: ${when(tank.refillAt)}` : null,
    tank.burst ? `5 часов: занято ${Math.round(tank.burst.percent)}%${tank.burst.resetsAt !== null ? `, сброс ${formatClock(tank.burst.resetsAt, now)}` : ""}` : null,
    resets ? `Бесплатных сбросов: ${resets.count}${resets.expires.length ? ` · сгорают ${resets.expires.map((time) => formatClock(time, now)).join(", ")}` : ""}` : null,
    "Лампы у бака: дни до сброса",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A tank's label, on the right of its tank or under it in a row: its name, what is left and when it refills. */
export function tankLabels(list: readonly Tank[], column: FuelColumn | null, now: number) {
  if (!column) return [];
  return list.flatMap((tank) => {
    const anchor = column.anchors.get(tank.key);
    const size = column.labels.get(tank.key);
    if (!anchor || !size) return [];
    return [{
      tank,
      info: tankInfo(tank, now),
      cells: tankCells(tank),
      low: tankEmpty(tank),
      row: column.row,
      title: tankTitle(tank, now),
      style: { ...at(anchor.x, anchor.y), maxWidth: `${size.width}px` },
    }];
  });
}
