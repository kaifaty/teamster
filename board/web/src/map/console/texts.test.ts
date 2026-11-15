import { describe, expect, it } from "vitest";
import { ADMIRAL_NOTE } from "../../lib/accounts";
import { formatClock, formatUntil } from "../../lib/format";
import type { Machine } from "../../types";
import type { Tank } from "../fleet";
import { dutyBlock, machineRow, MAX_CELLS, reflectionNote, subscriptionRow, tankTitle, type ReflectionMarks } from "./texts";

const NOW = 1_800_000_000;
const tank = (overrides: Partial<Tank>): Tank => ({
  key: "codex:main", name: "main", executor: "codex", fuel: 41, bad: false, status: null, admiral: false, duty: null,
  refillAt: null, resets: null, burst: null, ...overrides,
});
const when = (time: number) => `${formatClock(time, NOW)} (${formatUntil(time, NOW)})`;
const stars = [
  { live: 5, ready: 2 },
  { live: 3, ready: 0 },
];

describe("the duty block", () => {
  it("names the duty, its family, what is left, the reset and since when it is on duty, with the reason in the title", () => {
    const since = NOW - 3600;
    const duty = tank({ key: "claude:pool", name: "pool", executor: "claude", fuel: 64, refillAt: NOW + 3 * 86400, admiral: true, duty: { reason: "больше всего осталось", since } });
    const block = dutyBlock([tank({}), duty], stars, NOW);
    expect(block).toMatchObject({
      key: "claude:pool",
      heading: "Дежурный · pool",
      family: "Claude",
      info: "64% · ↻ 3 д",
      since: `дежурит с ${formatClock(since, NOW)}`,
      live: "в работе 8 · ждут тебя 2",
    });
    expect(block.title).toBe(["Дежурный · pool · Claude", "Почему: больше всего осталось", ADMIRAL_NOTE].join("\n"));
    expect(block.label).toContain("Открыть экран подписки");
  });

  it("says no one is on duty, and still counts the live tasks", () => {
    const block = dutyBlock([tank({})], stars, NOW);
    expect(block).toMatchObject({ key: null, heading: "Дежурный не назначен", family: null, info: null, since: null, label: null, live: "в работе 8 · ждут тебя 2" });
    expect(dutyBlock([], [], NOW).live).toBe("в работе 0 · ждут тебя 0");
  });
});

describe("a subscription's row", () => {
  it("takes its family's colour, the week left as its bar and the words of the tanks", () => {
    expect(subscriptionRow(tank({ refillAt: NOW + 3 * 3600 }), NOW)).toMatchObject({ tone: "codex", bar: 41, left: "41%", until: "↻ 3 ч", cells: 0, duty: false });
    expect(subscriptionRow(tank({ executor: "claude", fuel: 90 }), NOW)).toMatchObject({ tone: "claude", bar: 90, until: null });
    expect(subscriptionRow(tank({ fuel: null }), NOW)).toMatchObject({ tone: "codex", bar: 0, left: "нет данных" });
  });

  it("runs red at 20 % and less, and grey when it gives nothing: exhausted, limited or logged out", () => {
    expect(subscriptionRow(tank({ fuel: 20 }), NOW).tone).toBe("low");
    expect(subscriptionRow(tank({ fuel: 21 }), NOW).tone).toBe("codex");
    expect(subscriptionRow(tank({ fuel: 0, bad: true, status: "исчерпан", refillAt: NOW + 600 }), NOW)).toMatchObject({ tone: "off", bar: 0, left: "исчерпан", until: "↻ 10 мин" });
    expect(subscriptionRow(tank({ fuel: 70, bad: true, status: "лимит" }), NOW)).toMatchObject({ tone: "off", bar: 0, left: "лимит" });
    expect(subscriptionRow(tank({ executor: "claude", fuel: null, bad: true, status: "нужен вход" }), NOW)).toMatchObject({ tone: "off", left: "нужен вход" });
    expect(subscriptionRow(tank({ bad: true }), NOW).left).toBe("пусто");
  });

  it("shows Codex's free resets as cells, up to four, and marks the duty's row", () => {
    expect(MAX_CELLS).toBe(4);
    expect(subscriptionRow(tank({ resets: { count: 7, expires: [] } }), NOW).cells).toBe(4);
    const row = subscriptionRow(tank({ resets: { count: 2, expires: [] }, admiral: true }), NOW);
    expect(row).toMatchObject({ cells: 2, duty: true });
    expect(row.label).toBe("main, Codex: 41%, бесплатных сбросов 2, дежурная. Открыть экран подписки");
  });

  it("puts everything the subscription knows in the title", () => {
    const resetsAt = NOW + 7200;
    const expires = [NOW + 86_400, NOW + 2 * 86_400];
    expect(tankTitle(tank({ admiral: true, status: "доступна", refillAt: NOW + 3600, burst: { percent: 37.4, resetsAt }, resets: { count: 2, expires } }), NOW)).toBe(
      [
        "main · Codex",
        ADMIRAL_NOTE,
        "Неделя: осталось 41%",
        "Состояние: доступна",
        `Сброс недели: ${when(NOW + 3600)}`,
        `5 часов: занято 37%, сброс ${formatClock(resetsAt, NOW)}`,
        `Бесплатных сбросов: 2 · сгорают ${expires.map((time) => formatClock(time, NOW)).join(", ")}`,
      ].join("\n"),
    );
    expect(tankTitle(tank({ executor: "claude", fuel: null, bad: true, refillAt: NOW + 600 }), NOW)).toBe(
      ["main · Claude", "Неделя: нет данных", `Снова доступен: ${when(NOW + 600)}`].join("\n"),
    );
  });
});

