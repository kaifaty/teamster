<script setup lang="ts">
// The steps of a start the server runs in the background, live: each done step with how long it went, the step that
// goes, and the failure with its error. The lesson's thread and a channel just ordered show them.
import { computed } from "vue";
import type { Launch } from "../../types";
import { launchSteps, stepTime } from "./launch";

const props = defineProps<{ launch: Launch; now: number }>();
const steps = computed(() => launchSteps(props.launch, props.now));
const MARK = { done: "✓", running: "", failed: "✕" } as const;
</script>

<template>
  <div class="launch">
    <ol class="steps" aria-label="Шаги запуска">
      <li v-for="step in steps" :key="step.stage" class="step" :class="step.state">
        <span class="mark" aria-hidden="true">{{ MARK[step.state] }}</span>
        <span class="text">{{ step.text }}<span v-if="step.state === 'running'" class="visually-hidden"> — идёт</span></span>
        <span v-if="step.state === 'running'" class="time" aria-hidden="true">идёт<span class="dots"></span></span>
        <span v-else class="time num">{{ stepTime(step.seconds) }}</span>
      </li>
    </ol>
    <div v-if="launch.stage === 'failed'" class="fail-box" role="alert">
      <p class="f-head">Запуск не удался</p>
      <p v-if="launch.error" class="f-error">{{ launch.error }}</p>
      <slot name="failed"></slot>
    </div>
  </div>
</template>

<style scoped>
.launch {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12.5px;
}

.step {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  color: #cfe9e4;
}

.mark {
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  font-size: 10px;
  line-height: 1;
}

.done .mark {
  background: rgba(111, 207, 143, 0.2);
  color: var(--st-green);
}

.running .mark {
  border: 2px solid rgba(95, 214, 200, 0.3);
  border-top-color: var(--st-teal);
  animation: spin 0.9s linear infinite;
}

.running .text {
  color: var(--st-teal);
}

.step.failed .mark {
  background: rgba(255, 141, 122, 0.2);
  color: var(--st-red);
}

.step.failed .text {
  color: #ffb39e;
}

.time {
  color: var(--st-dim);
  font-size: 11.5px;
}

.fail-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border-left: 2px solid var(--st-red);
  background: rgba(255, 141, 122, 0.08);
}

.f-head {
  margin: 0;
  color: #ffb39e;
  font-weight: 600;
}

.f-error {
  margin: 0;
  color: #f0d6cf;
  font-size: 12.5px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .running .mark {
    animation: none;
  }
}
</style>
