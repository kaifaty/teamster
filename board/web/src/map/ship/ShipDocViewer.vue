<script setup lang="ts">
// One of the ship's documents, opened over its bridge: markdown rendered as on the task's card, the check's log as text.
import { nextTick, onMounted, ref, toRef } from "vue";
import type { BoardSource } from "../../lib/source";
import { useTaskFile } from "../../lib/taskFile";
import type { TaskFile } from "../../types";

const props = defineProps<{ source: BoardSource; slug: string; name: TaskFile; version: number }>();
const emit = defineEmits<{ close: [] }>();

const TITLES: Record<TaskFile, string> = { brief: "Полётное задание", last: "Последний доклад", review: "Акт инспекции", check: "Протокол проверки" };

const tab = toRef(props, "name");
const { text, state, html } = useTaskFile({
  source: () => props.source,
  slug: () => props.slug,
  tab,
  version: () => props.version,
  changed: () => props.version,
  immediate: true,
});

const closer = ref<HTMLButtonElement | null>(null);
onMounted(() => void nextTick(() => closer.value?.focus()));
</script>

<template>
  <div class="viewer-back" @click.self="emit('close')">
    <section class="viewer deck" role="dialog" aria-modal="true" aria-labelledby="viewer-title">
      <div class="deck-head">
        <span class="sigil" aria-hidden="true">▥</span>
        <h3 id="viewer-title">{{ TITLES[name] }}</h3>
        <button ref="closer" type="button" class="key close" title="Закрыть (Esc)" @click="emit('close')">✕<span class="visually-hidden"> Закрыть</span></button>
      </div>
      <div class="body" tabindex="0">
        <p v-if="state === 'loading' && text === null" class="empty">Загрузка…</p>
        <p v-else-if="state === 'missing'" class="empty">Файла нет.</p>
        <p v-else-if="state === 'error'" class="empty tone-bad">Не удалось загрузить файл.</p>
        <pre v-else-if="name === 'check' && text !== null" class="log mono">{{ text }}</pre>
        <!-- markdown-it runs with html: false, so task text cannot inject markup. -->
        <div v-else-if="text !== null" class="md" v-html="html"></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.viewer-back {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(3, 5, 8, 0.6);
}

.viewer {
  width: min(860px, 100%);
  max-height: 100%;
  min-height: 0;
}

.close {
  margin-left: auto;
  padding: 1px 9px;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 6px;
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

.log {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11.5px;
  line-height: 1.45;
}

.md {
  overflow-wrap: anywhere;
  line-height: 1.5;
}

.md :deep(h1),
.md :deep(h2),
.md :deep(h3) {
  margin: 14px 0 6px;
  color: var(--sh-title);
  font-size: 14px;
}

.md :deep(h1) {
  font-size: 16px;
}

.md :deep(p),
.md :deep(ul),
.md :deep(ol) {
  margin: 6px 0;
}

.md :deep(ul),
.md :deep(ol) {
  padding-left: 20px;
}

.md :deep(code) {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(214, 170, 96, 0.12);
  font-family: var(--mono);
  font-size: 12px;
}

.md :deep(pre) {
  padding: 8px 10px;
  border: 1px solid var(--sh-line);
  border-radius: 6px;
  background: var(--sh-well);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.md :deep(pre code) {
  padding: 0;
  background: none;
}

.md :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}

.md :deep(th),
.md :deep(td) {
  padding: 3px 8px;
  border: 1px solid var(--sh-line);
}

.md :deep(blockquote) {
  margin: 6px 0;
  padding-left: 10px;
  border-left: 3px solid var(--sh-line);
  color: var(--sh-dim);
}
</style>
