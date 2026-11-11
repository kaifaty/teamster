<script setup lang="ts">
// The deck «Что сделано»: the branch's changes, the PR, the saved check, the agent's own checks, the review, CI, the
// base merge, why the fix loop stopped and what is left undone — a row each, only when there is something to say.
import { computed } from "vue";
import type { Cargo, TaskChanges, TaskSummary } from "../../types";
import { doneRows } from "./done";

const props = defineProps<{ task: TaskSummary; cargo: Cargo | null; changes: TaskChanges | null | undefined; loading: boolean; now: number }>();

const rows = computed(() => doneRows(props.task, props.cargo, props.changes, props.now));
const aside = computed(() => (props.task.turn > 0 ? `${props.task.alive ? "к ходу" : "по итогам хода"} ${props.task.turn}` : ""));
</script>

<template>
  <section class="deck done" aria-labelledby="done-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">✓</span>
      <h3 id="done-deck">Что сделано</h3>
      <span class="aside">{{ aside }}</span>
    </div>
    <p v-if="!rows.length" class="empty">{{ loading ? "Загрузка…" : task.alive ? "Пока нечего показать: идёт первый ход." : "Ни изменений, ни проверок пока нет." }}</p>
    <div v-else class="rows">
      <div v-for="row in rows" :key="row.key" class="row well" :class="`row-${row.tone}`" :title="row.hint">
        <span class="dot" aria-hidden="true"></span>
        <span class="n">{{ row.title }}<small v-if="row.meta">{{ row.meta }}</small></span>
        <div class="v">
          <a v-if="row.link" :href="row.link" target="_blank" rel="noopener">{{ row.text }}</a>
          <template v-else>{{ row.text }}</template>
          <ul v-if="row.items.length || row.more">
            <li v-for="(item, index) in row.items" :key="index">
              <span class="sev mono" :class="`tone-${item.tone}`">{{ item.mark }}</span>
              <span class="what">
                <span :class="{ mono: row.key === 'claims' || row.key === 'ci' || row.key === 'base' }">{{ item.text }}</span>
                <template v-if="item.where"> · <span class="dim" :class="{ mono: row.key === 'review' }">{{ item.where }}</span></template>
              </span>
            </li>
            <li v-if="row.more" class="dim">ещё {{ row.more }}</li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.rows {
  display: grid;
  gap: 6px;
}

.row {
  display: grid;
  grid-template-columns: 18px minmax(120px, 180px) minmax(0, 1fr);
  align-items: start;
  gap: 3px 10px;
  padding: 7px 9px;
}

.dot {
  width: 10px;
  height: 10px;
  margin: 4px 0 0 3px;
  border-radius: 50%;
  background: var(--sh-faint);
}

.row-ok .dot {
  background: var(--sh-green);
}

.row-warn .dot {
  background: var(--sh-wait);
}

.row-bad .dot {
  background: var(--sh-red);
  box-shadow: 0 0 8px var(--sh-red);
}

.n {
  font-weight: 600;
}

.n small {
  display: block;
  color: var(--sh-faint);
  font-size: 11px;
  font-weight: 400;
}

.v {
  min-width: 0;
  overflow-wrap: anywhere;
}

ul {
  display: grid;
  gap: 4px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  font-size: 12.5px;
}

.sev {
  height: 17px;
  padding: 0 5px;
  border: 1px solid;
  border-radius: 4px;
  font-size: 11px;
  line-height: 15px;
}

.what {
  min-width: 0;
  overflow-wrap: anywhere;
}

@media (max-width: 560px) {
  .row {
    grid-template-columns: 18px minmax(0, 1fr);
  }

  .v {
    grid-column: 2;
  }
}
</style>
