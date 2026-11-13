<script setup lang="ts">
// The agent's work by time, as in a chat: its messages whole with their line breaks, its commands, edits and tools as
// short lines with their kind (the whole text on hover), its thinking dimmed to its first line until clicked. A long run
// of short lines folds to its last three behind «ещё N действий». The feed is the console's: the open lesson's
// implementation, or the open study.
import { computed } from "vue";
import { formatClock } from "../../lib/format";
import { useConsole } from "./console";

defineProps<{ who: string; now: number }>();
const desk = useConsole();

const feed = computed(() => desk.feed.value);
const time = (at: number) => new Date(at * 1000).toISOString();
</script>

<template>
  <section v-if="feed" class="agent-feed" :aria-label="`Работа: ${who}`">
    <p v-if="feed.truncated" class="cut">Показана последняя часть работы</p>
    <ol class="items" role="log" aria-live="polite" :aria-label="`Что делает ${who.toLowerCase()}`">
      <li v-for="row in desk.feedRows.value" :key="row.key" class="row" :class="row.type">
        <template v-if="row.type === 'message'">
          <span class="who">{{ who }} · <time :datetime="time(row.item.at)">{{ formatClock(row.item.at, now) }}</time></span>
          <p class="text">{{ row.item.text }}</p>
        </template>
        <button
          v-else-if="row.type === 'thinking'"
          type="button"
          class="thought"
          :class="{ open: desk.thoughtOpen(Number(row.key)) }"
          :aria-expanded="desk.thoughtOpen(Number(row.key))"
          @click="desk.toggleThought(Number(row.key))"
        >
          <span class="kind">думает</span>
          <span class="t-text">{{ desk.thoughtOpen(Number(row.key)) ? row.item.text : row.head }}</span>
        </button>
        <template v-else-if="row.type === 'line'">
          <span class="kind">{{ row.label }}</span>
          <span class="l-text mono" :title="row.item.text">{{ row.item.text }}</span>
        </template>
        <button v-else type="button" class="more" @click="desk.unfold(row.run)">{{ row.label }}</button>
      </li>
    </ol>
    <p v-if="feed.failed" class="lost">Лента не обновилась, повторю запрос</p>
  </section>
</template>

<style scoped>
.agent-feed {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  max-width: 78ch;
}

.cut,
.lost {
  margin: 0;
  color: var(--st-dim);
  font-size: 11.5px;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  animation: feed-in 180ms ease-out;
}

.row.message {
  flex-direction: column;
  gap: 2px;
  margin: 6px 0 4px;
}

.who {
  color: var(--st-dim);
  font-size: 11.5px;
}

.text {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid rgba(95, 214, 200, 0.24);
  border-radius: 3px;
  background: rgba(95, 214, 200, 0.06);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.kind {
  flex: none;
  min-width: 72px;
  color: var(--st-teal);
  font-size: 11px;
  text-align: right;
}

.l-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: #d4cab5;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thought {
  display: flex;
  flex: 1;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--st-dim);
  font: inherit;
  font-size: 12px;
  font-style: italic;
  text-align: left;
  cursor: pointer;
}

.thought .kind {
  color: var(--st-dim);
  font-style: normal;
}

.t-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thought.open .t-text {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.thought:hover .t-text,
.thought:focus-visible .t-text {
  color: #d4cab5;
}

.more {
  margin-left: 80px;
  padding: 1px 8px;
  border: 1px dashed rgba(95, 214, 200, 0.4);
  border-radius: 3px;
  background: none;
  color: var(--st-teal);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.more:hover,
.more:focus-visible {
  background: rgba(95, 214, 200, 0.1);
}

.thought:focus-visible,
.more:focus-visible {
  outline: 1px solid var(--st-teal);
  outline-offset: 2px;
}

@keyframes feed-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .row {
    animation: none;
  }
}

@container (max-width: 480px) {
  .kind {
    min-width: 0;
    text-align: left;
  }

  .more {
    margin-left: 0;
  }
}
</style>
