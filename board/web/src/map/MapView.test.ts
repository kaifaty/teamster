// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import snapshotJson from "../fixtures/snapshot.json";
import type { BoardSource } from "../lib/source";
import { createBoard } from "../store/board";
import type { Snapshot, TaskSummary } from "../types";
import MapConsole from "./console/MapConsole.vue";
import { queueOf } from "./console/queue";
import type { Star } from "./fleet";
import MapView from "./MapView.vue";

// The scene draws with WebGL, which the test has not: the map stands without it.
vi.mock("./scene", async () => ({ ...(await vi.importActual<object>("./scene/types")), createFleetScene: vi.fn() }));
vi.mock("./use/useFleetScene", () => ({ useFleetScene: () => ({ failure: ref(null), retry: () => {} }) }));

const snapshot = snapshotJson as unknown as Snapshot;

function source(): BoardSource {
  return {
    label: null,
    connect(onMessage, onState) {
      onState("open", null);
      onMessage({ type: "snapshot", snapshot });
      return () => {};
    },
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
  it("counts the tasks the systems' badges count: the reflection's own run is not one of them", async () => {
    const board = createBoard(source());
    board.start();
    const wrapper = mount(MapView, { props: { board, active: true }, attachTo: document.body });
    await flushPromises();
    const panel = wrapper.findComponent(MapConsole);
    const tasks = panel.props("tasks") as TaskSummary[];
    const stars = panel.props("stars") as Star[];
    // The fixture has a reflection run waiting with an alarm: the board's tasks hold it, the systems do not.
    expect(board.tasks.value.some((task) => task.slug === "reflect-review-patterns" && task.column === "attention")).toBe(true);
    expect(tasks.map((task) => task.slug)).not.toContain("reflect-review-patterns");
    expect(queueOf(tasks, "attention").length).toBe(stars.reduce((sum, star) => sum + star.attention, 0));
    expect(queueOf(tasks, "review_me").length).toBe(stars.reduce((sum, star) => sum + star.ready, 0));
    expect(queueOf(tasks, "attention").length).toBeGreaterThan(0);
    wrapper.unmount();
    board.stop();
  });
});
