<script setup lang="ts">
// The reply under a channel's conversation: the options picked on the analyst's open questions and the free text
// go to the study at once. While the analyst works, or once the study is closed, there is nothing to send.
import { computed } from "vue";
import type { Study } from "../../types";
import { isSendKey } from "../station";
import { useConsole } from "./console";
import CopiedNote from "./CopiedNote.vue";

const props = defineProps<{ study: Study }>();
const desk = useConsole();

const state = computed(() => desk.replyOf(props.study));
const reach = computed(() => desk.replyReach(props.study));
const NOTE = {
  working: "Аналитик работает — ответить можно после его хода",
  closed: "Разговор закрыт. Продолжить можно новым разбором",
} as const;

function setField(element: unknown) {
  desk.replyField.value = element instanceof HTMLTextAreaElement ? element : null;
}

function onKey(event: KeyboardEvent) {
  if (!isSendKey(event)) return;
  event.preventDefault();
  void desk.sendReply();
}
</script>

<template>
  <form class="reply" @submit.prevent="desk.sendReply">
    <textarea
      :ref="setField"
      v-model="desk.free.value"
      rows="2"
      placeholder="Ответ аналитику"
      aria-label="Ответ аналитику"
      :disabled="reach !== 'ok' || state.busy"
      @keydown="onKey"
    ></textarea>
    <div class="row">
      <p v-if="reach !== 'ok'" class="hint">{{ NOTE[reach] }}</p>
      <p v-else class="hint dim">Варианты уйдут вместе с текстом · ⌘/Ctrl+Enter</p>
      <button type="submit" class="key" :class="{ busy: state.busy }" :disabled="reach !== 'ok' || state.busy || !desk.reply.value">Отправить</button>
    </div>
    <p v-if="state.error" class="fail" role="alert">{{ state.error }}</p>
    <CopiedNote v-if="state.copied" :copied="state.copied" />
  </form>
</template>

<style scoped>
.reply {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid rgba(95, 214, 200, 0.18);
  background: rgba(3, 8, 10, 0.55);
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
}

.hint {
  min-width: 0;
  margin: 0;
  color: var(--st-dim);
  font-size: 12px;
}

.key {
  flex: none;
}

.fail {
  margin: 0;
  color: #ff9d8a;
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
