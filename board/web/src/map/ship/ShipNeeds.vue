<script setup lang="ts">
// What «Сейчас» asks of you, on its right: the agent's questions with quick answers and the reply they make, your own
// reply with the state's suggestion, the acceptance with the way back, the return for a fix, or nothing to do while the
// ship works or sleeps. One main button per state. Every order runs through the board server; a board that only reads
// copies the equal command.
import { computed, reactive, ref, watch } from "vue";
import { prLabel } from "../../lib/labels";
import { CONTINUE, MERGE, returnText } from "../../lib/orders";
import type { Cargo, TaskLimits, TaskSummary } from "../../types";
import CopiedNote from "../station/CopiedNote.vue";
import { isSendKey } from "../station";
import type { ShipDesk } from "./desk";
import { NOTE_MAX, answerText, deskOf, replyHint, type Answer, type Need } from "./orders";

const props = defineProps<{ task: TaskSummary; cargo: Cargo | null; desk: ShipDesk; need: Need; limits: TaskLimits | null | undefined; now: number }>();

const view = computed(() => deskOf(props.task, props.desk.queue.value));
const reply = computed(() => props.desk.groups.reply);
const accept = computed(() => props.desk.groups.accept);
const busy = computed(() => !!reply.value.busy || !!accept.value.busy);
const hint = computed(() => replyHint(view.value, props.desk.live.value ? null : props.desk.offReason.value));

// The agent's questions: a quick answer each, and the extra words.
const questions = computed(() => props.cargo?.questions ?? []);
const answers = reactive<(Answer | null)[]>([]);
const extra = ref("");
const composed = computed(() => answerText(questions.value, answers, extra.value));
function choose(index: number, kind: Answer["kind"]) {
  const before = answers[index];
  answers[index] = kind === "own" ? { kind, text: before?.kind === "own" ? before.text : "" } : { kind };
}
function own(index: number, text: string) {
  answers[index] = { kind: "own", text };
}
async function sendAnswers() {
  if (await props.desk.send(composed.value)) {
    answers.splice(0);
    extra.value = "";
  }
}

// The acceptance: a note, and the way back with the findings as its text.
const note = ref("");
const returning = ref(false);
async function accepted() {
  if (await props.desk.verdict("accepted", note.value)) note.value = "";
}
function back() {
  returning.value = true;
  void props.desk.fill(returnText(props.cargo));
}

const quick = computed(() => {
  const items = [{ label: "Продолжай", text: CONTINUE }];
  const cargo = props.cargo;
  if (cargo && (cargo.review?.findings.length || cargo.remaining.length || cargo.questions.length)) items.push({ label: "Доработай находки", text: returnText(cargo) });
  if (props.task.stop === "base conflict" || cargo?.base?.outcome === "conflict") items.push({ label: "Слей main", text: MERGE });
  return items;
});

/** How long the turn may still run, for «Вмешиваться не нужно». */
const calmWhy = computed(() => {
  const max = props.limits?.max_turn_minutes ?? null;
  const start = props.task.phase_started_at;
  if (max === null || start === null || props.task.phase !== "turn") return "Корабль сам дойдёт до следующей станции маршрута.";
  const left = Math.max(0, max - Math.floor((props.now - start) / 60));
  return `Ход сам кончится или упрётся в лимит через ${left} мин.`;
});

function setField(element: unknown) {
  props.desk.field.value = element instanceof HTMLTextAreaElement ? element : null;
}
function onKey(event: KeyboardEvent) {
  if (!view.value.send || !isSendKey(event)) return;
  event.preventDefault();
  void props.desk.send();
}

// Another ship, or the state moved on: clean answers, and the field takes the state's suggestion when it is empty.
watch(
  () => [props.task.slug, questions.value.join("\n")],
  () => {
    answers.splice(0);
    extra.value = "";
    returning.value = false;
    note.value = "";
  },
);
watch(
  () => [props.task.slug, props.need.kind, props.need.text] as const,
  ([, kind, text]) => {
    if ((kind === "reply" || kind === "return") && text && !props.desk.reply.value.trim()) props.desk.reply.value = text;
  },
  { immediate: true },
);
</script>

