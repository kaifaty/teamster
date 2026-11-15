// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { ActionResult } from "../../lib/actions";
import { fixtureResearch } from "../../fixtures/research";
import type { Lesson } from "../../types";
import { research } from "../research";
import { CONSOLE, createConsole } from "./console";
import LessonActions from "./LessonActions.vue";

const NOW = Date.UTC(2026, 10, 9, 4, 12) / 1000;
const W1 = "batch-2026-11-08.md W1"; // proposed, its proposal names teamster: the place is clear
const W2 = "batch-2026-11-08.md W2"; // proposed, its target has two repositories and a skill
const W4 = "batch-2026-11-08.md W4"; // proposed, its target is a repository the board does not know
const SKILL = "~/.claude/skills/agent-router/SKILL.md";

function setup(entry: string, patch: Partial<Lesson> = {}) {
  const view = fixtureResearch(NOW);
  Object.assign(view.lessons.find((item) => item.entry === entry)!, patch);
  const station = ref(research(view, [], [])!);
  const act = vi.fn(async (_route: string, _body: unknown): Promise<ActionResult> => ({ ok: true, output: "" }));
  const desk = createConsole(station, ref(NOW), { act: act as never, copy: async () => true });
  const lesson = station.value.proposed.find((item) => item.entry === entry)!;
  const wrapper = mount(LessonActions, { props: { lesson, stage: "proposed" }, global: { provide: { [CONSOLE as symbol]: desk } } });
  const button = (text: string) => wrapper.findAll("button").find((item) => item.text() === text)!;
  const hints = () => wrapper.findAll(".hint").map((item) => item.text());
  return { act, desk, lesson, wrapper, button, hints };
}

describe("«Внедрить» on a lesson whose place is clear", () => {
  it("starts the task in that repository at once, without the form and without a note left on the card", async () => {
    const { act, desk, lesson, wrapper, button } = setup(W1);
    desk.edit(lesson).note = "a note from an earlier form";
    expect(wrapper.find("form").exists()).toBe(false);
    await button("Внедрить в teamster").trigger("click");
    expect(act).toHaveBeenCalledWith("implement", { entry: W1, repo: "/Users/demo/dev/teamster" });
    expect(wrapper.find("form").exists()).toBe(false);
  });

  it("opens the form with that repository from «Другой репозиторий или уточнение»", async () => {
    const { act, wrapper, button } = setup(W1);
    await button("Другой репозиторий или уточнение").trigger("click");
    expect(act).not.toHaveBeenCalled();
    expect(wrapper.find("form").exists()).toBe(true);
    expect(wrapper.find("select").element.value).toBe("/Users/demo/dev/teamster");
  });
});

describe("«Внедрить» on a lesson whose place is not clear", () => {
  const HINT = "Урок меняет ещё: mytonwallet-frontend. Их части агент перечислит в отчёте — запусти потом отдельно";

  it("opens the form instead of starting, and names the lesson's other repositories", async () => {
    const { act, wrapper, button, hints } = setup(W2, { target: ["teamster", "mytonwallet-frontend", SKILL] });
    expect(button("Внедрить в teamster")).toBeUndefined();
    await button("Внедрить").trigger("click");
    expect(act).not.toHaveBeenCalled();
    expect(wrapper.find("select").element.value).toBe("/Users/demo/dev/teamster");
    expect(hints()).toContain(HINT);
  });

  it("names no other repository for a target of one repository the board does not know", async () => {
    const { act, wrapper, button, hints } = setup(W4);
    await button("Внедрить").trigger("click");
    expect(act).not.toHaveBeenCalled();
    expect(wrapper.find("form").exists()).toBe(true);
    expect(hints().some((text) => text.startsWith("Урок меняет ещё"))).toBe(false);
  });
});
