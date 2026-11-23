// The duty chat: the conversation with teamster's duty (GET /api/duty-chat, POST /api/actions/duty-chat).

import type { ActionsOff } from "./types";

/** Why a message cannot be sent now; null when it can. */
export type DutyChatReason = "no_duty" | "codex_duty" | "old_teamster" | "read_only" | "no_teamster";

export interface DutyTaskPlan {
  id: string;
  tasks: { repo: string; title: string; goal: string; done_when: string[] }[];
  actionable: boolean;
  accepted_turn?: number;
  error?: string;
}

export interface DutyComparison {
  approaches: [{ title: string; detail: string }, { title: string; detail: string }];
}

/** One message of the conversation. `id` stays the same between reads. */
export interface DutyChatMessage {
  id: string;
  at: number;
  from: "user" | "duty" | "note";
  text: string; // ≤ 8000 chars; the duty's reply
  turn: number | null; // the turn that carried the message, or the turn of the answer
  // The duty's answer only:
  status?: "answered" | "needs_decision" | "started";
  question?: string | null; // the one decision asked of the user
  options?: string[]; // 2–4 short answers to `question`, or none for a free answer
  started?: string[]; // slugs of the tasks the turn started
  account?: string | null; // the Claude account that answered
  task_plan?: DutyTaskPlan;
  comparison?: DutyComparison; // fixture scenario only
}

/** A message accepted while a turn runs, or a task note held by the hourly cap, not delivered yet. */
export interface DutyChatQueued {
  at: number;
  from: "user" | "note";
  text: string;
}

export interface DutyChatView {
  actions: { enabled: boolean; reason: ActionsOff | null };
  available: boolean; // reason === null
  reason: DutyChatReason | null;
  duty: { account: string; family: "codex" | "claude" } | null;
  busy: boolean; // a turn runs; its activity is the task feed of slug `duty`
  turn_started_at: number | null;
  messages: DutyChatMessage[]; // ascending at, the newest 200
  queued: DutyChatQueued[]; // ascending at
  last_error: { at: number; text: string } | null; // a refusal or failure after the send was answered
}
