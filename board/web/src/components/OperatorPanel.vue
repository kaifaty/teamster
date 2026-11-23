<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { formatFullTime } from "../lib/format";
import type { BoardSource } from "../lib/source";
import type { OperatorActivity, OperatorExchange, OperatorTarget, OperatorTask } from "../operatorActivity";

const props = defineProps<{
  activity: OperatorActivity; current: OperatorTask | null; connected: boolean; ask?: BoardSource["askOperator"];
}>();
const open = defineModel<boolean>("open", { required: true });
const target = defineModel<OperatorTarget | null>("target", { required: true });
const emit = defineEmits<{ task: [task: OperatorTask] }>();
const opener = ref<HTMLButtonElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
const log = ref<HTMLElement | null>(null);
const status = computed(() => !props.connected ? "Нет связи с доской"
  : !props.activity.available ? "Журнал недоступен"
  : props.current ? `Разбирает ${props.current.title}` : "Нет активного разбора");

interface Conversation {
  draft: string;
  pending: string;
  error: string;
  exchanges: OperatorExchange[];
}
const conversations = reactive<Record<string, Conversation>>({});
const chatKey = computed(() => {
  const task = target.value;
  return task ? JSON.stringify([task.kind, task.id, task.kind === "run" ? task.created : null]) : "general";
});
watch(chatKey, (key) => {
  conversations[key] ??= { draft: "", pending: "", error: "", exchanges: [] };
}, { immediate: true, flush: "sync" });
const chat = computed(() => conversations[chatKey.value]!);
const busy = ref(false);
const canSend = computed(() => props.connected && !busy.value && !!chat.value.draft.trim());

watch([open, chatKey], ([value]) => {
  if (!value) return;
  void nextTick(() => {
    (input.value ?? closeButton.value)?.focus();
    if (log.value) log.value.scrollTop = log.value.scrollHeight;
  });
});

async function send() {
  if (!props.ask || !canSend.value) return;
  const thread = chat.value;
  const question = thread.draft.trim();
  const history = thread.exchanges.slice(-2).map(exchange => ({
    question: [...exchange.question].slice(0, 800).join(""), answer: [...exchange.answer].slice(0, 800).join(""),
  }));
  busy.value = true;
  thread.error = "";
  thread.draft = "";
  thread.pending = question;
  void nextTick(() => { if (log.value) log.value.scrollTop = log.value.scrollHeight; });
  try {
    const answer = await props.ask(question, target.value, history);
    thread.exchanges.push({ question, answer });
  } catch (error) {
    thread.error = error instanceof Error ? error.message : "Не удалось связаться с оператором.";
    thread.draft = question;
  } finally {
    thread.pending = "";
    busy.value = false;
    if (chat.value === thread && open.value) {
      void nextTick(() => { if (log.value) log.value.scrollTop = log.value.scrollHeight; });
    }
  }
}

function onInputKey(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void send();
}

function close() {
  open.value = false;
  opener.value?.focus();
}
</script>

