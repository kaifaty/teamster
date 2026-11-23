// The board's actions: the board server runs `teamster lesson`, `say`, `reflect`, `verdict`, `review`, `stop` and
// `clean`, and starts a lesson's implementation (POST /api/actions/*), for the science station's buttons and the orders
// on a ship's bridge; it signs in to a subscription and refreshes its data, for the subscription's screen; and it sends
// a message to the duty chat (`teamster duty chat`). The board tab's task card only copies commands.

import type { ActionsOff, Launch, Login, TaskSummary } from "../types";
import type { Verdict } from "./commands";
import type { DutyBody } from "../dutyTypes";

export type ActionRoute =
  | "lesson"
  | "say"
  | "reflect"
  | "implement"
  | "verdict"
  | "review"
  | "stop"
  | "clean"
  | "login"
  | "login/input"
  | "login/cancel"
  | "account-add"
  | "opencode-add"
  | "opencode-remove"
  | "account-refresh"
  | "account-remove"
  | "duty-chat"
  | "duty";

export const OPENCODE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = (typeof EFFORTS)[number];
export const REVIEWERS = ["codex", "claude"] as const;
export type Reviewer = (typeof REVIEWERS)[number];
export const ANGLES = ["correctness", "concurrency", "security", "tests", "design"] as const;
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
  executor?: "claude" | "opencode";
  model?: string;
  entry: string;
  repo: string;
  note?: string;
}

/** A ship's refit with the next order; each option replaces the saved one, in the contract's bounds. */
export interface SayOptions {
  /** A provider/model for OpenCode, or an unqualified Codex or Claude model. */
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

/** A subscription: its family and its name in `accounts --json`. */
export interface AccountBody {
  family: "codex" | "claude";
  account: string;
}

/** What the person typed for a Claude sign-in: the code from the sign-in page, 1–512 characters. */
export interface LoginInputBody {
  id: string;
  text: string;
}

export interface LoginCancelBody {
  id: string;
}

/** A message to the duty: 1–8000 characters once trimmed. */
export interface DutyChatBody {
  text: string;
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
  login: AccountBody;
  "login/input": LoginInputBody;
  "login/cancel": LoginCancelBody;
  "account-add": AccountBody;
  "opencode-add": { provider: string; model: string };
  "opencode-remove": { provider: string };
  "account-refresh": AccountBody;
  "account-remove": AccountBody;
  "duty-chat": DutyChatBody;
  duty: DutyBody;
}

/**
 * `launch`: a newer server answers `implement` and `reflect` at once and runs the start in the background, whose steps
 * then come as `launch` messages; an older one answers once the task has started, without it. `task`: a verdict's answer
 * carries the task with the verdict recorded. `queued`: a message to the duty waits for the end of the running turn.
 */
export type ActionResult =
  | { ok: true; output: string; slug?: string; launch?: Launch; login?: Login; task?: TaskSummary; queued?: boolean; warning?: string | null }
  | { ok: false; error: string };

export type ActionSender = <R extends ActionRoute>(route: R, body: ActionBodies[R]) => Promise<ActionResult>;

/** Known refusals in the board's language; other errors keep teamster's text. */
const CODES: Record<string, string> = {
  read_only: "Доска запущена с --read-only",
  no_teamster: "Команда teamster не найдена",
  forbidden: "Сервер доски отклонил запрос",
  timeout: "teamster не ответил вовремя",
  old_teamster: "Установленный teamster не знает duty chat: обнови его",
  account_login_in_progress: "Сначала заверши или отмени вход в подписку",
  account_refresh_in_progress: "Дождись обновления данных подписки",
  account_removal_in_progress: "Подписка уже удаляется",
  "Account already exists": "Подписка с таким именем уже есть на карте",
  "Account list unavailable": "Доска не смогла прочитать список подписок",
  "Harness unavailable": "Этот харнес недоступен на машине доски",
  opencode_unavailable: "На машине доски не найден OpenCode",
  opencode_error: "Не удалось прочитать список провайдеров и моделей OpenCode",
  opencode_bindings_unavailable: "Не удалось обновить привязки OpenCode. Проверь формат и права доступа к board-opencode.json.",
  opencode_model_unavailable: "Модель больше не доступна у этого провайдера. Обновите список.",
  "teamster: Cannot remove the last Codex account": "В настройках Teamster должна остаться хотя бы одна подписка Codex",
  "teamster: Cannot remove the last Claude account; switch reviewer to codex": "В настройках Teamster должна остаться хотя бы одна подписка Claude",
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** A start as the contract has it: a slug, a stage and its steps. */
export const isLaunch = (value: unknown): value is Launch =>
  isRecord(value) && typeof value.slug === "string" && !!value.slug && typeof value.stage === "string" && Array.isArray(value.steps);

/** A task summary, as far as the board can tell: a slug, a column and its time. */
const isTask = (value: unknown): value is TaskSummary =>
  isRecord(value) && typeof value.slug === "string" && !!value.slug && typeof value.column === "string" && typeof value.updated_at === "number";

/** A sign-in as the contract has it: an id, a family, an account and a stage. */
export const isLogin = (value: unknown): value is Login =>
  isRecord(value) &&
  typeof value.id === "string" &&
  !!value.id &&
  (value.family === "codex" || value.family === "claude") &&
  typeof value.account === "string" &&
  typeof value.stage === "string" &&
  Array.isArray(value.output);

/** All Board actions use same-origin JSON and the Board request header. */
export function sendBoardAction(route: ActionRoute | "project-task" | "operator-chat", body: unknown, fetcher: typeof fetch = fetch): Promise<Response> {
  return fetcher(`/api/actions/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Teamster-Board": "1" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
}

/** One request to the board server; a refusal, a bad answer or a lost connection all come back as `ok: false`. */
export async function requestAction<R extends ActionRoute>(
  route: R,
  body: ActionBodies[R],
  fetcher: typeof fetch = fetch,
): Promise<ActionResult> {
  let response: Response;
  try {
    response = await sendBoardAction(route, body, fetcher);
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
    if (isLogin(data.login)) result.login = data.login;
    if (isTask(data.task)) result.task = data.task;
    if (typeof data.queued === "boolean") result.queued = data.queued;
    if (typeof data.warning === "string" || data.warning === null) result.warning = data.warning;
    return result;
  }
  if (isRecord(data) && typeof data.error === "string" && data.error.trim()) {
    const error = data.error.trim();
    if (error === "old_teamster" && route === "duty") return { ok: false, error: "Установленный teamster не знает duty set: обнови его" };
    return { ok: false, error: CODES[error] ?? error };
  }
  return { ok: false, error: `Сервер доски ответил ${response.status}${response.statusText ? ` ${response.statusText}` : ""}` };
}

/** Pins an account, resumes automatic elections or leaves no duty. The accounts stream carries the result. */
export function requestDuty(body: DutyBody, send: ActionSender = requestAction): Promise<ActionResult> {
  return send("duty", body);
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
