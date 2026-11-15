<script setup lang="ts">
// The duty block: the subscription teamster keeps for the orchestrator, with a place for its portrait, what is left in
// it, since when it is on duty and how many tasks are live. A click opens the subscription's screen. Compact, on a
// narrow window, it is one line of the panel's strip.
import type { DutyBlock } from "./texts";

defineProps<{ duty: DutyBlock; compact?: boolean }>();
const emit = defineEmits<{ open: [key: string] }>();
</script>

<template>
  <button
    v-if="duty.key"
    type="button"
    class="console-block console-duty c-press"
    :class="[duty.executor, { compact }]"
    :title="duty.title"
    :aria-label="duty.label ?? undefined"
    :data-account="duty.key"
    @click="emit('open', duty.key)"
  >
    <span v-if="!compact" class="duty-portrait" aria-hidden="true"></span>
    <span class="d-head c-name">{{ duty.heading }}</span>
    <span class="d-line c-text"><span class="d-family">{{ duty.family }}</span> · <span class="num">{{ duty.info }}</span></span>
    <span v-if="duty.since && !compact" class="d-line c-text c-muted num">{{ duty.since }}</span>
    <span v-if="!compact" class="d-live c-text num">{{ duty.live }}</span>
  </button>
  <div v-else class="console-block console-duty none" :class="{ compact }" :title="duty.title">
    <span class="d-head c-name">{{ duty.heading }}</span>
    <span class="d-live c-text num">{{ duty.live }}</span>
  </div>
</template>

<style scoped src="./console.css"></style>

<style scoped>
.console-duty {
  align-items: center;
  justify-content: flex-end;
  gap: 1px;
  font: inherit;
  font-size: 12px;
  text-align: center;
}

.console-duty.none {
  justify-content: center;
}

/*
 * The place for the duty's portrait: a neutral silhouette until a picture takes it, a head and shoulders over a dim
 * glow in the family's colour.
 */
.duty-portrait {
  --tint: rgba(214, 170, 96, 0.35);
  flex: 1 1 0;
  align-self: stretch;
  min-height: 0;
  margin-bottom: 3px;
  border: 1px solid rgba(214, 170, 96, 0.22);
  border-radius: 3px;
  background:
    radial-gradient(circle at 50% 38%, rgba(232, 226, 212, 0.22) 0 14%, transparent 15%),
    radial-gradient(ellipse 34% 26% at 50% 100%, rgba(232, 226, 212, 0.18) 0 98%, transparent 100%),
    radial-gradient(circle at 50% 60%, var(--tint), transparent 70%),
    #0c0f16;
}

.console-duty.codex .duty-portrait {
  --tint: rgba(126, 166, 245, 0.28);
}

.console-duty.claude .duty-portrait {
  --tint: rgba(229, 148, 114, 0.28);
}

.d-head {
  display: -webkit-box;
  flex: none;
  max-width: 100%;
  color: #f3c64e;
  white-space: normal;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.console-duty.none .d-head {
  color: #b8ad98;
}

.d-line,
.d-live {
  max-width: 100%;
}

.console-duty.codex .d-family {
  color: #7ea6f5;
}

.console-duty.claude .d-family {
  color: #e59472;
}

.d-live {
  margin-top: 2px;
  color: #cfc6b4;
}

/* One line of the narrow window's strip. */
.console-duty.compact {
  flex-direction: row;
  justify-content: flex-start;
  gap: 6px;
  height: auto;
  min-height: 44px;
  padding: 0 4px;
  text-align: left;
}

.console-duty.compact .d-head {
  display: block;
  flex: 0 1 auto;
  white-space: nowrap;
}

.console-duty.compact .d-line,
.console-duty.compact .d-live {
  flex: 0 1 auto;
  margin: 0;
}
</style>
