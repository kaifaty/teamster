// The duty chat's data: the conversation the server reads from teamster's duty task, read again whenever the server
// says it changed, and the user's messages to the duty. No view of its own: the map's console shows it.

import { ref, shallowRef } from "vue";
import type { DutyChatView } from "../dutyChatTypes";
import { requestAction, type ActionResult } from "../lib/actions";
import type { BoardSource } from "../lib/source";
import type { ServerMessage } from "../types";

/** The longest message the server takes, in characters once trimmed. */
export const DUTY_CHAT_TEXT_LIMIT = 8000;

/** What the duty chat needs of the board: its source and its server messages. */
export interface DutyChatHost {
  source: BoardSource;
  subscribe(listener: (message: ServerMessage) => void): () => void;
}

/** Why a text cannot go to the duty, or null; the server counts characters as code points. */
export function dutyChatTextError(text: string): string | null {
  const length = [...text.trim()].length;
  if (length === 0) return "Пустое сообщение";
  if (length > DUTY_CHAT_TEXT_LIMIT) return `Сообщение длиннее ${DUTY_CHAT_TEXT_LIMIT} символов`;
  return null;
}

/**
 * Holds the conversation (`view`, null until read and from a server without the duty chat), reads it again on every
 * `duty_chat` message and after a reconnect's snapshot, and sends the user's messages with `send`. `stop` ends the
 * subscription.
 */
export function createDutyChat(host: DutyChatHost) {
  const view = shallowRef<DutyChatView | null>(null);
  /** Why the last read failed; null once a read succeeds. */
  const readError = ref<string | null>(null);
  /** Whether a message is on its way to the server. */
  const sending = ref(false);
  let reads = 0;
  let sends = 0;

  async function refresh() {
    const source = host.source;
    if (!source.fetchDutyChat) return;
    const read = ++reads;
    try {
      const next = await source.fetchDutyChat();
      // An older read that answers late must not replace a newer one.
      if (read !== reads) return;
      readError.value = null;
      if (JSON.stringify(next) !== JSON.stringify(view.value)) view.value = next;
    } catch (error) {
      if (read === reads) readError.value = error instanceof Error ? error.message : String(error);
    }
  }

  const stop = host.subscribe((message) => {
    if (message.type === "duty_chat" || message.type === "snapshot") void refresh();
  });

  /**
   * Sends `text` to the duty. The answer comes as soon as the server accepted it (`queued`: it waits for the running
   * turn); the duty's reply arrives later in `view`, and so does a refusal that came late (`view.last_error`).
   */
  async function send(text: string): Promise<ActionResult> {
    const invalid = dutyChatTextError(text);
    if (invalid) return { ok: false, error: invalid };
    sends += 1;
    sending.value = true;
    try {
      const result = await (host.source.act ?? requestAction)("duty-chat", { text: text.trim() });
      if (result.ok) await refresh();
      return result;
    } finally {
      sends -= 1;
      sending.value = sends > 0;
    }
  }

  return { view, readError, sending, refresh, send, stop };
}

export type DutyChat = ReturnType<typeof createDutyChat>;
