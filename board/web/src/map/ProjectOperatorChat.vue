<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { formatClock } from "../lib/format";
import type { BoardSource } from "../lib/source";
import type { OperatorTarget, ProjectOperatorMessage } from "../operatorActivity";

const props = defineProps<{
  target: OperatorTarget;
  now: number;
  enabled?: boolean;
  ask?: BoardSource["askOperator"];
  messages: readonly ProjectOperatorMessage[];
  labels: ReadonlyMap<string, string>;
  refresh: () => Promise<void>;
}>();

const input = ref<HTMLTextAreaElement | null>(null);
const log = ref<HTMLElement | null>(null);
const draft = ref("");
const reference = ref<{ id: string; label: string } | null>(null);
const busy = ref(false);
const error = ref("");
const pending = computed(() => props.messages.some((row) => row.status === "pending"));
const canSend = computed(() => props.enabled && props.ask && !busy.value && !pending.value && !!draft.value.trim());
const caption = (id: string) => props.labels.get(id) ?? "Событие журнала";

function focus() {
  void nextTick(() => input.value?.focus());
}
function discuss(id: string, label: string) {
  if (busy.value) return;
  reference.value = { id, label };
  focus();
}
function prepare(question: string) {
  if (!busy.value && !draft.value.trim()) {
    draft.value = question;
    reference.value = null;
  }
  focus();
}
defineExpose({ discuss, focus, prepare });

watch(() => {
  const last = props.messages.at(-1);
  return last ? last.id + ":" + last.status : "";
}, () => {
  void nextTick(() => {
    if (log.value) log.value.scrollTop = log.value.scrollHeight;
  });
}, { flush: "post" });

async function send() {
  if (!canSend.value || !props.ask) return;
  const question = draft.value.trim();
  const event = reference.value;
  const history = props.messages.filter((row) => row.answer).slice(-2).map((row) => ({
    question: [...row.question].slice(0, 800).join(""),
    answer: [...(row.answer ?? "")].slice(0, 800).join(""),
  }));
  error.value = "";
  busy.value = true;
  try {
    await props.ask(question, props.target, history, event?.id);
    draft.value = "";
    reference.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Не удалось связаться с оператором.";
  } finally {
    await props.refresh();
    busy.value = false;
  }
}
function onKey(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void send();
}
</script>

<template>
  <section class="task-chat" aria-labelledby="task-operator-chat-title">
    <header>
      <span class="chat-avatar" aria-hidden="true">M</span>
      <div>
        <h2 id="task-operator-chat-title">Чат с оператором</h2>
        <p>Mini · {{ target.title }}</p>
      </div>
    </header>
    <ol v-if="messages.length" ref="log" class="chat-log" role="log" aria-label="Переписка по задаче">
      <li v-for="row in messages" :key="row.id">
        <div class="question">
          <div class="chat-by"><strong>Вы</strong><time :datetime="new Date(row.at * 1000).toISOString()">{{ formatClock(row.at, now) }}</time></div>
          <small v-if="row.reference">{{ caption(row.reference) }}</small>
          <p>{{ row.question }}</p>
        </div>
        <div v-if="row.answer" class="answer">
          <strong>Mini</strong>
          <p>{{ row.answer }}</p>
        </div>
        <p v-else-if="row.status === 'failed'" class="chat-feedback">Ответ не получен.</p>
      </li>
    </ol>
    <form v-if="enabled && ask" class="composer" @submit.prevent="send">
      <div v-if="reference" class="context">
        <span>{{ reference.label }}</span>
        <button type="button" class="btn" aria-label="Убрать ссылку на событие" :disabled="busy" @click="reference = null; focus()">×</button>
      </div>
      <label>Вопрос оператору
        <textarea ref="input" v-model="draft" rows="2" maxlength="2000" :readonly="busy" @keydown="onKey" />
      </label>
      <div class="composer-footer">
        <p v-if="busy || pending" role="status" class="chat-feedback">Жду ответа Mini…</p>
        <button type="submit" class="btn chat-send" :disabled="!canSend">Отправить</button>
      </div>
      <p v-if="error" role="alert" class="bad">{{ error }}</p>
    </form>
    <p v-else class="chat-feedback unavailable">Сейчас оператор не принимает сообщения.</p>
  </section>
</template>

<style scoped>
.task-chat { border: 1px solid var(--border); border-radius: 10px; background: var(--surface); overflow-wrap: anywhere; }
header { display: flex; align-items: center; gap: 9px; padding: 12px; border-bottom: 1px solid var(--border); }
.chat-avatar { display: grid; flex: none; place-items: center; width: 31px; height: 31px; border-radius: 7px;
  background: var(--journal-operator); color: var(--journal-accent); font-weight: 650; }
h2 { margin: 0; font-size: 15px; }
p { margin: 0; }
header p, .chat-feedback, time, small { color: var(--muted); font-size: 12px; }
.chat-log { list-style: none; margin: 0; padding: 10px 12px; max-height: 44dvh; overflow: auto; }
.chat-log li + li { margin-top: 8px; }
.question, .answer { padding: 7px 9px; border-radius: 7px; background: var(--surface-2); white-space: pre-wrap; font-size: 13px; }
.question { margin-left: 12px; }
.answer { margin-top: 6px; background: var(--journal-operator); }
.chat-log strong { font-size: 12px; }
.chat-by, .composer-footer, .context { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 8px; }
.composer { display: grid; gap: 6px; padding: 10px 12px 12px; border-top: 1px solid var(--border); }
label { display: grid; gap: 4px; font-size: 12px; font-weight: 600; }
textarea { width: 100%; resize: vertical; padding: 6px 8px; border: 1px solid var(--border-strong); border-radius: 6px;
  background: var(--surface-2); color: var(--text); font: inherit; font-weight: 400; }
.context { padding: 3px 6px; border-radius: 5px; background: var(--journal-operator); color: var(--journal-accent); font-size: 12px; }
.chat-send { margin-left: auto; }
.chat-send:not(:disabled) { background: var(--journal-accent); color: light-dark(#fff, #193329); border-color: var(--journal-accent); }
.unavailable { padding: 10px 12px; }
</style>
