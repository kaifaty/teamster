import { describe, expect, it } from "vitest";
import { logEvent } from "../fixtures/events";
import type { LogEvent } from "../types";
import { eventText, mergeEvents } from "./events";

const at = 1_800_000_000;
const event = (fields: Partial<LogEvent> & Pick<LogEvent, "kind">) => logEvent({ slug: "ship", repo: "demo", ...fields }, at);

describe("eventText", () => {
  it.each([
    [{ kind: "work", phase: "work", outcome: "completed" }, "ship вышел с верфи"],
    [{ kind: "work", phase: "fix", round: 2, outcome: "completed" }, "ship залатан, круг 2"],
    [{ kind: "work", phase: "work", outcome: "budget_exhausted" }, "ship остался без топлива"],
    [{ kind: "work", phase: "fix", outcome: "budget_exhausted" }, "ship остался без топлива"],
    [{ kind: "work", phase: "work", outcome: "failed" }, "ship потерял ход"],
    [{ kind: "work", phase: "work", outcome: "stuck" }, "ship потерял ход"],
    [{ kind: "work", phase: "fix", outcome: "stopped" }, "ship потерял ход"],
    [{ kind: "work", phase: "check", outcome: "passed" }, "ship прошёл полигон"],
    [{ kind: "work", phase: "check", outcome: "failed" }, "ship не прошёл полигон"],
    [{ kind: "work", phase: "check", outcome: "timeout" }, "ship не прошёл полигон"],
    [{ kind: "review", phase: "review", outcome: "completed", findings: 3 }, "Инспекция нашла у ship замечаний: 3"],
    [{ kind: "review", phase: "review", outcome: "completed", findings: 0 }, "ship чист на инспекции"],
    [{ kind: "work", phase: "turn", outcome: "completed", ci: "failed" }, "Ворота отклонили ship"],
    [{ kind: "work", phase: "turn", outcome: "completed", ci: "passed" }, "ship прошёл ворота"],
    [{ kind: "verdict", verdict: "accepted" }, "ship ушёл в солнце"],
    [{ kind: "verdict", verdict: "revised" }, "ship ушёл в солнце после правок"],
    [{ kind: "verdict", verdict: "redone" }, "ship отправлен на переделку"],
    [{ kind: "verdict", verdict: "dropped" }, "ship списан"],
    [{ kind: "scout", phase: "scout", outcome: "completed" }, "Разведчик ship вернулся"],
    [{ kind: "work", phase: "base_check", outcome: "skipped" }, "ship: base_check skipped"],
    [{ kind: "review", phase: "review", outcome: "refused" }, "ship: review refused"],
  ] as [Partial<LogEvent> & Pick<LogEvent, "kind">, string][])("%o → %s", (fields, text) => {
    expect(eventText(event(fields))).toBe(text);
  });
});

describe("mergeEvents", () => {
  it("adds history and live events once, oldest first", () => {
    const first = logEvent({ kind: "work", slug: "a", phase: "work", turn: 1 }, at);
    const second = logEvent({ kind: "work", slug: "a", phase: "check", turn: 1 }, at + 5);
    const live = mergeEvents([], [second]);
    const merged = mergeEvents(live, [first, { ...second }]);
    expect(merged).toEqual([first, second]);
    expect(mergeEvents(merged, [{ ...first }])).toBe(merged);
    // Another round of the same phase is a separate event.
    expect(mergeEvents(merged, [{ ...second, round: 1 }])).toHaveLength(3);
  });
});
