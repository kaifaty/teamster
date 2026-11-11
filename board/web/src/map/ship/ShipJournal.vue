<script setup lang="ts">
// The deck «Журнал рейса»: on the left the correspondence by time — your orders, the stations' reports, the first line
// of the captain's last report and the orders waiting in the queue; on the right the flight recorder. An order the end
// of a cycle dropped can go into the reply again.
import { computed, ref, watch } from "vue";
import { formatClock } from "../../lib/format";
import type { BoardSource } from "../../lib/source";
import type { Cargo, TaskLimits, TaskMessage, TaskSummary } from "../../types";
import type { ShipDesk } from "./desk";
import { deskOf, feedOf, isLong } from "./orders";
import ShipRecorder from "./ShipRecorder.vue";

const props = defineProps<{
  task: TaskSummary;
  desk: ShipDesk;
  messages: TaskMessage[];
  cargo: Cargo | null;
  limits: TaskLimits | null | undefined;
  source: BoardSource;
  now: number;
}>();

const view = computed(() => deskOf(props.task, props.desk.queue.value));
const feed = computed(() => feedOf(props.task, props.messages, props.cargo, props.desk.echo.value, props.desk.queued.value));
const busy = computed(() => !!props.desk.groups.reply.busy);

const open = ref(new Set<string>());
watch(
  () => props.task.slug,
  () => (open.value = new Set()),
);
function unfold(key: string) {
  open.value = new Set([...open.value, key]);
}
</script>

<template>
  <section class="deck journal" aria-labelledby="journal-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">▤</span>
      <h3 id="journal-deck">Журнал рейса</h3>
      <span class="aside">переписка и где корабль провёл время</span>
    </div>
    <div class="log">
      <div class="part">
        <div class="label">Переписка <span class="meta">твои указания и доклады</span></div>
        <ol v-if="feed.length" class="feed">
          <li v-for="item in feed" :key="item.key" class="msg" :class="[item.tone, item.queue]">
            <div class="from">
              <b>{{ item.who }}</b>
              <span>{{ [item.at !== null ? formatClock(item.at, now) : null, item.note].filter(Boolean).join(" · ") }}</span>
            </div>
            <p :class="{ folded: isLong(item.text) && !open.has(item.key) }">{{ item.text }}</p>
            <button v-if="isLong(item.text) && !open.has(item.key)" type="button" class="more" @click="unfold(item.key)">показать целиком</button>
            <button v-if="item.queue === 'dropped' && view.send" type="button" class="more" :disabled="busy" @click="desk.fill(item.text)">Отправить снова</button>
          </li>
        </ol>
        <p v-else class="empty">Переписки пока нет: рейс идёт по заданию.</p>
      </div>
      <div class="part">
        <div class="label">Самописец <span class="meta">весь рейс по времени</span></div>
        <ShipRecorder :task="task" :source="source" :messages="messages" :limits="limits" :now="now" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.log {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
  gap: 14px;
}

.part {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
}

.label {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  color: var(--sh-faint);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.label .meta {
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}

.feed {
  display: grid;
  gap: 7px;
  max-height: 420px;
  margin: 0;
  padding: 0 2px 0 0;
  overflow-y: auto;
  list-style: none;
  scrollbar-width: thin;
}

.msg {
  display: grid;
  gap: 2px;
  padding: 6px 9px;
  border: 1px solid rgba(214, 170, 96, 0.12);
  border-radius: 8px;
  background: var(--sh-well);
}

.from {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  color: var(--sh-dim);
  font-size: 11.5px;
}

.from b {
  font-weight: 600;
}

.msg.you {
  border-color: rgba(243, 194, 122, 0.3);
}

.msg.you b {
  color: var(--sh-title);
}

.msg.agent b {
  color: var(--sh-copper);
}

.msg.sys b {
  color: var(--sh-blue);
}

.msg.waiting {
  border-style: dashed;
}

.msg.dropped {
  border-color: rgba(255, 141, 122, 0.35);
  opacity: 0.85;
}

.msg.dropped .from span {
  color: var(--sh-red);
}

.msg p {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.msg p.folded {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  line-clamp: 4;
}

.more {
  justify-self: start;
  padding: 0;
  border: 0;
  background: none;
  color: #8fd8ff;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

@media (max-width: 860px) {
  .log {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
