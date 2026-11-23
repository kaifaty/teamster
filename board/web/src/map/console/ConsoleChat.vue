<script setup lang="ts">
// The conversation with the duty, open above the command row over the events (or in the narrow window's sheet): the
// user's messages, the duty's replies with their question's options and the tasks they started, the quieter notes about
// finished tasks, the messages that wait for the running turn and those still on their way. The newest stands at the
// bottom, and the list stays there unless the user scrolled up. While the duty works: how long, and its last steps.
import { defineAsyncComponent, onMounted, ref, watch } from "vue";
import type { DutyPlanReply } from "../../lib/actions";
import { atBottom } from "../station/feed";
import type { ChatRow } from "./chat";
import { runTime } from "./chat";
import { shortClock } from "./texts";

const props = defineProps<{
  rows: readonly ChatRow[];
  now: number;
  /** The duty account's name, or null when none is chosen. */
  account: string | null;
  portrait: string | null;
  busy: boolean;
  /** How long the running turn runs, in seconds; null while none runs or its start is unknown. */
  runSeconds: number | null;
  activity: readonly { key: string; label: string; text: string }[];
  lastError: string | null;
  readError: string | null;
  /** The narrow window's sheet: no close button, the sheet folds it. */
  sheet?: boolean;
}>();
const emit = defineEmits<{
  close: []; choose: [text: string]; task: [slug: string]; retry: [key: number]; dismiss: [key: number];
  sendPlan: [reply: DutyPlanReply]; refresh: [];
}>();
const DutyDecision = defineAsyncComponent(() => import("./DutyDecision.vue"));

// The list stays at its bottom while the user leaves it there, and goes there with the user's own message; scrolled up,
// it stays put and offers the news. The jumps are instant, so that the list knows at once where it stands.
const scroller = ref<HTMLElement | null>(null);
const renderedComparison = ref<string | null>(null);
const fresh = ref(false);
let stuck = true;
function down() {
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
  stuck = true;
  fresh.value = false;
}
function onScroll() {
  if (!scroller.value) return;
  stuck = atBottom(scroller.value, 8);
  if (stuck) fresh.value = false;
}
function decisionReady(row: Extract<ChatRow, { kind: "duty" }>) {
  if (row.comparison) renderedComparison.value = row.key;
  if (stuck) down();
}
onMounted(down);
const pendingCount = () => props.rows.filter((row) => row.kind === "pending").length;
watch(pendingCount, (count, before) => count > before && down(), { flush: "post" });
watch(
  () => [props.rows.length, props.rows.at(-1)?.key, props.busy, props.activity.map((line) => line.text).join("\n"), props.lastError],
  ([count], [was]) => {
    if (stuck) down();
    else if (count !== was) fresh.value = true;
  },
  { flush: "post" },
);

const PENDING_WORD = { sending: "отправляю…", sent: "отправлено, жду ответа сервера", failed: "не отправлено" } as const;
</script>

