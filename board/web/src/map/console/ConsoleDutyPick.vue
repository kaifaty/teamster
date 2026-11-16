<script setup lang="ts">
// The duty's choice: a small panel over the left wing (or a block of the narrow window's sheet) with «Выбирать
// автоматически» and every account of both families, its weekly share left and its state, the duty marked. Choosing an
// account pins it at once; one that needs a login is shown off with the reason. Arrows and Tab walk the accounts, Escape
// closes the panel. When choosing cannot work, everything stays visible, switched off, under the reason.
import { nextTick, onMounted, ref } from "vue";
import type { DutyMode } from "../../dutyTypes";
import type { DutyChoice } from "./dutyPick";

const props = defineProps<{
  choices: readonly DutyChoice[];
  mode: DutyMode | null;
  line: { text: string; alarm: boolean } | null;
  /** Why choosing cannot work, or null. */
  off: string | null;
  error: string | null;
  warning: string | null;
  /** The last automatic election's failure. */
  electionError: string | null;
  /** A block of the narrow window's sheet rather than a panel over the wing. */
  inline?: boolean;
}>();
const emit = defineEmits<{ pick: [choice: DutyChoice]; auto: [on: boolean]; close: [] }>();

const root = ref<HTMLElement | null>(null);
const accounts = () => [...(root.value?.querySelectorAll<HTMLButtonElement>(".choice:not(:disabled)") ?? [])];

/** The focus goes to the duty's account, or to the first one that can be chosen, or to the checkbox. */
function focusInside() {
  const list = accounts();
  (list.find((button) => button.getAttribute("aria-checked") === "true") ?? list[0] ?? root.value?.querySelector<HTMLElement>("input, .pick-close"))?.focus();
}
defineExpose({ focusInside });
onMounted(() => {
  if (!props.inline) void nextTick(focusInside);
});

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape" && !props.inline) {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const list = accounts();
  const at = list.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
  list[next]?.focus();
}
</script>

<template>
  <section
    ref="root"
    class="duty-pick"
    :class="{ inline }"
    :role="inline ? 'group' : 'dialog'"
    aria-labelledby="duty-pick-title"
    @keydown="onKey"
  >
    <header class="pick-head">
      <h2 id="duty-pick-title" class="pick-title">Дежурный</h2>
      <span v-if="line" class="pick-line" :class="{ alarm: line.alarm }">{{ line.text }}</span>
      <button v-if="!inline" type="button" class="pick-close" aria-label="Закрыть выбор дежурного" title="Закрыть (Esc)" @click="emit('close')">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    </header>
    <p v-if="off" class="pick-note">{{ off }}</p>
    <label class="pick-auto" :class="{ disabled: !!off }">
      <input type="checkbox" :checked="mode === 'auto'" :disabled="!!off" @change="emit('auto', ($event.target as HTMLInputElement).checked)" />
      <span>Выбирать автоматически</span>
    </label>
    <p class="pick-hint">
      {{ mode === "auto" ? "teamster сам выбирает дежурного; выбор подписки ниже закрепит её вручную." : "Выбор подписки закрепляет её дежурной." }}
    </p>
    <ul class="pick-list" role="radiogroup" aria-label="Подписки">
      <li v-for="choice in choices" :key="choice.key">
        <button
          type="button"
          role="radio"
          class="choice"
          :class="[choice.family, { current: choice.current, bad: choice.bad }]"
          :aria-checked="choice.current"
          :disabled="choice.disabled"
          :title="choice.reason ?? (choice.current ? 'Дежурит сейчас' : `Закрепить ${choice.account} дежурным`)"
          @click="emit('pick', choice)"
        >
          <span class="mark" aria-hidden="true">{{ choice.current ? "●" : "○" }}</span>
          <span class="who">
            <span class="name">{{ choice.account }}</span>
            <span class="meta"><span class="fam">{{ choice.familyLabel }}</span> · {{ choice.left }}<template v-if="choice.state"> · {{ choice.state }}</template></span>
            <span v-if="choice.reason" class="why">{{ choice.reason }}</span>
          </span>
          <span v-if="choice.current" class="badge">дежурит</span>
        </button>
      </li>
    </ul>
    <p v-if="error" class="pick-msg bad" role="alert">teamster не принял выбор: {{ error }}</p>
    <p v-else-if="warning" class="pick-msg warn" role="status">teamster предупредил: {{ warning }}</p>
    <p v-if="electionError" class="pick-msg bad">Автоматический выбор не удался: {{ electionError }}</p>
  </section>
