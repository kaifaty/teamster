<script setup lang="ts">
// A lesson's buttons, the same on its lab card and its docket: a proposed lesson is accepted, declined or
// discussed, an accepted one is marked applied. Each button acts at once; for a few seconds after it the card
// offers to take the decision back.
import { computed } from "vue";
import type { Lesson } from "../../types";
import { useConsole, type CardBusy } from "./console";
import CopiedNote from "./CopiedNote.vue";

const props = defineProps<{ lesson: Lesson; stage: "proposed" | "accepted" }>();
const desk = useConsole();

const card = computed(() => desk.cardOf(props.lesson));
const busy = (what: CardBusy) => card.value.busy === what;
const DONE = { accepted: "Принято", declined: "Отклонено", applied: "Внедрено" } as const;

/** The form's field, two-way: the card's note. */
const note = computed({
  get: () => card.value.note,
  set: (text: string) => desk.setNote(props.lesson, text),
});

function submit() {
  const form = card.value.form;
  if (form === "decline") void desk.decline(props.lesson);
  else if (form === "apply") void desk.apply(props.lesson);
  else if (form === "discuss") void desk.startDiscussion(props.lesson);
}
</script>

<template>
  <div class="lesson-actions" :aria-busy="!!card.busy">
    <p v-if="card.done" class="done-line" role="status">
      {{ DONE[card.done.status] }} ·
      <button type="button" class="link" :class="{ busy: busy('undo') }" :disabled="!!card.busy" @click="desk.undo(lesson)">Отменить</button>
    </p>

    <form v-else-if="card.form" class="form" @submit.prevent="submit" @keydown.esc.stop="desk.closeForm(lesson)">
      <textarea
        v-if="card.form === 'discuss'"
        v-model="note"
        rows="2"
        placeholder="Что обсудить? — необязательно"
        aria-label="Что обсудить"
        :disabled="!!card.busy"
      ></textarea>
      <input
        v-else
        v-model="note"
        class="note"
        type="text"
        :placeholder="card.form === 'decline' ? 'Причина — необязательно' : 'Где: PR, файл — необязательно'"
        :aria-label="card.form === 'decline' ? 'Причина отказа' : 'Где внедрено'"
        :disabled="!!card.busy"
      />
      <span class="buttons">
        <button type="submit" class="key" :class="{ gold: card.form === 'discuss', busy: !!card.busy }" :disabled="!!card.busy">
          {{ card.form === "decline" ? "Отклонить" : card.form === "apply" ? "Отметить" : "Начать обсуждение" }}
        </button>
        <button type="button" class="chip" :disabled="!!card.busy" @click="desk.closeForm(lesson)">Отмена</button>
      </span>
    </form>

    <div v-else-if="stage === 'proposed'" class="buttons">
      <button type="button" class="key gold" :class="{ busy: busy('accept') }" :disabled="!!card.busy" @click="desk.accept(lesson)">Принять</button>
      <button type="button" class="chip" :disabled="!!card.busy" @click="desk.openForm(lesson, 'decline')">Отклонить</button>
      <button type="button" class="chip" :disabled="!!card.busy" @click="desk.discuss(lesson)">Обсудить</button>
    </div>
    <div v-else class="buttons">
      <button type="button" class="chip applied" title="Изменение уже сделано: отметить урок внедрённым" :disabled="!!card.busy" @click="desk.openForm(lesson, 'apply')">
        Внедрено
      </button>
    </div>

    <p v-if="card.error" class="fail" role="alert">{{ card.error }}</p>
    <CopiedNote v-if="card.copied" :copied="card.copied" />
  </div>
</template>

<style scoped>
.lesson-actions {
  margin-top: 8px;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form textarea {
  width: 100%;
  resize: vertical;
}

.form .note {
  flex: none;
  width: 100%;
}

.done-line {
  margin: 0;
  color: var(--st-teal);
  font-size: 12.5px;
}

.fail {
  margin: 6px 0 0;
  color: #ff9d8a;
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
