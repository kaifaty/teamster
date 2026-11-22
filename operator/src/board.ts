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
  async function get(path: string, signal = AbortSignal.timeout(60_000)) {
    const route = "/api/external-duty/v1/" + path;
    console.log(JSON.stringify({ type: "board_request", method: "GET", route }));
    const response = await fetch(origin + route, {
      method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal,
    });
    const body = await response.text();
    if (body.includes(token)) throw new Error("Board returned its credential in response data");
    if (!response.ok) {
      if (response.status === 400 && JSON.parse(body).error?.code === "invalid_cursor") {
        throw new InvalidCursor("Board no longer has the saved cursor");
      }
      throw new Error(`Board GET returned HTTP ${response.status}`);
    }
    return JSON.parse(body);
  }

  return {
    async events(after: number): Promise<{ events: WorkEvent[]; next_cursor: number }> {
      const page = await get(`events?after=${after}`);
      if (!Array.isArray(page.events) || !Number.isSafeInteger(page.next_cursor) || page.next_cursor < after) {
        throw new Error("Invalid Board event page");
      }
      return page;
    },
    async list(signal?: AbortSignal): Promise<Card[]> {
      const { tasks } = await get("tasks", signal);
      if (!Array.isArray(tasks)) throw new Error("Invalid Board task list");
      return tasks;
    },
    async task(id: string, signal: AbortSignal): Promise<Card> {
      if (!id || id === "." || id === "..") throw new Error("Expected a task ID");
      const { task } = await get("tasks/" + encodeURIComponent(id), signal);
      if (task?.id !== id) throw new Error("Board returned a different task ID");
      return task;
    },
  };
}

export type Board = ReturnType<typeof connectBoard>;
