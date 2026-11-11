// A task's file for its card and its ship's screen: loaded on demand, cached until the task changes, markdown rendered
// by markdown-it with html: false, so task text cannot inject markup. The check's log stays plain text.

import { computed, ref, watch, type Ref } from "vue";
import type { BoardSource } from "./source";
import type { TaskFile } from "../types";
import { renderMarkdown } from "./markdown";

export interface TaskFileOptions {
  source: () => BoardSource;
  slug: () => string;
  /** The open file; null shows none. */
  tab: Readonly<Ref<TaskFile | null>>;
  /** The task's version in the cache's key. */
  version: () => number | string;
  /** A change of this reloads the open file. */
  changed: () => unknown;
  /** Loads the file opened at the start, not only on a change. */
  immediate?: boolean;
}

export function useTaskFile({ source, slug, tab, version, changed, immediate = false }: TaskFileOptions) {
  const text = ref<string | null>(null);
  const state = ref<"idle" | "loading" | "missing" | "error">("idle");
  const cache = new Map<string, string | null>();

  let request = 0;
  /** The tab whose text `text` holds, so that another tab never shows it while its own text loads. */
  let textTab: TaskFile | null = null;
  async function load() {
    const name = tab.value;
    const current = ++request;
    if (name !== textTab) {
      textTab = name;
      text.value = null;
    }
    if (!name) {
      text.value = null;
      state.value = "idle";
      return;
    }
    const key = `${slug()}\n${name}\n${version()}`;
    if (cache.has(key)) {
      text.value = cache.get(key)!;
      state.value = text.value === null ? "missing" : "idle";
      return;
    }
    state.value = "loading";
    try {
      const result = await source().fetchFile(slug(), name);
      if (current !== request) return;
      cache.set(key, result);
      text.value = result;
      state.value = result === null ? "missing" : "idle";
    } catch {
      if (current !== request) return;
      state.value = "error";
    }
  }

  const html = computed(() => (text.value !== null && tab.value !== "check" ? renderMarkdown(text.value) : ""));
  watch([tab, changed], () => void load(), { immediate });

  return { text, state, html };
}
