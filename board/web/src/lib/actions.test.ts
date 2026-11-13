import { describe, expect, it, vi } from "vitest";
import { postAction, requestAction } from "./actions";

const reply = (status: number, body: unknown, statusText = "") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, statusText });

describe("requestAction", () => {
  it("posts the body as JSON with the board's headers to the same origin", async () => {
    const fetcher = vi.fn(async () => reply(200, { ok: true, output: "started", slug: "reflect-1109-041200" }));
    const result = await requestAction("reflect", { order: "Why?", since: "30d" }, fetcher);
    expect(result).toEqual({ ok: true, output: "started", slug: "reflect-1109-041200" });
    // A newer server answers at once with the start it runs in the background; an older one names no launch.
    const launch = { slug: "lesson-u1", kind: "implement", entry: "b.md U1", repo: "teamster", stage: "fetching", steps: [{ stage: "fetching", at: 1 }], error: null, started_at: 1 };
    const quick = await requestAction("implement", { entry: "b.md U1", repo: "/r/teamster" }, async () => reply(200, { ok: true, output: "", slug: "lesson-u1", launch }));
    expect(quick).toEqual({ ok: true, output: "", slug: "lesson-u1", launch });
    const legacy = await requestAction("implement", { entry: "b.md U1", repo: "/r/teamster" }, async () => reply(200, { ok: true, output: "started", slug: "lesson-u1", launch: null }));
    expect(legacy).toEqual({ ok: true, output: "started", slug: "lesson-u1" });
    expect(fetcher).toHaveBeenCalledWith("/api/actions/reflect", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Teamster-Board": "1" },
      body: JSON.stringify({ order: "Why?", since: "30d" }),
      credentials: "same-origin",
    });
  });

  it("turns refusals, bad answers and a lost connection into an error", async () => {
    const send = (response: Response | Error) =>
      requestAction("lesson", { entry: "report.md L1", status: "accepted" }, async () => {
        if (response instanceof Error) throw response;
        return response;
      });
    expect(await send(reply(422, { ok: false, error: "unknown lesson report.md L1" }))).toEqual({ ok: false, error: "unknown lesson report.md L1" });
    expect(await send(reply(403, { ok: false, error: "read_only" }))).toEqual({ ok: false, error: "Доска запущена с --read-only" });
    expect(await send(reply(504, { ok: false, error: "timeout" }))).toEqual({ ok: false, error: "teamster не ответил вовремя" });
    expect(await send(reply(409, { ok: false, error: "study is working" }))).toEqual({ ok: false, error: "study is working" });
    expect(await send(reply(502, "<html>Bad gateway</html>", "Bad Gateway"))).toEqual({ ok: false, error: "Сервер доски ответил 502 Bad Gateway" });
    expect(await send(reply(413, ""))).toEqual({ ok: false, error: "Сервер доски ответил 413" });
    expect(await send(new TypeError("Failed to fetch"))).toEqual({ ok: false, error: "Сервер доски недоступен: Failed to fetch" });
  });
});

describe("postAction", () => {
  it("asks for the research again after a success only", async () => {
    const refresh = vi.fn(async () => {});
    const ok = vi.fn(async () => ({ ok: true as const, output: "done" }));
    expect(await postAction("say", { slug: "study", text: "Go" }, { send: ok, refresh })).toEqual({ ok: true, output: "done" });
    expect(ok).toHaveBeenCalledWith("say", { slug: "study", text: "Go" });
    expect(refresh).toHaveBeenCalledTimes(1);

    const failed = vi.fn(async () => ({ ok: false as const, error: "closed" }));
    expect(await postAction("say", { slug: "study", text: "Go" }, { send: failed, refresh })).toEqual({ ok: false, error: "closed" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
