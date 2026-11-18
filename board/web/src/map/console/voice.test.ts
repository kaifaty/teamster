import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROKE_DEFAULT,
  createVoice,
  findRecognition,
  NO_RECOGNITION,
  RESTART_DELAY,
  RETRY_DELAY,
  RETRYING,
  SHORT_RUN,
  voiceTitle,
  type RecognitionEventLike,
  type RecognitionLike,
} from "./voice";

/** A recognition the test speaks into. Like the browser's, `stop()` and `abort()` end it later: the test calls `end()`. */
class FakeRecognition implements RecognitionLike {
  static made: FakeRecognition[] = [];
  /** What the next `start()` does: nothing, throw, or end at once. */
  static onStart: "listen" | "throw" | "end" = "listen";
  lang = "";
  interimResults = false;
  continuous = false;
  started = false;
  stopped = false;
  aborted = false;
  onresult: ((event: RecognitionEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.made.push(this);
  }
  start() {
    if (FakeRecognition.onStart === "throw") throw new Error("InvalidStateError");
    this.started = true;
    if (FakeRecognition.onStart === "end") this.end();
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
  say(...parts: [string, boolean][]) {
    this.onresult?.({ results: parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) });
  }
  fail(error: string) {
    this.onerror?.({ error });
  }
  end() {
    this.onend?.();
  }
}

function setup(text = "") {
  FakeRecognition.made = [];
  FakeRecognition.onStart = "listen";
  const field = { text };
  const voice = createVoice({ ctor: FakeRecognition, lang: () => "ru", text: () => field.text, onText: (value) => (field.text = value) });
  return { voice, field, last: () => FakeRecognition.made.at(-1)!, made: () => FakeRecognition.made.length };
}

/** A while of listening, so that the browser's end is not a short failed run. */
const listenAWhile = () => vi.advanceTimersByTime(SHORT_RUN * 5);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("dictation", () => {
  it("listens through pauses: each browser end starts the next recognition after the field's text, until the user stops", () => {
    const { voice, field, last, made } = setup("Задача: ");
    voice.toggle();
    expect(voice.state.value).toBe("listening");
    expect(last()).toMatchObject({ lang: "ru", interimResults: true, continuous: true, started: true });
    last().say(["проверь", false]);
    expect(field.text).toBe("Задача: проверь");
    last().say(["проверь кэш ", true], [" сборки", false]);
    expect(field.text).toBe("Задача: проверь кэш сборки");
    last().say(["проверь кэш ", true], [" сборки", true]);
    // A long pause: the browser ends its recognition, the dictation goes on.
    listenAWhile();
    last().end();
    expect(voice.state.value).toBe("listening");
    expect(made()).toBe(1);
    // The user edits the draft between two recognitions; the next words come after it, once.
    field.text += ",";
    vi.advanceTimersByTime(RESTART_DELAY);
    expect(made()).toBe(2);
    last().say(["и тесты", false]);
    expect(field.text).toBe("Задача: проверь кэш сборки, и тесты");
    last().say(["и тесты прогони", true]);
    expect(field.text).toBe("Задача: проверь кэш сборки, и тесты прогони");
    // Silence ends the third one with `no-speech`: still not a failure.
    listenAWhile();
    last().fail("no-speech");
    last().end();
    vi.advanceTimersByTime(RESTART_DELAY);
    expect(made()).toBe(3);
    expect(voice.state.value).toBe("listening");
    expect(voice.note.value).toBeNull();
  });

  it("keeps the stopping recognition's last words at the user's stop, starts no other, and drops a dropped one's late words", () => {
    const { voice, field, last, made } = setup();
    voice.toggle();
    const first = last();
    first.say(["первое", false]);
    voice.toggle();
    expect(voice.state.value).toBe("idle");
    expect(first.stopped).toBe(true);
    first.say(["первое слово", true]);
    expect(field.text).toBe("первое слово");
    first.end();
    vi.runAllTimers();
    expect(made()).toBe(1);
    first.say(["позднее", true]);
    expect(field.text).toBe("первое слово");

    // A start while the stopped recognition still ends: the old one gives way and its late words do not land.
    voice.toggle();
    const second = last();
    second.say(["второе", false]);
    voice.toggle();
    voice.toggle();
    expect(second.aborted).toBe(true);
    second.say(["второе потерянное", true]);
    second.end();
    expect(field.text).toBe("первое слово второе");
    last().say(["третье", false]);
    expect(field.text).toBe("первое слово второе третье");
    expect(voice.state.value).toBe("listening");

    // A stop in the pause between two recognitions starts none.
    listenAWhile();
    last().end();
    voice.toggle();
    vi.runAllTimers();
    expect(made()).toBe(3);
    expect(voice.state.value).toBe("idle");
  });

  it("drops the dictation and its planned restart when the field is sent, so that the emptied field stays empty", () => {
    const { voice, field, last, made } = setup();
    voice.toggle();
    const first = last();
    first.say(["привет", false]);
    voice.dispose();
    field.text = "";
    first.say(["привет", true]);
    first.end();
    vi.runAllTimers();
    expect(field.text).toBe("");
    expect(voice.state.value).toBe("idle");
    expect(made()).toBe(1);

    // Sent in the pause between two recognitions.
    voice.toggle();
    last().say(["ещё", true]);
    listenAWhile();
    last().end();
    voice.dispose();
    field.text = "";
    vi.runAllTimers();
    expect(made()).toBe(2);
    expect(field.text).toBe("");
  });

  it("is off without the browser's recognition, and after the microphone was refused, with a title that says why", () => {
    const none = createVoice({ ctor: null, text: () => "", onText: () => {} });
    none.toggle();
    expect(none.state.value).toBe("off");
    expect(voiceTitle(none.state.value, none.why.value)).toBe(NO_RECOGNITION);

    const { voice, last, made } = setup();
    expect(voiceTitle(voice.state.value, voice.why.value)).toBe("Надиктовать задачу");
    voice.toggle();
    expect(voiceTitle(voice.state.value, voice.why.value)).toBe("Закончить диктовку (Esc)");
    last().fail("not-allowed");
    last().end();
    vi.runAllTimers();
    expect(voice.state.value).toBe("off");
    expect(voiceTitle(voice.state.value, voice.why.value)).toMatch(/не дал доступ к микрофону/);
    voice.toggle();
    expect(made()).toBe(1);

    // A language the browser cannot hear stops the dictation at once, with a note.
    const foreign = setup();
    foreign.voice.toggle();
    foreign.last().fail("language-not-supported");
    vi.runAllTimers();
    expect(foreign.voice.state.value).toBe("idle");
    expect(foreign.voice.note.value).toMatch(/языке страницы/);
    expect(foreign.made()).toBe(1);
  });

  it("retries a broken recognition with longer pauses, then stops with a note; a heard word resets the count", () => {
    const { voice, last, made } = setup();
    voice.toggle();
    last().fail("network");
    last().end();
    expect(voice.note.value).toBe(RETRYING);
    vi.advanceTimersByTime(RETRY_DELAY - 1);
    expect(made()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(made()).toBe(2);
    // The second try hears: the note goes and the count starts over.
    last().say(["слово", true]);
    expect(voice.note.value).toBeNull();
    last().fail("network");
    last().end();
    vi.advanceTimersByTime(RETRY_DELAY);
    expect(made()).toBe(3);
    last().fail("network");
    last().end();
    vi.advanceTimersByTime(RETRY_DELAY * 2);
    expect(made()).toBe(4);
    last().fail("network");
    last().end();
    vi.runAllTimers();
    expect(made()).toBe(4);
    expect(voice.state.value).toBe("idle");
    expect(voice.note.value).toMatch(/нужна сеть/);
    // A new start clears the note.
    voice.toggle();
    expect(voice.note.value).toBeNull();
  });

  it("gives up when start() throws or the browser ends the recognition at once, instead of looping", () => {
    for (const onStart of ["throw", "end"] as const) {
      const { voice, made } = setup();
      FakeRecognition.onStart = onStart;
      voice.toggle();
      vi.runAllTimers();
      expect(made()).toBe(3);
      expect(voice.state.value).toBe("idle");
      expect(voice.note.value).toBe(BROKE_DEFAULT);
    }
  });

  it("listens in Russian when the page names no language", () => {
    FakeRecognition.made = [];
    FakeRecognition.onStart = "listen";
    createVoice({ ctor: FakeRecognition, text: () => "", onText: () => {} }).toggle();
    expect(FakeRecognition.made[0]!.lang).toBe("ru-RU");
  });

  it("finds the browser's recognition, prefixed or not", () => {
    expect(findRecognition({})).toBeNull();
    expect(findRecognition({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(findRecognition({ SpeechRecognition: FakeRecognition, webkitSpeechRecognition: class {} })).toBe(FakeRecognition);
  });
});
