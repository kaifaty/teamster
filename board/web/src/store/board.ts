import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import type { BoardSource } from "../lib/source";
import type { ConnectionState } from "../lib/socket";
import { LOG_WINDOW_SECONDS, mergeEvents } from "../lib/events";
import type { LogEvent } from "../types";
import { emptyState, reduce, type BoardState } from "./reduce";

export function createBoard(source: BoardSource) {
  const state = shallowRef<BoardState>(emptyState);
  const connection = ref<ConnectionState>("connecting");
  const retryInMs = ref<number | null>(null);
  let stop: (() => void) | null = null;

  // The ship's log: the last day's history, loaded when the map wants it, and the live `event` messages.
  const events = shallowRef<readonly LogEvent[]>([]);
  const eventsError = ref<string | null>(null);
  let eventsWanted = false;
  let eventsRequest = 0;
  async function loadEvents() {
    eventsWanted = true;
    const request = ++eventsRequest;
    const until = Date.now() / 1000;
    try {
      const history = await source.fetchEvents(until - LOG_WINDOW_SECONDS, until);
      if (request !== eventsRequest) return;
      eventsError.value = null;
      events.value = mergeEvents(events.value, Array.isArray(history?.events) ? history.events : []);
    } catch (error) {
      if (request !== eventsRequest) return;
      eventsError.value = error instanceof Error ? error.message : String(error);
    }
  }

  const start = () => {
    stop?.();
    stop = source.connect(
      (message) => {
        if (message.type === "event") {
          if (message.event) events.value = mergeEvents(events.value, [message.event]);
          return;
        }
        // A reconnect may have missed events: once the log is open, it catches up with the new snapshot.
        if (message.type === "snapshot" && eventsWanted && state.value.loaded) void loadEvents();
        state.value = reduce(state.value, message, Date.now());
      },
      (next, retry) => {
        connection.value = next;
        retryInMs.value = retry;
      },
    );
  };

  return {
    source,
    state,
    connection,
    retryInMs,
    tasks: computed(() => Object.values(state.value.tasks)),
    events,
    eventsError,
    loadEvents,
    start,
    stop: () => {
      stop?.();
      stop = null;
    },
  };
}

export type Board = ReturnType<typeof createBoard>;

/** Current time in Unix seconds, ticking once per second while the component lives. */
export function useNow() {
  const now = ref(Date.now() / 1000);
  const timer = setInterval(() => {
    now.value = Date.now() / 1000;
  }, 1000);
  onBeforeUnmount(() => clearInterval(timer));
  return now;
}
