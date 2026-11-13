<script setup lang="ts">
// How a lesson's implementation goes, in its thread: the agent works — with the task's phase and its last action, live,
// or, under the agent's feed, its phase and how long it goes — needs a decision, opened a PR, changed the files outside
// the repository without one, stopped, or the task is closed. A stopped agent's whole report replaces its summary's
// first line once it is known. The reply to the agent stands under the thread, with the lesson's buttons.
import { computed } from "vue";
import type { Lesson } from "../../types";
import { implementationLine, outsideOf } from "../station";
import { useConsole } from "./console";

const props = defineProps<{ lesson: Lesson }>();
const desk = useConsole();

const line = computed(() => implementationLine(props.lesson.implementation, desk.cardOf(props.lesson).started, outsideOf(props.lesson)));
const sent = computed(() => desk.agentSent(props.lesson));
const work = computed(() => desk.workLineOf(props.lesson));
/** The stopped agent's report in full, or the first line of its summary until it is known. */
const report = computed(() => {
  const kind = line.value?.kind;
  if (kind !== "decision" && kind !== "stopped" && kind !== "outside") return null;
  return desk.agentReport.value ?? (kind === "decision" ? null : line.value!.summary);
});
</script>

<template>
  <div v-if="line" class="implementation" :class="line.kind">
    <p v-if="line.kind === 'pr'" class="line">
      {{ line.before }}<a :href="line.pr" target="_blank" rel="noopener">{{ line.label }}</a>{{ line.after }}
    </p>
    <p v-else-if="line.answer && sent" class="line">Ответ отправлен — агент продолжает</p>
    <p v-else class="line">
      {{ line.text }}<template v-if="line.kind === 'closed' && line.pr"> · <a :href="line.pr" target="_blank" rel="noopener">{{ line.label }}</a></template>
    </p>

    <ul v-if="line.kind === 'decision' && line.questions.length" class="questions">
      <li v-for="(question, number) in line.questions" :key="number">{{ question }}</li>
    </ul>
    <p v-if="report" class="summary" :class="{ whole: !!desk.agentReport.value }">{{ report }}</p>
    <p v-if="work" class="work">
      <span class="phase">{{ work.phase }}</span><template v-if="work.going"> · {{ work.going }}</template><template v-if="work.activity"> · <span class="activity">{{ work.activity }}</span></template>
    </p>
  </div>
</template>

<style scoped>
.implementation {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 10px;
  border-left: 2px solid var(--st-teal);
  background: rgba(95, 214, 200, 0.07);
  font-size: 12.5px;
}

.implementation.decision,
.implementation.stopped {
  border-left-color: var(--st-wait);
  background: rgba(243, 198, 78, 0.08);
}

.implementation.pr,
.implementation.outside {
  border-left-color: var(--st-green);
}

.implementation.closed {
  border-left-color: #6b6457;
  background: none;
}

.line {
  margin: 0;
  overflow-wrap: anywhere;
}

.decision .line,
.stopped .line {
  color: var(--st-wait);
}

.working .line {
  color: var(--st-teal);
}

.closed .line {
  color: var(--st-dim);
}

a {
  color: #8fd8ff;
}

.questions {
  margin: 0;
  padding-left: 18px;
}

.summary {
  margin: 0;
  color: var(--st-dim);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.summary.whole {
  color: inherit;
}

.work {
  margin: 0;
  color: var(--st-dim);
  overflow-wrap: anywhere;
}

.phase {
  color: var(--st-teal);
  font-weight: 600;
}

.activity {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
}
</style>
