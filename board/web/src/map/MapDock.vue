<script setup lang="ts">
// The dock at the map's bottom: the ship's log with its buttons and, over it, the replay's scale; and the replay's
// plate, over the sky on a wide window and in the dock on a phone.
import type { LogEvent } from "../types";
import ReplayBar from "./ReplayBar.vue";
import ShipLog from "./ShipLog.vue";
import type { Replay } from "./useReplay";

defineProps<{
  /** The replayed moment's time, or null while the map is live. */
  replayTime: string | null;
  replayVisible: boolean;
  replay: Replay;
  frame: string;
  now: number;
  logEvents: readonly LogEvent[];
  eventsError: string | null;
  /** The open system; null means the whole galaxy is shown. */
  repo: string | null;
  systemNames: ReadonlySet<string>;
  emblemOf: (repo: string | null) => string | null;
  compactDock: boolean;
}>();
const emit = defineEmits<{ toggleReplay: []; go: [event: LogEvent]; seek: [event: LogEvent] }>();
/** Open while the dock is compact. */
const logOpen = defineModel<boolean>("logOpen", { required: true });
</script>

<template>
  <div class="dock">
    <p v-if="replayTime" class="plate in-dock num" aria-hidden="true">Перемотка · {{ replayTime }}</p>
    <ReplayBar v-show="replayVisible" id="replay-scale" :replay="replay" :frame="frame" :now="now" />
    <ShipLog
      v-model:open="logOpen"
      :events="logEvents"
      :error="replay.at === null ? eventsError : replay.error"
      :repo="repo"
      :frame="frame"
      :systems="systemNames"
      :emblem-of="emblemOf"
      :at="replay.at"
      :compact="compactDock"
      @go="emit('go', $event)"
      @seek="emit('seek', $event)"
    >
      <template #head>
        <button
          type="button"
          class="dock-replay"
          :class="{ on: replay.active }"
          aria-controls="replay-scale"
          :aria-expanded="replayVisible"
          aria-label="Перемотка дня"
          :title="replayVisible ? 'Скрыть перемотку дня' : 'Показать перемотку дня'"
          @click="emit('toggleReplay')"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
            <path d="M1 6.4l1.5 1.8L4 6.4" />
            <path d="M8 5v3.2l2.2 1.4" />
          </svg>
        </button>
        <!-- The way back to the live map while the scale with its own button is hidden. -->
        <button v-if="replay.active && !replayVisible" type="button" class="dock-live" @click="replay.live()">В эфир</button>
      </template>
    </ShipLog>
  </div>
  <p v-if="replayTime" class="plate on-sky num" role="status">Перемотка · {{ replayTime }}</p>
</template>

<style scoped>
/* The ship's log and, over it, the replay's scale. */
.dock {
  position: absolute;
  left: 10px;
  bottom: 8px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  width: min(540px, calc(100% - 20px));
  max-height: 62%;
}

.dock > :deep(.log) {
  flex: 0 1 auto;
}

.dock > :deep(.replay) {
  flex: none;
}

/* At the head of the log: the button that shows or hides the replay's scale, and the way back to the live map. */
.dock-replay,
.dock-live {
  flex: none;
  align-self: center;
  box-sizing: border-box;
  height: 22px;
  margin: 0;
  border: 1px solid rgba(214, 170, 96, 0.35);
  border-radius: 2px;
  background: rgba(20, 22, 28, 0.9);
  color: #b8ad98;
  cursor: pointer;
}

.dock-replay {
  display: inline-grid;
  place-items: center;
  width: 22px;
  padding: 0;
}

.dock-replay:hover,
.dock-live:hover {
  border-color: rgba(243, 198, 78, 0.8);
}

.dock-replay.on {
  color: #f3c64e;
}

.dock-replay[aria-expanded="true"] {
  border-color: rgba(243, 198, 78, 0.9);
  background: rgba(243, 198, 78, 0.22);
  color: #f3c64e;
}

.dock-live {
  padding: 0 6px;
  border-color: rgba(255, 141, 122, 0.7);
  color: #ffb3a3;
  font: inherit;
  font-size: 11.5px;
}

.dock-replay:focus-visible,
.dock-live:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

/* Over the map while it replays; the sky's own labels stay clear under it. */
.plate {
  margin: 0;
  padding: 3px 12px;
  border: 1px solid rgba(243, 198, 78, 0.6);
  border-radius: 3px;
  background: rgba(8, 10, 15, 0.86);
  color: #f3c64e;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.02em;
  pointer-events: none;
  white-space: nowrap;
}

.plate.on-sky {
  position: absolute;
  left: 50%;
  top: 46px;
  z-index: 2;
  transform: translateX(-50%);
}

/* On a phone the toolbar takes the top of the map: the plate stands over the scale instead. */
.plate.in-dock {
  display: none;
  align-self: center;
}

@media (max-width: 760px) {
  .dock {
    left: 4px;
    bottom: 4px;
    width: calc(100% - 8px);
  }

  .plate.on-sky {
    display: none;
  }

  .plate.in-dock {
    display: block;
  }

  .dock-replay,
  .dock-live {
    height: 32px;
  }

  .dock-replay {
    width: 32px;
  }
}
</style>
