<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { isCurrent, recordLabel, sessionNames } from "../lib/projectTasks";
import type { Board } from "../store/board";
import type { OperatorTarget } from "../operatorActivity";
import type { Login } from "../types";
import AccountView from "./account/AccountView.vue";
import AddSubscription from "./account/AddSubscription.vue";
import OpenCodeAccount from "./account/OpenCodeAccount.vue";
import frameLight from "./art/frame-light.png";
import MapConsole from "./console/MapConsole.vue";
import DaySummary from "./DaySummary.vue";
import { stars, tanks } from "./fleet";
import ProjectTaskMap from "./ProjectTaskMap.vue";
import { research } from "./research";
import ShipView from "./ship/ShipView.vue";
import StationView from "./station/StationView.vue";
import { useArrivalChime } from "./use/useArrivalChime";
import { useMapSources } from "./use/useMapSources";
import { useProjectTasks } from "./use/useProjectTasks";

const props = defineProps<{ board: Board; active: boolean; machine?: string | null; operatorTaskId?: string; operatorProjects?: string[] }>();
const emit = defineEmits<{ machine: [id: string, opener: HTMLElement | null]; panel: []; askOperator: [target: OperatorTarget] }>();
const board = props.board;
const { data, error, refresh, save } = useProjectTasks(board, () => props.active);
const sources = useMapSources(props);
const { now, tasks, emblemOf, researchView, loadResearch } = sources;
const { sound } = useArrivalChime(sources);
const counts = computed(() => stars(tasks.value));
const subscriptions = computed(() => tanks(board.state.value.accounts?.data ?? null, now.value));
const station = computed(() => research(researchView.value, board.tasks.value, counts.value.map((repo) => repo.repo)));
watch(() => station.value?.running, (running, was) => {
  if (was && !running) void loadResearch();
});
const readOnly = computed(() => data.value ? !data.value.writable : !researchView.value || researchView.value.actions?.reason === "read_only");
const subscriptionsReadOnly = computed(() => import.meta.env.MODE === "fixture" || readOnly.value);

const query = matchMedia("(max-width: 760px)");
const narrow = ref(query.matches);
const logOpen = ref(false);
function resize() {
  narrow.value = query.matches;
  logOpen.value = false;
}
onMounted(() => query.addEventListener("change", resize));
onBeforeUnmount(() => query.removeEventListener("change", resize));

const map = ref<InstanceType<typeof ProjectTaskMap> | null>(null);
function taskForRun(id?: string) {
  return id ? data.value?.tasks.find((task) => task.sessions.includes(id)) : undefined;
}
const operatorSite = computed(() => taskForRun(props.operatorTaskId)?.id);
const consolePanel = ref<InstanceType<typeof MapConsole> | null>(null);
const toolsOpen = ref(false);
const projects = computed(() => new Set(data.value?.tasks.filter(isCurrent).map((task) => task.project)));
const sessions = computed(() => sessionNames(data.value?.tasks ?? [], board.tasks.value));
type RecordTarget = string | { taskId: string; sessionId: string };
const recordTarget = ref<RecordTarget | null>(null);
const linkedTask = computed(() => {
  const target = recordTarget.value;
  if (!target) return;
  return data.value?.tasks.find((task) => typeof target === "string"
    ? Object.values(task.session_slugs).includes(target) : task.id === target.taskId);
});
const record = computed(() => {
  const target = recordTarget.value;
  return target && (typeof target === "string" ? target : linkedTask.value?.session_slugs[target.sessionId]);
});
const recordTask = computed(() => record.value ? board.state.value.tasks[record.value] ?? null : null);
const researchOpen = ref(false);
const summaryOpen = ref(false);
const account = ref<string | null>(null);
const initialLogin = ref<Login | null>(null);
const addOpener = ref<HTMLElement | null>(null);
let recordOpener: HTMLElement | null = null;
let accountOpener: HTMLElement | null = null;
let researchOpener: HTMLElement | null = null;

function openOperatorTask(id: string) {
  const task = taskForRun(id);
  if (!task || !map.value) return false;
  recordTarget.value = account.value = null;
  researchOpen.value = false;
  map.value.select(task.id, true);
  return true;
}
defineExpose({ openOperatorTask });

