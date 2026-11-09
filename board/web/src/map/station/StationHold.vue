<script setup lang="ts">
// The archive hold: the records the next planned reflection will read, one capsule each. A record with a signal
// glows, and those are listed below; any of them can go into a task order at once. The archive keeper runs it.
import { computed } from "vue";
import archivistPortrait from "../art/portrait-archivist.jpg";
import { SIGNALS, plural, shortDate, type Research } from "../research";
import { signalTally } from "../station";
import { useConsole } from "./console";

const props = defineProps<{ research: Research }>();
const desk = useConsole();

/** The hold shows at most this many capsules; the rest are counted. */
const CAPSULES = 40;
const capsules = computed(() => {
  const { records, signals } = props.research.pending;
  const shown = Math.min(records, CAPSULES);
  const lit = Math.min(signals, shown);
  return { lit, plain: shown - lit, more: records - shown };
});

const repos = computed(() => {
  const list = props.research.pending.repos;
  const most = Math.max(1, ...list.map((item) => item.count));
  return list.map((item) => ({ ...item, share: item.count / most }));
});

const tally = computed(() => signalTally(props.research.pending.items));
const lastBatch = computed(() => {
  const batch = props.research.batch;
  if (!batch) return null;
  const repos = Object.entries(batch.repos).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  return { date: shortDate(batch.date), records: batch.records, repos: repos.map(([repo, count]) => `${repo} ${count}`).join(" · ") };
});

const keeperLine = computed(() => {
  const { records, signals } = props.research.pending;
  const since = props.research.batch ? `С разбора ${shortDate(props.research.batch.date)}` : "С начала архива";
  if (!records) return `${since} новых записей нет.`;
  return `${since} — ${records} ${plural(records, "запись", "записи", "записей")}${signals ? `, ${signals} с сигналом` : ""}. Их прочтёт следующий разбор.`;
});
</script>

<template>
  <section class="deck hold" data-deck="hold" aria-labelledby="deck-hold">
    <header class="deck-head">
      <span class="sigil" aria-hidden="true">▣</span>
      <h3 id="deck-hold">Трюм архива</h3>
      <span class="aside num">{{ research.pending.records }}<template v-if="research.pending.signals"> · <b class="hot">{{ research.pending.signals }} с сигналом</b></template></span>
    </header>
    <div class="deck-body">
      <p class="keeper">
        <img :src="archivistPortrait" alt="" class="mini" />
        <span><b>Хранитель архива:</b> {{ keeperLine }}</span>
      </p>

      <div v-if="research.pending.records" class="bay" role="img" :aria-label="`Записей ${research.pending.records}, с сигналом ${research.pending.signals}`">
        <i v-for="n in capsules.lit" :key="`lit-${n}`" class="capsule lit"></i>
        <i v-for="n in capsules.plain" :key="`plain-${n}`" class="capsule"></i>
        <span v-if="capsules.more" class="more num">+{{ capsules.more }}</span>
      </div>

      <ul v-if="repos.length" class="repos" aria-label="Записи по проектам">
        <li v-for="item in repos" :key="item.repo">
          <span class="r-name ellipsis" :title="item.repo">{{ item.repo }}</span>
          <span class="r-bar"><i :style="{ width: `${Math.max(6, item.share * 100)}%` }"></i></span>
          <span class="r-count num">{{ item.count }}</span>
        </li>
      </ul>

      <p v-if="tally.length" class="tally">
        <span v-for="item in tally" :key="item.signal" class="signal">{{ SIGNALS[item.signal] ?? item.signal }} · {{ item.count }}</span>
      </p>

      <ul v-if="research.pending.items.length" class="records" aria-label="Записи с сигналом">
        <li v-for="item in research.pending.items" :key="item.slug + item.stamp">
          <span class="mono ellipsis slug" :title="item.slug">{{ item.slug }}</span>
          <span class="dim repo ellipsis">{{ item.repo }}</span>
          <button type="button" class="chip small" title="Добавить в приказ «Разобрать задачи»" @click="desk.studyRecord(item.slug)">Разобрать</button>
          <span class="signals">
            <span v-for="signal in item.signals" :key="signal" class="signal">{{ SIGNALS[signal] ?? signal }}</span>
          </span>
        </li>
      </ul>

      <p v-if="lastBatch" class="batch">
        <span class="dim">Прошлый пакет {{ lastBatch.date }}:</span> {{ lastBatch.records }} {{ plural(lastBatch.records, "запись", "записи", "записей") }}<template v-if="lastBatch.repos"> · <span class="dim">{{ lastBatch.repos }}</span></template>
      </p>
    </div>
  </section>
</template>

<style scoped>
.hot {
  color: #ff9d8a;
  font-weight: 600;
}

/* The bay: capsules in racks; one with a signal glows. */
.bay {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14px, 1fr));
  gap: 4px;
  margin: 0 0 10px;
  padding: 8px;
  border: 1px solid rgba(217, 162, 76, 0.25);
  border-radius: 3px;
  background:
    repeating-linear-gradient(0deg, rgba(217, 162, 76, 0.06) 0 1px, transparent 1px 26px),
    rgba(10, 9, 7, 0.8);
}

.capsule {
  height: 22px;
  border: 1px solid rgba(217, 162, 76, 0.35);
  border-radius: 7px;
  background: linear-gradient(180deg, rgba(190, 180, 160, 0.22), rgba(120, 110, 95, 0.1) 60%, rgba(0, 0, 0, 0.3));
}

.capsule.lit {
  border-color: rgba(255, 141, 122, 0.9);
  background: linear-gradient(180deg, rgba(255, 170, 140, 0.9), rgba(255, 110, 80, 0.45) 55%, rgba(80, 20, 10, 0.6));
  box-shadow: 0 0 8px rgba(255, 120, 90, 0.55);
}

.more {
  align-self: center;
  color: var(--st-amber);
  font-size: 12px;
  white-space: nowrap;
}

.repos {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
}

.repos li {
  display: grid;
  grid-template-columns: minmax(0, 120px) minmax(0, 1fr) 2.5em;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}

.r-bar {
  height: 6px;
  border-radius: 3px;
  background: rgba(217, 162, 76, 0.12);
}

.r-bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--st-amber);
  box-shadow: 0 0 6px rgba(217, 162, 76, 0.5);
}

.r-count {
  color: #d9c7a4;
  text-align: right;
}

.tally {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0 0 8px;
}

.records {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
}

.records li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, auto) auto;
  grid-template-areas:
    "slug repo action"
    "signals signals signals";
  align-items: baseline;
  gap: 3px 8px;
  padding: 5px 0;
  border-bottom: 1px solid rgba(214, 170, 96, 0.14);
}

.slug {
  grid-area: slug;
}

.repo {
  grid-area: repo;
  max-width: 120px;
}

.records .chip {
  grid-area: action;
}

.signals {
  display: flex;
  flex-wrap: wrap;
  grid-area: signals;
  gap: 4px;
}

.batch {
  margin: 0;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
</style>
