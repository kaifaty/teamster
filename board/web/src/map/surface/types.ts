export interface SurfaceTask {
  id: string;
  project: string;
  title: string;
  status: "active" | "needs_input" | "blocked" | "ready" | "done" | "cancelled";
  parent_id: string | null;
  depends_on: string[];
  pull_requests: { provider: "github" | "forgejo"; url: string }[];
}
