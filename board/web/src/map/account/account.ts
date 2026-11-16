// A subscription's own screen, in words: its state, what «Сейчас» says, its limits, its card, its tasks and the
// sign-in the board runs for it. Pure: AccountView and its decks only draw what these return.

import { ADMIRAL_NOTE, parseAccounts, type AccountRow } from "../../lib/accounts";
import { formatAge, formatClock, formatUntil } from "../../lib/format";
import type { LastLogin, Login, LoginStage, TaskSummary } from "../../types";
import { LOW_FUEL } from "../fleet";

export type Family = AccountRow["executor"];

/** The tone of a state pill and a line, in the bridge's colours; `low` is copper: little left, still working. */
export type AccountTone = "ok" | "low" | "wait" | "sleep" | "bad" | "dim";

/** A subscription's key, the same as its tank's on the map. */
export const accountKey = (family: Family, name: string) => `${family}:${name}`;

/** The family's name as people say it. */
export const FAMILY_NAMES: Record<Family, string> = { codex: "Codex", claude: "Claude" };

/** The subscription with key `key` in `accounts --json`, or null once it is gone. */
export function findAccount(data: unknown, key: string, now: number): AccountRow | null {
  for (const item of parseAccounts(data, now).items ?? []) {
    if (item.kind === "row" && accountKey(item.row.executor, item.row.name) === key) return item.row;
  }
  return null;
}

/** What `accounts --json` says for every subscription: the switch thresholds, the credit floor and the pool. */
export interface AccountsContext {
  /** From this share of the week used, tasks prefer another Codex subscription; from `switchAt`, they leave it. */
  softSwitchAt: number | null;
  switchAt: number | null;
  /**
   * The credits a Codex subscription keeps untouched, and until when: the end of that local day, in Unix seconds, as
   * teamster keeps it; null when there is no floor.
   */
  creditsFloor: number | null;
  creditsFloorUntil: number | null;
  /** The Claude pool's weights together. */
  poolWeight: number;
}

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function accountsContext(data: unknown): AccountsContext {
  const root = isObj(data) ? data : {};
  const thresholds = isObj(root.thresholds) ? root.thresholds : {};
  // `credits_floor_until` is a local date, YYYY-MM-DD, kept through the end of that day.
  const date = typeof root.credits_floor_until === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(root.credits_floor_until) : null;
  const until = date ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), 23, 59, 59).getTime() : NaN;
  const pool = Array.isArray(root.claude) ? root.claude : [];
  return {
    softSwitchAt: num(thresholds.soft_switch_at),
    switchAt: num(thresholds.switch_at),
    creditsFloor: num(root.credits_floor) || null,
    creditsFloorUntil: Number.isNaN(until) ? null : until / 1000,
    poolWeight: pool.reduce<number>((sum, entry) => sum + (isObj(entry) ? (num(entry.weight) ?? 1) : 0), 0),
  };
}

/** Week left, in percent; null when the subscription does not report it. */
export const fuelOf = (row: AccountRow) => (row.weeklyPercent === null ? null : Math.max(0, Math.round(100 - row.weeklyPercent)));

/** Nothing works until someone signs in again: logged out, a token missing or refused, or the wrong ChatGPT account. */
export const needsSignIn = (row: AccountRow) => row.needsLogin || row.duplicate;

// The state.

/** A finished sign-in older than this, in seconds, is history: the server forgets it then too. */
export const LOGIN_RETENTION = 600;

/** The sign-in to show: none once it finished more than LOGIN_RETENTION ago. */
export function currentLogin(login: Login | null, now: number): Login | null {
  if (!login || login.finished_at === null) return login;
  return now - login.finished_at > LOGIN_RETENTION ? null : login;
}

/** A sign-in that succeeded after the subscription's data was last read: the data still shows the state before it. */
export function awaitingData(login: Login | null, fetchedAt: number | null): boolean {
  return login?.stage === "done" && login.finished_at !== null && (fetchedAt ?? 0) < login.finished_at;
}

