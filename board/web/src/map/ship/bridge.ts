// The ship's bridge: what the screen of one task shows, from the task, its detail and its limits — the decks, the plate
// beside the title, the ship's hull and papers, the route and the meters. «Сейчас» is in now.ts, «Что сделано» in
// done.ts. The decks only draw it.

import { formatAge, formatClock } from "../../lib/format";
import { EXECUTORS, KINDS, PHASES, problemLabel } from "../../lib/labels";
import type { Cargo, TaskLimits, TaskSummary } from "../../types";
import type { ArtName } from "../art";
import { MAX_PATCHES, hullOf, patchSpots, type Hull } from "../fleet";
import { placeOf } from "../placement";

/** Which decks the screen has: a session is a flagship without route, meters or orders; a scout has no repair loops. */
export interface BridgeView {
  route: boolean;
  loops: boolean;
  gauges: boolean;
  repairGauges: boolean;
  hull: boolean;
  docs: boolean;
  commands: boolean;
}

export function bridgeView(task: Pick<TaskSummary, "kind">): BridgeView {
  if (task.kind === "session") return { route: false, loops: false, gauges: false, repairGauges: false, hull: false, docs: false, commands: false };
  const scout = task.kind === "scout";
  return { route: true, loops: !scout, gauges: true, repairGauges: !scout, hull: true, docs: true, commands: true };
}

// Header.

export type StateTone = "work" | "wait" | "ready" | "sleep" | "bad" | "dim";

/** The plate beside the title: where the ship is in words. */
export function stateOf(task: TaskSummary): { text: string; tone: StateTone } {
  if (task.column === "closed") return { text: "закрыта", tone: "dim" };
  if (task.kind === "session") return task.alive ? { text: "идёт ход", tone: "work" } : { text: "ждёт тебя", tone: "ready" };
  if (task.column === "sleeping") return { text: "спит", tone: "sleep" };
  if (task.column === "review_me") return { text: "готово к приёмке", tone: "ready" };
  if (task.column === "attention") {
    if (task.result_status === "needs_decision") return { text: "ждёт решения", tone: "wait" };
    const tone: StateTone = task.result_status === "partial" || task.outcome === "stopped" ? "wait" : "bad";
    return { text: problemLabel(task) ?? "нужно внимание", tone };
  }
  return { text: `в работе · ${PHASES[task.phase]}`, tone: "work" };
}

// The ship.

const HULL_NAMES: Record<Hull, string> = { light: "Задача", frigate: "Задача", cruiser: "Задача", scout: "Разведка", flagship: "Сессия" };

/** The hull's picture: the same as the scene's, by the task's effort and its executor's colour. */
export function hullArt(task: Pick<TaskSummary, "kind" | "effort" | "executor">): ArtName {
  const codex = task.executor === "codex";
  switch (hullOf(task)) {
    case "flagship":
      return "flagship";
    case "scout":
      return "shipScout";
    case "frigate":
      return codex ? "shipBlueFrigate" : "shipCopperFrigate";
    case "cruiser":
      return codex ? "shipBlueCruiser" : "shipCopperCruiser";
    default:
      return codex ? "shipBlue" : "shipCopper";
  }
}

export function hullClass(task: Pick<TaskSummary, "kind" | "effort" | "executor">): string {
  return HULL_NAMES[hullOf(task)];
}

/** Fix rounds done: the limits' count, else the summary's. */
export const roundsOf = (task: Pick<TaskSummary, "fix_round">, limits: TaskLimits | null | undefined) => limits?.review_rounds ?? task.fix_round;

/** A mark on the hull's picture, in percent of the picture from its top left corner. */
export interface HullMark {
  kind: "hole" | "patch";
  left: number;
  top: number;
  title: string;
}

/** A hull shows at most this many holes. */
export const MAX_HOLES = 5;

const HOLE_SPOTS: readonly { x: number; y: number }[] = [
  { x: 0.12, y: -0.12 },
  { x: -0.14, y: 0.06 },
  { x: 0.04, y: 0.24 },
  { x: -0.04, y: -0.26 },
  { x: 0.16, y: 0.1 },
  { x: -0.12, y: 0.22 },
];

