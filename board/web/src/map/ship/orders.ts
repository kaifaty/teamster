// The ship's comms and orders: the feed of the comms room, which order groups the board server accepts for the ship
// in its state, the refit's options, and the command each order copies when the board only reads. The decks draw it.

import { ANGLES, EFFORTS, REVIEWERS, type ActionBodies, type Angle, type Effort, type SayOptions } from "../../lib/actions";
import { cleanCommand, commandSlug, optionFlags, reflectCommand, reflectSlug, reviewCommand, sayCommand, stopCommand, verdictCommand, type Verdict } from "../../lib/commands";
import { recommendedOrder } from "../../lib/orders";
import type { Cargo, TaskLimits, TaskMessage, TaskQueue, TaskSummary } from "../../types";
import { plural } from "../research";

/** An archived record's folder ends in its archive time: the server takes no order but a verdict or a reflection. */
export const archived = (slug: string) => commandSlug(slug) !== slug;

// The feed.

export interface FeedItem {
  key: string;
  /** null: the report of a ship without a time. */
  at: number | null;
  who: string;
  /** you: the human's order; sys: a station's report; agent: the captain; ask: a question that waits for an answer. */
  tone: "you" | "sys" | "agent" | "ask";
  text: string;
  /** Beside the time, e.g. the report's outcome. */
  note: string | null;
  /** An order of the queue: waiting for the end of the cycle, or dropped by it and ready to be sent again. */
  queue?: "waiting" | "dropped";
}

const SOURCES: Record<TaskMessage["source"], { who: string; tone: FeedItem["tone"] }> = {
  lead: { who: "Ты · указание", tone: "you" },
  review: { who: "Инспекция · круг исправления", tone: "sys" },
  ci: { who: "Врата · починка CI", tone: "sys" },
};

const RESULTS: Record<string, string> = { done: "сделано", partial: "сделано частично", needs_decision: "ждёт решения", blocked: "заблокирована" };

/** An order sent from the bridge, shown until the task's own messages or its queue carry it. */
export interface Echo {
  at: number;
  text: string;
  /** Sent to a busy ship: it waits in the queue. */
  queued?: boolean;
}

const same = (a: string, b: string) => a.trim() === b.trim();

/** Why the end of a cycle dropped the queue, in words about the ship. */
export const DROPPED: Record<string, string> = {
  stopped: "остановлен",
  interrupted: "прерван",
  failed: "сбой",
  budget_exhausted: "бюджет исчерпан",
  stuck: "завис",
  conflict: "конфликт",
  refused: "отказ",
  unavailable: "недоступен",
  exhausted: "лимиты исчерпаны",
  error: "ошибка",
};

/** «не доставлено · остановлен» beside a dropped order. */
export const droppedNote = (outcome: string | null) => ["не доставлено", outcome ? (DROPPED[outcome] ?? outcome) : null].filter(Boolean).join(" · ");

/**
 * The comms room's feed by time: the lead's orders and the stations' reports from `messages`, the orders the end of a
 * cycle dropped, then the captain's last report and its open questions; the orders waiting in the queue come last.
 * While the ship works, the report is the one before the current phase began.
 */
