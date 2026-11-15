// The control panel's texts at the map's bottom: the duty account, a subscription's row, a machine's row and the
// reflection's note. Pure functions; the panel's components only lay them out.

import { ADMIRAL_NOTE } from "../../lib/accounts";
import { formatClock, formatUntil } from "../../lib/format";
import { cpuMeter, dataAge, errorLabel, formatBytes, memoryMeter, statusLevel, statusText } from "../../lib/machines";
import type { Machine } from "../../types";
import { LOW_FUEL, untilText, type Star, type Tank } from "../fleet";
import { shortDate, type Research } from "../research";

const FAMILY = { codex: "Codex", claude: "Claude" } as const;

/** A row shows at most this many spare cells, one per free reset; the title has the count. */
export const MAX_CELLS = 4;

/** The spare cells a subscription's row shows: its free resets, Codex only. */
export function tankCells(tank: Tank): number {
  return Math.min(tank.resets?.count ?? 0, MAX_CELLS);
}

/** What is left, or why nothing is: "41%", "лимит", "нет данных". */
export function tankLeft(tank: Tank): string {
  return tank.bad ? (tank.status ?? "пусто") : tank.fuel !== null ? `${tank.fuel}%` : (tank.status ?? "нет данных");
}

/** What is left, and in how long the subscription refills: "41% · ↻ 3 д". */
export function tankInfo(tank: Tank, now: number): string {
  const until = untilText(tank.refillAt, now);
  return until ? `${tankLeft(tank)} · ↻ ${until}` : tankLeft(tank);
}