/**
 * The opaque part of each hull's picture, in shares of its square: its longest side, which is its length, and its
 * centre. Measured from the PNGs, so that every class fills the hangar alike.
 */
const ART_BOX: Partial<Record<ArtName, { span: number; cx: number; cy: number }>> = {
  shipBlue: { span: 0.896, cx: 0.5, cy: 0.469 },
  shipBlueFrigate: { span: 0.96, cx: 0.5, cy: 0.489 },
  shipBlueCruiser: { span: 0.951, cx: 0.5, cy: 0.49 },
  shipCopper: { span: 0.875, cx: 0.5, cy: 0.484 },
  shipCopperFrigate: { span: 0.978, cx: 0.502, cy: 0.502 },
  shipCopperCruiser: { span: 0.965, cx: 0.5, cy: 0.497 },
  shipScout: { span: 0.906, cx: 0.496, cy: 0.477 },
  flagship: { span: 0.971, cx: 0.5, cy: 0.499 },
};

/** The hull's length in shares of the hangar's side, and where it starts from the top: above the caption's band. */
export const HULL_SHARE = 0.77;
const HULL_TOP = 0.03;

/** Where the hull's picture stands in its square hangar, in percent of the side: its size and its top left corner. */
export interface HullFrame {
  size: number;
  left: number;
  top: number;
}

const round1 = (value: number) => Math.round(value * 1000) / 10;

/** The picture scaled so that its opaque part is HULL_SHARE of the hangar's side, centred across, near the top. */
export function hullFrame(art: ArtName): HullFrame {
  const box = ART_BOX[art] ?? { span: 1, cx: 0.5, cy: 0.5 };
  const size = HULL_SHARE / box.span;
  return { size: round1(size), left: round1(0.5 - box.cx * size), top: round1(HULL_TOP + HULL_SHARE / 2 - box.cy * size) };
}

/** Holes for the open review findings and patches for the fix rounds, at spots that depend only on the slug. */
export function hullMarks(slug: string, holes: number, rounds: number, frame: HullFrame): HullMark[] {
  // The spots are shares of the picture's side from its centre, as the scene places them.
  const at = (spot: { x: number; y: number }) => ({
    left: Math.round((frame.left + frame.size / 2 + spot.x * frame.size) * 10) / 10,
    top: Math.round((frame.top + frame.size / 2 + spot.y * frame.size) * 10) / 10,
  });
  const marks: HullMark[] = patchSpots(slug, rounds).map((spot, index) => ({
    kind: "patch",
    ...at(spot),
    title: `Круг исправления ${index + 1}`,
  }));
  const count = Math.max(0, Math.min(MAX_HOLES, Math.floor(holes)));
  let seed = 0;
  for (let i = 0; i < slug.length; i++) seed = (seed * 31 + slug.charCodeAt(i)) >>> 0;
  for (let i = 0; i < count; i++) {
    const spot = HOLE_SPOTS[(seed + i) % HOLE_SPOTS.length]!;
    marks.push({ kind: "hole", ...at(spot), title: "Открытое замечание ревью" });
  }
  return marks;
}

/** «исправлений 2 · замечаний 2» under the picture; empty for a whole hull. */
export function damageLine(holes: number, rounds: number): string {
  const parts = [];
  if (rounds > 0) parts.push(`исправлений ${Math.min(MAX_PATCHES, rounds)}`);
  if (holes > 0) parts.push(`замечаний ${Math.min(MAX_HOLES, holes)}`);
  return parts.join(" · ");
}


// The task's papers, in plain words.

export interface PaperRow {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}

export interface Papers {
  /** Always on the card. */
  main: PaperRow[];
  /** Under «Все параметры». */
  more: PaperRow[];
}

