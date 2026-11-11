// The flight recorder: the ship's whole voyage as a tape of stops in time, from the log's completed phases
// (board/CONTRACT.md, LogEvent), the turn's live phase, the lead's orders, the refuels and the verdicts. The deck only
// draws it.

import { coarseSpan } from "../../lib/format";
import type { LogEvent, TaskLimits, TaskMessage, TaskSummary } from "../../types";

export type TapeStop = "yard" | "range" | "inspection" | "gate" | "wait" | "cryo";

/**
 * The legend: every stop the tape can show, in the route's order, with its colour; `legend` names it the plain way
 * first. The time a stopped ship waited for you is its own stripe, «ждал тебя», wherever it stood: the route strip
 * shows where.
 */
export const TAPE_STOPS: readonly { id: TapeStop; name: string; legend: string; color: string }[] = [
  { id: "yard", name: "Работа", legend: "работа", color: "#a8653a" },
  { id: "range", name: "Проверка", legend: "проверка", color: "#4f9a62" },
  { id: "inspection", name: "Ревью", legend: "ревью", color: "#7b5bb8" },
  { id: "gate", name: "CI", legend: "CI", color: "#4a78c9" },
  { id: "wait", name: "Ждал тебя", legend: "ждал тебя", color: "#c9a23f" },
  { id: "cryo", name: "Сон", legend: "сон", color: "#5aa7c4" },
];

const NAMES = Object.fromEntries(TAPE_STOPS.map((stop) => [stop.id, stop.name])) as Record<TapeStop, string>;

/** The stop of a completed phase; the final `turn` row repeats its phase's outcome and gets none. */
const PHASE_STOPS: Readonly<Record<string, TapeStop>> = { work: "yard", fix: "yard", scout: "yard", check: "range", base_check: "range", review: "inspection" };

/** The stop of the live phase, as the map places the ship. */
function liveStop(phase: TaskSummary["phase"]): TapeStop {
  switch (phase) {
    case "sleeping":
      return "cryo";
    case "check":
      return "range";
    case "review":
      return "inspection";
    case "ci":
      return "gate";
    default:
      return "yard";
  }
}

const DAY = 86400;
/** The log keeps 31 days, and the server refuses a longer window. */
const LOG_DAYS = 31;

/** The window to ask the log for: from the ship's launch, but not earlier than 31 days back, to now. */
export function recorderWindow(created: number | null, now: number): { since: number; until: number } {
  const earliest = now - LOG_DAYS * DAY + 60;
  return { since: created !== null ? Math.min(now, Math.max(created, earliest)) : earliest, until: now };
}

/** The log's name for the ship: an archived record without its `-YYYYMMDDTHHMMSSZ` suffix. */
export const logSlug = (slug: string) => slug.replace(/-\d{8}T\d{6}Z$/, "");

export interface TapeSegment {
  stop: TapeStop;
  from: number;
  to: number;
  /** The phase going on now: the tape hatches it. */
  live: boolean;
  /** The phase came back failed, out of time or with defects. */
  failed: boolean;
  title: string;
  /** Where it stands on the tape, in percent. */
  left: number;
  width: number;
}

export type MarkKind = "say" | "fuel" | "verdict" | "fail";

export interface TapeMark {
  kind: MarkKind;
  at: number;
  label: string;
  title: string;
  left: number;
  /** Close marks stand in rows over one another, 0 the lowest. */
  lane: number;
}

export interface Tape {
  /** The log dropped earlier rows: the tape starts at the ship's first event, not at its launch. */
  truncated: boolean;
  start: number;
  end: number;
  segments: TapeSegment[];
  marks: TapeMark[];
}

const OUTCOMES: Readonly<Record<string, string>> = {
  completed: "завершено",
  passed: "пройдено",
  failed: "упало",
  timeout: "не уложилось во время",
  defects: "есть замечания",
  clean: "чисто",
  budget_exhausted: "бюджет исчерпан",
  stuck: "застрял",
  stopped: "остановлен",
  skipped: "пропущено",
  conflict: "конфликт",
};

