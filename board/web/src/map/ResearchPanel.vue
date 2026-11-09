<script setup lang="ts">
// The research station as a conversation with its staff: the human gives orders, the analyst reports, files
// dockets with lessons and asks, the archive keeper tells what the board knows itself. Everything the human
// decides goes out as one command to paste into a terminal: the board never runs anything.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { transmission } from "../lib/commands";
import { formatAge, formatClock, formatDuration } from "../lib/format";
import type { Lesson, Study, StudyMessage } from "../types";
import analystPortrait from "./art/portrait-analyst.jpg";
import archivistPortrait from "./art/portrait-archivist.jpg";
import { SIGNALS, shortDate, type Research } from "./research";
import {
  LESSON_STATE,
  STATE_TEXT,
  docketPlacement,
  firstStudy,
  lessonsByEntry,
  openQuestionsAt,
  orderCommand,
  reach,
  replyText,
  studyKey,
  studyState,
  studyTitle,
  transmissionFor,
  turnKey,
  type Decision,
  type DecisionStatus,
  type OrderDraft,
  type OrderKind,
} from "./station";

const props = defineProps<{ research: Research; now: number; frame: string }>();
const emit = defineEmits<{ close: []; open: [slug: string] }>();

type Tab = "link" | "lessons" | "watch";
const tab = ref<Tab>("link");

// ---- the conversation

const studies = computed(() => props.research.studies);
const keyOf = (study: Study | null) => (study ? studyKey(study) : null);
const openKey = ref<string | null>(keyOf(firstStudy(props.research.studies)));
const openStudy = computed(() => studies.value.find((study) => studyKey(study) === openKey.value) ?? null);
// A study that starts waiting while the panel is open comes forward, unless the human is in another one.
watch(
  () => keyOf(firstStudy(studies.value)),
  (key) => {
    if (!openStudy.value) openKey.value = key;
  },
);

function toggle(study: Study) {
  openKey.value = openKey.value === studyKey(study) ? null : studyKey(study);
}

const index = computed(() =>
  lessonsByEntry([props.research.proposed, props.research.accepted, props.research.applied, props.research.declined, props.research.other]),
);

const EXECUTOR: Record<string, string> = { claude: "Claude", codex: "Codex" };
const MODE: Record<Study["mode"], string> = { batch: "пакет", study: "по приказу" };

function speaker(study: Study, message: StudyMessage, at: number): string {
  if (message.from === "analyst") return `Аналитик · ${EXECUTOR[study.executor] ?? study.executor}`;
  return at === 0 ? "Ты · приказ" : "Ты · ответ";
}

/** What the archive keeper says about the material since the last batch. */
const archiveLine = computed(() => {
  const { batch, pending, watched } = props.research;
  const since = batch ? `С разбора ${shortDate(batch.date)}` : "С начала архива";
  const signals = pending.signals ? `, ${pending.signals} с сигналом` : "";
  const repos = watched.slice(0, 3).map((item) => `${item.repo} ${item.count}`).join(" · ");
  return `${since} — записей ${pending.records}${signals}${repos ? ` · ${repos}` : ""}.`;
});

const headline = computed(() => {
  const parts: string[] = [];
  if (props.research.waiting) parts.push(`ждёт ответа: ${props.research.waiting}`);
  const working = studies.value.find((study) => study.alive);
  if (working) {
    const last = working.messages[working.messages.length - 1];
    parts.push(`аналитик работает ${formatDuration(props.now - (last?.at ?? working.created))}`);
  } else if (props.research.running) {
    parts.push("идёт разбор");
  }
  const proposed = props.research.proposed.length;
  if (!parts.length && proposed) parts.push(`уроков ждут решения: ${proposed}`);
  if (!parts.length) parts.push(props.research.batch ? `на станции тихо · разбор ${shortDate(props.research.batch.date)}` : "на станции тихо");
  const text = parts.join(" · ");
  return text[0]!.toUpperCase() + text.slice(1);
});

/** The transmission as the terminal will run it, one command per line. */
const lines = (command: string) => command.split(" && ").join(" &&\n");

// ---- the human's side: decisions, answers, orders

const decisions = ref<Decision[]>([]);
const decided = (entry: string) => decisions.value.find((decision) => decision.entry === entry.trim()) ?? null;

function decide(entry: string, id: string, status: DecisionStatus) {
  const key = entry.trim();
  const current = decided(key);
  if (current?.status === status) {
    decisions.value = decisions.value.filter((decision) => decision !== current);
    return;
  }
  // A reason belongs to a refusal only: accepting after a refusal drops it.
  const note = status === "declined" ? (current?.note ?? "") : "";
  decisions.value = [...decisions.value.filter((decision) => decision.entry !== key), { entry: key, id, status, note }];
}

