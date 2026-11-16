// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref, type Ref } from "vue";
import type { TaskSummary } from "../../types";
import * as queue from "../console/queue";
import { SOUND_KEY, useArrivalChime } from "./useArrivalChime";

vi.mock("../console/queue", async (importOriginal) => {
  const real = await importOriginal<typeof import("../console/queue")>();
  return { ...real, arrivals: vi.fn(real.arrivals) };
});

/** The tones each chime played, in hertz. */
let played: number[][] = [];

class FakeAudio {
  state = "running";
  currentTime = 0;
  destination = {};
  private chime: number[] | null = null;
  createOscillator() {
    if (!this.chime) {
      this.chime = [];
      played.push(this.chime);
      queueMicrotask(() => (this.chime = null));
    }
    const chime = this.chime;
    return { type: "", frequency: { set value(hz: number) { chime.push(hz); } }, connect: (next: unknown) => next, start() {}, stop() {} };
  }
  createGain() {
    return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (next: unknown) => next };
  }
  resume = async () => {};
  close = async () => {};
}

const task = (slug: string, column: TaskSummary["column"]) => ({ slug, repo: "repo", column, phase_started_at: 1, updated_at: 1 }) as TaskSummary;

function setup(sound: boolean) {
  localStorage.setItem(SOUND_KEY, JSON.stringify(sound));
  const sources = { tasks: ref<TaskSummary[]>([]), loaded: ref(false), source: ref({ name: "board" }) };
  let chime!: ReturnType<typeof useArrivalChime>;
  const wrapper = mount(defineComponent({ setup: () => ((chime = useArrivalChime(sources as never)), () => h("div")) }));
  // The browser lets the page sound after the viewer's first press.
  window.dispatchEvent(new Event("pointerdown"));
  const show = async (tasks: TaskSummary[]) => {
    sources.tasks.value = tasks;
    await nextTick();
  };
  return { sources, sound: chime.sound as Ref<boolean>, show, wrapper };
}

beforeEach(() => {
  played = [];
  vi.mocked(queue.arrivals).mockClear();
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudio;
});
afterEach(() => localStorage.clear());

describe("the arrival chime", () => {
  it("compares each queue's column with its own, and chimes lower for an alarm", async () => {
    const { sources, show, wrapper } = setup(true);
    const first = [task("ready-1", "review_me"), task("alarm-1", "attention"), task("busy", "running")];
    sources.loaded.value = true;
    await show(first);
    // The first snapshot is no arrival.
    expect(played).toEqual([]);

    await show([...first, task("ready-2", "review_me")]);
    expect(vi.mocked(queue.arrivals).mock.calls.map(([before, now]) => [[...before!], [...now]])).toEqual([
      [["alarm-1"], ["alarm-1"]],
      [["ready-1"], ["ready-1", "ready-2"]],
    ]);
    expect(played).toEqual([[660, 880]]);

    await show([...first, task("ready-2", "review_me"), task("alarm-2", "attention")]);
    expect(played).toEqual([[660, 880], [440, 330]]);
    wrapper.unmount();
  });

  it("stays silent with the sound off, and after a change of source", async () => {
    // The audio woke while the sound was on; then the viewer turned it off.
    const { sources, sound, show, wrapper } = setup(true);
    sources.loaded.value = true;
    await show([task("ready-1", "review_me")]);
    sound.value = false;
    await show([task("ready-1", "review_me"), task("ready-2", "review_me")]);
    expect(played).toEqual([]);

    sound.value = true;
    await nextTick();
    sources.source.value = { name: "scenario" };
    await show([task("other-1", "attention"), task("other-2", "review_me")]);
    expect(played).toEqual([]);
    // The new source's own arrivals chime again.
    await show([task("other-1", "attention"), task("other-2", "review_me"), task("other-3", "review_me")]);
    expect(played).toEqual([[660, 880]]);
    wrapper.unmount();
  });
});
