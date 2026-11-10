<script setup lang="ts">
// The deck «Сейчас», the first on the bridge: the state in plain words with its facts, the route strip with the ship's
// stop, then what happens on the left — the message that set off the turn and the agent's full report, or its latest
// actions while it works — and what is needed from you on the right.
import { computed, ref, watch } from "vue";
import { formatAge, formatClock } from "../../lib/format";
import type { Cargo, TaskDetail, TaskLimits, TaskSummary } from "../../types";
import { ART } from "../art";
import { bridgeView, loopsOf, routeOf } from "./bridge";
import { REPORT_FOLD, nowOf, reportParagraphs } from "./now";
import type { ShipDesk } from "./desk";
import { causeOf, deskOf, needOf } from "./orders";
import ShipNeeds from "./ShipNeeds.vue";
import ShipTelemetry from "./ShipTelemetry.vue";

const props = defineProps<{ task: TaskSummary; detail: TaskDetail | null; desk: ShipDesk; now: number }>();

const cargo = computed<Cargo | null>(() => props.detail?.cargo ?? null);
const limits = computed<TaskLimits | null | undefined>(() => props.detail?.limits);
const view = computed(() => bridgeView(props.task));
const line = computed(() => nowOf(props.task, cargo.value, props.detail?.changes, limits.value, props.now));
const route = computed(() => routeOf(props.task, props.now));
const loops = computed(() => loopsOf(props.task, limits.value, cargo.value));
const cause = computed(() => causeOf(props.task, props.detail?.messages ?? []));
const need = computed(() => needOf(props.task, cargo.value, deskOf(props.task, props.desk.queue.value), props.now));

/** The full report from a server that sends it, else the summary's first line. */
const report = computed(() => props.detail?.report ?? props.task.summary);
const paragraphs = computed(() => (report.value ? reportParagraphs(report.value) : []));
const open = ref(false);
const folded = computed(() => !open.value && (report.value?.length ?? 0) > REPORT_FOLD);
watch(
  () => props.task.slug,
  () => (open.value = false),
);
const reportMeta = computed(() => {
  const status = props.task.result_status;
  const word = status === "done" ? "сделано" : status === "partial" ? "частично" : status === "needs_decision" ? "нужно решение" : status === "blocked" ? "заблокирована" : null;
  return [props.task.turn > 0 ? `ход ${props.task.turn}` : null, props.task.alive ? null : formatClock(props.task.updated_at, props.now), props.task.alive ? "прошлый ход" : word]
    .filter(Boolean)
    .join(" · ");
});
const working = computed(() => props.task.alive && props.task.column !== "sleeping");
const asked = computed(() => cargo.value?.questions ?? []);
</script>

<template>
  <section class="deck now" :class="`tone-${line.tone}`" aria-labelledby="now-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">◉</span>
      <h3 id="now-deck">Сейчас</h3>
      <span class="aside">обновлено {{ formatAge(task.updated_at, now) }}</span>
    </div>

    <div class="state" role="status">
      <span class="lamp" aria-hidden="true"></span>
      <p class="headline">{{ line.headline }}</p>
      <p v-if="line.facts.length" class="facts">
        <span v-for="fact in line.facts" :key="fact">{{ fact }}</span>
      </p>
    </div>

    <template v-if="view.route">
      <ol class="strip" aria-label="Маршрут корабля">
        <li v-for="stop in route.stops" :key="stop.id" :class="stop.state" :aria-current="stop.state === 'here' ? 'step' : undefined">
          <span class="ic"><img :src="ART[stop.art]" alt="" /></span>
          <span class="nm">{{ stop.name }}</span>
          <span class="pl">{{ stop.note }}</span>
        </li>
      </ol>
      <p class="where">
        <span>{{ route.line }}</span>
        <span v-for="loop in loops" :key="loop.kind" class="loop" :class="loop.kind">{{ loop.text }}</span>
      </p>
    </template>

    <div class="split" :class="{ single: !view.commands && !task.alive }">
      <div class="pane">
        <div v-if="cause" class="cause" :class="cause.tone">
          <div class="label">{{ cause.who }} <span class="meta">{{ formatClock(cause.at, now) }}</span></div>
          <p>{{ cause.text }}</p>
        </div>

        <template v-if="working">
          <div class="label">Что делает сейчас <span class="meta">последние действия</span></div>
          <ShipTelemetry :task="task" :log="detail?.activity_log ?? []" :loaded="!!detail" :now="now" :limit="6" />
        </template>
        <div v-else-if="task.kind !== 'session'" class="report">
          <div class="label">{{ cause?.tone === "you" ? "Ответ агента" : "Доклад агента" }} <span class="meta">{{ reportMeta }}</span></div>
          <div v-if="paragraphs.length" class="body" :class="{ folded }">
            <p v-for="(runs, index) in paragraphs" :key="index">
              <template v-for="(run, at) in runs" :key="at"><code v-if="run.code">{{ run.text }}</code><template v-else>{{ run.text }}</template></template>
            </p>
          </div>
          <p v-else class="empty">Агент не оставил доклада.</p>
          <button v-if="folded" type="button" class="more" @click="open = true">показать целиком</button>
        </div>
        <!-- Questions the panel on the right does not take answers to: «Вернуть на доработку» carries them. -->
        <div v-if="asked.length && need.kind !== 'questions'" class="asked">
          <div class="label">Вопросы агента <span class="meta">{{ asked.length }}</span></div>
          <ol>
            <li v-for="(question, index) in asked" :key="index">{{ question }}</li>
          </ol>
        </div>
      </div>

      <ShipNeeds v-if="task.kind !== 'session' || !task.alive" :task="task" :cargo="cargo" :desk="desk" :need="need" :limits="limits" :now="now" />
    </div>
  </section>