describe("a machine's row", () => {
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

  it("tells the CPU and the memory free of a live machine", () => {
    const row = machineRow(machine({ role: "сборка" }), NOW);
    expect(row).toMatchObject({ id: "m1", name: "gpu-box", line: "CPU 13 % · память 24 ГБ из 64", level: "ok", dim: false });
    expect(row.title.split("\n").slice(0, 2)).toEqual(["gpu-box · сборка", "свободна"]);
    expect(machineRow(machine({ status: "busy", reasons: ["cpu"] }), NOW)).toMatchObject({ level: "warn" });
  });

  it("says «нет связи» and «нет данных» in the strip's words, with the age of the data in the title", () => {
    const offline = machineRow(machine({ status: "offline", sampled_at: NOW - 600 }), NOW);
    expect(offline).toMatchObject({ line: "нет связи", level: "muted", dim: true });
    expect(offline.title).toBe(["gpu-box", "нет связи", "данные 10 мин назад"].join("\n"));
    expect(machineRow(machine({ status: "unknown", metrics: null, sampled_at: null }), NOW)).toMatchObject({ line: "нет данных", dim: true });
    // Metrics left over from before say nothing live about a machine whose state is unknown.
    expect(machineRow(machine({ status: "unknown" }), NOW)).toMatchObject({ line: "нет данных", dim: true });
    expect(machineRow(machine({ status: "offline" }), NOW).label).toBe("gpu-box: нет связи. Открыть карточку машины");
  });
});

describe("the reflection's note", () => {
  const marks = (overrides: Partial<ReflectionMarks>): ReflectionMarks => ({
    batch: { name: "b", date: "2026-11-07", through: null, records: 3, repos: {} },
    proposed: [],
    waiting: 0,
    running: false,
    pending: { records: 9, signals: 4, repos: [], items: [] },
    ...overrides,
  });
  const lessons = (count: number) => Array.from({ length: count }, () => ({})) as ReflectionMarks["proposed"];

  it("puts a question first, with the rest in the title", () => {
    expect(reflectionNote(marks({ waiting: 2, running: true, proposed: lessons(3) }))).toMatchObject({
      note: "ждёт ответа 2",
      title: "идёт разбор\nждут ответа 2\nждут решения 3\nс сигналом 4 из 9",
      running: false,
      waiting: true,
    });
  });

  it("then a running reflection, then the lessons that wait for a decision", () => {
    expect(reflectionNote(marks({ running: true, proposed: lessons(3) }))).toMatchObject({ note: "идёт разбор", running: true, waiting: false });
    expect(reflectionNote(marks({ proposed: lessons(3) }))).toMatchObject({
      note: "ждут решения 3",
      title: "разбор 07.11\nждут решения 3\nс сигналом 4 из 9",
      waiting: true,
      label: "Рефлексия: ждут решения 3. Открыть экран рефлексии",
    });
  });

  it("else tells when the last reflection was", () => {
    expect(reflectionNote(marks({}))).toMatchObject({ note: "разбор 07.11", title: "разбор 07.11\nждут решения 0\nс сигналом 4 из 9", waiting: false });
    expect(reflectionNote(marks({ batch: null })).note).toBe("разборов не было");
  });

  it("has nothing to open without data", () => {
    expect(reflectionNote(null)).toMatchObject({ note: "нет данных", label: null });
  });
});
