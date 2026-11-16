// Choosing the duty in the console's left wing: the accounts the panel lists, the quiet line under the duty's name, the
// plain sentences when choosing cannot work, and the choice shown before the server confirms it. Pure functions; the
// wing and its panel only call them.

import type { DutyData, DutyDisabled, DutyFamily, DutyMode } from "../../dutyTypes";
import type { AccountRow } from "../../lib/accounts";
import type { Tank } from "../fleet";

/** Who is on duty and how, as the console shows it: the server's record, or the choice still on its way. */
export interface ShownDuty {
  mode: DutyMode;
  account: string | null;
  family: DutyFamily | null;
}

/** The choice on its way over the server's record; the record alone without one; null from a server without choosing. */
export function shownDuty(duty: DutyData | null, pending: ShownDuty | null): ShownDuty | null {
  if (pending) return pending;
  return duty && { mode: duty.mode, account: duty.account, family: duty.family };
}

/** Whether the server's record already shows the choice, so that it no longer needs holding. */
export function confirms(duty: DutyData | null, pending: ShownDuty): boolean {
  if (!duty || duty.mode !== pending.mode) return false;
  // An automatic election may name anyone; the mode is enough.
  return pending.mode === "auto" || (duty.account === pending.account && duty.family === pending.family);
}

const FAMILY: Record<DutyFamily, string> = { claude: "Claude", codex: "Codex" };

export interface DutyChoice {
  key: string;
  account: string;
  family: DutyFamily;
  familyLabel: string;
  /** «осталось 59 % недели», or «неделя: нет данных». */
  left: string;
  /** The account's state in the subscriptions' words («исчерпан», «нужен вход»), or null when it works. */
  state: string | null;
  bad: boolean;
  /** It is on duty now. */
  current: boolean;
  /** It cannot be pinned: `reason` says why. Every account is off while choosing is off; the panel says why once. */
  disabled: boolean;
  reason: string | null;
}

export const NEEDS_LOGIN_REASON = "нужен вход: войди в подписку на её экране, потом выбирай";

/** The accounts to choose from: Claude first (the duty chat needs one), then Codex; those that can be pinned first. */
export function dutyChoices(rows: readonly AccountRow[], shown: ShownDuty | null, choosable: boolean): DutyChoice[] {
  const order = (row: AccountRow) => (row.executor === "claude" ? 0 : 2) + (row.pinnable ? 0 : 1);
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => order(a.row) - order(b.row) || a.index - b.index)
    .map(({ row }) => ({
      key: `${row.executor}:${row.name}`,
      account: row.name,
      family: row.executor,
      familyLabel: FAMILY[row.executor],
      left: row.weeklyPercent === null ? "неделя: нет данных" : `осталось ${Math.max(0, Math.round(100 - row.weeklyPercent))} % недели`,
      state: row.status,
      bad: row.bad,
      current: !!shown && shown.mode !== "off" && shown.account === row.name && shown.family === row.executor,
      disabled: !choosable || !row.pinnable,
      reason: row.pinnable ? null : NEEDS_LOGIN_REASON,
    }));
}

/** The quiet line under the duty's name: how it was chosen; `alarm` when a pinned duty cannot work now. */
export function modeLine(duty: DutyData | null, shown: ShownDuty | null): { text: string; alarm: boolean } | null {
  if (!shown) return null;
  if (shown.mode === "off") return { text: "дежурный не выбран", alarm: false };
  if (shown.mode === "auto") {
    if (shown.account) return { text: "выбран автоматически", alarm: false };
    // Without an account the server's own automatic record found no candidate; a choice on its way is still electing.
    return duty?.mode === "auto" ? { text: "выбирается автоматически: подходящей подписки нет", alarm: true } : { text: "выбирается автоматически", alarm: false };
  }
  // The record's reason belongs to the record's own pin, not to a choice still on its way.
  const unavailable = duty?.mode === "pinned" && duty.account === shown.account && duty.family === shown.family ? duty.pinned_unavailable : null;
  return unavailable ? { text: `закреплён вручную, но не работает: ${unavailable}`, alarm: true } : { text: "закреплён вручную", alarm: false };
}

/** Why the duty cannot be chosen from the board, or null when it can. */
export function choosingOff(duty: DutyData | null): string | null {
  if (!duty) return "Сервер доски не умеет выбирать дежурного: перезапусти доску новой версии";
  if (duty.choosable) return null;
  const reasons: Record<DutyDisabled, string> = {
    read_only: "Доска запущена с --read-only: выбирать дежурного нельзя",
    no_teamster: "Доска не нашла команду teamster: выбирать дежурного нельзя",
    old_teamster: "teamster старше 1.87.0 и не умеет выбор дежурного: обнови teamster",
  };
  return duty.reason_disabled ? reasons[duty.reason_disabled] : "Выбирать дежурного сейчас нельзя";
}

/** The subscriptions with the shown duty marked, so that the wing shows a choice at once; unchanged without one. */
export function withShownDuty(tanks: readonly Tank[], pending: ShownDuty | null): readonly Tank[] {
  if (!pending) return tanks;
  const key = pending.mode !== "off" && pending.account ? `${pending.family}:${pending.account}` : null;
  return tanks.map((tank) => {
    const on = tank.key === key;
    if (on === !!tank.duty) return tank;
    return { ...tank, admiral: on, duty: on ? { reason: null, since: null } : null };
  });
}
