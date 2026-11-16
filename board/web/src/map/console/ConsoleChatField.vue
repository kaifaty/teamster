<script setup lang="ts">
// The duty chat's field at the head of the command row: the microphone, the message «Задача дежурному…» growing to a few
// lines, the button that shows the conversation and the send button. Focusing the field opens the conversation; Enter
// sends, Shift+Enter breaks the line, Escape folds the conversation. The microphone dictates into the field and never
// sends by itself. When the chat cannot work, a plain sentence stands instead.
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
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
}>();
const emit = defineEmits<{ send: []; open: []; close: []; toggle: []; grow: [extra: number] }>();
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
  } else if (event.key === "Escape" && props.open && !props.sheet) {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
  }
}

// The field grows with its text up to a few lines; how much it grew above one line moves the conversation up.
const LINE = 18;
const MAX_LINES = 5;
function grow() {
  const area = field.value;
  if (!area) return;
  area.style.height = "auto";
  const height = Math.min(area.scrollHeight, LINE * MAX_LINES + 12);
  area.style.height = `${height}px`;
  emit("grow", Math.max(0, height - (LINE + 12)));
}
watch(text, () => void nextTick(grow));

const voice = createVoice({ text: () => text.value, onText: (value) => (text.value = value) });
onBeforeUnmount(() => {
  voice.dispose();
  emit("grow", 0);
});
</script>

<template>
  <div class="chat-field" :class="{ sheet, off: !!unavailable }">
    <p v-if="unavailable" class="chat-off" :title="unavailable">{{ unavailable }}</p>
    <template v-else>
      <button
        type="button"
        class="mic"
        :class="voice.state.value"
        :disabled="voice.state.value === 'off'"
        :aria-pressed="voice.state.value === 'listening'"
        :aria-label="voice.state.value === 'listening' ? 'Диктовка: идёт' : 'Диктовка'"
        :title="voiceTitle(voice.state.value, voice.why.value)"
        @click="voice.toggle"
      >
        <img :src="voice.state.value === 'listening' ? micActive : micIdle" alt="" draggable="false" />
      </button>
      <div class="box">
        <textarea
          ref="field"
          v-model="text"
          rows="1"
          class="input"
          aria-label="Задача дежурному"
          :aria-expanded="sheet ? undefined : open"
          :aria-controls="sheet ? undefined : 'duty-chat'"
          placeholder="Задача дежурному…"
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
}

.mic img {
  display: block;
  width: 100%;
  height: 100%;
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