/** Everything a subscription knows, for its row's title. */
export function tankTitle(tank: Tank, now: number): string {
  const when = (time: number) => `${formatClock(time, now)} (${formatUntil(time, now)})`;
  const resets = tank.resets;
  return [
    `${tank.name} · ${FAMILY[tank.executor]}`,
    tank.admiral ? ADMIRAL_NOTE : null,
    tank.fuel !== null ? `Неделя: осталось ${tank.fuel}%` : "Неделя: нет данных",
    tank.status ? `Состояние: ${tank.status}` : null,
    tank.refillAt !== null ? `${tank.bad ? "Снова доступен" : "Сброс недели"}: ${when(tank.refillAt)}` : null,
    tank.burst ? `5 часов: занято ${Math.round(tank.burst.percent)}%${tank.burst.resetsAt !== null ? `, сброс ${formatClock(tank.burst.resetsAt, now)}` : ""}` : null,
    resets ? `Бесплатных сбросов: ${resets.count}${resets.expires.length ? ` · сгорают ${resets.expires.map((time) => formatClock(time, now)).join(", ")}` : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The colour of a subscription's bar: its family's; red with LOW_FUEL percent or less left; grey when it gives nothing,
 * exhausted, limited or logged out.
 */
export type FuelTone = "codex" | "claude" | "low" | "off";

export function fuelTone(tank: Pick<Tank, "executor" | "bad" | "fuel">): FuelTone {
  if (tank.bad) return "off";
  if (tank.fuel !== null && tank.fuel <= LOW_FUEL) return "low";
  return tank.executor;
}

/** A subscription's row in the panel: its name, a bar of the week left, the figure and the reset. */
export function subscriptionRow(tank: Tank, now: number) {
  const until = untilText(tank.refillAt, now);
  const cells = tankCells(tank);
  const left = tankLeft(tank);
  return {
    key: tank.key,
    name: tank.name,
    executor: tank.executor,
    tone: fuelTone(tank),
    /** The bar's width in percent: nothing for a subscription that gives nothing. */
    bar: tank.bad ? 0 : (tank.fuel ?? 0),
    left,
    until: until ? `↻ ${until}` : null,
    cells,
    duty: tank.admiral,
    title: tankTitle(tank, now),
    label: [
      `${tank.name}, ${FAMILY[tank.executor]}: ${left}`,
      until ? `сброс через ${until}` : null,
      cells ? `бесплатных сбросов ${cells}` : null,
      tank.admiral ? "дежурная" : null,
    ]
      .filter(Boolean)
      .join(", ") + ". Открыть экран подписки",
  };
}

export type SubscriptionRow = ReturnType<typeof subscriptionRow>;

/** How many portraits each family has: duty-claude-1…3 and duty-codex-1…2 in ../art. */
export const PORTRAITS = { claude: 3, codex: 2 } as const;

/**
 * Each subscription's portrait, by its key: the next one of its family in the order given, «duty-claude-1»,
 * «duty-claude-2»…, and round again when a family has more subscriptions than portraits.
 */
export function portraitNames(tanks: readonly Pick<Tank, "key" | "executor">[]): Map<string, string> {
  const seen = { claude: 0, codex: 0 };
  const names = new Map<string, string>();
  for (const tank of tanks) {
    const number = (seen[tank.executor]++ % PORTRAITS[tank.executor]) + 1;
    names.set(tank.key, `duty-${tank.executor}-${number}`);
  }
  return names;
}

/** "в работе 12 · ждут тебя 3": the live tasks of every system, and those that wait for you, as the systems' labels count them. */
export function liveLine(stars: readonly Pick<Star, "live" | "ready">[]): string {
  const live = stars.reduce((sum, star) => sum + star.live, 0);
  const ready = stars.reduce((sum, star) => sum + star.ready, 0);
  return `в работе ${live} · ждут тебя ${ready}`;
}

/** "21:39" today, "14.11 21:39" on another day: short enough for the duty's window. */
export function shortClock(at: number, now: number): string {
  const date = new Date(at * 1000);
  const today = new Date(now * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? time : `${two(date.getDate())}.${two(date.getMonth() + 1)} ${time}`;
}

/**
 * The duty block: the subscription teamster keeps for the orchestrator, what is left in it and since when it is on duty,
 * with the reason in the title; «Дежурный не назначен» without one.
 */
export function dutyBlock(tanks: readonly Tank[], stars: readonly Pick<Star, "live" | "ready">[], now: number) {
  const tank = tanks.find((item) => item.duty) ?? null;
  const live = liveLine(stars);
  if (!tank) {
    return { key: null, heading: "Дежурный не назначен", name: null, family: null, executor: null, info: null, since: null, off: false, title: "Teamster не назначил дежурную подписку", live, label: null };
  }
  const since = tank.duty?.since ?? null;
  const reason = tank.duty?.reason ?? null;
  const info = tankInfo(tank, now);
  const sinceText = since !== null ? `дежурит с ${shortClock(since, now)}` : null;
  return {
    key: tank.key,
    heading: `Дежурный · ${tank.name}`,
    name: tank.name,
    family: FAMILY[tank.executor],
    executor: tank.executor,
    info,
    since: sinceText,
    /** It gives nothing now: its portrait is greyed out, as its row is. */
    off: tank.bad,
    title: [`Дежурный · ${tank.name} · ${FAMILY[tank.executor]}`, reason ? `Почему: ${reason}` : null, ADMIRAL_NOTE].filter(Boolean).join("\n"),
    live,
    label: `Дежурный ${tank.name}, ${FAMILY[tank.executor]}: ${info}${sinceText ? `, ${sinceText}` : ""}. Открыть экран подписки`,
  };
}

export type DutyBlock = ReturnType<typeof dutyBlock>;

/**
 * A machine's row: its name, then its CPU in use and its memory free («CPU 52 % · RAM 2,6 ГБ», the title says more), or
 * its status in the words of the board's strip while nothing is
 * known of them — «нет связи», «нет данных».
 */
export function machineRow(machine: Machine, now: number) {
  const status = statusText(machine);
  const metrics = machine.status === "offline" || machine.status === "unknown" ? null : machine.metrics;
  const cpu = metrics?.cpu ? cpuMeter(metrics.cpu) : null;
  const memory = metrics?.memory ? memoryMeter(metrics.memory) : null;
  const parts = [cpu ? `CPU ${cpu.value}` : null, metrics?.memory ? `RAM ${formatBytes(metrics.memory.available_bytes)}` : null].filter(Boolean);
  const line = parts.length ? parts.join(" · ") : status;
  // A failed probe that has not yet made the machine offline, and data that is not fresh: in the title, as the card has them.
  const mark = machine.error && machine.status !== "offline" ? `⚠ ${errorLabel(machine.error)}` : null;
  return {
    id: machine.id,
    name: machine.name,
    line,
    level: statusLevel(machine.status) ?? "muted",
    /** Nothing live is known: the row is dimmed. */
    dim: !metrics,
    title: [machine.role ? `${machine.name} · ${machine.role}` : machine.name, status, cpu?.title, memory?.title, mark, dataAge(machine, now)].filter(Boolean).join("\n"),
    label: `${machine.name}: ${parts.length ? `${status}, ${line}` : status}. Открыть карточку машины`,
  };
}

export type MachineRow = ReturnType<typeof machineRow>;

export type ReflectionMarks = Pick<Research, "batch" | "proposed" | "waiting" | "running" | "pending">;

/** The reflection's note: the most pressing one, and the rest in the title; «нет данных» while the server tells nothing. */
export function reflectionNote(marks: ReflectionMarks | null) {
  if (!marks) return { note: "нет данных", title: "Сервер не прислал данных о разборах", running: false, waiting: false, label: null };
  const last = marks.batch ? `разбор ${shortDate(marks.batch.date)}` : "разборов не было";
  const proposed = marks.proposed.length;
  const asks = marks.waiting;
  // A question waits on the human before anything else.
  const note = asks ? `ждёт ответа ${asks}` : marks.running ? "идёт разбор" : proposed ? `ждут решения ${proposed}` : last;
  const title = [
    marks.running ? "идёт разбор" : last,
    ...(asks ? [`ждут ответа ${asks}`] : []),
    `ждут решения ${proposed}`,
    `с сигналом ${marks.pending.signals} из ${marks.pending.records}`,
  ].join("\n");
  return { note, title, running: marks.running && !asks, waiting: asks > 0 || (!marks.running && proposed > 0), label: `Рефлексия: ${note}. Открыть экран рефлексии` };
}
