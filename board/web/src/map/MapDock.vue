<script setup lang="ts">
// The dock at the map's bottom: the ship's log.
import type { LogEvent } from "../types";
import ShipLog from "./ShipLog.vue";

defineProps<{
  frame: string;
  logEvents: readonly LogEvent[];
  eventsError: string | null;
  /** The open system; null means the whole galaxy is shown. */
  repo: string | null;
  systemNames: ReadonlySet<string>;
  emblemOf: (repo: string | null) => string | null;
  compactDock: boolean;
}>();
const emit = defineEmits<{ go: [event: LogEvent] }>();
/** Open while the dock is compact. */
const logOpen = defineModel<boolean>("logOpen", { required: true });
</script>

<template>
  <div class="dock">
    <ShipLog
      v-model:open="logOpen"
      :events="logEvents"
      :error="eventsError"
      :repo="repo"
      :frame="frame"
      :systems="systemNames"
      :emblem-of="emblemOf"
      :compact="compactDock"
      @go="emit('go', $event)"
    />
  </div>
</template>

<style scoped>
/* The ship's log. */
.dock {
  position: absolute;
  left: 10px;
  bottom: 8px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(540px, calc(100% - 20px));
  max-height: 62%;
}

.dock > :deep(.log) {
  flex: 0 1 auto;
}

@media (max-width: 760px) {
  .dock {
    left: 4px;
    bottom: 4px;
    width: calc(100% - 8px);
  }
}
</style>
