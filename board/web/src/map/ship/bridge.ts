// The ship's bridge: what the screen of one task shows, from the task, its detail and its limits. The decks only draw it.

import { coarseSpan, formatAge, formatClock, formatDuration } from "../../lib/format";
import { ACTIVITY, EXECUTORS, KINDS, PHASES, findingsLabel, problemLabel, stopLabel, type Tone } from "../../lib/labels";
import { recommendedOrder, type OrderTone } from "../../lib/orders";
import type { Cargo, TaskLimits, TaskSummary } from "../../types";
import type { ArtName } from "../art";
import { MAX_PATCHES, hullOf, patchSpots, type Hull } from "../fleet";
import { placeOf } from "../placement";

/** Which decks the screen has: a session is a flagship without route, gauges or orders; a scout has no repair loops. */
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
  if (task.column === "closed") return { text: "рейс окончен", tone: "dim" };
  if (task.kind === "session") return task.alive ? { text: "идёт ход", tone: "work" } : { text: "ждёт тебя", tone: "ready" };
  if (task.column === "sleeping") return { text: "спит", tone: "sleep" };
  if (task.column === "review_me") return { text: "на рейде · готово", tone: "ready" };
  if (task.column === "attention") {
    if (task.result_status === "needs_decision") return { text: "ждёт решения", tone: "wait" };
    const tone: StateTone = task.result_status === "partial" || task.outcome === "stopped" ? "wait" : "bad";
    return { text: problemLabel(task) ?? "нужно внимание", tone };
  }
  return { text: `в работе · ${PHASES[task.phase]}`, tone: "work" };
}

/** The line «what next»: the reason of the order the state calls for, in its tone. */
export function nextLine(task: TaskSummary, now: number): { text: string; tone: OrderTone } {
  const order = recommendedOrder(task, now);
  if (order) return { text: order.reason, tone: order.tone };
  if (task.column === "closed") return { text: "Рейс окончен: задача закрыта, приказов не нужно", tone: "muted" };
  return task.alive
    ? { text: "Сессия ведёт ход: ответить ей можно в приложении Claude", tone: "muted" }
    : { text: "Сессия ждёт тебя в приложении Claude", tone: "warn" };
}

// The ship.

const HULL_NAMES: Record<Hull, string> = { light: "Лёгкий корабль", frigate: "Фрегат", cruiser: "Крейсер", scout: "Разведчик", flagship: "Флагман" };

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
  const kind = hullOf(task);
  if (kind === "flagship" || kind === "scout") return HULL_NAMES[kind];
  return `${HULL_NAMES[kind]} · ${task.executor === "codex" ? "синий" : "медный"} корпус`;
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

/** The picture fills this share of its frame, centred. */
const ART_SHARE = 0.82;
const toPercent = (share: number) => Math.round((50 + share * ART_SHARE * 100) * 10) / 10;

/** Holes for the open review findings and patches for the fix rounds, at spots that depend only on the slug. */
export function hullMarks(slug: string, holes: number, rounds: number): HullMark[] {
  const marks: HullMark[] = patchSpots(slug, rounds).map((spot, index) => ({
    kind: "patch",
    left: toPercent(spot.x),
    top: toPercent(spot.y),
    title: `Заплата: круг исправления ${index + 1}`,
  }));
  const count = Math.max(0, Math.min(MAX_HOLES, Math.floor(holes)));
  let seed = 0;
  for (let i = 0; i < slug.length; i++) seed = (seed * 31 + slug.charCodeAt(i)) >>> 0;
  for (let i = 0; i < count; i++) {
    const spot = HOLE_SPOTS[(seed + i) % HOLE_SPOTS.length]!;
    marks.push({ kind: "hole", left: toPercent(spot.x), top: toPercent(spot.y), title: "Открытая находка ревью" });
  }
  return marks;
}

/** «заплат 2 · пробоин 2» under the picture; empty for a whole hull. */
export function damageLine(holes: number, rounds: number): string {
  const parts = [];
  if (rounds > 0) parts.push(`заплат ${Math.min(MAX_PATCHES, rounds)}`);
  if (holes > 0) parts.push(`пробоин ${Math.min(MAX_HOLES, holes)}`);
  return parts.join(" · ");
}

