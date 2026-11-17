// Reads `teamster accounts --json` output defensively. Any part that does not have the
// expected shape is shown as compact JSON instead.
import type { DutyData } from "../dutyTypes";

export interface AccountRow {
  key: string;
  executor: "codex" | "claude";
  name: string;
  /** Weekly usage in percent, when the account reports it. */
  weeklyPercent: number | null;
  /** Unix seconds of the weekly reset. */
  weeklyResetsAt: number | null;
  /** Short state such as "исчерпан" or "не вошёл"; null for a healthy account. */
  status: string | null;
  /** The status is a problem (exhausted, logged out, limited). */
  bad: boolean;
  /** Unix seconds until which the account is limited. */
  limitedUntil: number | null;
  /**
   * Set when this is the duty account (`data.duty`): the one kept for the orchestrator, which new tasks skip. The board
   * calls it the admiral's.
   */
  duty: DutyInfo | null;
  /** Free resets of the limits left on a Codex account, and when each expires (Unix seconds); null when unknown. */
  resets: { count: number; expires: number[] } | null;
  /** The short window (five hours) in percent, and its reset; null when the account does not report it. */
  burst: { percent: number; resetsAt: number | null } | null;
  /** Nothing works until someone signs in again: a Codex account logged out, a Claude token missing or refused. */
  needsLogin: boolean;
  /** Whether teamster can pin this account now; the duty's choosable also gates the control. */
  pinnable: boolean;
  pinReason: "needs_login" | null;
  /** Codex: signed in to the same ChatGPT account as another subscription, so tasks skip it until it signs in anew. */
  duplicate: boolean;
  /** Codex: the ChatGPT plan (`pro`, `team`…) and the sign-in's e-mail; null when unknown or for Claude. */
  plan: string | null;
  email: string | null;
  /** Codex: the credit balance, and how much of it tasks may spend above the floor; null when unknown or for Claude. */
  credits: { balance: number | null; spendable: number | null; unlimited: boolean } | null;
  /** Claude: the account's share in the pool (its plan size) and when its limits were last read; null for Codex. */
  weight: number | null;
  updatedAt: number | null;
  /** Claude: the limits are older than the pool allows, and the next task reads them again. */
  stale: boolean;
}

/** What the admiral's account is, for titles: the duty account kept for the orchestrator. */
export const ADMIRAL_NOTE = "Резерв оркестратора: новые задачи эту подписку не берут";

export interface DutyInfo {
  /** Why this account was elected, as `duty tick` wrote it. */
  reason: string | null;
  /** Unix seconds since which the account is on duty. */
  since: number | null;
}

export type AccountItem = { kind: "row"; row: AccountRow } | { kind: "raw"; key: string; json: string };

export interface ParsedAccounts {
  /** Recognised accounts, or null when `data` has an unknown form. */
  items: AccountItem[] | null;
  /** Compact JSON of the whole value when `items` is null. */
  raw: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** ISO string or Unix seconds → Unix seconds. */
export function toSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms / 1000;
  }
  return null;
}

export function compactJson(value: unknown, limit = 400): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const WEEK_MINUTES = 7 * 24 * 60;

/** The weekly window of a Codex account: the longest of `primary` and `secondary`. */
function codexWeekly(entry: Obj): Obj | null {
  const windows = [entry.secondary, entry.primary].filter(isObj);
  if (windows.length === 0) return null;
  const withMinutes = windows.filter((w) => num(w.window_minutes) !== null);
  if (withMinutes.length > 0) {
    const longest = withMinutes.reduce((a, b) => (num(b.window_minutes)! > num(a.window_minutes)! ? b : a));
    return num(longest.window_minutes)! >= WEEK_MINUTES ? longest : null;
  }
  return isObj(entry.secondary) ? entry.secondary : null;
}

