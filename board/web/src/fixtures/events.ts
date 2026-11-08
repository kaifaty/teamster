// Demo history for the ship's log and the day's summary, for `npm run dev:fixture` and the map's scenario.

import type { Events, LogEvent, Report } from "../types";

/** A journal line without the fields it does not need; `ago` is seconds before now. */
export type DemoEvent = Partial<LogEvent> & Pick<LogEvent, "kind"> & { ago: number };

export function logEvent(event: Omit<DemoEvent, "ago">, at: number): LogEvent {
  return {
    at,
    started: null,
    slug: null,
    repo: null,
    phase: null,
    turn: null,
    round: null,
    outcome: null,
    result_status: null,
    verdict: null,
    findings: null,
    severe_findings: null,
    angle: null,
    account: null,
    reviewer: null,
    provider: null,
    model: null,
    task_type: null,
    ci: null,
    note: null,
    ...event,
  };
}

/** The history at `now`: every demo event, oldest first, inside the requested window. */
export function demoEvents(list: readonly DemoEvent[], now: number, since: number, until: number): Events {
  const events = list
    .map(({ ago, ...event }) => logEvent(event, now - ago))
    .filter((event) => event.at >= since && event.at <= until)
    .sort((a, b) => a.at - b.at);
  return { since, until, events };
}

/** Events of the fixture board's tasks: every kind of line the log knows, over the last day. */
export const FIXTURE_EVENTS: readonly DemoEvent[] = [
  { ago: 22 * 3600, kind: "verdict", slug: "flaky-e2e", repo: "demo-wallet", verdict: "dropped", note: "flaky test moved elsewhere" },
  { ago: 20 * 3600, kind: "work", slug: "pr-template", repo: "teamster", phase: "work", turn: 1, outcome: "completed" },
  { ago: 19.5 * 3600, kind: "work", slug: "pr-template", repo: "teamster", phase: "check", turn: 1, outcome: "passed" },
  { ago: 19 * 3600, kind: "review", slug: "pr-template", repo: "teamster", phase: "review", turn: 1, round: 0, angle: "correctness", outcome: "completed", findings: 0, verdict: "clean" },
  { ago: 18.8 * 3600, kind: "work", slug: "pr-template", repo: "teamster", phase: "turn", turn: 1, outcome: "completed", ci: "passed" },
  { ago: 17 * 3600, kind: "verdict", slug: "pr-template", repo: "teamster", verdict: "accepted" },
  { ago: 9 * 3600, kind: "scout", slug: "scout-api-shape", repo: "demo-assistant", phase: "scout", outcome: "completed" },
  { ago: 6 * 3600, kind: "work", slug: "budget-overrun", repo: "ml-lab", phase: "work", turn: 2, outcome: "budget_exhausted" },
  { ago: 5 * 3600, kind: "work", slug: "demo-tunnel-land", repo: "demo-tunnel", phase: "work", turn: 1, outcome: "stuck" },
  { ago: 4 * 3600, kind: "work", slug: "accounts-json-schema", repo: "teamster", phase: "work", turn: 1, outcome: "completed" },
  { ago: 3.9 * 3600, kind: "work", slug: "accounts-json-schema", repo: "teamster", phase: "check", turn: 1, outcome: "failed" },
  { ago: 3.7 * 3600, kind: "work", slug: "accounts-json-schema", repo: "teamster", phase: "fix", turn: 1, round: 1, outcome: "completed" },
  { ago: 3.6 * 3600, kind: "work", slug: "accounts-json-schema", repo: "teamster", phase: "check", turn: 1, round: 1, outcome: "passed" },
  { ago: 3.4 * 3600, kind: "review", slug: "accounts-json-schema", repo: "teamster", phase: "review", turn: 1, round: 1, angle: "correctness", outcome: "completed", findings: 3, severe_findings: 1 },
  { ago: 3.1 * 3600, kind: "work", slug: "accounts-json-schema", repo: "teamster", phase: "fix", turn: 1, round: 2, outcome: "completed" },
  { ago: 3 * 3600, kind: "work", slug: "accounts-json-schema", repo: "teamster", phase: "turn", turn: 1, outcome: "completed", ci: "failed" },
  { ago: 2.5 * 3600, kind: "work", slug: "cdp-screenshot-tool", repo: "teamster", phase: "turn", turn: 2, outcome: "completed", ci: "passed" },
  { ago: 2 * 3600, kind: "verdict", slug: "merge-conflict-fix", repo: "demo-vault", verdict: "redone", note: "conflicts with the new schema" },
  { ago: 100 * 60, kind: "review", slug: "review-ws-reconnect", repo: "demo-vault", phase: "review", turn: 1, angle: "correctness", outcome: "completed", findings: 2 },
  { ago: 80 * 60, kind: "work", slug: "died-supervisor", repo: "demo-wallet", phase: "work", turn: 3, outcome: "failed" },
  { ago: 60 * 60, kind: "work", slug: "ml-eval-pipeline", repo: "ml-lab", phase: "check", turn: 1, outcome: "timeout" },
  { ago: 45 * 60, kind: "verdict", slug: "cdp-screenshot-tool", repo: "teamster", verdict: "revised", note: "renamed the option" },
  { ago: 30 * 60, kind: "work", slug: "nightly-bench", repo: "demo-tunnel", phase: "wrapup", turn: 2, outcome: "stopped" },
  { ago: 20 * 60, kind: "work", slug: "orphan-row", repo: null, phase: "base_check", turn: 1, outcome: "skipped" },
  { ago: 12 * 60, kind: "work", slug: "board-web-frontend", repo: "teamster", phase: "work", turn: 1, outcome: "completed" },
  { ago: 6 * 60, kind: "work", slug: "board-web-frontend", repo: "teamster", phase: "check", turn: 1, outcome: "passed" },
];

