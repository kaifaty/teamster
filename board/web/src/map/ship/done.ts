// «Что сделано»: the rows of the deck under «Сейчас» — the branch, the PR and what each station and the agent itself
// found, each only when there is something to say. The deck only draws it.

import { coarseSpan, formatClock, formatDuration } from "../../lib/format";
import { EXECUTORS, findingsLabel, prLabel, stopLabel, type Tone } from "../../lib/labels";
import type { Cargo, TaskChanges, TaskSummary } from "../../types";
import { count, failedOutcome } from "./now";

export interface DoneItem {
  mark: string;
  tone: Tone;
  text: string;
  where: string | null;
}

export interface DoneRow {
  key: "changes" | "pr" | "check" | "claims" | "review" | "ci" | "base" | "stop" | "remaining";
  title: string;
  /** The station's or the bridge's word under the title. */
  meta: string;
  tone: Tone;
  text: string;
  /** A tooltip, such as the check's command. */
  hint?: string;
  /** A link the row's text points to: the PR. */
  link?: string;
  items: DoneItem[];
  /** Findings past the first MAX_FINDINGS. */
  more: number;
}

/** The rows list at most this many findings, and «ещё N» for the rest. */
export const MAX_FINDINGS = 5;

const severityTone = (severity: string): Tone => (/^P[01]$/.test(severity) ? "bad" : severity === "P2" ? "warn" : "muted");
const CI_WORDS: Record<string, string> = { pending: "идёт", passed: "прошёл", failed: "упал", timeout: "не уложился во время", skipped: "пропущен", none: "проверок нет" };
const CLAIMS: Record<string, { mark: string; tone: Tone }> = { passed: { mark: "✓", tone: "ok" }, failed: { mark: "✕", tone: "bad" }, not_run: { mark: "—", tone: "muted" } };

/**
 * The rows of «Что сделано», each only when there is something to say: the branch's changes, the PR, the saved
 * check, the agent's own checks, the review, CI, the base merge, why the fix loop stopped, and what is left undone.
 * The agent's questions are not here: they wait in «Сейчас».
 */
