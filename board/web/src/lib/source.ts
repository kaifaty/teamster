import { sendBoardAction, type ActionSender } from "./actions";
import { projectTaskErrors, type ProjectScout, type ProjectTask, type ProjectTaskChange, type ProjectTaskDetails, type ProjectTasks } from "./projectTasks";
import type { ArtIndex, Events, Report, ResearchView, ServerMessage, TaskDetail, TaskFeed, TaskFile } from "../types";
import type { DutyChatView } from "../dutyChatTypes";
import type { OperatorExchange, OperatorResolution, OperatorResolutionRule, OperatorTarget } from "../operatorActivity";
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
  fetchProjectTaskDetails?(id: string): Promise<ProjectTaskDetails | null>;
  fetchScoutHistory?(project: string): Promise<ProjectScout[]>;
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
  fetchOperatorResolution?(card: string): Promise<OperatorResolution | null>;
  setOperatorResolution?(rule: OperatorResolutionRule): Promise<void>;
  askOperator?(question: string, target: OperatorTarget | null, history: OperatorExchange[]): Promise<string>;
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

const operatorErrors: Record<string, string> = {
  invalid_question: "Сократите вопрос и попробуйте ещё раз.",
  operator_busy: "Оператор занят. Попробуйте через минуту.",
  operator_task_unavailable: "У оператора нет доступа к этой задаче.",
  operator_timeout: "Оператор не ответил вовремя. Попробуйте ещё раз.",
  operator_no_answer: "Mini не смог ответить. Попробуйте ещё раз.",
};

async function operatorResponse(request: Promise<Response>, signal: AbortSignal) {
  const response = await request.catch(() => {
    throw new Error(signal.aborted ? operatorErrors.operator_timeout : "Не удалось связаться с оператором.");
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(operatorErrors[data?.error] ?? "Не удалось связаться с оператором.");
  }
  return data;
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
    async fetchProjectTaskDetails(id) {
      const response = await get(`/api/project-tasks/${encodeURIComponent(id)}/details`);
      return response ? response.json() : null;
    },
    async fetchScoutHistory(project) {
      const response = await get(`/api/project-tasks/scout-history?project=${encodeURIComponent(project)}`);
      if (!response) throw new Error("404");
      return (await response.json()).scouts;
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
    async fetchOperatorResolution(card) {
      const response = await get(`/api/project-tasks/${encodeURIComponent(card)}/resolution`);
      return response ? response.json() : null;
    },
    async setOperatorResolution(rule) {
      const response = await sendBoardAction("operator-resolution", rule);
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? "Не удалось обновить полномочия оператора.");
      }
    },
    async askOperator(question, target, history) {
      const context = target && (target.kind === "run"
        ? { kind: target.kind, id: target.id, created: target.created } : { kind: target.kind, id: target.id });
      const signal = AbortSignal.timeout(125_000);
      const request = sendBoardAction("operator-chat", { question, target: context, history },
        (url, init) => fetch(url, { ...init, signal }));
      const { id } = await operatorResponse(request, signal);
      const path = `/api/operator-chat/${encodeURIComponent(id)}`;
      while (!signal.aborted) {
        const { answer } = await operatorResponse(fetch(path, { signal }), signal);
        if (typeof answer === "string") return answer;
        await new Promise(resolve => window.setTimeout(resolve, 1000));
      }
      throw new Error(operatorErrors.operator_timeout);
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
