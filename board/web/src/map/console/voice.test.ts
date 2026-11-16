import { describe, expect, it } from "vitest";
import { createVoice, findRecognition, NO_RECOGNITION, voiceTitle, type RecognitionEventLike, type RecognitionLike } from "./voice";

/** A recognition the test speaks into. */
class FakeRecognition implements RecognitionLike {
  static made: FakeRecognition[] = [];
  lang = "";
  interimResults = false;
  continuous = true;
  started = false;
  onresult: ((event: RecognitionEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.made.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.onend?.();
  }
  say(...parts: [string, boolean][]) {
    this.onresult?.({ results: parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) });
  }
}

function setup(text = "") {
  FakeRecognition.made = [];
  const field = { text };
  const voice = createVoice({ ctor: FakeRecognition, lang: () => "ru", text: () => field.text, onText: (value) => (field.text = value) });
  return { voice, field, last: () => FakeRecognition.made.at(-1)! };
}

describe("dictation", () => {
  it("listens in the page's language with interim results, and writes the words after the field's text as they come", () => {
    const { voice, field, last } = setup("Задача: ");
    voice.toggle();
    expect(voice.state.value).toBe("listening");
    expect(last()).toMatchObject({ lang: "ru", interimResults: true, continuous: false, started: true });
    last().say(["проверь", false]);
    expect(field.text).toBe("Задача: проверь");
    last().say(["проверь кэш ", true], [" сборки", false]);
    expect(field.text).toBe("Задача: проверь кэш сборки");
    // A pause ends the phrase: the browser ends the recognition.
    last().onend?.();
    expect(voice.state.value).toBe("idle");
    expect(field.text).toBe("Задача: проверь кэш сборки");
  });

  it("stops at the second press, and starts anew after the text the field holds then", () => {
    const { voice, field, last } = setup();
    voice.toggle();
    last().say(["первое", true]);
    voice.toggle();
    expect(voice.state.value).toBe("idle");
    field.text += ",";
    voice.toggle();
    last().say(["второе", false]);
    expect(field.text).toBe("первое, второе");
    expect(FakeRecognition.made).toHaveLength(2);
  });

  it("is off without the browser's recognition, and after the microphone was refused, with a title that says why", () => {
    const none = createVoice({ ctor: null, text: () => "", onText: () => {} });
    none.toggle();
    expect(none.state.value).toBe("off");
    expect(voiceTitle(none.state.value, none.why.value)).toBe(NO_RECOGNITION);

    const { voice, last } = setup();
    expect(voiceTitle(voice.state.value, voice.why.value)).toBe("Надиктовать задачу");
    voice.toggle();
    expect(voiceTitle(voice.state.value, voice.why.value)).toBe("Остановить диктовку");
    last().onerror?.({ error: "not-allowed" });
    last().onend?.();
    expect(voice.state.value).toBe("off");
    expect(voiceTitle(voice.state.value, voice.why.value)).toMatch(/не дал доступ к микрофону/);
    voice.toggle();
    expect(FakeRecognition.made).toHaveLength(1);

    // Silence only ends the listening.
    const quiet = setup();
    quiet.voice.toggle();
    quiet.last().onerror?.({ error: "no-speech" });
    quiet.last().onend?.();
    expect(quiet.voice.state.value).toBe("idle");
  });

  it("finds the browser's recognition, prefixed or not", () => {
    expect(findRecognition({})).toBeNull();
    expect(findRecognition({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(findRecognition({ SpeechRecognition: FakeRecognition, webkitSpeechRecognition: class {} })).toBe(FakeRecognition);
  });
});
