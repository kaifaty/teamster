// The board server's sign-ins to subscriptions (POST /api/actions/login) and the journal's `account_login` rows.

/** The latest `account_login` row of the journal for one account. */
export interface LastLogin {
  family: "codex" | "claude";
  account: string;
  at: number;
  status: string; // teamster's outcome: the Codex status, or `ok` or the probe's reason for Claude
}

/** A sign-in's step as the server reports it. */
export type LoginStage = "starting" | "waiting" | "saving" | "checking" | "done" | "failed" | "cancelled";

/**
 * A sign-in the server runs in the background after `POST /api/actions/login`: `teamster login|claude-login <name>
 * --events`. In the snapshot's `logins` while it goes and for 10 minutes after, and a `login` message at each change.
 */
export interface Login {
  id: string;
  family: "codex" | "claude";
  account: string;
  stage: LoginStage;
  started_at: number;
  finished_at: number | null;
  url: string | null; // the sign-in page
  code: string | null; // Codex: the one-time code to enter on that page
  code_expires_at: number | null;
  prompt: boolean; // Claude: the sign-in asks for the code the page shows
  output: string[]; // the sign-in tool's last lines, without the token
  status: string | null; // from teamster's result: `available`, `duplicate`, `ok`, `failed`, a probe's reason…
  ok: boolean | null;
  message: string | null; // teamster's explanation of the result
  error: string | null; // why it failed, when it did
}
