import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../types";
import { formatClock } from "./format";
import { recommendedOrder } from "./orders";

const task = (extra: Partial<TaskSummary>): TaskSummary => ({
  slug: "fix-login", kind: "work", title: null, link: null, repo: "r", branch: null, task_type: null, executor: "codex", account: null,
  reviewer: null, model: null, effort: null, column: "attention", phase: "idle", phase_started_at: null,
  alive: false, turn: 1, fix_round: 0, outcome: null, result_status: null, summary: null, pr: null,
  ci: null, sleeping_until: null, created: null, updated_at: 0, activity: null, ...extra,
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
