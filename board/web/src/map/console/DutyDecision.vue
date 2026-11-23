<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { A2uiSurface, type LitComponentApi } from "@a2ui/lit";
import {
  A2uiButton, A2uiCard, A2uiCheckBox, A2uiChoicePicker, A2uiColumn, A2uiText, A2uiTextField,
  Catalog, MessageProcessor, setMarkdownRenderer, type DataModel,
} from "@a2ui/web_core/v1_0";
import type { DutyComparison, DutyTaskPlan } from "../../dutyChatTypes";
import type { DutyPlanReply } from "../../lib/actions";

const props = defineProps<{ plan?: DutyTaskPlan; comparison?: DutyComparison; disabled: boolean }>();
const emit = defineEmits<{ send: [reply: DutyPlanReply]; choose: [title: string]; ready: [] }>();
const mount = ref<HTMLDivElement | null>(null);
const invalidCriteria = ref(false);

const catalog = new Catalog<LitComponentApi>("teamster:duty-decision", "1.0", [
  A2uiText, A2uiColumn, A2uiCard, A2uiCheckBox, A2uiTextField, A2uiChoicePicker, A2uiButton,
], []);
setMarkdownRenderer(async (text) => {
  const plain = document.createElement("span");
  plain.textContent = text;
  return plain.innerHTML;
});

const SURFACE_ID = "decision";
const SEND_ID = "send";
const bind = (path: string) => ({ "@path": path });
type Component = { id: string; component: string; [key: string]: unknown };

function planComponents(plan: DutyTaskPlan): Component[] {
  return plan.tasks.flatMap((task, index) => {
    const id = `task_${index}`;
    const path = `/tasks/${index}`;
    const criteria = task.done_when.map((_, criterion) => ({
      id: `${id}_criterion_${criterion}`,
      component: "TextField",
      label: `Критерий ${criterion + 1}`,
      "@accessibility": { label: `${task.title}, критерий ${criterion + 1}` },
      value: bind(`${path}/done_when/${criterion}`),
      variant: "longText",
    }));
    return [
      { id, component: "Card", child: `${id}_fields` },
      { id: `${id}_fields`, component: "Column", children: [
        `${id}_select`, `${id}_repo`, `${id}_goal`, ...criteria.map((field) => field.id),
      ] },
      { id: `${id}_select`, component: "CheckBox", label: task.title, value: bind(`${path}/selected`) },
      { id: `${id}_repo`, component: "Text", text: task.repo, variant: "caption" },
      { id: `${id}_goal`, component: "Text", text: task.goal },
      ...criteria,
    ];
  });
}

function comparisonComponents(comparison: DutyComparison): Component[] {
  const options = comparison.approaches.map((approach, index) => ({ label: approach.title, value: String(index) }));
  return [
    ...comparison.approaches.map((approach, index) => ({
      id: `approach_${index}`, component: "Text", text: `${approach.title} — ${approach.detail}`,
    })),
    { id: "choice", component: "ChoicePicker", label: "Выбери подход", options, value: bind("/choice") },
  ];
}

function selectedTasks(plan: DutyTaskPlan, model: DataModel): DutyPlanReply["selected"] {
  return plan.tasks.flatMap((task, index) => model.get(`/tasks/${index}/selected`) === true ? [{
    index,
    done_when: task.done_when.map((_, criterion) => model.get<string>(`/tasks/${index}/done_when/${criterion}`).trim()),
  }] : []);
}

function validSelection(selected: DutyPlanReply["selected"]): boolean {
  return selected.length > 0 && selected.every(({ done_when }) =>
    done_when.every((criterion) => criterion.length > 0 && [...criterion].length <= 200),
  );
}

let processor: MessageProcessor<LitComponentApi> | undefined;

