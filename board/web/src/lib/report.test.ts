import { describe, expect, it } from "vitest";
import { daySummary } from "./report";

describe("daySummary", () => {
  it("leaves the duty chat out of the day's tasks, turns, hours, executors and costly tasks", () => {
    const report = {
      summary: { tasks: 3, turns: 7, active_hours: 2 },
      groups: [
        { executor: "claude", tasks: 2, done_fraction: 0.5, median_active_minutes: 30 },
        { executor: "codex", tasks: 1, done_fraction: 1, median_active_minutes: 60 },
      ],
      tasks: [
        { slug: "duty", repo: "room", turns: 4, active_minutes: 30, executors: ["claude"] },
        { slug: "fix-parser", repo: "parser", turns: 2, active_minutes: 60, executors: ["codex"] },
        { slug: "duty", repo: "parser", turns: 1, active_minutes: 30, executors: ["claude"] },
      ],
    };
    const summary = daySummary(report, [], 0)!;
    expect([summary.tasks, summary.turns, summary.activeHours]).toEqual([2, 3, 1.5]);
    expect(summary.executors.map((group) => [group.name, group.tasks])).toEqual([["claude", 1], ["codex", 1]]);
    expect(summary.costly.map((task) => `${task.repo}/${task.slug}`)).toEqual(["parser/fix-parser", "parser/duty"]);
    // A day of nothing but the conversation has nothing to show.
    const only = { summary: { tasks: 1, turns: 4, active_hours: 0.5 }, groups: [{ executor: "claude", tasks: 1 }],
                   tasks: [{ slug: "duty", repo: "room", turns: 4, active_minutes: 30, executors: ["claude"] }] };
    expect(daySummary(only, [], 0)).toBeNull();
  });
});