<template>
  <div class="needs" :class="[`kind-${need.kind}`, `tone-${need.tone}`]" :aria-busy="busy">
    <h4>{{ need.title }}</h4>
    <p v-if="!desk.live.value && need.kind !== 'none' && need.kind !== 'sleep'" class="readonly">
      Доска только читает ({{ desk.offReason.value }}): кнопки копируют команды teamster.
    </p>

    <!-- The agent's questions. -->
    <template v-if="need.kind === 'questions'">
      <ol class="questions">
        <li v-for="(question, index) in questions" :key="index" class="question">
          <p>{{ question }}</p>
          <div class="chips" role="group" :aria-label="`Ответ на вопрос ${index + 1}`">
            <button type="button" class="chip" :aria-pressed="answers[index]?.kind === 'yes'" :disabled="busy" @click="choose(index, 'yes')">Да</button>
            <button type="button" class="chip" :aria-pressed="answers[index]?.kind === 'no'" :disabled="busy" @click="choose(index, 'no')">Нет</button>
            <button type="button" class="chip" :aria-pressed="answers[index]?.kind === 'own'" :disabled="busy" @click="choose(index, 'own')">Своё…</button>
          </div>
          <input
            v-if="answers[index]?.kind === 'own'"
            class="field"
            type="text"
            :value="(answers[index] as { text: string }).text"
            :placeholder="`Свой ответ на вопрос ${index + 1}`"
            :aria-label="`Свой ответ на вопрос ${index + 1}`"
            :disabled="busy"
            @input="own(index, ($event.target as HTMLInputElement).value)"
          />
        </li>
      </ol>
      <label class="label" for="ship-extra">Добавить к ответу <span class="meta">необязательно</span></label>
      <textarea id="ship-extra" v-model="extra" rows="2" placeholder="Например: копию сохрани рядом со скриптом" :disabled="busy"></textarea>
      <div class="label">Уйдёт агенту</div>
      <pre class="preview" :class="{ blank: !composed }">{{ composed || "Выбери ответы или напиши своё указание." }}</pre>
      <div class="row">
        <button type="button" class="key main" :disabled="busy || !composed" @click="sendAnswers">{{ reply.busy ? "Передаю…" : "Ответить агенту" }}</button>
        <span class="dim hint">{{ desk.live.value ? "Агент получит ответ и продолжит ход" : hint }}</span>
      </div>
    </template>

    <!-- Your reply: the state's suggestion, or your own words. -->
    <form v-else-if="need.kind === 'reply' || need.kind === 'return'" class="reply" @submit.prevent="desk.send()">
      <textarea
        id="ship-say"
        :ref="setField"
        v-model="desk.reply.value"
        rows="4"
        :placeholder="need.kind === 'return' ? 'Что исправить' : 'Твой ответ или указание агенту'"
        :aria-label="need.kind === 'return' ? 'Что исправить' : 'Указание кораблю'"
        :disabled="busy"
        @keydown="onKey"
      ></textarea>
      <div v-if="need.kind === 'reply'" class="chips">
        <button v-for="item in quick" :key="item.label" type="button" class="chip" :disabled="busy" @click="desk.fill(item.text)">{{ item.label }}</button>
      </div>
      <div class="row">
        <button type="submit" class="key main" :class="{ bad: need.kind === 'return' }" :disabled="busy || !desk.reply.value.trim()">
          {{ reply.busy ? "Передаю…" : need.kind === "return" ? "Вернуть на исправление" : "Передать" }}
        </button>
        <button v-if="need.kind === 'return'" type="button" class="key" :disabled="busy" @click="accepted">{{ accept.busy ? "Принимаю…" : "Принять как есть" }}</button>
        <span class="dim hint">{{ hint }}</span>
      </div>
    </form>

    <!-- The acceptance. -->
    <template v-else-if="need.kind === 'accept'">
      <a v-if="task.pr" class="key pr" :href="task.pr" target="_blank" rel="noopener">Открыть {{ prLabel(task.pr) }} ↗</a>
      <input v-model="note" class="field" type="text" :maxlength="NOTE_MAX" placeholder="Заметка к вердикту — необязательно" aria-label="Заметка к вердикту" :disabled="busy" />
      <div class="row">
        <button type="button" class="key main ok" :disabled="busy" @click="accepted">{{ accept.busy === "accepted" ? "Принимаю…" : "Принять" }}</button>
        <button v-if="view.send && !returning" type="button" class="key" :disabled="busy" @click="back">Вернуть на доработку</button>
      </div>
      <p class="dim hint">Принять — записать вердикт для статистики; PR этим не сливается.</p>
      <form v-if="returning" class="reply" @submit.prevent="desk.send()">
        <textarea id="ship-say" :ref="setField" v-model="desk.reply.value" rows="4" aria-label="Что доработать" :disabled="busy" @keydown="onKey"></textarea>
        <div class="row">
          <button type="submit" class="key" :disabled="busy || !desk.reply.value.trim()">{{ reply.busy ? "Передаю…" : "Вернуть" }}</button>
          <button type="button" class="key" :disabled="busy" @click="returning = false">Отмена</button>
        </div>
      </form>
    </template>

    <!-- At work: nothing to do, an order can wait in the queue. -->
    <template v-else-if="need.kind === 'calm'">
      <p class="why">{{ calmWhy }}</p>
      <details v-if="view.queue" class="fold">
        <summary>Поставить указание в очередь</summary>
        <form class="reply" @submit.prevent="desk.send()">
          <textarea id="ship-say" :ref="setField" v-model="desk.reply.value" rows="3" placeholder="Например: после этого круга не трогай F3" aria-label="Указание в очередь" :disabled="busy" @keydown="onKey"></textarea>
          <div class="row">
            <button type="submit" class="key" :disabled="busy || !desk.reply.value.trim()">{{ reply.busy ? "Ставлю в очередь…" : "В очередь" }}</button>
          </div>
        </form>
      </details>
      <p class="dim hint">{{ hint }}</p>
    </template>

    <p v-else-if="need.kind === 'sleep'" class="why">Корабль проснётся сам, когда лимит аккаунта сбросится.</p>

    <p v-if="reply.done" class="result ok" role="status" :title="reply.output">{{ reply.done }}</p>
    <p v-if="reply.error" class="result bad" role="alert">{{ reply.error }}</p>
    <CopiedNote v-if="reply.copied" :copied="reply.copied" />
    <template v-if="need.kind === 'accept' || need.kind === 'return'">
      <p v-if="accept.done" class="result ok" role="status" :title="accept.output">{{ accept.done }}</p>
      <p v-if="accept.error" class="result bad" role="alert">{{ accept.error }}</p>
      <CopiedNote v-if="accept.copied" :copied="accept.copied" />
    </template>
  </div>
