import { describe, expect, it } from "vitest";
import type { Cargo, TaskSummary } from "../types";
import { formatClock } from "./format";
import { recommendedOrder, returnText } from "./orders";

const task = (extra: Partial<TaskSummary>): TaskSummary => ({
  slug: "fix-login", kind: "work", title: null, link: null, repo: "r", branch: null, task_type: null, executor: "codex", account: null,
  reviewer: null, model: null, effort: null, column: "attention", phase: "idle", phase_started_at: null,
  alive: false, turn: 1, fix_round: 0, outcome: null, result_status: null, summary: null, pr: null,
  ci: null, sleeping_until: null, created: null, updated_at: 0, activity: null, check: null, review: null, findings_left: 0, stop: null, left: 0, ...extra,
});

const NOW = 1_800_000_000;
const brief = (extra: Partial<TaskSummary>) => {
  const order = recommendedOrder(task(extra), NOW);
  return order && [order.action, order.tone, order.reason, order.command];
};

describe("recommendedOrder", () => {
  it("gives no order to a session or a closed task", () => {
    expect(recommendedOrder(task({ kind: "session", column: "running", alive: true }), NOW)).toBeNull();
    expect(recommendedOrder(task({ column: "closed", outcome: "stopped" }), NOW)).toBeNull();
  });

  it("waits through the sleep", () => {
    const order = recommendedOrder(task({ column: "sleeping", phase: "sleeping", alive: true }), NOW)!;
    expect(order).toEqual({
      reason: "Спит до сброса лимита, проснётся сам",
      tone: "muted",
      action: "wait",
      label: "wait --through-sleep",
      command: "teamster wait fix-login --through-sleep",
    });
    const until = NOW + 3600;
    expect(recommendedOrder(task({ column: "sleeping", sleeping_until: until }), NOW)!.reason).toBe(
      `Спит до сброса лимита, проснётся сам в ${formatClock(until, NOW)}`,
    );
  });

  it.each([
    ["ci", "Ждёт CI: дождись итога"],
    ["turn", "Идёт ход: дождись итога"],
    ["check", "Идёт проверка: дождись итога"],
    ["review", "Идёт ревью: дождись итога"],
    ["fix", "Идёт исправление: дождись итога"],
    ["idle", "В работе: дождись итога"],
  ] as const)("waits for a running task in phase %s", (phase, reason) => {
    const order = recommendedOrder(task({ column: "running", alive: true, phase }), NOW)!;
    expect([order.action, order.tone, order.reason, order.label, order.command]).toEqual(["wait", "muted", reason, "wait", "teamster wait fix-login"]);
  });

  it("orders a finished task by its CI", () => {
    const failed = recommendedOrder(task({ column: "review_me", ci: "failed" }), NOW)!;
    const text = "CI не прошёл: разбери логи упавших проверок, исправь и запушь.";
    expect(failed).toMatchObject({ action: "say", tone: "bad", reason: "Готово, но CI не прошёл: верни на исправление", label: "say", text });
    expect(failed.command).toBe(`teamster say fix-login '${text}'`);
    expect(brief({ column: "review_me", ci: "timeout" })?.[0]).toBe("say");
    expect(brief({ column: "review_me", ci: "pending" })).toEqual(["status", "warn", "CI не дождались: проверь статус PR", "teamster status fix-login"]);
    expect(recommendedOrder(task({ column: "review_me", ci: "passed", pr: "https://github.com/o/r/pull/118" }), NOW)).toEqual({
      reason: "Готово: прочитай diff и прими · PR #118",
      tone: "ok",
      action: "verdict",
      label: "verdict accepted",
      command: "teamster verdict fix-login accepted",
      verdict: "accepted",
    });
    expect(brief({ column: "review_me" })?.[2]).toBe("Готово: прочитай diff и прими");
  });

  it("returns a finished task with a base conflict or a failed check before its CI", () => {
    const merge = "Слей базовую ветку и разреши конфликт, сохранив смысл обеих сторон.";
    const check = "Сохранённая проверка упала: разбери её вывод и исправь.";
    expect(recommendedOrder(task({ column: "review_me", stop: "base conflict", check: "failed", ci: "failed" }), NOW)).toMatchObject({
      action: "say", tone: "bad", reason: "Конфликт с базой: верни на слияние", text: merge, command: `teamster say fix-login '${merge}'`,
    });
    expect(recommendedOrder(task({ column: "review_me", check: "failed", ci: "failed" }), NOW)).toMatchObject({
      action: "say", tone: "bad", reason: "Готово, но проверка упала: верни на исправление", text: check,
    });
    expect(brief({ column: "review_me", check: "timeout", ci: "pending" })?.[2]).toBe("Готово, но проверка упала: верни на исправление");
    expect(brief({ column: "review_me", check: "passed", ci: "failed" })?.[2]).toBe("Готово, но CI не прошёл: верни на исправление");
  });

  it("accepts a finished task with findings or open items with a warning, after its CI", () => {
    expect(recommendedOrder(task({ column: "review_me", findings_left: 2, pr: "https://github.com/o/r/pull/118" }), NOW)).toEqual({
      reason: "Готово, остались замечания: прими или верни на доработку · PR #118",
      tone: "warn",
      action: "verdict",
      label: "verdict accepted",
      command: "teamster verdict fix-login accepted",
      verdict: "accepted",
    });
    expect(brief({ column: "review_me", left: 1 })).toEqual([
      "verdict", "warn", "Готово, остались замечания: прими или верни на доработку", "teamster verdict fix-login accepted",
    ]);
    expect(brief({ column: "review_me", findings_left: 2, ci: "failed" })?.[2]).toBe("Готово, но CI не прошёл: верни на исправление");
    expect(brief({ column: "review_me", left: 1, ci: "pending" })?.[2]).toBe("CI не дождались: проверь статус PR");
    expect(brief({ column: "review_me", review: "clean", stop: "clean" })?.slice(0, 2)).toEqual(["verdict", "ok"]);
  });

  it("orders a base conflict in attention after the outcome and before the result status", () => {
    const merge = "teamster say fix-login 'Слей базовую ветку и разреши конфликт, сохранив смысл обеих сторон.'";
    expect(brief({ outcome: "conflict", result_status: "blocked", stop: "base conflict" })).toEqual(["say", "bad", "Конфликт с базой: верни на слияние", merge]);
    expect(brief({ outcome: "stopped", stop: "base conflict" })?.[2]).toBe("Остановлена: проверь работу и продолжи");
  });

  it.each([
    ["refused", "status", "bad", "Отказ модели: пересмотри задачу, повтор не поможет", "teamster status fix-login"],
    ["stuck", "status", "bad", "Повторяет одну и ту же ошибку: разберись сам", "teamster status fix-login"],
    ["failed", "status", "bad", "Сбой: прочитай ошибку в статусе", "teamster status fix-login"],
    ["error", "status", "bad", "Сбой: прочитай ошибку в статусе", "teamster status fix-login"],
    ["unavailable", "status", "bad", "Сбой: прочитай ошибку в статусе", "teamster status fix-login"],
    ["exhausted", "accounts", "bad", "Лимиты аккаунтов исчерпаны: проверь аккаунты", "teamster accounts"],
    ["budget_exhausted", "say", "warn", "Бюджет исчерпан: продли ход или раздели задачу", "teamster say fix-login 'Продолжай с оставшейся работы.'"],
    ["stopped", "say", "warn", "Остановлена: проверь работу и продолжи", "teamster say fix-login 'Продолжай с того места, где остановился.'"],
    ["interrupted", "say", "warn", "Прервана: проверь worktree и продолжи", "teamster say fix-login 'Продолжай с того места, где остановился.'"],
    ["running", "say", "bad", "Надзиратель умер: продолжи через say", "teamster say fix-login 'Продолжай с того места, где остановился.'"],
    ["sleeping", "say", "bad", "Надзиратель умер: продолжи через say", "teamster say fix-login 'Продолжай с того места, где остановился.'"],
  ])("orders attention by outcome %s", (outcome, ...expected) => {
    expect(brief({ outcome })).toEqual(expected);
  });

  it("labels the accounts order plainly", () => {
    expect(recommendedOrder(task({ outcome: "exhausted" }), NOW)!.label).toBe("accounts");
  });

  it("orders attention by result status after the outcome", () => {
    expect(recommendedOrder(task({ result_status: "needs_decision" }), NOW)).toMatchObject({
      action: "say", tone: "warn", reason: "Ждёт твоего решения: ответь через say", command: null, text: "",
    });
    expect(recommendedOrder(task({ result_status: "blocked" }), NOW)).toMatchObject({
      action: "say", tone: "bad", reason: "Заблокирована: сними блокировку и напиши, что изменилось", command: null, text: "",
    });
    expect(brief({ result_status: "partial" })).toEqual([
      "say", "warn", "Сделано частично: дай следующие указания", "teamster say fix-login 'Продолжай: доделай оставшееся из «Done when».'",
    ]);
    expect(brief({ outcome: "stopped", result_status: "partial" })?.[2]).toBe("Остановлена: проверь работу и продолжи");
  });

  it("falls back to status with the problem label", () => {
    expect(brief({ outcome: "conflict" })).toEqual(["status", "warn", "Конфликт: посмотри статус", "teamster status fix-login"]);
    expect(brief({ outcome: "completed", result_status: "done" })?.[2]).toBe("Нужно внимание: посмотри статус");
  });

  it("gives a scout status instead of say or verdict", () => {
    expect(brief({ kind: "scout", outcome: "stopped" })).toEqual(["status", "warn", "Остановлена: проверь работу и продолжи", "teamster status fix-login"]);
    expect(brief({ kind: "scout", column: "review_me" })).toEqual(["status", "ok", "Готово: прочитай diff и прими", "teamster status fix-login"]);
    expect(brief({ kind: "scout", column: "running", alive: true })?.[0]).toBe("wait");
  });

  it("names an archived task by its slug and quotes the say text", () => {
    expect(brief({ slug: "pr-template-20261105T101500Z", outcome: "refused" })?.[3]).toBe("teamster status pr-template");
    expect(brief({ slug: "pr-template-20261105T101500Z", column: "review_me" })?.[3]).toBe("teamster verdict pr-template accepted");
    expect(brief({ slug: "pr-template-20261105T101500Z", column: "sleeping" })?.[3]).toBe("teamster wait pr-template --through-sleep");
    expect(brief({ slug: "pr-template-20261105T101500Z", result_status: "partial" })?.[3]).toBe(
      "teamster say pr-template 'Продолжай: доделай оставшееся из «Done when».'",
    );
    expect(brief({ slug: "it's odd", outcome: "stopped" })?.[3]).toBe("teamster say 'it'\\''s odd' 'Продолжай с того места, где остановился.'");
  });
});