/** Live lines the fixture board adds, one at a time, round and round. */
export const FIXTURE_LIVE: readonly Omit<DemoEvent, "ago">[] = [
  { kind: "review", slug: "board-web-frontend", repo: "teamster", phase: "review", turn: 1, angle: "correctness", outcome: "completed", findings: 1 },
  { kind: "work", slug: "board-web-frontend", repo: "teamster", phase: "fix", turn: 1, round: 1, outcome: "completed" },
  { kind: "work", slug: "ci-wait-retry", repo: "demo-assistant", phase: "turn", turn: 2, outcome: "completed", ci: "passed" },
  { kind: "review", slug: "board-web-frontend", repo: "teamster", phase: "review", turn: 1, round: 1, angle: "correctness", outcome: "completed", findings: 0 },
  { kind: "verdict", slug: "accounts-json-schema", repo: "teamster", verdict: "accepted" },
];

/** A day's report, as `teamster report --json --by executor` prints it, with the fields the summary reads. */
export function demoReport(now: number, slugs: { slug: string; repo: string; minutes: number; turns: number }[]): Report {
  return {
    fetched_at: now,
    error: null,
    data: {
      since: new Date(now * 1000).toISOString().slice(0, 10) + "T00:00:00Z",
      until: new Date(now * 1000).toISOString(),
      filters: { repo: null, slug: null },
      summary: {
        tasks: slugs.length,
        turns: slugs.reduce((sum, task) => sum + task.turns, 0),
        active_hours: slugs.reduce((sum, task) => sum + task.minutes, 0) / 60,
        checks: { total: 14, passed: 11, pass_fraction: 11 / 14 },
        ci: { total: 6, passed: 4, pass_fraction: 4 / 6 },
        reviews: { total: 9, with_defects: 4, defect_fraction: 4 / 9, findings: 11, average_findings: 11 / 9 },
        fix_rounds_to_clean: { "0": 3, "1": 2, "2": 1 },
      },
      by: ["executor"],
      groups: [
        { executor: "claude", tasks: Math.ceil(slugs.length / 2), done_fraction: 0.75, median_active_minutes: 38 },
        { executor: "codex", tasks: Math.floor(slugs.length / 2), done_fraction: 0.6, median_active_minutes: 52 },
      ],
      tasks: slugs.map((task) => ({ ...task, active_minutes: task.minutes })),
    },
  };
}
