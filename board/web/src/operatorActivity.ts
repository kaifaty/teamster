export interface OperatorTask {
  task_id: string;
  slug: string;
  title: string;
}

export interface OperatorActivity {
  available: boolean;
  chat?: boolean;
  current: OperatorTask | null;
  history: (OperatorTask & {
    event_id: string;
    turn: number;
    started_at: number;
    source: "mini" | "handoff";
    recommendation: string;
  })[];
}

export type OperatorTarget = ({ kind: "project"; id: string } | { kind: "run"; id: string; created: number })
  & { title: string };

export interface OperatorExchange {
  question: string;
  answer: string;
}

export interface ProjectOperatorMessage {
  id: string;
  at: number;
  question: string;
  reference: string | null;
  answer: string | null;
  status: "pending" | "answered" | "failed";
}

export type OperatorResolutionRule =
  | { card: string; run: string; rule: "verdict" }
  | { card: string; run: string; rule: "negative"; evidence: string; phrase: string }
  | { card: string; revoke: true };

export interface OperatorResolution {
  writable: boolean;
  assignment: { run: string; status: string; evidence: string | null } | null;
  recommendations?: OperatorActivity["history"];
  commands?: {
    id: string;
    actor: string;
    run: string;
    slug: string;
    action: "start" | "say" | "stop";
    at: number;
    executor: string;
    account: string | null;
    model: string | null;
    text: string | null;
  }[];
  chat?: ProjectOperatorMessage[];
  events: {
    seq: number;
    actor: "user" | "operator";
    kind: string;
    at: number;
    detail: {
      reason?: string; archive?: string; sha?: string; files?: number; report?: string;
      operation?: string; id?: string; worktree?: string; phrase?: string; note?: string; run?: string; turn?: number;
      evidence?: string | { slug: string; turn: number; report?: string } | null;
    };
  }[];
}
