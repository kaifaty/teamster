import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoice, findRecognition, NO_RECOGNITION, voiceTitle, type RecognitionEventLike, type RecognitionLike } from "./voice";

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
  /** The results so far, each `[transcript, isFinal]`: the browser sends them all every time. */
  say(...parts: [string, boolean][]) {
    if (!this.started) throw new Error("a recognition that was not started hears nothing");
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

/** The browser ends a recognition after about three seconds of silence. */
const SILENCE = 3000;

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
    // A pause: the browser ends its recognition with a guess still interim; the guess stays and the dictation goes on.
    vi.advanceTimersByTime(SILENCE);
    last().end();
    expect(field.text).toBe("Задача: проверь кэш сборки");
    expect(voice.state.value).toBe("listening");
    expect(made()).toBe(1);
    // The user edits the draft between two recognitions; the next words come after it, once.
    field.text += ",";
    vi.advanceTimersByTime(300);
    expect(made()).toBe(2);
    expect(last().started).toBe(true);
    last().say(["и тесты", false]);
    expect(field.text).toBe("Задача: проверь кэш сборки, и тесты");
    last().say(["и тесты прогони", true]);
    expect(field.text).toBe("Задача: проверь кэш сборки, и тесты прогони");
    // Several silences in a row, each ending with `no-speech` after three seconds: none counts as a failure.
    for (let round = 3; round <= 7; round += 1) {
      vi.advanceTimersByTime(SILENCE);
      last().fail("no-speech");
      last().end();
      vi.advanceTimersByTime(300);
      expect(made()).toBe(round);
      expect(last().started).toBe(true);
    }
    expect(voice.state.value).toBe("listening");
    expect(voice.note.value).toBeNull();
  });

  it("takes back a withdrawn guess, and keeps the user's typing around the dictated words", () => {
    const { voice, field, last } = setup();
    voice.toggle();
    last().say(["проверь", false]);
    last().say();
    expect(field.text).toBe("");
    last().say(["проверь", false]);
    // The user types after the words while the recognition still works on them.
    field.text += " затем сборку";
    last().say(["проверь кэш", true]);
    expect(field.text).toBe("проверь кэш затем сборку");
    // The user rewrites the dictated words themselves: they stay, and the next words come after the field's text.
    field.text = "почини кэш затем сборку";
    last().say(["проверь кэш", true], [" и тесты", false]);
    expect(field.text).toBe("почини кэш затем сборку и тесты");
  });

  it("keeps the stopping recognition's last words at the user's stop and starts no other", () => {
    const { voice, field, last, made } = setup();
    voice.toggle();
    const first = last();
    first.say(["первое", false]);
    voice.toggle();
    expect(voice.state.value).toBe("idle");
    expect(first.stopped).toBe(true);
    // The user types while the browser still finishes the words.
    field.text += ", затем";
    first.say(["первое слово", true]);
    expect(field.text).toBe("первое слово, затем");
    first.end();
    vi.runAllTimers();
    expect(made()).toBe(1);
    first.say(["позднее", true]);
    expect(field.text).toBe("первое слово, затем");
  });

  it("starts anew at once after a stop, with the stopped recognition's final words in their place and its refusal ignored", () => {
    const { voice, field, last, made } = setup();
    voice.toggle();
    const first = last();
    first.say(["проверь", false]);
    voice.toggle();
    field.text += ",";
    voice.toggle();
    expect(made()).toBe(2);
    expect(first.aborted).toBe(false);
    first.say(["проверь кэш", true]);
    expect(field.text).toBe("проверь кэш,");
    first.fail("not-allowed");
    first.end();
    expect(voice.state.value).toBe("listening");
    last().say(["и тесты", false]);
    expect(field.text).toBe("проверь кэш, и тесты");
  });

  it("drops the dictation, the stopping one and the planned restart when the field is sent, so the emptied field stays empty", () => {
    const { voice, field, last, made } = setup();
    voice.toggle();
    const first = last();
    first.say(["привет", false]);
    voice.dispose();
    expect(first.aborted).toBe(true);
    field.text = "";
    first.say(["привет", true]);
    first.end();
    vi.runAllTimers();
    expect(field.text).toBe("");
    expect(voice.state.value).toBe("idle");
    expect(made()).toBe(1);

    // A stopped recognition still finishing.
    voice.toggle();
    const second = last();
    second.say(["ещё", false]);
    voice.toggle();
    voice.dispose();
    expect(second.aborted).toBe(true);
    field.text = "";
    second.say(["ещё раз", true]);
    expect(field.text).toBe("");

    // Sent in the pause between two recognitions: the planned restart goes.
    voice.toggle();
    last().say(["ещё", true]);
    vi.advanceTimersByTime(SILENCE);
    last().end();
    expect(vi.getTimerCount()).toBe(1);
    voice.dispose();
    expect(vi.getTimerCount()).toBe(0);
    field.text = "";
    vi.runAllTimers();
    expect(made()).toBe(3);
    expect(field.text).toBe("");
  });

  it("is off after the microphone was refused, with the reason as its note, and with a title that says why", () => {
    const none = createVoice({ ctor: null, text: () => "", onText: () => {} });
    none.toggle();
    expect(none.state.value).toBe("off");
    expect(voiceTitle(none.state.value, none.why.value)).toBe(NO_RECOGNITION);

    const { voice, last, made } = setup();
    expect(voiceTitle(voice.state.value, voice.why.value)).toBe("Надиктовать задачу");
    voice.toggle();
    expect(voiceTitle(voice.state.value, voice.why.value)).toBe("Закончить диктовку (Esc)");
    // Refused on a retry: the reason replaces the retry's note.
    last().fail("network");
    last().end();
    vi.advanceTimersByTime(1000);
    last().fail("not-allowed");
    last().end();
    vi.runAllTimers();
    expect(voice.state.value).toBe("off");
    expect(voice.note.value).toMatch(/не дал доступ к микрофону/);
    expect(voiceTitle(voice.state.value, voice.why.value)).toMatch(/не дал доступ к микрофону/);
    voice.toggle();
    expect(made()).toBe(2);

    // A language the browser cannot hear stops the dictation at once, with a note.
    const foreign = setup();
    foreign.voice.toggle();
    foreign.last().fail("language-not-supported");
    vi.runAllTimers();
    expect(foreign.voice.state.value).toBe("idle");
    expect(foreign.voice.note.value).toMatch(/языке страницы/);
    expect(foreign.made()).toBe(1);
  });

  it("retries a broken recognition after 1 s, then 2 s, then stops with a note; only a final word resets the count", () => {
    const { voice, field, last, made } = setup();
    voice.toggle();
    // The connection breaks on a guess: the guess goes, the final word stays.
    last().say(["проверь", true], [" кеш", false]);
    last().fail("network");
    last().end();
    expect(field.text).toBe("проверь");
    expect(voice.note.value).toMatch(/прервалось: пробую снова/);
    vi.advanceTimersByTime(999);
    expect(made()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(made()).toBe(2);
    last().say(["кэш сборки", true]);
    expect(field.text).toBe("проверь кэш сборки");
    expect(voice.note.value).toBeNull();
    vi.advanceTimersByTime(SILENCE);
    last().end();
    vi.advanceTimersByTime(300);
    expect(made()).toBe(3);
    // Each try now hears a guess only, and breaks: the guesses do not reset the count.
    for (const pause of [1000, 2000]) {
      last().say(["и", false]);
      last().fail("network");
      last().end();
      vi.advanceTimersByTime(pause - 1);
      const before = made();
      vi.advanceTimersByTime(1);
      expect(made()).toBe(before + 1);
    }
    last().say(["и", false]);
    last().fail("network");
    last().end();
    vi.runAllTimers();
    expect(made()).toBe(5);
    expect(voice.state.value).toBe("idle");
    expect(voice.note.value).toMatch(/нужна сеть/);
    expect(field.text).toBe("проверь кэш сборки");
    // A new start clears the note.
    voice.toggle();
    expect(voice.note.value).toBeNull();
  });

  it("drops the retry's note at the user's stop and at the send", () => {
    for (const end of ["stop", "dispose"] as const) {
      const { voice, last, made } = setup();
      voice.toggle();
      last().fail("network");
      last().end();
      expect(voice.note.value).not.toBeNull();
      voice[end]();
      vi.runAllTimers();
      expect(made()).toBe(1);
      expect(voice.note.value).toBeNull();
    }
  });

  it("gives up when start() throws or the browser ends the recognition at once, with pauses between the tries", () => {
    for (const onStart of ["throw", "end"] as const) {
      const { voice, made } = setup();
      FakeRecognition.onStart = onStart;
      voice.toggle();
      expect(made()).toBe(1);
      vi.advanceTimersByTime(999);
      expect(made()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(made()).toBe(2);
      vi.advanceTimersByTime(1999);
      expect(made()).toBe(2);
      vi.runAllTimers();
      expect(made()).toBe(3);
      expect(voice.state.value).toBe("idle");
      expect(voice.note.value).toMatch(/^Диктовка остановлена: браузер не смог/);
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
