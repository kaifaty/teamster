// The board server's sign-ins and refreshes on the fixture data, so that `dev:fixture` clicks through a subscription's
// screen without a server. A Codex sign-in shows its page and one-time code, then checks and succeeds; a Claude one opens
// its page, asks for the code and, once it is pasted (or after a while, as if the page called back), saves the token,
// checks and succeeds. A finished sign-in brings its subscription back to work in every later accounts message.
import type { AccountBody, ActionBodies, ActionResult, LoginCancelBody, LoginInputBody } from "../lib/actions";
import { parseAccounts } from "../lib/accounts";
import type { Accounts, Login, ServerMessage } from "../types";

export type LoginRoute = "login" | "login/input" | "login/cancel" | "account-refresh" | "account-remove";

export interface FixtureLogins {
  act<R extends LoginRoute>(route: R, body: ActionBodies[R]): ActionResult;
  /** The accounts message as the sign-ins left it: a signed-in subscription works again. */
  patch(message: ServerMessage): ServerMessage;
}

const LIVE = new Set(["starting", "waiting", "saving", "checking"]);

/** `clock`: Unix seconds now; `emit` tells the board about a sign-in's change or refreshed accounts. */
export function fixtureLogins(clock: () => number, emit: (message: ServerMessage) => void, accounts: () => Accounts | null): FixtureLogins {
  const logins = new Map<string, Login>();
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  const signedIn = new Set<string>();
  const removed = new Set<string>();
  let refreshedAt: number | null = null;
  /** Claude subscriptions whose limits a refresh read anew, with when. */
  const probed = new Map<string, number>();
  let counter = 0;

  function update(id: string, change: Partial<Login>) {
    const login = logins.get(id);
    if (!login || !LIVE.has(login.stage)) return;
    const next: Login = { ...login, ...change, output: [...login.output, ...(change.output ?? [])].slice(-40) };
    if (!LIVE.has(next.stage)) next.finished_at = clock();
    logins.set(id, next);
    emit({ type: "login", login: next });
    if (next.stage === "done") {
      signedIn.add(`${next.family}:${next.account}`);
      const current = accounts();
      if (current) emit(patch({ type: "accounts", accounts: { ...current, fetched_at: clock() } }));
    }
  }

  function later(id: string, ms: number, change: () => Partial<Login>) {
    const timer = setTimeout(() => update(id, change()), ms);
    timers.set(id, [...(timers.get(id) ?? []), timer]);
  }

  function clear(id: string) {
    for (const timer of timers.get(id) ?? []) clearTimeout(timer);
    timers.delete(id);
  }

  function finishClaude(id: string, from: number) {
    later(id, from, () => ({ stage: "checking", prompt: false, output: ["✓ Long-lived authentication token created successfully!", "Your OAuth token (valid for 1 year): [token hidden]"] }));
    later(id, from + 2200, () => ({ stage: "saving" }));
    later(id, from + 3800, () => ({ stage: "done", status: "ok", ok: true, message: "" }));
  }

  function signingIn(family: AccountBody["family"], account: string) {
    return [...logins.values()].some((login) => login.family === family && login.account === account && LIVE.has(login.stage));
  }

  function start({ family, account }: AccountBody): ActionResult {
    if (signingIn(family, account)) return { ok: false, error: "Вход уже идёт" };
    const id = `login-${++counter}`;
    const now = clock();
    const login: Login = {
      id, family, account, stage: "starting", started_at: now, finished_at: null, url: null, code: null, code_expires_at: null,
      prompt: false, output: [], status: null, ok: null, message: null, error: null,
    };
    logins.set(id, login);
    emit({ type: "login", login });
    if (family === "codex") {
      later(id, 1200, () => ({
        stage: "waiting",
        url: "https://auth.openai.com/codex/device",
        code: "QF7K-2MZPD",
        code_expires_at: clock() + 900,
        output: [
          "Follow these steps to sign in with ChatGPT using device code authorization:",
          "1. Open this link in your browser and sign in to your account",
          "https://auth.openai.com/codex/device",
          "2. Enter this one-time code (expires in 15 minutes)",
          "QF7K-2MZPD",
        ],
      }));
      later(id, 16000, () => ({ stage: "checking", output: ["Successfully logged in."] }));
      later(id, 18500, () => ({ stage: "done", status: "available", ok: true, message: "" }));
    } else {
      later(id, 900, () => ({
        stage: "waiting",
        url: "https://claude.ai/oauth/authorize?code=true&client_id=fixture",
        output: ["Opening browser to sign in…", "Browser didn't open? Use the url below to sign in", "https://claude.ai/oauth/authorize?code=true&client_id=fixture"],
      }));
      later(id, 3500, () => ({ prompt: true, output: ["Paste code here if prompted >"] }));
      // Without a pasted code the page calls back by itself, as when the browser reaches the sign-in tool.
      timers.get(id)!.push(setTimeout(() => {
        if (logins.get(id)?.stage === "waiting") finishClaude(id, 0);
      }, 40000));
    }
    return { ok: true, output: "", login };
  }

  function input({ id, text }: LoginInputBody): ActionResult {
    const login = logins.get(id);
    if (!login) return { ok: false, error: "Вход не найден" };
    if (login.family !== "claude" || !LIVE.has(login.stage)) return { ok: false, error: "Вход уже закончен" };
    if (!text.trim() || text.length > 512) return { ok: false, error: "Invalid text" };
    update(id, { prompt: false, output: ["Paste code here if prompted > ••••••"] });
    finishClaude(id, 700);
    return { ok: true, output: "" };
  }

  function cancel({ id }: LoginCancelBody): ActionResult {
    const login = logins.get(id);
    if (!login) return { ok: false, error: "Вход не найден" };
    if (!LIVE.has(login.stage)) return { ok: false, error: "Вход уже закончен" };
    clear(id);
    update(id, { stage: "cancelled", prompt: false });
    return { ok: true, output: "" };
  }

  function refresh({ family, account }: AccountBody): ActionResult {
    setTimeout(() => {
      refreshedAt = clock();
      if (family === "claude") probed.set(account, refreshedAt);
      const current = accounts();
      if (current) emit(patch({ type: "accounts", accounts: current }));
    }, 1500);
    return { ok: true, output: "" };
  }

  function remove({ family, account }: AccountBody): ActionResult {
    const current = accounts();
    const rows = (parseAccounts(current?.data, clock()).items ?? []).flatMap((item) =>
      item.kind === "row" && item.row.executor === family ? [item.row] : []);
    if (!current || !rows.some((row) => row.name === account)) return { ok: false, error: "Account not found" };
    if (signingIn(family, account)) return { ok: false, error: "Вход уже идёт" };
    if (rows.length === 1) return { ok: false, error: `Нужна хотя бы одна подписка ${family === "codex" ? "Codex" : "Claude"}.` };
    removed.add(`${family}:${account}`);
    refreshedAt = clock();
    emit(patch({ type: "accounts", accounts: current }));
    return { ok: true, output: "" };
  }

  function patchData(data: unknown): unknown {
    if (typeof data !== "object" || data === null) return data;
    const root = data as Record<string, unknown>;
    const fix = (family: "codex" | "claude") =>
      Array.isArray(root[family])
        ? (root[family] as unknown[]).flatMap((entry) => {
            if (typeof entry !== "object" || entry === null) return [entry];
            const item = { ...(entry as Record<string, unknown>) };
            const key = `${family}:${String(item.name)}`;
            if (removed.has(key)) return [];
            const read = family === "claude" ? probed.get(String(item.name)) : undefined;
            if (read !== undefined) item.updated_at = new Date(read * 1000).toISOString();
            if (!signedIn.has(key)) return [item];
            return [family === "codex"
              ? { ...item, status: "available", plan: item.plan ?? "plus", primary: item.primary ?? { used_percent: 3, resets_at: null, window_minutes: 10080 } }
              : { ...item, token_unavailable: null, needs_login: null, limited_until: null }];
          })
        : root[family];
    return { ...root, codex: fix("codex"), claude: fix("claude") };
  }

  function patch(message: ServerMessage): ServerMessage {
    if (message.type === "accounts") {
      const value = message.accounts;
      return { ...message, accounts: { ...value, fetched_at: Math.max(value.fetched_at ?? 0, refreshedAt ?? 0) || value.fetched_at, data: patchData(value.data) } };
    }
    if (message.type === "snapshot") {
      const value = message.snapshot.accounts;
      return {
        ...message,
        snapshot: {
          ...message.snapshot,
          accounts: { ...value, fetched_at: Math.max(value.fetched_at ?? 0, refreshedAt ?? 0) || value.fetched_at, data: patchData(value.data) },
          logins: [...logins.values()],
        },
      };
    }
    return message;
  }

  return {
    act(route, body) {
      if (route === "login") return start(body as AccountBody);
      if (route === "login/input") return input(body as LoginInputBody);
      if (route === "login/cancel") return cancel(body as LoginCancelBody);
      if (route === "account-remove") return remove(body as AccountBody);
      return refresh(body as AccountBody);
    },
    patch,
  };
}
