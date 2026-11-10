<script setup lang="ts">
// The deck «Бортовые документы»: the task's brief, last answer, review and check log, those the task has; each opens
// in the viewer.
import { computed } from "vue";
import type { TaskFile } from "../../types";

const props = defineProps<{ files: readonly TaskFile[]; loading: boolean }>();
const emit = defineEmits<{ open: [name: TaskFile, opener: HTMLElement] }>();

const DOCS: readonly { name: TaskFile; sigil: string; title: string; file: string }[] = [
  { name: "brief", sigil: "✦", title: "Полётное задание", file: "brief.md" },
  { name: "last", sigil: "✎", title: "Последний доклад", file: "last.md" },
  { name: "review", sigil: "⛨", title: "Акт инспекции", file: "review.md" },
  { name: "check", sigil: "▣", title: "Протокол проверки", file: "check.log" },
];
const present = computed(() => DOCS.filter((doc) => props.files.includes(doc.name)));
</script>

<template>
  <section class="deck docs-deck" aria-labelledby="docs-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">▥</span>
      <h3 id="docs-deck">Бортовые документы</h3>
    </div>
    <p v-if="!present.length" class="empty">{{ loading ? "Загрузка…" : "Документов пока нет." }}</p>
    <div v-else class="docs">
      <button
        v-for="doc in present"
        :key="doc.name"
        type="button"
        class="doc well"
        :data-doc="doc.name"
        @click="emit('open', doc.name, $event.currentTarget as HTMLElement)"
      >
        <span class="g" aria-hidden="true">{{ doc.sigil }}</span>
        <span class="n">{{ doc.title }}</span>
        <span class="f mono">{{ doc.file }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.docs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 6px;
}

.doc {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 2px 8px;
  padding: 7px 9px;
  border-color: rgba(214, 170, 96, 0.18);
  color: var(--sh-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.doc:hover:not(:disabled) {
  border-color: var(--sh-line);
  background: rgba(243, 194, 122, 0.06);
}

.doc:disabled {
  opacity: 0.45;
  cursor: default;
}

.g {
  grid-row: span 2;
  color: var(--sh-title);
  font-size: 16px;
  line-height: 20px;
}

.n {
  font-weight: 600;
}

.f {
  color: var(--sh-faint);
  font-size: 11.5px;
}
</style>