const FAILED = new Set(["failed", "timeout", "defects"]);

/** What the phase came back with; a review with findings came back with defects. */
function resultOf(event: LogEvent): string | null {
  if (event.phase === "review" || event.kind === "review") {
    if (event.verdict === "defects" || (event.findings ?? 0) > 0) return "defects";
    if (event.verdict === "clean" || event.findings === 0) return "clean";
  }
  return event.outcome;
}

/** «Работа, ход 1», but «Проверка» or «Ревью · deep» alone: a phase that names its stop needs no second name. */
function segmentHead(stop: TapeStop, label: string): string {
  const name = NAMES[stop];
  return label.toLowerCase().startsWith(name.toLowerCase()) ? name + label.slice(name.length) : `${name}, ${label}`;
}

function phaseLabel(event: LogEvent): string {
  switch (event.phase) {
    case "work":
      return event.turn !== null ? `ход ${event.turn}` : "ход";
    case "fix":
      return event.round !== null ? `исправление, круг ${event.round}` : "исправление";
    case "check":
      return "проверка";
    case "base_check":
      return "проверка с базой";
    case "review":
      return event.angle ? `ревью · ${event.angle}` : "ревью";
    default:
      return "разведка";
  }
}

function resultLabel(event: LogEvent, result: string | null): string {
  if (result === null) return "без итога";
  const word = OUTCOMES[result] ?? result;
  return result === "defects" && event.findings ? `${word}: ${event.findings}` : word;
}

const begin = (event: LogEvent) => event.started ?? event.at;
const span = (from: number, to: number) => coarseSpan(Math.max(0, to - from));

type Bare = Omit<TapeSegment, "left" | "width">;

/**
 * The tape's stops: every completed phase but the final `turn` rows; «ждал тебя» after each finished turn, until the
 * ship's next event; and, while the ship works or sleeps, its live phase until `now`.
 */
export function tapeSegments(events: readonly LogEvent[], task: TaskSummary, now: number): Bare[] {
  const rows = [...events].sort((a, b) => begin(a) - begin(b) || a.at - b.at);
  const segments: Bare[] = [];
  for (const event of rows) {
    const stop = event.phase !== null ? PHASE_STOPS[event.phase] : undefined;
    if (!stop || event.started === null || event.kind === "verdict") continue;
    const result = resultOf(event);
    segments.push({
      stop,
      from: event.started,
      to: Math.max(event.started, event.at),
      live: false,
      failed: result !== null && FAILED.has(result),
      title: `${segmentHead(stop, phaseLabel(event))}: ${span(event.started, event.at)} · ${resultLabel(event, result)}`,
    });
  }

  const lastEnd = Math.max(-Infinity, ...rows.map((event) => event.at));
  const working = (task.alive || task.column === "sleeping") && task.phase_started_at !== null;
  let live: Bare | null = null;
  if (working) {
    const stop = liveStop(task.phase);
    const from = Math.min(now, Math.max(task.phase_started_at!, lastEnd));
    const what = stop === "cryo" ? "спит" : "идёт";
    live = { stop, from, to: now, live: true, failed: false, title: `${NAMES[stop]}: ${what} ${span(from, now)}` };
  }

  // «Ждал тебя»: from a finished turn to the next thing that happened, or to now while the ship still waits.
  const closedAt = task.column === "closed" ? Math.max(lastEnd, task.updated_at) : now;
  for (const turn of rows) {
    if (turn.phase !== "turn") continue;
    const next = rows.filter((event) => event !== turn && begin(event) >= turn.at).map(begin);
    if (live) next.push(live.from);
    const to = next.length ? Math.min(...next) : working ? turn.at : closedAt;
    if (to > turn.at) {
      const still = !working && task.column !== "closed" && to >= now;
      segments.push({ stop: "wait", from: turn.at, to, live: false, failed: false, title: `${still ? "Ждёт тебя" : "Ждал тебя"} ${span(turn.at, to)}` });
    }
  }
  if (live) segments.push(live);
  return segments.sort((a, b) => a.from - b.from || Number(a.live) - Number(b.live));
}

