import { describe, expect, it } from "vitest";
import { parseAccounts, type AccountRow } from "../../lib/accounts";
import type { Login, TaskSummary } from "../../types";
import {
  accountsContext,
  cardOf,
  codeLeft,
  findAccount,
  lastLoginOf,
  latestLogin,
  limitsOf,
  loginLine,
  loginLive,
  loginSteps,
  nowOf,
  stateOf,
  tasksOn,
} from "./account";

const NOW = 1_794_700_000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const data = {
  codex: [
    {
      name: "main",
      plan: "pro",
      email: "me@example.com",
      primary: { used_percent: 87, resets_at: iso(NOW + 30 * 3600), window_minutes: 10080 },
      secondary: null,
      credits: { balance: "58851.46", unlimited: false, has_credits: true, spendable: 48851.46 },
      reset_credits: { available_count: 2, expires_at: [iso(NOW + 10 * 86400), iso(NOW + 20 * 86400)] },
      status: "available",
    },
    { name: "spare", plan: null, primary: null, secondary: null, credits: {}, reset_credits: {}, status: "not_logged_in" },
    { name: "twin", plan: "plus", primary: null, secondary: null, credits: {}, reset_credits: {}, status: "duplicate" },
    {
      name: "spent",
      plan: "plus",
      primary: { used_percent: 100, resets_at: iso(NOW + 5 * 3600), window_minutes: 10080 },
      secondary: null,
      credits: {},
      reset_credits: {},
      status: "exhausted",
    },
    { name: "mute", plan: null, primary: null, secondary: null, credits: {}, reset_credits: {}, status: null },
  ],
  claude: [
    {
      name: "pool",
      weight: 5,
      updated_at: iso(NOW - 60),
      stale: false,
      five_hour: { used_percent: 14, resets_at: iso(NOW + 3600) },
      seven_day: { used_percent: 40, resets_at: iso(NOW + 2 * 86400) },
      limited_until: null,
      token_unavailable: null,
      needs_login: null,
    },
    {
      name: "locked",
      weight: 20,
      updated_at: iso(NOW - 86400),
      stale: true,
      five_hour: null,
      seven_day: { used_percent: 60, resets_at: iso(NOW + 3 * 86400) },
      limited_until: iso(NOW + 3 * 86400),
      token_unavailable: null,
      needs_login: true,
    },
  ],
  thresholds: { soft_switch_at: 90, switch_at: 99 },
  credits_floor: 10000,
  credits_floor_until: "2026-12-15",
  duty: { account: "pool", family: "claude", since: NOW - 600, reason: "most room" },
};

const row = (key: string): AccountRow => findAccount(data, key, NOW)!;
const context = accountsContext(data);

const login = (extra: Partial<Login> = {}): Login => ({
  id: "l1", family: "codex", account: "spare", stage: "waiting", started_at: NOW - 30, finished_at: null, url: null, code: null,
  code_expires_at: null, prompt: false, output: [], status: null, ok: null, message: null, error: null, ...extra,
});

describe("a subscription's state", () => {
  it("finds a subscription by its tank's key, and nothing for an unknown one", () => {
    expect(row("codex:main").name).toBe("main");
    expect(row("claude:pool").executor).toBe("claude");
    expect(findAccount(data, "codex:pool", NOW)).toBeNull();
    expect(findAccount(null, "codex:main", NOW)).toBeNull();
  });

  it("says in the pill what matters first: a sign-in going, then one needed, then the limits", () => {
    expect(stateOf(row("codex:spare"), login())).toEqual({ text: "идёт вход", tone: "wait" });
    expect(stateOf(row("codex:spare"), login({ stage: "failed" }))).toEqual({ text: "нужен вход", tone: "bad" });
    expect(stateOf(row("codex:twin"), null).text).toBe("нужен вход");
    expect(stateOf(row("claude:locked"), null).text).toBe("нужен вход");
    expect(stateOf(row("codex:spent"), null)).toEqual({ text: "неделя исчерпана", tone: "sleep" });
    expect(stateOf(row("codex:mute"), null)).toEqual({ text: "нет данных", tone: "dim" });
    expect(stateOf(row("codex:main"), null)).toEqual({ text: "мало осталось", tone: "low" });
    expect(stateOf(row("claude:pool"), null)).toEqual({ text: "работает", tone: "ok" });
  });

  it("makes «Войти заново» the main order only when nothing works without a sign-in", () => {
    expect(nowOf(row("codex:spare"), context, NOW)).toMatchObject({ lead: "Нужен вход", relogin: true, tone: "bad" });
    expect(nowOf(row("codex:spare"), context, NOW).details[0]).toContain("ChatGPT");
    expect(nowOf(row("claude:locked"), context, NOW).details[0]).toContain("связке ключей");
    expect(nowOf(row("codex:twin"), context, NOW)).toMatchObject({ lead: "Вошла в чужой аккаунт ChatGPT", relogin: true });
    for (const key of ["codex:main", "codex:spent", "codex:mute", "claude:pool"]) expect(nowOf(row(key), context, NOW).relogin).toBe(false);
  });

  it("tells how long a spent subscription rests, and what a working one has left", () => {
    expect(nowOf(row("codex:spent"), context, NOW).details[0]).toMatch(/^Задачи её не берут до .+\(через 5 ч\)\.$/);
    const main = nowOf(row("codex:main"), context, NOW);
    expect(main.lead).toBe("Работает: осталось 13% недели");
    expect(main.details).toContain("Осталось мало: с 90% занятой недели задачи берут другую подписку.");
    const pool = nowOf(row("claude:pool"), context, NOW);
    expect(pool.details.at(-1)).toBe("Резерв оркестратора: новые задачи эту подписку не берут: most room.");
  });
});

