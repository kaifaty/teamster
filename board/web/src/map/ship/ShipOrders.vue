<script setup lang="ts">
// The order desk: acceptance, refit, an extra inspection, a flight review at the science station and the recall.
// A group shows only where the board server takes its order; every button acts at once, and a board that only reads
// copies the equal command. Stopping and writing off ask on the screen itself first.
import { computed, ref, watch } from "vue";
import { REVIEWERS, type Reviewer } from "../../lib/actions";
import { EXECUTORS } from "../../lib/labels";
import { returnText } from "../../lib/orders";
import type { Cargo, TaskLimits, TaskSummary } from "../../types";
import CopiedNote from "../station/CopiedNote.vue";
import type { GroupId, ShipDesk } from "./desk";
import { ANGLE_CHIPS, NOTE_MAX, OTHER_VERDICTS, anglesOf, deskOf, effortsFor, refitLine, stopConfirm, toggleAngle } from "./orders";

const props = defineProps<{ task: TaskSummary; desk: ShipDesk; limits: TaskLimits | null | undefined; cargo: Cargo | null }>();

const view = computed(() => deskOf(props.task, props.desk.queue.value));
const groups = computed(() => props.desk.groups);
const busy = (id: GroupId) => !!groups.value[id].busy;
const efforts = computed(() => effortsFor(props.task.executor));
const line = computed(() => refitLine(props.desk.refitNow.value, view.value.queue));
const refit = props.desk.refit;
const asIs = (value: string | number | null | undefined) => (value === null || value === undefined || value === "" ? "как сейчас" : String(value));
const savedAngles = computed(() => props.limits?.review_angles ?? []);

// Acceptance.
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

// The recall.
const confirming = ref<"stop" | "clean" | null>(null);
const keepBranch = ref(true);
const CONFIRM = computed(() => ({
  stop: stopConfirm(props.desk.queued.value?.waiting.length ?? 0),
  clean: "Списать: удалить worktree и запись задачи.",
}));
async function recall() {
  const what = confirming.value;
  if (!what) return;
  const asked = props.task.slug;
  if (what === "stop") await props.desk.stop();
  else await props.desk.clean(keepBranch.value);
  // Another ship opened meanwhile keeps its own confirmation.
  if (props.task.slug === asked) confirming.value = null;
}

watch(
  () => props.task.slug,
  () => {
    note.value = "";
    other.value = "";
    reviewAngles.value = [];
    reviewer.value = "";
    confirming.value = null;
    keepBranch.value = true;
  },
);
</script>

