<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { detachedName, statusLabels, type ProjectTask, type ProjectTaskChange } from "../lib/projectTasks";

const props = defineProps<{
  task: ProjectTask | null;
  project: string;
  projects: string[];
  tasks: ProjectTask[];
  sessions: ReadonlyMap<string, string>;
  writable: boolean;
  save: (change: ProjectTaskChange) => Promise<ProjectTask>;
}>();
const emit = defineEmits<{ close: []; saved: [task: ProjectTask] }>();

// Only an explicit edit starts a draft. Background reads can refresh the available choices.
const original = props.task;
const draft = reactive({
  project: original?.project ?? props.project,
  title: original?.title ?? "",
  status: original?.status ?? "active",
  parent_id: original?.parent_id ?? null,
  depends_on: [...(original?.depends_on ?? [])],
  sessions: [...(original?.sessions ?? [])],
  pull_requests: (original?.pull_requests ?? []).map((pr) => ({ ...pr })),
});
const error = ref("");
const saving = ref(false);
const titleField = ref<HTMLInputElement | null>(null);
onMounted(() => titleField.value?.focus());

const taskChoices = computed(() => new Map(props.tasks.filter((task) => task.id !== original?.id)
  .map((task) => [task.id, `${task.title} · ${task.project}`])));
const groups = computed(() => [
  { field: "depends_on", label: "Блокирующие задания", add: "Добавить предпосылку", choices: taskChoices.value },
  { field: "sessions", label: "Запуски и сессии", add: "Добавить запуск или сессию", choices: props.sessions },
] as const);

function addLink(links: string[], event: Event) {
  const select = event.currentTarget as HTMLSelectElement;
  if (select.value) links.push(select.value);
  select.value = "";
}

const change = computed<ProjectTaskChange>(() => {
  const fields = {
    project: draft.project.trim(), title: draft.title.trim(), status: draft.status, parent_id: draft.parent_id,
    depends_on: [...draft.depends_on], sessions: [...draft.sessions],
    pull_requests: draft.pull_requests.map(({ provider, url }) => ({ provider, url: url.trim() })),
  };
  if (!original) return fields;
  const edited = Object.entries(fields).filter(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify(original[key as keyof typeof fields]));
  return { id: original.id, ...Object.fromEntries(edited) };
});
async function submit() {
  if (!props.writable || saving.value || !draft.title.trim() || !draft.project.trim()) return;
  saving.value = true;
  error.value = "";
  try {
    emit("saved", await props.save(change.value));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="editor" aria-labelledby="editor-heading" @submit.prevent="submit" @keydown.esc.stop="!saving && emit('close')">
    <fieldset :disabled="saving || !writable">
      <header>
        <h2 id="editor-heading">{{ original ? "Изменить задание" : "Новое задание" }}</h2>
        <button type="button" class="btn" aria-label="Закрыть форму" @click="emit('close')">×</button>
      </header>
      <label>Название<input ref="titleField" v-model="draft.title" maxlength="200" required /></label>
      <label>Проект
        <input v-model="draft.project" list="project-names" maxlength="255" placeholder="Выберите или введите название" required />
        <datalist id="project-names"><option v-for="name in projects" :key="name" :value="name" /></datalist>
      </label>
      <label>Статус
        <select v-model="draft.status">
          <option v-for="(label, value) in statusLabels" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label>Родительское задание
        <select v-model="draft.parent_id">
          <option :value="null">Без родительского задания</option>
          <option v-for="[id, name] in taskChoices" :key="id" :value="id">{{ name }}</option>
        </select>
      </label>
      <div v-for="group in groups" :key="group.field" class="links">
        <label>{{ group.label }}
          <select @change="addLink(draft[group.field], $event)">
            <option value="">{{ group.add }}</option>
            <option v-for="[id, name] in group.choices" :key="id" :value="id" :disabled="draft[group.field].includes(id)">{{ name }}</option>
          </select>
        </label>
        <div v-for="(id, index) in draft[group.field]" :key="id" class="link-row">
          <span>{{ group.choices.get(id) ?? detachedName(id) }}</span>
          <button type="button" class="btn" :aria-label="`Убрать: ${group.choices.get(id) ?? id}`" @click="draft[group.field].splice(index, 1)">Убрать</button>
        </div>
      </div>
      <div class="links">
        <header>
          <strong>Пул-реквесты</strong>
          <button type="button" class="btn" @click="draft.pull_requests.push({ provider: 'github', url: '' })">Добавить PR</button>
        </header>
        <div v-for="(pr, index) in draft.pull_requests" :key="index" class="pr-row">
          <select v-model="pr.provider" :aria-label="`Сервис PR ${index + 1}`">
            <option value="github">GitHub</option><option value="forgejo">Forgejo</option>
          </select>
          <input v-model="pr.url" type="url" required pattern="https?://.+" placeholder="https://…" :aria-label="`Ссылка на PR ${index + 1}`" />
          <button type="button" class="btn" :aria-label="`Убрать PR ${index + 1}`" @click="draft.pull_requests.splice(index, 1)">×</button>
        </div>
      </div>
      <p v-if="error" role="alert">Не удалось сохранить задание. {{ error }}</p>
      <footer>
        <button v-if="writable" type="submit" class="btn primary" :disabled="!draft.project.trim() || !draft.title.trim() || (!!original && Object.keys(change).length === 1)">
          {{ saving ? "Сохранение…" : original ? "Сохранить" : "Создать задание" }}
        </button>
        <button type="button" class="btn" @click="emit('close')">Отмена</button>
      </footer>
    </fieldset>
    <p v-if="!writable">Только чтение <button type="button" class="btn" @click="emit('close')">Закрыть</button></p>
  </form>
</template>

<style scoped>
fieldset { display: grid; gap: 12px; min-width: 0; padding: 0; margin: 0; border: 0; }
header, footer, .link-row, .pr-row { display: flex; align-items: center; gap: 8px; }
header, .link-row { justify-content: space-between; }
h2 { margin: 0; font-size: 17px; }
label, .links { display: grid; gap: 5px; min-width: 0; }
label, strong { font-weight: 600; }
input, select {
  width: 100%;
  min-width: 0;
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
  font-weight: 400;
}
.link-row { padding: 4px 6px; background: var(--surface-3); overflow-wrap: anywhere; }
.link-row button, .pr-row button { flex: none; }
.pr-row select { width: auto; }
[role="alert"] { margin: 0; color: var(--bad); }
footer { padding-top: 6px; border-top: 1px solid var(--border); }
</style>
