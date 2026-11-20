// Dictation for the duty chat's field: the browser's speech recognition (`SpeechRecognition`, `webkitSpeechRecognition`
// in Chrome and Safari) behind a small wrapper, so that tests drive it with a fake. A dictation lasts until the user stops
// it: the browser ends its recognition at a pause or after a while, and the wrapper starts a new one, whose words go
// after the text the field holds at its first word. Each recognition listens in the page's language with interim
// results, and its words replace what it dictated so far in its own place, so that the user's edits around them stay.
// Nothing is sent: the user sends the field.

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
const RETRYING = "Распознавание прервалось: пробую снова";
const BROKE_DEFAULT = "Диктовка остановлена: браузер не смог продолжить распознавание";

/** Errors that only end the browser's recognition: silence, or the wrapper's own stop. */
const QUIET = new Set(["no-speech", "aborted"]);

export const NO_RECOGNITION = "Этот браузер не умеет распознавать речь: набери задачу текстом";

/** The pause before the next recognition after a normal end, and the first pause after a failed one, doubling. */
const RESTART_DELAY = 250;
const RETRY_DELAY = 1000;
/** Failed recognitions in a row after which the dictation stops. */
const MAX_FAILURES = 3;
/** A recognition that ends sooner than this without a word counts as failed: the browser could not listen. */
const SHORT_RUN = 1000;

/** The microphone button's title. */
export function voiceTitle(state: VoiceState, why: string | null): string {
  if (state === "listening") return "Закончить диктовку (Esc)";
  if (state === "off") return why ?? NO_RECOGNITION;
  return "Надиктовать задачу";
}

/** The words of the results from `from` on; only the final ones with `finals`. */
function heardText(results: ArrayLike<RecognitionResultLike>, from: number, finals = false): string {
  return Array.from(results)
    .slice(from)
    .filter((result) => !finals || result.isFinal)
    .map((result) => result[0]?.transcript ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export interface VoiceOptions {
  /** The browser's recognition; `findRecognition()` by default. */
  ctor?: RecognitionCtor | null;
  lang?: () => string;
  /** The field's text now. */
  text: () => string;
  /** The field's text as the words come. */
  onText: (text: string) => void;
}

export function createVoice(options: VoiceOptions) {
  const ctor = options.ctor === undefined ? findRecognition() : options.ctor;
  const state = ref<VoiceState>(ctor ? "idle" : "off");
  /** Why the microphone is off; null while it works. */
  const why = ref<string | null>(ctor ? null : NO_RECOGNITION);
  /** Why the dictation retries, stopped by itself, or the microphone was refused; null after a start or while all is well. */
  const note = ref<string | null>(null);
  /** The running recognition. */
  let current: RecognitionLike | null = null;
  /** Recognitions the user stopped: they still deliver their last words, into their own place in the field. */
  const stopping = new Set<RecognitionLike>();
  let restart: ReturnType<typeof setTimeout> | null = null;
  /** Failed recognitions in a row; a final word resets it. */
  let failures = 0;

  function cancelRestart() {
    if (restart !== null) clearTimeout(restart);
    restart = null;
  }

  /** The note of a retry that will not come any more goes with it. */
  function dropRetryNote() {
    if (note.value === RETRYING) note.value = null;
  }

  /** Drops the running recognition without its end: its late events find another `current` and do nothing. */
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
    const recognition = new ctor();
    const started = Date.now();
    let heard = false;
    let error: string | null = null;
    /** What this recognition put into the field, with its leading space, and where; null before its first word. */
    let inserted: string | null = null;
    let at = 0;
    /** Results the user took over by editing their words: they are no longer written. */
    let skip = 0;
    let seen = 0;
    let results: ArrayLike<RecognitionResultLike> = [];

    /** Puts the words in this recognition's place, keeping the field's other text as the user left it. */
    function place(words: string) {
      const text = options.text();
      if (inserted === null) {
        if (!words) return;
        at = text.length;
      } else if (!text.startsWith(inserted, at)) {
        const found = inserted ? text.lastIndexOf(inserted) : -1;
        if (found < 0) {
          // The user edited the dictated words: they keep them, and later words come after the field's text.
          skip = seen;
          inserted = null;
          return place(heardText(results, skip));
        }
        at = found;
      }
      const head = text.slice(0, at);
      const piece = words && head && !/\s$/.test(head) ? ` ${words}` : words;
      options.onText(head + piece + text.slice(at + (inserted?.length ?? 0)));
      inserted = piece;
    }

    recognition.lang = (options.lang ?? pageLanguage)();
    recognition.interimResults = true;
    // Listens through pauses; the browser still ends it at times, and `onend` starts the next one.
    recognition.continuous = true;
    recognition.onresult = (event) => {
      if (current !== recognition && !stopping.has(recognition)) return;
      heard = true;
      if (Array.from(event.results).some((result) => result.isFinal)) {
        failures = 0;
        dropRetryNote();
      }
      results = event.results;
      place(heardText(results, skip));
      seen = results.length;
    };
    recognition.onerror = (event) => {
      if (current !== recognition) return;
      const refusal = REFUSALS[event.error];
      if (refusal) {
        cancelRestart();
        why.value = refusal;
        note.value = refusal;
        state.value = "off";
        return;
      }
      const fatal = FATAL[event.error];
      if (fatal) return giveUp(fatal);
      if (!QUIET.has(event.error)) error = event.error;
    };
    recognition.onend = () => {
      stopping.delete(recognition);
      if (current !== recognition) return;
      current = null;
      // A broken recognition's last guess stays unconfirmed: only its final words remain.
      if (error !== null) place(heardText(results, skip, true));
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
    dropRetryNote();
    state.value = "idle";
    const recognition = current;
    current = null;
    if (recognition) {
      stopping.add(recognition);
      recognition.stop();
    }
  }

  return {
    state,
    why,
    note,
    start,
    stop,
    /** The microphone's press: starts, or stops the dictation. */
    toggle: () => (state.value === "listening" ? stop() : start()),
    /** Drops the dictation and the stopping recognitions without their last words, when the field is sent or goes away. */
    dispose() {
      cancelRestart();
      dropRetryNote();
      if (state.value === "listening") state.value = "idle";
      drop();
      for (const recognition of stopping) recognition.abort();
      stopping.clear();
    },
  };
}

export type Voice = ReturnType<typeof createVoice>;
