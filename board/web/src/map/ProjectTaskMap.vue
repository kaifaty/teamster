<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { prLabel } from "../lib/labels";
import { detachedName, isCurrent, recordLabel, statusLabels, type ProjectTask, type ProjectTaskChange, type ProjectTaskDetails, type ProjectTasks } from "../lib/projectTasks";
import ProjectTaskForm from "./ProjectTaskForm.vue";
import ProjectTaskSurface from "./surface/ProjectTaskSurface.vue";
import { stateOf } from "./ship/bridge";
import type { TaskSummary } from "../types";

const props = defineProps<{
  data: ProjectTasks | null;
  error: string;
  sessions: ReadonlyMap<string, string>;
  records: Readonly<Record<string, TaskSummary>>;
  fetchDetails?: (id: string) => Promise<ProjectTaskDetails | null>;
  save: (change: ProjectTaskChange) => Promise<ProjectTask>;
}>();
const emit = defineEmits<{ record: [taskId: string, sessionId: string]; panel: []; retry: [] }>();
const surface = ref<InstanceType<typeof ProjectTaskSurface> | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const picker = ref<HTMLSelectElement | null>(null);
const createButton = ref<HTMLButtonElement | null>(null);
const editButton = ref<HTMLButtonElement | null>(null);
const project = ref("");
const selectedId = ref<string | null>(null);
const editor = shallowRef<{ task: ProjectTask | null; project: string } | null>(null);
const tasks = computed(() => props.data?.tasks ?? []);
const byId = computed(() => new Map(tasks.value.map((task) => [task.id, task])));
const selected = computed(() => selectedId.value ? byId.value.get(selectedId.value) : undefined);
const current = computed(() => tasks.value.filter(isCurrent));
const projects = computed(() => [...new Set([...Object.keys(props.data?.biomes ?? {}), ...tasks.value.map((task) => task.project)])].sort());
const choices = computed(() => {
  const groups = new Map<string, ProjectTask[]>();
  for (const task of current.value) {
    const group = groups.get(task.project);
    if (group) group.push(task);
    else groups.set(task.project, [task]);
  }
  return groups;
});
const dependencies = computed(() => {
  const task = selected.value;
  if (!task) return [];
  return [
    { heading: "Зависит от", rows: task.depends_on.map((id) => ({ id, task: byId.value.get(id) })) },
    { heading: "Зависят от этого задания", rows: tasks.value.filter((other) => other.depends_on.includes(task.id))
      .map((other) => ({ id: other.id, task: other })) },
  ];
});
const details = shallowRef<ProjectTaskDetails | null>(null);
const loadingDetails = ref(false);
watch(() => {
  const task = selected.value;
  return task && !editor.value && (task.sessions.length || task.pull_requests.length)
    ? JSON.stringify([task.id, task.sessions, task.session_slugs, task.pull_requests]) : "";
}, (key, _, onCleanup) => {
  details.value = null;
  loadingDetails.value = false;
  if (!key || !selected.value || !props.fetchDetails) return;
  let current = true;
  onCleanup(() => { current = false; });
  loadingDetails.value = true;
  void props.fetchDetails(selected.value.id).then((result) => {
    if (current) details.value = result;
  }, () => {
    if (current) details.value = null;
  }).finally(() => {
    if (current) loadingDetails.value = false;
  });
});
const sessionBadgeTone = { work: "", ready: "ok", bad: "bad", wait: "warn", sleep: "warn", dim: "muted" };
const linked = computed(() => {
  const task = selected.value;
  return task?.sessions.map((id) => {
    const slug = task.session_slugs[id];
    const live = slug ? props.records[slug] : undefined;
    const fetched = details.value?.sessions[id];
    const record = live && (!fetched || live.created === fetched.created) ? live : fetched;
    return {
      id, slug, name: record ? recordLabel(record) : props.sessions.get(id) ?? detachedName(id),
      state: record ? stateOf(record) : null,
    };
  }) ?? [];
});
const prLabels = {
  draft: { text: "Черновик", tone: "warn" },
  open: { text: "Открыт", tone: "muted" },
  merged: { text: "Влит", tone: "ok" },
  closed: { text: "Закрыт", tone: "muted" },
};
const pulls = computed(() => selected.value?.pull_requests.map((pr) => {
  const state = details.value?.pull_requests[pr.url];
  return { ...pr, badge: state ? prLabels[state] : null };
}) ?? []);

