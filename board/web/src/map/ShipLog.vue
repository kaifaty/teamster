<script setup lang="ts">
// The ship's log at the bottom of the map: the fleet's completed phases and the lead's verdicts, newest first.
import { computed, ref, watch } from "vue";
import type { LogEvent } from "../types";
import { describeEvent, eventKey } from "../lib/events";
import { formatFullTime } from "../lib/format";
import { loadJson, saveJson } from "../lib/storage";
import { hashName } from "./layout";
import { SUN_KINDS } from "./palette";

const props = defineProps<{
  events: readonly LogEvent[];
  error: string | null;
  /** The open system; null shows the whole galaxy. */
  repo: string | null;
  frame: string;
  /** Systems the map can open; a line about any other one, or without a repository, leads nowhere. */
  systems: ReadonlySet<string>;
  emblemOf: (repo: string | null) => string | null;
}>();
const emit = defineEmits<{ go: [event: LogEvent] }>();

/** The log never draws more rows than this; older ones stay in memory. */
const SHOWN = 300;

const KEY = "codex-board.log-expanded.v1";
const expanded = ref(loadJson(KEY, false, (v): v is boolean => typeof v === "boolean"));
watch(expanded, (value) => saveJson(KEY, value));

const clock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
/** The colour of the system's sun, as the map paints it. */
const sunColour = (repo: string) => SUN_KINDS[hashName(repo) % SUN_KINDS.length]!.glow;

const rows = computed(() => {
  const list = props.repo ? props.events.filter((event) => event.repo === props.repo) : props.events;
  const rows = [];
  for (let i = list.length - 1; i >= 0 && rows.length < SHOWN; i--) {
    const event = list[i]!;
    const line = describeEvent(event);
    rows.push({
      key: eventKey(event),
      event,
      time: clock.format(new Date(event.at * 1000)),
      full: formatFullTime(event.at),
      text: line.text,
      tone: line.tone,
      go: event.repo !== null && props.systems.has(event.repo),
      emblem: props.emblemOf(event.repo),
      colour: event.repo ? sunColour(event.repo) : "#6f6a60",
      title: [formatFullTime(event.at), event.repo, line.text, event.note].filter(Boolean).join("\n"),
    });
  }
  return rows;
});

const hideImage = (event: Event) => {
  (event.target as HTMLElement).hidden = true;
};
</script>

<template>
  <section class="log" :class="{ open: expanded }" :style="{ '--frame': `url(${frame})` }" aria-labelledby="log-title">
    <header class="l-head">
      <h2 id="log-title">Бортовой журнал<span v-if="repo" class="l-where"> · {{ repo }}</span></h2>
      <button type="button" class="l-toggle" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ expanded ? "свернуть ▾" : "развернуть ▴" }}
      </button>
    </header>
    <ol class="l-rows" aria-live="polite" aria-relevant="additions">
      <li v-if="error" class="l-note bad" :title="error">Журнал не загрузился: {{ error }}</li>
      <li v-if="!rows.length" class="l-note">{{ repo ? "В этой системе за сутки тихо." : "За сутки в журнале ни строчки." }}</li>
      <li v-for="row in rows" :key="row.key">
        <component
          :is="row.go ? 'button' : 'div'"
          :type="row.go ? 'button' : undefined"
          class="l-row"
          :class="[row.tone, { go: row.go }]"
          :title="row.title"
          @click="row.go && emit('go', row.event)"
        >
          <time class="num" :datetime="new Date(row.event.at * 1000).toISOString()" :title="row.full">{{ row.time }}</time>
          <img v-if="row.emblem" :key="row.emblem" class="l-mark" :src="row.emblem" alt="" @error="hideImage" />
          <span v-else class="l-dot" :style="{ background: row.colour }" aria-hidden="true"></span>
          <span class="l-text">{{ row.text }}</span>
        </component>
      </li>
    </ol>
  </section>
</template>

<style scoped>
/* Stands on the dark sky in both of the board's themes, like the map's other labels. */
.log {
  --row: 20px;
  position: absolute;
  left: 10px;
  bottom: 8px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(540px, calc(100% - 20px));
  max-height: 50%;
  padding: 2px 4px 4px;
  border: 10px solid transparent;
  border-image: var(--frame) 30 / 10px / 0 stretch;
  background: rgba(8, 10, 15, 0.88);
  background-clip: padding-box;
  color: #e8e2d4;
  font-size: 12px;
  line-height: 16px;
}

.l-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 3px 2px;
}

.l-head h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: #f3c27a;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.l-where {
  color: #9b907c;
  font-weight: 400;
}

.l-toggle {
  flex: none;
  padding: 0 4px;
  border: 0;
  border-radius: 2px;
  background: none;
  color: #b8ad98;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.l-toggle:hover {
  color: #f3c64e;
}

.l-rows {
  /* Five rows folded; unfolded, the rest of half the map. */
  height: calc(var(--row) * 5);
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

.log.open .l-rows {
  flex: 1;
  height: auto;
  min-height: calc(var(--row) * 5);
}

.l-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: var(--row);
  margin: 0;
  padding: 0 3px;
  border: 0;
  border-radius: 2px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
}

.l-row.go {
  cursor: pointer;
}

.l-row.go:hover {
  background: rgba(214, 170, 96, 0.18);
}

.l-row:focus-visible,
.l-toggle:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: -1px;
}

.l-row time {
  flex: none;
  color: #9b907c;
}

.l-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.06);
}

.l-mark {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 2px;
  object-fit: contain;
}

.l-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.l-row.ok .l-text {
  color: #cfe3c4;
}

.l-row.bad .l-text {
  color: #ffb3a3;
}

.l-note {
  padding: 2px 3px;
  overflow: hidden;
  color: #a89c86;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.l-note.bad {
  color: #ff8d7a;
}

@media (max-width: 760px) {
  .log {
    --row: 22px;
    left: 4px;
    bottom: 4px;
    width: calc(100% - 8px);
  }
}
</style>
