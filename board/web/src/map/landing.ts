// The board lands a lesson's PR by itself: it waits for the PR, merges it, marks the lesson applied, releases teamster and
// upgrades it — or leaves the merge to the human, or fails. The server words each stage; the station shows its words.

import { prLabel } from "../lib/labels";
import type { Implementation, Landing } from "../types";

export type LandingStage = Landing["stage"];

/** The stages of the board's landing while it still goes: the board waits for the PR, merges it, releases or upgrades. */
const LANDING_GOES: ReadonlySet<LandingStage> = new Set(["waiting", "merging", "releasing", "upgrading"]);

/** The board's landing of the implementation's PR; an older server sends none. */
export const landingOf = (implementation: Implementation | null | undefined): Landing | null => implementation?.landing ?? null;

/** Whether the board lands the implementation's PR itself now, or has landed it: the human has nothing to do. */
export function landingHolds(implementation: Implementation | null | undefined): boolean {
  const stage = landingOf(implementation)?.stage;
  return !!stage && (stage === "landed" || LANDING_GOES.has(stage));
}

/**
 * The board lands the PR itself: the server's `text`, split around «PR #N» when the PR is known so that the label links
 * to it. `tone`: «working» while the landing goes, «done» once landed, «pr» when the human merges, «stopped» when it failed.
 */
export interface LandingLine {
  kind: "landing";
  stage: LandingStage;
  tone: "working" | "done" | "pr" | "stopped";
  text: string;
  pr: string | null;
  label: string | null;
  before: string;
  after: string;
  answer: false;
}

/** The line of the board's landing; a text without the PR's label gets the link after it. */
export function landingLine(landing: Landing): LandingLine {
  const { stage, text, pr } = landing;
  const tone = LANDING_GOES.has(stage) ? "working" : stage === "landed" ? "done" : stage === "manual" ? "pr" : "stopped";
  const base = { kind: "landing", stage, tone, text, pr, answer: false } as const;
  if (!pr) return { ...base, label: null, before: text, after: "" };
  const label = prLabel(pr);
  const at = text.indexOf(label);
  // «PR #1» must not match the start of «PR #12».
  if (at >= 0 && !/\d/.test(text.charAt(at + label.length))) return { ...base, label, before: text.slice(0, at), after: text.slice(at + label.length) };
  return { ...base, label, before: `${text} · `, after: "" };
}
