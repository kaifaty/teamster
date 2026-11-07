// Demo for `npm run dev:fixture`: three agents (Codex, Claude and a reviewer) go round every station of a
// system. One of them changes every SCENARIO_STEP_SECONDS, in turn, so every place and every walk shows up
// without real tasks. A standing fleet keeps the rest in view: every hull of both families, a damaged ship with
// patches, a ship under review with its escort, and a second system in trouble.

import type { BoardSource } from "../lib/source";
import type { Activity, Column, Phase, TaskDetail, TaskSummary } from "../types";

export const SCENARIO_REPO = "demo-system";
export const SCENARIO_OUTPOST = "demo-outpost";
export const SCENARIO_STEP_SECONDS = 4;

interface Stage {
  column: Column;
  phase: Phase;
  alive: boolean;
  /** The latest activity and its age when the stage starts; null when there is none. */
  activity: { kind: Activity["kind"]; text: string; age?: number } | null;
  note: string;
  turn: number;
  fix_round?: number;
  ci?: string;
  pr?: boolean;
  result_status?: string;
  outcome?: string;
  summary?: string;
  /** Seconds from the start of the stage to the wake-up. */
  sleep?: number;
}

interface Agent {
  slug: string;
  kind: TaskSummary["kind"];
  executor: TaskSummary["executor"];
  reviewer: TaskSummary["reviewer"];
  account: string;
  model: string;
  effort: string;
  task_type: string | null;
  /** The stage at step 0, so that the agents start at different places. */
  first: number;
  /** Words of this agent's activity lines. */
  words: { file: string; command: string; idea: string };
}

const AGENTS: readonly Agent[] = [
  {
    slug: "fleet-scene",
    kind: "work",
    executor: "codex",
    reviewer: "claude",
    account: "codex-team-2",
    model: "gpt-5.5-codex",
    effort: "high",
    task_type: "feature",
    first: 0,
    words: { file: "src/map/scene.ts", command: "npm run build", idea: "Где поставить полигон" },
  },
  {
    slug: "label-overlap-fix",
    kind: "work",
    executor: "claude",
    reviewer: "codex",
    account: "claude-pool-1",
    model: "claude-opus-5-5",
    effort: "medium",
    task_type: "fix",
    first: 5,
    words: { file: "src/map/MapView.vue", command: "npm test -- --run", idea: "Почему подписи наезжают друг на друга" },
  },
  {
    slug: "review-pr-118",
    kind: "review",
    executor: "codex",
    reviewer: "claude",
    account: "codex-team-1",
    model: "gpt-5.5",
    effort: "high",
    task_type: null,
    first: 9,
    words: { file: "board/web/src/App.vue", command: "git diff origin/main...HEAD", idea: "Проверяю, что доска не изменилась" },
  },
];

/** The stages every agent goes through, in a circle: every row of the placement table, and a stale turn. */
function stages(words: Agent["words"]): Stage[] {
  const running = { column: "running", alive: true } as const;
  return [
    { ...running, phase: "turn", turn: 1, note: "ход 1", activity: { kind: "command", text: words.command } },
    { ...running, phase: "turn", turn: 1, note: "правка", activity: { kind: "edit", text: `Edit ${words.file}` } },
    { ...running, phase: "turn", turn: 1, note: "размышляет", activity: { kind: "thinking", text: words.idea } },
    { ...running, phase: "turn", turn: 1, note: "сообщение", activity: { kind: "message", text: "Готово, отдаю на проверку" } },
    { ...running, phase: "check", turn: 1, note: "проверка", activity: { kind: "message", text: "Готово, отдаю на проверку", age: 4 } },
    { ...running, phase: "review", turn: 1, note: "ревью", activity: { kind: "message", text: "Проверка прошла, жду ревью", age: 2 } },
    { ...running, phase: "fix", turn: 2, fix_round: 1, note: "исправление", activity: { kind: "edit", text: `Edit ${words.file}: замечания ревью` } },
    { ...running, phase: "check", turn: 2, fix_round: 1, note: "проверка", activity: { kind: "message", text: "Исправил замечания", age: 3 } },
    { ...running, phase: "ci", turn: 2, pr: true, ci: "pending", note: "CI", activity: { kind: "message", text: "Запушил ветку, жду CI", age: 2 } },
    {
      column: "review_me", phase: "idle", alive: false, turn: 2, pr: true, ci: "passed", note: "ждёт ревью",
      result_status: "done", outcome: "done", summary: "Готово, PR ждёт ревью", activity: null,
    },
    { ...running, phase: "turn", turn: 3, pr: true, ci: "passed", note: "ход 3", activity: { kind: "tool", text: "Read src/types.ts" } },
    {
      ...running, phase: "turn", turn: 3, pr: true, ci: "passed", note: "ход 3 молчит",
      activity: { kind: "message", text: "Жду ответа от сервера", age: 200 },
    },
    {
      column: "sleeping", phase: "sleeping", alive: true, turn: 3, pr: true, outcome: "sleeping", sleep: 25 * 60,
      note: "сон до сброса лимита", activity: { kind: "message", text: "Лимит аккаунта, сплю до сброса", age: 5 },
    },
    {
      column: "attention", phase: "idle", alive: false, turn: 3, pr: true, note: "нужно решение",
      result_status: "needs_decision", outcome: "done", summary: "Нужно решение: где показывать закрытые задачи", activity: null,
    },
  ];
}

