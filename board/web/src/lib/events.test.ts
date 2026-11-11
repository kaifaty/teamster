import { describe, expect, it } from "vitest";
import { logEvent } from "../fixtures/events";
import type { LogEvent } from "../types";
import { eventText, mergeEvents } from "./events";

const at = 1_800_000_000;
const event = (fields: Partial<LogEvent> & Pick<LogEvent, "kind">) => logEvent({ slug: "ship", repo: "demo", ...fields }, at);

describe("eventText", () => {
  it.each([
    [{ kind: "work", phase: "work", outcome: "completed" }, "ship: ход закончен"],
    [{ kind: "work", phase: "fix", round: 2, outcome: "completed" }, "ship: исправлено, круг 2"],
    [{ kind: "work", phase: "work", outcome: "budget_exhausted" }, "ship: бюджет исчерпан"],
    [{ kind: "work", phase: "fix", outcome: "budget_exhausted" }, "ship: бюджет исчерпан"],
    [{ kind: "work", phase: "work", outcome: "failed" }, "ship: ход прерван"],
    [{ kind: "work", phase: "work", outcome: "stuck" }, "ship: ход прерван"],
    [{ kind: "work", phase: "fix", outcome: "stopped" }, "ship: ход прерван"],
    [{ kind: "work", phase: "check", outcome: "passed" }, "ship: проверка прошла"],
    [{ kind: "work", phase: "check", outcome: "failed" }, "ship: проверка упала"],
    [{ kind: "work", phase: "check", outcome: "timeout" }, "ship: проверка упала"],
    [{ kind: "review", phase: "review", outcome: "completed", findings: 3 }, "ship: ревью нашло замечаний: 3"],
    [{ kind: "review", phase: "review", outcome: "completed", findings: 0 }, "ship: ревью чистое"],
    [{ kind: "work", phase: "turn", outcome: "completed", ci: "failed" }, "ship: CI упал"],
    [{ kind: "work", phase: "turn", outcome: "completed", ci: "passed" }, "ship: CI прошёл"],
    [{ kind: "verdict", verdict: "accepted" }, "ship: принято"],
    [{ kind: "verdict", verdict: "revised" }, "ship: принято с правками"],
    [{ kind: "verdict", verdict: "redone" }, "ship: на переделку"],
    [{ kind: "verdict", verdict: "dropped" }, "ship: отброшено"],
    [{ kind: "scout", phase: "scout", outcome: "completed" }, "ship: разведка закончена"],
    [{ kind: "scout", phase: "scout", outcome: "failed" }, "ship: ход прерван"],
    [{ kind: "scout", phase: "turn", outcome: "completed" }, "ship: turn completed"],
    [{ kind: "work", phase: "turn", outcome: "budget_exhausted" }, "ship: turn budget_exhausted"],
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
