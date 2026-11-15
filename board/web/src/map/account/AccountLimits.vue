<script setup lang="ts">
// A subscription's limits: the week and the five-hour window, each a bar of what is used with the lines where tasks
// begin to prefer another subscription and where they leave it, and in words what is left and when it resets.
import type { LimitBar } from "./account";

defineProps<{ bars: LimitBar[] }>();
</script>

<template>
  <section class="deck" aria-labelledby="account-limits">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">▤</span>
      <h3 id="account-limits">Лимиты</h3>
    </div>
    <div v-for="bar in bars" :key="bar.id" class="limit">
      <div class="label">
        <span class="name">{{ bar.label }}</span>
        <span class="num" :class="`tone-${bar.tone}`">{{ bar.used === null ? "—" : `${Math.round(bar.used)}%` }}</span>
      </div>
      <div
        class="track"
        role="meter"
        :aria-label="`${bar.label}: ${bar.text}`"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="bar.used === null ? undefined : Math.round(bar.used)"
      >
        <span v-if="bar.used !== null" class="fill" :class="bar.tone" :style="{ width: `${Math.min(100, Math.max(0, bar.used))}%` }"></span>
        <span v-for="mark in bar.marks" :key="mark.at" class="mark" :style="{ left: `${mark.at}%` }" :title="mark.title"></span>
      </div>
      <p class="text num">{{ bar.text }}</p>
    </div>
    <p v-if="bars.some((bar) => bar.marks.length)" class="legend dim">
      <span class="mark-key" aria-hidden="true"></span>{{ bars.flatMap((bar) => bar.marks).map((mark) => mark.title).join("; ") }}
    </p>
  </section>
</template>

<style scoped>
.limit {
  display: grid;
  gap: 4px;
}

.label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.name {
  color: var(--sh-text);
  font-weight: 600;
}

.label .num {
  font-size: 15px;
  font-weight: 650;
}

.track {
  position: relative;
  height: 12px;
  overflow: hidden;
  border: 1px solid rgba(214, 170, 96, 0.22);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
}

.fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 5px 0 0 5px;
  background: var(--sh-green);
}

.fill.low {
  background: var(--sh-copper);
}

.fill.bad {
  background: var(--sh-red);
}

.fill.dim {
  background: var(--sh-dim);
}

.mark {
  position: absolute;
  top: -1px;
  bottom: -1px;
  width: 2px;
  margin-left: -1px;
  background: var(--sh-wait);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
}

.text {
  margin: 0;
  color: var(--sh-dim);
  font-size: 12.5px;
}

.legend {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 0;
  font-size: 12px;
}

.mark-key {
  flex: none;
  width: 2px;
  height: 12px;
  background: var(--sh-wait);
}

.tone-ok {
  color: var(--sh-green);
}

.tone-low {
  color: var(--sh-copper);
}

.tone-bad {
  color: var(--sh-red);
}

.tone-dim {
  color: var(--sh-dim);
}
</style>
