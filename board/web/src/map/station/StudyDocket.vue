<script setup lang="ts">
// A lesson's docket in a study's conversation: what the analyst filed, how the lesson stands, the quick «Принять» and
// «Отклонить», and «Открыть урок» — the lesson's thread is where it is read in full and its implementation followed.
// «Внедрить» opens the thread with the start's form.
import { computed } from "vue";
import type { StudyMessage } from "../../types";
import { LESSON_STATE, docketParts } from "../station";
import { useConsole } from "./console";

const props = defineProps<{ item: StudyMessage["lessons"][number] }>();
const desk = useConsole();

const SCOPE: Record<"invariant" | "domain", string> = { invariant: "общий", domain: "по проекту" };
const DONE = { accepted: "Принято", declined: "Отклонено", applied: "Внедрено" } as const;

const lesson = computed(() => desk.index.value.get(props.item.entry.trim()) ?? null);
const card = computed(() => (lesson.value ? desk.cardOf(lesson.value) : null));
const parts = computed(() =>
  lesson.value
    ? docketParts(lesson.value, desk.cardOf(lesson.value), { offers: desk.offersImplement(lesson.value) && !desk.implementOff.value, goes: desk.startGoes(lesson.value) })
    : null,
);
const state = computed(() => {
  const shown = lesson.value;
  if (!shown) return "";
  return desk.badgeOf(shown) ?? (shown.status !== "proposed" ? LESSON_STATE[shown.status] || shown.status_text : "");
});
</script>

<template>
  <article class="docket" :class="lesson?.status ?? 'unindexed'">
    <header class="d-head">
      <span>Урок · {{ item.id }}<template v-if="item.scope"> · {{ SCOPE[item.scope] }}</template></span>
      <span v-if="state" class="d-state">{{ state }}</span>
    </header>
    <dl class="d-body">
      <dt>Когда</dt>
      <dd>{{ item.cue }}</dd>
      <template v-if="item.lesson"><dt>Что делать</dt><dd>{{ item.lesson }}</dd></template>
    </dl>
    <div v-if="lesson && card && parts" class="d-actions">
      <span v-if="card.done" class="d-done" role="status">
        {{ DONE[card.done.status] }} ·
        <button type="button" class="link" :disabled="!!card.busy" @click="desk.undo(lesson)">Отменить</button>
      </span>
      <button v-if="parts.implement" type="button" class="key gold" @click="desk.showLesson(lesson, 'implement')">Внедрить</button>
      <button v-if="parts.decide" type="button" class="key" title="Принять без запуска" :disabled="!!card.busy" @click="desk.accept(lesson)">Принять</button>
      <button v-if="parts.decide" type="button" class="chip" title="Отклонить без причины" :disabled="!!card.busy" @click="desk.decline(lesson)">Отклонить</button>
      <button type="button" class="chip" :title="`Открыть урок ${item.id} в переписке`" @click="desk.showLesson(lesson)">Открыть урок</button>
    </div>
    <p v-if="card?.error" class="d-fail" role="alert">{{ card.error }}</p>
  </article>
</template>

<style scoped>
/* A docket: a lesson with the decision it waits for. */
.docket {
  padding: 7px 10px 8px;
  border: 1px solid rgba(214, 170, 96, 0.3);
  border-left: 3px solid var(--st-title);
  border-radius: 0 3px 3px 0;
  background: rgba(20, 18, 14, 0.85);
}

.docket.accepted {
  border-left-color: var(--st-teal);
}

.docket.applied {
  border-left-color: var(--st-green);
}

.docket.unindexed,
.docket.declined {
  border-left-color: #6b6457;
}

.docket.declined {
  opacity: 0.8;
}

.d-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--st-title);
  font-size: 12px;
  font-weight: 600;
}

.d-state {
  color: #9cc2bc;
  font-weight: 400;
}

.d-body {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 10px;
  margin: 6px 0 0;
}

.d-body dt {
  color: var(--st-dim);
}

.d-body dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.d-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.d-done {
  color: var(--st-teal);
  font-size: 12.5px;
}

.d-fail {
  margin: 4px 0 0;
  color: #ff9d8a;
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
