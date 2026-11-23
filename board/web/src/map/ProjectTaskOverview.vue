<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { BoardSource } from "../lib/source";
import type { ProjectTaskOverview } from "../operatorActivity";

const props = defineProps<{
  card: string;
  overview?: ProjectTaskOverview | null;
  hasContext: boolean;
  enabled: boolean;
  source: BoardSource;
  refresh: () => Promise<void>;
}>();
const busy = ref(false);
const error = ref("");
const canRequest = computed(() => props.enabled && props.hasContext && !!props.source.requestProjectOverview);
const pending = computed(() => busy.value || props.overview?.status === "pending");

async function request(refresh: boolean) {
  if (!canRequest.value || pending.value || !props.source.requestProjectOverview) return;
  busy.value = true;
  error.value = "";
  try {
    await props.source.requestProjectOverview(props.card, refresh);
    await props.refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

watch(canRequest, (ready) => {
  if (ready && !props.overview && !error.value) void request(false);
}, { immediate: true });
</script>

<template>
  <section class="task-overview" aria-labelledby="journal-overview">
    <div class="overview-heading">
      <h2 id="journal-overview">О задаче</h2>
      <button v-if="canRequest && overview?.change && !pending && !error && overview.status !== 'failed'"
        type="button" class="btn" @click="request(true)">
        Обновить описание
      </button>
    </div>
    <dl v-if="overview?.change" class="overview-fields">
      <div><dt>Что меняем</dt><dd>{{ overview.change }}</dd></div>
      <div><dt>Зачем</dt><dd>{{ overview.why }}</dd></div>
      <div><dt>Ожидаемый результат</dt><dd>{{ overview.expected }}</dd></div>
    </dl>
    <p v-if="pending" role="status" class="muted">{{ overview?.change ? "Обновляю описание…" : "Готовлю краткое описание…" }}</p>
    <p v-else-if="error || overview?.status === 'failed'" role="alert" class="overview-error">
      {{ error || "Не удалось подготовить описание." }}
      <button v-if="canRequest" type="button" class="btn" @click="request(true)">Повторить</button>
    </p>
    <p v-else-if="!overview?.change" class="muted">
      {{ hasContext ? "Краткое описание пока недоступно." : "Для описания нужна постановка задачи или отчёт исполнителя." }}
    </p>
  </section>
</template>

<style scoped>
.task-overview { margin-top: 18px; padding: clamp(14px, 2.4vw, 22px); display: grid; gap: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.task-overview :is(h2, p, dl, dd) { margin: 0; }
.overview-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 6px 10px; }
.overview-heading h2 { font-size: 18px; line-height: 1.3; }
.overview-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 20px; }
.overview-fields dt { margin-bottom: 4px; font-size: 13px; font-weight: 650; color: var(--journal-accent); }
.overview-fields dd, .task-overview p { font-size: 14px; line-height: 1.55; }
.overview-error { color: var(--bad); }
@media (max-width: 700px) {
  .overview-fields { grid-template-columns: minmax(0, 1fr); }
}
</style>