<template>
  <section id="duty-chat" class="chat" :class="{ sheet }" aria-label="Переписка с дежурным">
    <header class="chat-head">
      <img v-if="portrait" class="face" :src="portrait" alt="" />
      <h2 class="chat-title">Дежурный<template v-if="account"> · {{ account }}</template></h2>
      <button v-if="!sheet" type="button" class="chat-close" aria-label="Свернуть переписку" title="Свернуть переписку (Esc)" @click="emit('close')">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    </header>
    <p v-if="readError" class="chat-alert" role="alert">Не удалось прочитать переписку: {{ readError }}. Показано то, что было прочитано раньше.</p>
    <ol ref="scroller" class="chat-log" role="log" aria-label="Сообщения" tabindex="0" @scroll="onScroll">
      <li v-if="!rows.length" class="chat-empty">Переписки пока нет. Напиши дежурному задачу в поле ниже: он ответит здесь и сам запустит задачи.</li>
      <li v-for="row in rows" :key="row.key" class="msg" :class="row.kind">
        <template v-if="row.kind === 'user'">
          <p class="bubble">{{ row.text }}</p>
          <time class="when">{{ shortClock(row.at, now) }}</time>
        </template>
        <template v-else-if="row.kind === 'duty'">
          <p class="bubble"><span class="visually-hidden">Дежурный: </span>{{ row.text }}</p>
          <p v-if="row.question" class="question">{{ row.question }}</p>
          <div v-if="row.options.length && (!row.comparison || renderedComparison !== row.key)" class="chips" role="group" :aria-label="row.question ? `Варианты ответа: ${row.question}` : 'Варианты ответа'">
            <button
              v-for="option in row.options"
              :key="option"
              type="button"
              class="chip"
              :disabled="!row.active"
              :title="row.active ? `Ответить «${option}»` : 'На этот вопрос уже ответили'"
              @click="emit('choose', option)"
            >
              {{ option }}
            </button>
          </div>
          <DutyDecision
            v-if="(row.taskPlan?.actionable && row.taskPlan.accepted_turn === undefined &&
              row.planSend?.state !== 'accepted' && row.planSend?.state !== 'closed') || (row.comparison && row.active)"
            :key="row.taskPlan?.id ?? row.key"
            :plan="row.taskPlan"
            :comparison="row.comparison"
            :disabled="!row.active || busy || !!readError || row.planSend?.state === 'sending' || row.planSend?.state === 'unknown'"
            @send="emit('sendPlan', $event)"
            @choose="emit('choose', $event)"
            @ready="decisionReady(row)"
          />
          <p v-if="row.taskPlan?.error" class="plan-status bad" role="alert">Дежурный не выполнил ответ: {{ row.taskPlan.error }}</p>
          <p v-else-if="row.taskPlan?.accepted_turn !== undefined || row.planSend?.state === 'accepted'" class="plan-status" role="status">Ответ принят</p>
          <p v-else-if="row.planSend?.state === 'sending'" class="plan-status" role="status">Отправляю…</p>
          <div v-else-if="row.planSend?.state === 'unknown'" class="plan-status" role="status">
            Не удалось подтвердить отправку.
            <button type="button" class="link" @click="emit('refresh')">Проверить отправку</button>
          </div>
          <p v-else-if="row.planSend?.error" class="plan-status bad" role="alert">{{ row.planSend.error }}</p>
          <p v-if="row.started.length" class="started">
            <span class="c-muted">Запущено:</span>
            <template v-for="task in row.started" :key="task.slug">
              <a v-if="task.repo" href="#" class="task-link" :title="`Открыть запуск ${task.slug}`" @click.prevent="emit('task', task.slug)">{{ task.slug }}</a>
              <span v-else class="task-gone" title="Запуск сейчас недоступен на доске">{{ task.slug }}</span>
            </template>
          </p>
          <time class="when">{{ shortClock(row.at, now) }}</time>
        </template>
        <template v-else-if="row.kind === 'note'">
          <details v-if="row.body" class="note-body">
            <summary>{{ row.head }}</summary>
            <pre>{{ row.body }}</pre>
          </details>
          <p v-else class="note-head">{{ row.head }}</p>
          <time class="when">{{ shortClock(row.at, now) }}</time>
        </template>
        <template v-else-if="row.kind === 'queued'">
          <p class="bubble">{{ row.text }}</p>
          <span class="when">{{ row.from === "note" ? "заметка о задаче ждёт следующего хода" : "ждёт: дежурный закончит ход и прочтёт" }}</span>
        </template>
        <template v-else>
          <p class="bubble">{{ row.pending.text }}</p>
          <span class="when" :class="{ bad: row.pending.state === 'failed' }" :role="row.pending.state === 'failed' ? 'alert' : undefined">
            {{ PENDING_WORD[row.pending.state] }}<template v-if="row.pending.error">: {{ row.pending.error }}</template>
          </span>
          <span v-if="row.pending.state === 'failed'" class="again">
            <button type="button" class="link" @click="emit('retry', row.pending.key)">Повторить</button>
            <button type="button" class="link" @click="emit('dismiss', row.pending.key)">Убрать</button>
          </span>
        </template>
      </li>
      <li v-if="busy" class="msg working" role="status">
        <p class="work-head">Дежурный работает<template v-if="runSeconds !== null"> · {{ runTime(runSeconds) }}</template></p>
        <ul v-if="activity.length" class="work-lines">
          <li v-for="line in activity" :key="line.key"><span class="c-muted">{{ line.label }}:</span> {{ line.text }}</li>
        </ul>
      </li>
      <li v-if="lastError" class="msg failure" role="alert">{{ lastError }}</li>
    </ol>
    <button v-if="fresh" type="button" class="fresh" @click="down">Новые сообщения ↓</button>
  </section>