const VERDICTS: Readonly<Record<string, string>> = { accepted: "принят", revised: "принят после правок", redone: "на переделку", dropped: "отброшен" };

const oneLine = (text: string, limit = 120) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

/** The marks over the tape: the lead's orders, the refuels, the verdicts and the failed stops, by time. */
export function tapeMarks(
  events: readonly LogEvent[],
  segments: readonly Bare[],
  messages: readonly TaskMessage[],
  rotations: TaskLimits["rotations"],
): Omit<TapeMark, "left" | "lane">[] {
  const marks: Omit<TapeMark, "left" | "lane">[] = [];
  for (const message of messages) {
    if (message.source === "lead") marks.push({ kind: "say", at: message.at, label: "▼ указание", title: `Указание: ${oneLine(message.text)}` });
  }
  for (const rotation of rotations) {
    if (!rotation.to) continue;
    const change = rotation.from ? `${rotation.from} → ${rotation.to}` : rotation.to;
    marks.push({ kind: "fuel", at: rotation.at, label: "⇄ аккаунт", title: `Смена аккаунта ${change}${rotation.reason ? ` · ${rotation.reason}` : ""}` });
  }
  for (const event of events) {
    if (event.kind !== "verdict") continue;
    const word = event.verdict ? (VERDICTS[event.verdict] ?? event.verdict) : "без отметки";
    marks.push({ kind: "verdict", at: event.at, label: "✓ вердикт", title: `Вердикт: ${word}${event.note ? ` · ${oneLine(event.note)}` : ""}` });
  }
  for (const segment of segments) {
    if (segment.failed) marks.push({ kind: "fail", at: segment.to, label: "✗", title: segment.title });
  }
  return marks.sort((a, b) => a.at - b.at);
}

/** Marks nearer than this, in percent of the tape, stand in different rows. */
const MARK_ROOM = 9;
const LANES = 3;

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The whole tape: its stops and marks placed between the launch (or the first record) and now (or the last record).
 * When the log came `truncated`, the launch is not on it: the tape starts at the first record.
 */
export function tapeOf(
  events: readonly LogEvent[],
  task: TaskSummary,
  messages: readonly TaskMessage[],
  rotations: TaskLimits["rotations"],
  now: number,
  truncated = false,
): Tape {
  const bare = tapeSegments(events, task, now);
  const times = [...bare.flatMap((segment) => [segment.from, segment.to]), ...events.map((event) => event.at)];
  const created = !truncated && task.created !== null && task.created >= now - LOG_DAYS * DAY ? task.created : Infinity;
  const start = Math.min(created, ...times);
  const closed = task.column === "closed";
  const end = Math.max(start + 60, closed ? Math.max(task.updated_at, ...times) : Math.max(now, ...times));
  const inside = (at: number) => at >= start && at <= end;
  const at = (time: number) => round2(((Math.max(start, Math.min(end, time)) - start) / (end - start)) * 100);
  const segments = bare.map((segment) => ({ ...segment, left: at(segment.from), width: round2(at(segment.to) - at(segment.from)) }));
  const lastLeft: number[] = [];
  const marks = tapeMarks(events, bare, messages, rotations)
    .filter((mark) => inside(mark.at))
    .map((mark) => {
      const left = at(mark.at);
      let lane = lastLeft.findIndex((previous) => left - previous >= MARK_ROOM);
      if (lane < 0) lane = lastLeft.length < LANES ? lastLeft.length : LANES - 1;
      lastLeft[lane] = left;
      return { ...mark, left, lane };
    });
  return { truncated, start, end, segments, marks };
}

