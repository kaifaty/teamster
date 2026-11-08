<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { formatAge, formatDuration } from "../lib/format";
import type { Lesson } from "../types";
import { SIGNALS, shortDate, type Research } from "./research";

const props = defineProps<{ research: Research; now: number }>();
const emit = defineEmits<{ close: []; open: [slug: string] }>();

/** Settled lessons fold behind a button; the ones that wait for a decision are always shown. */
const showSettled = ref(false);
const settled = computed(() => [...props.research.applied, ...props.research.declined, ...props.research.other]);

const runLine = computed(() => {
  const run = props.research.run;
  if (!run) return null;
  if (props.research.running) {
    const started = run.phase_started_at ?? run.created;
    return started !== null ? `идёт разбор · ${formatDuration(props.now - started)}` : "идёт разбор";
  }
  return `последний запуск ${formatAge(run.updated_at, props.now)}`;
});

const batchRepos = computed(() =>
  Object.entries(props.research.batch?.repos ?? {})
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([repo, count]) => `${repo} ${count}`)
    .join(" · "),
);

const scopeText = (lesson: Lesson) =>
  lesson.scope === "invariant" ? "общий" : lesson.scope === "domain" ? lesson.repos.join(", ") || lesson.scope_text : lesson.scope_text;

const closeButton = ref<HTMLButtonElement | null>(null);
const onKey = (event: KeyboardEvent) => {
  if (event.key === "Escape") emit("close");
};
onMounted(() => {
  closeButton.value?.focus();
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <aside class="panel" role="dialog" aria-modal="false" aria-labelledby="research-title">
    <header class="p-head">
      <h2 id="research-title">Исследовательский центр</h2>
      <button ref="closeButton" type="button" class="btn close" title="Закрыть (Esc)" @click="emit('close')">
        <span aria-hidden="true">✕</span><span class="visually-hidden">Закрыть</span>
      </button>
    </header>

    <div class="p-body">
      <p class="lead">Разбирает закрытые задачи, ищет повторяющиеся сбои и предлагает уроки. Решение по уроку принимаешь ты.</p>

      <dl class="fields">
        <dt>Рефлексия</dt>
        <dd>
          <span :class="{ live: research.running }">{{ runLine ?? "запусков на доске нет" }}</span>
          <button v-if="research.run" type="button" class="link" @click="emit('open', research.run.slug)">сессия</button>
        </dd>
        <dt>Последний разбор</dt>
        <dd v-if="research.batch">
          {{ shortDate(research.batch.date) }} · записей {{ research.batch.records }}
          <span v-if="batchRepos" class="muted block">{{ batchRepos }}</span>
        </dd>
        <dd v-else class="muted">ещё не было</dd>
        <dt>С тех пор</dt>
        <dd>записей {{ research.pending.records }}<template v-if="research.pending.signals"> · с сигналом {{ research.pending.signals }}</template></dd>
      </dl>

      <section>
        <h3>Ждут решения <span class="count">{{ research.proposed.length }}</span></h3>
        <p v-if="!research.proposed.length" class="muted">Ничего не ждёт.</p>
        <ul v-else class="lessons">
          <li v-for="lesson in research.proposed" :key="lesson.entry" class="lesson proposed">
            <span class="cue">{{ lesson.cue }}</span>
            <span class="meta">{{ shortDate(lesson.date) }} · {{ scopeText(lesson) }} · <span class="mono">{{ lesson.entry }}</span></span>
          </li>
        </ul>
      </section>

      <section v-if="research.pending.items.length">
        <h3>Под наблюдением <span class="count">{{ research.pending.items.length }}</span></h3>
        <p class="muted small">Закрытые задачи с сигналом: их разберёт следующий запуск.</p>
        <ul class="records">
          <li v-for="item in research.pending.items" :key="item.slug + item.stamp">
            <span class="mono ellipsis" :title="item.slug">{{ item.slug }}</span>
            <span class="muted repo">· {{ item.repo }}</span>
            <span class="signals">
              <span v-for="signal in item.signals" :key="signal" class="signal">{{ SIGNALS[signal] ?? signal }}</span>
            </span>
          </li>
        </ul>
      </section>

      <section>
        <h3>
          Решено
          <span class="count">{{ research.applied.length }} применено · {{ research.declined.length }} отклонено<template v-if="research.other.length"> · {{ research.other.length }} прочих</template></span>
        </h3>
        <button v-if="settled.length" type="button" class="btn" :aria-expanded="showSettled" @click="showSettled = !showSettled">
          {{ showSettled ? "Свернуть" : "Показать" }}
        </button>
        <ul v-if="showSettled" class="lessons">
          <li v-for="lesson in settled" :key="lesson.entry" class="lesson" :class="lesson.status">
            <span class="cue">{{ lesson.cue }}</span>
            <span class="meta">{{ shortDate(lesson.date) }} · {{ scopeText(lesson) }} · {{ lesson.status_text }}</span>
          </li>
        </ul>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  width: min(560px, 100vw);
  border-left: 1px solid var(--border);
  background: var(--surface);
  box-shadow: var(--shadow-panel);
}

.p-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--border);
}

.p-head h2 {
  flex: 1;
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.close {
  flex: none;
  padding: 3px 8px;
}

.p-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 16px 24px;
}

.lead {
  margin: 0 0 12px;
  color: var(--muted);
}

.fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px 14px;
  margin: 0 0 16px;
}

.fields dt {
  color: var(--muted);
}

.fields dd {
  margin: 0;
  min-width: 0;
}

.live {
  color: var(--ok);
  font-weight: 600;
}

.block {
  display: block;
}

.link {
  margin-left: 8px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--link);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

section {
  margin: 0 0 18px;
}

h3 {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 650;
}

.count {
  margin-left: 4px;
  color: var(--muted);
  font-weight: 400;
}

.muted {
  color: var(--muted);
}

.small {
  margin: 0 0 6px;
  font-size: 12px;
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
  border-left: 3px solid var(--border);
  border-radius: 0 var(--radius) var(--radius) 0;
  background: var(--surface-2);
}

.lesson.proposed {
  border-left-color: var(--warn);
}

.lesson.applied {
  border-left-color: var(--ok);
}

.lesson.declined {
  border-left-color: var(--faint);
}

.cue {
  overflow-wrap: anywhere;
}

.meta {
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.records li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 0;
  padding: 3px 0;
  border-bottom: 1px solid var(--border);
}

.records .mono {
  max-width: 60%;
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
  background: var(--bad-soft);
  color: var(--bad);
  font-size: 11.5px;
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