export function feedOf(
  task: TaskSummary,
  messages: readonly TaskMessage[],
  cargo: Cargo | null | undefined,
  echo: readonly Echo[] = [],
  queue: TaskQueue | null | undefined = null,
): FeedItem[] {
  const ordered = [...messages].sort((a, b) => a.at - b.at);
  const rows: { item: FeedItem; rank: number }[] = ordered.map((message, index) => ({
    item: { key: `m${index}-${message.at}`, at: message.at, ...SOURCES[message.source], text: message.text, note: typeof message.queued_at === "number" ? "из очереди" : null },
    rank: 0,
  }));
  for (const [index, order] of (queue?.dropped ?? []).entries()) {
    rows.push({ item: { key: `d${index}-${order.at}`, at: order.at, ...SOURCES.lead, text: order.text, note: droppedNote(order.outcome), queue: "dropped" }, rank: 0 });
  }
  const waiting: FeedItem[] = [...(queue?.waiting ?? [])]
    .sort((a, b) => a.at - b.at)
    .map((order, index) => ({ key: `w${index}-${order.at}`, at: order.at, ...SOURCES.lead, text: order.text, note: "в очереди", queue: "waiting" }));
  const carried = (sent: Echo) =>
    [...ordered.filter((message) => message.source === "lead"), ...(queue?.waiting ?? []), ...(queue?.dropped ?? [])].some(
      (message) => message.at >= sent.at - 5 && same(message.text, sent.text),
    );
  for (const [index, sent] of echo.entries()) {
    if (carried(sent)) continue;
    const item: FeedItem = { key: `e${index}-${sent.at}`, at: sent.at, ...SOURCES.lead, text: sent.text, note: sent.queued ? "в очереди" : "передано" };
    if (sent.queued) waiting.push({ ...item, queue: "waiting" });
    else rows.push({ item, rank: 0 });
  }
  const status = task.result_status;
  const questions = cargo?.questions ?? [];
  if (task.summary || status || questions.length) {
    const last = ordered.length ? ordered[ordered.length - 1]!.at : Infinity;
    const at = task.alive ? Math.min(task.phase_started_at ?? task.updated_at, last) : task.updated_at;
    // The report that set off the work comes before the messages of its time; a finished turn's after them.
    const rank = task.alive ? -1 : 1;
    if (task.summary || status) {
      const text = task.summary ?? RESULTS[status ?? ""] ?? status ?? "";
      rows.push({ item: { key: "report", at, who: "Капитан · доклад", tone: "agent", text, note: status ? (RESULTS[status] ?? status) : null }, rank });
    }
    const waiting = !task.alive && task.column !== "closed" && !archived(task.slug);
    for (const [index, question] of questions.entries()) {
      rows.push({
        item: { key: `q${index}`, at, who: "Капитан · вопрос", tone: waiting ? "ask" : "agent", text: question, note: waiting ? "ждёт ответа" : null },
        rank: rank + 0.5,
      });
    }
  }
  const feed = rows
    .map((row, order) => ({ ...row, order }))
    .sort((a, b) => (a.item.at ?? 0) - (b.item.at ?? 0) || a.rank - b.rank || a.order - b.order)
    .map((row) => row.item);
  return [...feed, ...waiting];
}

/** A message longer than four lines folds under «показать целиком». */
export const FOLD_LINES = 4;
export const isLong = (text: string) => text.split("\n").length > FOLD_LINES || text.length > FOLD_LINES * 90;

// The order groups.

export interface DeskView {
  /** The reply field of the comms room. */
  reply: boolean;
  /** «Передать»: the server takes `say` now; a ship at work gets the note instead, unless it queues. */
  send: boolean;
  /** «В очередь»: the ship is at work and the installed teamster queues the order until its cycle ends. */
  queue: boolean;
  /** «Приёмка»; `acceptFirst`: on the roadstead it leads and is lit. */
  accept: boolean;
  acceptFirst: boolean;
  refit: boolean;
  review: boolean;
  reflect: boolean;
  stop: boolean;
  clean: boolean;
}

/**
 * Which groups the bridge shows: only those whose order the server accepts (the 409 conditions of the contract).
 * `queue`: the board's teamster queues a say to a busy ship (`actions.queue`).
 */
export function deskOf(task: Pick<TaskSummary, "slug" | "kind" | "alive" | "column">, queue = false): DeskView {
  const session = task.kind === "session";
  const old = archived(task.slug);
  const idle = !task.alive;
  const words = task.kind === "work" || task.kind === "review" || task.kind === "reflect";
  const judged = task.kind === "work" || task.kind === "review";
  const queued = words && !old && task.alive && queue;
  const send = (words && !old && idle) || queued;
  return {
    reply: words && !old,
    send,
    queue: queued,
    accept: judged,
    acceptFirst: judged && task.column === "review_me",
    refit: send,
    review: judged && !old && idle,
    reflect: !session,
    stop: !session && !old && task.alive,
    clean: !session && !old && idle,
  };
}

