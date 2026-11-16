// Dictation for the duty chat's field: the browser's speech recognition (`SpeechRecognition`, `webkitSpeechRecognition`
// in Chrome and Safari) behind a small wrapper, so that tests drive it with a fake. A start listens in the page's
// language with interim results, and the recognised words replace what was dictated so far, after the text the field
// held before; a second start or a pause stops. Nothing is sent: the user sends the field.

import { ref } from "vue";

/** The parts of a recognition result the wrapper reads. */
export interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

export interface RecognitionEventLike {
  readonly results: ArrayLike<RecognitionResultLike>;
}

/** The parts of `SpeechRecognition` the wrapper uses. */
export interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type RecognitionCtor = new () => RecognitionLike;

/** The browser's recognition, or null without one. */
export function findRecognition(scope: object = globalThis): RecognitionCtor | null {
  const holder = scope as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return holder.SpeechRecognition ?? holder.webkitSpeechRecognition ?? null;
}

/** The page's language for recognition: `<html lang>`, Russian without one. */
export function pageLanguage(): string {
  return (typeof document !== "undefined" && document.documentElement.lang) || "ru-RU";
}

/** `idle` can start, `listening` hears, `off` cannot start: no recognition in the browser, or the microphone refused. */
export type VoiceState = "idle" | "listening" | "off";

/** Why the microphone is off, by the recognition's error; the rest only end the listening. */
const REFUSALS: Record<string, string> = {
  "not-allowed": "Браузер не дал доступ к микрофону: разреши его в настройках сайта и обнови страницу",
  "service-not-allowed": "Браузер не дал распознавать речь на этой странице",
  "audio-capture": "Браузер не нашёл микрофон",
};

export const NO_RECOGNITION = "Этот браузер не умеет распознавать речь: набери задачу текстом";

/** The microphone button's title. */
export function voiceTitle(state: VoiceState, why: string | null): string {
  if (state === "listening") return "Остановить диктовку";
  if (state === "off") return why ?? NO_RECOGNITION;
  return "Надиктовать задачу";
}

/** The field's text: what it held before the dictation, then the words heard so far. */
export function dictated(before: string, results: ArrayLike<RecognitionResultLike>): string {
  const heard = Array.from(results, (result) => result[0]?.transcript ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const head = before.trimEnd();
  if (!heard) return head;
  return head ? `${head} ${heard}` : heard;
}

export interface VoiceOptions {
  /** The browser's recognition; `findRecognition()` by default. */
  ctor?: RecognitionCtor | null;
  lang?: () => string;
  /** The field's text when the dictation starts. */
  text: () => string;
  /** The field's text as the words come. */
  onText: (text: string) => void;
}

export function createVoice(options: VoiceOptions) {
  const ctor = options.ctor === undefined ? findRecognition() : options.ctor;
  const state = ref<VoiceState>(ctor ? "idle" : "off");
  /** Why the microphone is off; null while it works. */
  const why = ref<string | null>(ctor ? null : NO_RECOGNITION);
  let current: RecognitionLike | null = null;

  function start() {
    if (!ctor || state.value !== "idle") return;
    const before = options.text();
    const recognition = new ctor();
    recognition.lang = (options.lang ?? pageLanguage)();
    recognition.interimResults = true;
    // One phrase: the browser stops at a pause.
    recognition.continuous = false;
    recognition.onresult = (event) => {
      if (current === recognition) options.onText(dictated(before, event.results));
    };
    recognition.onerror = (event) => {
      if (current !== recognition) return;
      const refusal = REFUSALS[event.error];
      if (refusal) {
        why.value = refusal;
        state.value = "off";
      }
    };
    recognition.onend = () => {
      if (current !== recognition) return;
      current = null;
      if (state.value === "listening") state.value = "idle";
    };
    current = recognition;
    try {
      recognition.start();
      state.value = "listening";
    } catch {
      current = null;
    }
  }

  function stop() {
    if (state.value === "listening") current?.stop();
  }

  return {
    state,
    why,
    start,
    stop,
    /** The microphone's press: starts, or stops what listens. */
    toggle: () => (state.value === "listening" ? stop() : start()),
    /** Drops the listening without waiting for its end, when the field goes away. */
    dispose() {
      const recognition = current;
      current = null;
      if (state.value === "listening") state.value = "idle";
      recognition?.abort();
    },
  };
}

export type Voice = ReturnType<typeof createVoice>;