function select(id: string, focus = false) {
  const task = byId.value.get(id);
  if (!task) return;
  editor.value = null;
  selectedId.value = task.id;
  project.value = task.project;
  emit("panel");
  void nextTick(() => {
    surface.value?.focusTask(id, !focus);
    closeButton.value?.focus({ preventScroll: true });
  });
}
function edit(task: ProjectTask | null) {
  if (!props.data?.writable) return;
  editor.value = { task, project: task?.project ?? project.value };
  emit("panel");
}
function closeEditor() {
  const creating = !editor.value?.task;
  editor.value = null;
  void nextTick(() => (creating ? createButton.value : editButton.value)?.focus());
}
function closeCard() {
  selectedId.value = null;
  void nextTick(() => picker.value?.focus());
}
function focusProject(name: string) {
  project.value = name;
  editor.value = null;
  selectedId.value = null;
  void nextTick(() => surface.value?.focusProject(name));
}
function saved(task: ProjectTask) {
  select(task.id, !editor.value?.task);
}
defineExpose({ select, focusProject });
</script>

<template>
  <div class="project-map">
    <div class="tools">
      <label>
        <span class="visually-hidden">Задание</span>
        <select ref="picker" class="btn" :disabled="!current.length"
          :value="selected && isCurrent(selected) ? selected.id : ''" @change="select(($event.target as HTMLSelectElement).value, true)">
          <option disabled value="">Выбрать задание</option>
          <optgroup v-for="[name, members] in choices" :key="name" :label="name">
            <option v-for="task in members" :key="task.id" :value="task.id">{{ task.title }}</option>
          </optgroup>
        </select>
      </label>
      <button v-if="data?.writable" ref="createButton" type="button" class="btn primary" @click="edit(null)">Новое задание</button>
      <span v-else-if="data" class="muted">Только чтение</span>
      <slot />
    </div>

    <div class="terrain">
      <ProjectTaskSurface v-if="data" ref="surface" :tasks="tasks" :selected-id="selectedId" :biomes="data.biomes" @select="select" />
      <p v-if="error" class="map-note" role="alert">
        Не удалось обновить задания. {{ error }} <button type="button" class="btn" @click="emit('retry')">Повторить</button>
      </p>
      <p v-else-if="!data" class="map-note" role="status">Загрузка заданий…</p>

      <aside v-if="editor && data" class="task-panel">
        <ProjectTaskForm :key="editor.task?.id ?? 'new'" :task="editor.task" :project="editor.project" :projects="projects"
          :tasks="tasks" :sessions="sessions" :writable="data.writable" :save="save" @saved="saved" @close="closeEditor" />
      </aside>
      <aside v-else-if="selected" class="task-panel" aria-labelledby="selected-title" @keydown.esc.stop="closeCard">
        <header>
          <span class="muted">Задание · {{ selected.project }}</span>
          <button ref="closeButton" type="button" class="btn" aria-label="Закрыть карточку задания" @click="closeCard">×</button>
        </header>
        <h2 id="selected-title">{{ selected.title }}</h2>
        <div class="status-row">
          <span class="chip" :class="{ ok: selected.status === 'done', warn: ['needs_input', 'ready'].includes(selected.status), bad: selected.status === 'blocked' }">
            {{ statusLabels[selected.status] }}
          </span>
          <button v-if="data?.writable" ref="editButton" type="button" class="btn" @click="edit(selected)">Изменить</button>
        </div>
        <dl>
          <template v-if="selected.parent_id">
            <dt>Родительское задание</dt>
            <dd><button class="link" type="button" @click="select(selected.parent_id, true)">{{ byId.get(selected.parent_id)?.title ?? selected.parent_id }}</button></dd>
          </template>
          <template v-for="group in dependencies" :key="group.heading">
            <dt>{{ group.heading }}</dt>
            <dd v-if="!group.rows.length" class="muted">Нет</dd>
            <dd v-for="row in group.rows" :key="row.id" class="link-row">
              <div v-if="row.task">
                <button class="link" type="button" @click="select(row.id, true)">{{ row.task.title }}</button>
                <small v-if="row.task.project !== selected.project" class="muted linked-project">{{ row.task.project }}</small>
              </div>
              <span v-else class="muted">{{ row.id }}</span>
              <span class="chip muted">{{ row.task ? statusLabels[row.task.status] : "Недоступно" }}</span>
            </dd>
          </template>
          <dt>Запуски и сессии</dt>
          <dd v-if="!linked.length" class="muted">Нет связанных записей</dd>
          <dd v-for="item in linked" :key="item.id" class="link-row">
            <button v-if="item.slug" class="link" type="button" @click="emit('record', selected.id, item.id)">{{ item.name }}</button>
            <span v-else class="muted">{{ item.name }}</span>
            <span class="chip" :class="item.state ? sessionBadgeTone[item.state.tone] : 'muted'">
              {{ item.state?.text ?? (loadingDetails ? "Загрузка…" : "Статус недоступен") }}
            </span>
          </dd>
          <template v-if="pulls.length">
            <dt>Пул-реквесты</dt>
            <dd v-for="pr in pulls" :key="pr.url" class="link-row">
              <a :href="pr.url" :title="pr.url" target="_blank" rel="noopener">{{ pr.provider === "github" ? "GitHub" : "Forgejo" }} · {{ prLabel(pr.url) }} ↗</a>
              <span class="chip" :class="pr.badge?.tone ?? 'muted'">
                {{ pr.badge?.text ?? (loadingDetails ? "Загрузка…" : "Статус недоступен") }}
              </span>
            </dd>
          </template>
        </dl>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.project-map { display: flex; flex: 1; min-height: 0; flex-direction: column; }
.tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
.tools select { max-width: min(25vw, 320px); text-overflow: ellipsis; }
.terrain { position: relative; isolation: isolate; flex: 1; min-height: 0; overflow: hidden; }
.terrain > :deep(.surface) { min-height: 0; }
.project-map :deep(.btn.primary) { background: var(--codex-soft); color: var(--codex); border-color: var(--codex); }
.task-panel, .map-note {
  position: absolute; z-index: 1; background: var(--surface); color: var(--text); border: 1px solid var(--border-strong);
  border-radius: var(--radius); box-shadow: var(--shadow-panel);
}
.task-panel { top: 10px; right: 10px; width: min(360px, calc(100% - 20px)); max-height: calc(100% - 20px); overflow: auto; overscroll-behavior: contain; padding: 14px; overflow-wrap: anywhere; }
.map-note { top: 8px; left: 10px; max-width: calc(100% - 20px); margin: 0; padding: 6px 10px; }
header, .status-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
h2 { margin: 4px 0 8px; font-size: 18px; }
dl { margin: 0; }
dt { margin-top: 10px; color: var(--muted); font-size: 12px; }
dd { margin: 3px 0 0; }
.link-row { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 3px 8px; }
.link-row .chip { flex-shrink: 0; }
.linked-project { display: block; }
.link { border: 0; padding: 0; background: none; color: var(--link); cursor: pointer; text-align: start; overflow-wrap: anywhere; }
.link:hover { text-decoration: underline; }
@media (max-width: 760px) {
  .tools { padding: 5px 8px; gap: 4px; }
  .tools select { max-width: 44vw; }
  .task-panel { top: auto; bottom: 6px; right: 6px; width: min(360px, calc(100% - 12px)); max-height: calc(100% - 12px); }
  .task-panel[aria-labelledby] { max-height: 60%; }
}
</style>
