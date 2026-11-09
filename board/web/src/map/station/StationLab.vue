<script setup lang="ts">
// The lab: every lesson the analyst proposed moves along one line — proposed, accepted, applied — or drops out
// declined. The stages are the lab's tabs; a card's buttons act at once, and a card whose lesson an agent implements
// shows how that goes.
import type { Lesson } from "../../types";
import { plural, shortDate, type Research } from "../research";
import { useConsole, type Stage } from "./console";
import LessonActions from "./LessonActions.vue";
import LessonImplementation from "./LessonImplementation.vue";

defineProps<{ research: Research }>();
const emit = defineEmits<{ jump: [deck: "comms"] }>();
const desk = useConsole();

const STAGES: { stage: Stage; sigil: string; label: [string, string, string] }[] = [
  { stage: "proposed", sigil: "◆", label: ["на решение", "на решение", "на решение"] },
  { stage: "accepted", sigil: "◇", label: ["к внедрению", "к внедрению", "к внедрению"] },
  { stage: "applied", sigil: "✓", label: ["внедрён", "внедрено", "внедрено"] },
  { stage: "declined", sigil: "✕", label: ["отклонён", "отклонено", "отклонено"] },
];

const scopeText = (lesson: Lesson) =>
  lesson.scope === "invariant" ? "общий" : lesson.scope === "domain" ? lesson.repos.join(", ") || lesson.scope_text : lesson.scope_text;
const filedOf = (lesson: Lesson) => desk.filed.value.get(lesson.entry.trim()) ?? null;

/** The lesson's own section, or what the analyst's docket said when the index row has none. */
const what = (lesson: Lesson) => lesson.lesson ?? filedOf(lesson)?.lesson ?? null;
const proposal = (lesson: Lesson) => lesson.proposal ?? filedOf(lesson)?.proposal ?? null;
const hasBody = (lesson: Lesson) => !!(what(lesson) || proposal(lesson) || lesson.evidence || lesson.caveats);

function toDocket(lesson: Lesson) {
  const filed = filedOf(lesson);
  if (!filed) return;
  desk.select(filed.study);
  emit("jump", "comms");
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
          :class="[item.stage, { on: desk.labStage.value === item.stage, lit: desk.listOf(item.stage).length > 0, aside: item.stage === 'declined' }]"
          :aria-pressed="desk.labStage.value === item.stage"
          @click="desk.labStage.value = item.stage"
        >
          <span class="s-sigil" aria-hidden="true">{{ item.sigil }}</span>
          <b class="s-count num">{{ desk.listOf(item.stage).length }}</b>
          <span class="s-label">{{ plural(desk.listOf(item.stage).length, ...item.label) }}</span>
        </button>
      </template>
    </nav>

    <div class="deck-body">
      <p v-if="!desk.shown.value.length" class="dim empty">
        {{ desk.labStage.value === "proposed" ? "Ничего не ждёт решения." : desk.labStage.value === "accepted" ? "Принятых и не внедрённых уроков нет." : "Здесь пока пусто." }}
      </p>

      <ul v-else class="cards">
        <li v-for="lesson in desk.shown.value" :key="lesson.entry" :data-entry="lesson.entry.trim()" class="card" :class="desk.labStage.value === 'declined' ? lesson.status : desk.labStage.value">
          <p class="title">{{ lesson.title || lesson.cue }}</p>
          <p v-if="lesson.title" class="cue">{{ lesson.cue }}</p>
          <p class="meta">
            {{ shortDate(lesson.date) }} · {{ scopeText(lesson) }} ·
            <button v-if="filedOf(lesson)" type="button" class="link mono" title="Открыть докладную в рубке связи" @click="toDocket(lesson)">{{ lesson.entry }}</button>
            <span v-else class="mono">{{ lesson.entry }}</span>
          </p>
          <template v-if="(desk.labStage.value === 'proposed' || desk.labStage.value === 'accepted') && hasBody(lesson)">
            <dl v-if="what(lesson) || proposal(lesson)" class="details">
              <template v-if="what(lesson)"><dt>Что делать</dt><dd>{{ what(lesson) }}</dd></template>
              <template v-if="proposal(lesson)"><dt>Предложение</dt><dd>{{ proposal(lesson) }}</dd></template>
            </dl>
            <details v-if="lesson.evidence || lesson.caveats" class="more">
              <summary>Подробнее</summary>
              <dl class="details">
                <template v-if="lesson.evidence"><dt>Доказательства</dt><dd class="pre">{{ lesson.evidence }}</dd></template>
                <template v-if="lesson.caveats"><dt>Оговорки</dt><dd class="pre">{{ lesson.caveats }}</dd></template>
              </dl>
            </details>
          </template>
          <p v-if="desk.labStage.value !== 'proposed' && lesson.status_text && lesson.status_text !== lesson.status" class="status">{{ lesson.status_text }}</p>

          <template v-if="desk.labStage.value === 'proposed' || desk.labStage.value === 'accepted'">
            <LessonImplementation :lesson="lesson" />
            <LessonActions :lesson="lesson" :stage="desk.labStage.value" />
          </template>
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
  container-type: inline-size;
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

.title {
  margin: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.cue {
  margin: 1px 0 0;
  color: var(--st-dim);
  font-size: 12.5px;
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

.details dd.pre {
  white-space: pre-wrap;
}

.more {
  margin-top: 4px;
  font-size: 12.5px;
}

.more summary {
  color: #8fd8ff;
  cursor: pointer;
}

/* On a narrow card the labels stand above their text. */
@container (max-width: 340px) {
  .details {
    grid-template-columns: minmax(0, 1fr);
  }

  .details dd {
    margin-bottom: 4px;
  }
}
</style>
