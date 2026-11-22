import { projectTaskErrors, type ProjectTask, type ProjectTaskChange, type ProjectTaskDetails, type ProjectTasks } from "../lib/projectTasks";

function sessionFields(slugs: string[]) {
  const session_slugs = Object.fromEntries(slugs.map((slug) =>
    [slug.startsWith("local_") ? slug : `demo-run:${slug}`, slug]));
  return { session_slugs, sessions: Object.keys(session_slugs), source_slug: slugs.find((slug) => !slug.startsWith("local_")) ?? null };
}

export function fixtureProjectTasks(changed?: () => void) {
  const projects: ProjectTasks = {
    writable: true,
    biomes: { "demo-shop": "forest", "demo-vault": "volcanic" },
    tasks: [
      {
        id: "demo-checkout", project: "demo-shop", title: "Обновить оформление заказа", status: "active",
        parent_id: null, depends_on: [], ...sessionFields([]), pull_requests: [],
      },
      {
        id: "demo-cart", project: "demo-shop", title: "Сохранить корзину после входа", status: "blocked",
        parent_id: "demo-checkout", depends_on: ["demo-backup"],
        ...sessionFields(["review-ws-reconnect", "local_3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c"]),
        pull_requests: [{ provider: "github", url: "https://github.com/example/demo-shop/pull/12" }],
      },
      {
        id: "demo-backup", project: "demo-vault", title: "Проверить резервную копию", status: "ready",
        parent_id: null, depends_on: [], ...sessionFields([]),
        pull_requests: [{ provider: "forgejo", url: "https://forgejo.example/demo/vault/pulls/7" }],
      },
    ],
  };
  let next = 1;
  return {
    fetchProjectTasks: async () => structuredClone(projects),
    async fetchProjectTaskDetails(id: string): Promise<ProjectTaskDetails | null> {
      const task = projects.tasks.find((entry) => entry.id === id);
      if (!task) return null;
      return {
        sessions: {},
        pull_requests: Object.fromEntries(task.pull_requests.map((pr) => [
          pr.url, pr.url === "https://github.com/example/demo-shop/pull/12" ? "open"
            : pr.url === "https://forgejo.example/demo/vault/pulls/7" ? "merged" : null,
        ])),
      };
    },
    async saveProjectTask(change: ProjectTaskChange) {
      const id = "id" in change ? change.id : null;
      const refs = new Map(projects.tasks.flatMap((task) => Object.entries(task.session_slugs)));
      const links = change.sessions && sessionFields(change.sessions.map((ref) => refs.get(ref) ?? ref));
      if (links?.sessions.some((ref) => projects.tasks.some((other) => other.id !== id && other.sessions.includes(ref)))) {
        throw new Error(projectTaskErrors["Session already attached to another project task"]);
      }
      let task: ProjectTask;
      if ("id" in change) {
        const saved = projects.tasks.find((item) => item.id === change.id);
        if (!saved) throw new Error(projectTaskErrors["Unknown project task"]);
        task = Object.assign(saved, structuredClone(change), links);
      } else {
        task = { status: "active", parent_id: null, depends_on: [], pull_requests: [],
          ...structuredClone(change), ...(links ?? sessionFields([])), id: `demo-task-${next++}` };
        projects.tasks.push(task);
      }
      changed?.();
      return structuredClone(task);
    },
  };
}