function drop(decision: Decision) {
  decisions.value = decisions.value.filter((item) => item !== decision);
}

/** A lesson id names a staged decision, unless another one shares it: then the whole entry does. */
const chipName = (decision: Decision) =>
  decisions.value.some((other) => other !== decision && other.id === decision.id) ? decision.entry : decision.id;

/** Answers to the open questions, by the analyst's turn and question number: a new turn starts clean. */
const answers = reactive<Record<string, string[]>>({});
const answersOf = (study: Study) => (answers[turnKey(study)] ??= []);

/** Questions answered in the human's own words instead of an option. */
const custom = reactive<Record<string, boolean[]>>({});
const customOf = (study: Study) => (custom[turnKey(study)] ??= []);

function choose(study: Study, number: number, option: string) {
  const list = answersOf(study);
  list[number] = list[number] === option ? "" : option;
  customOf(study)[number] = false;
}

function ownAnswer(study: Study, number: number) {
  customOf(study)[number] = true;
  answersOf(study)[number] = "";
}

/** The free text of a reply, kept for each study. */
const drafts = reactive<Record<string, string>>({});
const free = computed({
  get: () => (openStudy.value ? (drafts[studyKey(openStudy.value)] ?? "") : ""),
  set: (text: string) => {
    if (openStudy.value) drafts[studyKey(openStudy.value)] = text;
  },
});
const replyField = ref<HTMLTextAreaElement | null>(null);