/** «Сейчас» between a sign-in's success and the subscription's fresh data. */
export const SIGNED_IN: NowView = { lead: "Вход выполнен", details: ["Жду новые данные подписки…"], tone: "ok", relogin: false };

/** A sign-in that is still going. */
export const LIVE_STAGES: readonly LoginStage[] = ["starting", "waiting", "saving", "checking"];
export const loginLive = (login: Login | null | undefined): boolean => !!login && LIVE_STAGES.includes(login.stage);

/**
 * Which limit stops a blocked subscription, and until when: the week, the five hours, or a limit teamster names without
 * a window (Codex: the plan's own refusal; Claude: a limit until a time). A Codex window counts as spent from `switchAt`,
 * where teamster takes the subscription off.
 */
export function spentOf(row: AccountRow, context: AccountsContext): { what: "week" | "burst" | "limit"; until: number | null } {
  const limit = context.switchAt ?? 100;
  if (row.executor === "codex") {
    if (row.weeklyPercent !== null && row.weeklyPercent >= limit) return { what: "week", until: row.weeklyResetsAt };
    if (row.burst && row.burst.percent >= limit) return { what: "burst", until: row.burst.resetsAt };
  }
  return { what: "limit", until: row.limitedUntil };
}

const SPENT: Record<ReturnType<typeof spentOf>["what"], { pill: string; lead: string }> = {
  week: { pill: "неделя исчерпана", lead: "Неделя исчерпана" },
  burst: { pill: "5 часов исчерпаны", lead: "Окно 5 часов исчерпано" },
  limit: { pill: "лимит", lead: "Лимит" },
};

/** The pill beside the name. */
export function stateOf(row: AccountRow, login: Login | null, context: AccountsContext): { text: string; tone: AccountTone } {
  if (loginLive(login)) return { text: "идёт вход", tone: "wait" };
  if (needsSignIn(row)) return { text: "нужен вход", tone: "bad" };
  if (row.bad) return { text: SPENT[spentOf(row, context).what].pill, tone: "sleep" };
  const fuel = fuelOf(row);
  if (fuel === null) return { text: "нет данных", tone: "dim" };
  if (fuel <= LOW_FUEL) return { text: "мало осталось", tone: "low" };
  return { text: "работает", tone: "ok" };
}

/** «Сейчас»: the state in one line, then why and what follows; `relogin` makes «Войти заново» the main order. */
export interface NowView {
  lead: string;
  details: string[];
  tone: AccountTone;
  relogin: boolean;
}

const at = (time: number, now: number) => `${formatClock(time, now)} (${formatUntil(time, now)})`;

export function nowOf(row: AccountRow, context: AccountsContext, now: number): NowView {
  const admiral = row.duty ? [`${ADMIRAL_NOTE}${row.duty.reason ? `: ${row.duty.reason}` : ""}.`] : [];
  if (row.duplicate) {
    return {
      lead: "Вошла в чужой аккаунт ChatGPT",
      details: ["Эта подписка вошла в тот же аккаунт ChatGPT, что и другая, поэтому задачи её не берут.", "Войди заново — в аккаунт этой подписки."],
      tone: "bad",
      relogin: true,
    };
  }
  if (row.needsLogin) {
    const what =
      row.executor === "codex"
        ? "Вход в аккаунт ChatGPT закончился, поэтому задачи её не берут."
        : "Токена этой подписки нет в связке ключей или Anthropic его не принимает, поэтому задачи её не берут.";
    return { lead: "Нужен вход", details: [what, "Войди заново — подписка вернётся в работу."], tone: "bad", relogin: true };
  }
  if (row.bad) {
    const spent = spentOf(row, context);
    const until = spent.until;
    return {
      lead: SPENT[spent.what].lead,
      details: [until !== null && until > now ? `Задачи её не берут до ${at(until, now)}.` : "Задачи её не берут до сброса лимита.", ...admiral],
      tone: "sleep",
      relogin: false,
    };
  }
  const fuel = fuelOf(row);
  if (fuel === null) {
    return {
      lead: "Нет данных",
      details: ["teamster не смог прочитать лимиты этой подписки. Обнови данные; если не поможет — войди заново."],
      tone: "dim",
      relogin: false,
    };
  }
  const details: string[] = [];
  if (row.weeklyResetsAt !== null && row.weeklyResetsAt > now) details.push(`Неделя обновится ${at(row.weeklyResetsAt, now)}.`);
  if (fuel <= LOW_FUEL) {
    details.push(
      row.executor === "codex" && context.softSwitchAt !== null
        ? `Осталось мало: с ${context.softSwitchAt}% занятой недели задачи берут другую подписку.`
        : "Осталось мало: скоро задачи перейдут на другую подписку.",
    );
  }
  if (row.stale && row.updatedAt !== null) details.push(`Лимиты прочитаны ${formatAge(row.updatedAt, now)}; следующая задача прочитает их снова.`);
  details.push(...admiral);
  return { lead: `Работает: осталось ${fuel}% недели`, details, tone: fuel <= LOW_FUEL ? "low" : "ok", relogin: false };
}

