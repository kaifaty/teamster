// The bridge's console: what the comms room and the order desk share — the reply field, the refit that goes with it,
// and each group's request with its outcome. Every order runs at once through the board server; a board that only
// reads copies the equal `teamster` command instead.

import { computed, nextTick, reactive, ref, watch, type Ref } from "vue";
import { readOnlyReason, type ActionSender, type ReviewAngles, type Reviewer } from "../../lib/actions";
import type { Verdict } from "../../lib/commands";
import type { TaskDetail, TaskSummary } from "../../types";
import type { Copied } from "../station/console";
import { blankRefit, deskOf, fallbackCommand, lastLine, reflectOrder, refitOf, type Echo, type RefitDraft, type ShipOrder } from "./orders";

export type GroupId = "reply" | "accept" | "review" | "reflect" | "recall";

/** One group's request in flight and what came of the last one. */
export interface GroupState {
  /** Which button waits for the server. */
  busy: string | null;
  done: string;
  error: string;
  copied: Copied | null;
}

const blank = (): GroupState => ({ busy: null, done: "", error: "", copied: null });

async function clipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface DeskOptions {
  /** The board's name for the task, which every request carries. */
  slug: Readonly<Ref<string>>;
  task: Readonly<Ref<TaskSummary | null>>;
  detail: Readonly<Ref<TaskDetail | null>>;
  /** Runs an order on the board server and loads the task again once it succeeded. */
  act: ActionSender;
  copy?: (text: string) => Promise<boolean>;
}

export function createShipDesk({ slug, task, detail, act, copy = clipboard }: DeskOptions) {
  const actions = computed(() => detail.value?.actions);
  const live = computed(() => actions.value?.enabled === true);
  const offReason = computed(() => readOnlyReason(actions.value?.reason, !!actions.value));
  /** The board's teamster queues a say to a busy ship. */
  const queue = computed(() => actions.value?.queue === true);
  /** The groups the bridge shows for the ship as it is now. */
  const view = computed(() => (task.value ? deskOf(task.value, queue.value) : null));
  /** The orders in the ship's queue: waiting for the end of its cycle, or dropped by it. */
  const queued = computed(() => detail.value?.queue ?? null);

  const reply = ref("");
  const field = ref<HTMLTextAreaElement | null>(null);
  const refit = reactive<RefitDraft>(blankRefit());
  const refitNow = computed(() => (task.value ? refitOf(refit, task.value, detail.value?.limits) : { options: {}, errors: [] }));
  const echo = ref<Echo[]>([]);
  const groups = reactive<Record<GroupId, GroupState>>({ reply: blank(), accept: blank(), review: blank(), reflect: blank(), recall: blank() });

  // Another ship: a clean console.
  watch(slug, () => {
    reply.value = "";
    Object.assign(refit, blankRefit());
    echo.value = [];
    for (const id of Object.keys(groups) as GroupId[]) groups[id] = blank();
  });

  /**
   * Runs the order, or copies its command; `done` words the success. Returns whether the server carried it out. An
   * answer that comes once another ship is open changes nothing: its console was cleaned for that ship.
   */
  async function run(group: GroupId, button: string, order: ShipOrder, done: (output: string, slug?: string) => string = lastLine): Promise<boolean> {
    const state = groups[group];
    if (state.busy) return false;
    const asked = slug.value;
    Object.assign(state, blank(), { busy: button });
    try {
      if (!live.value) {
        const command = fallbackCommand(order);
        const copied = await copy(command);
        if (slug.value === asked) state.copied = { command, copied, reason: offReason.value };
        return false;
      }
      const result = await act(order.route, order.body as never);
      if (slug.value !== asked) return false;
      if (!result.ok) {
        state.error = result.error;
        return false;
      }
      state.done = done(result.output, result.slug) || "Готово";
      return true;
    } finally {
      state.busy = null;
    }
  }

  /** Puts a text into the reply field and the caret at its end. */
  async function fill(text: string) {
    reply.value = text;
    await nextTick();
    const area = field.value;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  async function send() {
    const text = reply.value.trim();
    const state = groups.reply;
    if (!text) {
      Object.assign(state, blank(), { error: "Сначала напиши указание" });
      return;
    }
    const { options, errors } = refitNow.value;
    if (errors.length) {
      Object.assign(state, blank(), { error: `Переоснащение: ${errors.join(" · ")}` });
      return;
    }
    const body = Object.keys(options).length ? { slug: slug.value, text, options } : { slug: slug.value, text };
    const toQueue = view.value?.queue === true;
    if (await run("reply", "send", { route: "say", body }, (output) => lastLine(output) || (toQueue ? "Указание в очереди" : "Указание передано"))) {
      echo.value = [...echo.value, toQueue ? { at: Date.now() / 1000, text, queued: true } : { at: Date.now() / 1000, text }];
      reply.value = "";
      Object.assign(refit, blankRefit());
    }
  }

  const verdict = (value: Verdict, note = "") => {
    const trimmed = note.trim();
    return run("accept", value, { route: "verdict", body: trimmed ? { slug: slug.value, verdict: value, note: trimmed } : { slug: slug.value, verdict: value } });
  };

  function review(angles: ReviewAngles | undefined, reviewer: Reviewer | "") {
    const body = { slug: slug.value, ...(angles !== undefined ? { review_angles: angles } : {}), ...(reviewer ? { reviewer } : {}) };
    return run("review", "review", { route: "review", body });
  }

  const reflect = () => run("reflect", "reflect", reflectOrder(slug.value), (output, made) => (made ? `Разбор запущен: ${made}` : lastLine(output)));
  const stop = () => run("recall", "stop", { route: "stop", body: { slug: slug.value } });
  const clean = (keepBranch: boolean) => run("recall", "clean", { route: "clean", body: { slug: slug.value, keep_branch: keepBranch } });

  return { live, offReason, queue, queued, reply, field, refit, refitNow, echo, groups, fill, send, verdict, review, reflect, stop, clean };
}

export type ShipDesk = ReturnType<typeof createShipDesk>;
