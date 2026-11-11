import { describe, expect, it } from "vitest";
import type { ReflectionSchedule } from "../types";
import { clockShort, cronText, dayWhen, dial, stationClock } from "./schedule";

// Local times, so that the tests do not depend on the machine's time zone.
const local = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 10, day, hour, minute, second).getTime() / 1000;

const schedule = (patch: Partial<ReflectionSchedule> = {}): ReflectionSchedule => ({
  source: "desktop",
  name: "Рефлексия",
  cron: "0 9 * * *",
  enabled: true,
  last_run_at: local(9, 9, 5),
  last_scheduled_for: local(9, 9),
  next_at: local(10, 9),
  ...patch,
});

describe("cronText", () => {
  it("reads the usual shapes", () => {
    expect(cronText("0 9 * * *")).toBe("ежедневно в 09:00");
    expect(cronText("30 8 * * 1-5")).toBe("по будням в 08:30");
    expect(cronText("0 10 * * 1")).toBe("по понедельникам в 10:00");
    expect(cronText("0 10 * * 7")).toBe("по воскресеньям в 10:00");
    expect(cronText("0 10 * * 6,0")).toBe("по выходным в 10:00");
    expect(cronText("0 10 * * 5,1,3")).toBe("по пн, ср, пт в 10:00");
    expect(cronText("*/15 * * * *")).toBe("каждые 15 мин");
    expect(cronText("5 * * * *")).toBe("каждый час в :05");
    expect(cronText("0 */6 * * *")).toBe("каждые 6 ч");
    expect(cronText("0 9 1 * *")).toBe("1-го числа в 09:00");
  });

  it("shows anything else as written", () => {
    expect(cronText("@daily")).toBe("cron @daily");
    expect(cronText("0 10 1 * 1")).toBe("cron 0 10 1 * 1");
    expect(cronText("0 25 * * *")).toBe("cron 0 25 * * *");
  });
});

describe("dayWhen", () => {
  it("names today, tomorrow and yesterday, and dates further away", () => {
    const now = local(9, 12);
    expect(dayWhen(local(9, 9, 5), now)).toBe("сегодня в 09:05");
    expect(dayWhen(local(10, 9), now)).toBe("завтра в 09:00");
    expect(dayWhen(local(8, 9), now)).toBe("вчера в 09:00");
    expect(dayWhen(local(12, 9), now)).toMatch(/^чт, 12 нояб\.? в 09:00$/);
  });
});

describe("dial", () => {
  it("counts hours, minutes and seconds up to 99 hours", () => {
    expect(dial(21 * 3600 + 14 * 60 + 5)).toBe("21:14:05");
    expect(dial(-5)).toBe("00:00:00");
    expect(dial(5 * 86400 + 3 * 3600)).toBe("5 д 3 ч");
  });
});

describe("stationClock", () => {
  it("counts down to the next run and fills the ring from the last one", () => {
    const now = local(9, 21, 5);
    const clock = stationClock(schedule(), now, null);
    expect(clock).toMatchObject({ state: "counting", big: "11:55:00", when: "завтра в 09:00", rule: "ежедневно в 09:00", last: "сегодня в 09:05" });
    expect(clock.progress).toBeCloseTo(0.5, 1);
    expect(clockShort(clock, now, schedule().next_at)).toBe("11 ч 55 мин");
  });

  it("tells a running reflection first", () => {
    const clock = stationClock(schedule(), local(9, 12), local(9, 11, 50));
    expect(clock).toMatchObject({ state: "running", big: "10 мин 00 с", when: "завтра в 09:00" });
    expect(clockShort(clock, local(9, 12), null)).toBe("идёт");
  });

  it("shows a run that is due, a switched-off schedule, an unread cron and none at all", () => {
    expect(stationClock(schedule(), local(10, 9, 0, 30), null)).toMatchObject({ state: "due", progress: 1, big: "вот-вот" });
    expect(stationClock(schedule({ enabled: false }), local(9, 12), null)).toMatchObject({ state: "off", progress: 0, when: null });
    expect(stationClock(schedule({ cron: "@daily", next_at: null }), local(9, 12), null)).toMatchObject({ state: "unknown", rule: "cron @daily" });
    expect(stationClock(null, local(9, 12), null)).toMatchObject({ state: "none", big: "по запросу", rule: null });
    expect(stationClock(undefined, local(9, 12), null).state).toBe("none");
  });

  it("starts the ring from the planned time of a run that never happened", () => {
    const clock = stationClock(schedule({ last_run_at: null }), local(9, 21), null);
    expect(clock.last).toBe("сегодня в 09:00");
    expect(clock.progress).toBeCloseTo(0.5, 2);
  });
});
