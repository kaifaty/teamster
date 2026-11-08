<script setup lang="ts">
// teamster commands for the task, copied to the clipboard: the board never runs anything itself.
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { TaskSummary } from "../types";
import { VERDICTS, sayCommand, takesWords, taskCommands, verdictCommand, type Verdict } from "../lib/commands";

const props = defineProps<{ task: Pick<TaskSummary, "slug" | "kind"> }>();

const plain = computed(() => taskCommands(props.task));
const words = computed(() => takesWords(props.task));
const verdict = ref<Verdict>("accepted");
const note = ref("");
const message = ref("");

/** The last command and where it came from; the field shows it, selected when the clipboard refused it. */
const last = ref<{ from: string; command: string; copied: boolean } | null>(null);
const field = ref<HTMLInputElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => props.task.slug,
  () => {
    last.value = null;
    note.value = "";
    message.value = "";
  },
);

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
    <div class="row">
      <button
        v-for="item in plain"
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
      <div class="row">
        <select v-model="verdict" class="btn" aria-label="Вердикт">
          <option v-for="option in VERDICTS" :key="option" :value="option">{{ option }}</option>
        </select>
        <input v-model="note" class="field grow" type="text" maxlength="200" placeholder="заметка, необязательно" aria-label="Заметка к вердикту" />
        <button type="button" class="btn cmd" @click="copy('verdict', verdictCommand(task.slug, verdict, note))">
          <span class="mono">{{ flash("verdict") ? "скопировано" : "verdict" }}</span>
        </button>
      </div>
      <div class="row">
        <textarea v-model="message" class="field grow" rows="2" placeholder="Что сказать задаче" aria-label="Текст для teamster say"></textarea>
        <button type="button" class="btn cmd" :disabled="!message.trim()" @click="copy('say', sayCommand(task.slug, message))">
          <span class="mono">{{ flash("say") ? "скопировано" : "say" }}</span>
        </button>
      </div>
    </template>

    <p v-if="last && !last.copied" class="manual">Буфер обмена недоступен — скопируй вручную:</p>
    <input
      v-if="last"
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

textarea.field {
  resize: vertical;
  min-height: 2.6em;
}

.out {
  display: block;
  width: 100%;
  font-size: 11.5px;
}

.manual {
  margin: 0 0 4px;
  color: var(--warn);
  font-size: 12px;
}
</style>
