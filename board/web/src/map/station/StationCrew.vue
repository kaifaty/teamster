<script setup lang="ts">
// The crew: the analyst, the reflection itself, and the archive keeper, who tells what the board knows without an
// agent. Each card shows the post's state with a lamp; the analyst's card opens the study it is busy with.
import { computed } from "vue";
import { formatDuration } from "../../lib/format";
import analystPortrait from "../art/portrait-analyst.jpg";
import archivistPortrait from "../art/portrait-archivist.jpg";
import { plural, type Research } from "../research";
import { analystOnDuty, studyTitle, workingSince, type AnalystState } from "../station";
import { useConsole } from "./console";

const props = defineProps<{ research: Research; now: number }>();
const desk = useConsole();

const EXECUTOR: Record<string, string> = { claude: "Claude", codex: "Codex" };
const duty = computed(() => analystOnDuty(props.research.studies));

const ANALYST: Record<AnalystState, string> = {
  working: "работает",
  waiting: "ждёт твоего ответа",
  failed: "ход прервался",
  free: "свободен",
};

const analystLine = computed(() => {
  const { state, study } = duty.value;
  if (state === "working") {
    const since = workingSince(props.research);
    return since !== null ? `${ANALYST.working} · ${formatDuration(props.now - since)}` : ANALYST.working;
  }
  if (state === "waiting" && props.research.waiting > 1) return `${ANALYST.waiting} · ${props.research.waiting} ${plural(props.research.waiting, "канал", "канала", "каналов")}`;
  return study || state !== "free" ? ANALYST[state] : "свободен";
});

const analystNote = computed(() => {
  const study = duty.value.study;
  if (!study) return "Разбирает записи задач, предлагает уроки и задаёт вопросы.";
  const who = [EXECUTOR[study.executor] ?? study.executor, study.account].filter(Boolean).join(" · ");
  return `${who} · «${studyTitle(study)}»`;
});

const keeperLine = computed(() => {
  const { records, signals } = props.research.pending;
  if (!records) return "всё разобрано";
  return `не разобрано ${records} ${plural(records, "запись", "записи", "записей")}${signals ? `, ${signals} с сигналом` : ""}`;
});
const lessons = computed(() => {
  const r = props.research;
  return r.proposed.length + r.accepted.length + r.applied.length + r.declined.length + r.other.length;
});
</script>

<template>
  <section class="deck crew" data-deck="crew" aria-labelledby="deck-crew">
    <header class="deck-head">
      <span class="sigil" aria-hidden="true">☉</span>
      <h3 id="deck-crew">Агенты</h3>
      <span class="aside">{{ research.studies.length }} {{ plural(research.studies.length, "разговор", "разговора", "разговоров") }} за 30 дней</span>
    </header>
    <div class="deck-body">
      <button
        type="button"
        class="member analyst"
        :class="duty.state"
        :disabled="!duty.study"
        :title="duty.study ? 'Открыть этот разговор в переписке' : undefined"
        @click="duty.study && desk.select(duty.study)"
      >
        <img class="face" :src="analystPortrait" alt="" />
        <span class="who">
          <b>Аналитик</b>
          <span class="state"><i class="lamp" aria-hidden="true"></i>{{ analystLine }}</span>
          <span class="note ellipsis">{{ analystNote }}</span>
        </span>
      </button>
      <div class="member keeper-card">
        <img class="face" :src="archivistPortrait" alt="" />
        <span class="who">
          <b>Архив</b>
          <span class="state"><i class="lamp" aria-hidden="true"></i>на посту · {{ keeperLine }}</span>
          <span class="note">Уроков в индексе: {{ lessons }}. Считает сам, без агента.</span>
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.deck-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.member {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid rgba(214, 170, 96, 0.18);
  border-radius: 3px;
  background: rgba(14, 16, 20, 0.7);
  color: inherit;
  font: inherit;
  text-align: left;
}

button.member {
  cursor: pointer;
}

button.member:hover:not(:disabled) {
  border-color: rgba(95, 214, 200, 0.5);
}

button.member:disabled {
  cursor: default;
}

.face {
  flex: none;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  object-fit: cover;
  box-shadow: 0 0 0 2px var(--st-teal);
}

.keeper-card .face {
  box-shadow: 0 0 0 2px var(--st-amber);
}

.waiting .face {
  box-shadow: 0 0 0 2px var(--st-wait), 0 0 14px rgba(243, 198, 78, 0.55);
}

.failed .face {
  box-shadow: 0 0 0 2px var(--st-red);
}

.free .face {
  box-shadow: 0 0 0 2px rgba(95, 214, 200, 0.4);
}

.who {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.who b {
  color: var(--st-text);
  font-weight: 650;
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--st-dim);
  font-size: 12.5px;
}

.lamp {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6b6457;
}

.working .state {
  color: var(--st-teal);
}

.working .lamp {
  background: var(--st-teal);
  box-shadow: 0 0 6px var(--st-teal);
  animation: st-blink 1.6s ease-in-out infinite;
}

.waiting .state {
  color: var(--st-wait);
}

.waiting .lamp {
  background: var(--st-wait);
  box-shadow: 0 0 6px var(--st-wait);
}

.failed .state {
  color: var(--st-red);
}

.failed .lamp {
  background: var(--st-red);
}

.keeper-card .state {
  color: #d9c7a4;
}

.keeper-card .lamp {
  background: var(--st-amber);
  box-shadow: 0 0 5px var(--st-amber);
}

.note {
  color: var(--st-faint);
  font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .working .lamp {
    animation: none;
  }
}
</style>