</template>

<style scoped src="./console.css"></style>
<style scoped>
/*
 * Over the events, between the wings: from just past the wings' bodies (87 art pixels into the centre's ends) and from
 * the command row's top upward, taller than the events but under the toolbar, so that the galaxy above stays in view.
 */
.chat {
  position: absolute;
  left: calc(var(--u, 0.5px) * 87);
  right: calc(var(--u, 0.5px) * 87);
  bottom: calc(var(--row-height, 72px) + var(--chat-grow, 0px));
  z-index: 2;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: max(var(--events-height, 160px), min(46vh, calc(var(--stage-height, 100vh) - var(--below-toolbar, 46px) - var(--row-height, 72px) - var(--chat-grow, 0px) - 12px)));
  padding: 0 0 6px;
  border: 1px solid rgba(240, 165, 70, 0.75);
  border-radius: 10px 10px 4px 4px;
  background: linear-gradient(to bottom, rgba(20, 13, 6, 0.98), rgba(6, 8, 12, 0.97) 44px);
  box-shadow:
    inset 0 1px 0 rgba(255, 220, 160, 0.35),
    inset 0 0 0 2px rgba(60, 36, 12, 0.9),
    inset 0 0 0 3px rgba(214, 150, 70, 0.35),
    0 6px 22px rgba(0, 0, 0, 0.75);
  color: #e8e2d4;
  font-size: 13px;
  line-height: 18px;
}

.chat.sheet {
  position: relative;
  left: auto;
  right: auto;
  bottom: auto;
  height: auto;
  border-radius: 6px;
}

.chat-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 10px;
  border-bottom: 1px solid rgba(214, 150, 70, 0.4);
}

.face {
  width: 28px;
  height: 28px;
  border: 1px solid rgba(240, 165, 70, 0.7);
  border-radius: 50%;
  object-fit: cover;
}

.chat-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: #f3c27a;
  font-size: 14px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 26px;
  padding: 0;
  border: 1px solid rgba(214, 150, 70, 0.55);
  border-radius: 5px;
  background: rgba(30, 20, 8, 0.9);
  color: #f3c27a;
  cursor: pointer;
}

.chat-close:hover {
  border-color: #f3c64e;
}

.chat-close:focus-visible,
.chat-log:focus-visible,
.chip:focus-visible,
.link:focus-visible,
.task-link:focus-visible,
.fresh:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.chat-alert {
  flex: none;
  margin: 6px 10px 0;
  color: #ff8d7a;
  font-size: 12px;
}

