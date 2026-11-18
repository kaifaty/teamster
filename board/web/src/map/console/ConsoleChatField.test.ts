// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConsoleChatField from "./ConsoleChatField.vue";
import type { RecognitionEventLike } from "./voice";

const field = (props: { unavailable: string | null; pickDuty?: boolean }) =>
  mount(ConsoleChatField, { props: { busy: false, open: false, modelValue: "", ...props } });

/** The browser's recognition, as the field finds it on the page. */
class FakeRecognition {
  static made: FakeRecognition[] = [];
  lang = "";
  interimResults = false;
  continuous = false;
  stopped = false;
  aborted = false;
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
  abort() {
    this.aborted = true;
  }
  say(transcript: string, isFinal: boolean) {
    this.onresult?.({ results: [Object.assign([{ transcript }], { isFinal })] });
  }
}

/** The field's watcher of its own box, which the test calls when the field is hidden. */
let resized: (() => void) | null = null;
class FakeResizeObserver {
  constructor(callback: () => void) {
    resized = callback;
  }
  observe() {}
  disconnect() {}
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function dictating() {
  vi.useFakeTimers();
  FakeRecognition.made = [];
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
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
    const folds = vi.fn();
    document.body.addEventListener("keydown", folds);
    const mic = wrapper.get(".mic");
    // A plain button in the tab order: Enter and Space press it.
    expect(mic.element.tagName).toBe("BUTTON");
    expect(mic.attributes("tabindex")).toBeUndefined();
    expect(mic.attributes()).toMatchObject({ "aria-pressed": "false", "aria-label": "Диктовка" });
    await mic.trigger("click");
    expect(mic.attributes()).toMatchObject({ "aria-pressed": "true", "aria-label": "Диктовка" });
    expect(wrapper.get("[role=status]").text()).toBe("Идёт диктовка");
    last().say("проверь кэш", true);
    await wrapper.vm.$nextTick();
    expect(wrapper.get("textarea").element.value).toBe("проверь кэш");
    await wrapper.get("textarea").trigger("keydown", { key: "Escape" });
    expect(last().stopped).toBe(true);
    expect(folds).not.toHaveBeenCalled();
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(wrapper.emitted("send")).toBeUndefined();
    expect(mic.attributes("aria-pressed")).toBe("false");
    // Escape on the microphone stops as well, and goes no further.
    await mic.trigger("click");
    await mic.trigger("keydown", { key: "Escape" });
    expect(last().stopped).toBe(true);
    expect(folds).not.toHaveBeenCalled();
    // With no dictation, Escape folds the conversation as before.
    await wrapper.get("textarea").trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
    // The dictated words stay a draft: edited, they reach the model, and only Enter sends them.
    await wrapper.get("textarea").setValue("проверь кэш и тесты");
    expect(wrapper.props("modelValue")).toBe("проверь кэш и тесты");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", shiftKey: true });
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", isComposing: true });
    expect(wrapper.emitted("send")).toBeUndefined();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("send")).toHaveLength(1);
    document.body.removeEventListener("keydown", folds);
    wrapper.unmount();
  });

  it("says why the microphone was refused, and keeps it in the tab order", async () => {
    const { wrapper, last } = dictating();
    await wrapper.get(".mic").trigger("click");
    last().onerror?.({ error: "not-allowed" });
    last().onend?.();
    await wrapper.vm.$nextTick();
    const mic = wrapper.get(".mic");
    expect(mic.attributes()).toMatchObject({ "aria-disabled": "true", "aria-pressed": "false" });
    expect(mic.attributes("disabled")).toBeUndefined();
    const status = wrapper.get("[role=status]");
    expect(status.text()).toMatch(/не дал доступ к микрофону/);
    expect(status.classes()).toContain("shown");
    expect(mic.attributes("aria-describedby")).toBe(status.attributes("id"));
    await mic.trigger("click");
    expect(FakeRecognition.made).toHaveLength(1);
    wrapper.unmount();
  });

  it("drops the dictation and its planned restart at the send, at the unmount, and when the field is hidden", async () => {
    const { wrapper, last } = dictating();
    await wrapper.get(".mic").trigger("click");
    const first = last();
    first.say("привет", false);
    await wrapper.vm.$nextTick();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("send")).toHaveLength(1);
    expect(first.aborted).toBe(true);
    await wrapper.setProps({ modelValue: "" });
    first.say("привет", true);
    first.onend?.();
    vi.runAllTimers();
    await wrapper.vm.$nextTick();
    expect(wrapper.get("textarea").element.value).toBe("");
    expect(FakeRecognition.made).toHaveLength(1);
    expect(wrapper.get(".mic").attributes("aria-pressed")).toBe("false");

    // Sent in the pause between two recognitions.
    await wrapper.get(".mic").trigger("click");
    last().say("ещё", true);
    vi.advanceTimersByTime(3000);
    last().onend?.();
    expect(vi.getTimerCount()).toBe(1);
    await wrapper.vm.$nextTick();
    await wrapper.get(".send").trigger("click");
    expect(wrapper.emitted("send")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeRecognition.made).toHaveLength(2);

    // Hidden with its panel while it listens: the dictation stops.
    await wrapper.get(".mic").trigger("click");
    vi.spyOn(wrapper.element, "getClientRects").mockReturnValue([] as unknown as DOMRectList);
    resized?.();
    expect(last().stopped).toBe(true);
    vi.runAllTimers();
    expect(FakeRecognition.made).toHaveLength(3);

    // Unmounted while it listens: the recognition is aborted.
    await wrapper.get(".mic").trigger("click");
    const fourth = last();
    wrapper.unmount();
    expect(fourth.aborted).toBe(true);

    // Unmounted in the pause between two recognitions: none starts.
    const again = dictating();
    await again.wrapper.get(".mic").trigger("click");
    vi.advanceTimersByTime(3000);
    again.last().onend?.();
    again.wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(FakeRecognition.made).toHaveLength(1);
  });
});
