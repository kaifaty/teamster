import { ref, shallowRef, watch } from "vue";
import type { ProjectTaskChange, ProjectTasks } from "../../lib/projectTasks";
import type { Board } from "../../store/board";

export function useProjectTasks(board: Board, active: () => boolean) {
  const data = shallowRef<ProjectTasks | null>(null);
  const error = ref("");
  let revision = 0;
  let reading = false;
  let readAgain = false;
  async function refresh() {
    if (!active()) return;
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    const current = revision;
    try {
      const result = await board.source.fetchProjectTasks();
      if (current !== revision) return;
      if (JSON.stringify(result) !== JSON.stringify(data.value)) data.value = result;
      error.value = "";
    } catch (cause) {
      if (current === revision) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      reading = false;
      if (readAgain) {
        readAgain = false;
        void refresh();
      }
    }
  }
  watch(active, (visible, _, onCleanup) => {
    if (!visible) return;
    // Reconnects, managed work changes and edits from other tabs all use the Board socket.
    const unsubscribe = board.subscribe((message) => {
      if (["snapshot", "task", "task_removed", "project_tasks_changed"].includes(message.type)) void refresh();
    });
    void refresh();
    onCleanup(() => {
      ++revision;
      readAgain = false;
      unsubscribe();
    });
  }, { immediate: true });

  async function save(change: ProjectTaskChange) {
    const saved = await board.source.saveProjectTask(change);
    ++revision;
    if (data.value) {
      const tasks = data.value.tasks.slice();
      const index = tasks.findIndex((task) => task.id === saved.id);
      if (index < 0) tasks.push(saved);
      else tasks[index] = saved;
      data.value = { ...data.value, tasks };
    }
    // Attaching a run can absorb its projected task. Fetch the full map after applying the saved card.
    void refresh();
    return saved;
  }
  return { data, error, refresh, save };
}