.chat-log {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 8px 10px 2px;
  overflow-y: auto;
  list-style: none;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

.chat.sheet .chat-log {
  max-height: 42vh;
}

.chat-empty {
  padding: 12px 4px;
  color: #a89c86;
}

.plan-status {
  margin: 5px 0 0;
  color: #c5aa8b;
}

.plan-status.bad {
  color: #ffad9a;
}

.msg {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin: 0 0 8px;
}

.bubble {
  max-width: 82%;
  margin: 0;
  padding: 5px 10px;
  border: 1px solid rgba(214, 150, 70, 0.4);
  border-radius: 8px;
  background: rgba(34, 27, 18, 0.95);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

/* The user's own messages stand on the right, in a bluer glass, like the sketch's. */
.msg.user,
.msg.queued,
.msg.pending {
  align-items: flex-end;
}

.msg.user .bubble,
.msg.queued .bubble,
.msg.pending .bubble {
  border-color: rgba(120, 150, 210, 0.6);
  background: rgba(24, 32, 52, 0.95);
}

/* Not delivered yet: dashed, dimmer. */
.msg.queued .bubble,
.msg.pending .bubble {
  border-style: dashed;
  opacity: 0.8;
}

.when {
  margin-top: 2px;
  color: #8f846f;
  font-size: 11px;
  line-height: 14px;
}

.when.bad {
  color: #ff8d7a;
}

.question {
  max-width: 82%;
  margin: 4px 0 0;
  color: #f6dfb0;
  font-weight: 650;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 5px;
}

/* An option: a small bronze chip; answered questions keep theirs, dimmed. */
.chip {
  min-height: 28px;
  padding: 2px 12px;
  border: 1px solid rgba(240, 165, 70, 0.85);
  border-radius: 7px;
  background: linear-gradient(to bottom, #4a2f0f, #2c1a07);
  box-shadow: inset 0 1px 0 rgba(255, 220, 160, 0.35);
  color: #f6dfb0;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.chip:hover:not(:disabled) {
  filter: brightness(1.2);
}

.chip:disabled {
  border-color: rgba(214, 150, 70, 0.3);
  background: rgba(30, 24, 16, 0.8);
  box-shadow: none;
  color: #8f846f;
  cursor: default;
}

.started {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 5px 0 0;
  font-size: 12px;
}

.task-link {
  color: #f3c64e;
  font-weight: 650;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.task-link:hover {
  color: #ffe08a;
}

.task-gone {
  color: #a89c86;
}

/* A note about a finished task: quieter, no bubble, its details folded. */
.msg.note {
  align-items: stretch;
  padding: 0 4px 0 8px;
  border-left: 2px solid rgba(168, 156, 134, 0.45);
  color: #a89c86;
  font-size: 12px;
  line-height: 16px;
}

.note-head,
.note-body summary {
  margin: 0;
  overflow-wrap: anywhere;
  cursor: default;
}

.note-body summary {
  cursor: pointer;
}

.note-body pre {
  margin: 4px 0 0;
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.again {
  display: flex;
  gap: 10px;
  margin-top: 2px;
}

.link {
  padding: 0;
  border: 0;
  background: none;
  color: #f3c64e;
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}

/* The running turn: how long it runs, and its last steps. */
.msg.working {
  align-items: stretch;
  padding: 5px 8px;
  border: 1px solid rgba(243, 198, 78, 0.35);
  border-radius: 8px;
  background: rgba(40, 30, 10, 0.6);
}

.work-head {
  margin: 0;
  color: #f3c64e;
  font-weight: 650;
}

.work-head::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: #f3c64e;
  vertical-align: 1px;
  animation: glow 1.4s ease-in-out infinite;
}

.work-lines {
  margin: 3px 0 0;
  padding: 0;
  list-style: none;
  color: #cfc4ad;
  font-size: 12px;
  line-height: 16px;
}

.work-lines li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg.failure {
  color: #ff8d7a;
}

.fresh {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  padding: 3px 12px;
  border: 1px solid rgba(240, 165, 70, 0.7);
  border-radius: 12px;
  background: rgba(30, 20, 8, 0.95);
  color: #f6dfb0;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

@keyframes glow {
  50% {
    opacity: 0.3;
  }
}

@media (prefers-reduced-motion: reduce) {
  .work-head::before {
    animation: none;
  }
}

@media (max-width: 760px) {
  .chip {
    min-height: 40px;
  }
}
</style>
