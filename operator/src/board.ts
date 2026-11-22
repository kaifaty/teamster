interface Turn {
  turn: number;
  status: string;
  outcome: string | null;
  result_status: string | null;
  summary: string | null;
  question?: string | null;
  checks: {
    saved: { command: string; outcome: string; exit: number | null } | null;
    reported: { command: string; outcome: string; details: string }[];
    ci: { outcome: string; failing: string[] } | null;
  };
}

export interface WorkEvent extends Turn {
  id: string;
  type: "task_finished" | "needs_decision";
  task_id: string;
}

export interface Card extends Turn {
  id: string;
  executor: string | null;
  blocker: string | null;
}

export interface TitleCandidate {
  id: string;
  revision: string;
  title: string;
  goal: string;
  summary: string;
}

export class InvalidCursor extends Error {}

export function localUrl(value: string, path: "/" | "/v1"): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== path && url.pathname !== path + "/")) {
    throw new Error(`Expected a loopback HTTP URL with path ${path}`);
  }
  return url.origin + (path === "/" ? "" : path);
}

export function connectBoard(origin: string, token: string) {
  async function request(path: string, signal = AbortSignal.timeout(60_000), change?: {
    revision: string; title: string | null;
  }) {
    const route = "/api/external-duty/v1/" + path;
    const method = change ? "POST" : "GET";
    console.log(JSON.stringify({ type: "board_request", method, route }));
    const response = await fetch(origin + route, {
      method, headers: { Authorization: `Bearer ${token}`, ...(change ? { "Content-Type": "application/json" } : {}) },
      body: change ? JSON.stringify(change) : undefined, redirect: "error", signal,
    });
    const body = await response.text();
    if (body.includes(token)) throw new Error("Board returned its credential in response data");
    if (response.status === 404 && path === "project-titles") return { tasks: [] };
    if (response.status === 409 && change) return { ok: false };
    if (!response.ok) {
      if (response.status === 400 && JSON.parse(body).error?.code === "invalid_cursor") {
        throw new InvalidCursor("Board no longer has the saved cursor");
      }
      throw new Error(`Board ${method} returned HTTP ${response.status}`);
    }
    return JSON.parse(body);
  }

  return {
    async events(after: number): Promise<{ events: WorkEvent[]; next_cursor: number }> {
      const page = await request(`events?after=${after}`);
      if (!Array.isArray(page.events) || !Number.isSafeInteger(page.next_cursor) || page.next_cursor < after) {
        throw new Error("Invalid Board event page");
      }
      return page;
    },
    async list(signal?: AbortSignal): Promise<Card[]> {
      const { tasks } = await request("tasks", signal);
      if (!Array.isArray(tasks)) throw new Error("Invalid Board task list");
      return tasks;
    },
    async task(id: string, signal: AbortSignal): Promise<Card> {
      if (!id || id === "." || id === "..") throw new Error("Expected a task ID");
      const { task } = await request("tasks/" + encodeURIComponent(id), signal);
      if (task?.id !== id) throw new Error("Board returned a different task ID");
      return task;
    },
    async titleCandidates(signal: AbortSignal): Promise<TitleCandidate[]> {
      const { tasks } = await request("project-titles", signal);
      if (!Array.isArray(tasks) || tasks.some(task => !task ||
          !["id", "revision", "title", "goal", "summary"].every(key => typeof task[key] === "string"))) {
        throw new Error("Invalid Board title candidates");
      }
      return tasks;
    },
    async updateTitle(task: TitleCandidate, title: string | null, signal: AbortSignal): Promise<boolean> {
      const result = await request("project-titles/" + encodeURIComponent(task.id), signal, {
        revision: task.revision, title,
      });
      return result.ok === true;
    },
  };
}

export type Board = ReturnType<typeof connectBoard>;
