// The order a task's state calls for: one reason and one command, from the lead's loop in lead-guide.md
// and the turn outcomes in results.md. The board only copies the command, it never runs it.

import type { TaskSummary } from "../types";
import { commandSlug, sayCommand, shellWord, takesWords, verdictCommand, type CommandId, type Verdict } from "./commands";
import { formatClock } from "./format";
import { problemLabel, prLabel } from "./labels";

export type OrderTone = "ok" | "warn" | "bad" | "muted";

export interface Order {
  /** Why, shown above the button. */
  reason: string;
  tone: OrderTone;
  action: CommandId | "say" | "verdict" | "accounts";
  /** The button's text, in monospace. */
  label: string;
  /** The command, ready to copy; null when the order needs the human's words. */
  command: string | null;
  /** For say: the text put into the field. */
  text?: string;
  /** For verdict: the chosen verdict. */
  verdict?: Verdict;
}

const RUNNING: Partial<Record<TaskSummary["phase"], string>> = {
  ci: "Ждёт CI: дождись итога",
  turn: "Идёт ход: дождись итога",
  check: "Идёт проверка: дождись итога",
  review: "Идёт ревью: дождись итога",
  fix: "Идёт исправление: дождись итога",
};

const CONTINUE = "Продолжай с того места, где остановился.";

/** The order for `task` at `now` (seconds), or null when there is nothing to order: a session or a closed task. */
export function recommendedOrder(task: TaskSummary, now: number): Order | null {
  if (task.kind === "session" || task.column === "closed") return null;
  const slug = shellWord(commandSlug(task.slug));
  const plain = (action: CommandId | "accounts", reason: string, tone: OrderTone, label: string = action): Order => ({
    reason,
    tone,
    action,
    label,
    command: action === "accounts" ? "teamster accounts" : `teamster ${action} ${slug}`,
  });
  const status = (reason: string, tone: OrderTone) => plain("status", reason, tone);
  const say = (reason: string, tone: OrderTone, text: string): Order =>
    takesWords(task)
      ? { reason, tone, action: "say", label: "say", command: text ? sayCommand(task.slug, text) : null, text }
      : status(reason, tone);

  if (task.column === "sleeping") {
    const until = task.sleeping_until !== null ? ` в ${formatClock(task.sleeping_until, now)}` : "";
    return {
      ...plain("wait", `Спит до сброса лимита, проснётся сам${until}`, "muted", "wait --through-sleep"),
      command: `teamster wait ${slug} --through-sleep`,
    };
  }
  if (task.alive) return plain("wait", RUNNING[task.phase] ?? "В работе: дождись итога", "muted");

  if (task.column === "review_me") {
    if (task.ci === "failed" || task.ci === "timeout") {
      return say("Готово, но CI не прошёл: верни на исправление", "bad", "CI не прошёл: разбери логи упавших проверок, исправь и запушь.");
    }
    if (task.ci === "pending") return status("CI не дождались: проверь статус PR", "warn");
    const reason = `Готово: прочитай diff и прими${task.pr ? ` · ${prLabel(task.pr)}` : ""}`;
    if (!takesWords(task)) return status(reason, "ok");
    return { reason, tone: "ok", action: "verdict", label: "verdict accepted", command: verdictCommand(task.slug, "accepted"), verdict: "accepted" };
  }

  if (task.column === "attention") {
    switch (task.outcome) {
      case "refused":
        return status("Отказ модели: пересмотри задачу, повтор не поможет", "bad");
      case "stuck":
        return status("Повторяет одну и ту же ошибку: разберись сам", "bad");
      case "failed":
      case "error":
      case "unavailable":
        return status("Сбой: прочитай ошибку в статусе", "bad");
      case "exhausted":
        return plain("accounts", "Лимиты аккаунтов исчерпаны: проверь аккаунты", "bad");
      case "budget_exhausted":
        return say("Бюджет исчерпан: продли ход или раздели задачу", "warn", "Продолжай с оставшейся работы.");
      case "stopped":
        return say("Остановлена: проверь работу и продолжи", "warn", CONTINUE);
      case "interrupted":
        return say("Прервана: проверь worktree и продолжи", "warn", CONTINUE);
      case "running":
      case "sleeping":
        return say("Надзиратель умер: продолжи через say", "bad", CONTINUE);
    }
    switch (task.result_status) {
      case "needs_decision":
        return say("Ждёт твоего решения: ответь через say", "warn", "");
      case "blocked":
        return say("Заблокирована: сними блокировку и напиши, что изменилось", "bad", "");
      case "partial":
        return say("Сделано частично: дай следующие указания", "warn", "Продолжай: доделай оставшееся из «Done when».");
    }
  }

  const label = problemLabel(task);
  return status(`${label ? label.charAt(0).toUpperCase() + label.slice(1) : "Нужно внимание"}: посмотри статус`, "warn");
}