describe("a subscription's limits and card", () => {
  it("marks where Codex tasks prefer and leave a subscription, and nothing for Claude", () => {
    const [week, burst] = limitsOf(row("codex:main"), context, NOW);
    expect(week).toMatchObject({ id: "week", used: 87, tone: "low" });
    expect(week!.marks.map((mark) => mark.at)).toEqual([90, 99]);
    expect(week!.text).toMatch(/^занято 87% · осталось 13% · сброс /);
    expect(burst).toMatchObject({ id: "burst", used: null, text: "нет данных", tone: "dim" });
    expect(limitsOf(row("claude:pool"), context, NOW)[0]!.marks).toEqual([]);
    expect(limitsOf(row("claude:pool"), context, NOW)[1]).toMatchObject({ used: 14, tone: "ok" });
    const same = accountsContext({ ...data, thresholds: { soft_switch_at: 99, switch_at: 99 } });
    expect(limitsOf(row("codex:main"), same, NOW)[0]!.marks.map((mark) => mark.at)).toEqual([99]);
  });

  it("shows Codex plan, account, credits above the floor and free resets", () => {
    const card = Object.fromEntries(cardOf(row("codex:main"), context, null, NOW - 5, NOW).map((entry) => [entry.label, entry.value]));
    expect(card["Тариф"]).toBe("Pro");
    expect(card["Аккаунт"]).toBe("me@example.com");
    expect(card["Кредиты"]).toMatch(/^58\s851 \(задачам доступно 48\s851; 10\s000 в запасе до 15 дек\.\)$/);
    expect(card["Бесплатные сбросы"]).toMatch(/^2 · сгорают /);
    expect(card["Данные доски"]).toBe("5 с назад");
  });

  it("shows a Claude subscription's share of the pool, its limits' age, its reserve and its last sign-in", () => {
    const card = cardOf(row("claude:pool"), context, { family: "claude", account: "pool", at: NOW - 3600, status: "ok" }, null, NOW);
    const values = Object.fromEntries(card.map((entry) => [entry.label, entry.value]));
    expect(values["Доля в пуле"]).toBe("вес 5 из 25 (20% задач)");
    expect(values["Резерв оркестратора"]).toMatch(/^с /);
    expect(values["Последний вход"]).toMatch(/ — успешно$/);
    expect(card.find((entry) => entry.label === "Лимиты прочитаны")?.tone).toBeUndefined();
    const locked = cardOf(row("claude:locked"), context, { family: "claude", account: "locked", at: NOW - 60, status: "authentication failed" }, null, NOW);
    expect(locked.find((entry) => entry.label === "Лимиты прочитаны")).toMatchObject({ tone: "wait" });
    expect(locked.find((entry) => entry.label === "Последний вход")).toMatchObject({ tone: "bad" });
  });

  it("finds the journal's latest sign-in of the subscription only", () => {
    const list = [
      { family: "codex" as const, account: "main", at: 5, status: "available" },
      { family: "codex" as const, account: "main", at: 9, status: "duplicate" },
      { family: "claude" as const, account: "main", at: 20, status: "ok" },
    ];
    expect(lastLoginOf(list, "codex", "main")?.at).toBe(9);
    expect(lastLoginOf(undefined, "codex", "main")).toBeNull();
  });

  it("lists the open tasks working on the subscription, the latest first", () => {
    const task = (slug: string, extra: Partial<TaskSummary>) => ({ slug, executor: "codex", account: "main", column: "running", updated_at: 1, ...extra }) as TaskSummary;
    const tasks = {
      a: task("a", { updated_at: 5 }),
      b: task("b", { updated_at: 9 }),
      c: task("c", { column: "closed" }),
      d: task("d", { executor: "claude" }),
      e: task("e", { account: "spare" }),
    };
    expect(tasksOn(tasks, "codex", "main").map((entry) => entry.slug)).toEqual(["b", "a"]);
  });
});

