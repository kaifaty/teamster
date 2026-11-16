// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ConsoleChatField from "./ConsoleChatField.vue";

const field = (props: { unavailable: string | null; pickDuty?: boolean }) =>
  mount(ConsoleChatField, { props: { busy: false, open: false, modelValue: "", ...props } });

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
});