describe("returnText", () => {
  const empty: Cargo = {
    check: null, claims: [], review: null, stop: null, ci: null, base: null, remaining: [], questions: [], decisions: { fixed: 0, rejected: 0 },
  };

  it("lists every finding, failure, conflict, remaining item and question", () => {
    const cargo: Cargo = {
      ...empty,
      check: { command: "npm test", outcome: "failed", exit: 1, seconds: 3, at: null },
      review: {
        verdict: "defects",
        summary: null,
        findings: [
          { id: "F2", severity: "P3", title: "Нет примера", file: "a.md", line: 48 },
          { id: "F4", severity: "P2", title: "Гонка", file: "b.ts", line: null },
        ],
        reviews: 2,
      },
      ci: { outcome: "failed", passed: 4, failed: 2, total: 6, failing: ["build", "lint"], seconds: 60, rounds: 0, reason: null },
      base: { base: "origin/main", outcome: "conflict", files: ["x.ts", "y.ts"] },
      remaining: ["README"],
      questions: ["Убрать поле?"],
    };
    expect(returnText(cargo)).toBe(
      [
        "Доработай перед приёмкой:",
        "- F2 [P3] Нет примера — a.md:48",
        "- F4 [P2] Гонка — b.ts",
        "- Сохранённая проверка упала: разбери её вывод и исправь.",
        "- CI не прошёл: build, lint.",
        "- Слей origin/main и разреши конфликт в x.ts, y.ts, сохранив смысл обеих сторон.",
        "- Доделай: README",
        "- Ответ на «Убрать поле?»: ",
      ].join("\n"),
    );
  });

  it("gives only the first line without cargo or with an empty one", () => {
    expect(returnText(empty)).toBe("Доработай перед приёмкой:");
    expect(returnText(null)).toBe("Доработай перед приёмкой:");
  });

  it("names a finding without a file by itself", () => {
    const review = { verdict: "defects" as const, summary: null, findings: [{ id: "F1", severity: "P3", title: "Тест", file: null, line: 3 }], reviews: 1 };
    expect(returnText({ ...empty, review })).toBe("Доработай перед приёмкой:\n- F1 [P3] Тест");
  });
});
