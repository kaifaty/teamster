<script setup lang="ts">
// The comms room: every study is a channel, and the open channel shows its conversation — the order, the
// analyst's reports with dockets and questions, the human's replies, and under them the reply to send.
import { nextTick, ref, watch } from "vue";
import { formatClock } from "../../lib/format";
import type { Study, StudyMessage } from "../../types";
import analystPortrait from "../art/portrait-analyst.jpg";
import archivistPortrait from "../art/portrait-archivist.jpg";
import { plural, type Research } from "../research";
import { LESSON_STATE, STATE_TEXT, docketParts, docketPlacement, openQuestionsAt, studyKey, studyState, studyTitle } from "../station";
import { useConsole } from "./console";
import LessonActions from "./LessonActions.vue";
import LessonImplementation from "./LessonImplementation.vue";
import StationReply from "./StationReply.vue";

defineProps<{ research: Research; now: number }>();
const desk = useConsole();

const EXECUTOR: Record<string, string> = { claude: "Claude", codex: "Codex" };
const MODE: Record<Study["mode"], string> = { batch: "пакет", study: "по приказу" };
const SCOPE: Record<"invariant" | "domain", string> = { invariant: "общий", domain: "по проекту" };

function speaker(study: Study, message: StudyMessage, at: number): string {
  if (message.from === "analyst") return `Аналитик · ${EXECUTOR[study.executor] ?? study.executor}`;
  return at === 0 ? "Ты · приказ" : "Ты · ответ";
}

const docketsOf = (study: Study) => docketPlacement(study.messages);
/** The index row of a docket, with what its card shows: the buttons and the implementation's line. */
function docket(entry: string) {
  const lesson = desk.index.value.get(entry.trim());
  return lesson ? { lesson, ...docketParts(lesson, desk.cardOf(lesson)) } : null;
}

// A newly opened channel shows its latest turn, where the questions wait.
const talk = ref<HTMLElement | null>(null);
watch(
  () => desk.openKey.value,
  async () => {
    await nextTick();
    if (talk.value) talk.value.scrollTop = talk.value.scrollHeight;
  },
  { immediate: true },
);

const waitingCount = (studies: readonly Study[]) => studies.filter((study) => study.waiting).length;
</script>

