import { sendBoardAction, type ActionSender } from "./actions";
import { projectTaskErrors, type ProjectTask, type ProjectTaskChange, type ProjectTasks } from "./projectTasks";
import type { ArtIndex, Events, Report, ResearchView, ServerMessage, TaskDetail, TaskFeed, TaskFile } from "../types";
import type { DutyChatView } from "../dutyChatTypes";
import { connectSocket, type ConnectionState } from "./socket";

export interface OpenCodeProviders {
  status: "ok" | "unavailable" | "error";
  providers: { id: string; name: string; models: string[] }[];
}

/** Where the board gets its data: the real server, or the fixtures in `dev:fixture` mode. */
export interface BoardSource {
  /** Shown in the header next to the connection state, e.g. "фикстуры". */
  label: string | null;
  connect(onMessage: (message: ServerMessage) => void, onState: (state: ConnectionState, retryInMs: number | null) => void): () => void;
  fetchProjectTasks(): Promise<ProjectTasks>;
  saveProjectTask(change: ProjectTaskChange): Promise<ProjectTask>;
  /** null for an unknown task (404). */
  fetchDetail(slug: string): Promise<TaskDetail | null>;
  /** A new ACP conversation for this task. Fixture sources have no local agent. */
  openTaskChat?(slug: string, binding?: { provider: string; model: string }): WebSocket;
  /** null when the file does not exist (404). */
  fetchFile(slug: string, name: TaskFile): Promise<string | null>;
  /**
   * The agent's work by time, only what is new after `after` when given; null for an unknown, archived task, a session,
   * and an older server without the route (404).
   */
  fetchFeed(slug: string, after: string | null): Promise<TaskFeed | null>;
  /** Which repositories have their own map art. */
  fetchArt(): Promise<ArtIndex>;
  /** What the reflection learned; null when the server has no such route yet (404). */
  fetchResearch(): Promise<ResearchView | null>;
  /** The conversation with the duty; null when the server has no such route yet (404). Absent from sources without it. */
  fetchDutyChat?(): Promise<DutyChatView | null>;
  fetchOpenCodeProviders?(): Promise<OpenCodeProviders>;
  /** Completed phases and verdicts between two Unix times, both inclusive. */
  fetchEvents(since: number, until: number): Promise<Events>;
  /** `teamster report` from the local date `since` (YYYY-MM-DD), grouped by `by` (e.g. "executor"). */
  fetchReport(since: string, by: string): Promise<Report>;
  /** Runs a science station action; without it the action goes to the board server (POST /api/actions/*). */
  act?: ActionSender;
}

async function get(path: string): Promise<Response | null> {
  const response = await fetch(path, { headers: { Accept: "application/json, text/plain" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  return response;
}

export function serverSource(): BoardSource {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return {
    label: null,
    connect: (onMessage, onState) => connectSocket({ url: `${scheme}://${location.host}/ws`, onMessage, onState }),
    async fetchProjectTasks() {
      const response = await get("/api/project-tasks");
      if (!response) throw new Error("404");
      return response.json();
    },
    async saveProjectTask(change) {
      const response = await sendBoardAction("project-task", change);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.task?.id) {
        const reason = data?.error ?? data?.detail ?? `HTTP ${response.status}`;
        throw new Error(projectTaskErrors[reason] ?? reason);
      }
      return data.task;
    },
    openTaskChat(slug, binding) {
      const url = new URL(`${scheme}://${location.host}/ws/tasks/${encodeURIComponent(slug)}/chat`);
      if (binding) {
        url.searchParams.set("provider", binding.provider);
        url.searchParams.set("model", binding.model);
      }
      return new WebSocket(url, "teamster-board-chat");
    },
    async fetchDetail(slug) {
      const response = await get(`/api/tasks/${encodeURIComponent(slug)}`);
      return response ? ((await response.json()) as TaskDetail) : null;
    },
    async fetchFile(slug, name) {
      const response = await get(`/api/tasks/${encodeURIComponent(slug)}/files/${name}`);
      return response ? response.text() : null;
    },
    async fetchFeed(slug, after) {
      const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
      const response = await get(`/api/tasks/${encodeURIComponent(slug)}/feed${query}`);
      return response ? ((await response.json()) as TaskFeed) : null;
    },
    async fetchArt() {
      const response = await get("/api/art");
      return response ? ((await response.json()) as ArtIndex) : {};
    },
    async fetchResearch() {
      const response = await get("/api/research");
      return response ? ((await response.json()) as ResearchView) : null;
    },
    async fetchDutyChat() {
      const response = await get("/api/duty-chat");
      return response ? ((await response.json()) as DutyChatView) : null;
    },
    async fetchOpenCodeProviders() {
      const response = await get("/api/opencode/providers");
      if (!response) throw new Error("404");
      return (await response.json()) as OpenCodeProviders;
    },
    async fetchEvents(since, until) {
      const response = await get(`/api/events?since=${Math.floor(since)}&until=${Math.ceil(until)}`);
      if (!response) throw new Error("404");
      return (await response.json()) as Events;
    },
    async fetchReport(since, by) {
      const response = await get(`/api/report?since=${encodeURIComponent(since)}&by=${encodeURIComponent(by)}`);
      if (!response) throw new Error("404");
      return (await response.json()) as Report;
    },
  };
}
