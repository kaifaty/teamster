// Telemetry: the agent's latest actions while the ship works — the detail's activity log and every live activity
// that came over the socket after it, newest first.

import type { Activity } from "../../types";

/** The deck shows at most this many actions. */
export const TELEMETRY_LIMIT = 10;

/** Each kind of action in a word, as the deck labels and colours it. */
export const TELEMETRY_WORDS: Record<Activity["kind"], string> = {
  command: "команда",
  edit: "правка",
  message: "сообщение",
  tool: "инструмент",
  thinking: "мысль",
};

const keyOf = (activity: Activity) => JSON.stringify([activity.at, activity.text]);

/** The detail's log with the live activities added: one row per `at` and text, newest first, at most TELEMETRY_LIMIT. */
export function mergeTelemetry(log: readonly Activity[], live: readonly Activity[]): Activity[] {
  const seen = new Set<string>();
  const rows: Activity[] = [];
  for (const activity of [...live, ...log]) {
    if (!activity || typeof activity.text !== "string") continue;
    const key = keyOf(activity);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(activity);
  }
  // A stable sort: rows without a time keep their place after the timed ones.
  rows.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
  return rows.slice(0, TELEMETRY_LIMIT);
}
