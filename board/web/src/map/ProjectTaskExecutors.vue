<script setup lang="ts">
import { computed } from "vue";
import { formatClock, formatFullTime } from "../lib/format";
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
const stageText: Record<TaskSummary["phase"], string> = {
  turn: "Исполнитель работает над поручением",
  check: "Teamster выполняет проверки",
  review: "Идёт ревью изменений",
  fix: "Исполнитель исправляет замечания",
  ci: "Teamster ждёт результатов CI",
  sleeping: "Ход приостановлен до сброса квоты",
  idle: "Teamster завершает ход",
};
const activityLabels = { ...ACTIVITY, message: { label: "Сообщение исполнителя" } };

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
  const started = work?.turn_started_at ?? (record?.phase === "turn" ? record.phase_started_at : null);
  const last = record?.activity;
  const fallback = last && last.kind !== "thinking" && last.text
    && (started === null || last.at !== null && last.at >= started) ? [last] : [];
  const publicActivity = work?.recent_activity?.filter((event) => event.kind !== "thinking");
  const recent = publicActivity?.length ? publicActivity : fallback;
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
  return { ...session, record, active, status, tone: phase?.tone ?? "dim", notes, started, recent,
    name: record ? EXECUTORS[record.executor] ?? record.executor : session.label,
    check: record?.phase === "check" ? work?.check_command : null,
    priority: active ? 0 : queued || record?.column === "sleeping" ? 1 : 2 };
}).sort((left, right) => left.priority - right.priority));
</script>

<template>
  <section class="executors" aria-labelledby="journal-executors">
    <h2 id="journal-executors">Исполнители</h2>
    <p v-if="!rows.length" class="muted">К задаче пока не привязано ни одной сессии.</p>
    <ul v-else class="executor-list">
      <li v-for="row in rows" :key="row.id" class="executor" :class="{ selected: selected === row.id, live: row.active }">
        <header class="executor-heading">
          <div>
            <h3>{{ row.name }}<template v-if="row.record?.account"> · <code>{{ row.record.account }}</code></template></h3>
            <p v-if="row.record" class="executor-meta muted">
              {{ KINDS[row.record.kind] }}<template v-if="row.record.model"> · {{ row.record.model }}</template>
            </p>
          </div>
          <span class="executor-status" :data-tone="row.tone">{{ row.status }}</span>
        </header>
        <p v-if="row.started !== null" class="executor-time muted">
          {{ row.record?.alive ? "Текущий ход начат" : "Последний ход начат" }}
          <time :datetime="new Date(row.started * 1000).toISOString()" :title="formatFullTime(row.started)">
            {{ formatClock(row.started, now) }}
          </time>
        </p>
        <div class="executor-body">
          <div class="executor-orders">
            <div v-for="note in row.notes" :key="note.label" class="executor-order">
              <h4>{{ note.label }}</h4>
              <details v-if="note.text.length > 300">
                <summary>{{ note.text.slice(0, 175).trimEnd() }}…</summary>
                <p class="note-text">{{ note.text }}</p>
              </details>
              <p v-else class="note-text">{{ note.text }}</p>
            </div>
            <p v-if="row.record?.column === 'sleeping' && row.record.sleeping_until !== null" class="executor-meta muted">
              Возобновление {{ formatClock(row.record.sleeping_until, now) }}
            </p>
            <div v-else-if="!row.active && row.record?.summary" class="executor-order">
              <h4>Последний результат</h4>
              <p>{{ row.record.summary }}</p>
            </div>
          </div>
          <div v-if="row.active && row.record" class="executor-progress">
            <h4>Что происходит сейчас</h4>
            <p>{{ stageText[row.record.phase] }}
              <template v-if="row.record.phase === 'review' && row.record.reviewer">
                · {{ EXECUTORS[row.record.reviewer] ?? row.record.reviewer }}
              </template>
            </p>
            <details v-if="row.check">
              <summary>Команда проверки</summary>
              <p><code>{{ row.check }}</code></p>
            </details>
            <details v-if="row.recent.length" class="executor-activity" open>
              <summary>{{ row.started === null ? "Последние действия" : "Действия этого хода" }}</summary>
              <ol>
                <li v-for="event in row.recent" :key="event.kind + ':' + event.text">
                  <div class="activity-meta muted">
                    <span>{{ activityLabels[event.kind].label }}</span>
                    <time v-if="event.at !== null" :datetime="new Date(event.at * 1000).toISOString()" :title="formatFullTime(event.at)">
                      {{ formatClock(event.at, now) }}
                    </time>
                  </div>
                  <code v-if="event.kind === 'command' || event.kind === 'edit'">{{ event.text }}</code>
                  <p v-else>{{ event.text }}</p>
                </li>
              </ol>
            </details>
          </div>
        </div>
        <footer v-if="row.slug" class="executor-actions">
          <button type="button" class="executor-link" :aria-pressed="selected === row.id" @click="emit('select', row.id)">
            {{ row.label }}
          </button>
          <code v-if="selected === row.id && row.record?.branch" class="executor-meta muted">{{ row.record.branch }}</code>
          <button v-if="selected === row.id" type="button" class="btn" @click="emit('controls', row.id)">Действия запуска</button>
        </footer>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.executors { margin-top: 22px; display: grid; gap: 10px; }