// Limits.

export interface LimitBar {
  id: "week" | "burst";
  label: string;
  /** Used, 0–100; null when unknown. */
  used: number | null;
  /** In words under the bar: used, left, when it resets. */
  text: string;
  tone: AccountTone;
  /** Lines across the bar: from where tasks prefer another subscription, and where they leave it. */
  marks: { at: number; title: string }[];
}

function usedTone(used: number): AccountTone {
  return used >= 100 - LOW_FUEL / 2 ? "bad" : used >= 100 - LOW_FUEL ? "low" : "ok";
}

export function limitsOf(row: AccountRow, context: AccountsContext, now: number): LimitBar[] {
  const reset = (time: number | null) => (time !== null && time > now ? ` · сброс ${at(time, now)}` : "");
  const week = row.weeklyPercent;
  const marks =
    row.executor === "codex"
      ? [
          ...(context.softSwitchAt !== null && context.softSwitchAt !== context.switchAt
            ? [{ at: context.softSwitchAt, title: `С ${context.softSwitchAt}% задачи предпочитают другую подписку` }]
            : []),
          ...(context.switchAt !== null ? [{ at: context.switchAt, title: `С ${context.switchAt}% задачи переходят на другую подписку` }] : []),
        ]
      : [];
  const burst = row.burst;
  return [
    {
      id: "week",
      label: "Неделя",
      used: week,
      text: week === null ? "нет данных" : `занято ${Math.round(week)}% · осталось ${fuelOf(row)}%${reset(row.weeklyResetsAt)}`,
      tone: week === null ? "dim" : usedTone(week),
      marks,
    },
    {
      id: "burst",
      label: "5 часов",
      used: burst ? burst.percent : null,
      text: burst ? `занято ${Math.round(burst.percent)}%${reset(burst.resetsAt)}` : "нет данных",
      tone: burst ? usedTone(burst.percent) : "dim",
      marks: [],
    },
  ];
}

// The card.

export interface CardRow {
  label: string;
  value: string;
  title?: string;
  tone?: AccountTone;
}

const amount = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const day = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

const PLANS: Record<string, string> = { pro: "Pro", plus: "Plus", team: "Team", business: "Business", enterprise: "Enterprise", free: "Free" };

/** A ChatGPT plan as its own name: "pro" → "Pro". */
export const planName = (plan: string) => PLANS[plan] ?? plan;

/** What a finished sign-in's status says, short; teamster's own word when it is unknown here. */
export function loginStatusText(status: string): { text: string; tone: AccountTone } {
  switch (status) {
    case "available":
    case "ok":
      return { text: "успешно", tone: "ok" };
    case "exhausted":
      return { text: "успешно, неделя исчерпана", tone: "sleep" };
    case "usage limit":
      return { text: "успешно, но у подписки лимит", tone: "sleep" };
    case "duplicate":
      return { text: "вошла в чужой аккаунт", tone: "bad" };
    case "not_logged_in":
      return { text: "вход не сохранился", tone: "bad" };
    case "token unavailable":
      return { text: "токен не сохранился", tone: "bad" };
    case "authentication failed":
      return { text: "Anthropic не принял токен", tone: "bad" };
    case "request failed":
      return { text: "проверочный запрос не прошёл", tone: "bad" };
    case "unknown":
      return { text: "не удалось проверить", tone: "wait" };
    case "failed":
      return { text: "не удался", tone: "bad" };
    default:
      return { text: status, tone: "dim" };
  }
}

