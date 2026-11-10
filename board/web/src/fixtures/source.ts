// `npm run dev:fixture`: plays the fixtures instead of talking to the server. The fixture times are
// shifted so that the snapshot looks fresh and stream message i happens i seconds after it.
import type { BoardSource } from "../lib/source";
import { ART, BACKDROPS } from "../map/art";
import { emptyState, reduce, type BoardState } from "../store/reduce";
import type { Activity, Cargo, ServerMessage, Snapshot, TaskDetail, TaskFile, TaskLimits, TaskMessage } from "../types";
import snapshotJson from "./snapshot.json";
import streamJson from "./stream.json";
import detailsJson from "./details.json";
import { FIXTURE_EVENTS, FIXTURE_LIVE, demoEvents, demoReport, logEvent } from "./events";
import type { ActionSender } from "../lib/actions";
import { fixtureActions, fixtureResearch, type StationRoute } from "./research";
import { fixtureShips, type ShipRoute } from "./ships";

interface FixtureDetail {
  timeline: { at: number; text: string }[];
  files: Partial<Record<TaskFile, string>>;
  cargo?: Cargo;
  limits?: TaskLimits | null;
  messages?: TaskMessage[];
  activity_log?: Activity[];
  actions?: TaskDetail["actions"];
}

/** A task's cargo when the fixtures give none: present, but with nothing in it. */
const NO_CARGO: Cargo = {
  check: null, claims: [], review: null, stop: null, ci: null, base: null, remaining: [], questions: [], decisions: { fixed: 0, rejected: 0 },
};

const snapshot = snapshotJson as unknown as Snapshot;
const stream = streamJson as unknown as ServerMessage[];
const details = detailsJson as unknown as Record<string, FixtureDetail>;
const BASE = snapshot.generated_at;

const STEP_MS = 1000;
/** A new line in the ship's log this often. */
const EVENT_MS = 9000;

const TIME_KEYS = new Set([
  "generated_at", "phase_started_at", "sleeping_until", "created", "updated_at", "at", "fetched_at",
  "resets_at", "limited_until", "expires_at", "since", "checked_at", "sampled_at",
  "last_run_at", "last_scheduled_for", "next_at",
]);

function shiftValue(value: unknown, delta: number): unknown {
  if (typeof value === "number") return value + delta;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms + delta * 1000).toISOString();
  }
  if (Array.isArray(value)) return value.map((item) => shiftValue(item, delta));
  return value;
}

/** Copies `value` with every known time field moved by `delta` seconds. */
export function shiftTimes<T>(value: T, delta: number): T {
  if (Array.isArray(value)) return value.map((item) => shiftTimes(item, delta)) as T;
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = TIME_KEYS.has(key) && item !== null ? shiftValue(item, delta) : shiftTimes(item, delta);
  }
  return out as T;
}

export function fixtureSource(): BoardSource {
  let state: BoardState = emptyState;
  let delta = 0;
  // The history is anchored once, so that a reload returns the same events rather than shifted copies.
  const origin = Date.now() / 1000;
  // The station's actions change this copy; its times stay in the snapshot's, like the rest of the fixtures.
  const research = fixtureResearch(BASE);
  const station = fixtureActions(research, () => Date.now() / 1000 - delta);
  // A ship's orders change the board itself, in the board's time.
  let push: ((message: ServerMessage) => void) | null = null;
  const ships = fixtureShips(() => state.tasks, () => Date.now() / 1000, (message) => push?.(message));
  /** A say to a study goes to the station; every other say and order goes to the ship. */
  const act: ActionSender = async (route, body) => {
    const slug = (body as { slug?: string }).slug;
    const study = route === "say" && (!slug || !state.tasks[slug] || state.tasks[slug]!.kind === "reflect");
    if (route === "lesson" || route === "implement" || route === "reflect" || study) return station(route as StationRoute, body as never);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return ships.act(route as ShipRoute, body as never);
  };
  return {
    label: "фикстуры",
    act,
    connect(onMessage, onState) {
      let index = -1; // -1 = the snapshot, then the stream; the cycle repeats like a reconnect.
      const emit = (original: ServerMessage) => {
        const message = ships.patch(original);
        if (!message) return;
        state = reduce(state, message, Date.now());
        onMessage(message);
      };
      push = emit;
      const step = () => {
        const now = Date.now() / 1000;
        if (index < 0) {
          delta = now - BASE;
          emit(shiftTimes<ServerMessage>({ type: "snapshot", snapshot }, delta));
        } else {
          const message = stream[index];
          if (message) emit(shiftTimes(message, now - (BASE + index + 1)));
        }
        index = index + 1 >= stream.length ? -1 : index + 1;
      };
      onState("connecting", null);
      onState("open", null);
      step();
      const timer = setInterval(step, STEP_MS);
      let live = 0;
      const events = setInterval(() => {
        const event = FIXTURE_LIVE[live++ % FIXTURE_LIVE.length]!;
        onMessage({ type: "event", event: logEvent(event, Date.now() / 1000) });
      }, EVENT_MS);
      return () => {
        push = null;
        clearInterval(timer);
        clearInterval(events);
      };
    },
    async fetchDetail(slug) {
      const task = state.tasks[slug];
      if (!task) return null;
      const extra = details[slug];
      const timeline = extra?.timeline.length
        ? shiftTimes(extra.timeline, delta)
        : task.created !== null
          ? [{ at: task.created, text: "задача создана" }]
          : [];
      const files = (["brief", "last", "review", "check"] as const).filter((name) => extra?.files[name] !== undefined);
      const cargo = task.kind === "session" ? null : shiftTimes(extra?.cargo ?? NO_CARGO, delta);
      const detail: TaskDetail = { ...task, timeline, files, cargo };
      // The fields newer servers add stay absent where the fixture leaves them out, as from an older server.
      for (const key of ["limits", "messages", "activity_log", "actions"] as const) {
        if (extra?.[key] !== undefined) Object.assign(detail, { [key]: shiftTimes(extra[key], delta) });
      }
      const sent = ships.sent(slug);
      if (sent.length) detail.messages = [...(detail.messages ?? []), ...sent];
      return detail;
    },
    async fetchFile(slug, name) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return details[slug]?.files[name] ?? null;
    },
    // Shared pictures in other roles, so that one repository looks like itself and the others stay as they are.
    async fetchArt() {
      return { "demo-game": { sky: BACKDROPS[0], planet: ART.planetRoadstead, emblem: ART.gate } };
    },
    async fetchConstellations() {
      return { constellations: [{ name: "Demo Wallet", repos: ["demo-wallet*", "demo-vault", "demo-shop"] }], error: null };
    },
    async fetchResearch() {
      return shiftTimes(research, delta);
    },
    async fetchEvents(since, until) {
      return demoEvents(FIXTURE_EVENTS, origin, since, until);
    },
    async fetchReport() {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return demoReport(Date.now() / 1000, [
        { slug: "accounts-json-schema", repo: "teamster", minutes: 96, turns: 2 },
        { slug: "budget-overrun", repo: "ml-lab", minutes: 74, turns: 3 },
        { slug: "cdp-screenshot-tool", repo: "teamster", minutes: 41, turns: 2 },
        { slug: "board-web-frontend", repo: "teamster", minutes: 33, turns: 1 },
        { slug: "review-ws-reconnect", repo: "demo-vault", minutes: 18, turns: 1 },
        { slug: "demo-tunnel-land", repo: "demo-tunnel", minutes: 12, turns: 1 },
        { slug: "scout-api-shape", repo: "demo-assistant", minutes: 6, turns: 1 },
      ]);
    },
  };
}