/** The short window of a Codex account: one with a length under a week. */
function codexBurst(entry: Obj): Obj | null {
  return [entry.primary, entry.secondary].filter(isObj).find((w) => num(w.window_minutes) !== null && num(w.window_minutes)! < WEEK_MINUTES) ?? null;
}

function burstOf(window: Obj | null): AccountRow["burst"] {
  const percent = window ? num(window.used_percent) : null;
  return percent === null ? null : { percent, resetsAt: toSeconds(window!.resets_at) };
}

/** `reset_credits` of a Codex account: how many free resets are left and when they expire. */
function resetsOf(entry: Obj): AccountRow["resets"] {
  const credits = entry.reset_credits;
  if (!isObj(credits) || num(credits.available_count) === null) return null;
  const expires = Array.isArray(credits.expires_at) ? credits.expires_at.map(toSeconds).filter((at): at is number => at !== null) : [];
  return { count: Math.max(0, Math.round(num(credits.available_count)!)), expires: expires.sort((a, b) => a - b) };
}

/** What a subscription that needs a sign-in shows wherever its state is short: the tank's label, the accounts' panel. */
export const NEEDS_LOGIN = "нужен вход";

const CODEX_STATUS: Record<string, string> = {
  exhausted: "исчерпан",
  not_logged_in: NEEDS_LOGIN,
  duplicate: "дубликат",
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** A number or a numeric string (Codex sends its balance as a string) → a number; anything else → null. */
function amount(value: unknown): number | null {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return num(value);
}

function creditsOf(entry: Obj): AccountRow["credits"] {
  const credits = entry.credits;
  if (!isObj(credits)) return null;
  const balance = amount(credits.balance);
  const spendable = amount(credits.spendable);
  if (balance === null && spendable === null && credits.unlimited !== true) return null;
  return { balance, spendable, unlimited: credits.unlimited === true };
}

/** When an exhausted Codex account comes back: the latest reset of the windows it used up, or null. */
function spentUntil(entry: Obj): number | null {
  const resets = [entry.primary, entry.secondary]
    .filter(isObj)
    .filter((window) => (num(window.used_percent) ?? 0) >= 100)
    .map((window) => toSeconds(window.resets_at))
    .filter((at): at is number => at !== null);
  return resets.length ? Math.max(...resets) : null;
}

function codexRow(entry: Obj, index: number): AccountRow | null {
  if (typeof entry.name !== "string") return null;
  const weekly = codexWeekly(entry);
  const status = typeof entry.status === "string" ? entry.status : null;
  return {
    key: `codex:${entry.name}:${index}`,
    executor: "codex",
    name: entry.name,
    weeklyPercent: weekly ? num(weekly.used_percent) : null,
    weeklyResetsAt: weekly ? toSeconds(weekly.resets_at) : null,
    status: status === null ? "нет данных" : status === "available" ? null : (CODEX_STATUS[status] ?? status),
    bad: status !== null && status !== "available",
    limitedUntil: status === "exhausted" ? spentUntil(entry) : null,
    duty: null,
    resets: resetsOf(entry),
    burst: burstOf(codexBurst(entry)),
    needsLogin: status === "not_logged_in",
    pinnable: entry.pinnable === true,
    pinReason: entry.pin_reason === "needs_login" ? "needs_login" : null,
    duplicate: status === "duplicate",
    plan: text(entry.plan),
    email: text(entry.email),
    credits: creditsOf(entry),
    weight: null,
    updatedAt: null,
    stale: false,
  };
}

function claudeRow(entry: Obj, index: number, now: number): AccountRow | null {
  if (typeof entry.name !== "string") return null;
  const weekly = isObj(entry.seven_day) ? entry.seven_day : null;
  const limitedUntil = toSeconds(entry.limited_until);
  let status: string | null = null;
  let bad = false;
  const needsLogin = entry.token_unavailable === true || entry.needs_login === true;
  if (needsLogin) {
    status = NEEDS_LOGIN;
    bad = true;
  } else if (limitedUntil !== null && limitedUntil > now) {
    status = "лимит";
    bad = true;
  } else if (entry.stale === true) {
    status = "данные устарели";
  }
  return {
    key: `claude:${entry.name}:${index}`,
    executor: "claude",
    name: entry.name,
    weeklyPercent: weekly ? num(weekly.used_percent) : null,
    weeklyResetsAt: weekly ? toSeconds(weekly.resets_at) : null,
    status,
    bad,
    // A sign-in, not a reset, brings back an account that needs one.
    limitedUntil: bad && !needsLogin && limitedUntil !== null && limitedUntil > now ? limitedUntil : null,
    duty: null,
    resets: null,
    burst: burstOf(isObj(entry.five_hour) ? entry.five_hour : null),
    needsLogin,
    pinnable: entry.pinnable === true,
    pinReason: entry.pin_reason === "needs_login" ? "needs_login" : null,
    duplicate: false,
    plan: null,
    email: null,
    credits: null,
    weight: num(entry.weight),
    updatedAt: toSeconds(entry.updated_at),
    stale: entry.stale === true,
  };
}

/** `data.duty`: an object with `account` and `family`, or null or missing when there is no duty. */
function dutyOf(data: Obj): { account: string; family: "codex" | "claude"; info: DutyInfo } | null {
  const duty = data.duty;
  if (!isObj(duty) || typeof duty.account !== "string" || (duty.family !== "codex" && duty.family !== "claude")) return null;
  return {
    account: duty.account,
    family: duty.family,
    info: { reason: typeof duty.reason === "string" && duty.reason ? duty.reason : null, since: toSeconds(duty.since) },
  };
}

/** Null until the server reports duty selection support, including its disabled reason. */
export function parseDuty(data: unknown): DutyData | null {
  const duty = isObj(data) && isObj(data.duty) ? data.duty : null;
  if (!duty || (duty.mode !== "auto" && duty.mode !== "pinned" && duty.mode !== "off")) return null;
  const election = isObj(duty.last_election) ? duty.last_election : {};
  return {
    mode: duty.mode,
    account: text(duty.account),
    family: duty.family === "codex" || duty.family === "claude" ? duty.family : null,
    since: toSeconds(duty.since),
    checked_at: toSeconds(duty.checked_at),
    reason: text(duty.reason),
    pinned_unavailable: text(duty.pinned_unavailable),
    choosable: duty.choosable === true,
    reason_disabled: duty.reason_disabled === "read_only" || duty.reason_disabled === "no_teamster" || duty.reason_disabled === "old_teamster" ? duty.reason_disabled : null,
    last_election: { at: toSeconds(election.at), error: text(election.error) },
  };
}

/** `now` is Unix seconds. */
export function parseAccounts(data: unknown, now: number): ParsedAccounts {
  if (data === null || data === undefined) return { items: [], raw: null };
  if (!isObj(data) || (!Array.isArray(data.codex) && !Array.isArray(data.claude))) {
    return { items: null, raw: compactJson(data) };
  }
  const items: AccountItem[] = [];
  const add = (list: unknown, executor: "codex" | "claude") => {
    if (!Array.isArray(list)) return;
    list.forEach((entry: unknown, index) => {
      const row = isObj(entry)
        ? executor === "codex"
          ? codexRow(entry, index)
          : claudeRow(entry, index, now)
        : null;
      items.push(row ? { kind: "row", row } : { kind: "raw", key: `${executor}:raw:${index}`, json: compactJson(entry, 160) });
    });
  };
  add(data.codex, "codex");
  add(data.claude, "claude");
  const duty = dutyOf(data);
  if (duty) {
    const item = items.find((i) => i.kind === "row" && i.row.executor === duty.family && i.row.name === duty.account);
    if (item?.kind === "row") item.row.duty = duty.info;
  }
  return { items, raw: null };
}
