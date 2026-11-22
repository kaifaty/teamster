import type { ProjectTask, ProjectTaskChange, ProjectTasks } from "../lib/projectTasks";

export function fixtureProjectTasks() {
  const projects: ProjectTasks = {
    writable: true,
    biomes: { "demo-shop": "forest", "demo-vault": "volcanic" },
    tasks: [
      {
        id: "demo-checkout", project: "demo-shop", title: "Обновить оформление заказа", status: "active",
        source_slug: null, parent_id: null, depends_on: [], sessions: [], pull_requests: [],
      },
      {
        id: "demo-cart", project: "demo-shop", title: "Сохранить корзину после входа", status: "ready",
        source_slug: "review-ws-reconnect", parent_id: "demo-checkout", depends_on: ["demo-backup"],
        sessions: ["review-ws-reconnect", "local_3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c"],
        pull_requests: [{ provider: "github", url: "https://github.com/example/demo-shop/pull/12" }],
      },
      {
        id: "demo-backup", project: "demo-vault", title: "Проверить резервную копию", status: "blocked",
        source_slug: null, parent_id: null, depends_on: [], sessions: [],
        pull_requests: [{ provider: "forgejo", url: "https://forgejo.example/demo/vault/pulls/7" }],
      },
    ],
  };
  let next = 1;
  return {
    fetchProjectTasks: async () => structuredClone(projects),
    async saveProjectTask(change: ProjectTaskChange) {
      let task: ProjectTask;
      if ("id" in change) {
        const saved = projects.tasks.find((item) => item.id === change.id);
        if (!saved) throw new Error("Unknown task");
        task = Object.assign(saved, structuredClone(change));
      } else {
        task = { status: "active", source_slug: null, parent_id: null, depends_on: [], sessions: [], pull_requests: [],
          ...structuredClone(change), id: `demo-task-${next++}` };
        projects.tasks.push(task);
      }
      return structuredClone(task);
    },
  };
}
