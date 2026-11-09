import { describe, expect, it } from "vitest";
import { RESEARCH_LABEL_DROP } from "../layout";
import { stationLabel, type StationMarks } from "./station";

const marks = (overrides: Partial<StationMarks>): StationMarks => ({
  batch: { name: "b", date: "2026-11-07", through: null, records: 3, repos: {} },
  proposed: [],
  waiting: 0,
  running: false,
  pending: { records: 9, signals: 4, repos: [], items: [] },
  ...overrides,
});
const lessons = (count: number) => Array.from({ length: count }, () => ({})) as StationMarks["proposed"];
const label = (overrides: Partial<StationMarks>) => stationLabel(marks(overrides), { x: 100, y: 200 });

describe("the science station's label", () => {
  it("puts a question first", () => {
    expect(label({ waiting: 2, running: true, proposed: lessons(3) })).toMatchObject({
      note: "ждёт ответа 2",
      title: "идёт разбор\nждут ответа 2\nждут решения 3\nс сигналом 4 из 9",
      running: false,
      waiting: true,
    });
  });

  it("then a running reflection, then the lessons that wait for a decision", () => {
    expect(label({ running: true, proposed: lessons(3) })).toMatchObject({ note: "идёт разбор", running: true, waiting: false });
    expect(label({ proposed: lessons(3) })).toMatchObject({
      note: "ждут решения 3",
      title: "разбор 07.11\nждут решения 3\nс сигналом 4 из 9",
      running: false,
      waiting: true,
    });
  });

  it("else tells when the last reflection was", () => {
    expect(label({})).toMatchObject({ note: "разбор 07.11", title: "разбор 07.11\nждут решения 0\nс сигналом 4 из 9", waiting: false });
    expect(label({ batch: null }).note).toBe("разборов не было");
  });

  it("stands under the station", () => {
    expect(label({}).style).toEqual({ "--x": 100, "--y": 200 + RESEARCH_LABEL_DROP });
  });
});
