<script setup lang="ts">
// The comms room: every study is a channel, and the open channel shows its conversation — the order, the analyst's
// reports with dockets and questions, the human's replies, the analyst's work as it goes while it works, and under them
// the reply to send. A study just ordered is a
// channel at once, with its request and the start's steps, until the research shows it. A lesson opened from the
// lab, a docket or the line «what next» takes the screen instead of the channel.
import { computed, nextTick, ref, watch } from "vue";
import { formatClock } from "../../lib/format";
import type { Study, StudyMessage } from "../../types";
import analystPortrait from "../art/portrait-analyst.jpg";
import archivistPortrait from "../art/portrait-archivist.jpg";
import { plural, type Research } from "../research";
import { STATE_TEXT, docketPlacement, openQuestionsAt, studyState, studyTitle } from "../station";
import AgentFeed from "./AgentFeed.vue";
import { useConsole } from "./console";
import { useFollow } from "./feed";
import LaunchSteps from "./LaunchSteps.vue";
import LessonThread from "./LessonThread.vue";
import StationReply from "./StationReply.vue";
import StudyDocket from "./StudyDocket.vue";

defineProps<{ research: Research; now: number }>();
const desk = useConsole();

const EXECUTOR: Record<string, string> = { claude: "Claude", codex: "Codex" };
const MODE: Record<Study["mode"], string> = { batch: "плановый", study: "по запросу" };

function speaker(study: Study, message: StudyMessage, at: number): string {
  if (message.from === "analyst") return `Аналитик · ${EXECUTOR[study.executor] ?? study.executor}`;
  return at === 0 ? "Ты · запрос" : "Ты · ответ";
}

const docketsOf = (study: Study) => docketPlacement(study.messages);

/** What the screen shows: the open lesson, a channel just ordered, or a study's channel. */
const lesson = computed(() => desk.openLesson.value);
const waitingStudy = computed(() => (lesson.value ? null : desk.openPending.value));
const study = computed(() => (lesson.value || waitingStudy.value ? null : desk.openStudy.value));
const isOn = (key: string) => !lesson.value && desk.openKey.value === key;

// A newly opened channel shows its latest turn, where the questions wait.
const talk = ref<HTMLElement | null>(null);
watch(
  () => [desk.openKey.value, !!lesson.value],
  async () => {
    await nextTick();
    if (talk.value) talk.value.scrollTop = talk.value.scrollHeight;
  },
  { immediate: true },
);

// The open channel follows the analyst's work while the human reads its end; scrolled up, it offers «Новые действия ↓».
const feedCount = () => (desk.feedShown.value ? (desk.feed.value?.items.length ?? 0) : 0);
const follow = useFollow(
  talk,
  () => `${study.value?.messages.length ?? ""}|${study.value?.alive ?? ""}`,
  feedCount,
  () => (study.value ? desk.echoOf(study.value)?.text : null),
);

const waitingCount = (studies: readonly Study[]) => studies.filter((item) => item.waiting).length;
</script>

