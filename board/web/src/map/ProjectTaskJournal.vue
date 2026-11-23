<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef, watch } from "vue";
import { formatClock, formatFullTime } from "../lib/format";
import { prLabel, problemLabel, taskTitle } from "../lib/labels";
import { detachedName, isCurrent, statusLabels, type ProjectTask, type ProjectTaskChange, type ProjectTaskDetails } from "../lib/projectTasks";
import type { BoardSource } from "../lib/source";
import { useTaskDetail } from "../lib/taskDetail";
import type { OperatorActivity, OperatorTarget } from "../operatorActivity";
import type { TaskSummary } from "../types";
import { stateOf, verdictTitle } from "./ship/bridge";
import { changesLine, reportParagraphs } from "./ship/now";

const props = defineProps<{
  task: ProjectTask;
  initialSlug?: string;
  records: Readonly<Record<string, TaskSummary>>;
  source: BoardSource;
  now: number;
  operator?: OperatorActivity | null;
  operatorChat?: boolean;
  rename?: (change: ProjectTaskChange) => Promise<ProjectTask>;
}>();
const emit = defineEmits<{ close: []; runControls: [sessionId: string]; askOperator: [target: OperatorTarget] }>();

const details = shallowRef<ProjectTaskDetails | null>(null);
const linksError = ref(false);
const retryLinks = ref(0);
watch(() => [JSON.stringify(props.task.session_slugs), props.task.pull_requests.map((pr) => pr.url).join(), retryLinks.value], (_, __, onCleanup) => {
  if (!props.source.fetchProjectTaskDetails || (!props.task.sessions.length && !props.task.pull_requests.length)) return;
  let active = true;
  linksError.value = false;
  onCleanup(() => { active = false; });
  void props.source.fetchProjectTaskDetails(props.task.id).then((result) => {
    if (active) details.value = result;
  }).catch(() => {
    if (active) linksError.value = true;
  });
}, { immediate: true });

const sessionKinds = { work: "Исполнение", review: "Ревью", scout: "Разведка", session: "Сессия", duty: "Дежурный", reflect: "Рефлексия" };
const harnesses = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };
const prStatuses = { draft: "Черновик", open: "Открыт", merged: "Влит", closed: "Закрыт" };
const sessions = computed(() => props.task.sessions.map((id) => {
  const slug = props.task.session_slugs[id];
  const fetched = details.value?.sessions[id];
  const live = slug ? props.records[slug] : undefined;
  const record = live && (!fetched || live.created === fetched.created) ? live : fetched;
  return { id, slug, record, label: record ? taskTitle(record) : slug ?? detachedName(id) };
}));
const selectedId = ref(sessions.value.find((row) => row.slug && row.slug === props.initialSlug)?.id);
const selected = computed(() => sessions.value.find((row) => row.id === selectedId.value)
  ?? sessions.value.find((row) => row.slug && row.slug === props.task.source_slug)
  ?? sessions.value.find((row) => row.slug) ?? sessions.value[0]);

const { detail, detailError, detailState, loadDetail, resetDetail } = useTaskDetail(() =>
  selected.value?.slug ? props.source.fetchDetail(selected.value.slug) : Promise.resolve(null));
watch(() => selected.value?.slug, () => {
  resetDetail();
  void loadDetail();
}, { immediate: true });
watch(() => selected.value?.record?.updated_at, (value, previous) => {
  if (value !== undefined && previous !== undefined && value !== previous) void loadDetail();
});

const run = computed(() => {
  const row = selected.value;
  const result = detail.value;
  return result && row?.slug === result.slug && (!row.record || row.record.created === result.created) ? result : null;
});
const record = computed(() => selected.value?.record ?? run.value);
const state = computed(() => record.value ? stateOf(record.value) : null);
const changeText = computed(() => changesLine(run.value?.changes));
const inHistory = computed(() => !isCurrent(props.task));
const statusNote = computed(() => {
  if (inHistory.value || !record.value) return null;
  return record.value.column === "sleeping" ? "Ждёт сброса квоты" : problemLabel(record.value);
});

const operatorHistory = computed(() => (props.operator?.history ?? [])
  .filter((item) => props.task.sessions.includes(item.task_id)));
