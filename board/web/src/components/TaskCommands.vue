<script setup lang="ts">
// teamster commands for the task, copied to the clipboard: the board never runs anything itself.
// The order the task's state calls for comes first; the other commands fold under "Все команды".
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Cargo, TaskSummary } from "../types";
import { VERDICTS, sayCommand, takesWords, taskCommands, verdictCommand, type Verdict } from "../lib/commands";
import { recommendedOrder, returnText } from "../lib/orders";

const props = defineProps<{
  task: TaskSummary;
  now: number;
  /** What the task came back with, once its detail has loaded; "вернуть на доработку" lists it. */
  cargo?: Cargo | null;
}>();

const plain = computed(() => taskCommands(props.task));
const words = computed(() => takesWords(props.task));
const order = computed(() => recommendedOrder(props.task, props.now));
/** The order copies its own command with the main button, unless the human has to write or pick something. */
const button = computed(() => {
  const value = order.value;
  return value && value.action !== "say" && value.action !== "verdict" && value.command !== null ? { label: value.label, command: value.command } : null;
});
/** On the roadstead the order block switches between accepting the task and returning it with `say`. */
const roadstead = computed(() => props.task.column === "review_me" && words.value && order.value !== null);
/** The human's choice on the roadstead; null follows the order. */
const choice = ref<"verdict" | "say" | null>(null);
/** What the order block shows: the order's own action, or the human's choice on the roadstead. */
const shownAction = computed(() => (roadstead.value ? (choice.value ?? order.value?.action) : order.value?.action));
const returned = computed(() => returnText(props.cargo));
/** Lines in the say field: a long text takes the order block's full width. */
const lines = computed(() => message.value.split("\n").length);
/** The plain commands under "Все команды": every one but the order's own, which comes back here once the human
 * chose to accept or return the task and the order's button is hidden. */
const rest = computed(() => plain.value.filter((item) => choice.value !== null || item.command !== order.value?.command));
const verdict = ref<Verdict>(order.value?.verdict ?? "accepted");
const note = ref("");
const message = ref(order.value?.text ?? "");

/** The last command and where it came from; the field shows it, selected when the clipboard refused it. */
const last = ref<{ from: string; command: string; copied: boolean } | null>(null);
const field = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
const sayField = ref<HTMLTextAreaElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

watch(
  [() => props.task.slug, () => order.value?.text, () => order.value?.verdict] as const,
  ([slug, text, chosen], [oldSlug, oldText, oldChosen]) => {
    if (slug !== oldSlug) {
      choice.value = null;
      last.value = null;
      note.value = "";
      message.value = text ?? "";
      verdict.value = chosen ?? "accepted";
      return;
    }
    // The same task got a new order: follow it only where the human has not touched the field.
    if (text !== oldText || chosen !== oldChosen) choice.value = null;
    if (!message.value || message.value === (oldText ?? "")) message.value = text ?? "";
    if (verdict.value === (oldChosen ?? "accepted")) verdict.value = chosen ?? "accepted";
  },
);

