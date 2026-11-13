<script setup lang="ts">
// The lab: every lesson the analyst proposed moves along one line — proposed, accepted, applied — or drops out
// declined. The stages are the lab's tabs, and each lesson is one short row: its title, id, scope and date, and on the
// right how its implementation goes. A click opens the lesson in «Переписка», where it is read, decided and followed.
import type { Lesson } from "../../types";
import { plural, shortDate, type Research } from "../research";
import { LESSON_STATE, lessonId } from "../station";
import { useConsole, type Stage } from "./console";
import { BADGE_TONE } from "./launch";

defineProps<{ research: Research }>();
const desk = useConsole();

const STAGES: { stage: Stage; sigil: string; label: [string, string, string] }[] = [
  { stage: "proposed", sigil: "◆", label: ["на решение", "на решение", "на решение"] },
  { stage: "accepted", sigil: "◇", label: ["к внедрению", "к внедрению", "к внедрению"] },
  { stage: "applied", sigil: "✓", label: ["внедрён", "внедрено", "внедрено"] },
  { stage: "declined", sigil: "✕", label: ["отклонён", "отклонено", "отклонено"] },
];

const scopeText = (lesson: Lesson) =>
  lesson.scope === "invariant" ? "общий" : lesson.scope === "domain" ? lesson.repos.join(", ") || lesson.scope_text : lesson.scope_text;
const isOpen = (lesson: Lesson) => desk.openEntry.value === lesson.entry.trim();
/** A row that stays on its tab for «Отменить» says where its lesson went. */
const movedTo = (lesson: Lesson) => (desk.isHeld(lesson) ? LESSON_STATE[lesson.status] : "");
</script>

<template>
  <section class="deck lab" data-deck="lab" aria-labelledby="deck-lab">
    <header class="deck-head">
      <span class="sigil" aria-hidden="true">⚗</span>
      <h3 id="deck-lab">Уроки</h3>
      <span class="aside">всего {{ research.proposed.length + research.accepted.length + research.applied.length + research.declined.length + research.other.length }}</span>
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

      <ul v-else class="rows" aria-label="Уроки">
        <li v-for="lesson in desk.shown.value" :key="lesson.entry" :data-entry="lesson.entry.trim()">
          <button
            type="button"
            class="row"
            :class="[lesson.status, { on: isOpen(lesson), moved: !!movedTo(lesson) }]"
            :aria-pressed="isOpen(lesson)"
            :title="lesson.title || lesson.cue"
            @click="desk.showLesson(lesson)"
          >
            <span class="r-title">{{ lesson.title || lesson.cue }}</span>
            <span class="r-meta">
              <span class="mono">{{ lessonId(lesson.entry) }}</span> · {{ scopeText(lesson) }} · {{ shortDate(lesson.date) }}<template v-if="movedTo(lesson)"> · {{ movedTo(lesson) }}</template>
            </span>
            <span v-if="desk.badgeOf(lesson)" class="r-badge" :class="BADGE_TONE[desk.badgeOf(lesson)!]">{{ desk.badgeOf(lesson) }}</span>
          </button>
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

.rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* A lesson's row: its title on one line, its id, scope and date under it, and its label on the right. */
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    "title badge"
    "meta badge";
  align-items: center;
  gap: 0 8px;
  width: 100%;
  padding: 4px 8px;
  border: 1px solid rgba(214, 170, 96, 0.2);
  border-left: 3px solid #6b6457;
  border-radius: 0 3px 3px 0;
  background: rgba(20, 18, 14, 0.75);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.row:hover {
  background: rgba(243, 198, 78, 0.06);
}

.row.on {
  border-color: rgba(243, 198, 78, 0.65);
  background: rgba(243, 198, 78, 0.1);
  box-shadow: inset 0 0 0 1px rgba(243, 198, 78, 0.25);
}

.row.proposed {
  border-left-color: var(--st-title);
}

.row.accepted {
  border-left-color: var(--st-teal);
}

.row.applied {
  border-left-color: var(--st-green);
}

.row.moved {
  opacity: 0.75;
}

.r-title {
  grid-area: title;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.r-meta {
  grid-area: meta;
  overflow: hidden;
  color: var(--st-dim);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.r-badge {
  grid-area: badge;
  padding: 0 7px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 11.5px;
  line-height: 17px;
  white-space: nowrap;
}

.r-badge.teal {
  color: var(--st-teal);
}

.r-badge.wait {
  color: var(--st-wait);
}

.r-badge.green {
  color: var(--st-green);
}

.r-badge.red {
  color: var(--st-red);
}
</style>