onMounted(() => {
  const { plan, comparison } = props;
  if ((!plan && !comparison) || !mount.value) return;
  const components = plan ? planComponents(plan) : comparisonComponents(comparison!);
  const children = plan ? plan.tasks.map((_, index) => `task_${index}`) : ["approach_0", "approach_1", "choice"];
  processor = new MessageProcessor<LitComponentApi>([catalog], (action) => {
    if (props.disabled || action.name !== SEND_ID || action.surfaceId !== SURFACE_ID ||
        action.sourceComponentId !== SEND_ID) return;
    const model = processor?.getSurface(SURFACE_ID)?.dataModel;
    if (!model) return;
    if (plan) {
      const selected = selectedTasks(plan, model);
      if (validSelection(selected)) emit("send", { plan_id: plan.id, selected });
    } else {
      const [choice] = model.get<string[]>("/choice");
      const approach = comparison?.approaches[Number(choice)];
      if (approach) emit("choose", approach.title);
    }
  });

  try {
    processor.processMessages([{
      version: "1.0",
      createSurface: {
        surfaceId: SURFACE_ID,
        catalogId: catalog.id,
        dataModel: plan ? {
          valid: false,
          tasks: plan.tasks.map((task) => ({ selected: false, done_when: [...task.done_when] })),
        } : { valid: false, choice: [] },
        components: [
          { id: "root", component: "Column", children: [...children, SEND_ID] },
          ...components,
          {
            id: SEND_ID, component: "Button", child: "send_label", variant: "primary",
            action: { event: { name: SEND_ID } }, "@checks": [{ condition: bind("/valid") }],
          },
          { id: "send_label", component: "Text", text: "Отправить дежурному" },
        ],
      },
    }]);
    const surface = processor.getSurface(SURFACE_ID);
    if (!surface) return;
    const { dataModel } = surface;
    if (plan) {
      dataModel.subscribe("/tasks", () => {
        const selected = selectedTasks(plan, dataModel);
        const valid = validSelection(selected);
        dataModel.set("/valid", valid);
        invalidCriteria.value = selected.length > 0 && !valid;
      });
    } else {
      dataModel.subscribe<string[]>("/choice", (choice) => dataModel.set("/valid", choice?.length === 1));
    }
    const element = new A2uiSurface();
    element.surface = surface;
    mount.value.append(element);
    void element.updateComplete.then(() => emit("ready"));
  } catch (error) {
    // The chat already shows the plain text and its ordinary reply controls.
    console.warn("Could not render the duty decision", error);
  }
});

onBeforeUnmount(() => processor?.dispose());
</script>

<template>
  <div class="duty-decision" :inert="disabled">
    <div ref="mount"></div>
    <p v-if="invalidCriteria" class="criteria-error" role="status">Каждый критерий выбранной задачи должен содержать от 1 до 200 символов.</p>
  </div>
</template>

<style scoped>
.duty-decision {
  align-self: stretch;
  min-width: 0;
  max-width: 36rem;
  margin-top: 6px;
  overflow-wrap: anywhere;
  color-scheme: dark;
  accent-color: #f0b667;
  --a2ui-color-on-background: #ede0cc;
  --a2ui-color-on-surface: #ede0cc;
  --a2ui-color-on-primary: #211508;
  --a2ui-color-primary: #efbb78;
  --a2ui-color-primary-hover: #ffd197;
  --a2ui-color-surface: #221b16;
  --a2ui-color-input: #171411;
  --a2ui-color-on-input: #ede0cc;
  --a2ui-color-border: #68513a;
  --a2ui-text-caption-color: #c5aa8b;
  --a2ui-font-size-s: 13px;
  --a2ui-font-size-xs: 12px;
  --a2ui-card-padding: 9px;
  --a2ui-card-margin: 0;
  --a2ui-button-margin: 0;
  --a2ui-button-padding: 6px 10px;
  --a2ui-checkbox-margin: 0;
  --a2ui-column-gap: 6px;
}

.duty-decision[inert] {
  opacity: 0.7;
}

.criteria-error {
  margin: 4px 0 0;
  color: #ffad9a;
}
</style>
