// The board's actions: the board server runs `teamster lesson`, `say`, `reflect`, `verdict`, `review`, `stop` and
// `clean`, and starts a lesson's implementation (POST /api/actions/*), for the science station's buttons and the orders
// on a ship's bridge. The board tab's task card only copies commands.

import type { ActionsOff, Launch } from "../types";
import type { Verdict } from "./commands";

export type ActionRoute = "lesson" | "say" | "reflect" | "implement" | "verdict" | "review" | "stop" | "clean";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = (typeof EFFORTS)[number];
export const REVIEWERS = ["codex", "claude"] as const;
export type Reviewer = (typeof REVIEWERS)[number];
export const ANGLES = ["correctness", "concurrency", "security", "tests"] as const;
export type Angle = (typeof ANGLES)[number];
/** `auto`, or 1–4 distinct presets. */
export type ReviewAngles = "auto" | Angle[];

export interface LessonBody {
  entry: string;
  status: "accepted" | "declined" | "applied" | "proposed";
  note?: string;
}

/** Starts a task that makes the lesson's change: `repo` is a path from the research's `repos`. */
export interface ImplementBody {
  entry: string;
  repo: string;
  note?: string;
}

/** A ship's refit with the next order; each option replaces the saved one, in the contract's bounds. */
export interface SayOptions {
  /** `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` */
  model?: string;
  effort?: Effort;
  /** An integer, 5–600. */
  max_minutes?: number;
  /** 0.5–100. */
  max_weekly?: number;
  /** An integer, 0–5. */
  fix_rounds?: number;
  /** An integer, 0–5. */
  ci_rounds?: number;
  reviewer?: Reviewer;
  review_angles?: ReviewAngles;
}

export interface SayBody {
  slug: string;
  text: string;
  options?: SayOptions;
}

export interface VerdictBody {
  slug: string;
  verdict: Verdict;
  /** ≤ 200 characters. */
  note?: string;
}

export interface ReviewBody {
  slug: string;
  review_angles?: ReviewAngles;
  reviewer?: Reviewer;
  effort?: Effort;
}

export interface StopBody {
  slug: string;
}

/** The branch stays unless `keep_branch` is false. */
export interface CleanBody {
  slug: string;
  keep_branch?: boolean;
}

/** `tasks` does not go with `since` or `repos`. */
export interface ReflectBody {
  order?: string;
  tasks?: string[];
  since?: string;
  repos?: string[];
}

export interface ActionBodies {
  lesson: LessonBody;
  say: SayBody;
  reflect: ReflectBody;
  implement: ImplementBody;
  verdict: VerdictBody;
  review: ReviewBody;
  stop: StopBody;
  clean: CleanBody;
}

/**
 * `launch`: a newer server answers `implement` and `reflect` at once and runs the start in the background, whose steps
 * then come as `launch` messages; an older one answers once the task has started, without it.
 */
export type ActionResult = { ok: true; output: string; slug?: string; launch?: Launch } | { ok: false; error: string };

export type ActionSender = <R extends ActionRoute>(route: R, body: ActionBodies[R]) => Promise<ActionResult>;

/** What the server's own error codes mean; any other error is teamster's text and is shown as it is. */
const CODES: Record<string, string> = {
  read_only: "Доска запущена с --read-only",
  no_teamster: "Команда teamster не найдена",
  forbidden: "Сервер доски отклонил запрос",
  timeout: "teamster не ответил вовремя",
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** A start as the contract has it: a slug, a stage and its steps. */
export const isLaunch = (value: unknown): value is Launch =>
  isRecord(value) && typeof value.slug === "string" && !!value.slug && typeof value.stage === "string" && Array.isArray(value.steps);

/** One request to the board server; a refusal, a bad answer or a lost connection all come back as `ok: false`. */
export async function requestAction<R extends ActionRoute>(
  route: R,
  body: ActionBodies[R],
  fetcher: typeof fetch = fetch,
): Promise<ActionResult> {
  let response: Response;
  try {
    response = await fetcher(`/api/actions/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Teamster-Board": "1" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch (error) {
    return { ok: false, error: `Сервер доски недоступен${error instanceof Error && error.message ? `: ${error.message}` : ""}` };
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (response.ok && isRecord(data) && data.ok === true) {
    const result: ActionResult = { ok: true, output: typeof data.output === "string" ? data.output : "" };
    if (typeof data.slug === "string" && data.slug) result.slug = data.slug;
    if (isLaunch(data.launch)) result.launch = data.launch;
    return result;
  }
  if (isRecord(data) && typeof data.error === "string" && data.error.trim()) {
    const error = data.error.trim();
    return { ok: false, error: CODES[error] ?? error };
  }
  return { ok: false, error: `Сервер доски ответил ${response.status}${response.statusText ? ` ${response.statusText}` : ""}` };
}

/**
 * Runs an action and, once it succeeded, asks for the research or the task again: the server shows the change on the
 * next GET. `send` is the fixtures' stand-in in `dev:fixture` mode.
 */
export async function postAction<R extends ActionRoute>(
  route: R,
  body: ActionBodies[R],
  { send = requestAction, refresh }: { send?: ActionSender; refresh?: () => unknown } = {},
): Promise<ActionResult> {
  const result = await send(route, body);
  if (result.ok && refresh) await refresh();
  return result;
}

/** Why the board only reads, in the words of the fallback note; `null`: the server has no actions at all. */
export function readOnlyReason(reason: ActionsOff | null | undefined, known: boolean): string {
  if (!known) return "сервер без действий";
  return reason === "read_only" ? "запущена с --read-only" : reason === "no_teamster" ? "команда teamster не найдена" : "действия выключены";
}
