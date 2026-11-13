<script setup lang="ts">
// A lesson open in «Переписка»: its head, its whole text to read, and its implementation as a thread by time — your
// request, the start's steps, the task's state with its phase and the agent's last action, and your replies. Under the
// thread stand the lesson's buttons and, while the agent waits, the reply to it.
import { computed, nextTick, ref, watch } from "vue";
import { formatClock } from "../../lib/format";
import type { Lesson } from "../../types";
import { shortDate } from "../research";
import { LESSON_STATE, implementationLine, lessonId, outsideOf, studyTitle } from "../station";
import AgentReply from "./AgentReply.vue";
import { useConsole } from "./console";
import LaunchSteps from "./LaunchSteps.vue";
import LessonActions from "./LessonActions.vue";
import LessonImplementation from "./LessonImplementation.vue";

const props = defineProps<{ lesson: Lesson; now: number }>();
const desk = useConsole();

const entry = computed(() => props.lesson.entry.trim());
const filed = computed(() => desk.filed.value.get(entry.value) ?? null);
/** The lesson's own section, or what the analyst's docket said when the index row has none. */
const what = computed(() => props.lesson.lesson ?? filed.value?.lesson ?? null);
const proposal = computed(() => props.lesson.proposal ?? filed.value?.proposal ?? null);
const outside = computed(() => outsideOf(props.lesson));
const scope = computed(() => {
  const lesson = props.lesson;
  return lesson.scope === "invariant" ? "общий" : lesson.scope === "domain" ? lesson.repos.join(", ") || lesson.scope_text : lesson.scope_text;
});
const badge = computed(() => desk.badgeOf(props.lesson));
const state = computed(() => badge.value ?? (LESSON_STATE[props.lesson.status] || props.lesson.status_text));
const note = computed(() => {
  const text = props.lesson.status_text?.trim();
  return text && text !== props.lesson.status ? text : null;
});

const card = computed(() => desk.cardOf(props.lesson));
const ship = computed(() => desk.shipOf(props.lesson));
const launch = computed(() => desk.launchOf(props.lesson));
const said = computed(() => desk.agentOf(props.lesson).said);
const line = computed(() => implementationLine(props.lesson.implementation, card.value.started, outside.value));
/** «Ты · внедрить в …»: the request from this tab with its note, or the start the server knows of. */
const request = computed(() => {
  const own = desk.requestOf(props.lesson);
  if (own) return { repo: own.repo, note: own.note, at: own.at };
  const task = props.lesson.implementation;
  if (launch.value) return { repo: launch.value.repo ?? task?.repo ?? "", note: "", at: launch.value.started_at };
  return task ? { repo: task.repo, note: "", at: task.created } : null;
});
const stage = computed(() => (props.lesson.status === "proposed" ? "proposed" : "accepted"));
const acts = computed(() => props.lesson.status === "proposed" || props.lesson.status === "accepted" || !!card.value.done || !!card.value.error || !!card.value.copied);
const time = (at: number) => new Date(at * 1000).toISOString();

// A lesson opens at its beginning, to be read.
const scroller = ref<HTMLElement | null>(null);
watch(entry, async () => {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = 0;
});
</script>

