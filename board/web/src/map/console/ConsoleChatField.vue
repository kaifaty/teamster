<script setup lang="ts">
// The duty chat's field at the head of the command row: the microphone, the message «Задача дежурному…» growing to a few
// lines, the button that shows the conversation and the send button. Focusing the field opens the conversation; Enter
// sends, Shift+Enter breaks the line, Escape folds the conversation. The microphone dictates into the field through
// pauses until it is pressed again or Escape ends the dictation, and never sends by itself: the words stay a draft to
// edit. When the chat cannot work, a plain sentence stands instead.
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import micActive from "../art/console-mic-active.png";
import micIdle from "../art/console-mic-idle.png";
import { createVoice, voiceTitle } from "./voice";

const props = defineProps<{
  /** Why the chat cannot work, shown instead of the field; null when it can. */
  unavailable: string | null;
  /** The duty works on a turn: a message now waits for it. */
  busy: boolean;
  /** The conversation stands open. */
  open: boolean;
  /** The narrow window's sheet: the conversation always shows there, without its toggle. */
  sheet?: boolean;
  /** The chat needs a Claude duty: the sentence offers the duty's choice. */
  pickDuty?: boolean;
}>();
const emit = defineEmits<{ send: []; open: []; close: []; toggle: []; grow: [extra: number]; pickDuty: [opener: HTMLElement | null] }>();
const text = defineModel<string>({ required: true });

const field = ref<HTMLTextAreaElement | null>(null);
/** The next focus comes from folding the conversation: it does not open it again. */
let quiet = false;

function onFocus() {
  if (quiet) quiet = false;
  else emit("open");
}

defineExpose({
  /** Gives the focus back to the field without opening the conversation. */
  focusQuietly() {
    if (!field.value) return;
    quiet = document.activeElement !== field.value;
    field.value.focus();
  },
});

/** Sends the field; a dictation still running is dropped, so that its late words do not fill the emptied field. */
function send() {
  voice.dispose();
  emit("send");
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  } else if (event.key === "Escape" && voice.state.value === "listening") {
    event.preventDefault();
    event.stopPropagation();
    voice.stop();
  } else if (event.key === "Escape" && props.open && !props.sheet) {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
  }
}

// The field grows with its text up to a few lines; how much it grew above one line moves the conversation up.
const LINE = 18;
const MAX_LINES = 5;
/** How much the field grew above one line: the dictation's note stands above it. */
const extra = ref(0);
function grow() {
  const area = field.value;
  if (!area) return;
  area.style.height = "auto";
  const height = Math.min(area.scrollHeight, LINE * MAX_LINES + 12);
  area.style.height = `${height}px`;
  extra.value = Math.max(0, height - (LINE + 12));
  emit("grow", extra.value);
}
watch(text, () => void nextTick(grow));

const voice = createVoice({ text: () => text.value, onText: (value) => (text.value = value) });
const listening = computed(() => voice.state.value === "listening");
/** The note's id: the narrow window's sheet and the row may both hold a field. */
const noteId = useId();

/** Escape on the microphone ends a running dictation and goes no further. */
function stopOnEscape(event: KeyboardEvent) {
  if (!listening.value) return;
  event.preventDefault();
  event.stopPropagation();
  voice.stop();
}
onBeforeUnmount(() => {
  voice.dispose();
  emit("grow", 0);
});
</script>

<template>
  <div class="chat-field" :class="{ sheet, off: !!unavailable }">
    <p v-if="unavailable" class="chat-off" :title="unavailable">{{ unavailable }}</p>
    <button v-if="unavailable && pickDuty" type="button" class="pick-duty" aria-haspopup="dialog" aria-label="Выбрать дежурного" title="Выбрать дежурного" @click="emit('pickDuty', null)">Выбрать</button>
    <template v-else-if="!unavailable">
      <button
        type="button"
        class="mic"
        :class="voice.state.value"
        :disabled="voice.state.value === 'off'"
        :aria-pressed="listening"
        :aria-label="listening ? 'Закончить диктовку' : 'Надиктовать задачу'"
        :aria-describedby="voice.note.value ? noteId : undefined"
        :title="voiceTitle(voice.state.value, voice.why.value)"
        @click="voice.toggle"
        @keydown.esc="stopOnEscape"
      >
        <img :src="listening ? micActive : micIdle" alt="" draggable="false" />
      </button>
      <div class="box">
        <p :id="noteId" class="voice-note" :style="{ '--field-extra': `${extra}px` }" :class="{ shown: voice.note.value }" role="status">{{ voice.note.value ?? (listening ? "Идёт диктовка" : "") }}</p>
        <textarea
          ref="field"
          v-model="text"
          rows="1"
          class="input"
          aria-label="Задача дежурному"
          :aria-expanded="sheet ? undefined : open"
          :aria-controls="sheet ? undefined : 'duty-chat'"
          :placeholder="listening ? 'Говори… Esc или микрофон — закончить' : 'Задача дежурному…'"
          :aria-keyshortcuts="listening ? 'Escape' : undefined"
          :title="busy ? 'Дежурный работает: сообщение дождётся конца хода' : undefined"
          @focus="onFocus"
          @keydown="onKey"
          @input="grow"
        ></textarea>
        <button
          v-if="!sheet"
          type="button"
          class="tool"
          :aria-expanded="open"
          aria-controls="duty-chat"
          :aria-label="open ? 'Свернуть переписку с дежурным' : 'Показать переписку с дежурным'"
          :title="open ? 'Свернуть переписку (Esc)' : 'Показать переписку'"
          @click="emit('toggle')"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          </svg>
        </button>
        <button type="button" class="tool send" :disabled="!text.trim()" aria-label="Отправить дежурному" title="Отправить (Enter)" @click="send">
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <path d="M2 2.5l12 5.5-12 5.5 2-5.5z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* The field takes the row's free width, and never less than it needs to be typed in. */
.chat-field {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 200px;
  height: 100%;
}

