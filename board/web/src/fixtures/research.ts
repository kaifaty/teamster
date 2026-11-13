// The science station's fixtures: what the reflection learned, and the board server's actions played on that data,
// so that `dev:fixture` clicks through the whole station without a server. A start answers at once and then goes
// stage by stage in `launch` messages; an implementing agent is a task on the board with a changing last action.
import type { ActionBodies, ActionResult } from "../lib/actions";
import { reflectSlug } from "../lib/commands";
import type { Activity, Implementation, Launch, LaunchStage, Lesson, ResearchView, ServerMessage, Study, StudyMessage, TaskSummary } from "../types";

const task = (patch: Partial<Implementation> & Pick<Implementation, "slug" | "repo" | "created">): Implementation => ({
  archived: false, alive: false, result_status: null, pr: null, questions: [], summary: null, updated_at: patch.created, ...patch,
});

/** What the reflection learned, in made-up projects; a new copy each time, in the snapshot's time. */
export const fixtureResearch = (BASE: number): ResearchView => ({
  repos: [
    { name: "teamster", path: "/Users/demo/dev/teamster" },
    { name: "demo-game", path: "/Users/demo/dev/demo-game" },
    { name: "demo-shop", path: "/Users/demo/dev/demo-shop" },
    { name: "demo-vault", path: "/Users/demo/dev/demo-vault" },
    { name: "demo-wallet", path: "/Users/demo/dev/demo-wallet" },
  ],
  lessons: [
    { date: "2026-10-28", entry: "batch-2026-10-28.md L1", scope: "invariant", scope_text: "invariant", repos: [], cue: "review diff against a moved base", status: "applied", status_text: "applied rules (PR #12)" },
    { date: "2026-10-30", entry: "batch-2026-10-30.md L2", scope: "domain", scope_text: "domain demo-game", repos: ["demo-game"], cue: "full test suite times out while the machine is loaded", status: "applied", status_text: "applied demo-game AGENTS.md" },
    { date: "2026-11-01", entry: "batch-2026-11-01.md L1", scope: "domain", scope_text: "domain demo-shop, demo-vault", repos: ["demo-shop", "demo-vault"], cue: "sibling PRs conflict on one shared changelog", status: "declined", status_text: "declined 2026-11-02: one merge round each" },
    { date: "2026-11-05", entry: "batch-2026-11-05.md T1", scope: "invariant", scope_text: "invariant", repos: [], cue: "a partial result with a pushed commit skips the first review", status: "proposed", status_text: "proposed",
      title: "Review a partial result that already pushed",
      lesson: "When a turn ends partial but pushed a commit, run the first review on that commit before the next turn.",
      proposal: "In the supervisor, treat a pushed partial result like a finished turn for the first review.",
      evidence: "- demo-wallet/died-supervisor: the second turn built on an unreviewed commit\n- demo-vault/merge-conflict-fix: the defect from turn 1 reached CI",
      caveats: "Two records only; both had long first turns." },
    { date: "2026-11-06", entry: "batch-2026-11-06.md U1", scope: "invariant", scope_text: "invariant", repos: [], cue: "a test named by the brief stays green when the guarded behaviour is removed; the reviewer finds it by breaking the code", status: "accepted", status_text: "accepted: add a targeted check in the next task" },
    { date: "2026-11-06", entry: "batch-2026-11-06.md U2", scope: "domain", scope_text: "domain ml-lab", repos: ["ml-lab"], cue: "a smoke run starts the long training job inside the turn", status: "proposed", status_text: "proposed",
      title: "Keep the training smoke out of the turn",
      lesson: "Keep the ml-lab training smoke outside the interactive task turn.", proposal: null,
      evidence: "- ml-lab/budget-overrun: the smoke run took 41 minutes of a 60-minute turn", caveats: null },
    { date: "2026-11-06", entry: "batch-2026-11-06.md U3", scope: "domain", scope_text: "domain demo-game", repos: ["demo-game"], cue: "a save-format change ships without a migration test", status: "accepted", status_text: "accepted",
      title: "Test the save migration with the format change",
      lesson: "A change to the save format comes with a test that loads a save of the previous format.", proposal: null,
      implementation: task({ slug: "lesson-u3-save-migration", repo: "demo-game", alive: true, created: BASE - 600, updated_at: BASE - 120 }) },
    { date: "2026-11-06", entry: "batch-2026-11-06.md U4", scope: "domain", scope_text: "domain demo-wallet", repos: ["demo-wallet"], cue: "a retry hides a flaky e2e failure", status: "accepted", status_text: "accepted",
      title: "Report a flaky e2e test instead of retrying it",
      lesson: "When an e2e test passes only on retry, record it as flaky in the result instead of passing silently.", proposal: null,
      implementation: task({
        slug: "lesson-u4-flaky-e2e", repo: "demo-wallet", result_status: "needs_decision", created: BASE - 5400, updated_at: BASE - 900,
        questions: ["Mark the flaky test as skipped, or keep it running and only report it?"],
        summary: "The retry wrapper lives in the shared e2e runner; two suites depend on it.",
      }) },
    { date: "2026-11-06", entry: "batch-2026-11-06.md U5", scope: "invariant", scope_text: "invariant", repos: [], cue: "the brief's check runs on a stale build", status: "accepted", status_text: "accepted",
      title: "Rebuild before the brief's check",
      lesson: "Run the brief's check on a fresh build of the branch.", proposal: null,
      implementation: task({
        slug: "lesson-u5-fresh-build", repo: "teamster", result_status: "done", pr: "https://github.com/demo/teamster/pull/41", created: BASE - 9000, updated_at: BASE - 2400,
        summary: "The worker rebuilds before the saved check.",
      }) },
    { date: "2026-11-06", entry: "batch-2026-11-06.md U6", scope: "domain", scope_text: "domain demo-shop", repos: ["demo-shop"], cue: "a currency rounding fix lands without the ledger test", status: "accepted", status_text: "accepted",
      title: "Run the ledger test with every rounding fix",
      lesson: "A change to rounding runs the ledger reconciliation test.", proposal: null,
      implementation: task({
        slug: "lesson-u6-ledger-test", repo: "demo-shop", result_status: "blocked", created: BASE - 12000, updated_at: BASE - 4000,
        summary: "The ledger test needs a database dump that is not in the repository.",
      }) },
    { date: "2026-11-06", entry: "batch-2026-11-06.md U7", scope: "domain", scope_text: "domain demo-vault", repos: ["demo-vault"], cue: "a migration runs twice after a crash", status: "accepted", status_text: "accepted",
      title: "Make vault migrations safe to repeat",
      lesson: "A vault migration checks whether it already ran before it changes data.", proposal: null,
      implementation: task({
        slug: "lesson-u7-repeat-migration", repo: "demo-vault", archived: true, result_status: "partial", pr: "https://github.com/demo/demo-vault/pull/17", created: BASE - 90000, updated_at: BASE - 80000,
        summary: "Two of three migrations are guarded; the PR was closed for a new attempt.",
      }) },
    { date: "2026-11-07", entry: "study-2026-11-07.md L1", scope: "invariant", scope_text: "invariant", repos: [], cue: "a broad check repeats before the failure is reproduced", status: "proposed", status_text: "proposed" },
    { date: "2026-11-07", entry: "batch-2026-11-07.md V1", scope: "domain", scope_text: "domain demo-vault", repos: ["demo-vault"], cue: "the CI waiter reports «no CI run» as a CI failure", status: "proposed", status_text: "proposed",
      title: "No CI run is CI unavailable, not a failure",
      lesson: "When no run exists for the head commit, the waiter exits 75 so the supervisor skips CI.",
      proposal: "`~/.codex/checks/demo-vault/ci_wait.py`: when no run exists for the head commit after the wait, print the reason and exit 75.",
      evidence: "- demo-vault/backup-snapshots: «no CI run» after 10 min, two repair rounds, blocked", caveats: null,
      outside: ["~/.codex/checks/demo-vault/ci_wait.py"] },
    { date: "2026-11-07", entry: "batch-2026-11-07.md V2", scope: "domain", scope_text: "domain demo-shop", repos: ["demo-shop"], cue: "the check script skips the ledger test", status: "accepted", status_text: "accepted: внедряется: lesson-v2-1107",
      title: "Run the ledger test in the saved check",
      lesson: "The saved check of demo-shop runs the ledger reconciliation test.",
      proposal: "Add the ledger test to `check.sh` in `~/.codex/checks/demo-shop/`.", evidence: null, caveats: null,
      outside: ["~/.codex/checks/demo-shop/check.sh"],
      implementation: task({
        slug: "lesson-v2-1107", repo: "demo-shop", result_status: "done", created: BASE - 7000, updated_at: BASE - 1200,
        summary: "Changed ~/.codex/checks/demo-shop/check.sh: it runs the ledger test; copy check.sh.bak-2026-11-07-v2.",
      }) },
  ],
  studies: [
    {
      slug: "reflect-review-patterns", archived: false, mode: "study", alive: false,
      outcome: "completed", error: null, executor: "claude", account: "claude-pool-2",
      created: BASE - 3600, updated_at: BASE - 300, records: 2, file: "study-2026-11-07.md", waiting: true,
      messages: [
        { at: BASE - 3600, from: "lead", text: "Compare the failed checks in demo-wallet and demo-vault. Which lesson should guide the next task?", status: null, questions: [], lessons: [], file: null },
        {
          at: BASE - 300, from: "analyst", text: "Both records lost time repeating a broad check before reproducing the failing case.", status: "needs_decision",
          questions: [{ text: "Where should we apply the focused-check rule first?", options: ["demo-wallet", "demo-vault", "Both projects"] }],
          lessons: [{
            id: "L1", cue: "a broad check repeats before the failure is reproduced", entry: "study-2026-11-07.md L1",
            scope: "invariant", lesson: "Reproduce the failing case with a focused check before repeating the full suite.",
            proposal: "Add the focused-check sequence to each project's task brief.",
          }],
          file: "study-2026-11-07.md",
        },
      ],
    },
    {
      slug: "reflect-check-evidence", archived: true, mode: "batch", alive: false,
      outcome: "completed", error: null, executor: "codex", account: "demo-codex",
      created: BASE - 100000, updated_at: BASE - 86400, records: 11, file: "batch-2026-11-06.md", waiting: false,
      messages: [
        { at: BASE - 100000, from: "lead", text: "Review the check evidence from demo-game and ml-lab.", status: null, questions: [], lessons: [], file: null },
        {
          at: BASE - 98000, from: "analyst", text: "One check stayed green after the guarded behavior was removed. The long training smoke also ran inside a turn.", status: "needs_decision",
          questions: [{ text: "Should the next task verify that the check catches the defect?", options: ["Yes, before implementation", "Defer until the next review"] }],
          lessons: [{
            id: "U1", cue: "the guarded behavior is removed while its check stays green", entry: "batch-2026-11-06.md U1",
            scope: "invariant", lesson: "A check is useful evidence only if it fails when the guarded behavior is removed.",
            proposal: "Before implementation, run the named check against a deliberately reproduced defect.",
          }],
          file: "batch-2026-11-06.md",
        },
        { at: BASE - 97000, from: "lead", text: "Yes. Accept U1 and add a targeted check in the next task; keep the training proposal separate.", status: null, questions: [], lessons: [], file: null },
        {
          at: BASE - 96000, from: "analyst", text: "The report now separates the accepted check lesson from the training proposal.", status: "done", questions: [],
          lessons: [
            {
              id: "U1", cue: "the guarded behavior is removed while its check stays green", entry: "batch-2026-11-06.md U1",
              scope: "invariant", lesson: "A check is useful evidence only if it fails when the guarded behavior is removed.",
              proposal: "Before implementation, run the named check against a deliberately reproduced defect.",
            },
            {
              id: "U2", cue: "the long training smoke runs inside the turn", entry: "batch-2026-11-06.md U2",
              scope: "domain", lesson: "Keep the ml-lab training smoke outside the interactive task turn.", proposal: null,
            },
          ],
          file: "batch-2026-11-06.md",
        },
      ],
    },
  ],
  batch: { name: "batch-2026-11-07.md", date: "2026-11-07", through: "20261107T051647Z", records: 11, repos: { teamster: 4, "demo-game": 3, "ml-lab": 2, "demo-wallet": 2 } },
  pending: {
    records: 7,
    signals: 4,
    repos: { "demo-wallet": 2, "ml-lab": 1, "demo-vault": 1 },
    items: [
      { slug: "died-supervisor", repo: "demo-wallet", stamp: "20261107T221500Z", signals: ["blocked"] },
      { slug: "budget-overrun", repo: "ml-lab", stamp: "20261107T201000Z", signals: ["budget_exhausted", "fix_rounds"] },
      { slug: "merge-conflict-fix", repo: "demo-vault", stamp: "20261107T153000Z", signals: ["check_failed", "ci_repair"] },
      { slug: "flaky-e2e", repo: "demo-wallet", stamp: "20261107T090000Z", signals: ["escalate"] },
    ],
  },
  reflection_task: "codex-batch-reflection",
  actions: { enabled: true, reason: null },
  // Shifted with the other times: the planned run comes 21 hours after the snapshot, the last one 3 hours before it.
  schedule: {
    source: "desktop", name: "Рефлексия codex-worker (ежедневно)", cron: "0 9 * * *", enabled: true,
    last_run_at: BASE - 3 * 3600 + 340, last_scheduled_for: BASE - 3 * 3600, next_at: BASE + 21 * 3600,
  },
});

