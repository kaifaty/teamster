/** The duty selection fields added to `accounts.data.duty` by the board server. */
export type DutyMode = "auto" | "pinned" | "off";
export type DutyFamily = "codex" | "claude";
export type DutyDisabled = "old_teamster" | "read_only" | "no_teamster";

export interface DutyData {
  mode: DutyMode;
  account: string | null;
  family: DutyFamily | null;
  since: number | null;
  checked_at: number | null;
  reason: string | null;
  pinned_unavailable: string | null;
  choosable: boolean;
  reason_disabled: DutyDisabled | null;
  last_election: { at: number | null; error: string | null };
}

/** Exactly one target or mode, without additional fields. */
export type DutyBody = { account: string; family: DutyFamily; mode?: never } | { mode: "auto" | "off"; account?: never; family?: never };