const STAGES = AGENTS.map((agent) => stages(agent.words));
export const SCENARIO_STAGES = STAGES[0]!.length;
/** Steps until every agent is back where it started. */
export const SCENARIO_CYCLE = SCENARIO_STAGES * AGENTS.length;

/** How many times agent `index` has changed by step `step`: step k ≥ 1 moves agent (k - 1) mod 3. */
function moves(index: number, step: number): number {
  return step > index ? Math.floor((step - 1 - index) / AGENTS.length) + 1 : 0;
}

/** The step at which agent `index` last changed, 0 for its first stage. */
function lastChange(index: number, step: number): number {
  const count = moves(index, step);
  return count === 0 ? 0 : index + 1 + (count - 1) * AGENTS.length;
}

function build(index: number, stageIndex: number, changedAt: number, start: number): TaskSummary {
  const agent = AGENTS[index]!;
  const stage = STAGES[index]![stageIndex]!;
  return {
    slug: agent.slug,
    kind: agent.kind,
    title: null,
    link: null,
    repo: SCENARIO_REPO,
    branch: agent.kind === "work" ? `codex/${agent.slug}` : null,
    task_type: agent.task_type,
    executor: agent.executor,
    account: agent.account,
    reviewer: agent.reviewer,
    model: agent.model,
    effort: agent.effort,
    column: stage.column,
    phase: stage.phase,
    phase_started_at: changedAt,
    alive: stage.alive,
    turn: stage.turn,
    fix_round: stage.fix_round ?? 0,
    outcome: stage.outcome ?? (stage.alive ? "running" : null),
    result_status: stage.result_status ?? null,
    summary: stage.summary ?? null,
    pr: stage.pr ? `https://github.com/example/demo-system/pull/${118 + index}` : null,
    ci: stage.ci ?? null,
    sleeping_until: stage.sleep !== undefined ? changedAt + stage.sleep : null,
    created: start - 3600 + index * 60,
    updated_at: changedAt,
    activity:
      stage.alive && stage.activity
        ? { at: changedAt - (stage.activity.age ?? 0), kind: stage.activity.kind, text: stage.activity.text }
        : null,
  };
}

/** Ships that stay where they are; the working ones keep their activity fresh. */
const STANDING: readonly (Partial<TaskSummary> & Pick<TaskSummary, "slug" | "executor" | "effort">)[] = [
  {
    slug: "ci-burns-after-fixes", executor: "claude", account: "claude-pool-1", effort: "xhigh", reviewer: "codex",
    phase: "fix", fix_round: 2, ci: "failed", pr: "https://github.com/example/demo-system/pull/131",
    activity: { at: null, kind: "edit", text: "Edit src/store/reduce.ts: третий заход на падающий CI" },
  },
  {
    slug: "inspector-escort", executor: "claude", account: "claude-pool-1", effort: "high", reviewer: "codex",
    phase: "review", fix_round: 1, activity: { at: null, kind: "message", text: "Отдал на ревью, жду замечаний" },
  },
  {
    slug: "heavy-range-check", executor: "codex", account: "codex-team-1", effort: "max", reviewer: "claude",
    phase: "check", activity: { at: null, kind: "command", text: "npm run build" },
  },
  {
    slug: "light-through-gate", executor: "codex", account: "codex-team-2", effort: "low", reviewer: "claude",
    phase: "ci", ci: "pending", pr: "https://github.com/example/demo-system/pull/132",
    activity: { at: null, kind: "message", text: "Запушил ветку, жду CI" },
  },
  {
    slug: "outpost-migration", repo: SCENARIO_OUTPOST, executor: "codex", account: "codex-team-1", effort: "ultra",
    reviewer: "claude", column: "attention", phase: "idle", alive: false, result_status: "blocked", outcome: "done",
    summary: "Заблокировано: миграция требует доступа к базе",
  },
  {
    slug: "outpost-patrol", repo: SCENARIO_OUTPOST, executor: "claude", account: "claude-pool-2", effort: "low",
    reviewer: "codex", phase: "turn", activity: { at: null, kind: "tool", text: "Read README.md" },
  },
];

