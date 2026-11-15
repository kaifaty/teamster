// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "../../lib/actions";
import type { BoardSource } from "../../lib/source";
import type { TaskDetail, TaskSummary } from "../../types";
import ShipView from "./ShipView.vue";

const NOW = 1_800_000_000;

const ship: TaskSummary = {
  slug: "t", kind: "work", title: null, link: null, repo: "repo", branch: "codex/t", task_type: null, executor: "codex", account: null,
  reviewer: "claude", model: null, effort: null, column: "review_me", phase: "idle", phase_started_at: NOW - 600, alive: false, turn: 1,
  fix_round: 0, outcome: "completed", result_status: "done", summary: "Сделано", pr: null, ci: null, sleeping_until: null, created: NOW - 9000,
  updated_at: NOW - 50, activity: null, check: "passed", review: "clean", findings_left: 0, stop: null, left: 0, lead_verdict: null, lead_verdict_at: null,
};

describe("the ship's screen after «Принять»", () => {
  it("shows «Принято» with «Убрать задачу» at once, from the answer, and no «Принять»", async () => {
    const detail: TaskDetail = {
      ...ship, timeline: [], files: [], cargo: null, limits: null, messages: [], activity_log: [], report: null, changes: null,
      queue: { waiting: [], dropped: [] }, actions: { enabled: true, reason: null, queue: true },
    };
    const act = vi.fn(async (): Promise<ActionResult> => ({ ok: true, output: "verdict accepted recorded for t (repo)", task: { ...ship, lead_verdict: "accepted", lead_verdict_at: NOW } }));
    const source = {
      label: null, act, connect: () => () => {}, fetchDetail: async () => detail, fetchFile: async () => null, fetchFeed: async () => null,
      fetchArt: async () => ({}), fetchConstellations: async () => ({ constellations: [], error: null }), fetchResearch: async () => null,
      fetchEvents: async () => ({ since: 0, until: 0, events: [] }), fetchReport: async () => ({}) as never,
    } as BoardSource;
    // The map applies the task the answer carries, as the board does.
    const wrapper = mount(ShipView, {
      props: { slug: "t", task: ship, source, now: NOW, frame: "", emblem: null, onTask: (task: TaskSummary) => wrapper.setProps({ task }) },
      attachTo: document.body,
    });
    await flushPromises();
    const needs = () => wrapper.find(".needs");
    const buttons = () => needs().findAll("button").map((button) => button.text());
    expect(buttons()).toContain("Принять");
    expect(needs().text()).toContain("Принять — записать оценку. PR этим не сливается: следующий шаг появится здесь.");

    await needs().findAll("button").find((button) => button.text() === "Принять")!.trigger("click");
    await flushPromises();
    expect(act).toHaveBeenCalledWith("verdict", { slug: "t", verdict: "accepted" });
    expect(needs().find("h4").text()).toBe("Принято: осталось убрать задачу");
    expect(buttons()).toContain("Убрать задачу");
    expect(buttons()).not.toContain("Принять");
    expect(buttons()).toContain("Изменить вердикт");
    expect(wrapper.find(".pill").text()).toBe("принято");
    expect(wrapper.find(".headline").text()).toBe("Принято: осталось убрать задачу");
    wrapper.unmount();
  });
});
