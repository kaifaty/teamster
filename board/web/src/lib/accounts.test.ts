import { describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import { parseAccounts, parseDuty, type AccountRow } from "./accounts";
import { createDuty } from "../store/duty";
import type { Accounts } from "../types";
import type { BoardSource } from "./source";

const data = (extra: Record<string, unknown> = {}) => ({
  codex: [{ name: "alpha", status: "available" }],
  claude: [{ name: "alpha" }, { name: "beta" }],
  ...extra,
});
const rows = (value: unknown): AccountRow[] =>
  (parseAccounts(value, 0).items ?? []).flatMap((item) => (item.kind === "row" ? [item.row] : []));
const duties = (value: unknown) => rows(value).map((row) => (row.duty ? `${row.executor}:${row.name}` : null)).filter(Boolean);

describe("duty account", () => {
  it("marks no account without a duty", () => {
    expect(duties(data())).toEqual([]);
    expect(duties(data({ duty: null }))).toEqual([]);
    expect(duties(data({ duty: { account: null, family: null, reason: "no account available" } }))).toEqual([]);
  });

  it("marks the account of the duty's family, with its reason and start", () => {
    const parsed = rows(data({ duty: { account: "alpha", family: "claude", since: 1_800_000_000, reason: "most room" } }));
    expect(parsed.filter((row) => row.duty).map((row) => `${row.executor}:${row.name}`)).toEqual(["claude:alpha"]);
    expect(parsed.find((row) => row.duty)?.duty).toEqual({ reason: "most room", since: 1_800_000_000 });
  });

  it("reads the selection mode, disabled reason, last election and each account's pin ability", () => {
    const value = data({
      codex: [{ name: "alpha", pinnable: true, pin_reason: null }, { name: "login", pinnable: false, pin_reason: "needs_login" }],
      duty: { mode: "pinned", account: "alpha", family: "codex", pinned_unavailable: "exhausted", choosable: false, reason_disabled: "old_teamster", last_election: { at: 123, error: "tick refused" } },
    });
    expect(parseDuty(value)).toMatchObject({ mode: "pinned", pinned_unavailable: "exhausted", choosable: false, reason_disabled: "old_teamster", last_election: { at: 123, error: "tick refused" } });
    expect(rows(value).slice(0, 2).map((row) => [row.pinnable, row.pinReason])).toEqual([[true, null], [false, "needs_login"]]);
    expect(parseDuty(data({ duty: null }))).toBeNull();
    expect(parseDuty(data({ duty: { account: "alpha", family: "codex" } }))).toBeNull();
  });

  it("exposes live duty data and sends all three selections without hiding a warning or refusal", async () => {
    const state = shallowRef<{ accounts: Accounts | null }>({ accounts: null });
    const send = vi.fn().mockResolvedValueOnce({ ok: true, output: "", warning: "quota exhausted" })
      .mockResolvedValueOnce({ ok: false, error: "no candidates" }).mockResolvedValueOnce({ ok: true, output: "", warning: null });
    const selection = createDuty({ state, source: { act: send } as unknown as BoardSource });
    expect(selection.mode.value).toBeNull();
    expect(selection.choosable.value).toBe(false);
    state.value = { accounts: { fetched_at: 1, error: null, data: data({ duty: { mode: "auto", choosable: true } }) } };
    expect(selection.mode.value).toBe("auto");
    expect(selection.accounts.value.map((row) => row.name)).toEqual(["alpha", "alpha", "beta"]);
    const choosing = selection.choose("alpha", "claude");
    expect(selection.sending.value).toBe(true);
    expect(await choosing).toEqual({ ok: true, output: "", warning: "quota exhausted" });
    expect(selection.sending.value).toBe(false);
    expect(await selection.setAuto()).toEqual({ ok: false, error: "no candidates" });
    await selection.setOff();
    expect(send.mock.calls).toEqual([["duty", { account: "alpha", family: "claude" }], ["duty", { mode: "auto" }], ["duty", { mode: "off" }]]);
    state.value = { accounts: { fetched_at: 2, error: null, data: data({ duty: { mode: "off", choosable: true } }) } };
    expect(selection.mode.value).toBe("off");
  });
});
