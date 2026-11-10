<script setup lang="ts">
// The deck «Приборы»: dials of the turn's time, the task's fuel, the repair rounds and the gate's attempts; a scout
// has only the first two. A dial without data reads «—».
import { computed } from "vue";
import type { Cargo, TaskLimits, TaskSummary } from "../../types";
import { gaugesOf, type Gauge } from "./bridge";

const props = defineProps<{ task: TaskSummary; limits: TaskLimits | null | undefined; cargo: Cargo | null | undefined; now: number }>();

const gauges = computed(() => gaugesOf(props.task, props.limits, props.cargo, props.now));
/** The dial's circle: r = 32. */
const ROUND = 2 * Math.PI * 32;
const dash = (gauge: Gauge) => `${(gauge.share ?? 0) * ROUND} ${ROUND}`;
</script>

<template>
  <section class="deck gauges-deck" aria-labelledby="gauges-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">◔</span>
      <h3 id="gauges-deck">Приборы</h3>
      <span class="aside">лимиты задаются при старте</span>
    </div>
    <div class="gauges">
      <div v-for="gauge in gauges" :key="gauge.id" class="gauge well" :class="[gauge.id, gauge.tone, { none: gauge.share === null }]">
        <svg viewBox="0 0 80 80" aria-hidden="true">
          <circle class="track" cx="40" cy="40" r="32" />
          <circle v-if="gauge.share" class="fill" cx="40" cy="40" r="32" :stroke-dasharray="dash(gauge)" transform="rotate(-90 40 40)" />
        </svg>
        <b class="val num">{{ gauge.value }}</b>
        <span class="lbl">{{ gauge.label }}</span>
        <span class="hint">{{ gauge.hint }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.gauges {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
  gap: 8px;
}

.gauge {
  --dial: var(--sh-teal);
  display: grid;
  justify-items: center;
  gap: 2px;
  min-width: 0;
  padding: 8px 4px;
  text-align: center;
}

.gauge.fuel {
  --dial: var(--sh-title);
}

.gauge.repairs {
  --dial: var(--sh-copper);
}

.gauge.gate {
  --dial: var(--sh-blue);
}

.gauge.warn {
  --dial: var(--sh-wait);
}

.gauge.bad {
  --dial: var(--sh-red);
}

svg {
  width: 74px;
  height: 74px;
}

circle {
  fill: none;
  stroke-width: 7;
}

.track {
  stroke: rgba(214, 170, 96, 0.15);
}

.fill {
  stroke: var(--dial);
  stroke-linecap: round;
  transition: stroke-dasharray 0.6s ease-out;
}

.val {
  font-size: 15px;
  font-weight: 600;
}

.gauge.bad .val {
  color: var(--sh-red);
}

.gauge.none .val {
  color: var(--sh-faint);
}

.lbl {
  color: var(--sh-dim);
  font-size: 11.5px;
}

.hint {
  color: var(--sh-faint);
  font-size: 11px;
}

@media (prefers-reduced-motion: reduce) {
  .fill {
    transition: none;
  }
}
</style>
