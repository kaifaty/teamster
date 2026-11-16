<script setup lang="ts">
// The duty block: the subscription teamster keeps for the orchestrator, its portrait in an amber-edged window and over
// its foot what is left in it, how it was chosen, since when it is on duty and how many tasks are live. A click opens
// the duty's choice. Compact, on a narrow window, it is one line of the panel's strip with a small portrait.
import type { DutyBlock } from "./texts";

defineProps<{
  duty: DutyBlock;
  /** The duty's portrait, or null. */
  portrait: string | null;
  /** How the duty was chosen, in a quiet line under its name; `alarm` when a pinned duty cannot work now. */
  line?: { text: string; alarm: boolean } | null;
  /** The duty's choice stands open. */
  expanded?: boolean;
  compact?: boolean;
}>();
/** `opener`: the pressed element, to give the focus back to when the choice closes. */
const emit = defineEmits<{ pick: [opener: HTMLElement] }>();
</script>

<template>
  <button
    type="button"
    class="console-block console-duty c-press"
    :class="[duty.executor, { compact, off: duty.off, none: !duty.key }]"
    :title="duty.key ? `${duty.title}\nВыбрать дежурного` : 'Выбрать дежурного'"
    :aria-label="`${duty.label ?? (line ? 'Дежурный не выбран' : duty.heading)}. Выбрать дежурного`"
    aria-haspopup="dialog"
    :aria-expanded="expanded"
    @click="emit('pick', $event.currentTarget as HTMLElement)"
  >
    <img v-if="portrait && duty.key" class="duty-portrait" :src="portrait" alt="" />
    <span class="d-caption">
      <span v-if="duty.key" class="d-head c-name">Дежурный · <span class="d-name">{{ duty.name }}</span></span>
      <span v-else class="d-head c-name">{{ line ? "Дежурный" : duty.heading }}</span>
      <span v-if="line && !compact" class="d-mode c-text" :class="{ alarm: line.alarm }">{{ line.text }}</span>
      <span v-if="duty.key" class="d-line c-text"><template v-if="!compact"><span class="d-family">{{ duty.family }}</span> · </template><span class="num">{{ duty.info }}</span></span>
      <span v-if="duty.since && !compact" class="d-line c-text c-muted num">{{ duty.since }}</span>
      <span v-if="!compact" class="d-live c-text num"><template v-for="(part, i) in duty.live.split(' · ')" :key="i"><template v-if="i"> · </template><span class="d-part">{{ part }}</span></template></span>
      <span v-else-if="!duty.key" class="d-mode c-text">{{ line?.text ?? "" }}</span>
    </span>
  </button>
</template>

<style scoped src="./console.css"></style>

<style scoped>
/*
 * The duty's window: the portrait fills it, its corners follow the frame's compartment (--window-radius from the panel),
 * and an amber edge runs round it like the frame's inner kant. The caption stands over the portrait's foot.
 */
.console-duty {
  position: relative;
  justify-content: flex-end;
  overflow: hidden;
  margin: 0;
  padding: 0;
  border: 1px solid rgba(240, 165, 70, 0.75);
  border-radius: var(--window-radius, 6px);
  background: #060910;
  box-shadow:
    0 0 0 1px rgba(20, 12, 4, 0.9),
    0 0 6px rgba(240, 150, 50, 0.35);
  font: inherit;
  font-size: 12px;
  text-align: center;
}

.duty-portrait {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 50% 12%;
}

.console-duty.off .duty-portrait {
  filter: grayscale(1) brightness(0.75);
}

.d-caption {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  padding: 10px 8px 4px;
  background: linear-gradient(to bottom, transparent, rgba(5, 7, 12, 0.82) 30%, rgba(5, 7, 12, 0.94));
  line-height: 13px;
}

.console-duty.none {
  justify-content: center;
}

.console-duty.none .d-caption {
  background: none;
}

.d-head {
  display: -webkit-box;
  max-width: 100%;
  color: #f3c64e;
  font-size: 11.5px;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.console-duty.none .d-head {
  color: #b8ad98;
}

/* The name moves under «Дежурный ·» whole rather than breaking at a hyphen. */
.d-name {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}

.d-mode {
  max-width: 100%;
  color: #b8ad98;
  font-size: 11px;
  font-style: italic;
  white-space: normal;
}

.d-mode.alarm {
  color: #ff8d7a;
  font-style: normal;
}

.d-line,
.d-live {
  max-width: 100%;
  font-size: 11px;
}

/* The live tasks may take two lines in a small window rather than lose their end. */
.d-live {
  white-space: normal;
}

.d-part {
  white-space: nowrap;
}

.console-duty.codex .d-family {
  color: #7ea6f5;
}

.console-duty.claude .d-family {
  color: #e59472;
}

.d-live {
  color: #cfc6b4;
}

.console-duty:hover .duty-portrait {
  filter: brightness(1.12);
}

.console-duty.off:hover .duty-portrait {
  filter: grayscale(1) brightness(0.85);
}

/* One line of the narrow window's strip, a small portrait before it. */
.console-duty.compact {
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  height: auto;
  min-height: 40px;
  padding: 0 6px 0 0;
  border-radius: 4px;
  box-shadow: none;
  text-align: left;
}

.console-duty.compact .duty-portrait {
  position: static;
  flex: none;
  width: 38px;
  height: 38px;
}

.console-duty.compact .d-caption {
  flex-direction: row;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  padding: 0 0 0 4px;
  background: none;
}

.console-duty.compact .d-head {
  display: block;
  flex: 0 1 auto;
  white-space: nowrap;
}

.console-duty.compact .d-line {
  flex: none;
}
</style>