export function papersOf(task: TaskSummary, limits: TaskLimits | null | undefined, cargo: Cargo | null | undefined, now: number): Papers {
  const session = task.kind === "session";
  const captain = session || !task.account ? EXECUTORS[task.executor] : `${EXECUTORS[task.executor]} · ${task.account}`;
  const main: PaperRow[] = [
    { label: "Исполнитель", value: captain },
    { label: "Модель", value: task.model ?? "—", mono: task.model !== null },
    { label: "Усилие", value: task.effort ?? "—" },
  ];
  const more: PaperRow[] = [];
  if (!session) {
    main.push({ label: "Ревьюер", value: task.reviewer ? EXECUTORS[task.reviewer] : "—" });
    main.push({ label: "Задание", value: task.task_type ?? KINDS[task.kind] });
  }
  main.push({ label: "Запущен", value: task.created !== null ? `${formatClock(task.created, now)} · ${formatAge(task.created, now)}` : "—" });
  if (session) return { main, more };

  const check = limits?.check ?? cargo?.check?.command ?? null;
  more.push({ label: "Проверка", value: check ?? "не задана", mono: check !== null });
  const angles = limits?.review_angles ?? [];
  if (angles.length) more.push({ label: "Углы ревью", value: angles.join(", ") });
  if (limits) {
    if (task.kind !== "scout") {
      more.push({ label: "Круги исправления", value: limits.fix_rounds === null ? "—" : limits.fix_rounds === 0 ? "0: находки ревью не чинятся сами" : String(limits.fix_rounds) });
      more.push({ label: "CI", value: limits.ci_enabled ? `включён · попыток починки ${limits.ci_rounds ?? "—"}` : "выключен" });
    }
    more.push({ label: "Лимит хода", value: limits.max_turn_minutes !== null ? `${limits.max_turn_minutes} мин` : "без лимита" });
    more.push({ label: "Бюджет", value: limits.max_weekly_percent !== null ? `${percent.format(limits.max_weekly_percent)} % недели` : "без ограничения" });
    more.push({ label: "Смены аккаунта", value: refuels(limits, now) });
  }
  return { main, more };
}

function refuels(limits: TaskLimits, now: number): string {
  const rotations = limits.rotations;
  const last = rotations[rotations.length - 1];
  return last ? `${rotations.length} · последняя в ${formatClock(last.at, now)}` : "не было";
}

// The route.

export type StopId = "yard" | "range" | "inspection" | "gate" | "roadstead" | "sun";

export const STOPS: readonly { id: StopId; name: string; note: string; art: ArtName }[] = [
  { id: "yard", name: "Работа", note: "", art: "stationYard" },
  { id: "range", name: "Проверка", note: "", art: "planetRange" },
  { id: "inspection", name: "Ревью", note: "", art: "stationInspection" },
  { id: "gate", name: "CI", note: "", art: "gate" },
  { id: "roadstead", name: "Приёмка", note: "", art: "planetRoadstead" },
  { id: "sun", name: "В main", note: "", art: "sun" },
];

export interface RouteStop {
  id: StopId;
  name: string;
  note: string;
  art: ArtName;
  state: "past" | "here" | "ahead";
}

export interface Route {
  stops: RouteStop[];
  /** The sleeping ship stands in the cryo field beside the route; null for a ship that does not sleep. */
  cryo: { wakes: string | null } | null;
  /** The closed ship has no stop: its voyage is over. */
  ended: boolean;
  line: string;
}

/**
 * The ship's stop on the route, from its phase and column as the scene places it. A stopped ship's stop says that it
 * waits for you, so that the strip, the recorder's «ждал тебя» and the state never disagree.
 */
export function routeOf(task: TaskSummary, now: number): Route {
  const place = task.kind === "session" ? null : placeOf(task);
  const ended = task.column === "closed";
  const sleeping = place === "cryo";
  const waiting = !task.alive && !ended && task.kind !== "session";
  const here = STOPS.findIndex((stop) => stop.id === place);
  const stops = STOPS.map((stop, index) => {
    const state = index === here ? ("here" as const) : here >= 0 && index < here ? ("past" as const) : ("ahead" as const);
    return { ...stop, note: state === "here" && waiting ? "ждёт тебя" : stop.note, state };
  });
  const wakes = task.sleeping_until !== null ? formatClock(task.sleeping_until, now) : null;
  let line: string;
  if (ended) line = "Задача закрыта";
  else if (sleeping) line = `Спит до сброса лимита${wakes ? `, проснётся в ${wakes}` : ""}`;
  else if (here >= 0 && task.alive) line = `Сейчас: ${STOPS[here]!.name} · ${PHASES[task.phase]}`;
  else if (here >= 0 && place === "roadstead") line = "Готово: ждёт твоей приёмки";
  else if (here >= 0) line = `Стоит на этапе «${STOPS[here]!.name}»: ход кончился, дальше — по твоему слову`;
  else line = "Этап неизвестен";
  return { stops, cryo: sleeping ? { wakes } : null, ended, line };
}

