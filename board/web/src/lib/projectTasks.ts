import type { SurfaceTask } from "../map/surface/types";
import { taskTitle } from "./labels";
import type { TaskSummary } from "../types";

export interface ProjectTask extends SurfaceTask {
  sessions: string[];
  session_slugs: Record<string, string>;
  source_slug: string | null;
}

export interface ProjectTasks {
  tasks: ProjectTask[];
  biomes: Record<string, string>;
  writable: boolean;
}

type Fields = Omit<ProjectTask, "id" | "source_slug" | "session_slugs">;
export type ProjectTaskChange = Partial<Fields> & ({ id: string } | { project: string; title: string });

export const statusLabels: Record<ProjectTask["status"], string> = {
  active: "В работе",
  needs_input: "Нужен ответ",
  blocked: "Заблокировано",
  ready: "На приёмке",
  done: "Принято",
  cancelled: "Отменено",
};

export const isCurrent = (task: ProjectTask) => task.status !== "done" && task.status !== "cancelled";

export function recordLabel(record: TaskSummary) {
  return `${record.kind === "session" ? "Сессия" : "Запуск"} · ${taskTitle(record)} · ${record.repo}`;
}

/** Use the Board's current address for each saved reference, including an archived run with a reused name. */
export function sessionNames(tasks: ProjectTask[], records: TaskSummary[]) {
  const references = new Map<string, string>();
  const names = new Map<string, string>();
  for (const task of tasks) {
    for (const [id, slug] of Object.entries(task.session_slugs)) {
      references.set(slug, id);
      // An accessible archive can be outside the Board's recent snapshot.
      names.set(id, slug);
    }
  }
  for (const record of records) {
    if (record.kind === "reflect" || record.kind === "duty") continue;
    const id = references.get(record.slug) ?? record.slug;
    names.set(id, recordLabel(record));
  }
  return names;
}

export const detachedName = (ref: string) => `${ref.split(":")[0]} · нет на доске`;

export const projectTaskErrors: Record<string, string> = {
  read_only: "Доска открыта только для чтения.",
  project_tasks_unavailable: "Хранилище заданий недоступно.",
  "Invalid project name": "Введите название проекта без пути.",
  "Invalid project": "Введите название проекта длиной до 255 символов.",
  "Invalid title": "Введите название задания длиной до 200 символов.",
  "Invalid pull request URL or provider": "Проверьте адрес PR и выбранный сервис.",
  "Cycle in parent_id": "Задание не может быть своим предком.",
  "Cycle in depends_on": "Эта связь образует цикл блокирующих заданий.",
  "Unknown task ID in parent_id": "Родительское задание больше недоступно.",
  "Unknown task ID in depends_on": "Одно из блокирующих заданий больше недоступно.",
  "Unknown project task": "Задание больше недоступно.",
  "Unknown session": "Выбранный запуск или сессия больше недоступны.",
  "Session already attached to another project task": "Запуск или сессия уже связаны с другим заданием.",
};
