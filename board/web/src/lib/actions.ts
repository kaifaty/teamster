// The science station's actions: the board server runs `teamster lesson`, `say` and `reflect` for the station's
// buttons (POST /api/actions/*). Only the station acts; every other screen of the board only reads.

import type { ActionsOff } from "../types";

export type ActionRoute = "lesson" | "say" | "reflect";

export interface LessonBody {
  entry: string;
  status: "accepted" | "declined" | "applied" | "proposed";
  note?: string;
}

export interface SayBody {
  slug: string;
  text: string;
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
}

export type ActionResult = { ok: true; output: string; slug?: string } | { ok: false; error: string };

export type ActionSender = <R extends ActionRoute>(route: R, body: ActionBodies[R]) => Promise<ActionResult>;

/** What the server's own error codes mean; any other error is teamster's text and is shown as it is. */
const CODES: Record<string, string> = {
  read_only: "Доска запущена с --read-only",
  no_teamster: "Команда teamster не найдена",
  forbidden: "Сервер доски отклонил запрос",
  timeout: "teamster не ответил вовремя",
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

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
    return result;
  }
  if (isRecord(data) && typeof data.error === "string" && data.error.trim()) {
    const error = data.error.trim();
    return { ok: false, error: CODES[error] ?? error };
  }
  return { ok: false, error: `Сервер доски ответил ${response.status}${response.statusText ? ` ${response.statusText}` : ""}` };
}

/**
 * Runs a station action and, once it succeeded, asks for the research again: the server shows the change on the
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