export function doneRows(task: TaskSummary, cargo: Cargo | null | undefined, changes: TaskChanges | null | undefined, now: number): DoneRow[] {
  const rows: DoneRow[] = [];
  const row = (fields: Omit<DoneRow, "items" | "more"> & Partial<Pick<DoneRow, "items" | "more">>) => rows.push({ items: [], more: 0, ...fields });

  if (changes) {
    const none = changes.commits === 0 && changes.uncommitted === 0;
    const parts = [count(changes.commits, "коммит", "коммита", "коммитов"), count(changes.files, "файл", "файла", "файлов"), `+${changes.insertions} −${changes.deletions}`];
    if (changes.uncommitted > 0) parts.push(`незакоммичено ${changes.uncommitted}`);
    row({ key: "changes", title: "Изменения", meta: "ветка", tone: none ? "muted" : changes.uncommitted > 0 ? "warn" : "ok", text: none ? "Нет: в ветке ни одного коммита" : parts.join(" · ") });
  }
  if (task.pr) row({ key: "pr", title: "PR", meta: "", tone: "ok", text: `${prLabel(task.pr)} ↗`, link: task.pr });
  if (!cargo) return rows;

  const check = cargo.check;
  if (check) {
    const word = check.outcome === "passed" ? "Пройдена" : check.outcome === "failed" ? "Упала" : check.outcome === "timeout" ? "Не уложилась во время" : check.outcome;
    const aside = [check.at !== null ? `в ${formatClock(check.at, now)}` : null, check.seconds !== null ? formatDuration(check.seconds) : null, failedOutcome(check.outcome) && check.exit !== null ? `код ${check.exit}` : null];
    row({ key: "check", title: "Проверка", meta: "полигон", tone: check.outcome === "passed" ? "ok" : failedOutcome(check.outcome) ? "bad" : "muted", text: [word, ...aside].filter(Boolean).join(" · "), hint: check.command });
  }
  if (cargo.claims.length) {
    const items = cargo.claims.map((claim) => ({ ...(CLAIMS[claim.outcome] ?? { mark: "·", tone: "muted" as Tone }), text: claim.command, where: claim.details || null }));
    const failed = cargo.claims.filter((claim) => claim.outcome === "failed").length;
    const passed = cargo.claims.filter((claim) => claim.outcome === "passed").length;
    const text = failed ? `Упало ${failed} из ${cargo.claims.length}` : passed === cargo.claims.length ? "Все прошли" : passed ? `Прошло ${passed} из ${cargo.claims.length}` : "Не запускал";
    row({ key: "claims", title: "Проверки агента", meta: "по его отчёту", tone: failed ? "bad" : passed === cargo.claims.length ? "ok" : "muted", text, items });
  }
  const review = cargo.review;
  if (review) {
    const findings = review.findings.length;
    const clean = review.verdict === "clean" && !findings;
    const decided = [cargo.decisions.fixed ? `исправлено ${cargo.decisions.fixed}` : null, cargo.decisions.rejected ? `отклонено ${cargo.decisions.rejected}` : null].filter(Boolean).join(", ");
    const head = clean ? "Чисто" : findings ? findingsLabel(findings).replace(/^./, (c) => c.toUpperCase()) : review.verdict === "defects" ? "Есть замечания" : "Без итога";
    const after = review.reviews > 1 ? `после ${review.reviews} ревью` : null;
    const tone: Tone = clean ? "ok" : review.findings.some((finding) => severityTone(finding.severity) === "bad") ? "bad" : findings || review.verdict === "defects" ? "warn" : "muted";
    row({
      key: "review",
      title: "Ревью",
      meta: task.reviewer ? `инспекция · ${EXECUTORS[task.reviewer]}` : "инспекция",
      tone,
      text: [head, after, decided].filter(Boolean).join(" · "),
      hint: review.summary ?? undefined,
      items: review.findings.slice(0, MAX_FINDINGS).map((finding) => ({
        mark: finding.severity,
        tone: severityTone(finding.severity),
        text: finding.title,
        where: finding.file ? `${finding.file}${finding.line !== null ? `:${finding.line}` : ""}` : null,
      })),
      more: Math.max(0, findings - MAX_FINDINGS),
    });
  }
  const ci = cargo.ci;
  if (ci) {
    const bad = ci.failed > 0 || failedOutcome(ci.outcome);
    const word = ci.failed > 0 ? "Упал" : ci.outcome ? (CI_WORDS[ci.outcome] ?? ci.outcome).replace(/^./, (c) => c.toUpperCase()) : "Без итога";
    const aside = [ci.total > 0 ? `прошло ${ci.passed} из ${ci.total}` : null, ci.seconds !== null ? coarseSpan(ci.seconds) : null, ci.rounds > 0 ? `починок ${ci.rounds}` : null];
    row({
      key: "ci",
      title: "CI",
      meta: "врата",
      tone: bad ? "bad" : ci.outcome === "passed" ? "ok" : "muted",
      text: [word, ...aside].filter(Boolean).join(" · "),
      hint: ci.reason ?? undefined,
      items: ci.failing.map((name) => ({ mark: "✕", tone: "bad" as Tone, text: name, where: null })),
    });
  }
  const base = cargo.base;
  if (base) {
    const conflict = base.outcome === "conflict";
    const word = conflict ? "Конфликт" : base.outcome === "passed" ? "Слита чисто" : base.outcome === "skipped" ? "Не сливалась" : base.outcome;
    row({
      key: "base",
      title: `Слияние с ${base.base.replace(/^origin\//, "")}`,
      meta: "база",
      tone: conflict ? "bad" : base.outcome === "passed" ? "ok" : "muted",
      text: [word, base.files.length ? count(base.files.length, "файл", "файла", "файлов") : null].filter(Boolean).join(" · "),
      items: conflict ? base.files.map((file) => ({ mark: "≠", tone: "bad" as Tone, text: file, where: null })) : [],
    });
  }
  if (cargo.stop) {
    const stop = stopLabel(cargo.stop);
    row({ key: "stop", title: "Автоцикл остановлен", meta: "исправления", tone: stop.tone, text: stop.label, hint: cargo.stop });
  }
  if (cargo.remaining.length) {
    row({
      key: "remaining",
      title: "Не сделано",
      meta: `осталось ${cargo.remaining.length}`,
      tone: "warn",
      text: "По отчёту агента:",
      items: cargo.remaining.map((item, index) => ({ mark: String(index + 1), tone: "warn" as Tone, text: item, where: null })),
    });
  }
  return rows;
}