export function cardOf(row: AccountRow, context: AccountsContext, last: LastLogin | null, fetchedAt: number | null, now: number): CardRow[] {
  const rows: CardRow[] = [{ label: "Семейство", value: FAMILY_NAMES[row.executor] }];
  if (row.executor === "codex") {
    if (row.plan) rows.push({ label: "Тариф", value: planName(row.plan) });
    if (row.email) rows.push({ label: "Аккаунт", value: row.email });
    const credits = row.credits;
    if (credits?.unlimited) rows.push({ label: "Кредиты", value: "без ограничения" });
    else if (credits && credits.balance !== null) {
      const floor =
        context.creditsFloor !== null && (context.creditsFloorUntil === null || context.creditsFloorUntil > now)
          ? `; ${amount.format(context.creditsFloor)} в запасе${context.creditsFloorUntil !== null ? ` до ${day.format(new Date(context.creditsFloorUntil * 1000))}` : ""}`
          : "";
      const spend = credits.spendable !== null ? ` (задачам доступно ${amount.format(Math.max(0, credits.spendable))}${floor})` : "";
      rows.push({ label: "Кредиты", value: `${amount.format(credits.balance)}${spend}` });
    }
    if (row.resets) {
      const expires = row.resets.expires.map((time) => day.format(new Date(time * 1000)));
      rows.push({
        label: "Бесплатные сбросы",
        value: row.resets.count ? `${row.resets.count}${expires.length ? ` · сгорают ${expires.join(", ")}` : ""}` : "нет",
      });
    }
  } else {
    if (row.weight !== null && context.poolWeight > 0) {
      rows.push({
        label: "Доля в пуле",
        value: `вес ${row.weight} из ${context.poolWeight} (${Math.round((row.weight / context.poolWeight) * 100)}% задач)`,
        title: "Вес — размер тарифа: чем он больше, тем чаще пул Claude даёт задачи этой подписке",
      });
    }
    if (row.updatedAt !== null) {
      rows.push({
        label: "Лимиты прочитаны",
        value: `${formatClock(row.updatedAt, now)}${row.stale ? " · устарели" : ""}`,
        tone: row.stale ? "wait" : undefined,
      });
    }
  }
  if (row.duty) {
    rows.push({
      label: "Резерв оркестратора",
      value: row.duty.since !== null ? `с ${formatClock(row.duty.since, now)}` : "да",
      title: [ADMIRAL_NOTE, row.duty.reason].filter(Boolean).join("\n"),
      tone: "wait",
    });
  }
  if (last) {
    const status = last.status ? loginStatusText(last.status) : null;
    rows.push({
      label: "Последний вход",
      value: status ? `${formatClock(last.at, now)} — ${status.text}` : formatClock(last.at, now),
      tone: !status || status.tone === "ok" ? undefined : status.tone,
    });
  }
  if (fetchedAt !== null) rows.push({ label: "Данные доски", value: formatAge(fetchedAt, now) });
  return rows;
}

/** The journal's latest sign-in of this subscription. */
export function lastLoginOf(list: readonly LastLogin[] | undefined, family: Family, name: string): LastLogin | null {
  let latest: LastLogin | null = null;
  for (const entry of list ?? []) {
    if (entry.family === family && entry.account === name && (!latest || entry.at > latest.at)) latest = entry;
  }
  return latest;
}

// Tasks.

