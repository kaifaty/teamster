<script setup lang="ts">
// The transmitter: everything picked on the station's decks goes out as one command per round — the decisions on
// lessons with the reply to the open channel, or with a new order. The board copies it, the terminal runs it.
import { DECISION_TEXT, studyTitle, type OrderKind } from "../station";
import { useConsole } from "./console";

const desk = useConsole();

const REACH_NOTE: Record<"working" | "closed", string> = {
  working: "Аналитик работает: ответ можно передать после его хода. Решения по урокам уйдут сейчас.",
  closed: "Исследование закрыто. Продолжить можно новым приказом.",
};

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

/** The transmission as the terminal will run it, one command per line. */
const lines = (command: string) => command.split(" && ").join(" &&\n");

function setReply(element: unknown) {
  desk.replyField.value = element instanceof HTMLTextAreaElement ? element : null;
}
function setOrder(element: unknown) {
  desk.orderField.value = element instanceof HTMLTextAreaElement ? element : null;
}
function setLast(element: unknown) {
  desk.lastField.value = element instanceof HTMLTextAreaElement ? element : null;
}
</script>

<template>
  <section class="deck radio" data-deck="radio" aria-labelledby="deck-radio">
    <header class="deck-head">
      <span class="sigil" aria-hidden="true">⇡</span>
      <h3 id="deck-radio">Передатчик</h3>
      <span class="switch" role="group" aria-label="Что передать">
        <button type="button" :class="{ on: desk.composer.value === 'reply' }" :aria-pressed="desk.composer.value === 'reply'" @click="desk.composer.value = 'reply'">Ответ</button>
        <button type="button" :class="{ on: desk.composer.value === 'order' }" :aria-pressed="desk.composer.value === 'order'" @click="desk.composer.value = 'order'">Приказ</button>
      </span>
    </header>

    <div class="deck-body">
      <ul v-if="desk.decisions.value.length" class="staged" aria-label="Решения по урокам">
        <li v-for="decision in desk.decisions.value" :key="decision.entry" :class="decision.status" :title="decision.entry">
          {{ desk.chipName(decision) }} · {{ DECISION_TEXT[decision.status] }}<template v-if="decision.note.trim()">: {{ decision.note.trim() }}</template>
          <button type="button" class="x" :aria-label="`Убрать решение по ${decision.entry}`" @click="desk.drop(decision)">×</button>
        </li>
      </ul>

      <template v-if="desk.composer.value === 'reply'">
        <p class="to">
          <template v-if="desk.target.value">Кому: «{{ studyTitle(desk.target.value) }}»</template>
          <template v-else>Открой канал в рубке связи, чтобы ответить аналитику.</template>
        </p>
        <p v-if="desk.target.value && desk.targetReach.value !== 'ok'" class="note-line">{{ REACH_NOTE[desk.targetReach.value] }}</p>
        <textarea
          v-else-if="desk.target.value"
          :ref="setReply"
          v-model="desk.free.value"
          rows="2"
          placeholder="Ответ или уточнение аналитику. Выбранные варианты уйдут вместе с ним"
          aria-label="Ответ аналитику"
        ></textarea>
        <div class="send-row">
          <pre class="preview" :class="{ empty: !desk.replyCommand.value }">{{ desk.replyCommand.value ? lines(desk.replyCommand.value) : "Выбери ответы или решения — команда соберётся здесь" }}</pre>
          <button type="button" class="key" :disabled="!desk.replyCommand.value" @click="desk.sendReply">Передать</button>
        </div>
      </template>

      <template v-else>
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
        <p v-if="desk.orderError.value" class="error" role="alert">{{ desk.orderError.value }}</p>
        <div class="send-row">
          <pre class="preview" :class="{ empty: !('command' in desk.ordered.value) }">{{ "command" in desk.ordered.value ? lines(desk.orderLine.value) : desk.ordered.value.error }}</pre>
          <button type="button" class="key gold" @click="desk.sendOrder">Передать приказ</button>
        </div>
      </template>

      <p v-if="desk.last.value && desk.last.value.copied" class="done" role="status">Шифровка скопирована — вставь в терминал. Ответ придёт следующим ходом аналитика.</p>
      <template v-else-if="desk.last.value">
        <p class="error" role="alert">Буфер обмена недоступен — скопируй команду вручную:</p>
        <textarea :ref="setLast" class="mono manual" rows="2" readonly :value="desk.last.value.command" aria-label="Команда для терминала"></textarea>
      </template>
    </div>
  </section>
</template>

<style scoped>
.deck-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.switch {
  display: inline-flex;
  margin-left: auto;
  border: 1px solid rgba(214, 170, 96, 0.35);
  border-radius: 2px;
}

.switch button {
  padding: 1px 12px;
  border: 0;
  background: none;
  color: #b8ad98;
  font: inherit;
  cursor: pointer;
}

.switch button.on {
  background: rgba(95, 214, 200, 0.18);
  color: var(--st-teal-text);
}

.staged {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.staged li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 0 4px 0 8px;
  border-radius: 999px;
  background: rgba(95, 214, 200, 0.16);
  color: var(--st-teal-text);
  font-size: 12px;
}

.staged li.declined {
  background: rgba(155, 144, 124, 0.2);
  color: #d4cab5;
}

.staged li.applied {
  background: rgba(111, 207, 143, 0.18);
  color: #c9f2d6;
}

.x {
  padding: 0 4px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.to,
.note-line {
  margin: 0;
  overflow: hidden;
  color: var(--st-dim);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-line {
  white-space: normal;
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
}

.send-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.preview {
  flex: 1;
  min-width: 0;
  max-height: 72px;
  margin: 0;
  padding: 4px 8px;
  overflow-y: auto;
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

.key {
  flex: none;
}

.done {
  margin: 0;
  color: var(--st-teal);
  font-size: 12px;
}

.error {
  margin: 0;
  color: #ff9d8a;
  font-size: 12px;
}

.manual {
  width: 100%;
}
</style>
