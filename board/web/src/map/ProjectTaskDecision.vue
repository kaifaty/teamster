<script setup lang="ts">
import { computed, ref } from "vue";
import { formatClock } from "../lib/format";
import { EXECUTORS, PHASES } from "../lib/labels";
import type { BoardSource } from "../lib/source";
import { optionLabels, type OperatorOption, type OperatorResolution, type OperatorTarget } from "../operatorActivity";
import type { TaskSummary } from "../types";

const props = defineProps<{
  heading: string;
  blocked: boolean;
  executor?: TaskSummary;
  now: number;
  target: OperatorTarget;
  source: BoardSource;
  showOptions: boolean;
  resolution: OperatorResolution | null;
  enabled: boolean;
  resolving: boolean;
  refresh: () => Promise<void>;
}>();
const emit = defineEmits<{ focusChat: [] }>();

const resolutionBusy = ref(false);
const proposal = computed(() => props.resolution?.proposals?.at(-1));
const chosen = computed(() => props.resolution?.events.find(event => event.detail.proposal === proposal.value?.id
  && event.kind === "choice")?.detail.action);
const options = computed(() => proposal.value?.options ?? []);
const primary = computed(() => options.value.find((option) => option.action === proposal.value?.recommended) ?? options.value[0]);
const alternatives = computed(() => options.value.filter((option) => option !== primary.value));
const canAsk = computed(() => props.enabled && props.resolution?.writable && !!props.source.askOperator);
const canChoose = computed(() => props.resolution?.writable && !!props.source.setOperatorResolution);
const analyzing = ref(false);
const proposalError = ref("");

async function askForDecision() {
  if (!props.source.askOperator || analyzing.value) return;
  analyzing.value = true;
  proposalError.value = "";
  const history = (props.resolution?.chat ?? []).filter(row => row.answer).slice(-2).map(row => ({
    question: row.question.slice(0, 800), answer: (row.answer ?? "").slice(0, 800),
  }));
  try {
    await props.source.askOperator("Проверь текущую причину остановки и предложи дальнейшие действия.",
      props.target, history, undefined, true);
    await props.refresh();
  } catch (error) {
    proposalError.value = error instanceof Error ? error.message : String(error);
    await props.refresh();
  } finally {
    analyzing.value = false;
  }
}

async function chooseOption(action: OperatorOption) {
  if (!props.source.setOperatorResolution || !proposal.value || resolutionBusy.value) return;
  resolutionBusy.value = true;
  proposalError.value = "";
  try {
    await props.source.setOperatorResolution({ card: props.target.id, proposal: proposal.value.id, action });
    await props.refresh();
    if (action === "clarify") emit("focusChat");
  } catch (error) {
    proposalError.value = error instanceof Error ? error.message : String(error);
  } finally {
    resolutionBusy.value = false;
  }
}
</script>

<template>
  <main class="task-next" :class="{ 'task-blocker': blocked }" aria-labelledby="journal-next">
    <div class="next-heading">
      <p class="muted">Следующий шаг</p>
      <button v-if="enabled" class="btn jump-chat" type="button" @click="emit('focusChat')">К оператору</button>
    </div>
    <h2 id="journal-next">{{ heading }}</h2>
    <p v-if="executor" class="muted">
      {{ EXECUTORS[executor.executor] ?? executor.executor }}<template v-if="executor.account"> · <code>{{ executor.account }}</code></template>
      <template v-if="executor.alive && executor.column === 'running'"> · {{ PHASES[executor.phase] }}</template>
      <template v-else-if="executor.column === 'sleeping' && executor.sleeping_until !== null">
        · возобновление {{ formatClock(executor.sleeping_until, now) }}
      </template>
    </p>
    <slot name="blocker" />
    <section v-if="showOptions && ((proposal && !chosen) || canAsk)" class="task-proposal" aria-label="Варианты оператора">
      <p v-if="analyzing || proposal?.status === 'pending'" role="status">Оператор сверяет отчёт и связанные PR…</p>
      <p v-if="proposalError || proposal?.status === 'failed'" class="journal-error" role="alert">
        {{ proposalError || "Оператор не смог подготовить варианты. Запрос можно повторить." }}
      </p>
      <template v-if="proposal?.status === 'answered' && !chosen && primary">
        <p class="proposal-label">{{ proposal.recommended ? "Оператор рекомендует" : "Вариант оператора" }}</p>
        <p>{{ primary.text }}</p>
        <p v-if="primary.action === 'accept' && proposal.record_only" class="muted">
          Архивируется журнал задачи. Рабочая копия и локальная ветка уже отсутствуют.
        </p>
        <button v-if="canChoose" type="button" class="btn journal-primary"
          :disabled="resolutionBusy || analyzing || resolving" @click="chooseOption(primary.action)">
          {{ optionLabels[primary.action] }}
        </button>
        <strong v-else>{{ optionLabels[primary.action] }}</strong>
        <details v-if="alternatives.length || proposal.reason">
          <summary>{{ alternatives.length ? "Другие варианты и обоснование" : "Обоснование" }}</summary>
          <p v-if="proposal.reason" class="muted">{{ proposal.reason }}</p>
          <ul class="decision-options">
            <li v-for="option in alternatives" :key="option.action">
              <p>{{ option.text }}</p>
              <p v-if="option.action === 'accept' && proposal.record_only" class="muted">
                Архивируется журнал задачи. Рабочая копия и локальная ветка уже отсутствуют.
              </p>
              <button v-if="canChoose" type="button" class="btn" :disabled="resolutionBusy || analyzing || resolving"
                @click="chooseOption(option.action)">{{ optionLabels[option.action] }}</button>
              <strong v-else>{{ optionLabels[option.action] }}</strong>
            </li>
          </ul>
        </details>
      </template>
      <button v-if="canAsk" type="button" class="btn request-options"
        :disabled="analyzing || proposal?.status === 'pending' || resolutionBusy || resolving" @click="askForDecision">
        {{ proposal && !chosen ? "Обновить варианты" : "Запросить варианты у оператора" }}
      </button>
    </section>
  </main>
</template>

<style scoped>
.task-next { display: grid; gap: 7px; padding: 12px 14px; border: 1px solid var(--border); border-inline-start: 3px solid var(--journal-accent); border-radius: 9px; background: var(--surface); font-size: 14px; line-height: 1.5; }
.task-next > h2 { margin: 0; font-size: 19px; line-height: 1.3; }
.task-next p { margin: 0; max-width: 72ch; }
.task-blocker { border-inline-start-color: var(--warn); }
.next-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 6px 10px; font-size: 12px; }
.jump-chat { padding-block: 2px; }
.task-proposal { display: grid; gap: 7px; margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 14px; line-height: 1.5; }
.task-proposal ul { margin: 0; }
.task-proposal .btn { justify-self: start; white-space: normal; text-align: start; }
.task-proposal .request-options { background: transparent; font-size: 12px; }
.task-proposal summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.task-proposal details > p { margin-top: 5px; }
.task-proposal .proposal-label { color: var(--journal-accent); font-size: 12px; font-weight: 600; }
.journal-primary { background: var(--journal-accent); color: light-dark(#fff, #193329); border-color: var(--journal-accent); }
.journal-error { color: var(--bad); }
.task-proposal .decision-options { display: grid; gap: 8px; padding: 0; list-style: none; }
.decision-options li { display: grid; gap: 6px; padding-top: 8px; margin-top: 5px; border-top: 1px solid var(--border); }
@container project-summary (min-width: 680px) {
  .jump-chat { display: none; }
}
</style>
