<script setup lang="ts">
// The deck «Другие действия»: what «Сейчас» does not lead with — a verdict, the refit, an extra review, a flight review
// at the science station and the recall. The forms stay folded until opened. A group shows only where the board server
// takes its order; every button acts at once, and a board that only reads copies the equal command. Stopping and
// writing off ask on the screen itself first (ShipRecall, shared with the block of a ship with a verdict).
import { computed, ref, watch } from "vue";
import { REVIEWERS, type Reviewer } from "../../lib/actions";
import { EXECUTORS } from "../../lib/labels";
import type { Cargo, TaskLimits, TaskSummary } from "../../types";
import CopiedNote from "../station/CopiedNote.vue";
import { verdictOf } from "./bridge";
import type { GroupId, ShipDesk } from "./desk";
import { ANGLE_CHIPS, NOTE_MAX, OTHER_VERDICTS, anglesOf, deskOf, effortsFor, refitLine, toggleAngle } from "./orders";
import ShipRecall from "./ShipRecall.vue";

const props = defineProps<{ task: TaskSummary; desk: ShipDesk; limits: TaskLimits | null | undefined; cargo: Cargo | null }>();

const view = computed(() => deskOf(props.task, props.desk.queue.value));
const groups = computed(() => props.desk.groups);
const busy = (id: GroupId) => !!groups.value[id].busy;
const efforts = computed(() => effortsFor(props.task.executor));
const line = computed(() => refitLine(props.desk.refitNow.value, view.value.queue));
const refit = props.desk.refit;
const asIs = (value: string | number | null | undefined) => (value === null || value === undefined || value === "" ? "как сейчас" : String(value));
const savedAngles = computed(() => props.limits?.review_angles ?? []);

// Acceptance. Once a verdict is written, «Принять» stands here too, to change the verdict back.
const judged = computed(() => verdictOf(props.task) !== null);
const acceptHere = computed(() => !view.value.acceptFirst || judged.value);
const verdictGroup = ref<HTMLDetailsElement | null>(null);
function onVerdictToggle() {
  if (verdictGroup.value) props.desk.verdictOpen.value = verdictGroup.value.open;
}
const note = ref("");
const other = ref("");
async function accept(verdict: Parameters<ShipDesk["verdict"]>[0]) {
  if (await props.desk.verdict(verdict, note.value)) {
    note.value = "";
    other.value = "";
  }
}

// The extra inspection.
const reviewAngles = ref<string[]>([]);
const reviewer = ref<Reviewer | "">("");

watch(
  () => props.task.slug,
  () => {
    note.value = "";
    other.value = "";
    reviewAngles.value = [];
    reviewer.value = "";
  },
);
</script>