/** The verdicts besides «Принять», in the human's words. */
export const OTHER_VERDICTS: readonly { verdict: Exclude<Verdict, "accepted">; label: string }[] = [
  { verdict: "revised", label: "принят с моими правками" },
  { verdict: "redone", label: "переделан в другом месте" },
  { verdict: "dropped", label: "не берём" },
];

/** The verdict's note fits the server's bound. */
export const NOTE_MAX = 200;

// The refit.

export interface RefitDraft {
  model: string;
  effort: string;
  max_minutes: string;
  max_weekly: string;
  fix_rounds: string;
  ci_rounds: string;
  reviewer: string;
  angles: string[];
}

export const blankRefit = (): RefitDraft => ({ model: "", effort: "", max_minutes: "", max_weekly: "", fix_rounds: "", ci_rounds: "", reviewer: "", angles: [] });

/** `ultra` only drives a Codex ship. */
export const effortsFor = (executor: TaskSummary["executor"]): readonly Effort[] => (executor === "codex" ? EFFORTS : EFFORTS.filter((item) => item !== "ultra"));

export const ANGLE_CHIPS: readonly (Angle | "auto")[] = [...ANGLES, "auto"];

/** A chip pressed or released: `auto` stands alone, and a preset releases it. */
export function toggleAngle(angles: readonly string[], angle: string): string[] {
  if (angles.includes(angle)) return angles.filter((item) => item !== angle);
  if (angle === "auto") return ["auto"];
  return [...angles.filter((item) => item !== "auto"), angle];
}