/** How long the fixture analyst takes for a turn. */
export const TURN_MS = 8000;
/** How long the fixture agent takes for a turn of an implementation. */
export const IMPLEMENT_MS = 9000;
/** How long each stage of a fixture start takes. */
export const STAGE_MS = 1100;
/** The lesson whose first start fails, to show that path. */
export const FAILING_ENTRY = "batch-2026-11-06.md U2";

const message = (at: number, from: StudyMessage["from"], text: string | null, patch: Partial<StudyMessage> = {}): StudyMessage => ({
  at, from, text, status: null, questions: [], lessons: [], file: null, ...patch,
});

/** What a fixture agent does, one line after another while it works. */
const ACTIVITIES: [Activity["kind"], string][] = [
  ["command", "rg -n \"save_format\" src tests"],
  ["thinking", "Читаю, где формат сохранения проверяется при загрузке"],
  ["edit", "tests/test_save_migration.py"],
  ["command", "python -m pytest tests/test_save_migration.py -q"],
  ["edit", "AGENTS.md"],
  ["message", "Добавил тест загрузки сохранения прошлой версии"],
  ["command", "git commit -m \"Test the save migration\""],
];

export type StationRoute = "lesson" | "say" | "reflect" | "implement";
export type StationSender = <R extends StationRoute>(route: R, body: ActionBodies[R]) => Promise<ActionResult>;

