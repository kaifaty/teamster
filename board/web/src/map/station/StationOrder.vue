<script setup lang="ts">
// The order deck: a new study for the analyst — an extra batch, named tasks, or a question to the archive. The order
// goes out at once and its channel opens in the comms room; the equivalent command stays one click away.
import { ref } from "vue";
import type { OrderKind } from "../station";
import { useConsole } from "./console";
import CopiedNote from "./CopiedNote.vue";

const desk = useConsole();

const ORDER_KINDS: { kind: OrderKind; label: string }[] = [
  { kind: "batch", label: "Внеочередной разбор" },
  { kind: "tasks", label: "Разобрать задачи" },
  { kind: "question", label: "Исследовать вопрос" },
];
const ORDER_HINT: Record<OrderKind, string> = {
  batch: "Записи после последнего разбора. Фокус разбора — необязательно",
  tasks: "Что искать в этих задачах — необязательно",
  question: "Вопрос к архиву: что выяснить",
};

const showCommand = ref(false);

function setOrder(element: unknown) {
  desk.orderField.value = element instanceof HTMLTextAreaElement ? element : null;
}
</script>

<template>
  <section class="deck order" data-deck="order" aria-labelledby="deck-order">
    <header class="deck-head">
      <span class="sigil" aria-hidden="true">⇡</span>
      <h3 id="deck-order">Приказ</h3>
    </header>

    <form class="deck-body" @submit.prevent="desk.sendOrder">
      <span class="kinds" role="group" aria-label="Вид приказа">
        <button
          v-for="item in ORDER_KINDS"
          :key="item.kind"
          type="button"
          class="chip"
          :class="{ picked: desk.draft.kind === item.kind }"
          :aria-pressed="desk.draft.kind === item.kind"
          @click="desk.draft.kind = item.kind"
        >
          {{ item.label }}
        </button>
      </span>
      <div v-if="desk.draft.kind === 'tasks'" class="row">
        <input v-model="desk.draft.tasks" type="text" placeholder="Задачи: nft-send-fix wallet-ci" aria-label="Задачи через пробел" />
      </div>
      <div v-else-if="desk.draft.kind === 'question'" class="row">
        <input v-model="desk.draft.since" type="text" placeholder="За срок: 30d или 2026-11-01" aria-label="Срок" />
        <input v-model="desk.draft.repos" type="text" placeholder="Проекты — необязательно" aria-label="Проекты через пробел" />
      </div>
      <textarea :ref="setOrder" v-model="desk.draft.text" rows="2" :placeholder="ORDER_HINT[desk.draft.kind]" aria-label="Текст приказа"></textarea>
      <p v-if="desk.orderState.error" class="error" role="alert">{{ desk.orderState.error }}</p>
      <div class="send-row">
        <button type="button" class="link small" :aria-expanded="showCommand" @click="showCommand = !showCommand">Команда</button>
        <button type="submit" class="key gold" :class="{ busy: desk.orderState.busy }" :disabled="desk.orderState.busy">Отдать приказ</button>
      </div>
      <pre v-if="showCommand" class="preview" :class="{ empty: !('command' in desk.ordered.value) }">{{ "command" in desk.ordered.value ? desk.ordered.value.command : desk.ordered.value.error }}</pre>
      <p v-if="desk.orderState.done !== null" class="done" role="status">
        Приказ принят<template v-if="desk.orderState.done">: <span class="mono">{{ desk.orderState.done }}</span></template>
      </p>
      <CopiedNote v-if="desk.orderState.copied" :copied="desk.orderState.copied" />
    </form>
  </section>
</template>

<style scoped>
.deck-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

textarea {
  width: 100%;
  resize: vertical;
}

.kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.row {
  display: flex;
  gap: 6px;
}

.row input {
  flex: 1;
  min-width: 0;
}

.send-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.small {
  font-size: 12px;
}

.preview {
  margin: 0;
  padding: 4px 8px;
  border: 1px dashed rgba(95, 214, 200, 0.22);
  border-radius: 2px;
  background: rgba(3, 8, 10, 0.6);
  color: #9cc2bc;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11.5px;
  line-height: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.preview.empty {
  color: var(--st-faint);
  font-family: inherit;
}

.done {
  margin: 0;
  color: var(--st-teal);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.error {
  margin: 0;
  color: #ff9d8a;
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