/** The angles as the contract takes them, in the presets' order; undefined for none. */
export function anglesOf(angles: readonly string[]): SayOptions["review_angles"] {
  if (angles.includes("auto")) return "auto";
  const picked = ANGLES.filter((item) => angles.includes(item));
  return picked.length ? picked : undefined;
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function numberOf(text: string, integer: boolean): number | null {
  const clean = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const value = Number(clean);
  return integer && !Number.isInteger(value) ? null : value;
}

export interface Refit {
  options: SayOptions;
  /** Fields out of the contract's bounds, in words; such a refit does not go. */
  errors: string[];
}

/** The refit's options: only the fields the human changed, each within the contract; an empty field keeps the ship as it is. */
export function refitOf(draft: RefitDraft, task: Pick<TaskSummary, "executor" | "model" | "effort" | "reviewer">, limits: TaskLimits | null | undefined): Refit {
  const options: SayOptions = {};
  const errors: string[] = [];
  const model = draft.model.trim();
  if (model) {
    if (!MODEL.test(model)) errors.push("Двигатель: латиница, цифры, «.», «_» и «-», до 64 знаков");
    else if (model !== task.model) options.model = model;
  }
  const effort = draft.effort.trim();
  if (effort) {
    if (!(effortsFor(task.executor) as readonly string[]).includes(effort)) errors.push(`Форсаж: ${effortsFor(task.executor).join(", ")}`);
    else if (effort !== task.effort) options.effort = effort as Effort;
  }
  const numeric = (key: "max_minutes" | "max_weekly" | "fix_rounds" | "ci_rounds", label: string, min: number, max: number, integer: boolean, now: number | null | undefined) => {
    if (!draft[key].trim()) return;
    const value = numberOf(draft[key], integer);
    if (value === null || value < min || value > max) errors.push(`${label}: ${integer ? "целое " : ""}от ${String(min).replace(".", ",")} до ${max}`);
    else if (value !== now) options[key] = value;
  };
  numeric("max_minutes", "Лимит хода", 5, 600, true, limits?.max_turn_minutes);
  numeric("max_weekly", "Топливо задачи", 0.5, 100, false, limits?.max_weekly_percent);
  numeric("fix_rounds", "Круги ремонта", 0, 5, true, limits?.fix_rounds);
  numeric("ci_rounds", "Попытки CI", 0, 5, true, limits?.ci_rounds);
  const reviewer = draft.reviewer.trim();
  if (reviewer && reviewer !== task.reviewer && (REVIEWERS as readonly string[]).includes(reviewer)) options.reviewer = reviewer as SayOptions["reviewer"];
  const angles = anglesOf(draft.angles);
  const saved = anglesOf(limits?.review_angles ?? []);
  if (angles !== undefined && JSON.stringify(angles) !== JSON.stringify(saved)) options.review_angles = angles;
  return { options, errors };
}

/** The line under the refit: what goes with the next order, or with the order put in the queue. */
export function refitLine(refit: Refit, queued = false): string {
  if (refit.errors.length) return refit.errors.join(" · ");
  const flags = optionFlags(refit.options);
  return flags.length ? `уйдёт с указанием${queued ? " в очередь" : ""}: ${flags.join(" ")}` : "ничего не меняется";
}

/** The hint under the reply field: how the order goes, or why it does not. */
export function replyHint(view: Pick<DeskView, "send" | "queue">): string {
  if (view.queue) return "Корабль в пути: указание встанет в очередь и уйдёт одним ходом, когда он закончит цикл. Срочно — «Остановить», но очередь тогда не уйдёт";
  if (view.send) return "С изменёнными полями переоснащения · ⌘/Ctrl+Enter";
  return "Идёт ход: teamster отклонит указание. Обнови teamster до 1.60, чтобы ставить указания в очередь, или останови корабль";
}

/** The confirmation of «Остановить»: the orders waiting in the queue are lost with the cycle. */
export function stopConfirm(waiting: number): string {
  const base = "Остановить корабль посреди хода? Работа в worktree останется.";
  if (waiting <= 0) return base;
  return `${base} ${waiting} ${plural(waiting, "указание", "указания", "указаний")} в очереди не ${plural(waiting, "уйдёт", "уйдут", "уйдут")}.`;
}

// The orders and their commands.

export type ShipRoute = "say" | "verdict" | "review" | "reflect" | "stop" | "clean";
export type ShipOrder = { [R in ShipRoute]: { route: R; body: ActionBodies[R] } }[ShipRoute];

/** The `teamster` command equal to the order, for a board that only reads. */
export function fallbackCommand(order: ShipOrder, now: Date = new Date()): string {
  switch (order.route) {
    case "say":
      return sayCommand(order.body.slug, order.body.text, order.body.options);
    case "verdict":
      return verdictCommand(order.body.slug, order.body.verdict, order.body.note);
    case "review":
      return reviewCommand(order.body);
    case "reflect":
      return reflectCommand({ slug: reflectSlug(now), tasks: order.body.tasks });
    case "stop":
      return stopCommand(order.body.slug);
    case "clean":
      return cleanCommand(order.body.slug, order.body.keep_branch !== false);
  }
}

/** A reflection of this one ship, by the name teamster knows it. */
export const reflectOrder = (slug: string): ShipOrder => ({ route: "reflect", body: { tasks: [commandSlug(slug)] } });

export type MainOrder = { kind: "fill"; label: string; text: string } | { kind: "verdict"; label: string };

/** The button of the line «what next», when the board can carry the order out: a reply to fill in, or the acceptance. */
export function mainOrder(task: TaskSummary, now: number): MainOrder | null {
  const order = recommendedOrder(task, now);
  if (!order) return null;
  const desk = deskOf(task);
  if (order.action === "say" && order.text && desk.send) return { kind: "fill", label: "Подготовить указание", text: order.text };
  if (order.action === "verdict" && desk.accept) return { kind: "verdict", label: "Принять" };
  return null;
}

/** The last line of the command's output, for the line under a group. */
export const lastLine = (output: string) => output.trim().split("\n").filter((line) => line.trim()).pop()?.trim() ?? "";
