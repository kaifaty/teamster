<script setup lang="ts">
// How a lesson's implementation goes, on its card: the agent works, needs a decision, opened a PR, changed the files
// outside the repository without one, stopped, or the task is closed. An agent that waits takes a reply from the card,
// like the analyst in the comms room. «Посмотреть» leaves the station for the agent's ship: its system on the map,
// with the ship's card open.
import { computed } from "vue";
import type { Lesson } from "../../types";
import { implementationLine, isSendKey, outsideOf } from "../station";
import { useConsole } from "./console";
import CopiedNote from "./CopiedNote.vue";

const props = defineProps<{ lesson: Lesson }>();
const desk = useConsole();

const line = computed(() => implementationLine(props.lesson.implementation, desk.cardOf(props.lesson).started, outsideOf(props.lesson)));
const agent = computed(() => desk.agentOf(props.lesson));
const sent = computed(() => desk.agentSent(props.lesson));
const off = computed(() => agent.value.busy || sent.value);
const ship = computed(() => desk.shipOf(props.lesson));

const text = computed({
  get: () => agent.value.text,
  set: (value: string) => desk.setAgentText(props.lesson, value),
});

function onKey(event: KeyboardEvent) {
  if (!isSendKey(event)) return;
  event.preventDefault();
  void desk.sayToAgent(props.lesson);
}
</script>

<template>
  <div v-if="line" class="implementation" :class="line.kind" role="status">
    <div class="head">
      <p v-if="line.kind === 'pr'" class="line">
        {{ line.before }}<a :href="line.pr" target="_blank" rel="noopener">{{ line.label }}</a>{{ line.after }}
      </p>
      <p v-else-if="line.answer && sent" class="line">Ответ отправлен — агент продолжает</p>
      <p v-else class="line">
        {{ line.text }}<template v-if="line.kind === 'closed' && line.pr"> · <a :href="line.pr" target="_blank" rel="noopener">{{ line.label }}</a></template>
      </p>
      <button v-if="ship" type="button" class="chip small watch" :title="`Открыть систему ${ship.repo} на карте с кораблём агента`" @click="desk.watchAgent(lesson)">
        Посмотреть
      </button>
    </div>

    <ul v-if="line.kind === 'decision' && line.questions.length" class="questions">
      <li v-for="(question, number) in line.questions" :key="number">{{ question }}</li>
    </ul>
    <p v-if="(line.kind === 'stopped' || line.kind === 'outside') && line.summary" class="summary">{{ line.summary }}</p>

    <form v-if="line.answer" class="answer" @submit.prevent="desk.sayToAgent(lesson)">
      <textarea
        v-model="text"
        class="agent-answer"
        rows="2"
        placeholder="Ответ агенту"
        aria-label="Ответ агенту"
        :disabled="off"
        @keydown="onKey"
      ></textarea>
      <span class="row">
        <span class="dim">⌘/Ctrl+Enter</span>
        <button type="submit" class="key" :class="{ busy: agent.busy }" :disabled="off || !text.trim()">Ответить</button>
      </span>
    </form>
    <p v-if="agent.error" class="fail" role="alert">{{ agent.error }}</p>
    <CopiedNote v-if="agent.copied" :copied="agent.copied" />
  </div>
</template>

<style scoped>
.implementation {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  padding: 5px 8px;
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

.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.line {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.watch {
  flex: none;
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

.answer {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.answer textarea {
  width: 100%;
  resize: vertical;
}

.answer textarea:disabled {
  opacity: 0.55;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.fail {
  margin: 0;
  color: #ff9d8a;
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