<template>
  <section class="deck comms" data-deck="comms" aria-labelledby="deck-comms">
    <header class="deck-head">
      <span class="sigil" aria-hidden="true">⌁</span>
      <h3 id="deck-comms">Рубка связи</h3>
      <span class="aside">
        {{ research.studies.length }} {{ plural(research.studies.length, "канал", "канала", "каналов") }}<template v-if="waitingCount(research.studies)"> · <b class="wait">ждут ответа {{ waitingCount(research.studies) }}</b></template>
      </span>
    </header>

    <div class="room">
      <p v-if="!research.studies.length" class="keeper empty">
        <img :src="archivistPortrait" alt="" class="mini" />
        <span>Каналов пока нет. Нажми «Обсудить» на уроке или отдай приказ — аналитик откроет канал.</span>
      </p>

      <ul v-else class="channels" aria-label="Каналы">
        <li v-for="study in research.studies" :key="studyKey(study)">
          <button
            type="button"
            class="channel"
            :class="[studyState(study), { on: desk.openKey.value === studyKey(study) }]"
            :aria-pressed="desk.openKey.value === studyKey(study)"
            @click="desk.select(study)"
          >
            <span class="lamp" aria-hidden="true"></span>
            <span class="c-title">{{ studyTitle(study) }}</span>
            <span class="c-meta">{{ MODE[study.mode] }} · {{ formatClock(study.updated_at, now) }}</span>
            <span class="c-state">{{ STATE_TEXT[studyState(study)] }}</span>
          </button>
        </li>
      </ul>

      <article v-if="desk.openStudy.value" class="screen" :class="studyState(desk.openStudy.value)" aria-live="polite">
        <header class="s-head">
          <b class="s-title">{{ studyTitle(desk.openStudy.value) }}</b>
          <span class="s-meta">
            {{ MODE[desk.openStudy.value.mode] }} · записей {{ desk.openStudy.value.records }} ·
            {{ EXECUTOR[desk.openStudy.value.executor] ?? desk.openStudy.value.executor }}<template v-if="desk.openStudy.value.account"> · {{ desk.openStudy.value.account }}</template>
            · <span class="mono">{{ desk.openStudy.value.slug }}</span>
          </span>
        </header>

        <ol ref="talk" class="talk">
          <li
            v-for="(message, at) in desk.openStudy.value.messages"
            :key="`${message.from}-${message.at}-${at}`"
            class="msg"
            :class="message.from"
          >
            <img v-if="message.from === 'analyst'" :src="analystPortrait" alt="" class="avatar" />
            <div class="bubble-wrap">
              <span class="who">{{ speaker(desk.openStudy.value, message, at) }} · <time :datetime="new Date(message.at * 1000).toISOString()">{{ formatClock(message.at, now) }}</time></span>
              <p v-if="message.from === 'lead'" class="bubble">{{ message.text ?? "Плановый разбор, без особого приказа." }}</p>
              <p v-else-if="message.text" class="bubble">{{ message.text }}</p>

              <!-- Dockets: a lesson's card stands at the last report that carries it. -->
              <template v-for="lesson in message.lessons" :key="lesson.id">
                <article
                  v-if="docketsOf(desk.openStudy.value).get(lesson.id) === at"
                  class="docket"
                  :class="desk.index.value.get(lesson.entry.trim())?.status ?? 'unindexed'"
                >
                  <header class="d-head">
                    <span>Докладная · {{ lesson.id }}<template v-if="lesson.scope"> · {{ SCOPE[lesson.scope] }}</template></span>
                    <span v-if="desk.index.value.get(lesson.entry.trim()) && desk.index.value.get(lesson.entry.trim())!.status !== 'proposed'" class="d-state">
                      {{ LESSON_STATE[desk.index.value.get(lesson.entry.trim())!.status] || desk.index.value.get(lesson.entry.trim())!.status_text }}
                    </span>
                  </header>
                  <dl class="d-body">
                    <dt>Когда</dt>
                    <dd>{{ lesson.cue }}</dd>
                    <template v-if="lesson.lesson"><dt>Что делать</dt><dd>{{ lesson.lesson }}</dd></template>
                    <template v-if="lesson.proposal"><dt>Предложение</dt><dd>{{ lesson.proposal }}</dd></template>
                  </dl>
                  <LessonImplementation v-if="docket(lesson.entry)?.implementation" :lesson="docket(lesson.entry)!.lesson" />
                  <LessonActions v-if="docket(lesson.entry)?.actions" :lesson="docket(lesson.entry)!.lesson" stage="proposed" />
                </article>
                <span v-else class="d-moved">докладная {{ lesson.id }} — пересмотрена ниже</span>
              </template>

              <!-- Questions: live only in the last report of a waiting study. -->
              <div v-if="message.questions.length" class="questions" :class="{ live: openQuestionsAt(desk.openStudy.value) === at }">
                <div v-for="(question, number) in message.questions" :key="number" class="question">
                  <p class="q-text"><span class="q-num">{{ number + 1 }}.</span> {{ question.text }}</p>
                  <div v-if="openQuestionsAt(desk.openStudy.value) === at && desk.replyReach(desk.openStudy.value) === 'ok'" class="q-answers">
                    <button
                      v-for="option in question.options"
                      :key="option"
                      type="button"
                      class="chip"
                      :class="{ picked: desk.answersOf(desk.openStudy.value)[number] === option }"
                      :aria-pressed="desk.answersOf(desk.openStudy.value)[number] === option"
                      @click="desk.choose(desk.openStudy.value, number, option)"
                    >
                      {{ option }}
                    </button>
                    <input
                      v-if="!question.options.length || desk.customOf(desk.openStudy.value)[number]"
                      v-model="desk.answersOf(desk.openStudy.value)[number]"
                      class="note"
                      type="text"
                      placeholder="Твой ответ"
                      :aria-label="`Ответ на вопрос ${number + 1}`"
                    />
                    <button v-else type="button" class="chip ghost" @click="desk.ownAnswer(desk.openStudy.value, number)">Свой ответ</button>
                  </div>
                </div>
              </div>
            </div>
          </li>
          <li v-if="desk.echoOf(desk.openStudy.value)" class="msg lead">
            <div class="bubble-wrap">
              <span class="who">Ты · ответ · только что</span>
              <p class="bubble">{{ desk.echoOf(desk.openStudy.value)!.text }}</p>
            </div>
          </li>
          <li v-if="desk.openStudy.value.alive || desk.echoOf(desk.openStudy.value)" class="keeper inline">
            <img :src="analystPortrait" alt="" class="mini" />
            <span>Аналитик читает записи<span class="dots" aria-hidden="true"></span></span>
          </li>
          <li v-else-if="studyState(desk.openStudy.value) === 'failed'" class="keeper inline bad">
            <img :src="archivistPortrait" alt="" class="mini" />
            <span>Ход прервался{{ desk.openStudy.value.error ? `: ${desk.openStudy.value.error}` : "" }}. Повтори приказ или ответь аналитику «продолжай».</span>
          </li>
        </ol>
        <StationReply :study="desk.openStudy.value" />
      </article>
      <p v-else-if="research.studies.length" class="pick dim">Выбери канал слева.</p>
    </div>
  </section>
</template>

<style scoped>
.wait {
  color: var(--st-wait);
  font-weight: 600;
}

/* Channels beside the screen on a wide deck, above it on a narrow one. */
.comms {
  container-type: inline-size;
}

.room {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  gap: 8px;
  min-height: 0;
  padding-top: 8px;
}

@container (min-width: 620px) {
  .room {
    grid-template-columns: 220px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }

  .room .channels {
    max-height: none;
  }
}

.empty {
  grid-column: 1 / -1;
}