</template>

<style scoped>
.needs {
  display: grid;
  gap: 9px;
  align-content: start;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--sh-line);
  border-radius: 10px;
  background: var(--sh-well);
}

.needs.tone-warn {
  border-color: rgba(243, 198, 78, 0.6);
  background: rgba(12, 10, 4, 0.8);
}

.needs.tone-bad {
  border-color: rgba(255, 141, 122, 0.55);
  background: rgba(16, 6, 4, 0.75);
}

.needs.tone-ok {
  border-color: rgba(111, 207, 143, 0.55);
  background: rgba(4, 14, 8, 0.75);
}

h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}

.readonly {
  margin: 0;
  padding: 5px 8px;
  border: 1px dashed rgba(214, 170, 96, 0.35);
  border-radius: 6px;
  color: #d4cab5;
  font-size: 12px;
}

.questions {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: question;
}

.question {
  display: grid;
  gap: 6px;
  counter-increment: question;
}

.question p {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  margin: 0;
  overflow-wrap: anywhere;
}

.question p::before {
  content: counter(question) ".";
  color: var(--sh-wait);
  font-weight: 600;
}

.question .chips,
.question .field {
  margin-left: 20px;
  width: calc(100% - 20px);
}

.needs .chip[aria-pressed="true"] {
  border-color: var(--sh-wait);
  background: rgba(243, 198, 78, 0.2);
  color: #fff3cf;
}

.label {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  color: var(--sh-faint);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.label .meta {
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}

.preview {
  margin: 0;
  padding: 7px 9px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  border: 1px dashed rgba(243, 194, 122, 0.35);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.35);
  color: #e9dcc0;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11.5px;
  line-height: 17px;
}

.preview.blank {
  color: var(--sh-faint);
}

.reply {
  display: grid;
  gap: 6px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.hint {
  flex: 1 1 180px;
  margin: 0;
  font-size: 11.5px;
}

.why {
  margin: 0;
  color: var(--sh-dim);
  font-size: 12.5px;
}

.needs .key.main {
  border-color: var(--sh-wait);
  background: rgba(243, 198, 78, 0.22);
  color: #fff3cf;
  font-weight: 600;
}

.needs .key.main.ok {
  border-color: var(--sh-green);
  background: rgba(111, 207, 143, 0.2);
  color: #dcffe7;
}

.needs .key.main.bad {
  border-color: var(--sh-red);
  background: rgba(255, 141, 122, 0.18);
  color: #ffe1da;
}

.pr {
  justify-self: start;
}

.fold > summary {
  color: var(--sh-title);
  font-size: 12.5px;
  cursor: pointer;
}

.fold[open] > summary {
  margin-bottom: 6px;
}
</style>
