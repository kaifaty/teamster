<script setup lang="ts">
// The lab: every lesson the analyst proposed moves along one line — proposed, accepted, applied — or drops out
// declined. The stages are the lab's tabs; a decision taken on a card goes to the transmitter with the rest.
import { computed, ref, watch } from "vue";
import type { Lesson } from "../../types";
import { plural, shortDate, type Research } from "../research";
import { reach } from "../station";
import { useConsole } from "./console";

const props = defineProps<{ research: Research }>();
const emit = defineEmits<{ jump: [deck: "comms"] }>();
const desk = useConsole();

type Stage = "proposed" | "accepted" | "applied" | "declined";
const STAGES: { stage: Stage; sigil: string; label: [string, string, string] }[] = [
  { stage: "proposed", sigil: "◆", label: ["на решение", "на решение", "на решение"] },
  { stage: "accepted", sigil: "◇", label: ["к внедрению", "к внедрению", "к внедрению"] },
  { stage: "applied", sigil: "✓", label: ["внедрён", "внедрено", "внедрено"] },
  { stage: "declined", sigil: "✕", label: ["отклонён", "отклонено", "отклонено"] },
];

const listOf = (stage: Stage): Lesson[] =>
  stage === "declined" ? [...props.research.declined, ...props.research.other] : props.research[stage];

const firstStage = (): Stage => (["proposed", "accepted", "applied"] as const).find((stage) => listOf(stage).length) ?? "proposed";
const stage = ref<Stage>(firstStage());
// New proposals bring the lab back to the decisions, unless the human looks at another stage that has lessons.
watch(
  () => props.research.proposed.length,
  (count, before) => {
    if (count > (before ?? 0) || !listOf(stage.value).length) stage.value = firstStage();
  },
);

const shown = computed(() => listOf(stage.value));
const scopeText = (lesson: Lesson) =>
  lesson.scope === "invariant" ? "общий" : lesson.scope === "domain" ? lesson.repos.join(", ") || lesson.scope_text : lesson.scope_text;
const filedOf = (lesson: Lesson) => desk.filed.value.get(lesson.entry.trim()) ?? null;

function toDocket(lesson: Lesson) {
  const filed = filedOf(lesson);
  if (!filed) return;
  desk.select(filed.study);
  emit("jump", "comms");
}

function clarify(lesson: Lesson) {
  const filed = filedOf(lesson);
  if (!filed) return;
  emit("jump", "comms");
  void desk.clarify(filed.id, filed.study);
}
</script>