.channels {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 150px;
  margin: 0;
  padding: 0 2px 0 0;
  overflow-y: auto;
  list-style: none;
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

.channel {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  grid-template-areas:
    "lamp title title"
    ". meta state";
  gap: 1px 8px;
  align-items: baseline;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid rgba(95, 214, 200, 0.16);
  border-radius: 3px;
  background: rgba(14, 20, 24, 0.6);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.channel:hover {
  background: rgba(95, 214, 200, 0.08);
}

.channel.on {
  border-color: rgba(95, 214, 200, 0.7);
  background: rgba(95, 214, 200, 0.12);
  box-shadow: inset 3px 0 0 var(--st-teal);
}

.channel.waiting {
  border-color: rgba(243, 198, 78, 0.55);
}

.channel.waiting.on {
  box-shadow: inset 3px 0 0 var(--st-wait);
}

.channel.failed {
  border-color: rgba(255, 141, 122, 0.45);
}

.lamp {
  grid-area: lamp;
  align-self: center;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6b6457;
}

.working .lamp {
  background: var(--st-teal);
  box-shadow: 0 0 6px var(--st-teal);
}

.waiting .lamp {
  background: var(--st-wait);
  box-shadow: 0 0 6px var(--st-wait);
  animation: st-blink 1.4s ease-in-out infinite;
}

.failed .lamp {
  background: var(--st-red);
}

.c-title {
  display: -webkit-box;
  grid-area: title;
  overflow: hidden;
  font-weight: 600;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
}

.c-meta {
  grid-area: meta;
  overflow: hidden;
  color: var(--st-dim);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-state {
  grid-area: state;
  color: var(--st-dim);
  font-size: 12px;
  white-space: nowrap;
}

.waiting .c-state {
  color: var(--st-wait);
}

.working .c-state {
  color: var(--st-teal);
}

.failed .c-state {
  color: var(--st-red);
}

/* The channel's screen. */
.screen {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid rgba(95, 214, 200, 0.2);
  border-radius: 3px;
  background: rgba(3, 8, 10, 0.72);
  box-shadow: inset 0 0 40px rgba(95, 214, 200, 0.05);
}

.screen.waiting {
  border-color: rgba(243, 198, 78, 0.45);
}

.s-head {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 1px;
  padding: 7px 10px;
  border-bottom: 1px solid rgba(95, 214, 200, 0.14);
}

.s-title {
  overflow-wrap: anywhere;
}

.s-meta {
  color: var(--st-dim);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.pick {
  margin: 0;
  padding: 12px;
}

.talk {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 2px 10px 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
  list-style: none;
  scrollbar-width: thin;
  scrollbar-color: rgba(95, 214, 200, 0.3) transparent;
}

.msg {
  display: flex;
  gap: 8px;
  margin: 10px 0 0;
}

.msg.lead {
  justify-content: flex-end;
}

.avatar {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  box-shadow: 0 0 0 1px rgba(95, 214, 200, 0.6);
}

.bubble-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  max-width: 86%;
}

.lead .bubble-wrap {
  align-items: flex-end;
}

.who {
  color: var(--st-dim);
  font-size: 11.5px;
}

.bubble {
  margin: 0;
  padding: 7px 10px;
  border-radius: 3px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.analyst .bubble {
  border: 1px solid rgba(95, 214, 200, 0.25);
  background: rgba(95, 214, 200, 0.08);
}

.lead .bubble {
  border: 1px solid rgba(243, 194, 122, 0.3);
  background: rgba(243, 194, 122, 0.1);
}

.keeper.inline {
  margin: 8px 0 2px;
}

/* A docket: a lesson with the decision it waits for. */
.docket {
  padding: 7px 10px 8px;
  border: 1px solid rgba(214, 170, 96, 0.3);
  border-left: 3px solid var(--st-title);
  border-radius: 0 3px 3px 0;
  background: rgba(20, 18, 14, 0.85);
}

.docket.accepted {
  border-left-color: var(--st-teal);
}

.docket.applied {
  border-left-color: var(--st-green);
}

.docket.unindexed,
.docket.declined {
  border-left-color: #6b6457;
}

.docket.declined {
  opacity: 0.8;
}

.d-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--st-title);
  font-size: 12px;
  font-weight: 600;
}

.d-state {
  color: #9cc2bc;
  font-weight: 400;
}

.d-body {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 10px;
  margin: 6px 0 0;
}

.d-body dt {
  color: var(--st-dim);
}

.d-body dd {
  margin: 0;
  overflow-wrap: anywhere;
}


.d-moved {
  color: var(--st-faint);
  font-size: 12px;
  font-style: italic;
}

/* Questions that wait for the human glow gold. */
.questions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(155, 144, 124, 0.3);
  border-radius: 3px;
}

.questions.live {
  border-color: rgba(243, 198, 78, 0.7);
  background: rgba(243, 198, 78, 0.07);
}

.q-text {
  margin: 0;
  overflow-wrap: anywhere;
}

.q-num {
  color: var(--st-title);
  font-weight: 600;
}

.q-answers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

@media (prefers-reduced-motion: reduce) {
  .waiting .lamp {
    animation: none;
  }
}
</style>
