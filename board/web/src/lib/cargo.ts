// The rows of a task's "Груз" section: what it came back with, one row per part that has data.

import type { Cargo, CargoFinding } from "../types";
import { coarseSpan, formatDuration } from "./format";
import { findingsLabel, stopLabel, type Tone } from "./labels";

export interface CargoRow {
  key: "check" | "review" | "stop" | "ci" | "base";
  label: string;
  text: string;
  tone: Tone;
  /** A tooltip, such as the check's command. */
  title?: string;
}

/** Whether the cargo carries anything worth a section. */
export function hasCargo(cargo: Cargo | null | undefined): cargo is Cargo {
  if (!cargo) return false;
  return Boolean(
    cargo.check || cargo.review || cargo.stop || cargo.ci || cargo.base || cargo.claims?.length || cargo.remaining?.length ||
      cargo.questions?.length || cargo.decisions?.fixed || cargo.decisions?.rejected,
  );
}

/** A CI outcome without failed checks, in the row labelled "CI", so without the word itself. */
const CI_OUTCOMES: Record<string, string> = { pending: "идёт", skipped: "пропущен", timeout: "таймаут", none: "нет проверок", failed: "упал" };

const failed = (outcome: string | null | undefined) => outcome === "failed" || outcome === "timeout";

/** "F2 P3 Заголовок — file:line". */
export function findingLine(finding: CargoFinding): string {
  const where = finding.file ? ` — ${finding.file}${finding.line !== null ? `:${finding.line}` : ""}` : "";
  return `${finding.id} ${finding.severity} ${finding.title}${where}`;
}

export function cargoRows(cargo: Cargo): CargoRow[] {
  const rows: CargoRow[] = [];
  const check = cargo.check;
  if (check) {
    const text =
      check.outcome === "passed"
        ? `прошла${check.seconds !== null ? ` · ${formatDuration(check.seconds)}` : ""}`
        : check.outcome === "failed"
          ? `упала${check.exit !== null ? ` · код ${check.exit}` : ""}`
          : check.outcome === "timeout"
            ? "таймаут"
            : check.outcome;
    rows.push({ key: "check", label: "Проверка", text, tone: check.outcome === "passed" ? "ok" : failed(check.outcome) ? "bad" : "muted", title: check.command });
  }
  const review = cargo.review;
  if (review) {
    const count = review.findings.length;
    const head = review.verdict === "clean" && !count ? "чисто" : count ? findingsLabel(count) : review.verdict === "defects" ? "есть замечания" : "без итога";
    const severe = review.findings.some((finding) => /^P[0-2]$/.test(finding.severity));
    rows.push({
      key: "review",
      label: "Ревью",
      text: review.reviews > 0 ? `${head} · ${review.reviews} ревью` : head,
      tone: head === "чисто" ? "ok" : severe ? "bad" : review.verdict === null && !count ? "muted" : "warn",
      title: review.summary ?? undefined,
    });
  }
  if (cargo.stop) {
    const stop = stopLabel(cargo.stop);
    rows.push({ key: "stop", label: "Цикл", text: stop.label, tone: stop.tone, title: cargo.stop });
  }
  const ci = cargo.ci;
  if (ci) {
    const time = ci.seconds !== null ? ` · ${coarseSpan(ci.seconds)}` : "";
    let text: string;
    let tone: Tone;
    if (ci.failed > 0) {
      text = `упало ${ci.failed} из ${ci.total}${ci.failing.length ? `: ${ci.failing.join(", ")}` : ""}`;
      tone = "bad";
    } else if (ci.outcome === "passed") {
      text = `${ci.passed} из ${ci.total} прошли${time}`;
      tone = "ok";
    } else {
      const outcome = ci.outcome ? (CI_OUTCOMES[ci.outcome] ?? ci.outcome) : "без итога";
      text = ci.total > 0 ? `${outcome} · ${ci.passed} из ${ci.total} прошли${time}` : outcome;
      tone = failed(ci.outcome) ? "bad" : "muted";
    }
    if (ci.rounds > 0) text += ` · раундов починки: ${ci.rounds}`;
    rows.push({ key: "ci", label: "CI", text, tone, title: ci.reason ?? undefined });
  }
  const base = cargo.base;
  if (base) {
    const text =
      base.outcome === "conflict"
        ? base.files.length ? `конфликт: ${base.files.join(", ")}` : "конфликт"
        : base.outcome === "passed"
          ? "слита"
          : base.outcome === "skipped"
            ? "не сливалась"
            : base.outcome;
    rows.push({ key: "base", label: "База", text, tone: base.outcome === "conflict" ? "bad" : base.outcome === "passed" ? "ok" : "muted", title: base.base });
  }
  return rows;
}