.chat-field.sheet {
  min-width: 0;
  height: auto;
}

.chat-off {
  display: -webkit-box;
  flex: 1;
  margin: 0;
  overflow: hidden;
  color: #e9d3a8;
  font-size: 12px;
  line-height: 15px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

/* «Выбрать дежурного»: a small cast bronze button after the sentence. */
.pick-duty {
  flex: none;
  height: calc(var(--cast-height, 30px) - 2px);
  padding: 0 10px;
  border: 1px solid #1f1205;
  border-radius: 5px;
  background: linear-gradient(to bottom, #9a6a2c 0%, #6b4316 9%, #45290c 52%, #2f1b07 90%, #7a501c 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 220, 160, 0.5),
    inset 0 0 0 1px rgba(214, 150, 70, 0.55);
  color: #f6dfb0;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
  cursor: pointer;
}

.pick-duty:hover {
  filter: brightness(1.18);
}

.pick-duty:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 2px;
}

.chat-field.sheet .chat-off {
  display: block;
  padding: 4px 2px;
}

/* The microphone: its round cast art, a little larger than the row's buttons. */
.mic {
  flex: none;
  width: calc(var(--cast-height, 30px) + 18px);
  height: calc(var(--cast-height, 30px) + 18px);
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  cursor: pointer;
  position: relative;
}

.mic img {
  display: block;
  width: 100%;
  height: 100%;
}

/* A dictation runs: a slow ring pulses around the microphone until it is pressed again. */
.mic.listening::after {
  content: "";
  position: absolute;
  inset: 3px;
  border: 2px solid rgba(243, 154, 46, 0.9);
  border-radius: 50%;
  pointer-events: none;
  animation: mic-pulse 1.4s ease-out infinite;
}

@keyframes mic-pulse {
  from {
    opacity: 0.9;
    transform: scale(0.92);
  }
  to {
    opacity: 0;
    transform: scale(1.12);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mic.listening::after {
    animation: none;
    opacity: 0.8;
  }
}

.mic:hover:not(:disabled) img {
  filter: brightness(1.15);
}

.mic:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.mic:disabled {
  cursor: default;
}

.mic:disabled img {
  filter: saturate(0.2) brightness(0.6);
}

/* Why the dictation stopped or retries: a small plate over the field's left edge. The live text that a dictation
   runs stays for screen readers only. */
.voice-note {
  position: absolute;
  left: 0;
  bottom: calc(50% + (var(--cast-height, 30px) + 2px) / 2 + var(--field-extra, 0px) + 4px);
  z-index: 1;
  max-width: 100%;
  margin: 0;
  padding: 3px 8px;
  border: 1px solid rgba(214, 150, 70, 0.7);
  border-radius: 5px;
  background: rgba(14, 12, 10, 0.96);
  color: #f3d9a6;
  font-size: 12px;
  line-height: 15px;
  white-space: normal;
  pointer-events: none;
}

.voice-note:not(.shown) {
  clip-path: inset(50%);
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  white-space: nowrap;
}

/* The narrow window's sheet has no room above the field: the note stands in the flow, over it. */
.chat-field.sheet .voice-note.shown {
  position: static;
  margin-bottom: 4px;
}

/* The field: a dark inset in the bronze. */
.box {
  position: relative;
  flex: 1;
  min-width: 0;
  align-self: stretch;
}

.input {
  position: absolute;
  left: 0;
  right: 0;
  /* One line stands on the row's middle; more lines grow upward over the panel. */
  bottom: calc(50% - (var(--cast-height, 30px) + 2px) / 2);
  box-sizing: border-box;
  display: block;
  width: 100%;
  height: calc(var(--cast-height, 30px) + 2px);
  min-height: calc(var(--cast-height, 30px) + 2px);
  margin: 0;
  padding: 6px 64px 6px 12px;
  border: 1px solid rgba(214, 150, 70, 0.7);
  border-radius: 7px;
  background: linear-gradient(to bottom, rgba(4, 6, 10, 0.98), rgba(14, 14, 16, 0.96));
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.8),
    0 1px 0 rgba(255, 210, 140, 0.18);
  color: #f3ead8;
  font: inherit;
  font-size: 14px;
  line-height: 18px;
  resize: none;
  overflow-y: auto;
  scrollbar-width: thin;
}

.chat-field.sheet .box {
  align-self: auto;
  min-height: 40px;
}

.chat-field.sheet .input {
  position: relative;
  bottom: auto;
}

.input::placeholder {
  color: #9b8f78;
}

.input:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.tool {
  position: absolute;
  bottom: calc(50% - var(--cast-height, 30px) / 2 + 1px);
  display: grid;
  place-items: center;
  width: 28px;
  height: calc(var(--cast-height, 30px) - 2px);
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: none;
  color: #c9a46b;
  cursor: pointer;
}

.chat-field.sheet .tool {
  bottom: 1px;
}

.tool:not(.send) {
  right: 32px;
}

.tool[aria-expanded="true"] {
  color: #f3c64e;
}

.send {
  right: 4px;
  color: #f39a2e;
}

.tool:hover:not(:disabled) {
  background: rgba(214, 170, 96, 0.16);
}

.tool:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: -1px;
}

.send:disabled {
  color: #6f6352;
  cursor: default;
}
</style>