.executors :is(h2, h3, h4, p, ul, ol) { margin: 0; }
.executors h2 { font-size: 18px; line-height: 1.3; }
.executors h3 { font-size: 17px; line-height: 1.35; }
.executors h4 { font-size: 13px; line-height: 1.4; color: var(--journal-accent); }
.executor-list { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 10px; }
.executor { display: grid; align-content: start; gap: 10px; min-width: 0; padding: clamp(12px, 2.4vw, 20px); border: 1px solid var(--border); border-radius: 10px; background: var(--surface); font-size: 14px; line-height: 1.5; }
.executor.live { grid-column: 1 / -1; }
.executor.selected { border-color: var(--journal-operator-line); }
.executor-heading, .executor-actions, .activity-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; }
.executor-heading { justify-content: space-between; }
.executor-body { display: grid; grid-template-columns: minmax(0, 1fr); }
.live .executor-body { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.executor-orders, .executor-progress { display: grid; align-content: start; gap: 8px; min-width: 0; }
.executor-order h4 { margin-bottom: 4px; }
.executor-progress { padding: 10px 12px; border-radius: 8px; background: var(--surface-2); }
.executor-actions { padding-top: 8px; border-top: 1px solid var(--border); }
.executor-link { border: 0; padding: 0; background: none; color: var(--text); text-align: left; font: inherit; font-weight: 650; cursor: pointer; overflow-wrap: anywhere; }
.executor-link:hover { text-decoration: underline; }
.executor-link[aria-pressed="true"] { color: var(--journal-accent); }
.executor-status { padding: 2px 7px; border-radius: 6px; border: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.executor-status[data-tone="work"] { color: var(--journal-accent); background: var(--journal-operator); border-color: var(--journal-operator-line); }
.executor-status[data-tone="wait"], .executor-status[data-tone="sleep"] { color: var(--warn); }
.executor-status[data-tone="bad"] { color: var(--bad); }
.executor-meta, .executor-time, .activity-meta { font-size: 12px; }
.executor-time time, .activity-meta time { font-variant-numeric: tabular-nums; }
.executor-activity summary { font-weight: 600; }
.executor-activity ol { display: grid; gap: 7px; list-style: none; padding: 7px 0 0; }
.executor-activity li { padding-top: 5px; border-top: 1px solid var(--border); }
.executor-activity code { font-size: 12px; }
.activity-meta { justify-content: space-between; }
.note-text { white-space: pre-wrap; }
details summary { cursor: pointer; }
details[open] .note-text { margin-top: 5px; }
@media (max-width: 760px) {
  .live .executor-body { grid-template-columns: minmax(0, 1fr); gap: 10px; }
}
</style>
