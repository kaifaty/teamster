import { ref } from "vue";
import type { TaskDetail } from "../types";

export function useTaskDetail(fetchDetail: () => Promise<TaskDetail | null>) {
  const detail = ref<TaskDetail | null>(null);
  const detailError = ref<string | null>(null);
  const detailState = ref<"loading" | "missing" | "settled">("loading");

  let request = 0;
  async function loadDetail() {
    const current = ++request;
    try {
      const result = await fetchDetail();
      if (current !== request) return;
      detailError.value = null;
      if (result) detail.value = result;
      detailState.value = result === null ? "missing" : "settled";
    } catch (error) {
      if (current !== request) return;
      detailError.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (current === request && detailState.value === "loading") detailState.value = "settled";
    }
  }

  function resetDetail() {
    detail.value = null;
    detailState.value = "loading";
  }

  return { detail, detailError, detailState, loadDetail, resetDetail };
}
