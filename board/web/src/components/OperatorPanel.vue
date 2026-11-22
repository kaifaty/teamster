<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { formatFullTime } from "../lib/format";
import type { OperatorActivity, OperatorTask } from "../operatorActivity";

const props = defineProps<{ activity: OperatorActivity; current: OperatorTask | null; connected: boolean }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ task: [task: OperatorTask] }>();
const opener = ref<HTMLButtonElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const status = computed(() => !props.connected ? "Нет связи с доской"
  : !props.activity.available ? "Журнал недоступен"
  : props.current ? `Разбирает ${props.current.title}` : "Нет активного разбора");

watch(open, (value) => {
  if (value) void nextTick(() => closeButton.value?.focus());
});
function close() {
  open.value = false;
  opener.value?.focus();
}
</script>

<template>
  <button ref="opener" type="button" class="btn operator-toggle" :aria-expanded="open"
    aria-controls="operator-panel" :title="status" @click="open = !open">
    Оператор <span class="chip" :class="{ ok: current }">Mini</span>
    <span class="ellipsis muted">{{ status }}</span>
  </button>
  <aside v-show="open" id="operator-panel" class="operator-panel" aria-labelledby="operator-heading"
    @keydown.esc.stop="close">
    <header>
      <h2 id="operator-heading">Оператор <span class="muted">· Mini</span></h2>
      <button ref="closeButton" type="button" class="btn" aria-label="Закрыть панель оператора" @click="close">×</button>
    </header>
    <p v-if="current" class="current">
      Mini разбирает <button type="button" class="task-link" @click="emit('task', current)">{{ current.title }}</button>
    </p>
    <p v-else class="muted">{{ status }}</p>
    <h3>История рекомендаций</h3>
    <ol v-if="activity.history.length" class="history">
      <li v-for="item in activity.history" :key="item.event_id">
        <button type="button" class="task-link" @click="emit('task', item)">{{ item.title }} <span aria-hidden="true">↗</span></button>
        <div class="muted metadata">
          {{ item.source === "mini" ? "Mini" : "Нужен человек" }} · Ход {{ item.turn }} ·
          <time :datetime="new Date(item.started_at * 1000).toISOString()" title="Начало разбора">{{ formatFullTime(item.started_at) }}</time>
        </div>
        <p>{{ item.recommendation }}</p>
      </li>
    </ol>
    <p v-else-if="activity.available" class="muted">Рекомендаций пока нет</p>
  </aside>
</template>

<style scoped>
.operator-toggle { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: min(100%, 340px); }
.operator-toggle .ellipsis { width: min(20vw, 170px); text-align: left; }
@media (max-width: 600px) { .operator-toggle .ellipsis { display: none; } }
.operator-panel {
  position: absolute; z-index: 30; top: calc(100% + 6px); right: 10px; width: min(420px, calc(100% - 20px));
  max-height: 70dvh; overflow: auto; padding: 14px 16px; border: 1px solid var(--border-strong);
  border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: 0 6px 24px #0004;
}
header { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: 16px; }
h3 { margin: 18px 0 4px; font-size: 13px; }
p { margin: 6px 0; overflow-wrap: anywhere; }
.current { padding: 7px 9px; border-radius: 4px; background: var(--ok-soft); }
.history { list-style: none; margin: 0; padding: 0; }
li { padding: 9px 0 4px; border-top: 1px solid var(--border); }
li p { white-space: pre-wrap; }
.metadata { font-size: 11px; }
.task-link {
  padding: 0; border: 0; background: none; color: inherit; font: inherit; font-weight: 600; text-align: left;
  text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; cursor: pointer;
}
</style>
