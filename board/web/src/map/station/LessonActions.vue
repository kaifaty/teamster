<script setup lang="ts">
// A lesson's buttons, under its thread in «Переписка»: a proposed lesson is implemented, accepted, declined or
// discussed, an accepted one is implemented or marked applied. «Внедрить» asks where, and «Запустить» closes the form
// and shows the start in the thread at once; the other buttons show their decision at once too, and for a few seconds
// after them the lesson offers to take the decision back.
// For a lesson whose proposal changes files outside the repositories, «Внедрить» lets its agent change them, and
// «Скопировать задание» copies the change for a session that makes it by hand.
import { computed, ref } from "vue";
import type { Lesson } from "../../types";
import { manualAssignment, outsideOf } from "../station";
import { useConsole, type CardBusy } from "./console";
import CopiedNote from "./CopiedNote.vue";

const props = defineProps<{ lesson: Lesson; stage: "proposed" | "accepted" }>();
const desk = useConsole();
const repos = computed(() => desk.repos.value);
const outside = computed(() => outsideOf(props.lesson));

const card = computed(() => desk.cardOf(props.lesson));
const busy = (what: CardBusy) => card.value.busy === what;
const DONE = { accepted: "Принято", declined: "Отклонено", applied: "Внедрено" } as const;

/** The form's field, two-way: the card's note. */
const note = computed({
  get: () => card.value.note,
  set: (text: string) => desk.setNote(props.lesson, text),
});
/** «Репозиторий», two-way: the picked repository's path. */
const repo = computed({
  get: () => card.value.repo,
  set: (path: string) => desk.setRepo(props.lesson, path),
});
const implementTitle = computed(
  () =>
    desk.implementOff.value ??
    (outside.value.length
      ? "Агент сделает изменение урока, в том числе в файлах вне репозитория, сначала сохранив их копии .bak"
      : "Агент сделает изменение урока и откроет PR"),
);

/** «Скопировать задание»: the text just copied, or shown to copy by hand when the clipboard refused. */
const assignment = ref<{ text: string; copied: boolean } | null>(null);
async function copyAssignment() {
  const text = manualAssignment(props.lesson, new Date());
  assignment.value = { text, copied: await desk.copyText(text) };
}
function selectAll(event: FocusEvent) {
  (event.target as HTMLTextAreaElement).select();
}

function submit() {
  const form = card.value.form;
  if (form === "decline") void desk.decline(props.lesson);
  else if (form === "apply") void desk.apply(props.lesson);
  else if (form === "discuss") void desk.startDiscussion(props.lesson);
  else if (form === "implement") void desk.implement(props.lesson, props.stage);
}
</script>