/** What the ship does now, under its picture: its latest activity while it works, else why it stands. */
export function activityLine(task: TaskSummary, now: number): string {
  const activity = task.alive ? task.activity : null;
  if (activity) {
    const age = activity.at !== null ? ` · ${formatAge(activity.at, now)}` : "";
    return `${ACTIVITY[activity.kind].label}: ${activity.text}${age}`;
  }
  if (task.column === "sleeping") return task.sleeping_until !== null ? `спит до ${formatClock(task.sleeping_until, now)}` : "спит";
  if (task.alive) return "нет активности";
  return task.summary ?? problemLabel(task) ?? "стоит";
}

export interface PaperRow {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}

/** The ship's papers: who flies it, on what, for what, who inspects it, how it is tested, when it was launched. */
export function papersOf(task: TaskSummary, limits: TaskLimits | null | undefined, cargo: Cargo | null | undefined, now: number): PaperRow[] {
  const session = task.kind === "session";
  const captain = session || !task.account ? EXECUTORS[task.executor] : `${EXECUTORS[task.executor]} · ${task.account}`;
  const rows: PaperRow[] = [
    { label: "Капитан", value: captain },
    { label: "Двигатель", value: task.model ?? "—", mono: true },
    { label: "Форсаж", value: task.effort ?? "—" },
  ];
  if (!session) {
    rows.push({ label: "Задание", value: task.task_type ?? KINDS[task.kind] });
    const angles = limits?.review_angles ?? [];
    const reviewer = task.reviewer ? [EXECUTORS[task.reviewer], angles.join(", ")].filter(Boolean).join(" · ") : "—";
    rows.push({ label: "Инспектор", value: reviewer });
    const check = limits?.check ?? cargo?.check?.command ?? null;
    rows.push({ label: "Проверка", value: check ?? "—", mono: check !== null });
  }
  rows.push({ label: "Спущен", value: task.created !== null ? `${formatClock(task.created, now)} · ${formatAge(task.created, now)}` : "—" });
  if (!session) rows.push({ label: "Заправки", value: refuels(limits, now) });
  return rows;
}

function refuels(limits: TaskLimits | null | undefined, now: number): string {
  if (!limits) return "—";
  const rotations = limits.rotations;
  const last = rotations[rotations.length - 1];
  return last ? `${rotations.length} · смена аккаунта в ${formatClock(last.at, now)}` : "0";
}

// The route.

export type StopId = "yard" | "range" | "inspection" | "gate" | "roadstead" | "sun";

