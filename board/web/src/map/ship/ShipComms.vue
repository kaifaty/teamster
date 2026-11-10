<script setup lang="ts">
// The comms room: the lead's orders, the stations' reports and the captain's last report with its questions, by time;
// under them the reply, which goes to the ship at once with the refit's changed fields. A ship at work takes the reply
// only once its turn ends; an archived ship, a session and a scout take none.
import { computed, ref, watch } from "vue";
import { formatClock } from "../../lib/format";
import { CONTINUE, MERGE, returnText } from "../../lib/orders";
import type { Cargo, TaskMessage, TaskSummary } from "../../types";
import CopiedNote from "../station/CopiedNote.vue";
import { isSendKey } from "../station";
import type { ShipDesk } from "./desk";
import { deskOf, feedOf, isLong } from "./orders";

const props = defineProps<{ task: TaskSummary; desk: ShipDesk; messages: TaskMessage[]; cargo: Cargo | null; now: number }>();

const view = computed(() => deskOf(props.task));
const feed = computed(() => feedOf(props.task, props.messages, props.cargo, props.desk.echo.value));
const state = computed(() => props.desk.groups.reply);
const busy = computed(() => !!state.value.busy);

const open = ref(new Set<string>());
watch(
  () => props.task.slug,
  () => (open.value = new Set()),
);
function unfold(key: string) {
  open.value = new Set([...open.value, key]);
}

const QUICK = computed(() => [
  { label: "Продолжай", text: CONTINUE },
  { label: "Доработай находки", text: returnText(props.cargo) },
  { label: "Слей main", text: MERGE },
]);

function setField(element: unknown) {
  props.desk.field.value = element instanceof HTMLTextAreaElement ? element : null;
}

function onKey(event: KeyboardEvent) {
  if (!view.value.send || !isSendKey(event)) return;
  event.preventDefault();
  void props.desk.send();
}
</script>

<template>
  <section class="deck comms" aria-labelledby="comms-deck">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">≋</span>
      <h3 id="comms-deck">Рубка связи</h3>
      <span class="aside">приказы, доклады, вопросы</span>
    </div>

    <ol v-if="feed.length" class="feed">
      <li v-for="item in feed" :key="item.key" class="msg" :class="item.tone">
        <div class="from">
          <b>{{ item.who }}</b>
          <span>{{ [item.at !== null ? formatClock(item.at, now) : null, item.note].filter(Boolean).join(" · ") }}</span>
        </div>
        <p :class="{ folded: isLong(item.text) && !open.has(item.key) }">{{ item.text }}</p>
        <button v-if="isLong(item.text) && !open.has(item.key)" type="button" class="more" @click="unfold(item.key)">показать целиком</button>
      </li>
    </ol>
    <p v-else class="empty">Переговоров пока нет.</p>

    <form v-if="view.reply" class="reply" @submit.prevent="desk.send">
      <label class="dim label" for="ship-say">Указание кораблю</label>
      <textarea
        id="ship-say"
        :ref="setField"
        v-model="desk.reply.value"
        rows="3"
        placeholder="Например: сначала закрой P1, P2 можно позже"
        :disabled="busy"
        @keydown="onKey"
      ></textarea>
      <div class="chips">
        <button v-for="quick in QUICK" :key="quick.label" type="button" class="chip" :disabled="busy" @click="desk.fill(quick.text)">{{ quick.label }}</button>
      </div>
      <div class="row">
        <template v-if="view.send">
          <span class="dim hint">С изменёнными полями переоснащения · ⌘/Ctrl+Enter</span>
          <button type="submit" class="key main" :disabled="busy || !desk.reply.value.trim()">{{ state.busy ? "Передаю…" : "Передать" }}</button>
        </template>
        <p v-else class="hint wait">Идёт ход: teamster примет указание, когда ход кончится. Срочное — через «Остановить».</p>
      </div>
      <p v-if="state.done" class="result ok" role="status">{{ state.done }}</p>
      <p v-if="state.error" class="result bad" role="alert">{{ state.error }}</p>
      <CopiedNote v-if="state.copied" :copied="state.copied" />
    </form>
  </section>
</template>

<style scoped>
.feed {
  display: grid;
  gap: 8px;
  max-height: 460px;
  margin: 0;
  padding: 0 2px 0 0;
  overflow-y: auto;
  list-style: none;
  scrollbar-width: thin;
}

.msg {
  display: grid;
  gap: 3px;
  padding: 7px 9px;
  border: 1px solid rgba(214, 170, 96, 0.14);
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
  letter-spacing: 0.04em;
}

.msg.you {
  margin-left: 22px;
  border-color: rgba(243, 194, 122, 0.35);
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

.msg.ask {
  border-color: var(--sh-wait);
  box-shadow: 0 0 0 3px rgba(243, 198, 78, 0.1);
}

.msg.ask b {
  color: var(--sh-wait);
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

.reply {
  display: grid;
  gap: 6px;
}

.label {
  font-size: 11.5px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.hint {
  flex: 1 1 160px;
  margin: 0;
  font-size: 11.5px;
}

.hint.wait {
  color: var(--sh-wait);
}
</style>