function openRecord(target: RecordTarget) {
  recordOpener = document.activeElement as HTMLElement | null;
  recordTarget.value = target;
  emit("panel");
}
function pickRecord(event: Event) {
  const picker = event.currentTarget as HTMLSelectElement;
  if (picker.value) openRecord(picker.value);
  picker.value = "";
}
function closeRecord() {
  recordTarget.value = null;
  void nextTick(() => recordOpener?.focus());
}
function showLinkedTask() {
  const task = linkedTask.value;
  if (!task) return;
  recordTarget.value = account.value = null;
  researchOpen.value = false;
  map.value?.select(task.id, true);
}
function openAgent(slug: string, project: string) {
  if (board.state.value.tasks[slug] || !projects.value.has(project)) return openRecord(slug);
  researchOpen.value = false;
  map.value?.focusProject(project);
}
function openResearch() {
  researchOpener = document.activeElement as HTMLElement | null;
  account.value = recordTarget.value = null;
  researchOpen.value = true;
  emit("panel");
}
function closeResearch() {
  researchOpen.value = false;
  void nextTick(() => researchOpener?.focus());
}
function openAccount(key: string, opener: HTMLElement | null, login?: Login) {
  recordTarget.value = null;
  researchOpen.value = false;
  initialLogin.value = login ?? null;
  account.value = key;
  accountOpener = opener;
  emit("panel");
}
function closeAccount() {
  account.value = null;
  void nextTick(() => accountOpener?.focus());
}
function finishAdd(key: string, login?: Login) {
  openAccount(key, addOpener.value, login);
  addOpener.value = null;
}
function closeAdd() {
  const opener = addOpener.value;
  addOpener.value = null;
  void nextTick(() => opener?.focus());
}
function closeSummary() {
  summaryOpen.value = false;
  void nextTick(() => consolePanel.value?.summaryButton?.focus());
}
watch([() => props.active, () => props.machine], ([active, machine]) => {
  if (active && !machine) return;
  recordTarget.value = account.value = addOpener.value = null;
  researchOpen.value = summaryOpen.value = false;
});
</script>

<template>
  <section class="map" aria-label="Карта заданий">
    <ProjectTaskMap ref="map" :data="data" :error="error" :sessions="sessions" :save="save" :operator-site="operatorSite"
      :records="board.state.value.tasks" :fetch-details="board.source.fetchProjectTaskDetails"
      :fetch-scout-history="board.source.fetchScoutHistory" :operator-projects="operatorProjects"
      @ask-operator="emit('askOperator', $event)"
      @record="(taskId, sessionId) => openRecord({ taskId, sessionId })" @scout="openRecord"
      @retry="refresh" @panel="emit('panel')">
      <button type="button" class="btn tools-toggle" :aria-expanded="toolsOpen" aria-controls="map-tools"
        title="Запуски и сессии, дежурный, подписки, машины и рефлексия" @click="toolsOpen = !toolsOpen">Инструменты</button>
    </ProjectTaskMap>
    <section v-if="toolsOpen" id="map-tools" aria-label="Инструменты доски">
      <select class="btn record-picker" aria-label="Открыть запуск или сессию" @change="pickRecord">
        <option value="" disabled selected>Запуски и сессии</option>
        <option v-for="item in board.tasks.value" :key="item.slug" :value="item.slug">{{ recordLabel(item) }}</option>
      </select>
      <MapConsole ref="consolePanel" v-model:log-open="logOpen" v-model:summary-open="summaryOpen" v-model:sound="sound"
        :frame="frameLight" :now="now" :tanks="subscriptions" :stars="counts" :machines="board.state.value.machines"
        :machine="machine ?? null" :account="account" :station="station" :research-open="researchOpen"
        :log-events="board.events.value" :events-error="board.eventsError.value" :emblem-of="emblemOf"
        :narrow="narrow" :tasks="tasks" :projects="projects" :host="board" :read-only="readOnly"
        @project="map?.focusProject($event)" @task="openRecord"
        @open-account="openAccount" @add-subscription="addOpener = $event"
        @machine="(id, opener) => emit('machine', id, opener)" @open-research="openResearch" />
    </section>

    <StationView v-if="researchOpen && active && station" :research="station" :now="now" :frame="frameLight"
      :covered="!!record || !!machine" :source="board.source" :refresh="loadResearch" :tasks="board.state.value.tasks"
      :launches="board.state.value.launches" @close="closeResearch" @open="openRecord" @ship="openAgent" />
    <OpenCodeAccount v-if="active && account?.startsWith('opencode:')" :provider="account.slice('opencode:'.length)"
      :accounts="board.state.value.accounts" :source="board.source" :read-only="subscriptionsReadOnly" :frame="frameLight"
      @close="closeAccount" />
    <AccountView v-else-if="account && active" :key="account" :account-key="account" :initial-login="initialLogin" :read-only="readOnly"
      :covered="!!record || !!machine" :accounts="board.state.value.accounts" :logins="board.state.value.logins"
      :tasks="board.state.value.tasks" :source="board.source" :now="now" :frame="frameLight"
      @close="closeAccount" @open="openRecord" />
    <ShipView v-if="record && active" :slug="record" :task="recordTask" :opencode="board.state.value.accounts?.opencode"
      :source="board.source" :now="now" :frame="frameLight" :emblem="emblemOf(recordTask?.repo ?? null)"
      :map-task-title="linkedTask?.title" @close="closeRecord" @show="showLinkedTask" @task="board.put" />
    <DaySummary v-if="summaryOpen && active" :source="board.source" :events="board.events.value" :frame="frameLight" @close="closeSummary" />
    <AddSubscription v-if="addOpener && active" :source="board.source" :read-only="subscriptionsReadOnly"
      :accounts="board.state.value.accounts" @open="finishAdd" @close="closeAdd" />
  </section>
</template>

<style scoped>
.map { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.tools-toggle { margin-inline-start: auto; }
#map-tools { flex: none; background: var(--surface); }
#map-tools > .console { position: relative; }
.record-picker { margin: 5px 12px; max-width: calc(100% - 24px); }
</style>