<template>
  <article class="thread" :class="lesson.status" aria-labelledby="lesson-title">
    <header class="t-head">
      <b id="lesson-title" class="t-title">{{ lesson.title || lesson.cue }}</b>
      <span class="t-meta">
        <span class="mono">{{ lesson.entry }}</span> · {{ shortDate(lesson.date) }} · {{ scope }} · <span class="t-state">{{ state }}</span>
      </span>
      <span v-if="filed || ship" class="t-links">
        <button v-if="filed" type="button" class="link" :title="`Открыть разбор, в котором появился урок ${lessonId(lesson.entry)}`" @click="desk.select(filed.study)">
          Разбор: {{ studyTitle(filed.study) }}
        </button>
        <button v-if="ship" type="button" class="chip small" :title="`Открыть репозиторий ${ship.repo} на карте с задачей агента`" @click="desk.watchAgent(lesson)">
          Посмотреть
        </button>
      </span>
    </header>

    <div ref="scroller" class="t-scroll">
      <dl class="fields">
        <dt>Когда</dt>
        <dd>{{ lesson.cue }}</dd>
        <template v-if="what"><dt>Что делать</dt><dd>{{ what }}</dd></template>
        <template v-if="proposal"><dt>Предложение</dt><dd>{{ proposal }}</dd></template>
        <template v-if="lesson.evidence"><dt>Доказательства</dt><dd>{{ lesson.evidence }}</dd></template>
        <template v-if="lesson.caveats"><dt>Оговорки</dt><dd>{{ lesson.caveats }}</dd></template>
      </dl>
      <div v-if="outside.length" class="outside" role="note">
        <p class="o-head">Предложение меняет файлы вне репозитория</p>
        <ul class="paths mono">
          <li v-for="path in outside" :key="path">{{ path }}</li>
        </ul>
        <p class="hint">
          «Внедрить» разрешит агенту их менять: сначала копия .bak рядом, проверка на копии, без PR. Или скопируй задание
          и сделай правку в своей сессии.
        </p>
      </div>
      <p v-if="note" class="note">Заметка к решению: {{ note }}</p>

      <!-- The implementation by time: the request, the start's steps, the task's state, then your replies. -->
      <ol class="feed" aria-label="Внедрение" aria-live="polite">
        <li v-if="request" class="msg mine">
          <span class="who">Ты · внедрить в {{ request.repo }} · <time :datetime="time(request.at)">{{ formatClock(request.at, now) }}</time></span>
          <p v-if="request.note" class="bubble">{{ request.note }}</p>
        </li>
        <li v-if="launch" class="msg">
          <LaunchSteps :launch="launch" :now="now">
            <template #failed>
              <span v-if="desk.offersImplement(lesson)"><button type="button" class="key gold" @click="desk.retry(lesson)">Запустить снова</button></span>
            </template>
          </LaunchSteps>
        </li>
        <li v-if="line" class="msg">
          <LessonImplementation :lesson="lesson" />
        </li>
        <!-- The task's whole feed of messages and commands (GET /api/tasks/{slug}/feed) comes here, after the state. -->
        <li v-for="(item, number) in said" :key="number" class="msg mine">
          <span class="who">
            Ты · ответ · <time :datetime="time(item.at)">{{ formatClock(item.at, now) }}</time>
            <template v-if="item.state === 'sending'"> · <span class="sending">отправляется<span class="dots" aria-hidden="true"></span></span></template>
            <template v-else-if="item.state === 'failed'"> · <span class="failed">не отправлено</span></template>
          </span>
          <p class="bubble" :class="{ dim: item.state === 'sending' }">{{ item.text }}</p>
          <p v-if="item.state === 'failed'" class="fail" role="alert">{{ item.error }}</p>
        </li>
      </ol>
    </div>

    <footer v-if="acts || line?.answer" class="t-dock">
      <AgentReply v-if="line?.answer" :lesson="lesson" />
      <LessonActions v-if="acts" :lesson="lesson" :stage="stage" />
    </footer>
  </article>
</template>

<style scoped>
.thread {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid rgba(214, 170, 96, 0.3);
  border-left: 3px solid #6b6457;
  border-radius: 0 3px 3px 0;
  background: rgba(10, 10, 9, 0.78);
}

.thread.proposed {
  border-left-color: var(--st-title);
}

.thread.accepted {
  border-left-color: var(--st-teal);
}

.thread.applied {
  border-left-color: var(--st-green);
}

.t-head {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(214, 170, 96, 0.18);
}

.t-title {
  color: var(--st-title);
  font-size: 14px;
  overflow-wrap: anywhere;
}

.t-meta {
  color: var(--st-dim);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.t-state {
  color: #d4cab5;
}

.t-links {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  margin-top: 2px;
  font-size: 12.5px;
}

.t-scroll {
  flex: 1;
  min-height: 0;
  padding: 10px 12px 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

/* The lesson's text, readable on the wide panel; its line breaks stay. */
.fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 14px;
  max-width: 78ch;
  margin: 0;
  line-height: 19px;
}

.fields dt {
  color: var(--st-dim);
}

.fields dd {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.outside {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-width: 78ch;
  margin-top: 10px;
  padding: 6px 10px;
  border-left: 2px solid var(--st-amber);
  background: rgba(217, 162, 76, 0.08);
  font-size: 12.5px;
}

.o-head {
  margin: 0;
  color: var(--st-amber);
}

.paths {
  margin: 0;
  padding-left: 16px;
  font-size: 11.5px;
  overflow-wrap: anywhere;
}

.hint {
  margin: 0;
  color: var(--st-dim);
  font-size: 12px;
}

.note {
  max-width: 78ch;
  margin: 10px 0 0;
  color: var(--st-dim);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.feed {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 14px 0 0;
  padding: 12px 0 0;
  border-top: 1px dashed rgba(214, 170, 96, 0.2);
  list-style: none;
}

.feed:empty {
  display: none;
}

.msg {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 640px;
}

.msg.mine {
  align-items: flex-end;
  align-self: flex-end;
}

.who {
  color: var(--st-dim);
  font-size: 11.5px;
}

.bubble {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid rgba(243, 194, 122, 0.3);
  border-radius: 3px;
  background: rgba(243, 194, 122, 0.1);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.sending {
  color: var(--st-teal);
}

.failed,
.fail {
  color: #ff9d8a;
}

.fail {
  margin: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.t-dock {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px 10px;
  border-top: 1px solid rgba(214, 170, 96, 0.22);
  background: rgba(8, 8, 7, 0.7);
}

.t-dock :deep(.lesson-actions) {
  margin-top: 0;
}

@container (max-width: 480px) {
  .fields {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }

  .fields dd {
    margin-bottom: 6px;
  }
}
</style>
