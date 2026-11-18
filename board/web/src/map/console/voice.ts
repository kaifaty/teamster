// Dictation for the duty chat's field: the browser's speech recognition (`SpeechRecognition`, `webkitSpeechRecognition`
// in Chrome and Safari) behind a small wrapper, so that tests drive it with a fake. A dictation lasts until the user stops
// it: the browser ends its recognition at a pause or after a while, and the wrapper starts a new one after the text the
// field holds then, so the words of every recognition stay in order. Each recognition listens in the page's language
// with interim results, and its words replace what it dictated so far. Nothing is sent: the user sends the field.

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

/** `idle` can start, `listening` dictates until the user stops, `off` cannot start: no recognition, or the microphone refused. */
export type VoiceState = "idle" | "listening" | "off";

/** Why the microphone is off, by the recognition's error. */
const REFUSALS: Record<string, string> = {
  "not-allowed": "Браузер не дал доступ к микрофону: разреши его в настройках сайта и обнови страницу",
  "service-not-allowed": "Браузер не дал распознавать речь на этой странице",
  "audio-capture": "Браузер не нашёл микрофон",
};

/** Errors after which another recognition would fail the same way: the dictation stops with the note. */
const FATAL: Record<string, string> = {
  "language-not-supported": "Браузер не распознаёт речь на языке страницы",
  "bad-grammar": "Браузер не смог настроить распознавание речи",
};

/** The note after a transient error, when the dictation gave up retrying. */
const BROKE: Record<string, string> = {
  network: "Диктовка остановлена: распознаванию речи нужна сеть, а она недоступна",
};
export const RETRYING = "Распознавание прервалось: пробую снова";
export const BROKE_DEFAULT = "Диктовка остановлена: браузер не смог продолжить распознавание";

/** Errors that only end the browser's recognition: silence, or the wrapper's own stop. */
const QUIET = new Set(["no-speech", "aborted"]);

export const NO_RECOGNITION = "Этот браузер не умеет распознавать речь: набери задачу текстом";

/** The pause before the next recognition after a normal end, and the first pause after a failed one, doubling. */
export const RESTART_DELAY = 250;
export const RETRY_DELAY = 1000;
/** Failed recognitions in a row after which the dictation stops. */
export const MAX_FAILURES = 3;
/** A recognition that ends sooner than this without a word counts as failed: the browser could not listen. */
export const SHORT_RUN = 1000;

/** The microphone button's title. */
export function voiceTitle(state: VoiceState, why: string | null): string {
  if (state === "listening") return "Закончить диктовку (Esc)";
  if (state === "off") return why ?? NO_RECOGNITION;
  return "Надиктовать задачу";
}

/** The field's text: what it held before the recognition, then the words heard so far. */
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
  /** The field's text when a recognition starts. */
  text: () => string;
  /** The field's text as the words come. */
  onText: (text: string) => void;
}

export function createVoice(options: VoiceOptions) {
  const ctor = options.ctor === undefined ? findRecognition() : options.ctor;
  const state = ref<VoiceState>(ctor ? "idle" : "off");
  /** Why the microphone is off; null while it works. */
  const why = ref<string | null>(ctor ? null : NO_RECOGNITION);
  /** Why the last dictation stopped by itself; null after a start or while all is well. */
  const note = ref<string | null>(null);
  /** The recognition whose words go into the field: the running one, or the one stopping after the user's stop. */
  let current: RecognitionLike | null = null;
  let restart: ReturnType<typeof setTimeout> | null = null;
  /** Failed recognitions in a row; a heard word resets it. */
  let failures = 0;

  function cancelRestart() {
    if (restart !== null) clearTimeout(restart);
    restart = null;
  }

  /** Drops the recognition without its end: its late events find another `current` and do nothing. */
  function drop() {
    const recognition = current;
    current = null;
    recognition?.abort();
  }

  /** Ends the dictation by itself, with a note why. */
  function giveUp(message: string) {
    cancelRestart();
    note.value = message;
    if (state.value === "listening") state.value = "idle";
    drop();
  }

  /** Starts one browser recognition of the dictation. */
  function listen() {
    restart = null;
    if (!ctor || state.value !== "listening") return;
    const before = options.text();
    const recognition = new ctor();
    const started = Date.now();
    let heard = false;
    let error: string | null = null;
    recognition.lang = (options.lang ?? pageLanguage)();
    recognition.interimResults = true;
    // Listens through pauses; the browser still ends it at times, and `onend` starts the next one.
    recognition.continuous = true;
    recognition.onresult = (event) => {
      if (current !== recognition) return;
      heard = true;
      failures = 0;
      if (state.value === "listening") note.value = null;
      options.onText(dictated(before, event.results));
    };
    recognition.onerror = (event) => {
      if (current !== recognition) return;
      const refusal = REFUSALS[event.error];
      if (refusal) {
        cancelRestart();
        why.value = refusal;
        state.value = "off";
        return;
      }
      const fatal = FATAL[event.error];
      if (fatal) return giveUp(fatal);
      if (!QUIET.has(event.error)) error = event.error;
    };
    recognition.onend = () => {
      if (current !== recognition) return;
      current = null;
      if (state.value !== "listening") return;
      const failed = error !== null || (!heard && Date.now() - started < SHORT_RUN);
      if (!failed) return schedule(RESTART_DELAY);
      retry(error ? BROKE[error] ?? BROKE_DEFAULT : BROKE_DEFAULT);
    };
    current = recognition;
    try {
      // An end inside `start()` comes before any word and counts as a short run.
      recognition.start();
    } catch {
      if (current !== recognition) return;
      current = null;
      retry(BROKE_DEFAULT);
    }
  }

  /** After a failed recognition: a later try with a longer pause, or the dictation's end after a few in a row. */
  function retry(message: string) {
    failures += 1;
    if (failures >= MAX_FAILURES) return giveUp(message);
    note.value = RETRYING;
    schedule(RETRY_DELAY * 2 ** (failures - 1));
  }

  function schedule(delay: number) {
    cancelRestart();
    restart = setTimeout(listen, delay);
  }

  function start() {
    if (!ctor || state.value !== "idle") return;
    // A recognition still stopping after the user's stop gives way: its words are already in the field.
    drop();
    cancelRestart();
    failures = 0;
    note.value = null;
    state.value = "listening";
    listen();
  }

  /** The user's stop: the running recognition delivers its last words, and no other one starts. */
  function stop() {
    if (state.value !== "listening") return;
    cancelRestart();
    state.value = "idle";
    current?.stop();
  }

  return {
    state,
    why,
    note,
    start,
    stop,
    /** The microphone's press: starts, or stops the dictation. */
    toggle: () => (state.value === "listening" ? stop() : start()),
    /** Drops the dictation without waiting for its last words, when the field is sent or goes away. */
    dispose() {
      cancelRestart();
      if (state.value === "listening") state.value = "idle";
      drop();
    },
  };
}

export type Voice = ReturnType<typeof createVoice>;
