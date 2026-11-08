// The replay's state: which day, which moment, playing or not, and the day's events. Null `at` is the live map.

import { computed, markRaw, onBeforeUnmount, reactive, ref, shallowRef, watch, type Ref } from "vue";
import { mergeEvents } from "../lib/events";
import type { Board } from "../store/board";
import type { LogEvent } from "../types";
import { REPLAY_QUIET_SECONDS, replayWindow, type ReplayWindow } from "./replay";

/** Replay speeds: seconds of the day per second of the replay. */
export const REPLAY_SPEEDS = [60, 600, 3600] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export function useReplay(board: Ref<Board>, now: Ref<number>) {
  // With reduced motion the replay moves in steps: once a second rather than ten times.
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const day = ref("");
  const at = ref<number | null>(null);
  const playing = ref(false);
  const speed = ref<ReplaySpeed>(600);
  const frozen = ref<ReplayWindow | null>(null);
  const loaded = shallowRef<readonly LogEvent[]>([]);
  const error = ref<string | null>(null);

  const active = computed(() => at.value !== null);
  /** The window on the scale: the replayed day, or the last 24 hours up to now while live. */
  const window = computed(() => frozen.value ?? replayWindow(day.value, now.value));
  /** The events behind the map: the day's, with a lookback for tasks already under way when it starts. */
  // Raw, so that the reactive state below hands the list out as it is rather than a deep proxy of it.
  const events = computed(() => markRaw((active.value ? loaded.value : board.value.events.value) as LogEvent[]) as readonly LogEvent[]);

  let request = 0;
  async function load(span: ReplayWindow) {
    const ask = ++request;
    const from = board.value;
    // The last day is already in memory; it shows at once and the lookback joins it.
    loaded.value = day.value === "" ? from.events.value : [];
    error.value = null;
    try {
      const history = await from.source.fetchEvents(span.since - REPLAY_QUIET_SECONDS, span.until);
      if (ask !== request) return;
      loaded.value = mergeEvents(loaded.value, Array.isArray(history?.events) ? history.events : []);
    } catch (failure) {
      if (ask !== request) return;
      error.value = failure instanceof Error ? failure.message : String(failure);
    }
  }

  /** Freezes the window and loads its events, unless the replay already runs on it. */
  function enter() {
    if (frozen.value) return;
    frozen.value = replayWindow(day.value, Date.now() / 1000);
    void load(frozen.value);
  }

  const clamp = (t: number) => Math.min(window.value.until, Math.max(window.value.since, t));

  function seek(t: number) {
    enter();
    at.value = clamp(t);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let last = 0;
  function tick() {
    const time = performance.now();
    const next = (at.value ?? window.value.since) + ((time - last) / 1000) * speed.value;
    last = time;
    at.value = clamp(next);
    if (at.value >= window.value.until) pause();
  }

  function play() {
    enter();
    if (at.value === null || at.value >= window.value.until) at.value = window.value.since;
    playing.value = true;
    clearInterval(timer);
    last = performance.now();
    timer = setInterval(tick, still ? 1000 : 100);
  }

  function pause() {
    playing.value = false;
    clearInterval(timer);
  }

  /** Back to the live map; the board kept its updates all along. */
  function live() {
    pause();
    request++;
    at.value = null;
    frozen.value = null;
    day.value = "";
    loaded.value = [];
    error.value = null;
  }

  /** Another day: the replay starts at its beginning, paused. */
  function choose(next: string) {
    pause();
    day.value = next;
    frozen.value = null;
    enter();
    at.value = window.value.since;
  }

  watch(board, live);
  onBeforeUnmount(pause);

  return reactive({ still, day, at, playing, speed, window, events, error, active, seek, play, pause, live, choose });
}

export type Replay = ReturnType<typeof useReplay>;
