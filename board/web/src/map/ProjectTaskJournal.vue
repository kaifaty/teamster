<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { formatClock, formatFullTime } from "../lib/format";
import { prLabel, problemLabel, taskTitle } from "../lib/labels";
import { detachedName, isCurrent, statusLabels, type ProjectRunWork, type ProjectTask, type ProjectTaskChange, type ProjectTaskDetails } from "../lib/projectTasks";
import type { BoardSource } from "../lib/source";
import { useTaskDetail } from "../lib/taskDetail";
import type { OperatorActivity, OperatorResolution, OperatorResolutionRule, OperatorTarget } from "../operatorActivity";
import type { TaskSummary } from "../types";
import { optionLabels } from "../operatorActivity";
import ProjectTaskDecision from "./ProjectTaskDecision.vue";
import ProjectTaskExecutors from "./ProjectTaskExecutors.vue";
import ProjectTaskOverview from "./ProjectTaskOverview.vue";
import ProjectOperatorChat from "./ProjectOperatorChat.vue";
import { verdictTitle } from "./ship/bridge";
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
const emit = defineEmits<{ close: []; runControls: [sessionId: string]; evidence: [slug: string] }>();

const details = shallowRef<ProjectTaskDetails | null>(null);
const workUpdate = shallowRef<Record<string, ProjectRunWork>>();
const linksError = ref(false);
const retryLinks = ref(0);
watch(() => [props.task.id, JSON.stringify(props.task.session_slugs), props.task.pull_requests.map((pr) => pr.url).join(), retryLinks.value], (_, __, onCleanup) => {
  workUpdate.value = undefined;
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
const overviewContext = computed(() => Object.values(workUpdate.value ?? details.value?.work ?? {}).some((item) => item.goal)
  || sessions.value.some((row) => row.record?.kind !== "session" && row.record?.summary));
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
const changeText = computed(() => changesLine(run.value?.changes));
const inHistory = computed(() => !isCurrent(props.task));
const statusNote = computed(() => {
  if (inHistory.value || !record.value) return null;
  return record.value.column === "sleeping" ? "Ждёт сброса квоты" : problemLabel(record.value);
});

const isAnalyzing = computed(() => !inHistory.value && !!props.operator?.current &&
  props.task.sessions.includes(props.operator.current.task_id));

interface JournalEntry {
  id: string;
  actor: string;
  title: string;
  at: number;
  text?: string;
  report?: boolean;
  evidence?: string;
  reference?: string;
  handoff?: string;
}
const resolution = shallowRef<OperatorResolution | null>(null);
const workRevision = computed(() => JSON.stringify([
  sessions.value.map((row) => [
    row.id, row.record?.turn, row.record?.phase, row.record?.column,
    row.record?.column === "running" ? row.record.activity?.at : null,
  ]),
  resolution.value?.events.filter((event) => event.kind === "waiting_followup" || event.kind === "followup_finished").at(-1)?.seq,
  resolution.value?.commands?.at(-1)?.id,
]));
watch(workRevision, (_, __, onCleanup) => {
  if (!props.source.fetchProjectTaskDetails || !props.task.sessions.length) return;
  let active = true;
  onCleanup(() => { active = false; });
  const id = props.task.id;
  void props.source.fetchProjectTaskDetails(id, true).then((result) => {
    if (active && props.task.id === id && result?.work) workUpdate.value = result.work;
  }).catch(() => {
    if (active && props.task.id === id) linksError.value = true;
  });
});
const operatorHistory = computed(() => resolution.value?.recommendations ?? (props.operator?.history ?? [])
  .filter((item) => props.task.sessions.includes(item.task_id)));
const operatorOnly = ref(false);
const chat = ref<InstanceType<typeof ProjectOperatorChat> | null>(null);
const chatTarget = computed<OperatorTarget>(() => ({ kind: "project", id: props.task.id, title: props.task.title }));
const chatEnabled = computed(() => props.operatorChat && resolution.value?.chat !== undefined);
const resolutionLabels: Record<string, string> = {
  delegated: "Передал полномочия оператору",
  pending: "Полномочия переданы",
  waiting_run: "Ждёт завершения запуска",
  waiting_verdict: "Ждёт вердикта",
  waiting_evidence: "Ждёт связанный запуск",
  needs_decision: "Нужно решение",
  verdict_started: "Записывает вердикт",
  verdict_recorded: "Вердикт записан",
  archive_started: "Сохраняет архив",
  archived: "Запуск архивирован",
  cleanup_blocked: "Выполнение приостановлено",
  revoked: "Полномочия отозваны",
  choice: "Пользователь выбрал действие",
  status_changed: "Статус изменился",
  clarification_requested: "Ждёт ответа пользователя",
  waiting_followup: "Поручение передано исполнителю",
  followup_finished: "Исполнитель ответил",
  repair_conflict: "Оператор вернул исполнителю конфликт PR",
  conflict_detected: "PR конфликтует с базовой веткой",
};
const managed = computed(() => sessions.value.filter((row) => row.slug && row.record
  && ["work", "review"].includes(row.record.kind) && !row.slug.match(/-\d{8}T\d{6}Z$/)));
const possibleEvidence = computed(() => Object.values(props.records).filter((item) =>
  ["work", "review"].includes(item.kind)).map((item) => item.slug).sort());
const resolutionActive = computed(() => resolution.value?.assignment
  && !["archived", "revoked", "followup_finished", "clarification_requested"].includes(resolution.value.assignment.status));
const resolutionForm = ref(false);
const resolutionRun = ref("");
const resolutionRule = ref<"verdict" | "negative">("verdict");
const evidenceSlug = ref("");
const evidencePhrase = ref("");
const resolutionBusy = ref(false);
const resolutionError = ref("");
let resolutionTimer: ReturnType<typeof setInterval> | undefined;
let resolutionRequest = 0;
async function refreshResolution() {
  if (!props.source.fetchOperatorResolution) return;
  const request = ++resolutionRequest;
  try {
    const result = await props.source.fetchOperatorResolution(props.task.id);
    if (request === resolutionRequest) resolution.value = result;
  } catch (error) {
    if (request === resolutionRequest) {
      resolutionError.value = error instanceof Error ? error.message : String(error);
    }
  }
}
function editResolution() {
  resolutionRun.value = managed.value.find((row) => row.id === selected.value?.id)?.id ?? managed.value[0]?.id ?? "";
  resolutionForm.value = true;
  resolutionError.value = "";
}
async function submitResolution(revoke = false) {
  if (!props.source.setOperatorResolution || resolutionBusy.value) return;
  const card = props.task.id;
  const input: OperatorResolutionRule = revoke ? { card, revoke: true }
    : resolutionRule.value === "verdict" ? { card, run: resolutionRun.value, rule: "verdict" }
    : { card, run: resolutionRun.value, rule: "negative", evidence: evidenceSlug.value.trim(), phrase: evidencePhrase.value.trim() };
  resolutionBusy.value = true;
  resolutionError.value = "";
  try {
    await props.source.setOperatorResolution(input);
    resolutionForm.value = false;
    await refreshResolution();
  } catch (error) {
    resolutionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    resolutionBusy.value = false;
  }
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
    const byOperator = shown.lead_verdict === "dropped" && resolution.value?.events.some((event) =>
      event.kind === "verdict_recorded" && event.detail.run === selected.value?.id && event.detail.turn === shown.turn);
    if (shown.lead_verdict_at !== null && verdict && !byOperator) {
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
    rows.push({
      id: "recommendation:" + item.event_id, reference: "recommendation:" + item.event_id,
      actor: item.source === "mini" ? "Оператор Mini" : "Оператор",
      title: "Рекомендация по ходу " + item.turn + " · " + item.title,
      text: item.recommendation, at: item.started_at,
    });
  }
  const commandLabels = { start: "Запустил исполнителя", say: "Передал поручение", stop: "Остановил запуск" };
  for (const command of resolution.value?.commands ?? []) {
    const reference = "command:" + command.id;
    rows.push({
      id: reference, reference, actor: command.actor, title: commandLabels[command.action], at: command.at,
      handoff: [harnesses[command.executor as keyof typeof harnesses] ?? command.executor,
        command.account, command.model, command.slug].filter(Boolean).join(" · "),
      text: command.text ?? undefined,
    });
  }
  for (const event of resolution.value?.events ?? []) {
    const data = event.detail;
    const evidence = typeof data.evidence === "string" ? data.evidence.split(":")[0] : data.evidence?.slug;
    const reason = event.kind === "needs_decision"
      ? "Подтверди итог вручную или передай оператору другое условие."
      : undefined;
    const text = [reason, data.reason, data.action && optionLabels[data.action],
      data.from && data.to && `${statusLabels[data.from]} → ${statusLabels[data.to]}`,
      data.verdict === "accepted" ? "Результат принят" : data.verdict === "dropped" ? "Работа отклонена" : undefined,
      data.report ?? (typeof data.evidence === "object" ? data.evidence?.report : undefined),
      data.note ?? data.phrase, data.sha && `SHA ${data.sha}`, data.archive && `Архив ${data.archive}`,
      data.record_only && "В архив перенесён журнал задачи. Рабочих ресурсов не было.",
      data.files !== undefined ? `Файлов и ссылок вне Git: ${data.files}` : undefined,
      data.worktree && `Рабочая копия ${data.worktree}`,
      (data.operation ?? data.id) && `Операция ${data.operation ?? data.id}`].filter(Boolean).join("\n");
    const reference = `resolution:${event.seq}`;
    const target = data.run ? sessions.value.find((row) => row.id === data.run) : undefined;
    rows.push({ id: reference, reference, title: resolutionLabels[event.kind] ?? event.kind,
      handoff: target?.record ? [harnesses[target.record.executor] ?? target.record.executor, target.record.account,
        target.label].filter(Boolean).join(" · ") : data.run?.split(":")[0],
      actor: event.actor === "operator" ? "Оператор Mini" : "Пользователь", at: event.at, text, evidence });
  }
  for (const item of resolution.value?.proposals ?? []) {
    if (item.status !== "answered") continue;
    rows.push({ id: "proposal:" + item.id, actor: "Оператор Mini", at: item.at, title: "Подготовил варианты действий",
      text: [item.reason, ...item.options!.map(option => optionLabels[option.action] + " · " + option.text)].join("\n") });
  }
  return rows.sort((a, b) => b.at - a.at);
});
const visibleEntries = computed(() => operatorOnly.value ? entries.value.filter((row) => row.reference || row.id.startsWith("proposal:")) : entries.value);
const latestEvent = computed(() => entries.value.find((row) => row.reference && row.title !== resolutionLabels.status_changed)
  ?? entries.value[0]);
const labels = computed(() => new Map(entries.value.flatMap((row) =>
  row.reference ? [[row.reference, row.title + " · " + formatClock(row.at, props.now)] as const] : [])));
const pulls = computed(() => props.task.pull_requests.map((pr) => ({
  ...pr, status: details.value?.pull_requests[pr.url] ?? null,
})));
const showBlocker = computed(() => props.task.status === "blocked" || props.task.status === "needs_input");
const remaining = computed(() => run.value?.cargo?.remaining ?? []);
const questions = computed(() => run.value?.cargo?.questions ?? []);
const blockerItems = computed(() => [...questions.value, ...remaining.value]);
const mergedPulls = computed(() => pulls.value.filter((pr) => pr.status === "merged"));
const work = computed(() => workUpdate.value ?? details.value?.work);
const working = computed(() => sessions.value.find((row) => row.record?.alive && row.record.column === "running"));
const sleeping = computed(() => sessions.value.find((row) => row.record?.column === "sleeping"));
const queued = computed(() => sessions.value.find((row) => (work.value?.[row.id]?.queued ?? 0) > 0));
const awaitingExecutor = computed(() => resolution.value?.assignment?.status === "waiting_followup");
const underway = computed(() => !!(working.value || sleeping.value || queued.value || awaitingExecutor.value));
const nextStep = computed(() => {
  switch (props.task.status) {
    case "blocked": return "Что мешает продолжить";
    case "needs_input": return "Какое решение требуется";
    case "ready": return "Результат готов к приёмке";
    case "done": return "Результат принят";
    case "cancelled": return "Работа отменена";
  }
  if (working.value) return "Исполнитель ведёт работу";
  if (sleeping.value) return "Исполнитель ждёт сброса квоты";
  if (queued.value) return "Поручение в очереди";
  if (awaitingExecutor.value) return "Поручение передано исполнителю";
  return "Нет активного хода";
});
const nextExecutor = computed(() => (working.value ?? sleeping.value ?? queued.value
  ?? sessions.value.find((row) => row.id === resolution.value?.assignment?.run))?.record);

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
onMounted(() => {
  back.value?.focus({ preventScroll: true });
  if (props.source.fetchOperatorResolution) {
    void refreshResolution();
    resolutionTimer = setInterval(refreshResolution, 5000);
  }
});
onBeforeUnmount(() => {
  if (resolutionTimer) clearInterval(resolutionTimer);
  resolutionRequest++;
});
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
            <span class="task-status" :data-status="task.status" role="status">{{ statusLabels[task.status] }}</span>
            <button v-if="rename && draft === null" ref="renameButton" type="button" class="btn rename-button" @click="editTitle">Переименовать</button>
          </div>
          <p v-if="resolution?.overview?.change" class="task-description">{{ resolution.overview.change }}</p>
          <form v-if="draft !== null" class="rename-form" @submit.prevent="saveTitle">
            <label>Заголовок задачи <input ref="titleField" v-model="draft" maxlength="200" required :disabled="saving" /></label>
            <div class="actions">
              <button class="btn journal-primary" :disabled="saving || !draft.trim()">Сохранить</button>
              <button class="btn" type="button" :disabled="saving" @click="cancelRename">Отмена</button>
            </div>
            <p v-if="renameError" class="journal-error" role="alert">{{ renameError }}</p>
          </form>
        </div>
      </header>

      <div class="journal-layout">
        <ProjectTaskDecision class="journal-summary" :heading="nextStep" :blocked="showBlocker" :now="now"
          :executor="task.status === 'active' ? nextExecutor : undefined" :target="chatTarget" :source="source"
          :show-options="!inHistory && (task.status !== 'active' || !underway)" :resolution="resolution"
          :enabled="chatEnabled" :resolving="!!resolutionActive && resolution?.assignment?.status !== 'cleanup_blocked'"
          :refresh="refreshResolution" @focus-chat="chat?.focus()">
          <template v-if="showBlocker" #blocker>
            <template v-if="blockerItems.length">
              <p>{{ blockerItems[0] }}</p>
              <details v-if="blockerItems.length > 1">
                <summary>Остальное из отчёта</summary>
                <ul><li v-for="(item, index) in blockerItems.slice(1)" :key="index">{{ item }}</li></ul>
              </details>
            </template>
            <p v-else-if="selected?.slug && detailState === 'loading'" role="status">Загружаю отчёт запуска…</p>
            <p v-else>{{ record?.summary || statusNote || "В отчёте пока нет причины остановки." }}</p>
            <p v-if="mergedPulls.length">
              Уже влиты <a v-for="pr in mergedPulls" :key="pr.url" :href="pr.url" target="_blank" rel="noopener">
                {{ prLabel(pr.url) }} ↗
              </a>
            </p>
            <p v-if="record" class="muted blocker-source">
              Отчёт · {{ selected?.label }} · {{ formatFullTime(record.updated_at) }}
            </p>
          </template>
        </ProjectTaskDecision>

        <aside class="journal-context" aria-label="Исполнители и связи задачи">
          <ProjectTaskExecutors :sessions="sessions" :selected="selected?.id" :work="work"
            :resolution="resolution" :now="now" @select="selectedId = $event" @controls="emit('runControls', $event)" />
          <ProjectTaskOverview :card="task.id" :overview="resolution?.overview" :has-context="overviewContext"
            :enabled="chatEnabled && !!resolution?.writable" :source="source" :refresh="refreshResolution" />
          <section v-if="pulls.length || linksError" class="links" aria-labelledby="journal-links">
            <h2 id="journal-links">Пул-реквесты</h2>
            <p v-if="linksError" class="journal-error" role="alert">
              Не удалось обновить сведения о связях. <button class="btn" type="button" @click="retryLinks++">Повторить</button>
            </p>
            <ul v-if="pulls.length" class="pull-list">
              <li v-for="pr in pulls" :key="pr.url">
                <a :href="pr.url" target="_blank" rel="noopener">{{ pr.provider === "github" ? "GitHub" : "Forgejo" }} · {{ prLabel(pr.url) }} ↗</a>
                <small v-if="pr.status">{{ prStatuses[pr.status] }}</small>
              </li>
            </ul>
          </section>
        </aside>

        <aside v-if="chatEnabled || resolution?.chat?.length" class="journal-side" aria-label="Оператор">
          <ProjectOperatorChat ref="chat" :target="chatTarget" :now="now" :enabled="chatEnabled"
            :ask="source.askOperator" :messages="resolution?.chat ?? []" :labels="labels" :refresh="refreshResolution" />
        </aside>

        <details class="journal-main">
          <summary class="history-summary"><strong>Ход задачи</strong>
            <span v-if="latestEvent" class="muted">{{ latestEvent.title }} · {{ formatClock(latestEvent.at, now) }}</span>
          </summary>
          <div class="section-heading">
            <span v-if="sessions.length > 1 && selected" class="muted">{{ selected.label }}</span>
            <div class="journal-filter" role="group" aria-label="События журнала">
              <button type="button" class="btn" :aria-pressed="!operatorOnly" @click="operatorOnly = false">Все события</button>
              <button type="button" class="btn" :aria-pressed="operatorOnly" @click="operatorOnly = true">Действия оператора</button>
            </div>
          </div>
          <section v-if="resolution?.writable || resolution?.assignment || resolutionError" class="resolution-controls"
            aria-label="Полномочия оператора">
            <div class="actions">
              <span v-if="resolution?.assignment" role="status">
                {{ resolutionLabels[resolution.assignment.status] ?? resolution.assignment.status }}
              </span>
              <button v-if="resolution?.writable && resolutionActive" class="btn" type="button" :disabled="resolutionBusy"
                @click="submitResolution(true)">Отозвать полномочия</button>
              <button v-else-if="resolution?.writable && managed.length && !resolutionForm" class="btn" type="button"
                @click="editResolution">Передать оператору</button>
            </div>
            <form v-if="resolutionForm" class="rename-form" @submit.prevent="submitResolution()">
              <label>Запуск
                <select v-model="resolutionRun" required>
                  <option v-for="row in managed" :key="row.id" :value="row.id">{{ row.label }}</option>
                </select>
              </label>
              <label>Правило закрытия
                <select v-model="resolutionRule">
                  <option value="verdict">Архивировать после записанного вердикта</option>
                  <option value="negative">Отклонить по результату связанного запуска</option>
                </select>
              </label>
              <template v-if="resolutionRule === 'negative'">
                <label>Slug связанного запуска
                  <input v-model="evidenceSlug" :list="'resolution-evidence-' + task.id" required />
                  <datalist :id="'resolution-evidence-' + task.id">
                    <option v-for="slug in possibleEvidence" :key="slug" :value="slug" />
                  </datalist>
                </label>
                <label>Точная фраза из итогового отчёта
                  <input v-model="evidencePhrase" minlength="12" maxlength="400" required />
                </label>
              </template>
              <div class="actions">
                <button class="btn journal-primary" :disabled="resolutionBusy || !resolutionRun">Передать</button>
                <button class="btn" type="button" :disabled="resolutionBusy" @click="resolutionForm = false">Отмена</button>
              </div>
            </form>
            <p v-if="resolutionError" class="journal-error" role="alert">{{ resolutionError }}</p>
          </section>
          <ol class="timeline">
            <li v-if="isAnalyzing" class="event operator-event" role="status">Mini разбирает задачу…</li>
            <li v-for="entry in visibleEntries" :key="entry.id" class="event" :class="{ 'operator-event': entry.reference }">
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
              <details v-else-if="entry.reference" class="event-details operator-details" :open="entry.id === visibleEntries[0]?.id">
                <summary>{{ entry.title }} <small v-if="entry.handoff" class="handoff">↳ {{ entry.handoff }}</small></summary>
                <p v-if="entry.text" class="event-text">{{ entry.text }}</p>
                <div class="event-links">
                  <button v-if="entry.evidence" type="button" class="btn" @click="emit('evidence', entry.evidence)">Открыть связанный запуск</button>
                  <button v-if="chatEnabled" type="button" class="btn"
                    @click="chat?.discuss(entry.reference, labels.get(entry.reference) ?? entry.title)">Обсудить событие</button>
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
          <p v-else-if="!visibleEntries.length" class="muted">В журнале пока нет событий.</p>
          <details v-if="!operatorOnly && run?.timeline.length" class="system-events">
            <summary>Системные события запуска</summary>
            <ul>
              <li v-for="(event, index) in run.timeline" :key="index">
                <time :datetime="new Date(event.at * 1000).toISOString()">{{ formatClock(event.at, now) }}</time>
                <span>{{ event.text }}</span>
              </li>
            </ul>
          </details>
        </details>
      </div>
    </div>
  </section>
</template>

<style scoped>
.resolution-controls { margin-bottom: 12px; }
.resolution-controls select { font: inherit; }
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
  container: project-summary / inline-size;
  padding: 20px clamp(12px, 2.4vw, 42px) 40px;
  overflow-wrap: anywhere;
}
.journal-page h1, .journal-page h2, .journal-page h3, .journal-page p, .journal-page ul, .journal-page ol, .journal-page dl, .journal-page dd { margin: 0; }
.journal-page h2 { font-size: 17px; line-height: 1.3; }
.journal-page h3 { font-size: 14px; line-height: 1.35; }
.breadcrumb, .heading-title, .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.breadcrumb { margin-bottom: 15px; color: var(--muted); font-size: 13px; }
.history-mark { border-left: 1px solid var(--border); padding-left: 10px; }
.journal-heading { padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.source-name { color: var(--muted); font-size: 12px; margin-bottom: 4px !important; }
.heading-title h1 { font-size: clamp(24px, 4vw, 36px); font-weight: 675; line-height: 1.15; letter-spacing: -.04em; }
.journal-page .task-description { color: var(--muted); max-width: 75ch; margin-top: 7px; font-size: 14px; line-height: 1.5; }
.rename-button { align-self: center; }
.rename-form { display: grid; gap: 8px; max-width: 440px; margin-top: 12px; }
.rename-form label { display: grid; gap: 4px; font-size: 13px; }
.rename-form input { width: 100%; }
.task-status { padding: 4px 10px; border-radius: 100px; background: var(--surface); border: 1px solid var(--border); font-size: 12px; font-weight: 600; }
.task-status[data-status="needs_input"], .task-status[data-status="blocked"] { background: var(--warn-soft); color: var(--warn); }
.task-status:is([data-status="active"], [data-status="ready"], [data-status="done"]) { background: var(--journal-operator); color: var(--journal-accent); }
.blocker-source { font-size: 12px; }
.journal-summary > details > summary { cursor: pointer; }
.journal-summary > details > ul { padding-inline-start: 20px; }
.journal-layout { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-areas: "summary" "context" "operator" "history"; align-items: start; gap: 14px; margin-top: 16px; }
.journal-summary { grid-area: summary; min-width: 0; }
.journal-context { grid-area: context; display: grid; gap: 12px; min-width: 0; }
.journal-side { grid-area: operator; min-width: 0; }
.journal-main { grid-area: history; min-width: 0; border-top: 1px solid var(--border); }
.history-summary { padding: 10px 0; cursor: pointer; }
.history-summary span { margin-inline-start: 8px; font-size: 12px; }
.section-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.journal-filter, .event-links { display: flex; flex-wrap: wrap; gap: 5px; }
.journal-filter .btn[aria-pressed="true"] { background: var(--journal-operator); color: var(--journal-accent); border-color: var(--journal-operator-line); }
.resolution-controls { margin-top: 10px; }
.timeline { list-style: none; padding: 0; margin-top: 12px !important; }
.event { position: relative; display: grid; gap: 5px; padding: 0 0 16px 16px; margin-left: 4px; border-left: 1px solid var(--border-strong); }
.event:last-child { padding-bottom: 5px; }
.event::before { content: ""; position: absolute; top: 5px; left: -4px; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.operator-event::before { background: var(--journal-accent); }
.event-meta { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 10px; font-size: 12px; }
.event-meta time, .system-events time { color: var(--muted); font-variant-numeric: tabular-nums; }
.operator-details[open] { padding: 9px 11px; background: var(--journal-operator); border: 1px solid var(--journal-operator-line); border-radius: 8px; }
.handoff { color: var(--muted); font-weight: normal; }
.event-links:not(:empty) { margin-top: 7px; }
.journal-primary { background: var(--journal-accent); color: light-dark(#fff, #193329); border-color: var(--journal-accent); }
.journal-primary:hover:not(:disabled) { filter: brightness(.94); background: var(--journal-accent); }
.event-text, .report-text { font-size: 14px; line-height: 1.55; white-space: pre-wrap; }
.event-details summary, .system-events summary { cursor: pointer; font-weight: 600; }
.event-details .event-text, .report-text { margin-top: 6px; }
.report-text p + p { margin-top: 8px; }
.report-facts { display: flex; gap: 4px 12px; flex-wrap: wrap; list-style: none; padding: 4px 0 0; color: var(--muted); font-size: 12px; }
.passed { color: var(--journal-accent); }
.system-events { border-top: 1px solid var(--border); padding: 9px 0 0; margin-top: 8px; }
.system-events ul, .pull-list { list-style: none; padding: 0; }
.system-events li { display: grid; grid-template-columns: minmax(80px, auto) 1fr; gap: 10px; padding: 5px 0; font-size: 12px; }
.links { display: grid; gap: 7px; border-top: 1px solid var(--border); padding-block: 10px; }
.links small { color: var(--muted); }
.pull-list li + li { margin-top: 3px; }
.pull-list li { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 8px; }
.pull-list a, .links p { font-size: 13px; }
.journal-error { color: var(--bad); }
@container project-summary (min-width: 680px) {
  .journal-layout {
    grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
    grid-template-areas: "summary context" "history context";
    grid-template-rows: auto 1fr;
    gap: 16px clamp(16px, 2cqi, 34px);
  }
  .journal-layout:has(> .journal-side) {
    grid-template-areas: "summary operator" "context operator" "history operator";
    grid-template-rows: auto auto 1fr;
  }
}
@container project-summary (min-width: 960px) {
  .journal-layout:has(> .journal-side) {
    grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr);
    grid-template-areas: "summary context operator" "history context operator";
    grid-template-rows: auto 1fr;
  }
  .journal-context { border-inline-start: 1px solid var(--border); padding-inline-start: clamp(13px, 1.4cqi, 23px); }
}
@media (min-height: 750px) {
  @container project-summary (min-width: 960px) {
    .journal-side { position: sticky; top: 12px; }
  }
}
</style>
