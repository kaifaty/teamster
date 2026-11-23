// The console's duty chat: the conversation of the map's source (createDutyChat), the user's draft, the messages on
// their way, and the running turn's live activity, read from the task feed of slug `duty` while the conversation shows.

import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type { DutyPlanReply } from "../../lib/actions";
import { createDutyChat, type DutyChat, type DutyChatHost } from "../../store/dutyChat";
import type { TaskSummary } from "../../types";
import { createFeed, type TaskFeedHandle } from "../station/feed";
import { activeQuestion, arrived, chatRows, feedTail, lastErrorText, pendingBefore, unavailableText, type PendingMessage } from "./chat";

/** The slug of the duty's conversation, whose feed is the running turn's activity. */
const DUTY_SLUG = "duty";

/** `showing`: whether the conversation is on the screen, so that the running turn's activity is worth reading. */
export function useConsoleChat(
  host: () => DutyChatHost,
  now: () => number,
  tasks: () => readonly Pick<TaskSummary, "slug" | "repo">[],
  showing: () => boolean,
) {
  const chat = shallowRef<DutyChat | null>(null);
  /** The first read of this source answered: a missing view then means a server without the chat. */
  const read = ref(false);
  const pending = ref<PendingMessage[]>([]);
  let keys = 0;

  watch(
    host,
    (next) => {
      chat.value?.stop();
      pending.value = [];
      read.value = false;
      const made = createDutyChat(next);
      chat.value = made;
      void made.refresh().finally(() => {
        if (chat.value === made) read.value = true;
      });
    },
    { immediate: true },
  );

  const view = computed(() => chat.value?.view.value ?? null);
  const readError = computed(() => chat.value?.readError.value ?? null);
  // Once the server's view shows a message, its pending copy goes.
  watch(view, (next) => {
    if (pending.value.some((item) => arrived(next, item))) pending.value = pending.value.filter((item) => !arrived(next, item));
  });

  const draft = ref("");

  const rows = computed(() =>
    chatRows(view.value, pending.value, (slug) => {
      const task = tasks().find((item) => item.slug === slug);
      return task ? { repo: task.repo } : null;
    }, chat.value?.planSend.value),
  );
  const unavailable = computed(() => unavailableText(view.value, { read: read.value, readError: readError.value }));
  const lastError = computed(() => lastErrorText(view.value));
  const busy = computed(() => !!view.value?.busy);
  const runSeconds = computed(() => (view.value?.busy && view.value.turn_started_at !== null ? now() - view.value.turn_started_at : null));

  async function deliver(item: PendingMessage) {
    const target = chat.value;
    if (!target) return;
    const result = await target.send(item.text);
    if (chat.value !== target) return;
    if (!pending.value.some((row) => row.key === item.key)) return;
    const next: PendingMessage = result.ok ? { ...item, state: "sent", error: null } : { ...item, state: "failed", error: result.error };
    pending.value = arrived(view.value, next)
      ? pending.value.filter((row) => row.key !== item.key)
      : pending.value.map((row) => (row.key === item.key ? next : row));
  }

  /** Sends `text`: it shows at once, and stays with its reason and a retry when refused. */
  function send(text: string) {
    const message = text.trim();
    if (!message || !chat.value) return false;
    const before = pendingBefore(view.value, pending.value, message);
    const item: PendingMessage = { key: ++keys, text: message, at: Date.now() / 1000, before, state: "sending", error: null };
    pending.value = [...pending.value, item];
    void deliver(item);
    return true;
  }

  /** The field's draft goes; it empties at once. */
  function sendDraft() {
    if (send(draft.value)) draft.value = "";
  }

  function sendPlan(reply: DutyPlanReply) {
    const current = view.value;
    const active = activeQuestion(current, pending.value);
    if (active && current?.messages.find((message) => message.id === active)?.task_plan?.id === reply.plan_id) {
      void chat.value?.sendPlan(reply);
    }
  }

  function refresh() {
    void chat.value?.refresh();
  }

  function retry(key: number) {
    const item = pending.value.find((row) => row.key === key);
    if (!item) return;
    pending.value = pending.value.filter((row) => row.key !== key);
    send(item.text);
  }

  function dismiss(key: number) {
    pending.value = pending.value.filter((row) => row.key !== key);
  }

  // The running turn's activity, while the conversation shows.
  const feed = shallowRef<TaskFeedHandle | null>(null);
  watch(
    () => (showing() && busy.value ? host().source : null),
    (source) => {
      feed.value?.close();
      feed.value = source ? createFeed((slug, after) => source.fetchFeed(slug, after), DUTY_SLUG, true) : null;
    },
    { immediate: true },
  );
  const activity = computed(() => (feed.value && !feed.value.view.off ? feedTail(feed.value.view.items) : []));

  onBeforeUnmount(() => {
    chat.value?.stop();
    feed.value?.close();
  });

  return { view, readError, draft, rows, unavailable, lastError, busy, runSeconds, activity, send, sendDraft, sendPlan, refresh, retry, dismiss };
}

export type ConsoleChat = ReturnType<typeof useConsoleChat>;