export interface Loop {
  kind: "fix" | "ci";
  done: number;
  allowed: number | null;
  text: string;
}

/** The loops beside the route: fix rounds while any are allowed or done, and CI repairs while CI is on. */
export function loopsOf(task: TaskSummary, limits: TaskLimits | null | undefined, cargo: Cargo | null | undefined): Loop[] {
  if (!bridgeView(task).loops) return [];
  const done = roundsOf(task, limits);
  const allowed = limits?.fix_rounds ?? null;
  const loops: Loop[] = [];
  if ((allowed ?? 0) > 0 || done > 0) loops.push({ kind: "fix", done, allowed, text: `↺ круг исправления ${done}${allowed !== null ? ` из ${allowed}` : ""}` });
  if (limits?.ci_enabled) {
    const tries = cargo?.ci?.rounds ?? 0;
    const max = limits.ci_rounds;
    loops.push({ kind: "ci", done: tries, allowed: max, text: `↺ попытка CI ${tries}${max !== null ? ` из ${max}` : ""}` });
  }
  return loops;
}

// Meters: only those with something to show.

export interface Meter {
  id: "turn" | "fuel" | "repairs" | "gate";
  label: string;
  value: string;
  /** How full the bar is, 0 to 1; null draws no bar. */
  share: number | null;
  /** The bar turns warm near its limit and red at it. */
  tone: "ok" | "warn" | "bad";
}

const percent = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

function meter(id: Meter["id"], label: string, value: string, share: number | null): Meter {
  const level = share ?? 0;
  return { id, label, value, share: share === null ? null : Math.max(0, Math.min(1, share)), tone: level >= 1 ? "bad" : level >= 0.75 ? "warn" : "ok" };
}

const ratio = (done: number, allowed: number | null) => (allowed ? done / allowed : allowed === 0 && done > 0 ? 1 : null);

/**
 * The card's meters: the turn's time while it runs, the task's budget once it spent some, the fix rounds while any are
 * allowed or done, and the CI repairs while CI is on. A meter without data is left out, never drawn empty.
 */
export function metersOf(task: TaskSummary, limits: TaskLimits | null | undefined, cargo: Cargo | null | undefined, now: number): Meter[] {
  const view = bridgeView(task);
  if (!view.gauges) return [];
  const result: Meter[] = [];
  const start = task.phase_started_at;
  const max = limits?.max_turn_minutes ?? null;
  if (task.alive && start !== null && task.column !== "sleeping") {
    const minutes = Math.max(0, Math.floor((now - start) / 60));
    result.push(meter("turn", "Время хода", max !== null ? `${minutes} из ${max} мин` : `${minutes} мин`, max ? minutes / max : null));
  }
  const used = limits?.weekly_used_percent ?? null;
  const budget = limits?.max_weekly_percent ?? null;
  if (used !== null && (used > 0 || budget !== null)) {
    const value = budget !== null ? `${percent.format(used)} из ${percent.format(budget)} % недели` : `${percent.format(used)} % недели`;
    result.push(meter("fuel", "Бюджет задачи", value, budget ? used / budget : null));
  }
  if (!view.repairGauges || !limits) return result;
  if ((limits.fix_rounds ?? 0) > 0 || limits.review_rounds > 0) {
    const value = limits.fix_rounds !== null ? `${limits.review_rounds} из ${limits.fix_rounds}` : String(limits.review_rounds);
    result.push(meter("repairs", "Круги исправления", value, ratio(limits.review_rounds, limits.fix_rounds)));
  }
  if (limits.ci_enabled) {
    const tries = cargo?.ci?.rounds ?? 0;
    result.push(meter("gate", "Попытки починки CI", limits.ci_rounds !== null ? `${tries} из ${limits.ci_rounds}` : String(tries), ratio(tries, limits.ci_rounds)));
  }
  return result;
}
