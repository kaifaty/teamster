import type { SurfaceTask } from "../map/surface/types";
import { taskTitle } from "./labels";
import type { TaskSummary } from "../types";

export type ProjectTask = SurfaceTask & { sessions: string[]; source_slug: string | null };

export interface ProjectTasks {
  tasks: ProjectTask[];
  biomes: Record<string, string>;
  writable: boolean;
}

type Fields = Omit<ProjectTask, "id" | "source_slug">;
export type ProjectTaskChange = Partial<Fields> & ({ id: string } | { project: string; title: string });

export const statusLabels: Record<ProjectTask["status"], string> = {
  active: "В работе",
  needs_input: "Нужен ответ",
  blocked: "Заблокировано",
  ready: "На приёмке",
  done: "Принято",
  cancelled: "Отменено",
};

export function recordLabel(record: TaskSummary) {
  return `${record.kind === "session" ? "Сессия" : "Запуск"} · ${taskTitle(record)} · ${record.repo}`;
}

/** The server accepts a Board slug on input and returns a birth-specific ID for managed work. */
export function sessionDirectory(tasks: ProjectTask[], records: TaskSummary[]) {
  const bySlug = new Map(records.map((record) => [record.slug, record]));
  const names = new Map<string, string>();
  const slugs = new Map<string, string>();
  for (const record of records) {
    if (record.kind === "reflect" || record.kind === "duty") continue;
    names.set(record.slug, recordLabel(record));
    slugs.set(record.slug, record.slug);
  }
  for (const task of tasks) {
    for (const ref of task.sessions) {
      if (names.has(ref) || slugs.has(ref)) continue;
      const [name, stamp] = ref.split(":");
      if (!name || !stamp) continue;
      // Match the creation time even when an archived run and a new run share a name.
      // The timestamp in the managed ID is a Python float.hex() Unix time.
      const match = /^0x([01])\.([0-9a-f]+)p([+-]\d+)$/.exec(stamp);
      if (!match) continue;
      const fraction = match[2]!;
      const created = parseInt(match[1] + fraction, 16) * 2 ** (Number(match[3]) - 4 * fraction.length);
      const current = bySlug.get(name);
      const record = current?.created === created ? current : records.find((item) =>
        item.created === created && item.slug.replace(/-\d{8}T\d{6}Z$/, "") === name);
      if (record) {
        names.delete(record.slug);
        names.set(ref, recordLabel(record));
        slugs.set(ref, record.slug);
      }
    }
  }
  return { names, slugs };
}

export const detachedName = (ref: string) => `${ref.split(":")[0]} · нет на доске`;
