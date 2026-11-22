export interface OperatorTask {
  task_id: string;
  slug: string;
  title: string;
}

export interface OperatorActivity {
  available: boolean;
  current: OperatorTask | null;
  history: (OperatorTask & {
    event_id: string;
    turn: number;
    started_at: number;
    source: "mini" | "handoff";
    recommendation: string;
  })[];
}
