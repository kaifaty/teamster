import { describe, expect, it } from "vitest";
import type { FreeItem, Rings } from "../../lib/machines";
import type { Machine } from "../../types";
import { RINGS } from "../palette";
import { freeTitle, machineLabels, machineShape, RING_NOTE, ringLevel } from "./machines";

const NOW = 1_800_000_000;
const rings: Rings = { cpu: { percent: 95, level: "bad" }, memory: { percent: 80, level: "warn" }, gpu: { percent: 10, level: "ok" }, disk: null };
const machine = (overrides: Partial<Machine>): Machine => ({
  id: "m1", name: "gpu-box", role: null, status: "free", reasons: [], checked_at: NOW, sampled_at: NOW, error: null, host: null, history: [],
  metrics: {
    os: "linux",
    cpu: { cores: 32, load1: 4, load5: 4, percent: 12.5 },
    memory: { total_bytes: 64 * 2 ** 30, available_bytes: 24 * 2 ** 30 },
    gpus: [],
    disks: [],
  },
  ...overrides,
});
const column = {
  places: new Map([["m1", { x: 900, y: 300 }]]), labels: new Map(), status: true, size: 100, labelZoom: 1, right: 950, note: null,
};

describe("reactor labels", () => {
  it("colour a ring's figure only when it presses", () => {
    expect(ringLevel(rings, "cpu")).toBe("bad");
    expect(ringLevel(rings, "memory")).toBe("warn");
    expect(ringLevel(rings, "gpu")).toBeNull();
    expect(ringLevel({ ...rings, gpu: null }, "gpu")).toBeNull();
  });

  it("tell what is free ring by ring", () => {
    const free: FreeItem[] = [{ key: "cpu", text: "28 ядер" }, { key: "memory", text: "24 ГБ" }, { key: "gpu", text: "8 ГБ" }];
    expect(freeTitle(free)).toBe("Свободно: 28 ядер, памяти 24 ГБ, видеопамяти 8 ГБ");
    expect(freeTitle([{ key: "gpu", text: "40 %" }])).toBe("Свободно: GPU 40 %");
    expect(freeTitle([])).toBeNull();
  });

  it("put the name, the status, what is free and the rings' order in the title", () => {
    const [label] = machineLabels([machine({ role: "сборка" })], column, NOW);
    expect(label?.title).toBe(["gpu-box · сборка", "свободна", "Свободно: 28 ядер, памяти 24 ГБ", RING_NOTE].join("\n"));
    expect(label?.free.map((item) => item.color)).toEqual([RINGS.cpu, RINGS.memory]);
    expect(RING_NOTE).toBe("Кольца снаружи внутрь: CPU, память, GPU; дуга — занято");
    expect(label).toMatchObject({ level: "ok", showStatus: true, style: { "--x": 900 - 50 - 6, "--y": 300 } });
  });

  it("tell nothing free about an offline machine, and the age of its data", () => {
    const [label] = machineLabels([machine({ status: "offline", sampled_at: NOW - 600 })], column, NOW);
    expect(label?.free).toEqual([]);
    expect(label?.title).toBe(["gpu-box", "нет связи", RING_NOTE, "данные 10 мин назад"].join("\n"));
    expect(machineShape(machine({ status: "offline" })).status).toBe("нет связи");
    expect(machineShape(machine({})).status).toMatch(/^● .+ ● .+$/);
  });
});
