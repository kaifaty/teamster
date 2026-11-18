// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConsoleChatField from "./ConsoleChatField.vue";
import { RESTART_DELAY, SHORT_RUN, type RecognitionEventLike } from "./voice";

const field = (props: { unavailable: string | null; pickDuty?: boolean }) =>
  mount(ConsoleChatField, { props: { busy: false, open: false, modelValue: "", ...props } });

/** The browser's recognition, as the field finds it on the page. */
class FakeRecognition {
  static made: FakeRecognition[] = [];
  lang = "";
  interimResults = false;
  continuous = false;
  stopped = false;
  onresult: ((event: RecognitionEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.made.push(this);
  }
  start() {}
  stop() {
    this.stopped = true;
  }
  abort() {}
  say(transcript: string, isFinal: boolean) {
    this.onresult?.({ results: [Object.assign([{ transcript }], { isFinal })] });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function dictating() {
  vi.useFakeTimers();
  FakeRecognition.made = [];
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
  const wrapper: ReturnType<typeof mount<typeof ConsoleChatField>> = mount(ConsoleChatField, {
    props: {
      unavailable: null,
      busy: false,
      open: true,
      modelValue: "",
      "onUpdate:modelValue": (value: string): void => void wrapper.setProps({ modelValue: value }),
    },
    attachTo: document.body,
  });
  return { wrapper, last: () => FakeRecognition.made.at(-1)! };
}

describe("the duty chat's field", () => {
  it("stands as a plain sentence instead of the field when the chat cannot work, with the duty's choice only when it helps", () => {
    for (const pickDuty of [false, true]) {
      const wrapper = field({ unavailable: "Доска запущена с --read-only: писать дежурному нельзя", pickDuty });
      expect(wrapper.find(".chat-off").exists()).toBe(true);
      expect(wrapper.find("textarea").exists()).toBe(false);
      expect(wrapper.find(".mic").exists()).toBe(false);
      expect(wrapper.find(".pick-duty").exists()).toBe(pickDuty);
    }
    const working = field({ unavailable: null });
    expect(working.find("textarea").exists()).toBe(true);
    expect(working.find(".chat-off").exists()).toBe(false);
  });

  it("shows a running dictation on the microphone, ends it at Escape without folding the conversation, and never sends", async () => {
    const { wrapper, last } = dictating();
    const mic = wrapper.get(".mic");
    expect(mic.attributes()).toMatchObject({ "aria-pressed": "false", "aria-label": "Надиктовать задачу" });
    await mic.trigger("click");
    expect(mic.attributes()).toMatchObject({ "aria-pressed": "true", "aria-label": "Закончить диктовку" });
    expect(wrapper.get("[role=status]").text()).toBe("Идёт диктовка");
    last().say("проверь кэш", true);
    await wrapper.vm.$nextTick();
    expect(wrapper.get("textarea").element.value).toBe("проверь кэш");
    await wrapper.get("textarea").trigger("keydown", { key: "Escape" });
    expect(last().stopped).toBe(true);
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(wrapper.emitted("send")).toBeUndefined();
    expect(mic.attributes("aria-pressed")).toBe("false");
    // The next Escape folds the conversation as before.
    await wrapper.get("textarea").trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("drops the dictation and its planned restart at the send and at the unmount", async () => {
    const { wrapper, last } = dictating();
    await wrapper.get(".mic").trigger("click");
    const first = last();
    first.say("привет", false);
    await wrapper.vm.$nextTick();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("send")).toHaveLength(1);
    await wrapper.setProps({ modelValue: "" });
    first.say("привет", true);
    first.onend?.();
    vi.runAllTimers();
    await wrapper.vm.$nextTick();
    expect(wrapper.get("textarea").element.value).toBe("");
    expect(FakeRecognition.made).toHaveLength(1);
    expect(wrapper.get(".mic").attributes("aria-pressed")).toBe("false");

    // Unmounted in the pause between two recognitions: none starts.
    await wrapper.get(".mic").trigger("click");
    vi.advanceTimersByTime(SHORT_RUN * 5);
    last().onend?.();
    wrapper.unmount();
    vi.advanceTimersByTime(RESTART_DELAY * 10);
    expect(FakeRecognition.made).toHaveLength(2);
  });
});
