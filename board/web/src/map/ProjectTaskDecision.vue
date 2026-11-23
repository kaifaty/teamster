<script setup lang="ts">
import { computed, ref } from "vue";
import type { BoardSource } from "../lib/source";
import { optionLabels, type OperatorOption, type OperatorResolution, type OperatorTarget } from "../operatorActivity";

const props = defineProps<{
  target: OperatorTarget;
  source: BoardSource;
  inHistory: boolean;
  resolution: OperatorResolution | null;
  enabled: boolean;
  resolving: boolean;
  refresh: () => Promise<void>;
}>();
const emit = defineEmits<{ clarify: [] }>();

const resolutionBusy = ref(false);
const proposal = computed(() => props.resolution?.proposals?.at(-1));
const chosen = computed(() => props.resolution?.events.find(event => event.detail.proposal === proposal.value?.id
  && event.kind === "choice")?.detail.action);
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
    if (action === "clarify") emit('clarify');
  } catch (error) {
    proposalError.value = error instanceof Error ? error.message : String(error);
  } finally {
    resolutionBusy.value = false;
  }
}
</script>

<template>
  <section v-if="proposal || (!inHistory && enabled && resolution?.writable && source.askOperator)"
    class="task-proposal" aria-labelledby="journal-proposal">
    <div class="section-heading">
      <h2 id="journal-proposal">Следующий шаг</h2>
      <button v-if="!inHistory && enabled && resolution?.writable && source.askOperator" type="button"
        class="btn" :disabled="analyzing || proposal?.status === 'pending' || resolutionBusy" @click="askForDecision">
        {{ proposal ? "Обновить варианты" : "Запросить варианты у оператора" }}
      </button>
    </div>
    <p v-if="analyzing || proposal?.status === 'pending'" role="status">Оператор сверяет отчёт и связанные PR…</p>
    <p v-if="proposalError || proposal?.status === 'failed'" class="journal-error" role="alert">
      {{ proposalError || "Оператор не смог подготовить варианты. Запрос можно повторить." }}
    </p>
    <template v-if="proposal?.status === 'answered'">
      <p>{{ proposal.reason }}</p>
      <ul class="decision-options">
        <li v-for="option in proposal.options" :key="option.action">
          <strong>{{ optionLabels[option.action] }}</strong>
          <small v-if="proposal.recommended === option.action" class="muted">Рекомендация оператора</small>
          <p>{{ option.text }}</p>
          <p v-if="chosen === option.action" role="status">Вы выбрали этот вариант</p>
          <button v-if="!chosen && !inHistory && resolution?.writable && source.setOperatorResolution" type="button"
            class="btn" :class="{ 'journal-primary': proposal.recommended === option.action }"
            :disabled="resolutionBusy || analyzing || resolving" @click="chooseOption(option.action)">
            {{ optionLabels[option.action] }}
          </button>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.task-proposal { display: grid; gap: 8px; margin-top: 16px; padding: 14px; border: 1px solid var(--border); border-inline-start: 3px solid var(--journal-accent); border-radius: 8px; background: var(--surface); font-size: 14px; line-height: 1.5; }
.task-proposal h2, .task-proposal p, .task-proposal ul { margin: 0; }
.task-proposal h2 { font-size: 17px; }
.section-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.journal-primary { background: var(--journal-accent); color: light-dark(#fff, #193329); border-color: var(--journal-accent); }
.journal-error { color: var(--bad); }
.task-proposal .decision-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 235px), 1fr)); gap: 8px; padding: 0; list-style: none; }
.decision-options li { display: grid; align-content: start; gap: 6px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; }
.decision-options .btn { justify-self: start; }
</style>