/** "вернуть на доработку": the cargo's items go into the say field, and the field takes the focus. */
async function giveBack() {
  choice.value = "say";
  message.value = returned.value;
  await nextTick();
  const area = sayField.value;
  if (!area) return;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

/** "принять": back to the verdict, from the order or from the return. */
function accept() {
  choice.value = "verdict";
  verdict.value = "accepted";
}

async function copy(from: string, command: string) {
  clearTimeout(timer);
  let copied = false;
  try {
    if (!navigator.clipboard) throw new Error("no clipboard");
    await navigator.clipboard.writeText(command);
    copied = true;
  } catch {
    copied = false;
  }
  last.value = { from, command, copied };
  if (copied) {
    timer = setTimeout(() => {
      if (last.value?.command === command) last.value = { ...last.value, from: "" };
    }, 1600);
  } else {
    await nextTick();
    field.value?.focus();
    field.value?.select();
  }
}

const flash = (from: string) => last.value?.from === from && last.value.copied;
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <section v-if="plain.length" class="commands" aria-labelledby="commands-title">
    <h3 id="commands-title">Команды</h3>

    <div v-if="order" :class="['order', order.tone]">
      <p class="reason">{{ order.reason }}</p>
      <div v-if="button && choice === null" class="row">
        <button type="button" class="btn cmd main" :title="button.command" @click="copy('order', button.command)">
          <span class="mono">{{ flash("order") ? "скопировано" : button.label }}</span>
        </button>
        <button v-if="roadstead" type="button" class="btn cmd" @click="giveBack">вернуть на доработку</button>
      </div>
      <div v-else-if="shownAction === 'verdict' && words" class="row">
        <select v-model="verdict" class="btn" aria-label="Вердикт">
          <option v-for="option in VERDICTS" :key="option" :value="option">{{ option }}</option>
        </select>
        <input v-model="note" class="field grow" type="text" maxlength="200" placeholder="заметка, необязательно" aria-label="Заметка к вердикту" />
        <button type="button" class="btn cmd main" @click="copy('verdict', verdictCommand(task.slug, verdict, note))">
          <span class="mono">{{ flash("verdict") ? "скопировано" : `verdict ${verdict}` }}</span>
        </button>
        <button v-if="roadstead" type="button" class="btn cmd" @click="giveBack">вернуть на доработку</button>
      </div>
      <div v-else-if="shownAction === 'say' && words" class="row">
        <textarea
          ref="sayField"
          v-model="message"
          :class="['field', 'grow', { wide: lines > 1 }]"
          :rows="lines > 1 ? Math.min(10, lines + 1) : 2"
          placeholder="Твой ответ задаче"
          aria-label="Текст для teamster say"
        ></textarea>
        <button type="button" class="btn cmd main" :disabled="!message.trim()" @click="copy('say', sayCommand(task.slug, message))">
          <span class="mono">{{ flash("say") ? "скопировано" : "say" }}</span>
        </button>
        <template v-if="roadstead">
          <button v-if="message !== returned" type="button" class="btn cmd" @click="giveBack">вернуть на доработку</button>
          <button type="button" class="btn cmd" @click="accept">принять</button>
        </template>
      </div>
    </div>

    <component :is="order ? 'details' : 'div'" :key="task.slug" :class="{ all: order }">
      <summary v-if="order">Все команды</summary>
      <div class="row">
        <button
          v-for="item in order ? rest : plain"
          :key="item.id"
          type="button"
          class="btn cmd"
          :title="`${item.label}: ${item.command}`"
          @click="copy(item.id, item.command)"
        >
          <span class="mono">{{ flash(item.id) ? "скопировано" : item.id }}</span>
        </button>
      </div>

      <template v-if="words">
        <div v-if="shownAction !== 'verdict'" class="row">
          <select v-model="verdict" class="btn" aria-label="Вердикт">
            <option v-for="option in VERDICTS" :key="option" :value="option">{{ option }}</option>
          </select>
          <input v-model="note" class="field grow" type="text" maxlength="200" placeholder="заметка, необязательно" aria-label="Заметка к вердикту" />
          <button type="button" class="btn cmd" @click="copy('verdict', verdictCommand(task.slug, verdict, note))">
            <span class="mono">{{ flash("verdict") ? "скопировано" : "verdict" }}</span>
          </button>
        </div>
        <div v-if="shownAction !== 'say'" class="row">
          <textarea v-model="message" class="field grow" rows="2" placeholder="Что сказать задаче" aria-label="Текст для teamster say"></textarea>
          <button type="button" class="btn cmd" :disabled="!message.trim()" @click="copy('say', sayCommand(task.slug, message))">
            <span class="mono">{{ flash("say") ? "скопировано" : "say" }}</span>
          </button>
        </div>
      </template>
    </component>

    <p v-if="last && !last.copied" class="manual">Буфер обмена недоступен — скопируй вручную:</p>
    <!-- A text input drops line breaks, so a command with several lines gets a textarea. -->
    <textarea
      v-if="last && last.command.includes('\n')"
      ref="field"
      class="field mono out"
      :rows="Math.min(10, last.command.split('\n').length)"
      readonly
      :value="last.command"
      aria-label="Последняя команда"
      @focus="($event.target as HTMLTextAreaElement).select()"
    ></textarea>
    <input
      v-else-if="last"
      ref="field"
      class="field mono out"
      type="text"
      readonly
      :value="last.command"
      aria-label="Последняя команда"
      @focus="($event.target as HTMLInputElement).select()"
    />
  </section>
</template>

<style scoped>
.commands {
  margin: 0 0 14px;
}

h3 {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--muted);
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 4px;
  margin-bottom: 6px;
}

.cmd {
  min-width: 64px;
  padding: 2px 9px;
}

.cmd .mono {
  font-size: 11.5px;
}

.field {
  min-width: 0;
  padding: 3px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-3);
  color: var(--text);
  font: inherit;
}

.grow {
  flex: 1 1 160px;
}

.wide {
  flex-basis: 100%;
}

textarea.field {
  resize: vertical;
  min-height: 2.6em;
}

.out {
  display: block;
  width: 100%;
  font-size: 11.5px;
}

.order {
  --tone: var(--muted);
  --tone-soft: var(--surface-3);
  --tone-edge: var(--border);
  margin-bottom: 8px;
  padding: 6px 8px 2px;
  border: 1px solid var(--tone-edge);
  border-left: 3px solid var(--tone);
  border-radius: var(--radius);
  background: var(--tone-soft);
}

.order.ok {
  --tone: var(--ok);
  --tone-soft: var(--ok-soft);
  --tone-edge: var(--ok-soft);
}

.order.warn {
  --tone: var(--warn);
  --tone-soft: var(--warn-soft);
  --tone-edge: var(--warn-soft);
}

.order.bad {
  --tone: var(--bad);
  --tone-soft: var(--bad-soft);
  --tone-edge: var(--bad-soft);
}

.order.muted {
  --tone: var(--border-strong);
}

.reason {
  margin: 0 0 6px;
  color: var(--tone);
  font-weight: 600;
}

.order.muted .reason {
  color: var(--muted);
}

.main {
  border-color: var(--text);
  background: var(--text);
  color: var(--surface);
  font-weight: 600;
}

.main:hover {
  border-color: var(--text);
  opacity: 0.88;
}

.main:disabled {
  opacity: 0.45;
  cursor: default;
}

.all {
  margin-bottom: 6px;
}

.all > summary {
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.all:not([open]) > summary {
  margin-bottom: 0;
}

.manual {
  margin: 0 0 4px;
  color: var(--warn);
  font-size: 12px;
}
</style>