<template>
  <section class="deck orders" aria-labelledby="orders-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">⌘</span>
      <h3 id="orders-deck">Другие действия</h3>
    </div>
    <p v-if="!desk.live.value" class="readonly" role="note">Доска только читает ({{ desk.offReason.value }}): кнопки копируют команды teamster.</p>

    <div class="desk">
      <details v-if="view.refit" class="group fold">
        <summary>Изменить параметры <small>{{ view.queue ? "уйдёт с указанием в очередь" : "уйдёт со следующим ответом" }}</small></summary>
        <div class="body">
          <div class="refit">
            <label>Модель<input v-model="refit.model" class="field mono" type="text" :maxlength="task.executor === 'opencode' ? undefined : 64" :placeholder="asIs(task.model)" /></label>
            <label v-if="efforts.length"
              >Усилие
              <select v-model="refit.effort" class="field">
                <option value="">{{ `как сейчас${task.effort ? ` · ${task.effort}` : ""}` }}</option>
                <option v-for="effort in efforts" :key="effort" :value="effort">{{ effort }}</option>
              </select>
            </label>
            <label>Лимит хода, мин<input v-model="refit.max_minutes" class="field num" type="text" inputmode="numeric" :placeholder="asIs(limits?.max_turn_minutes)" /></label>
            <label>Бюджет, % недели<input v-model="refit.max_weekly" class="field num" type="text" inputmode="decimal" :placeholder="asIs(limits?.max_weekly_percent)" /></label>
            <label>Круги исправления<input v-model="refit.fix_rounds" class="field num" type="text" inputmode="numeric" :placeholder="asIs(limits?.fix_rounds)" /></label>
            <label>Попытки CI<input v-model="refit.ci_rounds" class="field num" type="text" inputmode="numeric" :placeholder="asIs(limits?.ci_rounds)" /></label>
            <label
              >Ревьюер
              <select v-model="refit.reviewer" class="field">
                <option value="">{{ `как сейчас${task.reviewer ? ` · ${EXECUTORS[task.reviewer]}` : ""}` }}</option>
                <option v-for="name in REVIEWERS" :key="name" :value="name">{{ EXECUTORS[name] }}</option>
              </select>
            </label>
          </div>
          <div class="chips" role="group" aria-label="Углы ревью">
            <span class="dim small">Углы ревью{{ savedAngles.length ? ` · сейчас ${savedAngles.join(", ")}` : "" }}</span>
            <button
              v-for="angle in ANGLE_CHIPS"
              :key="angle"
              type="button"
              class="chip"
              :aria-pressed="refit.angles.includes(angle)"
              @click="refit.angles = toggleAngle(refit.angles, angle)"
            >
              {{ angle }}
            </button>
          </div>
          <p class="cmd" :class="{ bad: desk.refitNow.value.errors.length }">{{ line }}</p>
        </div>
      </details>

      <!-- A called review sets the ship to work: its outcome stays under the group. -->
      <details v-if="view.review || groups.review.done" class="group fold" :open="!!groups.review.done || undefined" :aria-busy="busy('review')">
        <summary>Внеочередное ревью</summary>
        <div class="body">
          <div v-if="view.review" class="chips" role="group" aria-label="Углы внеочередного ревью">
            <button
              v-for="angle in ANGLE_CHIPS"
              :key="angle"
              type="button"
              class="chip"
              :aria-pressed="reviewAngles.includes(angle)"
              @click="reviewAngles = toggleAngle(reviewAngles, angle)"
            >
              {{ angle }}
            </button>
          </div>
          <div v-if="view.review" class="row">
            <select v-model="reviewer" class="field" aria-label="Ревьюер">
              <option value="">{{ `ревьюер как сейчас${task.reviewer ? ` · ${EXECUTORS[task.reviewer]}` : ""}` }}</option>
              <option v-for="name in REVIEWERS" :key="name" :value="name">{{ EXECUTORS[name] }}</option>
            </select>
            <button type="button" class="key" :disabled="busy('review')" @click="desk.review(anglesOf(reviewAngles), reviewer)">{{ groups.review.busy ? "Вызываю…" : "Вызвать" }}</button>
          </div>
          <p v-if="groups.review.done" class="result ok" role="status" :title="groups.review.output">{{ groups.review.done }}</p>
          <p v-if="groups.review.error" class="result bad" role="alert">{{ groups.review.error }}</p>
          <CopiedNote v-if="groups.review.copied" :copied="groups.review.copied" />
        </div>
      </details>

      <details
        v-if="view.accept"
        id="ship-verdict"
        ref="verdictGroup"
        class="group fold"
        :open="desk.verdictOpen.value || !!groups.accept.done || !!groups.accept.error || undefined"
        :aria-busy="busy('accept')"
        @toggle="onVerdictToggle"
      >
        <summary>{{ acceptHere ? "Записать вердикт" : "Другой вердикт" }} <small>{{ acceptHere ? "принят, с правками, не берём" : "с правками, переделан, не берём" }}</small></summary>
        <div class="body">
          <div class="row">
            <button v-if="acceptHere" type="button" class="key" :disabled="busy('accept')" @click="accept('accepted')">{{ groups.accept.busy === "accepted" ? "Принимаю…" : "Принять" }}</button>
            <select v-model="other" class="field" aria-label="Другой вердикт" :disabled="busy('accept')">
              <option value="">другой вердикт…</option>
              <option v-for="item in OTHER_VERDICTS" :key="item.verdict" :value="item.verdict">{{ item.label }}</option>
            </select>
            <button v-if="other" type="button" class="key" :disabled="busy('accept')" @click="accept(other as (typeof OTHER_VERDICTS)[number]['verdict'])">Записать</button>
          </div>
          <input v-model="note" class="field" type="text" :maxlength="NOTE_MAX" placeholder="Заметка к вердикту — необязательно" aria-label="Заметка к вердикту" :disabled="busy('accept')" />
          <p class="dim small">Вердикт — оценка для статистики; PR этим не сливается.</p>
          <template v-if="!view.acceptFirst">
            <p v-if="groups.accept.done" class="result ok" role="status" :title="groups.accept.output">{{ groups.accept.done }}</p>
            <p v-if="groups.accept.error" class="result bad" role="alert">{{ groups.accept.error }}</p>
            <CopiedNote v-if="groups.accept.copied" :copied="groups.accept.copied" />
          </template>
        </div>
      </details>

      <div v-if="view.reflect" class="group" :aria-busy="busy('reflect')">
        <div class="row">
          <button type="button" class="key" :disabled="busy('reflect')" @click="desk.reflect()">{{ groups.reflect.busy ? "Отправляю…" : "Разобрать задачу" }}</button>
          <span class="dim small">отправить задачу на рефлексию</span>
        </div>
        <p v-if="groups.reflect.done" class="result ok" role="status" :title="groups.reflect.output">{{ groups.reflect.done }}</p>
        <p v-if="groups.reflect.error" class="result bad" role="alert">{{ groups.reflect.error }}</p>
        <CopiedNote v-if="groups.reflect.copied" :copied="groups.reflect.copied" />
      </div>

      <div v-if="view.stop || view.clean" class="group" :aria-busy="busy('recall')">
        <ShipRecall :task="task" :desk="desk" :stop="view.stop" :clean="view.clean" />
      </div>

    </div>
  </section>
