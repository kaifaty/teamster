<script setup lang="ts">
// The machines block: every machine with its CPU and memory, or its status while nothing is known of them. A click opens
// the machine's card, which gives the focus back to the row when it closes.
import type { MachineRow } from "./texts";

defineProps<{
  rows: readonly MachineRow[];
  /** Why the machines' config was not read, or null. */
  note: string | null;
  /** The machine whose card is open, or null. */
  open: string | null;
}>();
const emit = defineEmits<{ open: [id: string, opener: HTMLElement] }>();
</script>

<template>
  <section class="console-block console-machines" aria-labelledby="console-machines-title">
    <h2 id="console-machines-title" class="c-title">Машины</h2>
    <p v-if="note" class="c-note bad c-text" :title="note">Конфиг машин не прочитан: {{ note }}</p>
    <p v-if="!rows.length && !note" class="c-note">Машин нет</p>
    <ul v-if="rows.length" class="c-rows">
      <li v-for="row in rows" :key="row.id" :data-machine="row.id">
        <button
          type="button"
          class="c-row m-row"
          :class="[row.level, { dim: row.dim }]"
          :title="row.title"
          :aria-label="row.label"
          :aria-pressed="open === row.id"
          @click="emit('open', row.id, $event.currentTarget as HTMLElement)"
        >
          <span class="m-line">
            <i class="m-dot" aria-hidden="true"></i>
            <span class="c-name">{{ row.name }}</span>
          </span>
          <span class="m-info c-text num">{{ row.line }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped src="./console.css"></style>

<style scoped>
/* The status takes the board's level colours at their dark values: the panel is dark in both themes. */
.m-row {
  --level: #9aa3b0;
}

.m-row.ok {
  --level: #5fc48c;
}

.m-row.warn {
  --level: #e0b04f;
}

.m-row.bad {
  --level: #f07f76;
}

.m-row[aria-pressed="true"] {
  border-color: #ffffff;
}

.m-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.m-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--level);
}

.m-row.dim .m-dot {
  border: 1.5px dashed var(--level);
  background: none;
}

.m-info {
  padding-left: 13px;
  color: #c9c1b0;
  font-size: 11px;
  line-height: 13px;
}

.m-row.dim .m-info {
  color: #9aa3b0;
}
</style>