<template>
  <div class="lesson-actions" :aria-busy="!!card.busy">
    <p v-if="card.done" class="done-line" role="status">
      {{ DONE[card.done.status] }} ·
      <button type="button" class="link" :class="{ busy: busy('undo') }" :disabled="!!card.busy" @click="desk.undo(lesson)">Отменить</button>
    </p>

    <form v-else-if="card.form === 'implement'" class="form" @submit.prevent="submit" @keydown.esc.stop="desk.closeForm(lesson)">
      <label class="field">
        <span class="label">Репозиторий</span>
        <select v-model="repo" :title="repo || 'Выбери репозиторий'" :disabled="!!card.busy">
          <option value="" disabled>Выбери репозиторий</option>
          <option v-for="item in repos" :key="item.path" :value="item.path" :title="item.path">{{ item.name }}</option>
        </select>
      </label>
      <p class="hint">
        В нём агент заведёт ветку, сделает правку с тестами и откроет PR. Части урока для других репозиториев он
        перечислит в отчёте.
      </p>
      <p v-if="desk.reposAccess.value === 'scanning'" class="hint" role="status">Ищу репозитории…</p>
      <p v-else-if="desk.reposAccess.value === 'denied'" class="hint warn" role="note">
        Часть репозиториев не видна: у доски нет доступа к диску. Разреши Python доски доступ к файлам на съёмных
        томах: Системные настройки → Конфиденциальность и безопасность → Файлы и папки или Полный доступ к диску.
      </p>
      <p v-if="outside.length" class="hint">
        Файлы из списка выше агент поменяет при любом выборе: с копией .bak рядом, без PR — проверь их по отчёту. Если в
        самом репозитории менять нечего, ветки и PR не будет.
      </p>
      <p v-else class="hint">Файлы вне репозиториев (~/.codex, ~/.claude) агент не трогает — перечислит их в отчёте.</p>
      <textarea v-model="note" rows="2" placeholder="Уточнение — необязательно" aria-label="Уточнение" :disabled="!!card.busy"></textarea>
      <span class="buttons">
        <button type="submit" class="key gold" :disabled="!!card.busy || !repo">Запустить</button>
        <button type="button" class="chip" :disabled="!!card.busy" @click="desk.closeForm(lesson)">Отмена</button>
      </span>
    </form>

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

    <!-- A proposed lesson whose start goes waits to become accepted. -->
    <div v-else-if="stage === 'proposed' && !desk.startGoes(lesson)" class="buttons">
      <button
        v-if="desk.offersImplement(lesson)"
        type="button"
        class="key gold"
        :title="implementTitle"
        :disabled="!!card.busy || !!desk.implementOff.value"
        @click="desk.openForm(lesson, 'implement')"
      >
        Внедрить
      </button>
      <button v-if="outside.length" type="button" class="chip" title="Скопировать правку для своей сессии Claude" :disabled="!!card.busy" @click="copyAssignment">
        Скопировать задание
      </button>
      <button type="button" class="key" title="Принять без запуска" :class="{ busy: busy('accept') }" :disabled="!!card.busy" @click="desk.accept(lesson)">Принять</button>
      <button type="button" class="chip" :disabled="!!card.busy" @click="desk.openForm(lesson, 'decline')">Отклонить</button>
      <button type="button" class="chip" :disabled="!!card.busy" @click="desk.discuss(lesson)">Обсудить</button>
    </div>
    <div v-else-if="stage === 'accepted'" class="buttons">
      <button
        v-if="desk.offersImplement(lesson)"
        type="button"
        class="key gold"
        :title="implementTitle"
        :disabled="!!card.busy || !!desk.implementOff.value"
        @click="desk.openForm(lesson, 'implement')"
      >
        Внедрить
      </button>
      <button v-if="outside.length" type="button" class="chip" title="Скопировать правку для своей сессии Claude" :disabled="!!card.busy" @click="copyAssignment">
        Скопировать задание
      </button>
      <button type="button" class="chip applied" title="Изменение уже сделано: отметить урок внедрённым" :disabled="!!card.busy" @click="desk.openForm(lesson, 'apply')">
        Внедрено
      </button>
    </div>

    <template v-if="assignment && !card.form">
      <p v-if="assignment.copied" class="copied" role="status">Задание скопировано: вставь его в сессию Claude, а после правки отметь «Внедрено»</p>
      <template v-else>
        <p class="copied" role="status">Буфер обмена недоступен: скопируй задание и вставь его в сессию Claude</p>
        <textarea class="mono manual" rows="6" readonly :value="assignment.text" aria-label="Задание для сессии Claude" @focus="selectAll"></textarea>
      </template>
    </template>
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

.field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}

.field .label {
  flex: none;
  color: var(--st-dim);
}

.field select {
  flex: 1;
  min-width: 0;
}

.hint {
  margin: 0;
  color: var(--st-dim);
  font-size: 12px;
}

.hint.warn {
  color: var(--st-amber);
}

.form .note {
  flex: none;
  width: 100%;
}

.copied {
  margin: 6px 0 0;
  color: #d4cab5;
  font-size: 12px;
}

.manual {
  width: 100%;
  margin-top: 4px;
  font-size: 11.5px;
  resize: vertical;
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