<template>
  <section class="deck comms" data-deck="comms" aria-labelledby="deck-comms">
    <header class="deck-head">
      <span class="sigil" aria-hidden="true">⌁</span>
      <h3 id="deck-comms">Переписка</h3>
      <span class="aside">
        {{ research.studies.length }} {{ plural(research.studies.length, "канал", "канала", "каналов") }}<template v-if="waitingCount(research.studies)"> · <b class="wait">ждут ответа {{ waitingCount(research.studies) }}</b></template>
      </span>
    </header>

    <div class="room">
      <p v-if="!desk.channels.value.length && !lesson" class="keeper empty">
        <img :src="archivistPortrait" alt="" class="mini" />
        <span>Разговоров пока нет. Нажми «Обсудить» на уроке или запусти разбор — аналитик ответит здесь.</span>
      </p>

      <ul v-if="desk.channels.value.length" class="channels" aria-label="Каналы">
        <li v-for="channel in desk.channels.value" :key="channel.key">
          <button
            v-if="channel.pending"
            type="button"
            class="channel working"
            :class="{ on: isOn(channel.key) }"
            :aria-pressed="isOn(channel.key)"
            @click="desk.showPending(channel.pending)"
          >
            <span class="lamp" aria-hidden="true"></span>
            <span class="c-title">{{ channel.pending.order?.split("\n")[0] || (channel.pending.mode === "batch" ? "Плановый разбор" : "Разбор по запросу") }}</span>
            <span class="c-meta">{{ MODE[channel.pending.mode] }} · {{ formatClock(channel.pending.at, now) }}</span>
            <span class="c-state">{{ desk.pendingLaunch(channel.pending)?.stage === "failed" ? "не запустился" : "запускается" }}</span>
          </button>
          <button
            v-else-if="channel.study"
            type="button"
            class="channel"
            :class="[studyState(channel.study), { on: isOn(channel.key) }]"
            :aria-pressed="isOn(channel.key)"
            @click="desk.select(channel.study)"
          >
            <span class="lamp" aria-hidden="true"></span>
            <span class="c-title">{{ studyTitle(channel.study) }}</span>
            <span class="c-meta">{{ MODE[channel.study.mode] }} · {{ formatClock(channel.study.updated_at, now) }}</span>
            <span class="c-state">{{ STATE_TEXT[studyState(channel.study)] }}</span>
          </button>
        </li>
      </ul>

      <LessonThread v-if="lesson" :key="lesson.entry" :lesson="lesson" :now="now" />

      <article v-else-if="waitingStudy" class="screen working">
        <header class="s-head">
          <b class="s-title">{{ waitingStudy.order?.split("\n")[0] || (waitingStudy.mode === "batch" ? "Плановый разбор" : "Разбор по запросу") }}</b>
          <span class="s-meta">{{ MODE[waitingStudy.mode] }}<template v-if="waitingStudy.slug"> · <span class="mono">{{ waitingStudy.slug }}</span></template></span>
        </header>
        <ol ref="talk" class="talk" aria-live="polite">
          <li class="msg lead">
            <div class="bubble-wrap">
              <span class="who">Ты · запрос · {{ formatClock(waitingStudy.at, now) }}</span>
              <p class="bubble">{{ waitingStudy.order ?? "Плановый разбор, без особого запроса." }}</p>
            </div>
          </li>
          <li v-if="desk.pendingLaunch(waitingStudy)" class="msg">
            <LaunchSteps :launch="desk.pendingLaunch(waitingStudy)!" :now="now">
              <template #failed>
                <span><button type="button" class="chip" @click="desk.dropPending(waitingStudy)">Убрать канал</button></span>
              </template>
            </LaunchSteps>
          </li>
          <li v-if="desk.pendingLaunch(waitingStudy)?.stage !== 'failed'" class="keeper inline">
            <img :src="analystPortrait" alt="" class="mini" />
            <span>Аналитик скоро начнёт читать записи<span class="dots" aria-hidden="true"></span></span>
          </li>
        </ol>
      </article>

      <article v-else-if="study" class="screen" :class="studyState(study)" aria-live="polite">
        <header class="s-head">
          <b class="s-title">{{ studyTitle(study) }}</b>
          <span class="s-meta">
            {{ MODE[study.mode] }} · записей {{ study.records }} ·
            {{ EXECUTOR[study.executor] ?? study.executor }}<template v-if="study.account"> · {{ study.account }}</template>
            · <span class="mono">{{ study.slug }}</span>
          </span>
        </header>

        <ol ref="talk" class="talk" @scroll.passive="follow.onScroll">
          <li v-for="(message, at) in study.messages" :key="`${message.from}-${message.at}-${at}`" class="msg" :class="message.from">
            <img v-if="message.from === 'analyst'" :src="analystPortrait" alt="" class="avatar" />
            <div class="bubble-wrap">
              <span class="who">{{ speaker(study, message, at) }} · <time :datetime="new Date(message.at * 1000).toISOString()">{{ formatClock(message.at, now) }}</time></span>
              <p v-if="message.from === 'lead'" class="bubble">{{ message.text ?? "Плановый разбор, без особого запроса." }}</p>
              <p v-else-if="message.text" class="bubble">{{ message.text }}</p>

              <!-- Dockets: a lesson's card stands at the last report that carries it. -->
              <template v-for="item in message.lessons" :key="item.id">
                <StudyDocket v-if="docketsOf(study).get(item.id) === at" :item="item" />
                <span v-else class="d-moved">урок {{ item.id }} — пересмотрен ниже</span>
              </template>

              <!-- Questions: live only in the last report of a waiting study. -->
              <div v-if="message.questions.length" class="questions" :class="{ live: openQuestionsAt(study) === at }">
                <div v-for="(question, number) in message.questions" :key="number" class="question">
                  <p class="q-text"><span class="q-num">{{ number + 1 }}.</span> {{ question.text }}</p>
                  <div v-if="openQuestionsAt(study) === at && desk.replyReach(study) === 'ok'" class="q-answers">
                    <button
                      v-for="option in question.options"
                      :key="option"
                      type="button"
                      class="chip"
                      :class="{ picked: desk.answersOf(study)[number] === option }"
                      :aria-pressed="desk.answersOf(study)[number] === option"
                      @click="desk.choose(study, number, option)"
                    >
                      {{ option }}
                    </button>
                    <input
                      v-if="!question.options.length || desk.customOf(study)[number]"
                      v-model="desk.answersOf(study)[number]"
                      class="note"
                      type="text"
                      placeholder="Твой ответ"
                      :aria-label="`Ответ на вопрос ${number + 1}`"
                    />
                    <button v-else type="button" class="chip ghost" @click="desk.ownAnswer(study, number)">Свой ответ</button>
                  </div>
                </div>
              </div>
            </div>
          </li>
          <li v-if="desk.echoOf(study)" class="msg lead">
            <div class="bubble-wrap">
              <span class="who">
                Ты · ответ · только что<template v-if="desk.echoOf(study)!.state === 'sending'"> · <span class="sending">отправляется<span class="dots" aria-hidden="true"></span></span></template>
                <template v-else-if="desk.echoOf(study)!.state === 'failed'"> · <span class="unsent">не отправлено</span></template>
              </span>
              <p class="bubble">{{ desk.echoOf(study)!.text }}</p>
              <p v-if="desk.echoOf(study)!.state === 'failed'" class="fail" role="alert">{{ desk.echoOf(study)!.error }}</p>
            </div>
          </li>
          <template v-if="study.alive || (desk.echoOf(study) && desk.echoOf(study)!.state !== 'failed')">
            <li v-if="desk.feedShown.value" class="msg work">
              <AgentFeed who="Аналитик" :now="now" />
            </li>
            <li v-else class="keeper inline">
              <img :src="analystPortrait" alt="" class="mini" />
              <span>Аналитик читает записи<span class="dots" aria-hidden="true"></span></span>
            </li>
          </template>
          <li v-else-if="studyState(study) === 'failed'" class="keeper inline bad">
            <img :src="archivistPortrait" alt="" class="mini" />
            <span>Ход прервался{{ study.error ? `: ${study.error}` : "" }}. Запусти разбор снова или ответь аналитику «продолжай».</span>
          </li>
          <li v-if="follow.fresh.value" class="news">
            <button type="button" class="news-key" @click="follow.down">Новые действия ↓</button>
          </li>
        </ol>
        <StationReply :study="study" />
      </article>
      <p v-else-if="desk.channels.value.length" class="pick dim">Выбери канал слева или урок справа.</p>
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

/* Without channels the lesson takes the whole room. */
.room > :deep(.thread):first-child {
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

.msg.work > * {
  flex: 1;
}

/* Stands at the bottom edge of the channel while news came above the part being read. */
.news {
  position: sticky;
  bottom: 4px;
  display: flex;
  justify-content: center;
  margin-top: 8px;
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

.sending {
  color: var(--st-teal);
}

.unsent,
.fail {
  color: #ff9d8a;
}

.fail {
  margin: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
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