describe("a sign-in", () => {
  it("takes the latest sign-in of the subscription", () => {
    const logins = {
      a: login({ id: "a", started_at: 10 }),
      b: login({ id: "b", started_at: 30 }),
      c: login({ id: "c", started_at: 50, account: "main" }),
      d: login({ id: "d", started_at: 60, family: "claude" }),
    };
    expect(latestLogin(logins, "codex", "spare")?.id).toBe("b");
    expect(latestLogin({}, "codex", "spare")).toBeNull();
    expect(loginLive(login())).toBe(true);
    expect(loginLive(login({ stage: "done" }))).toBe(false);
    expect(loginLive(null)).toBe(false);
  });

  it("marks its steps: done up to the current one, and a stopped one at the step it reached", () => {
    const states = (value: Login) => loginSteps(value).map((step) => `${step.id}:${step.state}`);
    expect(states(login({ code: "AB-CD" }))).toEqual(["starting:done", "waiting:current", "checking:todo", "done:todo"]);
    expect(states(login({ stage: "done", status: "available" }))).toEqual(["starting:done", "waiting:done", "checking:done", "done:done"]);
    expect(states(login({ family: "claude", stage: "saving" }))).toEqual(["starting:done", "waiting:done", "saving:current", "checking:todo", "done:todo"]);
    expect(states(login({ stage: "failed" }))).toEqual(["starting:failed", "waiting:todo", "checking:todo", "done:todo"]);
    expect(states(login({ stage: "cancelled", url: "https://x" }))).toEqual(["starting:done", "waiting:failed", "checking:todo", "done:todo"]);
    expect(states(login({ stage: "failed", url: "https://x", status: "duplicate" }))).toEqual(["starting:done", "waiting:done", "checking:failed", "done:todo"]);
  });

  it("says in one line what it does or how it ended", () => {
    expect(loginLine(login({ code: "AB-CD" })).text).toBe("Жду, пока ты введёшь код на странице входа.");
    expect(loginLine(login({ family: "claude", prompt: true })).text).toBe("Страница показала код — вставь его ниже.");
    expect(loginLine(login({ family: "claude" })).text).toBe("Жду подтверждения на странице входа.");
    expect(loginLine(login({ stage: "done", status: "available" }))).toEqual({ text: "Вход выполнен: подписка работает.", tone: "ok" });
    expect(loginLine(login({ stage: "done", status: "exhausted" }))).toEqual({ text: "Вход выполнен: успешно, неделя исчерпана.", tone: "sleep" });
    expect(loginLine(login({ stage: "failed", status: "duplicate" }))).toEqual({ text: "Вход не удался: вошла в чужой аккаунт.", tone: "bad" });
    expect(loginLine(login({ stage: "failed", status: "failed" })).text).toBe("Вход не удался.");
    expect(loginLine(login({ stage: "cancelled" })).text).toBe("Вход отменён.");
  });

  it("counts down the one-time code and says when it ran out", () => {
    expect(codeLeft(login(), NOW)).toBeNull();
    expect(codeLeft(login({ code_expires_at: NOW + 14 * 60 }), NOW)).toEqual({ text: "код действует ещё 14 мин", expired: false });
    expect(codeLeft(login({ code_expires_at: NOW - 1 }), NOW)).toEqual({ text: "срок кода вышел — начни вход заново", expired: true });
  });
});

describe("accounts --json fields the screen reads", () => {
  const rows = parseAccounts(data, NOW).items!.flatMap((item) => (item.kind === "row" ? [item.row] : []));
  const byName = Object.fromEntries(rows.map((entry) => [`${entry.executor}:${entry.name}`, entry]));

  it("marks the subscriptions that need a sign-in, and gives them no reset to wait for", () => {
    expect(byName["codex:spare"]).toMatchObject({ needsLogin: true, status: "нужен вход", bad: true });
    expect(byName["codex:twin"]).toMatchObject({ needsLogin: false, duplicate: true, bad: true });
    expect(byName["claude:locked"]).toMatchObject({ needsLogin: true, status: "нужен вход", limitedUntil: null });
    const token = parseAccounts({ claude: [{ name: "t", token_unavailable: true, limited_until: iso(NOW + 3600) }] }, NOW).items![0];
    expect(token?.kind === "row" && token.row).toMatchObject({ needsLogin: true, status: "нужен вход", limitedUntil: null });
    expect(byName["claude:pool"]).toMatchObject({ needsLogin: false, bad: false });
  });

  it("reads Codex plan, e-mail and credits, and Claude weight and limits' age", () => {
    expect(byName["codex:main"]).toMatchObject({ plan: "pro", email: "me@example.com", credits: { balance: 58851.46, spendable: 48851.46, unlimited: false } });
    expect(byName["codex:spare"]).toMatchObject({ plan: null, email: null, credits: null });
    expect(byName["claude:locked"]).toMatchObject({ weight: 20, stale: true, updatedAt: NOW - 86400, plan: null });
  });
});