async function clarify(id: string) {
  composer.value = "reply";
  const prefix = `По уроку ${id}: `;
  if (!free.value.includes(prefix)) free.value = (free.value.trim() ? `${free.value.trim()}\n` : "") + prefix;
  await nextTick();
  const area = replyField.value;
  if (!area) return;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

const composer = ref<"reply" | "order">(firstStudy(props.research.studies) ? "reply" : "order");
const target = computed(() => openStudy.value);
const targetReach = computed(() => reach(target.value));
const questionsAt = computed(() => (target.value ? openQuestionsAt(target.value) : -1));
const openQuestions = computed(() => (target.value && questionsAt.value >= 0 ? (target.value.messages[questionsAt.value]?.questions ?? []) : []));
const reply = computed(() =>
  target.value && targetReach.value === "ok" ? replyText(openQuestions.value, answersOf(target.value), free.value) : "",
);
const replyCommand = computed(() => transmissionFor(decisions.value, target.value, reply.value));

const REACH_NOTE: Record<"working" | "closed", string> = {
  working: "Аналитик работает: ответ можно передать после его хода. Решения по урокам уйдут сейчас.",
  closed: "Исследование закрыто. Продолжить можно новым приказом.",
};

const draft = reactive<OrderDraft>({ kind: "batch", tasks: "", since: "30d", repos: "", text: "" });
const ORDER_KINDS: { kind: OrderKind; label: string }[] = [
  { kind: "batch", label: "Внеочередной разбор" },
  { kind: "tasks", label: "Разобрать задачи" },
  { kind: "question", label: "Исследовать вопрос" },
];
const ORDER_HINT: Record<OrderKind, string> = {
  batch: "Записи после последнего разбора. Фокус разбора — необязательно",
  tasks: "Что искать в этих задачах — необязательно",
  question: "Вопрос к архиву: что выяснить",
};
const ordered = computed(() => orderCommand(draft, new Date(props.now * 1000)));
/** Decisions staged on lessons go out with the order. */
const orderLine = computed(() =>
  "command" in ordered.value ? transmission([transmissionFor(decisions.value, null, ""), ordered.value.command]) : "",
);

/** A record under watch goes into a task order. */
function studyRecord(slug: string) {
  tab.value = "link";
  composer.value = "order";
  draft.kind = "tasks";
  const tasks = draft.tasks.split(/[\s,]+/).filter(Boolean);
  if (!tasks.includes(slug)) draft.tasks = [...tasks, slug].join(" ");
}

// ---- copying

const last = ref<{ command: string; copied: boolean } | null>(null);
const lastField = ref<HTMLTextAreaElement | null>(null);
const orderError = ref("");

async function send(command: string, after: () => void) {
  if (!command) return;
  let copied = false;
  try {
    if (!navigator.clipboard) throw new Error("no clipboard");
    await navigator.clipboard.writeText(command);
    copied = true;
  } catch {
    copied = false;
  }
  last.value = { command, copied };
  after();
  if (!copied) {
    await nextTick();
    lastField.value?.focus();
    lastField.value?.select();
  }
}

function sendReply() {
  const study = target.value;
  // The say goes out only when there is a text for a study that can take it; otherwise the draft stays.
  const answered = !!reply.value && !!study && targetReach.value === "ok";
  void send(replyCommand.value, () => {
    decisions.value = [];
    if (answered && study) {
      drafts[studyKey(study)] = "";
      answers[turnKey(study)] = [];
      custom[turnKey(study)] = [];
    }
  });
}

function sendOrder() {
  const result = ordered.value;
  if ("error" in result) {
    orderError.value = result.error;
    return;
  }
  orderError.value = "";
  void send(orderLine.value, () => {
    decisions.value = [];
    draft.text = "";
    draft.tasks = "";
  });
}
watch(() => ({ ...draft }), () => (orderError.value = ""));

// ---- lessons tab

const showSettled = ref(false);
const settled = computed(() => [...props.research.applied, ...props.research.declined, ...props.research.other]);
const scopeText = (lesson: Lesson) =>
  lesson.scope === "invariant" ? "общий" : lesson.scope === "domain" ? lesson.repos.join(", ") || lesson.scope_text : lesson.scope_text;
const lessonId = (entry: string) => entry.trim().split(/\s+/).pop() ?? entry;

// ---- watch tab

const runLine = computed(() => {
  const run = props.research.run;
  if (!run) return null;
  if (run.alive) {
    const started = run.phase_started_at ?? run.created;
    return started !== null ? `идёт разбор · ${formatDuration(props.now - started)}` : "идёт разбор";
  }
  return `последний запуск ${formatAge(run.updated_at, props.now)}`;
});

// ---- panel

const closeButton = ref<HTMLButtonElement | null>(null);
const onKey = (event: KeyboardEvent) => {
  if (event.key !== "Escape" || event.isComposing) return;
  // Escape in a field leaves the field; the next one closes the panel. Drafts live only while it is open.
  const field = event.target instanceof HTMLElement && event.target.closest("input, textarea, select");
  if (field) {
    (field as HTMLElement).blur();
    return;
  }
  emit("close");
};
onMounted(() => {
  closeButton.value?.focus();
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

const docketsOf = (study: Study) => docketPlacement(study.messages);
const SCOPE: Record<"invariant" | "domain", string> = { invariant: "общий", domain: "по проекту" };
</script>

<template>
  <aside class="panel" role="dialog" aria-modal="false" aria-labelledby="research-title" :style="{ '--frame': `url(${frame})` }">
    <header class="head">
      <span class="staff" aria-hidden="true">
        <img class="face analyst" :src="analystPortrait" alt="" />
        <img class="face archivist" :src="archivistPortrait" alt="" />
      </span>
      <span class="titles">
        <h2 id="research-title">Исследовательский центр</h2>
        <span class="headline" :class="{ live: research.running && !research.waiting, wait: research.waiting > 0 }">{{ headline }}</span>
      </span>
      <button ref="closeButton" type="button" class="icon" title="Закрыть (Esc)" @click="emit('close')">
        <span aria-hidden="true">✕</span><span class="visually-hidden">Закрыть</span>
      </button>
    </header>

    <nav class="tabs" aria-label="Разделы станции">
      <button type="button" :class="{ on: tab === 'link' }" :aria-pressed="tab === 'link'" @click="tab = 'link'">
        Связь<b v-if="research.waiting" class="count wait">{{ research.waiting }}</b>
      </button>
      <button type="button" :class="{ on: tab === 'lessons' }" :aria-pressed="tab === 'lessons'" @click="tab = 'lessons'">
        Уроки<b v-if="research.proposed.length" class="count">{{ research.proposed.length }}</b>
      </button>
      <button type="button" :class="{ on: tab === 'watch' }" :aria-pressed="tab === 'watch'" @click="tab = 'watch'">
        Наблюдение<b v-if="research.pending.items.length" class="count dim">{{ research.pending.items.length }}</b>
      </button>
    </nav>

    <div class="body">
      <!-- Связь: the conversation, one study at a time. -->
      <template v-if="tab === 'link'">
        <p class="keeper">
          <img :src="archivistPortrait" alt="" class="mini" />
          <span><b>Хранитель архива:</b> {{ archiveLine }}</span>
        </p>
        <p v-if="!studies.length" class="keeper">
          <img :src="archivistPortrait" alt="" class="mini" />
          <span>Исследований на станции нет. Отдай приказ ниже — аналитик возьмётся за записи.</span>
        </p>

        <section v-for="study in studies" :key="studyKey(study)" class="study" :class="[studyState(study), { open: openKey === studyKey(study) }]">
          <button type="button" class="s-head" :aria-expanded="openKey === studyKey(study)" @click="toggle(study)">
            <span class="dot" aria-hidden="true"></span>
            <span class="s-title">{{ studyTitle(study) }}</span>
            <span class="s-meta">{{ MODE[study.mode] }} · записей {{ study.records }} · {{ formatClock(study.updated_at, now) }}</span>
            <span class="s-state">{{ STATE_TEXT[studyState(study)] }}</span>
          </button>

          <ol v-if="openKey === studyKey(study)" class="talk">
            <li v-for="(message, at) in study.messages" :key="`${message.from}-${message.at}-${at}`" class="msg" :class="message.from">
              <img v-if="message.from === 'analyst'" :src="analystPortrait" alt="" class="avatar" />
              <div class="bubble-wrap">
                <span class="who">{{ speaker(study, message, at) }} · <time :datetime="new Date(message.at * 1000).toISOString()">{{ formatClock(message.at, now) }}</time></span>
                <p v-if="message.from === 'lead'" class="bubble">{{ message.text ?? "Плановый разбор, без особого приказа." }}</p>
                <p v-else-if="message.text" class="bubble">{{ message.text }}</p>

                <!-- Dockets: a lesson's card stands at the last report that carries it. -->
                <template v-for="lesson in message.lessons" :key="lesson.id">
                  <article v-if="docketsOf(study).get(lesson.id) === at" class="docket" :class="index.get(lesson.entry)?.status ?? 'unindexed'">
                    <header class="d-head">
                      <span>Докладная · {{ lesson.id }}<template v-if="lesson.scope"> · {{ SCOPE[lesson.scope] }}</template></span>
                      <span v-if="index.get(lesson.entry) && index.get(lesson.entry)!.status !== 'proposed'" class="d-state">{{ LESSON_STATE[index.get(lesson.entry)!.status] || index.get(lesson.entry)!.status_text }}</span>
                    </header>
                    <dl class="d-body">
                      <dt>Когда</dt>
                      <dd>{{ lesson.cue }}</dd>
                      <template v-if="lesson.lesson"><dt>Что делать</dt><dd>{{ lesson.lesson }}</dd></template>
                      <template v-if="lesson.proposal"><dt>Предложение</dt><dd>{{ lesson.proposal }}</dd></template>
                    </dl>
                    <div v-if="index.get(lesson.entry)?.status === 'proposed'" class="d-actions">
                      <button type="button" class="chip" :class="{ picked: decided(lesson.entry)?.status === 'accepted' }" :aria-pressed="decided(lesson.entry)?.status === 'accepted'" @click="decide(lesson.entry, lesson.id, 'accepted')">Принять</button>
                      <button type="button" class="chip" :class="{ picked: decided(lesson.entry)?.status === 'declined' }" :aria-pressed="decided(lesson.entry)?.status === 'declined'" @click="decide(lesson.entry, lesson.id, 'declined')">Отклонить</button>
                      <button v-if="reach(study) === 'ok'" type="button" class="chip" @click="clarify(lesson.id)">Уточнить</button>
                      <input
                        v-if="decided(lesson.entry)?.status === 'declined'"
                        v-model="decided(lesson.entry)!.note"
                        class="note"
                        type="text"
                        placeholder="Причина — необязательно"
                        aria-label="Причина отказа"
                      />
                    </div>
                  </article>
                  <span v-else class="d-moved">докладная {{ lesson.id }} — пересмотрена ниже</span>
                </template>

                <!-- Questions: live only in the last report of a waiting study. -->
                <div v-if="message.questions.length" class="questions" :class="{ live: openQuestionsAt(study) === at }">
                  <div v-for="(question, number) in message.questions" :key="number" class="question">
                    <p class="q-text"><span class="q-num">{{ number + 1 }}.</span> {{ question.text }}</p>
                    <div v-if="openQuestionsAt(study) === at && reach(study) === 'ok'" class="q-answers">
                      <button
                        v-for="option in question.options"
                        :key="option"
                        type="button"
                        class="chip"
                        :class="{ picked: answersOf(study)[number] === option }"
                        :aria-pressed="answersOf(study)[number] === option"
                        @click="choose(study, number, option)"
                      >
                        {{ option }}
                      </button>
                      <input
                        v-if="!question.options.length || customOf(study)[number]"
                        v-model="answersOf(study)[number]"
                        class="note"
                        type="text"
                        placeholder="Твой ответ"
                        :aria-label="`Ответ на вопрос ${number + 1}`"
                      />
                      <button v-else type="button" class="chip ghost" @click="ownAnswer(study, number)">Свой ответ</button>
                    </div>
                  </div>
                </div>
              </div>
            </li>
            <li v-if="study.alive" class="keeper inline">
              <img :src="analystPortrait" alt="" class="mini" />
              <span>Аналитик читает записи<span class="dots" aria-hidden="true"></span></span>
            </li>
            <li v-else-if="studyState(study) === 'failed'" class="keeper inline bad">
              <img :src="archivistPortrait" alt="" class="mini" />
              <span>Ход прервался{{ study.error ? `: ${study.error}` : "" }}. Повтори приказ или передай аналитику «продолжай».</span>
            </li>
          </ol>
        </section>
      </template>

      <!-- Уроки: the index, decided from here as well. -->
      <template v-else-if="tab === 'lessons'">
        <section class="block">
          <h3>Ждут решения <span class="dim">{{ research.proposed.length }}</span></h3>
          <p v-if="!research.proposed.length" class="dim">Ничего не ждёт.</p>
          <ul v-else class="lessons">
            <li v-for="lesson in research.proposed" :key="lesson.entry" class="lesson proposed">
              <span class="cue">{{ lesson.cue }}</span>
              <span class="meta">{{ shortDate(lesson.date) }} · {{ scopeText(lesson) }} · <span class="mono">{{ lesson.entry }}</span></span>
              <span class="d-actions">
                <button type="button" class="chip" :class="{ picked: decided(lesson.entry)?.status === 'accepted' }" :aria-pressed="decided(lesson.entry)?.status === 'accepted'" @click="decide(lesson.entry, lessonId(lesson.entry), 'accepted')">Принять</button>
                <button type="button" class="chip" :class="{ picked: decided(lesson.entry)?.status === 'declined' }" :aria-pressed="decided(lesson.entry)?.status === 'declined'" @click="decide(lesson.entry, lessonId(lesson.entry), 'declined')">Отклонить</button>
                <input
                  v-if="decided(lesson.entry)?.status === 'declined'"
                  v-model="decided(lesson.entry)!.note"
                  class="note"
                  type="text"
                  placeholder="Причина — необязательно"
                  aria-label="Причина отказа"
                />
              </span>
            </li>
          </ul>
        </section>
        <section v-if="research.accepted.length" class="block">
          <h3>Приняты, ждут внедрения <span class="dim">{{ research.accepted.length }}</span></h3>
          <ul class="lessons">
            <li v-for="lesson in research.accepted" :key="lesson.entry" class="lesson accepted">
              <span class="cue">{{ lesson.cue }}</span>
              <span class="meta">{{ shortDate(lesson.date) }} · {{ scopeText(lesson) }} · {{ lesson.status_text }}</span>
            </li>
          </ul>
        </section>
        <section class="block">
          <h3>Решено <span class="dim">{{ research.applied.length }} внедрено · {{ research.declined.length }} отклонено<template v-if="research.other.length"> · {{ research.other.length }} прочих</template></span></h3>
          <button v-if="settled.length" type="button" class="chip ghost" :aria-expanded="showSettled" @click="showSettled = !showSettled">
            {{ showSettled ? "Свернуть" : "Показать" }}
          </button>
          <ul v-if="showSettled" class="lessons">
            <li v-for="lesson in settled" :key="lesson.entry" class="lesson" :class="lesson.status">
              <span class="cue">{{ lesson.cue }}</span>
              <span class="meta">{{ shortDate(lesson.date) }} · {{ scopeText(lesson) }} · {{ lesson.status_text }}</span>
            </li>
          </ul>
        </section>
      </template>

      <!-- Наблюдение: the archive keeper's ledger. -->
      <template v-else>
        <dl class="fields">
          <dt>Последний разбор</dt>
          <dd v-if="research.batch">
            {{ shortDate(research.batch.date) }} · записей {{ research.batch.records }}
            <span v-if="Object.keys(research.batch.repos).length" class="dim block">
              {{ Object.entries(research.batch.repos).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([repo, count]) => `${repo} ${count}`).join(" · ") }}
            </span>
          </dd>
          <dd v-else class="dim">ещё не было</dd>
          <dt>С тех пор</dt>
          <dd>записей {{ research.pending.records }}<template v-if="research.pending.signals"> · с сигналом {{ research.pending.signals }}</template></dd>
          <template v-if="runLine">
            <dt>Прежняя рефлексия</dt>
            <dd>
              {{ runLine }}
              <button v-if="research.run" type="button" class="link" @click="emit('open', research.run.slug)">сессия</button>
            </dd>
          </template>
        </dl>
        <section class="block">
          <h3>Под наблюдением <span class="dim">{{ research.pending.items.length }}</span></h3>
          <p class="dim small">Закрытые задачи с сигналом: их разберёт следующий разбор. Любую можно разобрать сейчас.</p>
          <ul class="records">
            <li v-for="item in research.pending.items" :key="item.slug + item.stamp">
              <span class="mono ellipsis" :title="item.slug">{{ item.slug }}</span>
              <span class="dim repo">· {{ item.repo }}</span>
              <button type="button" class="chip small-chip" @click="studyRecord(item.slug)">Разобрать</button>
              <span class="signals">
                <span v-for="signal in item.signals" :key="signal" class="signal">{{ SIGNALS[signal] ?? signal }}</span>
              </span>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <!-- The transmitter: one command per round, copied for the terminal. -->
    <footer class="radio" aria-label="Передатчик">
      <div class="r-head">
        <span class="r-title">Передатчик</span>
        <span class="switch" role="group" aria-label="Что передать">
          <button type="button" :class="{ on: composer === 'reply' }" :aria-pressed="composer === 'reply'" @click="composer = 'reply'">Ответ</button>
          <button type="button" :class="{ on: composer === 'order' }" :aria-pressed="composer === 'order'" @click="composer = 'order'">Приказ</button>
        </span>
      </div>

      <ul v-if="decisions.length" class="staged" aria-label="Решения по урокам">
        <li v-for="decision in decisions" :key="decision.entry" :class="decision.status" :title="decision.entry">
          {{ chipName(decision) }} · {{ decision.status === "accepted" ? "принять" : "отклонить" }}<template v-if="decision.note.trim()">: {{ decision.note.trim() }}</template>
          <button type="button" class="x" :aria-label="`Убрать решение по ${decision.entry}`" @click="drop(decision)">×</button>
        </li>
      </ul>

      <template v-if="composer === 'reply'">
        <p class="r-to">
          <template v-if="target">Кому: «{{ studyTitle(target) }}»</template>
          <template v-else>Открой исследование, чтобы ответить аналитику.</template>
        </p>
        <p v-if="target && targetReach !== 'ok'" class="r-note">{{ REACH_NOTE[targetReach] }}</p>
        <textarea
          v-else-if="target"
          ref="replyField"
          v-model="free"
          rows="2"
          placeholder="Ответ или уточнение аналитику. Выбранные варианты уйдут вместе с ним"
          aria-label="Ответ аналитику"
        ></textarea>
        <div class="r-send">
          <pre class="preview" :class="{ empty: !replyCommand }">{{ replyCommand ? lines(replyCommand) : "Выбери ответы или решения — команда соберётся здесь" }}</pre>
          <button type="button" class="send" :disabled="!replyCommand" @click="sendReply">Передать</button>
        </div>
      </template>

      <template v-else>
        <span class="kinds" role="group" aria-label="Вид приказа">
          <button
            v-for="item in ORDER_KINDS"
            :key="item.kind"
            type="button"
            class="chip"
            :class="{ picked: draft.kind === item.kind }"
            :aria-pressed="draft.kind === item.kind"
            @click="draft.kind = item.kind"
          >
            {{ item.label }}
          </button>
        </span>
        <div v-if="draft.kind === 'tasks'" class="row">
          <input v-model="draft.tasks" type="text" placeholder="Задачи: nft-send-fix wallet-ci" aria-label="Задачи через пробел" />
        </div>
        <div v-else-if="draft.kind === 'question'" class="row two">
          <input v-model="draft.since" type="text" placeholder="За срок: 30d или 2026-11-01" aria-label="Срок" />
          <input v-model="draft.repos" type="text" placeholder="Проекты — необязательно" aria-label="Проекты через пробел" />
        </div>
        <textarea v-model="draft.text" rows="2" :placeholder="ORDER_HINT[draft.kind]" aria-label="Текст приказа"></textarea>
        <p v-if="orderError" class="r-error" role="alert">{{ orderError }}</p>
        <div class="r-send">
          <pre class="preview" :class="{ empty: !('command' in ordered) }">{{ "command" in ordered ? lines(orderLine) : ordered.error }}</pre>
          <button type="button" class="send" @click="sendOrder">Передать приказ</button>
        </div>
      </template>

      <p v-if="last && last.copied" class="r-done" role="status">Шифровка скопирована — вставь в терминал. Ответ придёт следующим ходом аналитика.</p>
      <template v-else-if="last">
        <p class="r-error" role="alert">Буфер обмена недоступен — скопируй команду вручную:</p>
        <textarea ref="lastField" class="mono manual" rows="2" readonly :value="last.command" aria-label="Команда для терминала"></textarea>
      </template>
    </footer>
  </aside>
</template>

<style scoped>
/* A station console over the dark sky, like the map's other panels; teal is the station, gold waits for you. */
.panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(600px, 100vw);
  border: 12px solid transparent;
  border-image: var(--frame) 30 / 12px / 0 stretch;
  background: rgba(8, 10, 15, 0.95);
  background-clip: padding-box;
  color: #e8e2d4;
  font-size: 13px;
  line-height: 18px;
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 2px 4px 10px;
}

.staff {
  position: relative;
  flex: none;
  width: 76px;
  height: 48px;
}

.face {
  position: absolute;
  top: 0;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  object-fit: cover;
}

.face.analyst {
  left: 0;
  z-index: 1;
  box-shadow: 0 0 0 2px #5fd6c8;
}

.face.archivist {
  left: 30px;
  box-shadow: 0 0 0 2px #d9a24c;
}

.titles {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

h2 {
  margin: 0;
  color: #f3c27a;
  font-size: 15px;
  font-weight: 650;
}

.headline {
  color: #9b907c;
}

.headline.live {
  color: #5fd6c8;
}

.headline.wait {
  color: #f3c64e;
}

.icon {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid rgba(214, 170, 96, 0.35);
  border-radius: 2px;
  background: rgba(20, 22, 28, 0.9);
  color: #b8ad98;
  cursor: pointer;
}

.icon:hover {
  border-color: rgba(243, 198, 78, 0.8);
  color: #f3c64e;
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 0 4px;
  border-bottom: 1px solid rgba(214, 170, 96, 0.25);
}

.tabs button {
  padding: 5px 10px 6px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: #b8ad98;
  font: inherit;
  cursor: pointer;
}

.tabs button:hover {
  color: #e8e2d4;
}

.tabs button.on {
  border-bottom-color: #5fd6c8;
  color: #bfeee6;
}

.count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(243, 194, 122, 0.2);
  color: #f3c27a;
  font-size: 11.5px;
  font-weight: 600;
}

.count.wait {
  background: #f3c64e;
  color: #1b1408;
}

.count.dim {
  background: rgba(155, 144, 124, 0.2);
  color: #b8ad98;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 4px 14px;
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

/* The archive keeper speaks in short amber lines. */
.keeper {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 10px;
  color: #d9c7a4;
  font-size: 12.5px;
}

.keeper b {
  color: #d9a24c;
  font-weight: 600;
}

.keeper.inline {
  margin: 6px 0 2px;
  list-style: none;
}

.keeper.bad {
  color: #ff8d7a;
}

.mini {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  object-fit: cover;
}

.dots::after {
  content: "…";
  animation: blink 1.4s steps(2, end) infinite;
}

@keyframes blink {
  50% {
    opacity: 0.25;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dots::after {
    animation: none;
  }
}

/* One study: a folded header, the conversation when open. */
.study {
  margin: 0 0 8px;
  border: 1px solid rgba(95, 214, 200, 0.18);
  border-radius: 3px;
  background: rgba(14, 20, 24, 0.6);
}

.study.waiting {
  border-color: rgba(243, 198, 78, 0.55);
}

.study.failed {
  border-color: rgba(255, 141, 122, 0.45);
}

.s-head {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  grid-template-areas:
    "dot title state"
    ". meta meta";
  gap: 0 8px;
  align-items: baseline;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.s-head:hover {
  background: rgba(95, 214, 200, 0.07);
}

.dot {
  grid-area: dot;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6b6457;
}

.working .dot {
  background: #5fd6c8;
  box-shadow: 0 0 6px #5fd6c8;
}

.waiting .dot {
  background: #f3c64e;
  box-shadow: 0 0 6px #f3c64e;
}

.failed .dot {
  background: #ff8d7a;
}

.s-title {
  grid-area: title;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.s-meta {
  grid-area: meta;
  color: #9b907c;
  font-size: 12px;
}

.s-state {
  grid-area: state;
  color: #9b907c;
  font-size: 12px;
  white-space: nowrap;
}

.waiting .s-state {
  color: #f3c64e;
}

.working .s-state {
  color: #5fd6c8;
}

.failed .s-state {
  color: #ff8d7a;
}

/* The conversation. */
.talk {
  margin: 0;
  padding: 4px 10px 10px;
  border-top: 1px solid rgba(95, 214, 200, 0.14);
  list-style: none;
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
  max-width: 88%;
}

.lead .bubble-wrap {
  align-items: flex-end;
}

.who {
  color: #9b907c;
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

/* A docket: a lesson with the decision it waits for. */
.docket {
  padding: 7px 10px 8px;
  border: 1px solid rgba(214, 170, 96, 0.3);
  border-left: 3px solid #f3c27a;
  border-radius: 0 3px 3px 0;
  background: rgba(20, 18, 14, 0.85);
}

.docket.accepted {
  border-left-color: #5fd6c8;
}

.docket.applied {
  border-left-color: #6fcf8f;
}

.docket.unindexed {
  border-left-color: #6b6457;
}

.docket.declined {
  border-left-color: #6b6457;
  opacity: 0.8;
}

.d-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: #f3c27a;
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
  color: #9b907c;
}

.d-body dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.d-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.d-moved {
  color: #7d7566;
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
  color: #f3c27a;
  font-weight: 600;
}

.q-answers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.chip {
  padding: 2px 10px;
  border: 1px solid rgba(214, 170, 96, 0.4);
  border-radius: 999px;
  background: rgba(20, 22, 28, 0.9);
  color: #e8e2d4;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.chip:hover {
  border-color: rgba(243, 198, 78, 0.85);
}

.chip.picked {
  border-color: #f3c64e;
  background: #f3c64e;
  color: #1b1408;
}

.chip.ghost {
  border-style: dashed;
  color: #b8ad98;
}

.small-chip {
  margin-left: auto;
  padding: 0 8px;
  font-size: 12px;
}

input,
textarea {
  box-sizing: border-box;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid rgba(214, 170, 96, 0.3);
  border-radius: 2px;
  background: rgba(4, 6, 9, 0.9);
  color: #e8e2d4;
  font: inherit;
}

input:focus-visible,
textarea:focus-visible,
button:focus-visible {
  outline: 2px solid #5fd6c8;
  outline-offset: 1px;
}

.note {
  flex: 1 1 180px;
}

/* Lessons and the watch list. */
.block {
  margin: 0 0 16px;
}

h3 {
  margin: 0 0 6px;
  color: #f3c27a;
  font-size: 13px;
  font-weight: 650;
}

.dim {
  color: #9b907c;
  font-weight: 400;
}

.small {
  margin: 0 0 6px;
  font-size: 12px;
}

.block .dim.block,
.dim.block {
  display: block;
}

.lessons,
.records {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.lesson {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 0 6px;
  padding: 6px 8px;
  border-left: 3px solid #6b6457;
  background: rgba(20, 18, 14, 0.7);
}

.lesson.proposed {
  border-left-color: #f3c27a;
}

.lesson.accepted {
  border-left-color: #5fd6c8;
}

.lesson.applied {
  border-left-color: #6fcf8f;
}

.cue {
  overflow-wrap: anywhere;
}

.meta {
  color: #9b907c;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px 14px;
  margin: 0 0 16px;
}

.fields dt {
  color: #9b907c;
}

.fields dd {
  margin: 0;
  min-width: 0;
}

.link {
  margin-left: 8px;
  padding: 0;
  border: 0;
  background: none;
  color: #8fd8ff;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.records li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 0;
  padding: 4px 0;
  border-bottom: 1px solid rgba(214, 170, 96, 0.14);
}

.records .mono {
  max-width: 55%;
}

.records .repo {
  margin-left: 6px;
}

.signals {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  width: 100%;
}

.signal {
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(255, 141, 122, 0.16);
  color: #ff9d8a;
  font-size: 11.5px;
}

.mono {
  font-family: var(--mono, ui-monospace, monospace);
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The transmitter. */
.radio {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 6px;
  max-height: 55%;
  overflow-y: auto;
  padding: 8px 4px 2px;
  border-top: 1px solid rgba(214, 170, 96, 0.3);
}

.r-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.r-title {
  color: #f3c27a;
  font-weight: 650;
}

.switch {
  display: inline-flex;
  border: 1px solid rgba(214, 170, 96, 0.35);
  border-radius: 2px;
}

.switch button {
  padding: 2px 12px;
  border: 0;
  background: none;
  color: #b8ad98;
  font: inherit;
  cursor: pointer;
}

.switch button.on {
  background: rgba(95, 214, 200, 0.18);
  color: #bfeee6;
}

.staged {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.staged li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 0 4px 0 8px;
  border-radius: 999px;
  background: rgba(95, 214, 200, 0.16);
  color: #bfeee6;
  font-size: 12px;
}

.staged li.declined {
  background: rgba(155, 144, 124, 0.2);
  color: #d4cab5;
}

.x {
  padding: 0 4px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.r-to,
.r-note {
  margin: 0;
  overflow: hidden;
  color: #9b907c;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.r-note {
  white-space: normal;
}

.radio textarea {
  width: 100%;
  resize: vertical;
}

.kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.row {
  display: flex;
  gap: 6px;
}

.row input {
  flex: 1;
}

.r-send {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.preview {
  flex: 1;
  min-width: 0;
  max-height: 72px;
  margin: 0;
  overflow-y: auto;
  color: #9cc2bc;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11.5px;
  line-height: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.preview.empty {
  color: #7d7566;
  font-family: inherit;
}

.send {
  flex: none;
  padding: 4px 14px;
  border: 1px solid #5fd6c8;
  border-radius: 2px;
  background: rgba(95, 214, 200, 0.2);
  color: #dffaf5;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.send:hover:not(:disabled) {
  background: rgba(95, 214, 200, 0.32);
}

.send:disabled {
  border-color: rgba(155, 144, 124, 0.4);
  background: none;
  color: #7d7566;
  cursor: default;
}

.r-done {
  margin: 0;
  color: #5fd6c8;
  font-size: 12px;
}

.r-error {
  margin: 0;
  color: #ff9d8a;
  font-size: 12px;
}

.manual {
  width: 100%;
}
</style>