<template>
  <section class="deck lab" data-deck="lab" aria-labelledby="deck-lab">
    <header class="deck-head">
      <span class="sigil" aria-hidden="true">⚗</span>
      <h3 id="deck-lab">Лаборатория</h3>
      <span class="aside">уроков {{ research.proposed.length + research.accepted.length + research.applied.length + research.declined.length + research.other.length }}</span>
    </header>

    <nav class="line" aria-label="Стадии уроков">
      <template v-for="(item, number) in STAGES" :key="item.stage">
        <span v-if="number > 0 && item.stage !== 'declined'" class="arrow" aria-hidden="true">›</span>
        <button
          type="button"
          class="stage"
          :class="[item.stage, { on: stage === item.stage, lit: listOf(item.stage).length > 0, aside: item.stage === 'declined' }]"
          :aria-pressed="stage === item.stage"
          @click="stage = item.stage"
        >
          <span class="s-sigil" aria-hidden="true">{{ item.sigil }}</span>
          <b class="s-count num">{{ listOf(item.stage).length }}</b>
          <span class="s-label">{{ plural(listOf(item.stage).length, ...item.label) }}</span>
        </button>
      </template>
    </nav>

    <div class="deck-body">
      <p v-if="!shown.length" class="dim empty">
        {{ stage === "proposed" ? "Ничего не ждёт решения." : stage === "accepted" ? "Принятых и не внедрённых уроков нет." : "Здесь пока пусто." }}
      </p>

      <ul v-else class="cards">
        <li v-for="lesson in shown" :key="lesson.entry" class="card" :class="lesson.status">
          <p class="cue">{{ lesson.cue }}</p>
          <p class="meta">
            {{ shortDate(lesson.date) }} · {{ scopeText(lesson) }} ·
            <button v-if="filedOf(lesson)" type="button" class="link mono" title="Открыть докладную в рубке связи" @click="toDocket(lesson)">{{ lesson.entry }}</button>
            <span v-else class="mono">{{ lesson.entry }}</span>
          </p>
          <dl v-if="stage === 'proposed' && (filedOf(lesson)?.lesson || filedOf(lesson)?.proposal)" class="details">
            <template v-if="filedOf(lesson)?.lesson"><dt>Что делать</dt><dd>{{ filedOf(lesson)!.lesson }}</dd></template>
            <template v-if="filedOf(lesson)?.proposal"><dt>Предложение</dt><dd>{{ filedOf(lesson)!.proposal }}</dd></template>
          </dl>
          <p v-if="stage !== 'proposed' && lesson.status_text && lesson.status_text !== lesson.status" class="status">{{ lesson.status_text }}</p>

          <div v-if="lesson.status === 'proposed'" class="actions">
            <button type="button" class="chip" :class="{ picked: desk.decided(lesson.entry)?.status === 'accepted' }" :aria-pressed="desk.decided(lesson.entry)?.status === 'accepted'" @click="desk.decide(lesson.entry, desk.lessonId(lesson), 'accepted')">Принять</button>
            <button type="button" class="chip" :class="{ picked: desk.decided(lesson.entry)?.status === 'declined' }" :aria-pressed="desk.decided(lesson.entry)?.status === 'declined'" @click="desk.decide(lesson.entry, desk.lessonId(lesson), 'declined')">Отклонить</button>
            <button v-if="filedOf(lesson) && reach(filedOf(lesson)!.study) === 'ok'" type="button" class="chip" @click="clarify(lesson)">Уточнить</button>
            <input
              v-if="desk.decided(lesson.entry)?.status === 'declined'"
              v-model="desk.decided(lesson.entry)!.note"
              class="note"
              type="text"
              placeholder="Причина — необязательно"
              aria-label="Причина отказа"
            />
          </div>
          <div v-else-if="lesson.status === 'accepted'" class="actions">
            <button
              type="button"
              class="chip applied"
              :class="{ picked: desk.decided(lesson.entry)?.status === 'applied' }"
              :aria-pressed="desk.decided(lesson.entry)?.status === 'applied'"
              title="Изменение уже сделано: отметить урок внедрённым"
              @click="desk.decide(lesson.entry, desk.lessonId(lesson), 'applied')"
            >
              Внедрено
            </button>
            <input
              v-if="desk.decided(lesson.entry)?.status === 'applied'"
              v-model="desk.decided(lesson.entry)!.note"
              class="note"
              type="text"
              placeholder="Где: PR, файл — необязательно"
              aria-label="Где внедрено"
            />
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/* The line of stages: three flasks joined by arrows, and the declined ones set apart. */
.line {
  display: flex;
  flex: none;
  align-items: stretch;
  gap: 4px;
  padding: 8px 4px 6px;
}

.arrow {
  align-self: center;
  color: var(--st-faint);
  font-size: 16px;
}

.stage {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  gap: 0;
  min-width: 0;
  padding: 5px 4px 4px;
  border: 1px solid rgba(155, 144, 124, 0.3);
  border-radius: 3px;
  background: rgba(14, 16, 20, 0.7);
  color: var(--st-dim);
  font: inherit;
  cursor: pointer;
}

.stage.aside {
  flex: 0.8;
  margin-left: 6px;
  border-style: dashed;
}

.stage:hover {
  border-color: rgba(243, 198, 78, 0.6);
}

.stage.on {
  background: rgba(243, 198, 78, 0.1);
  box-shadow: inset 0 -2px 0 currentColor;
}

.s-sigil {
  font-size: 11px;
  line-height: 14px;
}

.s-count {
  font-size: 20px;
  line-height: 24px;
}

.s-label {
  max-width: 100%;
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.proposed.lit {
  border-color: rgba(243, 198, 78, 0.6);
  color: var(--st-wait);
}

.proposed.lit .s-count {
  text-shadow: 0 0 10px rgba(243, 198, 78, 0.6);
}

.accepted.lit {
  border-color: rgba(95, 214, 200, 0.5);
  color: var(--st-teal);
}

.applied.lit {
  border-color: rgba(111, 207, 143, 0.45);
  color: var(--st-green);
}

.declined.lit {
  color: #b8ad98;
}

.empty {
  margin: 6px 0;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.card {
  padding: 7px 9px 8px;
  border: 1px solid rgba(214, 170, 96, 0.2);
  border-left: 3px solid #6b6457;
  border-radius: 0 3px 3px 0;
  background: rgba(20, 18, 14, 0.75);
}

.card.proposed {
  border-left-color: var(--st-title);
}

.card.accepted {
  border-left-color: var(--st-teal);
}

.card.applied {
  border-left-color: var(--st-green);
}

.cue {
  margin: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.meta,
.status {
  margin: 2px 0 0;
  color: var(--st-dim);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.meta .link {
  color: #8fd8ff;
  font-size: 12px;
}

.details {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 10px;
  margin: 6px 0 0;
  font-size: 12.5px;
}

.details dt {
  color: var(--st-dim);
}

.details dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
</style>