</template>

<style scoped>
/*
 * Over the left wing, clear of its top, in the console's cast bronze: an amber kant round a dark glass, like the
 * conversation's panel. On the narrow window's sheet it is one of its blocks.
 */
.duty-pick {
  position: absolute;
  left: calc(var(--u, 0.5px) * 56);
  bottom: calc(100% + 6px);
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-sizing: border-box;
  width: min(360px, calc(100vw - 16px));
  max-height: calc(var(--stage-height, 100vh) - var(--below-toolbar, 46px) - var(--wing-height, 250px) - 14px);
  padding: 8px 10px 10px;
  border: 1px solid rgba(240, 165, 70, 0.75);
  border-radius: 10px 10px 6px 6px;
  background: linear-gradient(to bottom, rgba(20, 13, 6, 0.98), rgba(6, 8, 12, 0.97) 40px);
  box-shadow:
    inset 0 1px 0 rgba(255, 220, 160, 0.35),
    inset 0 0 0 2px rgba(60, 36, 12, 0.9),
    inset 0 0 0 3px rgba(214, 150, 70, 0.35),
    0 6px 22px rgba(0, 0, 0, 0.75);
  color: #e8e2d4;
  font-size: 12px;
  line-height: 16px;
  pointer-events: auto;
}

.duty-pick.inline {
  position: static;
  width: auto;
  max-height: none;
  border-radius: 6px;
}

/* The title and the close button on one line, how the duty was chosen under them. */
.pick-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
}

.pick-title {
  margin: 0;
  color: #f3c27a;
  font-size: 14px;
  font-weight: 650;
}

.pick-line {
  order: 3;
  flex: 1 0 100%;
  min-width: 0;
  color: #a89c86;
  overflow-wrap: anywhere;
}

.pick-line.alarm,
.pick-msg.bad {
  color: #ff8d7a;
}

.pick-close {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 26px;
  height: 24px;
  padding: 0;
  border: 1px solid rgba(214, 150, 70, 0.55);
  border-radius: 5px;
  background: rgba(30, 20, 8, 0.9);
  color: #f3c27a;
  cursor: pointer;
}

.pick-note {
  margin: 0;
  padding: 5px 8px;
  border: 1px solid rgba(214, 150, 70, 0.4);
  border-radius: 6px;
  background: rgba(40, 30, 10, 0.6);
  color: #f6dfb0;
}

.pick-auto {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  color: #f6dfb0;
  font-weight: 650;
  cursor: pointer;
}

.pick-auto input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: #e0a040;
}

.pick-auto.disabled {
  color: #8f846f;
  cursor: default;
}

.pick-hint {
  margin: -4px 0 0 24px;
  color: #8f846f;
  font-size: 11px;
  line-height: 14px;
}

.pick-list {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  min-height: 36px;
  margin: 0 0 3px;
  padding: 3px 8px;
  border: 1px solid rgba(214, 150, 70, 0.25);
  border-radius: 6px;
  background: rgba(24, 20, 14, 0.85);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.choice:hover:not(:disabled) {
  border-color: rgba(243, 198, 78, 0.8);
  background: rgba(48, 34, 14, 0.9);
}

.choice:focus-visible,
.pick-close:focus-visible,
.pick-auto input:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.choice.current {
  border-color: rgba(243, 198, 78, 0.9);
  background: linear-gradient(to bottom, #4a2f0f, #2c1a07);
  box-shadow: inset 0 1px 0 rgba(255, 220, 160, 0.35);
}

.choice:disabled {
  border-style: dashed;
  color: #8f846f;
  cursor: default;
}

.mark {
  flex: none;
  width: 12px;
  color: #f3c64e;
  text-align: center;
}

.who {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.name {
  overflow: hidden;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta,
.why {
  font-size: 11px;
  line-height: 14px;
}

.meta {
  color: #b8ad98;
}

.choice.claude .fam {
  color: #e59472;
}

.choice.codex .fam {
  color: #7ea6f5;
}

.choice.bad .meta {
  color: #c99a8c;
}

.why {
  color: #d9a08f;
}

.badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 8px;
  background: #f3c64e;
  color: #1a1408;
  font-size: 11px;
  font-weight: 700;
}

.pick-msg {
  margin: 0;
  overflow-wrap: anywhere;
}

.pick-msg.warn {
  color: #f3c64e;
}

@media (max-width: 760px) {
  .choice {
    min-height: 44px;
  }
}
</style>