<template>
  <section class="deck orders" aria-labelledby="orders-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">⌘</span>
      <h3 id="orders-deck">Пульт приказов</h3>
    </div>
    <p v-if="!desk.live.value" class="readonly" role="note">Доска только читает ({{ desk.offReason.value }}): кнопки копируют команды teamster.</p>

    <div class="desk">
      <div v-if="view.accept" class="group" :class="{ lit: view.acceptFirst }" :aria-busy="busy('accept')">
        <h4>Приёмка <small v-if="view.acceptFirst">корабль на рейде: твой вердикт</small></h4>
        <div class="row">
          <button type="button" class="key main" :disabled="busy('accept')" @click="accept('accepted')">{{ groups.accept.busy === "accepted" ? "Принимаю…" : "Принять" }}</button>
          <button v-if="view.reply" type="button" class="key" :disabled="busy('accept')" @click="desk.fill(returnText(cargo))">Вернуть на доработку</button>
        </div>
        <div class="row">
          <select v-model="other" class="field" aria-label="Другой вердикт" :disabled="busy('accept')">
            <option value="">другой вердикт…</option>
            <option v-for="item in OTHER_VERDICTS" :key="item.verdict" :value="item.verdict">{{ item.label }}</option>
          </select>
          <button v-if="other" type="button" class="key" :disabled="busy('accept')" @click="accept(other as (typeof OTHER_VERDICTS)[number]['verdict'])">Записать</button>
        </div>
        <input v-model="note" class="field" type="text" :maxlength="NOTE_MAX" placeholder="Заметка к вердикту — необязательно" aria-label="Заметка к вердикту" :disabled="busy('accept')" />
        <p v-if="groups.accept.done" class="result ok" role="status" :title="groups.accept.output">{{ groups.accept.done }}</p>
        <p v-if="groups.accept.error" class="result bad" role="alert">{{ groups.accept.error }}</p>
        <CopiedNote v-if="groups.accept.copied" :copied="groups.accept.copied" />
      </div>

      <div v-if="view.refit" class="group">
        <h4>Переоснащение <small>{{ view.queue ? "уйдёт с указанием в очередь" : "со следующего указания" }}</small></h4>
        <div class="refit">
          <label>Двигатель<input v-model="refit.model" class="field mono" type="text" maxlength="64" :placeholder="asIs(task.model)" /></label>
          <label
            >Форсаж
            <select v-model="refit.effort" class="field">
              <option value="">{{ `как сейчас${task.effort ? ` · ${task.effort}` : ""}` }}</option>
              <option v-for="effort in efforts" :key="effort" :value="effort">{{ effort }}</option>
            </select>
          </label>
          <label>Лимит хода, мин<input v-model="refit.max_minutes" class="field num" type="text" inputmode="numeric" :placeholder="asIs(limits?.max_turn_minutes)" /></label>
          <label>Топливо задачи, %<input v-model="refit.max_weekly" class="field num" type="text" inputmode="decimal" :placeholder="asIs(limits?.max_weekly_percent)" /></label>
          <label>Круги ремонта<input v-model="refit.fix_rounds" class="field num" type="text" inputmode="numeric" :placeholder="asIs(limits?.fix_rounds)" /></label>
          <label>Попытки CI<input v-model="refit.ci_rounds" class="field num" type="text" inputmode="numeric" :placeholder="asIs(limits?.ci_rounds)" /></label>
          <label
            >Инспектор
            <select v-model="refit.reviewer" class="field">
              <option value="">{{ `как сейчас${task.reviewer ? ` · ${EXECUTORS[task.reviewer]}` : ""}` }}</option>
              <option v-for="name in REVIEWERS" :key="name" :value="name">{{ EXECUTORS[name] }}</option>
            </select>
          </label>
        </div>
        <div class="chips" role="group" aria-label="Ракурсы инспекции">
          <span class="dim small">Ракурсы{{ savedAngles.length ? ` · сейчас ${savedAngles.join(", ")}` : "" }}</span>
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

      <!-- A called inspection sets the ship to work: its outcome stays under the group. -->
      <div v-if="view.review || groups.review.done" class="group" :aria-busy="busy('review')">
        <h4>Инспекция <small>внеочередная</small></h4>
        <div v-if="view.review" class="chips" role="group" aria-label="Ракурсы внеочередной инспекции">
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
          <select v-model="reviewer" class="field" aria-label="Инспектор">
            <option value="">{{ `инспектор как сейчас${task.reviewer ? ` · ${EXECUTORS[task.reviewer]}` : ""}` }}</option>
            <option v-for="name in REVIEWERS" :key="name" :value="name">{{ EXECUTORS[name] }}</option>
          </select>
          <button type="button" class="key" :disabled="busy('review')" @click="desk.review(anglesOf(reviewAngles), reviewer)">{{ groups.review.busy ? "Вызываю…" : "Вызвать" }}</button>
        </div>
        <p v-if="groups.review.done" class="result ok" role="status" :title="groups.review.output">{{ groups.review.done }}</p>
        <p v-if="groups.review.error" class="result bad" role="alert">{{ groups.review.error }}</p>
        <CopiedNote v-if="groups.review.copied" :copied="groups.review.copied" />
      </div>

      <div v-if="view.reflect" class="group" :aria-busy="busy('reflect')">
        <h4>Разбор полёта</h4>
        <div class="row">
          <button type="button" class="key" :disabled="busy('reflect')" @click="desk.reflect()">{{ groups.reflect.busy ? "Отправляю…" : "Отправить на научную станцию" }}</button>
          <span class="dim small">аналитик разберёт этот рейс</span>
        </div>
        <p v-if="groups.reflect.done" class="result ok" role="status" :title="groups.reflect.output">{{ groups.reflect.done }}</p>
        <p v-if="groups.reflect.error" class="result bad" role="alert">{{ groups.reflect.error }}</p>
        <CopiedNote v-if="groups.reflect.copied" :copied="groups.reflect.copied" />
      </div>

      <div v-if="view.stop || view.clean" class="group" :aria-busy="busy('recall')">
        <h4>Отзыв</h4>
        <div class="row">
          <button v-if="view.stop" type="button" class="key danger" :disabled="busy('recall')" @click="confirming = 'stop'">Остановить</button>
          <button v-if="view.clean" type="button" class="key danger" :disabled="busy('recall')" @click="confirming = 'clean'">Списать</button>
          <label v-if="view.clean" class="check"><input v-model="keepBranch" type="checkbox" /> оставить ветку</label>
        </div>
        <div v-if="confirming" class="confirm" role="alertdialog" aria-label="Подтверждение" @keydown.esc.stop="confirming = null">
          <span>{{ CONFIRM[confirming] }}</span>
          <button type="button" class="key danger" :disabled="busy('recall')" @click="recall">{{ groups.recall.busy ? "Выполняю…" : "Да" }}</button>
          <button type="button" class="key" :disabled="busy('recall')" @click="confirming = null">Отмена</button>
        </div>
        <p v-if="groups.recall.done" class="result ok" role="status" :title="groups.recall.output">{{ groups.recall.done }}</p>
        <p v-if="groups.recall.error" class="result bad" role="alert">{{ groups.recall.error }}</p>
        <CopiedNote v-if="groups.recall.copied" :copied="groups.recall.copied" />
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

.group.lit {
  padding: 8px;
  border: 1px solid var(--sh-green);
  border-radius: 8px;
  background: rgba(111, 207, 143, 0.07);
  box-shadow: 0 0 0 3px rgba(111, 207, 143, 0.08);
}

h4 {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  color: var(--sh-title);
  font-size: 12px;
  font-weight: 600;
}

h4 small {
  color: var(--sh-faint);
  font-size: 11px;
  font-weight: 400;
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
