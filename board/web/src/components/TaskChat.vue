<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { readOnlyReason } from "../lib/actions";
import type { BoardSource } from "../lib/source";
import { isSendKey } from "../map/station";
import { useFollow } from "../map/station/feed";
import type { Accounts, TaskDetail } from "../types";

const props = defineProps<{
  slug: string;
  connect: NonNullable<BoardSource["openTaskChat"]>;
  actions: TaskDetail["actions"];
  opencode?: Accounts["opencode"];
}>();

const permissionLabels: Record<string, string> = {
  allow_once: "разрешить один раз",
  allow_always: "всегда разрешать",
  reject_once: "отклонить один раз",
  reject_always: "всегда отклонять",
};

interface Permission {
  type: "permission";
  id: number;
  toolCall: { title?: string; rawInput?: unknown };
  options: { optionId: string; name: string; kind: string }[];
}

interface Session { type: "ready"; agent: string; executor: string; provider?: string; model?: string }

type ChatEvent =
  | Session
  | { type: "chunk"; text: string }
  | Permission
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };

const expanded = ref(false);
const model = ref("");
const binding = computed(() => props.opencode?.find((item) => item.model === model.value));
const stale = computed(() => !!model.value && !binding.value);
const session = ref<Session | null>(null);
const draft = ref("");
const busy = ref(false);
const error = ref("");
const stopReason = ref("");
const permission = ref<Permission | null>(null);
const messages = ref<{ role: "human" | "agent"; text: string }[]>([]);
const scroller = ref<HTMLElement | null>(null);
const field = ref<HTMLTextAreaElement | null>(null);
const follow = useFollow(scroller, () => messages.value.at(-1)?.text.length, () => messages.value.length);
let socket: WebSocket | null = null;

function disconnect() {
  if (socket) {
    socket.onmessage = socket.onclose = socket.onerror = null;
    socket.close();
    socket = null;
  }
  session.value = null;
  busy.value = false;
  permission.value = null;
}

function fail(message: string) {
  disconnect();
  error.value = message;
}

function close() {
  disconnect();
  expanded.value = false;
  draft.value = "";
  error.value = "";
  stopReason.value = "";
  messages.value = [];
}

