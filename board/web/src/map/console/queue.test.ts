import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../../types";
import { stars } from "../fleet";
import { arrivals, nextInQueue, queueOf, slugsIn } from "./queue";

const NOW = 1_800_000_000;
const task = (slug: string, column: TaskSummary["column"], since: number | null, updated = NOW, repo = "repo") =>
  ({ slug, repo, column, phase_started_at: since, updated_at: updated }) as TaskSummary;

describe("the command row's queues", () => {
  const tasks = [
    task("late", "review_me", NOW - 60),
    task("early", "review_me", NOW - 600, NOW, "other"),
    task("no-phase", "review_me", null, NOW - 300),
    task("alarm", "attention", NOW - 10),
    task("busy", "running", NOW - 9000),
    task("done", "closed", NOW - 9000),
  ];

  it("lists a column's tasks, the one that has waited longest first, by its phase or else its last change", () => {
    expect(queueOf(tasks, "review_me").map((item) => item.slug)).toEqual(["early", "no-phase", "late"]);
    expect(queueOf(tasks, "attention").map((item) => item.slug)).toEqual(["alarm"]);
  });

  it("counts what the systems' badges count", () => {
    const badges = stars(tasks);
    expect(queueOf(tasks, "review_me").length).toBe(badges.reduce((sum, star) => sum + star.ready, 0));
    expect(queueOf(tasks, "attention").length).toBe(badges.reduce((sum, star) => sum + star.attention, 0));
  });

  it("goes round the queue from the task opened last, and starts again when that one has left", () => {
    const queue = queueOf(tasks, "review_me");
    expect(nextInQueue(queue, null)?.slug).toBe("early");
    expect(nextInQueue(queue, "early")?.slug).toBe("no-phase");
    expect(nextInQueue(queue, "late")?.slug).toBe("early");
    expect(nextInQueue(queue, "gone")?.slug).toBe("early");
    expect(nextInQueue([], "early")).toBeNull();
  });

  it("tells which tasks have just come into a column, and none at the first snapshot", () => {
    const before = slugsIn(tasks, "review_me");
    const now = slugsIn([...tasks.filter((item) => item.slug !== "late"), task("new", "review_me", NOW)], "review_me");
    expect(arrivals(before, now)).toEqual(["new"]);
    expect(arrivals(null, now)).toEqual([]);
    expect(arrivals(now, now)).toEqual([]);
  });
});
