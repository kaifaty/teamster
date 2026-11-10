// The board server's task orders on the fixture data, so that `dev:fixture` clicks through a ship's bridge without a
// server: `say` adds the lead's message, or puts it in the queue of a busy ship whose teamster queues, `stop` puts the
// ship out of work and drops its queue, `clean` takes it off the board, and `verdict` and `review` answer with success. The orders outlive the replay's loop: every message passes `patch`.
import type { ActionBodies, ActionResult } from "../lib/actions";
import { commandSlug } from "../lib/commands";
import type { ServerMessage, TaskMessage, TaskQueue, TaskSummary } from "../types";

export type ShipRoute = "say" | "verdict" | "review" | "stop" | "clean";

export interface FixtureShips {
  /** The fixture message as the orders left it; null when the order removed its task. */
  patch(message: ServerMessage): ServerMessage | null;
  /** The lead's messages sent from the bridge. */
  sent(slug: string): TaskMessage[];
  /** The orders queued and dropped from the bridge. */
  queue(slug: string): TaskQueue;
  act<R extends ShipRoute>(route: R, body: ActionBodies[R]): ActionResult;
}

const fail = (error: string): ActionResult => ({ ok: false, error });

/** `tasks`: the board as the fixtures show it now; `emit` tells the board what an order changed; `queues`: the ship's detail has `actions.queue`. */
export function fixtureShips(
  tasks: () => Record<string, TaskSummary>,
  clock: () => number,
  emit: (message: ServerMessage) => void,
  queues: (slug: string) => boolean = () => false,
): FixtureShips {
  const stopped = new Map<string, number>();
  const removed = new Set<string>();
  const messages = new Map<string, TaskMessage[]>();
  const queued = new Map<string, TaskQueue>();
  const queueOf = (slug: string) => queued.get(slug) ?? { waiting: [], dropped: [] };

  const stop = (task: TaskSummary): TaskSummary => {
    const at = stopped.get(task.slug);
    if (at === undefined) return task;
    return { ...task, alive: false, column: "attention", outcome: "stopped", result_status: null, activity: null, sleeping_until: null, updated_at: Math.max(task.updated_at, at) };
  };

  function patch(message: ServerMessage): ServerMessage | null {
    switch (message.type) {
      case "snapshot": {
        const kept = message.snapshot.tasks.filter((task) => !removed.has(task.slug)).map(stop);
        return { ...message, snapshot: { ...message.snapshot, tasks: kept } };
      }
      case "task":
        return removed.has(message.task.slug) ? null : { ...message, task: stop(message.task) };
      case "activity":
        return removed.has(message.slug) || stopped.has(message.slug) ? null : message;
      default:
        return message;
    }
  }

  function find(slug: string): TaskSummary | ActionResult {
    const task = removed.has(slug) ? undefined : tasks()[slug];
    return task ?? fail(`Задача ${slug} не найдена`);
  }
  const isTask = (found: TaskSummary | ActionResult): found is TaskSummary => "slug" in found;
  const archived = (slug: string) => commandSlug(slug) !== slug;
  const judged = (task: TaskSummary) => task.kind === "work" || task.kind === "review";
  const ok = (output: string): ActionResult => ({ ok: true, output });

  const routes: { [R in ShipRoute]: (body: ActionBodies[R]) => ActionResult } = {
    say({ slug, text, options }) {
      const task = find(slug);
      if (!isTask(task)) return task;
      if (archived(slug) || !(judged(task) || task.kind === "reflect")) return fail("Задача сейчас не принимает указание");
      if (task.alive) {
        if (!queues(slug)) return fail("Задача сейчас не принимает указание");
        const queue = queueOf(slug);
        queued.set(slug, { ...queue, waiting: [...queue.waiting, { at: clock(), text: text.trim() }] });
        return ok(`queued for ${slug}: ${queue.waiting.length + 1} waiting; sent when the current cycle ends`);
      }
      const list = messages.get(slug) ?? [];
      list.push({ at: clock(), source: "lead", text: text.trim() });
      messages.set(slug, list);
      emit({ type: "task", task: { ...task, updated_at: clock() } });
      const flags = Object.keys(options ?? {}).length;
      return ok(`message saved for ${commandSlug(slug)}${flags ? `; ${flags} options replaced` : ""}`);
    },
    verdict({ slug, verdict }) {
      const task = find(slug);
      if (!isTask(task)) return task;
      if (!judged(task)) return fail("Вердикт ставится только задаче work или review");
      return ok(`verdict ${verdict} recorded for ${commandSlug(slug)}`);
    },
    review({ slug }) {
      const task = find(slug);
      if (!isTask(task)) return task;
      if (!judged(task) || task.alive || archived(slug)) return fail("Инспекцию можно вызвать только стоящему кораблю");
      return ok(`review of ${slug} started`);
    },
    stop({ slug }) {
      const task = find(slug);
      if (!isTask(task)) return task;
      if (!task.alive || archived(slug)) return fail("not running");
      stopped.set(slug, clock());
      const queue = queueOf(slug);
      const dropped = queue.waiting.map((order) => ({ ...order, dropped_at: clock(), outcome: "stopped" }));
      queued.set(slug, { waiting: [], dropped: [...queue.dropped, ...dropped] });
      emit({ type: "task", task: stop(task) });
      return ok(`${slug}: stopped`);
    },
    clean({ slug, keep_branch }) {
      const task = find(slug);
      if (!isTask(task)) return task;
      if (task.alive || archived(slug)) return fail("Списать можно только стоящий корабль");
      removed.add(slug);
      emit({ type: "task_removed", slug });
      return ok(`${slug}: worktree removed${keep_branch === false ? ", branch deleted" : ", branch kept"}`);
    },
  };

  return {
    patch,
    sent: (slug) => messages.get(slug) ?? [],
    queue: queueOf,
    act: (route, body) => routes[route](body),
  };
}