</template>

<style scoped>
.readonly {
  margin: 0;
  padding: 5px 8px;
  border: 1px dashed rgba(214, 170, 96, 0.35);
  border-radius: 6px;
  color: #d4cab5;
  font-size: 12px;
}

.desk {
  display: grid;
  gap: 10px;
}

.group {
  display: grid;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid rgba(214, 170, 96, 0.14);
}

.group:first-child {
  padding-top: 0;
  border-top: 0;
}

.fold > summary {
  display: flex;
  list-style: none;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  color: var(--sh-title);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

.fold > summary small {
  color: var(--sh-faint);
  font-size: 11px;
  font-weight: 400;
}

.fold > summary::-webkit-details-marker {
  display: none;
}

.fold > summary::after {
  content: "▸";
  margin-left: auto;
  color: var(--sh-faint);
}

.fold[open] > summary::after {
  content: "▾";
}

.fold .body {
  display: grid;
  gap: 6px;
  padding-top: 8px;
}

.refit label i {
  color: var(--sh-faint);
  font-style: normal;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.row select {
  flex: 1 1 160px;
  width: auto;
}

.refit {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 6px 10px;
}

.refit label {
  display: grid;
  gap: 2px;
  color: var(--sh-dim);
  font-size: 11.5px;
}

.small {
  font-size: 11.5px;
}

.cmd {
  margin: 0;
  padding: 5px 8px;
  overflow-wrap: anywhere;
  border: 1px dashed rgba(95, 214, 200, 0.35);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.45);
  color: var(--sh-teal);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11.5px;
}

.cmd.bad {
  border-color: rgba(255, 141, 122, 0.45);
  color: var(--sh-red);
}

</style>
