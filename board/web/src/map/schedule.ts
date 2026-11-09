// The science station's chronometer: when the planned reflection runs next, how far the station is through the
// wait, and the schedule in words. Pure data for the station screen; times are Unix seconds, read in local time
// like the cron itself.

import { coarseSpan, formatDuration } from "../lib/format";
import type { ReflectionSchedule } from "../types";

/** By the day of week, 0 = Sunday, for «по понедельникам». */
const ON_DAYS = ["воскресеньям", "понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам"];
const SHORT_DAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

const pad = (n: number) => String(n).padStart(2, "0");
const whole = (field: string) => (/^\d{1,2}$/.test(field) ? Number(field) : null);
const step = (field: string) => /^\*\/(\d{1,2})$/.exec(field)?.[1] ?? null;

/** The cron of a schedule in words, for the usual shapes; the expression itself for anything else. */
export function cronText(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return `cron ${cron.trim()}`;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const m = whole(minute);
  const h = whole(hour);
  const any = (field: string) => field === "*";
  if (any(dom) && any(month) && any(dow)) {
    if (m !== null && h !== null && m < 60 && h < 24) return `ежедневно в ${pad(h)}:${pad(m)}`;
    if (step(minute) && any(hour)) return `каждые ${step(minute)} мин`;
    if (m !== null && m < 60 && any(hour)) return `каждый час в :${pad(m)}`;
    if (m !== null && m < 60 && step(hour)) return `каждые ${step(hour)} ч`;
  }
  if (m === null || h === null || m > 59 || h > 23 || !any(month)) return `cron ${cron.trim()}`;
  const time = `в ${pad(h)}:${pad(m)}`;
  if (any(dom) && /^[0-7](,[0-7])*$/.test(dow)) {
    const days = [...new Set(dow.split(",").map((day) => Number(day) % 7))];
    if (days.length === 1) return `по ${ON_DAYS[days[0]!]} ${time}`;
    if (days.length === 2 && days.includes(0) && days.includes(6)) return `по выходным ${time}`;
    return `по ${days.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => SHORT_DAYS[day]).join(", ")} ${time}`;
  }
  if (any(dom) && dow === "1-5") return `по будням ${time}`;
  if (any(dow) && whole(dom) !== null && Number(dom) >= 1 && Number(dom) <= 31) return `${Number(dom)}-го числа ${time}`;
  return `cron ${cron.trim()}`;
}

const dayStart = (at: number) => {
  const date = new Date(at * 1000);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000;
};
const clockFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short" });

/** «сегодня в 09:00», «завтра в 09:00», «вчера в 09:05», or «пн, 10 нояб. в 09:00». */
export function dayWhen(at: number, now: number): string {
  const days = Math.round((dayStart(at) - dayStart(now)) / 86400);
  const time = clockFormat.format(new Date(at * 1000));
  const day = days === 0 ? "сегодня" : days === 1 ? "завтра" : days === -1 ? "вчера" : dateFormat.format(new Date(at * 1000));
  return `${day} в ${time}`;
}

/** A countdown on the dial: «21:14:05» up to 99 hours, «5 д 3 ч» beyond. */
export function dial(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  if (hours >= 100) return coarseSpan(total);
  return `${pad(hours)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/**
 * What the chronometer shows:
 * - `none`: the server names no planned reflection, only orders run it;
 * - `off`: the scheduled task is switched off;
 * - `unknown`: its cron cannot be read, so the next time is unknown;
 * - `running`: a reflection works now;
 * - `due`: the planned time has come and the run has not shown up yet;
 * - `counting`: the wait for the next run.
 */
export type ClockState = "none" | "off" | "unknown" | "running" | "due" | "counting";

export interface Clock {
  state: ClockState;
  /** 0–1: how far the station is from the last run to the next one, for the ring. */
  progress: number;
  /** The big line: a countdown, how long the run goes, or what is wrong. */
  big: string;
  /** Under it: when, in words. */
  when: string | null;
  /** The rule: «ежедневно в 09:00». */
  rule: string | null;
  /** The last planned run: «сегодня в 09:05». */
  last: string | null;
}

/**
 * The chronometer at `now`. `runningSince` is when the work going on now started, or null when nothing runs. The
 * ring counts from the desktop task's last run, or from its last planned time when it never ran.
 */
export function stationClock(
  schedule: ReflectionSchedule | null | undefined,
  now: number,
  runningSince: number | null,
): Clock {
  const rule = schedule ? cronText(schedule.cron) : null;
  const lastAt = schedule?.last_run_at ?? schedule?.last_scheduled_for ?? null;
  const last = lastAt !== null ? dayWhen(lastAt, now) : null;
  const next = schedule?.enabled ? schedule.next_at : null;
  const progress = next !== null && lastAt !== null && next > lastAt ? Math.min(1, Math.max(0, (now - lastAt) / (next - lastAt))) : 0;
  const when = next !== null ? dayWhen(next, now) : null;
  if (runningSince !== null) return { state: "running", progress, big: formatDuration(now - runningSince), when, rule, last };
  if (!schedule) return { state: "none", progress: 0, big: "по приказу", when: null, rule: null, last: null };
  if (!schedule.enabled) return { state: "off", progress: 0, big: "выключено", when: null, rule, last };
  if (next === null) return { state: "unknown", progress: 0, big: "—:—", when: null, rule, last };
  if (next <= now) return { state: "due", progress: 1, big: "вот-вот", when, rule, last };
  return { state: "counting", progress, big: dial(next - now), when, rule, last };
}

/** The top bar's short form of the wait: «21 ч 14 мин», «идёт», «—». */
export function clockShort(clock: Clock, now: number, next: number | null | undefined): string {
  if (clock.state === "running") return "идёт";
  if (clock.state === "due") return "вот-вот";
  if (clock.state !== "counting" || next == null) return "—";
  return coarseSpan(next - now);
}
