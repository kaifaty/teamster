<script setup lang="ts">
import { computed } from "vue";
import { formatClock } from "../lib/format";
import { ACTIVITY, EXECUTORS, KINDS } from "../lib/labels";
import type { ProjectRunWork } from "../lib/projectTasks";
import type { OperatorResolution } from "../operatorActivity";
import type { TaskSummary } from "../types";
import { stateOf } from "./ship/bridge";

const props = defineProps<{
  sessions: readonly { id: string; slug?: string; label: string; record?: TaskSummary }[];
  selected?: string;
  work?: Readonly<Record<string, ProjectRunWork>>;
  resolution: OperatorResolution | null;
  now: number;
}>();
const emit = defineEmits<{ select: [id: string]; controls: [id: string] }>();

const handoffs = computed(() => {
  const latest = new Map<string, { at: number; text: string; question: boolean }>();
  for (const command of props.resolution?.commands ?? []) {
    if (command.text && command.action !== "stop") {
      latest.set(command.run, { at: command.at, text: command.text, question: false });
    }
  }
  for (const event of props.resolution?.events ?? []) {
    const { run, note, action } = event.detail;
    if (event.kind === "waiting_followup" && run && note && (latest.get(run)?.at ?? 0) < event.at) {
      latest.set(run, { at: event.at, text: note, question: action === "ask_executor" });
    }
  }
  return latest;
});

const rows = computed(() => props.sessions.map((session) => {
  const record = session.record;
  const work = props.work?.[session.id];
  const handoff = handoffs.value.get(session.id);
  const sent = work?.order;
  const queued = work?.next_order;
  const handoffText = (text?: string) => handoff && (text === handoff.text || text?.endsWith("\n\n" + handoff.text))
    ? handoff.text : undefined;
  const sentHandoff = handoffText(sent?.text);
  const queuedHandoff = handoffText(queued?.text);
  const operatorLabel = handoff?.question ? "Вопрос оператора" : "Поручение оператора";
  const phase = record ? stateOf(record) : null;
  const active = !!record?.alive && record.column !== "sleeping" && record.column !== "closed";
  const status = record?.column === "sleeping" ? "Ждёт сброса квоты"
    : record?.column === "closed" ? "Нет активного хода" : phase?.text ?? "Сессия недоступна";
  const notes = [];
  if (sent) {
    notes.push({ label: sentHandoff ? operatorLabel : active ? "Текущее указание" : "Последнее указание",
      text: sentHandoff ?? sent.text });
  } else if (work?.goal) {
    notes.push({ label: "Постановка задачи", text: work.goal });
  }
  if (work && queued) {
    notes.push({ label: work.queued > 1 ? `Следующее в очереди · всего ${work.queued}` : "В очереди",
      text: queuedHandoff ?? queued.text });
  }
  if (handoff && !sentHandoff && !queuedHandoff && handoff.at >= (sent?.at ?? 0)) {
    notes.push({ label: handoff.question ? "Последний вопрос оператора" : "Последнее поручение оператора", text: handoff.text });
  }
  return { ...session, record, active, status, tone: phase?.tone ?? "dim", notes,
    priority: active ? 0 : queued || record?.column === "sleeping" ? 1 : 2 };
}).sort((left, right) => left.priority - right.priority));
</script>

<template>
  <section class="executors" aria-labelledby="journal-executors">
    <h2 id="journal-executors">Исполнители</h2>
    <p v-if="!rows.length" class="muted">К задаче пока не привязано ни одной сессии.</p>
    <ul v-else>
      <li v-for="row in rows" :key="row.id" :class="{ selected: selected === row.id }">
        <header class="executor-heading">
          <button v-if="row.slug" type="button" class="executor-link" :aria-pressed="selected === row.id" @click="emit('select', row.id)">
            {{ row.label }}
          </button>
          <strong v-else>{{ row.label }}</strong>
          <span class="executor-status" :data-tone="row.tone">{{ row.status }}</span>
        </header>
        <p v-if="row.record" class="executor-meta muted">
          {{ KINDS[row.record.kind] }} · {{ EXECUTORS[row.record.executor] ?? row.record.executor }}
          <template v-if="row.record.account"> · <code>{{ row.record.account }}</code></template>
          <template v-if="row.record.model"> · {{ row.record.model }}</template>
        </p>
        <div v-for="note in row.notes" :key="note.label">
          <details v-if="note.text.length > 300">
            <summary><strong>{{ note.label }}</strong> · {{ note.text.slice(0, 175).trimEnd() }}…</summary>
            <p class="note-text">{{ note.text }}</p>
          </details>
          <p v-else class="note-text"><strong>{{ note.label }}</strong> · {{ note.text }}</p>
        </div>
        <p v-if="row.active && row.record?.phase === 'review' && row.record.reviewer" class="executor-meta">
          Ревьюер · {{ EXECUTORS[row.record.reviewer] ?? row.record.reviewer }}
        </p>
        <p v-if="row.active && row.record?.activity" class="executor-meta muted">
          Последняя активность · {{ ACTIVITY[row.record.activity.kind].label }} · {{ row.record.activity.text }}
          <template v-if="row.record.activity.at !== null"> · {{ formatClock(row.record.activity.at, now) }}</template>
        </p>
        <p v-else-if="row.record?.column === 'sleeping' && row.record.sleeping_until !== null" class="executor-meta muted">
          Возобновление {{ formatClock(row.record.sleeping_until, now) }}
        </p>
        <p v-else-if="!row.active && row.record?.summary" class="executor-meta muted">Последний результат · {{ row.record.summary }}</p>
        <div v-if="row.slug && selected === row.id" class="executor-actions">
          <button type="button" class="btn" @click="emit('controls', row.id)">Действия запуска</button>
          <code v-if="row.record?.branch" class="muted">{{ row.record.branch }}</code>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.executors { margin-top: 18px; display: grid; gap: 9px; }
.executors ul { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 9px; }
.executors li { display: grid; align-content: start; gap: 7px; min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); font-size: 14px; }
.executors li.selected { border-color: var(--journal-operator-line); }
.executor-heading, .executor-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; }
.executor-heading { justify-content: space-between; }
.executor-link { border: 0; padding: 0; background: none; color: var(--text); text-align: left; font: inherit; font-weight: 650; cursor: pointer; overflow-wrap: anywhere; }
.executor-link:hover { text-decoration: underline; }
.executor-link[aria-pressed="true"] { color: var(--journal-accent); }
.executor-status { padding: 2px 7px; border-radius: 6px; border: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.executor-status[data-tone="work"] { color: var(--journal-accent); background: var(--journal-operator); border-color: var(--journal-operator-line); }
.executor-status[data-tone="wait"], .executor-status[data-tone="sleep"] { color: var(--warn); }
.executor-status[data-tone="bad"] { color: var(--bad); }
.executor-meta, .executor-actions code { font-size: 12px; }
.note-text { white-space: pre-wrap; }
details summary { cursor: pointer; }
details[open] .note-text { margin-top: 5px; }
</style>