/** The standing fleet of a scenario that started at `start`, with activity as fresh as `now`. */
export function scenarioFleet(start: number, now: number = start): TaskSummary[] {
  return STANDING.map((ship, index) => {
    const alive = ship.alive ?? true;
    return {
      kind: "work",
      title: null,
      link: null,
      repo: SCENARIO_REPO,
      branch: `codex/${ship.slug}`,
      task_type: "feature",
      reviewer: null,
      model: ship.executor === "codex" ? "gpt-5.5-codex" : "claude-opus-5-5",
      column: "running",
      phase: "turn",
      phase_started_at: start - 300 - index * 40,
      alive,
      turn: 1 + (ship.fix_round ?? 0),
      fix_round: 0,
      outcome: alive ? "running" : null,
      result_status: null,
      summary: null,
      pr: null,
      ci: null,
      sleeping_until: null,
      created: start - 7200 + index * 60,
      account: null,
      ...ship,
      updated_at: start - 300 - index * 40,
      activity: alive && ship.activity ? { ...ship.activity, at: now - 2 } : null,
    };
  });
}

/** The three tasks at step `step` of a scenario that started at `start` (Unix seconds). */
export function scenarioTasks(step: number, start: number): TaskSummary[] {
  return AGENTS.map((agent, index) => {
    const changed = lastChange(index, step);
    // The first stages started a little before the scenario, so their clocks do not all read zero.
    const changedAt = changed === 0 ? start - 20 - index * 35 : start + changed * SCENARIO_STEP_SECONDS;
    return build(index, (agent.first + moves(index, step)) % SCENARIO_STAGES, changedAt, start);
  });
}

function timeline(index: number, step: number, start: number): { at: number; text: string }[] {
  const agent = AGENTS[index]!;
  const entries = [{ at: start - 3600 + index * 60, text: "демо-задача создана" }];
  const count = moves(index, step);
  for (let move = Math.max(0, count - SCENARIO_STAGES + 1); move <= count; move++) {
    const at = move === 0 ? start - 20 - index * 35 : start + (index + 1 + (move - 1) * AGENTS.length) * SCENARIO_STEP_SECONDS;
    entries.push({ at, text: STAGES[index]![(agent.first + move) % SCENARIO_STAGES]!.note });
  }
  return entries;
}

const BRIEF = `# Демо-сценарий карты

Три агента — Codex, Claude и ревьюер — по кругу проходят все станции системы: верфь, полигон,
инспекцию, гиперврата, рейд, криополе и сигнал бедствия. Каждые ${SCENARIO_STEP_SECONDS} с меняется
один из них. Это не настоящие задачи: сценарий есть только в режиме \`npm run dev:fixture\`.
`;

/** Fuel depots of the demo: enough, low and spent, so that the galaxy shows them all, with their refuel times. */
function accounts(start: number) {
  return {
    codex: [
      { name: "codex-team-1", status: "available", secondary: { used_percent: 41, window_minutes: 10080, resets_at: start + 4 * 86400 } },
      { name: "codex-team-2", status: "available", secondary: { used_percent: 88, window_minutes: 10080, resets_at: start + 40 * 60 } },
    ],
    claude: [
      { name: "claude-pool-1", seven_day: { used_percent: 30 } },
      { name: "claude-pool-2", seven_day: { used_percent: 100, resets_at: start + 2 * 86400 }, limited_until: start + 5 * 3600 },
    ],
  };
}

/** A source that plays the scenario, for the map's demo mode. */
export function scenarioSource(): BoardSource {
  let start = Date.now() / 1000;
  let step = 0;
  let tasks: TaskSummary[] = [];
  return {
    label: "сценарий",
    fetchArt: async () => ({}),
    fetchResearch: async () => null,
    connect(onMessage, onState) {
      start = Date.now() / 1000;
      step = 0;
      tasks = scenarioTasks(step, start);
      onState("connecting", null);
      onState("open", null);
      onMessage({
        type: "snapshot",
        snapshot: {
          generated_at: start,
          tasks: [...tasks, ...scenarioFleet(start)],
          accounts: { fetched_at: start, error: null, data: accounts(start) },
        },
      });
      const timer = setInterval(() => {
        step += 1;
        const next = scenarioTasks(step, start);
        for (const task of next) {
          const previous = tasks.find((item) => item.slug === task.slug);
          if (!previous || previous.updated_at !== task.updated_at) onMessage({ type: "task", task });
        }
        tasks = next;
        for (const ship of scenarioFleet(start, Date.now() / 1000)) {
          if (ship.activity) onMessage({ type: "activity", slug: ship.slug, activity: ship.activity });
        }
      }, SCENARIO_STEP_SECONDS * 1000);
      return () => clearInterval(timer);
    },
    async fetchDetail(slug) {
      const index = tasks.findIndex((task) => task.slug === slug);
      if (index >= 0) return { ...tasks[index]!, timeline: timeline(index, step, start), files: ["brief"] } satisfies TaskDetail;
      const ship = scenarioFleet(start, Date.now() / 1000).find((task) => task.slug === slug);
      if (!ship) return null;
      return { ...ship, timeline: [{ at: ship.created!, text: "демо-корабль на месте" }], files: ["brief"] } satisfies TaskDetail;
    },
    async fetchFile(slug, name) {
      const known = tasks.some((task) => task.slug === slug) || STANDING.some((ship) => ship.slug === slug);
      return name === "brief" && known ? BRIEF : null;
    },
  };
}
