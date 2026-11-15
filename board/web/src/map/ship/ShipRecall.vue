<script setup lang="ts">
// «Остановить ход» and «Убрать задачу» with their confirmation on the screen itself and «оставить ветку». «Другие
// действия» and the block of a ship with a verdict share it: each place asks on its own and shows the outcome of its
// own order; «оставить ветку» is one for the ship. A board that only reads copies the equal command.
import { computed, ref, watch } from "vue";
import type { TaskSummary } from "../../types";
import CopiedNote from "../station/CopiedNote.vue";
import type { ShipDesk } from "./desk";
import { stopConfirm } from "./orders";

const props = withDefaults(
  defineProps<{
    task: TaskSummary;
    desk: ShipDesk;
    stop?: boolean;
    clean?: boolean;
    /** How «Убрать задачу» looks: the block's main button, a plain one beside the PR, or a danger among the orders. */
    look?: "main" | "plain" | "danger";
  }>(),
  { stop: false, clean: false, look: "danger" },
);

const group = computed(() => props.desk.groups.recall);
const busy = computed(() => !!group.value.busy);
const confirming = ref<"stop" | "clean" | null>(null);
/** This place sent the last order: its outcome shows here. */
const asked = ref(false);
const CONFIRM = computed(() => ({
  stop: stopConfirm(props.desk.queued.value?.waiting.length ?? 0),
  clean: "Списать: удалить worktree и запись задачи.",
}));

async function recall() {
  const what = confirming.value;
  if (!what) return;
  const slug = props.task.slug;
  asked.value = true;
  if (what === "stop") await props.desk.stop();
  else await props.desk.clean(props.desk.keepBranch.value);
  // Another ship opened meanwhile keeps its own confirmation.
  if (props.task.slug === slug) confirming.value = null;
}

watch(
  () => props.task.slug,
  () => {
    confirming.value = null;
    asked.value = false;
  },
);
</script>

<template>
  <div class="row" :aria-busy="busy">
    <slot />
    <button v-if="stop" type="button" class="key danger" :disabled="busy" @click="confirming = 'stop'">Остановить ход</button>
    <button v-if="clean" type="button" class="key" :class="{ main: look === 'main', danger: look === 'danger' }" :disabled="busy" @click="confirming = 'clean'">Убрать задачу</button>
    <label v-if="clean" class="check"><input v-model="desk.keepBranch.value" type="checkbox" /> оставить ветку</label>
  </div>
  <div v-if="confirming" class="confirm" role="alertdialog" aria-label="Подтверждение" @keydown.esc.stop="confirming = null">
    <span>{{ CONFIRM[confirming] }}</span>
    <button type="button" class="key danger" :disabled="busy" @click="recall">{{ group.busy ? "Выполняю…" : "Да" }}</button>
    <button type="button" class="key" :disabled="busy" @click="confirming = null">Отмена</button>
  </div>
  <template v-if="asked">
    <p v-if="group.done" class="result ok" role="status" :title="group.output">{{ group.done }}</p>
    <p v-if="group.error" class="result bad" role="alert">{{ group.error }}</p>
    <CopiedNote v-if="group.copied" :copied="group.copied" />
  </template>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--sh-dim);
  font-size: 12px;
}

.confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid rgba(255, 141, 122, 0.45);
  border-radius: 8px;
  background: rgba(255, 141, 122, 0.07);
  font-size: 12px;
}

.confirm span {
  flex: 1 1 180px;
}
</style>
