import { describe, expect, it } from "vitest";
import type { DutyData } from "../../dutyTypes";
import type { AccountRow } from "../../lib/accounts";
import type { Tank } from "../fleet";
import { choosingOff, confirms, dutyChoices, modeLine, NEEDS_LOGIN_REASON, shownDuty, withShownDuty } from "./dutyPick";

const row = (executor: AccountRow["executor"], name: string, used: number | null, more: Partial<AccountRow> = {}) =>
  ({ executor, name, weeklyPercent: used, status: null, bad: false, pinnable: true, pinReason: null, ...more }) as AccountRow;

const record = (more: Partial<DutyData> = {}): DutyData => ({
  mode: "auto", account: "pool-1", family: "claude", since: 1, checked_at: 1, reason: null, pinned_unavailable: null,
  choosable: true, reason_disabled: null, last_election: { at: 1, error: null }, ...more,
});

const ROWS = [
  row("codex", "personal", 41),
  row("codex", "spare", null, { pinnable: false, pinReason: "needs_login", status: "не вошёл", bad: true }),
  row("claude", "pool-3", 10, { pinnable: false, pinReason: "needs_login", status: "нужен вход", bad: true }),
  row("codex", "team", 100, { status: "исчерпан", bad: true }),
  row("claude", "pool-1", 63),
  row("claude", "pool-2", 33.4),
];

describe("the duty's choice", () => {
  it("lists Claude first, then Codex, those that can be pinned first, in teamster's order otherwise", () => {
    const list = dutyChoices(ROWS, shownDuty(record(), null), true);
    expect(list.map((item) => item.key)).toEqual(["claude:pool-1", "claude:pool-2", "claude:pool-3", "codex:personal", "codex:team", "codex:spare"]);
    expect(list[0]).toMatchObject({ familyLabel: "Claude", left: "осталось 37 % недели", current: true, disabled: false, reason: null });
    expect(list.find((item) => item.account === "spare")).toMatchObject({ left: "неделя: нет данных", state: "не вошёл", disabled: true, reason: NEEDS_LOGIN_REASON });
    // An exhausted account can still be pinned: teamster warns.
    expect(list.find((item) => item.account === "team")).toMatchObject({ left: "осталось 0 % недели", state: "исчерпан", bad: true, disabled: false });
  });

  it("switches every account off while choosing is off, and marks nobody without a duty", () => {
    expect(dutyChoices(ROWS, shownDuty(record(), null), false).every((item) => item.disabled)).toBe(true);
    expect(dutyChoices(ROWS, { mode: "off", account: null, family: null }, true).some((item) => item.current)).toBe(false);
    // A name both families have marks only the duty's family.
    const twins = [row("codex", "same", 0), row("claude", "same", 0)];
    expect(dutyChoices(twins, { mode: "pinned", account: "same", family: "codex" }, true).map((item) => item.current)).toEqual([false, true]);
  });

  it("says under the duty's name how it was chosen, for each mode", () => {
    const line = (duty: DutyData) => modeLine(duty, shownDuty(duty, null));
    expect(line(record())).toEqual({ text: "выбран автоматически", alarm: false });
    expect(line(record({ account: null, family: null }))).toEqual({ text: "выбирается автоматически: подходящей подписки нет", alarm: true });
    expect(line(record({ mode: "pinned" }))).toEqual({ text: "закреплён вручную", alarm: false });
    expect(line(record({ mode: "pinned", pinned_unavailable: "weekly limit exhausted" }))).toEqual({ text: "закреплён вручную, но не работает: weekly limit exhausted", alarm: true });
    expect(line(record({ mode: "off", account: null, family: null }))).toEqual({ text: "дежурный не выбран", alarm: false });
    expect(modeLine(null, null)).toBeNull();
    // A choice on its way speaks for itself, without the old pin's trouble.
    const pinnedBad = record({ mode: "pinned", pinned_unavailable: "exhausted" });
    expect(modeLine(pinnedBad, { mode: "pinned", account: "pool-2", family: "claude" })).toEqual({ text: "закреплён вручную", alarm: false });
    expect(modeLine(record({ mode: "off", account: null, family: null }), { mode: "auto", account: null, family: null })).toEqual({ text: "выбирается автоматически", alarm: false });
  });

  it("says plainly why choosing cannot work", () => {
    expect(choosingOff(record())).toBeNull();
    expect(choosingOff(record({ choosable: false, reason_disabled: "read_only" }))).toBe("Доска запущена с --read-only: выбирать дежурного нельзя");
    expect(choosingOff(record({ choosable: false, reason_disabled: "old_teamster" }))).toBe("teamster старше 1.87.0 и не умеет выбор дежурного: обнови teamster");
    expect(choosingOff(record({ choosable: false, reason_disabled: "no_teamster" }))).toBe("Доска не нашла команду teamster: выбирать дежурного нельзя");
    expect(choosingOff(null)).toBe("Сервер доски не умеет выбирать дежурного: перезапусти доску новой версии");
  });

  it("holds a choice until the record shows it, and shows it on the wing meanwhile", () => {
    const pin = { mode: "pinned" as const, account: "pool-2", family: "claude" as const };
    expect(shownDuty(record(), pin)).toBe(pin);
    expect(confirms(record(), pin)).toBe(false);
    expect(confirms(record({ mode: "pinned", account: "pool-2" }), pin)).toBe(true);
    expect(confirms(record({ account: "pool-9" }), { mode: "auto", account: "pool-1", family: "claude" })).toBe(true);
    const tanks = [
      { key: "claude:pool-1", duty: { reason: "r", since: 1 }, admiral: true },
      { key: "claude:pool-2", duty: null, admiral: false },
    ] as Tank[];
    expect(withShownDuty(tanks, null)).toBe(tanks);
    expect(withShownDuty(tanks, pin).map((tank) => [tank.key, !!tank.duty, tank.admiral])).toEqual([["claude:pool-1", false, false], ["claude:pool-2", true, true]]);
    expect(withShownDuty(tanks, { mode: "off", account: null, family: null }).some((tank) => tank.duty)).toBe(false);
  });
});
