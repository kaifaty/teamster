// The duty chat as the console shows it: the conversation's rows with the user's messages not yet in the server's view,
// the messages waiting for the running turn, which question's options still answer, and the plain sentences for a chat
// that cannot work. Pure functions; the console's chat only calls them.

import type { DutyChatMessage, DutyChatView } from "../../dutyChatTypes";
import type { FeedItem } from "../../types";

/**
 * A message the user sent that the server's view does not show yet. `before`: how many messages with its text the view
 * (and the sends before it) held when it went, so that it is known once there is one more. `failed` keeps it with its
 * reason and a retry.
 */
export interface PendingMessage {
  key: number;
  text: string;
  at: number;
  before: number;
  state: "sending" | "sent" | "failed";
  error: string | null;
}

/** A task the duty started: its system when it is on the map, which opens it; null otherwise. */
export interface StartedTask {
  slug: string;
  repo: string | null;
}

export type ChatRow =
  | { kind: "user"; key: string; text: string; at: number }
  | {
      kind: "duty";
      key: string;
      text: string;
      at: number;
      question: string | null;
      options: string[];
      /** The latest unanswered question: its options answer it. */
      active: boolean;
      started: StartedTask[];
    }
  | { kind: "note"; key: string; head: string; body: string; at: number }
  /** Accepted while the duty works, or a note held back: it goes with the next turn. */
  | { kind: "queued"; key: string; from: "user" | "note"; text: string; at: number }
  | { kind: "pending"; key: string; pending: PendingMessage };

/** How many of the user's messages, delivered or waiting, have `text`. */
export function sentCount(view: DutyChatView | null, text: string): number {
  if (!view) return 0;
  const same = (row: { from: string; text: string }) => row.from === "user" && row.text.trim() === text;
  return view.messages.filter(same).length + view.queued.filter(same).length;
}

/** A new send's `before`: the messages with its text in the view, and the identical sends still on their way. */
export function pendingBefore(view: DutyChatView | null, pending: readonly PendingMessage[], text: string): number {
  return sentCount(view, text) + pending.filter((row) => row.text === text && row.state !== "failed").length;
}

/** Whether the server's view shows the pending message: one more message with its text than when it went. */
export function arrived(view: DutyChatView | null, pending: PendingMessage): boolean {
  return pending.state !== "failed" && sentCount(view, pending.text) > pending.before;
}

/**
 * The id of the duty's latest message whose question has options and that no later message of the user answered,
 * delivered, waiting or on its way; null when there is none.
 */
export function activeQuestion(view: DutyChatView | null, pending: readonly PendingMessage[] = []): string | null {
  if (!view) return null;
  if (view.queued.some((row) => row.from === "user") || pending.some((row) => row.state !== "failed")) return null;
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index]!;
    if (message.from === "user") return null;
    if (message.from === "duty" && message.question && message.options?.length) return message.id;
  }
  return null;
}

const NOTE = /^Task note: (\S+) ended turn (\d+) with outcome (\S+?)\.?(?:\s|$)/;

/** A task note: its first line in plain words when it is teamster's own, and the rest under it. */
export function noteParts(text: string): { head: string; body: string } {
  const [first = "", ...rest] = text.split("\n");
  const known = NOTE.exec(first);
  const head = known ? `Задача ${known[1]} закончила ход ${known[2]}: ${known[3]}` : first.trim();
  return { head, body: rest.join("\n").trim() };
}

/** The rows in order: the conversation, the waiting messages, then the user's own still on their way. */
export function chatRows(
  view: DutyChatView | null,
  pending: readonly PendingMessage[],
  findTask: (slug: string) => { repo: string } | null,
): ChatRow[] {
  const active = activeQuestion(view, pending);
  const rows: ChatRow[] = (view?.messages ?? []).map((message: DutyChatMessage): ChatRow => {
    if (message.from === "user") return { kind: "user", key: message.id, text: message.text, at: message.at };
    if (message.from === "note") return { kind: "note", key: message.id, at: message.at, ...noteParts(message.text) };
    return {
      kind: "duty",
      key: message.id,
      text: message.text,
      at: message.at,
      question: message.question ?? null,
      options: message.options ?? [],
      active: message.id === active,
      started: (message.started ?? []).map((slug) => ({ slug, repo: findTask(slug)?.repo ?? null })),
    };
  });
  (view?.queued ?? []).forEach((row, index) => rows.push({ kind: "queued", key: `q${index}:${row.at}`, from: row.from, text: row.text, at: row.at }));
  for (const item of pending) if (!arrived(view, item)) rows.push({ kind: "pending", key: `p${item.key}`, pending: item });
  return rows;
}

/** The plain sentence instead of the field when the chat cannot work, or null when it can. */
export function unavailableText(view: DutyChatView | null, state: { read: boolean; readError: string | null }): string | null {
  if (!view) {
    if (state.readError) return `Не удалось прочитать переписку с дежурным: ${state.readError}`;
    return state.read ? "Сервер доски не знает чата с дежурным: перезапусти доску новой версии" : null;
  }
  if (view.available) return null;
  switch (view.reason) {
    case "no_duty":
      return "Дежурный не выбран: назначь аккаунт Claude командой teamster duty set";
    case "codex_duty":
      return `Дежурный${view.duty ? ` ${view.duty.account}` : ""} — аккаунт Codex; чат работает только с Claude (teamster duty set)`;
    case "old_teamster":
      return "teamster старше 1.86.0 и не умеет чат с дежурным: обнови teamster";
    case "read_only":
      return "Доска запущена с --read-only: писать дежурному нельзя";
    case "no_teamster":
      return "Доска не нашла команду teamster: писать дежурному нельзя";
    default:
      return "Писать дежурному сейчас нельзя";
  }
}

/** The refusal or failure after the last send was answered, in plain words. */
export function lastErrorText(view: DutyChatView | null): string | null {
  return view?.last_error ? `teamster не выполнил последнее сообщение: ${view.last_error.text}` : null;
}

/** How long the turn runs: "0:07", "12:30", "1:05:00". */
export function runTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const two = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}:${two(minutes)}:${two(total % 60)}` : `${minutes}:${two(total % 60)}`;
}

const FEED_LABEL: Record<FeedItem["kind"], string> = { message: "пишет", thinking: "думает", command: "команда", edit: "правка", tool: "инструмент" };

/** The last `count` steps of the running turn, one line each. */
export function feedTail(items: readonly FeedItem[], count = 3): { key: string; label: string; text: string }[] {
  return items
    .map((item, index) => ({ key: String(index), label: FEED_LABEL[item.kind], text: item.text.split("\n").find((line) => line.trim())?.trim() ?? "" }))
    .filter((line) => line.text)
    .slice(-count);
}
