// The order a task's state calls for: one reason and one command, from the lead's loop in lead-guide.md
// and the turn outcomes in results.md. The board only copies the command, it never runs it.

import type { Cargo, TaskSummary } from "../types";
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

export const CONTINUE = "Продолжай с того места, где остановился.";
export const MERGE = "Слей базовую ветку и разреши конфликт, сохранив смысл обеих сторон.";
const CHECK = "Сохранённая проверка упала: разбери её вывод и исправь.";
const BASE_CONFLICT = "Конфликт с базой: верни на слияние";

const failed = (outcome: string | null | undefined) => outcome === "failed" || outcome === "timeout";

/** The first line of the text that returns a task for more work. */
export const RETURN_HEAD = "Доработай перед приёмкой:";

/**
 * The text that returns a task on the roadstead for more work: one item per review finding, failed check,
 * failed CI, base conflict, remaining item and question. Without the cargo, only the first line.
 */
export function returnText(cargo: Cargo | null | undefined): string {
  const lines = [RETURN_HEAD];
  if (!cargo) return RETURN_HEAD;
  for (const finding of cargo.review?.findings ?? []) {
    const where = finding.file ? ` — ${finding.file}${finding.line !== null ? `:${finding.line}` : ""}` : "";
    lines.push(`- ${finding.id} [${finding.severity}] ${finding.title}${where}`);
  }
  if (failed(cargo.check?.outcome)) lines.push(`- ${CHECK}`);
  const ci = cargo.ci;
  if (ci && (ci.failed > 0 || failed(ci.outcome))) lines.push(ci.failing.length ? `- CI не прошёл: ${ci.failing.join(", ")}.` : "- CI не прошёл.");
  const base = cargo.base;
  if (base?.outcome === "conflict") {
    const where = base.files.length ? ` в ${base.files.join(", ")}` : "";
    lines.push(`- Слей ${base.base} и разреши конфликт${where}, сохранив смысл обеих сторон.`);
  }
  for (const item of cargo.remaining ?? []) lines.push(`- Доделай: ${item}`);
  for (const question of cargo.questions ?? []) lines.push(`- Ответ на «${question}»: `);
  return lines.join("\n");
}

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
    if (task.stop === "base conflict") return say(BASE_CONFLICT, "bad", MERGE);
    if (failed(task.check)) return say("Готово, но проверка упала: верни на исправление", "bad", CHECK);
    if (failed(task.ci)) {
      return say("Готово, но CI не прошёл: верни на исправление", "bad", "CI не прошёл: разбери логи упавших проверок, исправь и запушь.");
    }
    if (task.ci === "pending") return status("CI не дождались: проверь статус PR", "warn");
    const pr = task.pr ? ` · ${prLabel(task.pr)}` : "";
    const open = task.findings_left > 0 || task.left > 0;
    const reason = open ? `Готово, остались замечания: прими или верни на доработку${pr}` : `Готово: прочитай diff и прими${pr}`;
    const tone: OrderTone = open ? "warn" : "ok";
    if (!takesWords(task)) return status(reason, tone);
    return { reason, tone, action: "verdict", label: "verdict accepted", command: verdictCommand(task.slug, "accepted"), verdict: "accepted" };
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
    if (task.stop === "base conflict") return say(BASE_CONFLICT, "bad", MERGE);
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