export interface FixtureStation {
  act: StationSender;
  /** The implementing agents' tasks, for the board's snapshot. */
  tasks(): TaskSummary[];
  /** Once a second: the working agents' next action and phase. */
  tick(): void;
}

/** A board task for a lesson's implementation. */
function agentTask(task: Implementation, at: number): TaskSummary {
  return {
    slug: task.slug, kind: "work", title: null, link: null, repo: task.repo, branch: `lesson/${task.slug}`, task_type: "lesson",
    executor: "codex", account: "demo-codex", reviewer: "claude", model: null, effort: null, column: "running", phase: "turn",
    phase_started_at: at, alive: true, turn: 1, fix_round: 0, outcome: null, result_status: null, summary: null, pr: null, ci: null,
    sleeping_until: null, created: task.created, updated_at: at, activity: null, scheduled: null, check: null, review: null,
    findings_left: 0, stop: null, left: 0,
  };
}

/**
 * The board server's station actions on the fixture data. `clock` is now in the fixture's own time; a say or an order sets
 * the analyst to work, and a turn later the analyst answers. `emit` tells the board about starts and agents, in the
 * fixture's time.
 */
export function fixtureActions(view: ResearchView, clock: () => number, emit: (message: ServerMessage) => void = () => {}): FixtureStation {
  const fail = (error: string): ActionResult => ({ ok: false, error });
  const implementing = (slug: string): Lesson | undefined => view.lessons.find((item) => item.implementation?.slug === slug);
  const launches = (view.launches ??= []);
  const failed = new Set<string>();

  // ---- the agents' tasks on the board

  const agents = new Map<string, { task: TaskSummary; since: number; step: number }>();
  const show = (task: TaskSummary) => emit({ type: "task", task: { ...task } });
  function work(task: Implementation) {
    const at = clock();
    const own = agents.get(task.slug)?.task ?? agentTask(task, at);
    Object.assign(own, { alive: true, column: "running", phase: "turn", phase_started_at: at, updated_at: at, result_status: null });
    agents.set(task.slug, { task: own, since: at, step: 0 });
    show(own);
  }
  function rest(task: Implementation) {
    const agent = agents.get(task.slug);
    if (!agent) return;
    Object.assign(agent.task, {
      alive: false, activity: null, phase: "idle", updated_at: clock(), result_status: task.result_status, pr: task.pr, summary: task.summary,
      column: task.result_status === "done" ? "review_me" : "attention",
    });
    show(agent.task);
  }
  // The agents already at work in the fixtures work on.
  for (const lesson of view.lessons) if (lesson.implementation?.alive) work(lesson.implementation);
  function tick() {
    const now = clock();
    for (const agent of agents.values()) {
      const task = agent.task;
      if (!task.alive) continue;
      const share = ((now - agent.since) * 1000 % IMPLEMENT_MS) / IMPLEMENT_MS;
      const phase = share < 0.55 ? "turn" : share < 0.78 ? "check" : "review";
      if (phase !== task.phase) Object.assign(task, { phase, phase_started_at: now });
      const [kind, text] = ACTIVITIES[agent.step++ % ACTIVITIES.length]!;
      task.activity = { at: now, kind, text };
      task.updated_at = now;
      show(task);
    }
  }

  /** The agent's turn ends: the first one asks a question, the next one opens a PR. */
  const agentTurn = (lesson: Lesson, first: boolean) =>
    setTimeout(() => {
      const task = lesson.implementation;
      if (!task) return;
      Object.assign(task, first
        ? { alive: false, result_status: "needs_decision", updated_at: clock(), summary: "Нашёл два места, где правило можно записать.",
            questions: ["Записать правило в AGENTS.md репозитория или в docs/checks.md?"] }
        : { alive: false, result_status: "done", updated_at: clock(), questions: [], summary: "Правило записано, проверка добавлена.",
            pr: `https://github.com/demo/${task.repo}/pull/${50 + view.lessons.indexOf(lesson)}` });
      rest(task);
    }, IMPLEMENT_MS);
  const finish = (study: Study, answer: StudyMessage) =>
    setTimeout(() => {
      study.messages.push({ ...answer, at: clock() });
      Object.assign(study, { alive: false, waiting: answer.status === "needs_decision", outcome: "completed", updated_at: clock() });
    }, TURN_MS);

  // ---- starts, stage by stage

  const copy = (launch: Launch): Launch => ({ ...launch, steps: launch.steps.map((step) => ({ ...step })) });
  function startLaunch(patch: Pick<Launch, "slug" | "kind" | "entry" | "repo">, stage: LaunchStage): Launch {
    const at = clock();
    const launch: Launch = { ...patch, stage, steps: [{ stage, at }], error: null, started_at: at };
    launches.push(launch);
    emit({ type: "launch", launch: copy(launch) });
    return launch;
  }
  /** Goes through `stages` one per STAGE_MS, running each stage's change as it ends. */
  function advance(launch: Launch, stages: { stage: LaunchStage; error?: string; then?: () => void }[]) {
    let at = 0;
    for (const next of stages) {
      at += STAGE_MS;
      setTimeout(() => {
        if (launch.stage === "failed") return;
        next.then?.();
        Object.assign(launch, { stage: next.stage, error: next.error ?? null });
        launch.steps.push({ stage: next.stage, at: clock() });
        emit({ type: "launch", launch: copy(launch) });
      }, at);
    }
  }

  const routes: { [R in StationRoute]: (body: ActionBodies[R]) => ActionResult } = {
    lesson({ entry, status, note }) {
      const lesson = view.lessons.find((item) => item.entry === entry);
      if (!lesson) return fail(`Урок ${entry} не найден в индексе`);
      lesson.status = status;
      lesson.status_text = note ? `${status}: ${note}` : status;
      return { ok: true, output: `${entry}: ${status}` };
    },
    say({ slug, text }) {
      const lesson = implementing(slug);
      if (lesson?.implementation) {
        const task = lesson.implementation;
        if (task.alive) return fail("Агент работает: ответить можно после его хода");
        if (task.archived) return fail("Задача закрыта");
        Object.assign(task, { alive: true, result_status: null, updated_at: clock() });
        work(task);
        agentTurn(lesson, false);
        return { ok: true, output: `said to ${slug}: ${text.length} chars` };
      }
      const study = view.studies.find((item) => item.slug === slug);
      if (!study) return fail(`Исследование ${slug} не найдено`);
      if (study.alive) return fail("Аналитик работает: ответить можно после его хода");
      if (study.archived) return fail("Исследование закрыто");
      study.messages.push(message(clock(), "lead", text));
      Object.assign(study, { alive: true, waiting: false, updated_at: clock() });
      finish(study, message(0, "analyst", "Принял ответ и обновил докладную. Новых вопросов нет.", { status: "done", file: study.file }));
      return { ok: true, output: `said to ${slug}` };
    },
    implement({ entry, repo, note }) {
      const lesson = view.lessons.find((item) => item.entry === entry);
      if (!lesson) return fail(`Урок ${entry} не найден в индексе`);
      if (lesson.status === "applied" || lesson.status === "declined") return fail(`Урок ${entry} уже ${lesson.status === "applied" ? "внедрён" : "отклонён"}`);
      if (lesson.implementation && !lesson.implementation.archived) return fail(`Урок ${entry} уже внедряется: ${lesson.implementation.slug}`);
      const going = launches.find((item) => item.entry === entry && item.stage !== "done" && item.stage !== "failed");
      if (going) return fail(`Урок уже запускается: ${going.slug}`);
      const target = view.repos?.find((item) => item.path === repo);
      if (!target) return fail(`Репозиторий ${repo} не найден`);
      const id = entry.trim().split(/\s+/).at(-1)!.toLowerCase();
      let slug = `lesson-${id}`;
      while (view.lessons.some((item) => item.implementation?.slug === slug) || launches.some((item) => item.slug === slug)) slug += "x";
      const proposed = lesson.status === "proposed";
      const launch = startLaunch({ slug, kind: "implement", entry, repo: target.name }, proposed ? "accepting" : "fetching");
      const accept = () => {
        if (lesson.status === "proposed") Object.assign(lesson, { status: "accepted", status_text: "accepted" });
      };
      const stages: { stage: LaunchStage; error?: string; then?: () => void }[] = proposed ? [{ stage: "fetching", then: accept }] : [];
      // The first start of one lesson breaks, so that the screen shows a failed start; the next one goes.
      if (entry === FAILING_ENTRY && !failed.has(entry)) {
        failed.add(entry);
        advance(launch, [...stages, { stage: "worktree" }, { stage: "failed", error: `git worktree add: ветка lesson/${slug} уже есть в ${target.name} — удали её или выбери другой репозиторий` }]);
        return { ok: true, output: "", slug, launch: copy(launch) };
      }
      advance(launch, [
        ...stages,
        { stage: "worktree" },
        { stage: "starting" },
        {
          stage: "done",
          // The task shows up once its agent has started.
          then: () => {
            lesson.implementation = task({ slug, repo: target.name, alive: true, created: clock(), summary: note ?? null });
            work(lesson.implementation);
            agentTurn(lesson, true);
          },
        },
      ]);
      return { ok: true, output: "", slug, launch: copy(launch) };
    },
    reflect({ order, tasks = [], since, repos = [] }) {
      if (tasks.length && (since !== undefined || repos.length)) return fail("--task не сочетается с --since и --repo");
      let slug = reflectSlug(new Date());
      while (view.studies.some((item) => item.slug === slug) || launches.some((item) => item.slug === slug)) slug += "x";
      const launch = startLaunch({ slug, kind: "reflect", entry: null, repo: null }, "preparing");
      const begin = () => {
        const at = clock();
        const study: Study = {
          slug, archived: false, mode: tasks.length || since !== undefined || repos.length ? "study" : "batch", alive: true,
          outcome: null, error: null, executor: "claude", account: "claude-pool-2", created: at, updated_at: at,
          records: tasks.length || 5, file: null, waiting: false, messages: [message(at, "lead", order ?? null)],
        };
        view.studies.unshift(study);
        finish(study, message(0, "analyst", "Прочитал записи. Нашёл два похожих случая, но причина в них разная.", {
          status: "needs_decision",
          questions: [{ text: "Что важнее разобрать первым?", options: ["Повторные проверки", "Потерянное время на CI"] }],
        }));
      };
      advance(launch, [{ stage: "starting" }, { stage: "done", then: begin }]);
      return { ok: true, output: "", slug, launch: copy(launch) };
    },
  };
  return {
    async act(route, body) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return routes[route](body);
    },
    tasks: () => [...agents.values()].map((agent) => ({ ...agent.task })),
    tick,
  };
}
