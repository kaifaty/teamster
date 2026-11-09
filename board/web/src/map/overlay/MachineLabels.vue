<script setup lang="ts">
// The machines' labels, each on the left of its reactor, and the line over their column about a config that was not
// read. They share the level colours.
import type { machineLabels as machineLabelsOf } from "./machines";
import type { at } from "./style";

defineProps<{
  machineLabels: ReturnType<typeof machineLabelsOf>;
  /** The machine whose card is open, or null. */
  machine?: string | null;
  machineNoteStyle: ReturnType<typeof at> | null;
  machineNote: string | null;
}>();
/** A reactor's label was clicked: the focus goes back to it when the machine's card closes. */
const emit = defineEmits<{ open: [id: string, opener: HTMLElement] }>();
</script>

<template>
  <div
    v-for="label in machineLabels"
    :key="label.machine.id"
    class="machine"
    :class="{ open: machine === label.machine.id }"
    :style="label.style"
    :data-machine="label.machine.id"
  >
    <button
      type="button"
      class="m-label"
      :class="label.machine.status"
      :title="label.title"
      :aria-pressed="machine === label.machine.id"
      @click="emit('open', label.machine.id, $event.currentTarget as HTMLElement)"
    >
      <span class="m-name">{{ label.machine.name }}</span>
      <span v-if="label.showStatus && label.free.length" class="m-free num">
        <span v-for="item in label.free" :key="item.key" class="m-item" :class="item.level"><i class="m-dot" :style="{ background: item.color }" aria-hidden="true" />{{ item.text }}</span>
      </span>
      <span v-else-if="label.showStatus" class="m-status" :class="label.level">{{ label.status }}</span>
    </button>
  </div>
  <p v-if="machineNoteStyle" class="machine-note" :style="machineNoteStyle" :title="machineNote ?? ''">
    Конфиг машин не прочитан: {{ machineNote }}
  </p>
</template>

<style scoped src="./overlay.css"></style>

<style scoped>
/*
 * A machine's label on the left of its reactor, at the height of its centre. The status takes the board's level
 * colours at their dark values: the sky is dark in both themes. The line about a broken config stands over the column.
 */
.machine,
.machine-note {
  --ok: #5fc48c;
  --warn: #e0b04f;
  --bad: #f07f76;
  --muted: #9aa3b0;
  transform: translateX(-100%);
}

.machine {
  transform: translate(-100%, -50%);
}

.m-label {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  box-sizing: border-box;
  max-width: 180px;
  margin: 0;
  padding: 1px 7px;
  border: 1px solid rgba(214, 170, 96, 0.28);
  border-radius: 3px;
  background: rgba(8, 11, 18, 0.8);
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  line-height: 14px;
  text-align: right;
  white-space: nowrap;
  pointer-events: auto;
  cursor: pointer;
}

.m-label:hover {
  border-color: rgba(243, 198, 78, 0.8);
  background: rgba(26, 28, 34, 0.92);
}

.m-label:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.machine.open .m-label {
  border-color: #ffffff;
  background: rgba(26, 28, 34, 0.92);
}

.m-label.overloaded {
  border-color: rgba(255, 141, 122, 0.55);
}

.m-label.unknown {
  opacity: 0.8;
}

.m-name,
.m-status {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.m-name {
  font-size: 12px;
  font-weight: 650;
  line-height: 15px;
}

.m-status.ok {
  color: var(--ok);
}

.m-status.warn {
  color: var(--warn);
}

.m-status.bad {
  color: var(--bad);
}

.m-status.muted {
  color: var(--muted);
}

/* What is free on the machine, each figure after a dot of its ring's colour; gold or red while its ring is pressed. */
.m-free {
  display: flex;
  gap: 7px;
  max-width: 100%;
  overflow: hidden;
  color: #c9c1b0;
}

.m-item {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
}

.m-item.warn {
  color: var(--warn);
}

.m-item.bad {
  color: var(--bad);
}

.m-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.machine-note {
  max-width: 280px;
  margin: 0;
  overflow: hidden;
  color: var(--bad);
  font-size: 11.5px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow:
    0 0 3px #05070d,
    0 0 2px #05070d;
  pointer-events: auto;
}
</style>