export const STOPS: readonly { id: StopId; name: string; note: string; art: ArtName }[] = [
  { id: "yard", name: "Верфь", note: "ход, правки", art: "stationYard" },
  { id: "range", name: "Полигон", note: "проверка", art: "planetRange" },
  { id: "inspection", name: "Инспекция", note: "ревью", art: "stationInspection" },
  { id: "gate", name: "Врата", note: "CI", art: "gate" },
  { id: "roadstead", name: "Рейд", note: "твоя приёмка", art: "planetRoadstead" },
  { id: "sun", name: "Солнце", note: "слит в main", art: "sun" },
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

/** The ship's stop on the route, from its phase and column as the scene places it. */
export function routeOf(task: TaskSummary, now: number): Route {
  const place = task.kind === "session" ? null : placeOf(task);
  const ended = task.column === "closed";
  const sleeping = place === "cryo";
  const here = STOPS.findIndex((stop) => stop.id === place);
  const stops = STOPS.map((stop, index) => ({ ...stop, state: index === here ? ("here" as const) : here >= 0 && index < here ? ("past" as const) : ("ahead" as const) }));
  const wakes = task.sleeping_until !== null ? formatClock(task.sleeping_until, now) : null;
  let line: string;
  if (ended) line = "Рейс окончен: корабль больше не на маршруте";
  else if (sleeping) line = `Спит в Криополе${wakes ? `, проснётся в ${wakes}` : ""}`;
  else if (here >= 0) line = task.alive ? `Сейчас: ${STOPS[here]!.name}, ${PHASES[task.phase]}` : `Стоит: ${STOPS[here]!.name}`;
  else line = "Корабль не на маршруте";
  return { stops, cryo: sleeping ? { wakes } : null, ended, line };
}

export interface Loop {
  kind: "fix" | "ci";
  done: number;
  allowed: number | null;
  text: string;
}

/** The loops over the route: fix rounds back from the inspection, and CI repairs back from the gate while CI is on. */
export function loopsOf(task: TaskSummary, limits: TaskLimits | null | undefined, cargo: Cargo | null | undefined): Loop[] {
  if (!bridgeView(task).loops) return [];
  const done = roundsOf(task, limits);
  const allowed = limits?.fix_rounds ?? null;
  const loops: Loop[] = [{ kind: "fix", done, allowed, text: `круг исправления ${done}${allowed !== null ? ` из ${allowed}` : ""}` }];
  if (limits?.ci_enabled) {
    const tries = cargo?.ci?.rounds ?? 0;
    const max = limits.ci_rounds;
    loops.push({ kind: "ci", done: tries, allowed: max, text: `попытка CI ${tries}${max !== null ? ` из ${max}` : ""}` });
  }
  return loops;
}

// Gauges.

export interface Gauge {
  id: "turn" | "fuel" | "repairs" | "gate";
  label: string;
  /** «—» without data, never a zero it does not know. */
  value: string;
  /** How full the dial is, 0 to 1; null draws an empty dial. */
  share: number | null;
  /** The dial turns warm near its limit and red at it. */
  tone: "ok" | "warn" | "bad";
  hint: string;
}

const NONE = "—";
const percent = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

function gauge(id: Gauge["id"], label: string, value: string, share: number | null, hint: string): Gauge {
  const level = share === null ? 0 : share;
  return { id, label, value, share: share === null ? null : Math.max(0, Math.min(1, share)), tone: level >= 1 ? "bad" : level >= 0.75 ? "warn" : "ok", hint };
}

const ratio = (done: number, allowed: number | null) => (allowed ? done / allowed : allowed === 0 && done > 0 ? 1 : null);
const counted = (done: number, allowed: number | null) => (allowed !== null ? `${done} / ${allowed}` : String(done));

/** The four gauges, or two for a scout: the turn's time, the task's fuel, the repair rounds and the gate's attempts. */
export function gaugesOf(task: TaskSummary, limits: TaskLimits | null | undefined, cargo: Cargo | null | undefined, now: number): Gauge[] {
  const view = bridgeView(task);
  if (!view.gauges) return [];
  const result: Gauge[] = [];

  const start = task.phase_started_at;
  const max = limits?.max_turn_minutes ?? null;
  if (task.alive && start !== null && task.column !== "sleeping") {
    const minutes = Math.max(0, Math.floor((now - start) / 60));
    result.push(gauge("turn", "Время хода", max !== null ? `${minutes} / ${max} мин` : `${minutes} мин`, max ? minutes / max : null, `идёт с ${formatClock(start, now)}`));
  } else {
    result.push(gauge("turn", "Время хода", NONE, null, max !== null ? `лимит ${max} мин` : "ход не идёт"));
  }

  const used = limits?.weekly_used_percent ?? null;
  const budget = limits?.max_weekly_percent ?? null;
  if (used === null) result.push(gauge("fuel", "Топливо задачи", NONE, null, "доля недели аккаунта"));
  else {
    const value = budget !== null ? `${percent.format(used)} / ${percent.format(budget)} %` : `${percent.format(used)} %`;
    result.push(gauge("fuel", "Топливо задачи", value, budget ? used / budget : null, budget !== null ? "доля недели аккаунта" : "без бюджета"));
  }

  if (!view.repairGauges) return result;
  if (!limits) {
    result.push(gauge("repairs", "Круги ремонта", NONE, null, "после инспекции"));
    result.push(gauge("gate", "Попытки врат", NONE, null, "починки CI"));
    return result;
  }
  result.push(gauge("repairs", "Круги ремонта", counted(limits.review_rounds, limits.fix_rounds), ratio(limits.review_rounds, limits.fix_rounds), "после инспекции"));
  if (!limits.ci_enabled) result.push(gauge("gate", "Попытки врат", NONE, null, "CI выключен"));
  else {
    const tries = cargo?.ci?.rounds ?? 0;
    result.push(gauge("gate", "Попытки врат", counted(tries, limits.ci_rounds), ratio(tries, limits.ci_rounds), "починки CI"));
  }
  return result;
}

// The hull: what the checks found, by station.

export interface HullItem {
  mark: string;
  tone: Tone;
  text: string;
  where: string | null;
}

export interface HullRow {
  key: "check" | "review" | "ci" | "base" | "stop";
  title: string;
  aside: string;
  tone: Tone;
  /** A tooltip, such as the check's command. */
  hint?: string;
  items: HullItem[];
  /** Findings past the first MAX_FINDINGS. */
  more: number;
}

export interface HullReport {
  rows: HullRow[];
  remaining: string[];
  questions: string[];
}

/** The hull lists at most this many findings, and «ещё N» for the rest. */
export const MAX_FINDINGS = 5;

const failed = (outcome: string | null | undefined) => outcome === "failed" || outcome === "timeout";
const severityTone = (severity: string): Tone => (/^P[01]$/.test(severity) ? "bad" : severity === "P2" ? "warn" : "muted");
const CI_WORDS: Record<string, string> = { pending: "CI идёт", passed: "CI прошёл", failed: "CI упал", timeout: "CI не уложился во время", skipped: "CI пропущен", none: "проверок нет" };

export function hullReport(cargo: Cargo | null | undefined, now: number): HullReport {
  const rows: HullRow[] = [];
  if (!cargo) return { rows, remaining: [], questions: [] };
  const check = cargo.check;
  if (check) {
    const word = check.outcome === "passed" ? "пройдена" : check.outcome === "failed" ? "упала" : check.outcome === "timeout" ? "не уложилась во время" : check.outcome;
    const aside = [check.at !== null ? formatClock(check.at, now) : null, check.seconds !== null ? formatDuration(check.seconds) : null, failed(check.outcome) && check.exit !== null ? `код ${check.exit}` : null];
    rows.push({ key: "check", title: `Полигон: проверка ${word}`, aside: aside.filter(Boolean).join(" · "), tone: check.outcome === "passed" ? "ok" : failed(check.outcome) ? "bad" : "muted", hint: check.command, items: [], more: 0 });
  }
  const review = cargo.review;
  if (review) {
    const count = review.findings.length;
    const head = review.verdict === "clean" && !count ? "чисто" : count ? findingsLabel(count) : review.verdict === "defects" ? "есть замечания" : "без итога";
    const tone: Tone = head === "чисто" ? "ok" : review.findings.some((finding) => severityTone(finding.severity) === "bad") ? "bad" : count || review.verdict === "defects" ? "warn" : "muted";
    rows.push({
      key: "review",
      title: `Инспекция: ${head}`,
      aside: review.reviews > 0 ? `${review.reviews} ревью` : "",
      tone,
      hint: review.summary ?? undefined,
      items: review.findings.slice(0, MAX_FINDINGS).map((finding) => ({
        mark: finding.severity,
        tone: severityTone(finding.severity),
        text: finding.title,
        where: finding.file ? `${finding.file}${finding.line !== null ? `:${finding.line}` : ""}` : null,
      })),
      more: Math.max(0, count - MAX_FINDINGS),
    });
  }
  const ci = cargo.ci;
  if (ci) {
    const bad = ci.failed > 0 || failed(ci.outcome);
    const word = ci.failed > 0 ? "CI упал" : ci.outcome ? (CI_WORDS[ci.outcome] ?? `CI: ${ci.outcome}`) : "CI без итога";
    const aside = [ci.total > 0 ? `прошло ${ci.passed} из ${ci.total}` : null, ci.seconds !== null ? coarseSpan(ci.seconds) : null];
    rows.push({
      key: "ci",
      title: `Врата: ${word}`,
      aside: aside.filter(Boolean).join(" · "),
      tone: bad ? "bad" : ci.outcome === "passed" ? "ok" : "muted",
      hint: ci.reason ?? undefined,
      items: ci.failing.map((name) => ({ mark: "✕", tone: "bad", text: name, where: null })),
      more: 0,
    });
  }
  const base = cargo.base;
  if (base) {
    const conflict = base.outcome === "conflict";
    const word = conflict ? "конфликт" : base.outcome === "passed" ? "слита чисто" : base.outcome === "skipped" ? "не сливалась" : base.outcome;
    rows.push({
      key: "base",
      title: `База: ${base.base} ${word}`,
      aside: base.files.length ? `файлов ${base.files.length}` : "",
      tone: conflict ? "bad" : base.outcome === "passed" ? "ok" : "muted",
      items: conflict ? base.files.map((file) => ({ mark: "≠", tone: "bad", text: file, where: null })) : [],
      more: 0,
    });
  }
  if (cargo.stop) {
    const stop = stopLabel(cargo.stop);
    rows.push({ key: "stop", title: `Остановка: ${stop.label}`, aside: "", tone: stop.tone, hint: cargo.stop, items: [], more: 0 });
  }
  return { rows, remaining: cargo.remaining ?? [], questions: cargo.questions ?? [] };
}