</template>

<style scoped>
.now.tone-wait {
  box-shadow: 0 0 0 1px rgba(243, 198, 78, 0.35), 0 0 28px rgba(243, 198, 78, 0.12);
}

.now.tone-bad {
  box-shadow: 0 0 0 1px rgba(255, 141, 122, 0.35), 0 0 28px rgba(255, 141, 122, 0.1);
}

.now.tone-ready {
  box-shadow: 0 0 0 1px rgba(111, 207, 143, 0.35), 0 0 28px rgba(111, 207, 143, 0.1);
}

.state {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 2px 12px;
  color: var(--sh-teal);
}

.tone-wait .state {
  color: var(--sh-wait);
}

.tone-bad .state {
  color: var(--sh-red);
}

.tone-ready .state {
  color: var(--sh-green);
}

.tone-sleep .state {
  color: var(--sh-ice);
}

.tone-dim .state {
  color: var(--sh-dim);
}

.lamp {
  grid-row: span 2;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 12px currentColor;
}

.tone-wait .lamp,
.tone-bad .lamp {
  animation: pulse 1.6s ease-in-out infinite;
}

.tone-work .lamp {
  animation: pulse 2.4s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.headline {
  margin: 0;
  color: var(--sh-text);
  font-size: 18px;
  font-weight: 600;
  line-height: 24px;
  text-wrap: balance;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 0;
  margin: 0;
  color: var(--sh-dim);
  font-size: 12.5px;
}

.facts span + span::before {
  content: "·";
  margin: 0 8px;
  color: var(--sh-faint);
}

/* The route strip: six small stops with the ship's lit in the state's colour. */
.strip {
  position: relative;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  margin: 0;
  padding: 6px 4px 0;
  list-style: none;
}

.strip li {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 2px;
  min-width: 0;
  text-align: center;
}

.strip li::after {
  content: "";
  position: absolute;
  top: 17px;
  left: calc(50% + 21px);
  right: calc(-50% + 21px);
  border-top: 2px dotted rgba(214, 170, 96, 0.32);
}

.strip li:last-child::after {
  display: none;
}

.ic {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 1px solid rgba(214, 170, 96, 0.18);
  border-radius: 50%;
  background: var(--sh-well);
  opacity: 0.4;
}

.ic img {
  width: 30px;
  height: 30px;
  object-fit: contain;
}

.nm {
  color: var(--sh-dim);
  font-size: 12px;
}

.pl {
  color: var(--sh-faint);
  font-size: 11px;
}

.strip li.past .ic {
  opacity: 0.85;
}

.strip li.past::after {
  border-top-style: solid;
  border-color: rgba(214, 170, 96, 0.55);
}

.strip li.here {
  color: var(--sh-teal);
}

.tone-wait .strip li.here {
  color: var(--sh-wait);
}

.tone-bad .strip li.here {
  color: var(--sh-red);
}

.tone-ready .strip li.here {
  color: var(--sh-green);
}

.strip li.here .ic {
  border: 2px solid currentColor;
  box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.04), 0 0 14px currentColor;
  opacity: 1;
}

.strip li.here .nm {
  color: var(--sh-text);
  font-weight: 600;
}

.strip li.here .pl {
  color: currentColor;
}

.where {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0;
  color: var(--sh-dim);
  font-size: 12.5px;
}

.loop.fix {
  color: var(--sh-copper);
}

.loop.ci {
  color: var(--sh-blue);
}

/* What happens, and what is needed from you. */
.split {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 1fr);
  align-items: start;
  gap: 12px;
}

.split.single {
  grid-template-columns: minmax(0, 1fr);
}

.pane {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.label {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  color: var(--sh-faint);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.label .meta {
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}

.cause {
  display: grid;
  gap: 2px;
  padding: 7px 10px;
  border-left: 2px solid var(--sh-title);
  border-radius: 0 8px 8px 0;
  background: rgba(243, 194, 122, 0.05);
}

.cause.sys {
  border-left-color: #b892ff;
  background: rgba(184, 146, 255, 0.05);
}

.cause p {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.asked {
  display: grid;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid rgba(243, 198, 78, 0.35);
  border-radius: 10px;
  background: rgba(12, 10, 4, 0.6);
}

.asked ol {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 20px;
}

.asked li {
  overflow-wrap: anywhere;
}

.report {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(214, 170, 96, 0.14);
  border-radius: 10px;
  background: var(--sh-well);
}

.body {
  display: grid;
  gap: 8px;
  max-width: 78ch;
  font-size: 13.5px;
  line-height: 21px;
}

.body p {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.body.folded {
  max-height: 320px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(#000 75%, transparent);
  mask-image: linear-gradient(#000 75%, transparent);
}

code {
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(243, 194, 122, 0.08);
  color: #f1dcb4;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.more {
  justify-self: start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--sh-title);
  font: inherit;
  font-size: 12.5px;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: pointer;
}

@media (max-width: 980px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 560px) {
  .ic {
    width: 28px;
    height: 28px;
  }

  .ic img {
    width: 24px;
    height: 24px;
  }

  .strip li::after {
    top: 13px;
    left: calc(50% + 17px);
    right: calc(-50% + 17px);
  }

  .nm {
    font-size: 11px;
  }

  .pl {
    display: none;
  }

  .strip li.here .pl {
    display: block;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lamp {
    animation: none !important;
  }
}
</style>
