// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { ActionResult } from "../../lib/actions";
import { fixtureResearch } from "../../fixtures/research";
import { research } from "../research";
import { CONSOLE, createConsole } from "./console";
import LessonActions from "./LessonActions.vue";

const NOW = Date.UTC(2026, 10, 9, 4, 12) / 1000;
const W1 = "batch-2026-11-08.md W1"; // proposed, its proposal names teamster: the place is clear

function setup() {
  const station = ref(research(fixtureResearch(NOW), [], [])!);
  const act = vi.fn(async (_route: string, _body: unknown): Promise<ActionResult> => ({ ok: true, output: "" }));
  const desk = createConsole(station, ref(NOW), { act: act as never, copy: async () => true });
  const lesson = station.value.proposed.find((item) => item.entry === W1)!;
  const wrapper = mount(LessonActions, { props: { lesson, stage: "proposed" }, global: { provide: { [CONSOLE as symbol]: desk } } });
  const button = (text: string) => wrapper.findAll("button").find((item) => item.text() === text)!;
  return { act, desk, lesson, wrapper, button };
}

describe("«Внедрить» on a lesson whose place is clear", () => {
  it("starts the task in that repository at once, without the form", async () => {
    const { act, wrapper, button } = setup();
    expect(wrapper.find("form").exists()).toBe(false);
    await button("Внедрить в teamster").trigger("click");
    expect(act).toHaveBeenCalledWith("implement", { entry: W1, repo: "/Users/demo/dev/teamster" });
    expect(wrapper.find("form").exists()).toBe(false);
  });

  it("opens the form with that repository from «Другой репозиторий или уточнение»", async () => {
    const { act, wrapper, button } = setup();
    await button("Другой репозиторий или уточнение").trigger("click");
    expect(act).not.toHaveBeenCalled();
    expect(wrapper.find("form").exists()).toBe(true);
    expect(wrapper.find("select").element.value).toBe("/Users/demo/dev/teamster");
  });
});