const recommendation = computed(() => props.task.sessions.length && !inHistory.value
  ? operatorHistory.value.find((item) => item.task_id === selected.value?.id && item.turn === record.value?.turn) : undefined);
const isAnalyzing = computed(() => !inHistory.value && !!props.operator?.current &&
  props.operator.current.task_id === selected.value?.id);

interface JournalEntry {
  id: string;
  actor: string;
  title: string;
  at: number;
  text?: string;
  report?: boolean;
}
const reportBody = computed(() => reportParagraphs(run.value?.report ?? record.value?.summary ?? ""));
const entries = computed(() => {
  const rows: JournalEntry[] = [];
  const shown = record.value;
  if (shown) {
    if (reportBody.value.length) {
      rows.push({
        id: "report", actor: harnesses[shown.executor] ?? shown.executor,
        title: shown.turn > 0 ? "Отчёт по ходу " + shown.turn : "Отчёт исполнителя",
        at: shown.phase === "idle" ? shown.phase_started_at ?? shown.updated_at : shown.updated_at,
        report: true,
      });
    }
    const verdict = shown.lead_verdict && verdictTitle(shown);
    if (shown.lead_verdict_at !== null && verdict) {
      rows.push({ id: "verdict", actor: "Пользователь", title: verdict, at: shown.lead_verdict_at });
    }
    for (const [index, message] of (run.value?.messages ?? []).entries()) {
      const labels = { lead: ["Пользователь", "Указание"], review: ["Ревью", "Отчёт ревью"], ci: ["CI", "Результат CI"] } as const;
      const [actor, title] = labels[message.source];
      rows.push({ id: "message-" + index, actor, title, at: message.at, text: message.text });
    }
    if (shown.created !== null) {
      rows.push({ id: "started", actor: "Teamster", title: shown.kind === "session" ? "Сессия создана" : "Запуск создан", at: shown.created });
    }
  }
  for (const item of operatorHistory.value) {
    if (item.event_id === recommendation.value?.event_id) continue;
    rows.push({
      id: item.event_id, actor: item.source === "mini" ? "Оператор Mini" : "Оператор",
      title: "Разбор хода " + item.turn + " · " + item.title,
      text: item.recommendation, at: item.started_at,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
});
const pulls = computed(() => props.task.pull_requests.map((pr) => {
  const status = details.value?.pull_requests[pr.url];
  return { ...pr, status: status ? prStatuses[status] : null };
}));

const back = ref<HTMLButtonElement | null>(null);
const renameButton = ref<HTMLButtonElement | null>(null);
const titleField = ref<HTMLInputElement | null>(null);
const draft = ref<string | null>(null);
const saving = ref(false);
const renameError = ref("");
function editTitle() {
  draft.value = props.task.title;
  renameError.value = "";
  void nextTick(() => titleField.value?.focus());
}
function cancelRename() {
  draft.value = null;
  void nextTick(() => renameButton.value?.focus());
}
async function saveTitle() {
  const title = draft.value?.trim();
  if (!title || !props.rename || saving.value) return;
  saving.value = true;
  renameError.value = "";
  try {
    await props.rename({ id: props.task.id, title });
    cancelRename();
  } catch (error) {
    renameError.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}
function closeOrCancel() {
  if (draft.value === null) emit("close");
  else if (!saving.value) cancelRename();
}
onMounted(() => back.value?.focus({ preventScroll: true }));
</script>

<template>
  <section class="task-journal" role="dialog" aria-modal="false" aria-labelledby="journal-title" @keydown.esc.stop="closeOrCancel">
    <div class="journal-page">
      <nav class="breadcrumb" aria-label="Положение задачи">
        <button ref="back" type="button" class="btn" @click="emit('close')">← К карте</button>
        <span>{{ task.project }}</span>
        <span v-if="inHistory" class="history-mark">В истории</span>
      </nav>

      <header class="journal-heading">
        <div class="heading-main">
          <p v-if="task.source_slug && task.source_slug !== task.title" class="source-name"><code>{{ task.source_slug }}</code></p>
          <div class="heading-title">
            <h1 id="journal-title">{{ task.title }}</h1>
            <button v-if="rename && draft === null" ref="renameButton" type="button" class="btn rename-button" @click="editTitle">Переименовать</button>
          </div>
          <form v-if="draft !== null" class="rename-form" @submit.prevent="saveTitle">
            <label>Заголовок задачи <input ref="titleField" v-model="draft" maxlength="200" required :disabled="saving" /></label>
            <div class="actions">
              <button class="btn journal-primary" :disabled="saving || !draft.trim()">Сохранить</button>
              <button class="btn" type="button" :disabled="saving" @click="cancelRename">Отмена</button>
            </div>
            <p v-if="renameError" class="journal-error" role="alert">{{ renameError }}</p>
          </form>
        </div>
        <div class="task-status" :data-status="task.status" role="status">
          <strong>{{ statusLabels[task.status] }}</strong>
          <small v-if="statusNote">{{ statusNote }}</small>
        </div>
      </header>

      <div class="journal-layout">
        <main class="journal-main" aria-labelledby="journal-events">
          <div class="section-heading">
            <h2 id="journal-events">Ход задачи</h2>
            <span v-if="selected?.record" class="muted">{{ sessionKinds[selected.record.kind] }}<template v-if="selected.record.turn > 0"> · ход {{ selected.record.turn }}</template></span>
          </div>
          <ol class="timeline">
            <li v-if="!inHistory" class="event operator-event">
              <div class="event-meta">
                <strong>Оператор Mini</strong>
                <time v-if="recommendation" :datetime="new Date(recommendation.started_at * 1000).toISOString()" :title="formatFullTime(recommendation.started_at)">
                  Разбор начат {{ formatClock(recommendation.started_at, now) }}
                </time>
              </div>
              <section class="operator-note">
                <h3>{{ isAnalyzing ? "Идёт разбор задачи" : recommendation ? "Рекомендация по ходу" : "Следующий шаг" }}</h3>
                <p v-if="recommendation" class="event-text">{{ recommendation.recommendation }}</p>
                <p v-else-if="!isAnalyzing" class="event-text">
                  {{ operator?.available ? "Для выбранного хода пока нет рекомендации." : "Данные оператора сейчас недоступны." }}
                </p>
                <button v-if="operatorChat" type="button" class="btn journal-primary"
                  @click="emit('askOperator', { kind: 'project', id: task.id, title: task.title })">Спросить оператора</button>
              </section>
            </li>
            <li v-for="entry in entries" :key="entry.id" class="event">
              <div class="event-meta">
                <strong>{{ entry.actor }}</strong>
                <time :datetime="new Date(entry.at * 1000).toISOString()" :title="formatFullTime(entry.at)">{{ formatClock(entry.at, now) }}</time>
              </div>
              <details v-if="entry.report" class="event-details" open>
                <summary>{{ entry.title }}</summary>
                <ul v-if="changeText || record?.check === 'passed' || record?.ci === 'passed'" class="report-facts">
                  <li v-if="record?.check === 'passed'" class="passed">Проверка пройдена</li>
                  <li v-if="record?.ci === 'passed'" class="passed">CI прошёл</li>
                  <li v-if="changeText">{{ changeText }}</li>
                </ul>
                <div class="report-text">
                  <p v-for="(paragraph, index) in reportBody" :key="index">
                    <template v-for="(part, at) in paragraph" :key="at"><code v-if="part.code">{{ part.text }}</code><template v-else>{{ part.text }}</template></template>
                  </p>
                </div>
              </details>
              <details v-else-if="entry.text && entry.text.length > 320" class="event-details">
                <summary>{{ entry.title }}</summary>
                <p class="event-text">{{ entry.text }}</p>
              </details>
              <template v-else>
                <h3>{{ entry.title }}</h3>
                <p v-if="entry.text" class="event-text">{{ entry.text }}</p>
              </template>
            </li>
          </ol>
          <p v-if="detailError" role="alert" class="journal-error">
            Не удалось прочитать события запуска. <button type="button" class="btn" @click="loadDetail">Повторить</button>
          </p>
          <p v-else-if="selected?.slug && detailState === 'loading'" role="status" class="muted">Загружаю журнал запуска…</p>
          <p v-else-if="!entries.length" class="muted">В журнале пока нет событий.</p>
          <details v-if="run?.timeline.length" class="system-events">
            <summary>Системные события запуска</summary>
            <ul>
              <li v-for="(event, index) in run.timeline" :key="index">
                <time :datetime="new Date(event.at * 1000).toISOString()">{{ formatClock(event.at, now) }}</time>
                <span>{{ event.text }}</span>
              </li>
            </ul>
          </details>
        </main>

        <aside class="journal-side" aria-label="Назначение и связи">
          <section v-if="record" class="assignment" aria-labelledby="journal-assignment">
            <h2 id="journal-assignment">Назначение</h2>
            <dl>
              <div><dt>Harness</dt><dd>{{ harnesses[record.executor] ?? record.executor }}</dd></div>
              <div v-if="record.account"><dt>Подключение</dt><dd><code>{{ record.account }}</code></dd></div>
              <div v-if="record.model"><dt>Модель</dt><dd><code>{{ record.model }}</code></dd></div>
              <div v-if="record.branch"><dt>Ветка</dt><dd><code>{{ record.branch }}</code></dd></div>
              <div v-if="state"><dt>Запуск</dt><dd>{{ state.text }}</dd></div>
              <div v-if="record.sleeping_until !== null && record.column === 'sleeping'">
                <dt>Возобновление</dt><dd>{{ formatClock(record.sleeping_until, now) }}</dd>
              </div>
            </dl>
            <button v-if="selected?.slug" type="button" class="btn" @click="emit('runControls', selected.id)">Действия запуска</button>
          </section>
          <section class="links" aria-labelledby="journal-links">
            <h2 id="journal-links">Сессии и PR</h2>
            <p v-if="linksError" class="journal-error" role="alert">
              Не удалось обновить сведения о связях. <button class="btn" type="button" @click="retryLinks++">Повторить</button>
            </p>
            <ul v-if="sessions.length" class="session-list">
              <li v-for="row in sessions" :key="row.id">
                <button v-if="row.slug" type="button" class="session-link" :aria-pressed="row.id === selected?.id" @click="selectedId = row.id">
                  <span>{{ row.label }}</span>
                  <small v-if="row.record">{{ sessionKinds[row.record.kind] }} · {{ stateOf(row.record).text }}</small>
                </button>
                <p v-else class="muted unavailable">{{ row.label }}</p>
              </li>
            </ul>
            <p v-else class="muted">Связанных сессий пока нет.</p>
            <ul v-if="pulls.length" class="pull-list">
              <li v-for="pr in pulls" :key="pr.url">
                <a :href="pr.url" target="_blank" rel="noopener">{{ pr.provider === "github" ? "GitHub" : "Forgejo" }} · {{ prLabel(pr.url) }} ↗</a>
                <small v-if="pr.status">{{ pr.status }}</small>
              </li>
            </ul>
            <p v-else class="muted">PR пока нет.</p>
          </section>
        </aside>
      </div>
    </div>
  </section>
</template>

<style scoped>
.task-journal {
  position: absolute;
  inset: 0;
  z-index: 14;
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--surface-2);
  color: var(--text);
}
.journal-page {
  --journal-accent: light-dark(#2d5b4e, #a0d4c1);
  --journal-operator: light-dark(#e9f1ed, #23352f);
  --journal-operator-line: light-dark(#cbded4, #3d574c);
  max-width: 1220px;
  margin: 0 auto;
  padding: 22px clamp(16px, 4vw, 52px) 40px;
  overflow-wrap: anywhere;
}
.journal-page h1, .journal-page h2, .journal-page h3, .journal-page p, .journal-page ul, .journal-page ol, .journal-page dl, .journal-page dd { margin: 0; }
.journal-page h2 { font-size: 17px; line-height: 1.3; }
.journal-page h3 { font-size: 14px; line-height: 1.35; }
.breadcrumb, .heading-title, .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.breadcrumb { margin-bottom: 18px; color: var(--muted); font-size: 13px; }
.history-mark { border-left: 1px solid var(--border); padding-left: 10px; }
.journal-heading { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 14px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
.heading-main { min-width: 0; flex: 1 1 390px; }
.source-name { color: var(--muted); font-size: 12px; margin-bottom: 4px !important; }
.heading-title h1 { font-size: clamp(24px, 4vw, 36px); font-weight: 675; line-height: 1.15; letter-spacing: -.04em; }
.rename-button { align-self: center; }
.rename-form { display: grid; gap: 8px; max-width: 440px; margin-top: 12px; }
.rename-form label { display: grid; gap: 4px; font-size: 13px; }
.rename-form input { width: 100%; }
.task-status { display: grid; gap: 2px; padding: 7px 11px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); font-size: 13px; }
.task-status[data-status="needs_input"], .task-status[data-status="blocked"] { background: var(--warn-soft); color: var(--warn); }
.task-status[data-status="ready"], .task-status[data-status="done"] { background: var(--journal-operator); color: var(--journal-accent); }
.task-status small { font-size: 12px; }
.journal-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(230px, .43fr); align-items: start; gap: clamp(19px, 3vw, 36px); margin-top: 20px; }
.section-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.section-heading span { font-size: 12px; }
.timeline { list-style: none; padding: 0; margin-top: 12px !important; }
.event { position: relative; display: grid; gap: 5px; padding: 0 0 16px 16px; margin-left: 4px; border-left: 1px solid var(--border-strong); }
.event:last-child { padding-bottom: 5px; }
.event::before { content: ""; position: absolute; top: 5px; left: -4px; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.operator-event::before { background: var(--journal-accent); }
.event-meta { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 10px; font-size: 12px; }
.event-meta time, .system-events time { color: var(--muted); font-variant-numeric: tabular-nums; }
.operator-note { display: grid; gap: 8px; padding: 12px 14px; background: var(--journal-operator); border: 1px solid var(--journal-operator-line); border-radius: 10px; }
.operator-note .btn { justify-self: start; }
.journal-primary { background: var(--journal-accent); color: light-dark(#fff, #193329); border-color: var(--journal-accent); }
.journal-primary:hover:not(:disabled) { filter: brightness(.94); background: var(--journal-accent); }
.event-text, .report-text { font-size: 14px; line-height: 1.55; white-space: pre-wrap; }
.event-details summary, .system-events summary { cursor: pointer; font-weight: 600; }
.event-details .event-text, .report-text { margin-top: 6px; }
.report-text p + p { margin-top: 8px; }
.report-facts { display: flex; gap: 4px 12px; flex-wrap: wrap; list-style: none; padding: 4px 0 0; color: var(--muted); font-size: 12px; }
.passed { color: var(--journal-accent); }
.system-events { border-top: 1px solid var(--border); padding: 9px 0 0; margin-top: 8px; }
.system-events ul, .session-list, .pull-list { list-style: none; padding: 0; }
.system-events li { display: grid; grid-template-columns: minmax(80px, auto) 1fr; gap: 10px; padding: 5px 0; font-size: 12px; }
.journal-side { display: grid; align-content: start; gap: 12px; }
.assignment, .links { display: grid; gap: 9px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 13px; }
.assignment dl div { display: grid; grid-template-columns: minmax(90px, .8fr) minmax(0, 1fr); gap: 8px; padding: 4px 0; font-size: 13px; }
.assignment dt, .links small { color: var(--muted); }
.assignment .btn { justify-self: start; }
.session-link { width: 100%; border: 1px solid transparent; border-radius: 6px; padding: 6px; background: transparent; cursor: pointer; text-align: start; color: var(--text); overflow-wrap: anywhere; }
.session-link:hover, .session-link[aria-pressed="true"] { background: var(--journal-operator); border-color: var(--journal-operator-line); }
.session-link span, .session-link small { display: block; }
.session-link[aria-pressed="true"] span { color: var(--journal-accent); font-weight: 600; }
.session-list li + li, .pull-list li + li { margin-top: 3px; }
.pull-list li { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 8px; }
.pull-list a, .links p, .unavailable { font-size: 13px; }
.journal-error { color: var(--bad); }
@media (max-width: 720px) {
  .journal-layout { grid-template-columns: minmax(0, 1fr); }
  .journal-side { grid-template-columns: repeat(auto-fit, minmax(min(100%, 255px), 1fr)); }
}
</style>