/**
 * The tape the deck draws once the log is read, or null when there is nothing to draw. A ship on its first phase has
 * no event in the log yet, but its live segment already makes a tape.
 */
export function recordedTape(
  events: readonly LogEvent[] | null,
  task: TaskSummary,
  messages: readonly TaskMessage[],
  rotations: TaskLimits["rotations"],
  now: number,
  truncated = false,
): Tape | null {
  if (events === null) return null;
  const tape = tapeOf(events, task, messages, rotations, now, truncated);
  return tape.segments.length || tape.marks.length ? tape : null;
}

const SUM_PARTS: readonly { stops: readonly TapeStop[]; word: string }[] = [
  { stops: ["yard"], word: "работа" },
  { stops: ["range", "inspection"], word: "проверки и ревью" },
  { stops: ["gate"], word: "CI" },
  { stops: ["wait"], word: "ждал тебя" },
  { stops: ["cryo"], word: "сон" },
];

/** «36 мин всего: работа 3 мин, ждал тебя 33 мин» under the tape; overlapping segments are counted once each. */
export function tapeSummary(tape: Pick<Tape, "start" | "end" | "segments">): string {
  const parts = SUM_PARTS.map(({ stops, word }) => {
    const seconds = tape.segments.filter((segment) => stops.includes(segment.stop)).reduce((sum, segment) => sum + Math.max(0, segment.to - segment.from), 0);
    return seconds >= 60 ? `${word} ${coarseSpan(seconds)}` : null;
  }).filter(Boolean);
  const total = `${coarseSpan(Math.max(0, tape.end - tape.start))} всего`;
  return parts.length ? `${total}: ${parts.join(", ")}` : total;
}

// The time scale under the tape.

export interface Tick {
  left: number;
  label: string;
}

const MINUTE = 60;
const STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880, 4320, 7 * 1440].map((minutes) => minutes * MINUTE);
/**
 * Inner ticks keep this share of the tape away from its ends, where the ends' own labels stand: more for labels with
 * dates, and more at the end for «сейчас», so that a 560 px tape never overlaps them.
 */
const EDGE = 0.1;
const DATE_EDGE = 0.18;
const NOW_EDGE = 0.09;

const pad = (n: number) => String(n).padStart(2, "0");

function tickLabel(at: number, withDate: boolean): string {
  const date = new Date(at * 1000);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withDate ? `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${clock}` : clock;
}

/**
 * Four to six marks «HH:MM» from `start` to `end`: both ends and round local times between them; a voyage longer than a
 * day has dates. `nowLabel` adds «сейчас» to the end.
 */
export function tapeTicks(start: number, end: number, nowLabel = false): Tick[] {
  const length = Math.max(1, end - start);
  const withDate = length > DAY;
  const offset = -new Date(start * 1000).getTimezoneOffset() * 60;
  const edge = withDate ? DATE_EDGE : EDGE;
  const low = start + length * edge;
  const high = end - length * (edge + (nowLabel ? NOW_EDGE : 0));
  let inner: number[] | null = null;
  for (const step of STEPS) {
    const first = Math.ceil((low + offset) / step) * step - offset;
    const times: number[] = [];
    for (let time = first; time <= high; time += step) times.push(time);
    if (times.length <= 4) {
      inner = times.length >= 2 ? times : null;
      break;
    }
  }
  inner ??= [1, 2, 3].map((part) => start + (length * part) / 4);
  const place = (time: number) => round2(((time - start) / length) * 100);
  const endLabel = tickLabel(end, withDate);
  return [
    { left: 0, label: tickLabel(start, withDate) },
    ...inner.map((time) => ({ left: place(time), label: tickLabel(time, withDate) })),
    { left: 100, label: nowLabel ? `${endLabel} сейчас` : endLabel },
  ];
}
