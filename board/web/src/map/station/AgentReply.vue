<script setup lang="ts">
// The reply to a lesson's agent, under the lesson's thread while the agent waits: it shows in the thread at once and
// goes to the task with `say`.
import { computed } from "vue";
import type { Lesson } from "../../types";
import { isSendKey } from "../station";
import { useConsole } from "./console";
import CopiedNote from "./CopiedNote.vue";

const props = defineProps<{ lesson: Lesson }>();
const desk = useConsole();

const agent = computed(() => desk.agentOf(props.lesson));
const off = computed(() => agent.value.busy || desk.agentSent(props.lesson));
const text = computed({
  get: () => agent.value.text,
  set: (value: string) => desk.setAgentText(props.lesson, value),
});

function setField(element: unknown) {
  desk.agentField.value = element instanceof HTMLTextAreaElement ? element : null;
}

function onKey(event: KeyboardEvent) {
  if (!isSendKey(event)) return;
  event.preventDefault();
  void desk.sayToAgent(props.lesson);
}
</script>

<template>
  <form class="answer" @submit.prevent="desk.sayToAgent(lesson)">
    <textarea
      :ref="setField"
      v-model="text"
      class="agent-answer"
      rows="2"
      placeholder="Ответ агенту"
      aria-label="Ответ агенту"
      :disabled="off"
      @keydown="onKey"
    ></textarea>
    <span class="row">
      <span class="dim">{{ desk.agentSent(lesson) ? "Ответ отправлен — агент продолжает" : "⌘/Ctrl+Enter" }}</span>
      <button type="submit" class="key" :disabled="off || !text.trim()">Ответить</button>
    </span>
    <p v-if="agent.error" class="fail" role="alert">{{ agent.error }}</p>
    <CopiedNote v-if="agent.copied" :copied="agent.copied" />
  </form>
</template>

<style scoped>
.answer {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

textarea {
  width: 100%;
  resize: vertical;
}

textarea:disabled {
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
