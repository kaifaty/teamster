<script setup lang="ts">
// The deck «Корпус»: what the checks found, by station — the range's check, the inspection's findings, the gate's CI,
// the base merge and why the fix loop stopped — and what the task left open.
import { computed } from "vue";
import type { Cargo } from "../../types";
import { hullReport } from "./bridge";

const props = defineProps<{ cargo: Cargo | null | undefined; now: number; loading: boolean }>();

const report = computed(() => hullReport(props.cargo, props.now));
const empty = computed(() => !report.value.rows.length && !report.value.remaining.length && !report.value.questions.length);
</script>

<template>
  <section class="deck damage" aria-labelledby="damage-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">⛨</span>
      <h3 id="damage-deck">Корпус</h3>
      <span class="aside">что нашли проверки, по станциям</span>
    </div>
    <p v-if="empty" class="empty">{{ loading ? "Загрузка…" : "Проверок ещё не было: корпус цел." }}</p>
    <div v-else class="hull">
      <div v-for="row in report.rows" :key="row.key" class="sys well" :class="`sys-${row.tone}`" :title="row.hint">
        <span class="dot" aria-hidden="true"></span>
        <span class="t">{{ row.title }}</span>
        <span class="r num">{{ row.aside }}</span>
        <ul v-if="row.items.length || row.more">
          <li v-for="(item, index) in row.items" :key="index">
            <span class="sev mono" :class="`tone-${item.tone}`">{{ item.mark }}</span>
            <span>{{ item.text }}<template v-if="item.where"> · <span class="mono dim">{{ item.where }}</span></template></span>
          </li>
          <li v-if="row.more" class="more dim">ещё {{ row.more }}</li>
        </ul>
      </div>
      <div v-if="report.remaining.length" class="sys well sys-warn">
        <span class="dot" aria-hidden="true"></span>
        <span class="t">Осталось</span>
        <span class="r num">{{ report.remaining.length }}</span>
        <ul class="plain">
          <li v-for="(item, index) in report.remaining" :key="index">{{ item }}</li>
        </ul>
      </div>
      <div v-if="report.questions.length" class="sys well sys-warn">
        <span class="dot" aria-hidden="true"></span>
        <span class="t">Вопросы</span>
        <span class="r num">{{ report.questions.length }}</span>
        <ul class="plain">
          <li v-for="(item, index) in report.questions" :key="index">{{ item }}</li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hull {
  display: grid;
  gap: 6px;
}

.sys {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: start;
  gap: 2px 10px;
  padding: 7px 8px;
}

.dot {
  width: 12px;
  height: 12px;
  margin: 3px 0 0 4px;
  border-radius: 50%;
  background: var(--sh-dim);
}

.sys-ok .dot {
  background: var(--sh-green);
}

.sys-warn .dot {
  background: var(--sh-wait);
}

.sys-bad .dot {
  background: var(--sh-red);
  box-shadow: 0 0 8px var(--sh-red);
}

.sys-muted .dot {
  border: 2px solid var(--sh-blue);
  background: transparent;
}

.t {
  min-width: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.r {
  color: var(--sh-dim);
  font-size: 12px;
  text-align: right;
}

ul {
  display: grid;
  grid-column: 2 / -1;
  gap: 4px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12.5px;
}

ul.plain li,
li.more {
  display: block;
}

ul.plain li::before {
  content: "· ";
  color: var(--sh-dim);
}

.sev {
  height: 17px;
  padding: 0 5px;
  border: 1px solid;
  border-radius: 4px;
  font-size: 11px;
  line-height: 15px;
}
</style>