/** The open tasks whose executor works on this subscription now, the latest change first. */
export function tasksOn(tasks: Readonly<Record<string, TaskSummary>>, family: Family, name: string): TaskSummary[] {
  return Object.values(tasks)
    .filter((task) => task.executor === family && task.account === name && task.column !== "closed")
    .sort((a, b) => b.updated_at - a.updated_at);
}

// The sign-in.

/** The latest sign-in to this subscription the server reported, going or finished. */
export function latestLogin(logins: Readonly<Record<string, Login>>, family: Family, name: string): Login | null {
  let latest: Login | null = null;
  for (const login of Object.values(logins)) {
    if (login.family === family && login.account === name && (!latest || login.started_at > latest.started_at)) latest = login;
  }
  return latest;
}

/** The command that does the same sign-in in a terminal. */
export const loginCommand = (family: Family, name: string) => (family === "codex" ? `teamster login ${name}` : `teamster claude-login ${name}`);

export type StepState = "done" | "current" | "todo" | "failed";
export interface LoginStep {
  id: LoginStage;
  label: string;
  state: StepState;
}

const STEPS: Record<Family, { id: LoginStage; label: string }[]> = {
  codex: [
    { id: "starting", label: "Запуск" },
    { id: "waiting", label: "Вход на странице" },
    { id: "checking", label: "Проверка" },
    { id: "done", label: "Готово" },
  ],
  claude: [
    { id: "starting", label: "Запуск" },
    { id: "waiting", label: "Вход на странице" },
    { id: "checking", label: "Проверка" },
    { id: "saving", label: "Токен в связку ключей" },
    { id: "done", label: "Готово" },
  ],
};

/** How far a sign-in got: a failed or cancelled one stops at the step it reached, marked failed. */
export function loginSteps(login: Login): LoginStep[] {
  const steps = STEPS[login.family];
  let reached: LoginStage = login.stage;
  if (login.stage === "failed" || login.stage === "cancelled") {
    reached = login.status !== null && login.status !== "failed" ? "checking" : login.url || login.code || login.prompt ? "waiting" : "starting";
  }
  const index = Math.max(0, steps.findIndex((step) => step.id === reached));
  const stopped = login.stage === "failed" || login.stage === "cancelled";
  return steps.map((step, i) => ({
    ...step,
    state: i < index || login.stage === "done" ? "done" : i === index ? (stopped ? "failed" : "current") : "todo",
  }));
}

/** What the sign-in is doing or how it ended, in one line. */
export function loginLine(login: Login): { text: string; tone: AccountTone } {
  switch (login.stage) {
    case "starting":
      return { text: "Запускаю вход…", tone: "wait" };
    case "waiting":
      if (login.family === "codex") return { text: login.code ? "Жду, пока ты введёшь код на странице входа." : "Жду код от программы входа…", tone: "wait" };
      return { text: login.prompt ? "Страница показала код — вставь его ниже." : "Жду подтверждения на странице входа.", tone: "wait" };
    case "saving":
      return { text: "Сохраняю токен в связке ключей…", tone: "wait" };
    case "checking":
      return { text: "Вход прошёл, проверяю подписку…", tone: "wait" };
    case "done": {
      const status = loginStatusText(login.status ?? "ok");
      return { text: status.tone === "ok" ? "Вход выполнен: подписка работает." : `Вход выполнен: ${status.text}.`, tone: status.tone === "ok" ? "ok" : status.tone };
    }
    case "cancelled":
      return { text: "Вход отменён.", tone: "dim" };
    default: {
      const status = login.status && login.status !== "failed" ? loginStatusText(login.status).text : null;
      return { text: `Вход не удался${status ? `: ${status}` : ""}.`, tone: "bad" };
    }
  }
}

/** How long the one-time code still works, or that it ran out. */
export function codeLeft(login: Login, now: number): { text: string; expired: boolean } | null {
  if (login.code_expires_at === null) return null;
  if (login.code_expires_at <= now) return { text: "срок кода вышел — начни вход заново", expired: true };
  return { text: `код действует ${formatUntil(login.code_expires_at, now).replace("через ", "ещё ")}`, expired: false };
}
