// The ship's log: completed phases and lead verdicts (board/CONTRACT.md, LogEvent) told in the map's words.

import type { LogEvent } from "../types";

/** How far back the log reaches when it loads. */
export const LOG_WINDOW_SECONDS = 24 * 3600;
/** The most entries the client keeps; the server sends at most 5000 per request. */
export const LOG_LIMIT = 5000;

/** Two copies of one event (history and a live message) share this key. */
export function eventKey(event: LogEvent): string {
  return JSON.stringify([event.slug, event.kind, event.phase, event.turn, event.round, event.angle, event.at]);
}

/**
 * `current` with `incoming` added: no duplicates, ascending `at`, at most LOG_LIMIT newest. Returns `current`
 * itself when nothing is new, so that a watcher does not fire for a repeat.
 */
export function mergeEvents(current: readonly LogEvent[], incoming: readonly LogEvent[]): readonly LogEvent[] {
  const seen = new Set(current.map(eventKey));
  const added: LogEvent[] = [];
  for (const event of incoming) {
    if (!event || typeof event.at !== "number" || !Number.isFinite(event.at)) continue;
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(event);
  }
  if (!added.length) return current;
  const all = [...current, ...added].sort((a, b) => a.at - b.at);
  return all.length > LOG_LIMIT ? all.slice(all.length - LOG_LIMIT) : all;
}

const LOST = new Set(["failed", "stuck", "stopped"]);

export type EventTone = "ok" | "bad" | "plain";

const ok = (text: string) => ({ text, tone: "ok" as EventTone });
const bad = (text: string) => ({ text, tone: "bad" as EventTone });

/** One short line about the event in the map's words, and whether it is good news; every event gets one. */
export function describeEvent(event: LogEvent): { text: string; tone: EventTone } {
  const slug = event.slug ?? "безымянный корабль";
  const phase = event.phase ?? event.kind;
  const outcome = event.outcome;

  if (event.kind === "verdict") {
    switch (event.verdict) {
      case "accepted":
        return ok(`${slug} ушёл в солнце`);
      case "revised":
        return ok(`${slug} ушёл в солнце после правок`);
      case "redone":
        return bad(`${slug} отправлен на переделку`);
      case "dropped":
        return bad(`${slug} списан`);
    }
    return { text: `${slug}: вердикт ${event.verdict ?? "без отметки"}`, tone: "plain" };
  }
  if (event.kind === "scout" || phase === "scout") return ok(`Разведчик ${slug} вернулся`);
  if (event.ci === "failed") return bad(`Ворота отклонили ${slug}`);
  if (event.ci === "passed") return ok(`${slug} прошёл ворота`);

  if (phase === "work" || phase === "fix" || phase === "turn" || phase === "wrapup") {
    if (outcome === "budget_exhausted") return bad(`${slug} остался без топлива`);
    if (outcome && LOST.has(outcome)) return bad(`${slug} потерял ход`);
    if (outcome === "completed" && phase === "work") return ok(`${slug} вышел с верфи`);
    if (outcome === "completed" && phase === "fix") return ok(event.round !== null ? `${slug} залатан, круг ${event.round}` : `${slug} залатан`);
  }
  if (phase === "check" || phase === "base_check") {
    if (outcome === "passed") return ok(`${slug} прошёл полигон`);
    if (outcome === "failed" || outcome === "timeout") return bad(`${slug} не прошёл полигон`);
  }
  if (phase === "review" && (outcome === "completed" || outcome === null)) {
    if (event.findings !== null && event.findings > 0) return bad(`Инспекция нашла у ${slug} замечаний: ${event.findings}`);
    if (event.findings === 0 || event.verdict === "clean") return ok(`${slug} чист на инспекции`);
  }
  return { text: `${slug}: ${[phase, outcome].filter(Boolean).join(" ")}`, tone: "plain" };
}

export const eventText = (event: LogEvent): string => describeEvent(event).text;