function send(message: object) {
  if (socket?.readyState !== WebSocket.OPEN) {
    fail("Соединение прервано. Откройте чат заново.");
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function received(event: ChatEvent) {
  switch (event.type) {
    case "ready":
      if (model.value && (event.model !== model.value || event.provider !== model.value.split("/")[0])) {
        fail("Сервер не подтвердил выбранную модель. Откройте чат заново.");
        return;
      }
      session.value = event;
      void nextTick(() => field.value?.focus());
      break;
    case "chunk": {
      const last = messages.value.at(-1);
      if (last?.role === "agent") last.text += event.text;
      else messages.value.push({ role: "agent", text: event.text });
      break;
    }
    case "permission":
      permission.value = event;
      break;
    case "done":
      busy.value = false;
      permission.value = null;
      stopReason.value = event.stopReason === "end_turn" ? "" : event.stopReason;
      break;
    case "error":
      fail(event.message);
      break;
  }
}

function open() {
  if (!props.actions?.enabled || stale.value) return;
  expanded.value = true;
  try {
    socket = props.connect(props.slug, binding.value);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
    return;
  }
  socket.onmessage = ({ data }) => {
    try {
      received(JSON.parse(data) as ChatEvent);
    } catch {
      fail("Не удалось прочитать ответ сервера. Откройте чат заново.");
    }
  };
  socket.onerror = () => fail("Не удалось подключиться к чату. Проверьте подключение и доступ к записи на доске.");
  socket.onclose = () => fail("Соединение прервано. Откройте чат заново.");
}

function choose(optionId: string | null) {
  if (permission.value && send({ type: "permission", id: permission.value.id, optionId })) permission.value = null;
}

function prompt() {
  const text = draft.value.trim();
  if (!text || !session.value || busy.value || !send({ type: "prompt", text })) return;
  busy.value = true;
  stopReason.value = "";
  messages.value.push({ role: "human", text });
  draft.value = "";
  void nextTick(follow.down);
}

function onKey(event: KeyboardEvent) {
  if (!isSendKey(event)) return;
  event.preventDefault();
  prompt();
}

onBeforeUnmount(disconnect);
watch(() => props.actions?.enabled, (enabled) => {
  if (!enabled) close();
});
</script>

<template>
  <section class="task-chat" aria-label="Чат задачи">
    <label v-if="!expanded && (opencode?.length || model)" class="binding">
      Подписка для чата
      <select v-model="model" class="btn key" :disabled="!actions?.enabled">
        <option value="">Автоматически</option>
        <option v-if="stale" :value="model" disabled>{{ model }} · привязка изменилась</option>
        <option v-for="item in opencode" :key="item.provider" :value="item.model">{{ item.name }} · OpenCode · {{ item.model }}</option>
      </select>
    </label>
    <button type="button" class="btn key" :disabled="!actions?.enabled || (!expanded && stale)" :aria-expanded="expanded" @click="expanded ? close() : open()">
      {{ expanded ? "Закрыть чат" : "Открыть чат" }}
    </button>
    <span v-if="!actions?.enabled">Чат недоступен · {{ readOnlyReason(actions?.reason, !!actions) }}</span>
    <div v-if="expanded" class="conversation">
      <p>Это отдельный чат в рабочем дереве задачи. Закрытие чата завершает сессию.</p>
      <p v-if="session">Чат ведёт <strong>{{ session.agent }}</strong>. Исполнитель задачи — {{ session.executor }}.</p>
      <p v-if="session?.provider">Провайдер {{ session.provider }} · Модель {{ session.model }}</p>
      <ol v-if="messages.length" ref="scroller" class="transcript" role="log" aria-label="Сообщения" tabindex="0" @scroll="follow.onScroll">
        <li v-for="(message, index) in messages" :key="index">
          <strong>{{ message.role === "agent" ? "Агент" : "Вы" }}</strong>
          <p>{{ message.text }}</p>
        </li>
      </ol>
      <div v-if="permission" class="request" role="group" aria-label="Запрос разрешения">
        <strong>Агент запрашивает разрешение</strong>
        <p v-if="permission.toolCall.title">{{ permission.toolCall.title }}</p>
        <pre>{{ JSON.stringify(permission.toolCall.rawInput ?? permission.toolCall, null, 2) }}</pre>
        <div class="choices">
          <button v-for="option in permission.options" :key="option.optionId" type="button" class="btn key" @click="choose(option.optionId)">
            {{ option.name }}<template v-if="permissionLabels[option.kind]"> · {{ permissionLabels[option.kind] }}</template>
          </button>
          <button type="button" class="btn key" @click="choose(null)">Отменить запрос</button>
        </div>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <template v-else>
        <p v-if="!session || (busy && !permission)" role="status">{{ busy ? "Агент отвечает…" : "Подключение…" }}</p>
        <p v-if="stopReason" role="status">Агент завершил ход · {{ stopReason }}</p>
        <form v-if="session" @submit.prevent="prompt">
          <textarea ref="field" v-model="draft" rows="2" maxlength="8000" placeholder="Сообщение агенту" aria-label="Сообщение агенту" @keydown="onKey"></textarea>
          <button type="submit" class="btn key" :disabled="busy || !draft.trim()">Отправить</button>
        </form>
      </template>
    </div>
  </section>
</template>

<style scoped>
.task-chat { margin-bottom: 10px; }
.binding { display: grid; gap: 4px; margin-bottom: 6px; }
.binding select { min-width: 0; max-width: 100%; }
.conversation {
  display: grid;
  gap: 8px;
  padding: 10px;
  margin-top: 6px;
  border: 1px solid var(--sh-line, var(--border));
  border-radius: var(--radius);
  background: var(--sh-panel, var(--surface-3));
}
.conversation p { margin: 0; overflow-wrap: anywhere; }
.transcript {
  display: grid;
  gap: 8px;
  max-height: min(48vh, 400px);
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
}
.transcript p { white-space: pre-wrap; }
.request {
  border-left: 3px solid var(--sh-wait, var(--warn));
  padding: 2px 8px;
}
.request pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow-y: auto; }
.choices { display: flex; flex-wrap: wrap; gap: 6px; }
form { display: grid; justify-items: start; gap: 6px; }
textarea { width: 100%; resize: vertical; font: inherit; }
.error { color: var(--sh-red, var(--bad)); }
</style>