<template>
  <button ref="opener" type="button" class="btn operator-toggle" :aria-expanded="open"
    aria-controls="operator-panel" :title="status" @click="open = !open">
    Оператор <span class="chip" :class="{ ok: current }">Mini</span>
    <span class="ellipsis muted">{{ status }}</span>
  </button>
  <aside v-show="open" id="operator-panel" class="operator-panel" aria-labelledby="operator-heading"
    @keydown.esc.stop="close">
    <header>
      <h2 id="operator-heading">Оператор <span class="muted">· Mini</span></h2>
      <button ref="closeButton" type="button" class="btn" aria-label="Закрыть панель оператора" @click="close">×</button>
    </header>
    <section v-if="ask" class="chat" aria-label="Чат с оператором">
      <div v-if="target" class="chat-target">
        <strong>{{ target.title }}</strong>
        <button type="button" class="btn" @click="target = null">Общий чат</button>
      </div>
      <div v-if="chat.exchanges.length || chat.pending" ref="log" class="messages" role="log" aria-label="Сообщения">
        <template v-for="(item, index) in chat.exchanges" :key="index">
          <p class="question"><strong>Вы</strong>{{ item.question }}</p>
          <p class="answer"><strong>Mini</strong>{{ item.answer }}</p>
        </template>
        <p v-if="chat.pending" class="question"><strong>Вы</strong>{{ chat.pending }}</p>
      </div>
      <form @submit.prevent="send">
        <textarea ref="input" v-model="chat.draft" rows="2" maxlength="2000" :readonly="!!chat.pending"
          :placeholder="target ? 'Вопрос по задаче' : 'Вопрос оператору'" aria-label="Вопрос оператору" @keydown="onInputKey" />
        <button type="submit" class="btn primary" :disabled="!canSend">Отправить</button>
      </form>
      <p v-if="chat.pending" class="muted" role="status">Жду ответа Mini…</p>
      <p v-if="chat.error" class="bad" role="alert">{{ chat.error }}</p>
    </section>
    <p v-if="current" class="current">
      Mini разбирает <button type="button" class="task-link" @click="emit('task', current)">{{ current.title }}</button>
    </p>
    <p v-else class="muted">{{ status }}</p>
    <h3>История рекомендаций</h3>
    <ol v-if="activity.history.length" class="history">
      <li v-for="item in activity.history" :key="item.event_id">
        <button type="button" class="task-link" @click="emit('task', item)">{{ item.title }} <span aria-hidden="true">↗</span></button>
        <div class="muted metadata">
          {{ item.source === "mini" ? "Mini" : "Нужен человек" }} · Ход {{ item.turn }} ·
          <time :datetime="new Date(item.started_at * 1000).toISOString()" title="Начало разбора">{{ formatFullTime(item.started_at) }}</time>
        </div>
        <p>{{ item.recommendation }}</p>
      </li>
    </ol>
    <p v-else-if="activity.available" class="muted">Рекомендаций пока нет</p>
  </aside>
</template>

<style scoped>
.operator-toggle { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: min(100%, 340px); }
.operator-toggle .ellipsis { width: min(20vw, 170px); text-align: left; }
@media (max-width: 600px) { .operator-toggle .ellipsis { display: none; } }
.operator-panel {
  position: absolute; z-index: 30; top: calc(100% + 6px); right: 10px; width: min(420px, calc(100% - 20px));
  max-height: 70dvh; overflow: auto; padding: 14px 16px; border: 1px solid var(--border-strong);
  border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: 0 6px 24px #0004;
}
header { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: 16px; }
h3 { margin: 18px 0 4px; font-size: 13px; }
p { margin: 6px 0; overflow-wrap: anywhere; }
.chat { margin: 12px 0; }
.chat-target { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
.chat-target strong { font-size: 13px; overflow-wrap: anywhere; }
.chat-target button { flex: none; }
.messages { max-height: 32dvh; overflow: auto; margin-bottom: 8px; }
.messages p { width: fit-content; max-width: 100%; padding: 6px 9px; border-radius: 6px; white-space: pre-wrap; }
.messages strong { display: block; font-size: 11px; }
.question { margin-left: auto; background: var(--ok-soft); }
.answer { background: var(--surface-2); }
form { display: flex; align-items: flex-end; gap: 6px; }
textarea {
  flex: 1; min-width: 0; width: 100%; resize: vertical; font: inherit; color: inherit; padding: 6px 8px;
  border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface-2);
}
.current { padding: 7px 9px; border-radius: 4px; background: var(--ok-soft); }
.history { list-style: none; margin: 0; padding: 0; }
li { padding: 9px 0 4px; border-top: 1px solid var(--border); }
li p { white-space: pre-wrap; }
.metadata { font-size: 11px; }
.task-link {
  padding: 0; border: 0; background: none; color: inherit; font: inherit; font-weight: 600; text-align: left;
  text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; cursor: pointer;
}
</style>
