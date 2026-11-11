// «Сейчас», the bridge's first deck: the ship's state in plain words with its short facts, and the agent's report cut
// into paragraphs. The deck only draws it.

import { coarseSpan, formatClock } from "../../lib/format";
import { findingsLabel, problemLabel, prLabel } from "../../lib/labels";
import type { Cargo, TaskChanges, TaskLimits, TaskSummary } from "../../types";
import { plural } from "../research";
import { roundsOf, type StateTone } from "./bridge";

export interface NowLine {
  tone: StateTone;
  headline: string;
  /** Short facts after the headline: the turn, the branch's changes, the PR, the stations' results. */
  facts: string[];
}

export const failedOutcome = (outcome: string | null | undefined) => outcome === "failed" || outcome === "timeout";
export const count = (n: number, one: string, few: string, many: string) => `${n} ${plural(n, one, few, many)}`;

function headlineOf(task: TaskSummary, cargo: Cargo | null | undefined, limits: TaskLimits | null | undefined, now: number): { tone: StateTone; headline: string } {
  if (task.column === "closed") return { tone: "dim", headline: "Задача закрыта" };
  if (task.kind === "session") {
    return task.alive ? { tone: "work", headline: "Сессия ведёт ход" } : { tone: "ready", headline: "Сессия ждёт тебя в приложении Claude" };
  }
  if (task.column === "sleeping") {
    const wakes = task.sleeping_until !== null ? `, проснётся в ${formatClock(task.sleeping_until, now)}` : "";
    return { tone: "sleep", headline: `Спит до сброса лимита${wakes}` };
  }
  if (task.alive) {
    switch (task.phase) {
      case "fix": {
        const allowed = limits?.fix_rounds ?? null;
        const round = Math.max(1, roundsOf(task, limits));
        return { tone: "work", headline: `Агент исправляет находки ревью: круг ${round}${allowed ? ` из ${allowed}` : ""}` };
      }
      case "check":
        return { tone: "work", headline: "Идёт проверка" };
      case "review":
        return { tone: "work", headline: "Идёт ревью" };
      case "ci":
        return { tone: "work", headline: "Ждёт CI" };
      default:
        return { tone: "work", headline: task.turn > 0 ? `Агент работает: ход ${task.turn}` : "Агент работает" };
    }
  }
  if (task.column === "review_me") {
    if (task.stop === "base conflict") return { tone: "bad", headline: "Готово, но конфликт с базовой веткой" };
    if (failedOutcome(task.check)) return { tone: "bad", headline: "Готово, но проверка упала" };
    if (failedOutcome(task.ci)) {
      const ci = cargo?.ci;
      const failed = ci && ci.total > 0 ? `: ${ci.failed} из ${ci.total} упали` : "";
      return { tone: "bad", headline: `CI не прошёл${failed}` };
    }
    if (task.ci === "pending") return { tone: "wait", headline: "Готово, CI ещё не закончился" };
    if (task.findings_left > 0 || task.left > 0) return { tone: "wait", headline: "Готово, но остались замечания" };
    return { tone: "ready", headline: "Готово: можно принимать" };
  }
  // The column «attention»: the result first, then the outcome.
  if (task.result_status === "needs_decision") {
    const questions = cargo?.questions.length ?? 0;
    return { tone: "wait", headline: `Агент ждёт твоего решения${questions ? `: ${count(questions, "вопрос", "вопроса", "вопросов")}` : ""}` };
  }
  if (task.result_status === "blocked") return { tone: "bad", headline: "Агент заблокирован: нужна твоя помощь" };
  if (task.result_status === "partial") return { tone: "wait", headline: "Сделано частично: нужны указания" };
  const problem = problemLabel(task);
  const tone: StateTone = task.outcome === "stopped" || task.outcome === "budget_exhausted" || task.outcome === "interrupted" ? "wait" : "bad";
  return { tone, headline: problem ? `Нужно внимание: ${problem}` : "Нужно внимание" };
}

/** «ничего не изменено», «3 коммита · 7 файлов»; null when the branch is unknown. */
export function changesLine(changes: TaskChanges | null | undefined): string | null {
  if (!changes) return null;
  if (changes.commits === 0 && changes.uncommitted === 0) return "ничего не изменено";
  const parts = [];
  if (changes.commits > 0) parts.push(count(changes.commits, "коммит", "коммита", "коммитов"));
  if (changes.files > 0) parts.push(count(changes.files, "файл", "файла", "файлов"));
  if (changes.uncommitted > 0) parts.push(`незакоммичено ${changes.uncommitted}`);
  return parts.join(" · ");
}

export function nowOf(
  task: TaskSummary,
  cargo: Cargo | null | undefined,
  changes: TaskChanges | null | undefined,
  limits: TaskLimits | null | undefined,
  now: number,
): NowLine {
  const { tone, headline } = headlineOf(task, cargo, limits, now);
  const facts: string[] = [];
  if (task.kind !== "session" && task.turn > 0) {
    if (task.alive && task.column !== "sleeping" && task.phase_started_at !== null) {
      const max = limits?.max_turn_minutes ?? null;
      facts.push(`идёт ${coarseSpan(Math.max(0, now - task.phase_started_at))}${max !== null && task.phase === "turn" ? ` из ${max} мин` : ""}`);
    } else if (!task.alive && task.column !== "closed") {
      facts.push(`ход ${task.turn} закончился в ${formatClock(task.updated_at, now)}`);
    } else if (task.column === "closed") {
      facts.push(count(task.turn, "ход", "хода", "ходов"));
    }
  }
  const changed = changesLine(changes);
  if (changed) facts.push(changed);
  if (task.kind === "work" || task.kind === "review") {
    if (task.pr) facts.push(prLabel(task.pr));
    else if (!task.alive && task.column !== "closed") facts.push("PR нет");
  }
  if (task.check === "passed") facts.push("проверка пройдена");
  else if (failedOutcome(task.check)) facts.push("проверка упала");
  if (task.review === "clean" && task.findings_left === 0) facts.push("ревью чистое");
  else if (task.findings_left > 0) facts.push(`ревью: ${findingsLabel(task.findings_left)}`);
  const ci = cargo?.ci;
  if (task.ci === "passed") facts.push(ci && ci.total > 0 ? `CI ${ci.passed} из ${ci.total}` : "CI прошёл");
  else if (failedOutcome(task.ci)) facts.push("CI упал");
  else if (task.ci === "pending") facts.push("CI идёт");
  return { tone, headline, facts };
}

/** The report's text cut into paragraphs, and each paragraph into plain runs and `code` runs. */
export interface ReportRun {
  code: boolean;
  text: string;
}

export function reportParagraphs(text: string): ReportRun[][] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(/^\n+|\s+$/g, ""))
    .filter((paragraph) => paragraph.trim())
    .map((paragraph) => {
      const runs: ReportRun[] = [];
      const parts = paragraph.split("`");
      // An odd number of backticks leaves the last one as text.
      const closed = parts.length % 2 === 1;
      parts.forEach((part, index) => {
        const code = index % 2 === 1 && (closed || index < parts.length - 1);
        const value = code || index % 2 === 0 ? part : `\`${part}`;
        if (value) runs.push({ code, text: value });
      });
      return runs;
    });
}

/** A report longer than this folds under «показать целиком». */
export const REPORT_FOLD = 2400;
