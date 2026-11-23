export interface OperatorTask {
  task_id: string;
  slug: string;
  title: string;
}

export interface OperatorActivity {
  available: boolean;
  chat?: { projects: string[] };
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
