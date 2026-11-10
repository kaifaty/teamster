<script setup lang="ts">
// Telemetry in «Сейчас»: while the ship works, the agent's latest actions, newest first — the detail's log and every
// live activity the socket brought after it.
import { computed, ref, watch } from "vue";
import { coarseSpan } from "../../lib/format";
import type { Activity, TaskSummary } from "../../types";
import { TELEMETRY_LIMIT, TELEMETRY_WORDS, mergeTelemetry } from "./telemetry";

const props = defineProps<{
  task: TaskSummary;
  /** The detail's activity log, newest first. */
  log: readonly Activity[];
  /** Whether the detail has loaded: live activities count from then on. */
  loaded: boolean;
  now: number;
  /** At most this many rows. */
  limit?: number;
}>();

const live = ref<Activity[]>([]);
watch(
  () => props.task.slug,
  () => {
    live.value = [];
  },
);
watch(
  () => props.task.activity,
  (activity) => {
    if (activity && props.loaded) live.value = [activity, ...live.value].slice(0, TELEMETRY_LIMIT);
  },
);

const rows = computed(() => (props.task.alive ? mergeTelemetry(props.log, live.value).slice(0, props.limit ?? TELEMETRY_LIMIT) : []));
const MONO = new Set<Activity["kind"]>(["command", "edit", "tool"]);
const age = (activity: Activity) => (activity.at !== null ? coarseSpan(Math.max(0, props.now - activity.at)) : "—");
</script>

<template>
  <p v-if="!rows.length" class="empty">{{ loaded ? "Агент пока ничего не сделал" : "…" }}</p>
  <ul v-else class="tele" aria-live="polite">
    <li v-for="activity in rows" :key="`${activity.at}-${activity.text}`">
      <span class="k" :class="activity.kind">{{ TELEMETRY_WORDS[activity.kind] ?? activity.kind }}</span>
      <span class="x" :class="{ mono: MONO.has(activity.kind) }" :title="activity.text">{{ activity.text }}</span>
      <span class="a num">{{ age(activity) }}</span>
    </li>
  </ul>
</template>

<style scoped>
.tele {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tele li {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}

.k {
  color: var(--sh-faint);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.k.command {
  color: var(--sh-teal);
}

.k.edit {
  color: var(--sh-copper);
}

.k.tool {
  color: #b892ff;
}

.k.message {
  color: var(--sh-blue);
}

/* A long or many-line command keeps two lines; its whole text is in the title. */
.x {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.a {
  color: var(--sh-faint);
  font-size: 11px;
  white-space: nowrap;
}
</style>
