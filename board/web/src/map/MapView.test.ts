// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { fixtureProjectTasks } from "../fixtures/projectTasks";
import snapshotJson from "../fixtures/snapshot.json";
import type { BoardSource } from "../lib/source";
import { createBoard } from "../store/board";
import type { Snapshot, TaskSummary } from "../types";
import MapConsole from "./console/MapConsole.vue";
import { queueOf } from "./console/queue";
import type { Star } from "./fleet";
import MapView from "./MapView.vue";

const snapshot = snapshotJson as unknown as Snapshot;

function source(): BoardSource {
  return {
    label: null,
    connect(onMessage, onState) {
      onState("open", null);
      onMessage({ type: "snapshot", snapshot });
      return () => {};
    },
    ...fixtureProjectTasks(),
    fetchDetail: async () => null,
    fetchFile: async () => null,
    fetchFeed: async () => null,
    fetchArt: async () => ({}),
    fetchConstellations: async () => ({ constellations: [], error: null }),
    fetchResearch: async () => null,
    fetchEvents: async (since, until) => ({ since, until, events: [] }),
    fetchReport: async () => ({}) as never,
  };
}

describe("the map's control panel", () => {
  it("excludes reflection runs from both the duty counts and the operational queues", async () => {
    const board = createBoard(source());
    board.start();
    const wrapper = mount(MapView, { props: { board, active: true }, attachTo: document.body });
    await flushPromises();
    await wrapper.get('button[aria-controls="map-tools"]').trigger("click");
    const panel = wrapper.findComponent(MapConsole);
    const tasks = panel.props("tasks") as TaskSummary[];
    const stars = panel.props("stars") as Star[];
    // The snapshot includes a reflection run with an alarm.
    expect(board.tasks.value.some((task) => task.slug === "reflect-review-patterns" && task.column === "attention")).toBe(true);
    expect(tasks.map((task) => task.slug)).not.toContain("reflect-review-patterns");
    expect(queueOf(tasks, "attention").length).toBe(stars.reduce((sum, star) => sum + star.attention, 0));
    expect(queueOf(tasks, "review_me").length).toBe(stars.reduce((sum, star) => sum + star.ready, 0));
    expect(queueOf(tasks, "attention").length).toBeGreaterThan(0);
    wrapper.unmount();
    board.stop();
  });
});
