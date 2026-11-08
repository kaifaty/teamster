<script setup lang="ts">
// The ship's log at the bottom of the map: the fleet's completed phases and the lead's verdicts, newest first.
import { computed, nextTick, ref, watch } from "vue";
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
  /** The replay's moment: the rows up to it are marked and scrolled to, and every row moves the replay. */
  at?: number | null;
}>();
const emit = defineEmits<{ go: [event: LogEvent]; seek: [event: LogEvent] }>();

/** In replay, this many rows after the moment stay above it. */
const AHEAD = 50;

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
  const at = props.at ?? null;
  // In replay the rows shown are those around the moment, not only the newest ones.
  let top = list.length - 1;
  if (at !== null) {
    let past = list.length - 1;
    while (past >= 0 && list[past]!.at > at) past--;
    top = Math.min(list.length - 1, past + AHEAD);
  }
  const rows = [];
  let current = true;
  for (let i = top; i >= 0 && rows.length < SHOWN; i--) {
    const event = list[i]!;
    const line = describeEvent(event);
    const past = at !== null && event.at <= at;
    rows.push({
      past,
      future: at !== null && !past,
      current: past && current,
      key: eventKey(event),
      event,
      time: clock.format(new Date(event.at * 1000)),
      full: formatFullTime(event.at),
      text: line.text,
      tone: line.tone,
      go: at !== null || (event.repo !== null && props.systems.has(event.repo)),
      emblem: props.emblemOf(event.repo),
      colour: event.repo ? sunColour(event.repo) : "#6f6a60",
      title: [formatFullTime(event.at), event.repo, line.text, event.note].filter(Boolean).join("\n"),
    });
    if (past) current = false;
  }
  return rows;
});

// In replay the latest row up to the moment stays in view, moved only within the log.
const list = ref<HTMLElement | null>(null);
watch(
  () => rows.value.find((row) => row.current)?.key,
  (key) => {
    if (key === undefined) return;
    void nextTick(() => {
      const box = list.value;
      const row = box?.querySelector<HTMLElement>(".l-row.current");
      if (!box || !row) return;
      const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) {
        box.scrollTop = Math.max(0, top - box.clientHeight / 2);
      }
    });
  },
);

function pick(row: { go: boolean; event: LogEvent }) {
  if (!row.go) return;
  if (props.at !== null && props.at !== undefined) emit("seek", row.event);
  else emit("go", row.event);
}

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
    <ol ref="list" class="l-rows" :aria-live="at == null ? 'polite' : 'off'" aria-relevant="additions">
      <li v-if="error" class="l-note bad" :title="error">Журнал не загрузился: {{ error }}</li>
      <li v-else-if="!rows.length" class="l-note">{{ repo ? "В этой системе за сутки тихо." : "За сутки в журнале ни строчки." }}</li>
      <li v-for="row in rows" :key="row.key">
        <component
          :is="row.go ? 'button' : 'div'"
          :type="row.go ? 'button' : undefined"
          class="l-row"
          :class="[row.tone, { go: row.go, past: row.past, future: row.future, current: row.current }]"
          :title="row.title"
          :aria-current="row.current ? 'time' : undefined"
          @click="pick(row)"
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
  /* Placed by the map, at the bottom under the replay's scale. */
  position: relative;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  min-height: 0;
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

/* Replay: the rows still ahead are dim, the ones behind the moment carry a mark on the left. */
.l-row.future {
  opacity: 0.45;
}

.l-row.past {
  box-shadow: inset 2px 0 0 rgba(214, 170, 96, 0.45);
}

.l-row.current {
  background: rgba(243, 198, 78, 0.16);
  box-shadow: inset 2px 0 0 #f3c64e;
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
  }
}
</style>
