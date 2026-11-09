// The science station's fixtures: what the reflection learned, and the board server's actions played on that data,
// so that `dev:fixture` clicks through the whole station without a server.
import type { ActionBodies, ActionResult, ActionRoute, ActionSender } from "../lib/actions";
import { reflectSlug } from "../lib/commands";
import type { ResearchView, Study, StudyMessage } from "../types";

/** What the reflection learned, in made-up projects; a new copy each time, in the snapshot's time. */
export const fixtureResearch = (BASE: number): ResearchView => ({
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
    { date: "2026-11-07", entry: "study-2026-11-07.md L1", scope: "invariant", scope_text: "invariant", repos: [], cue: "a broad check repeats before the failure is reproduced", status: "proposed", status_text: "proposed" },
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
const TURN_MS = 8000;

const message = (at: number, from: StudyMessage["from"], text: string | null, patch: Partial<StudyMessage> = {}): StudyMessage => ({
  at, from, text, status: null, questions: [], lessons: [], file: null, ...patch,
});

/**
 * The board server's actions on the fixture data. `clock` is now in the fixture's own time; a say or an order sets
 * the analyst to work, and a turn later the analyst answers.
 */
export function fixtureActions(view: ResearchView, clock: () => number): ActionSender {
  const fail = (error: string): ActionResult => ({ ok: false, error });
  const finish = (study: Study, answer: StudyMessage) =>
    setTimeout(() => {
      study.messages.push({ ...answer, at: clock() });
      Object.assign(study, { alive: false, waiting: answer.status === "needs_decision", outcome: "completed", updated_at: clock() });
    }, TURN_MS);

  const routes: { [R in ActionRoute]: (body: ActionBodies[R]) => ActionResult } = {
    lesson({ entry, status, note }) {
      const lesson = view.lessons.find((item) => item.entry === entry);
      if (!lesson) return fail(`Урок ${entry} не найден в индексе`);
      lesson.status = status;
      lesson.status_text = note ? `${status}: ${note}` : status;
      return { ok: true, output: `${entry}: ${status}` };
    },
    say({ slug, text }) {
      const study = view.studies.find((item) => item.slug === slug);
      if (!study) return fail(`Исследование ${slug} не найдено`);
      if (study.alive) return fail("Аналитик работает: ответить можно после его хода");
      if (study.archived) return fail("Исследование закрыто");
      study.messages.push(message(clock(), "lead", text));
      Object.assign(study, { alive: true, waiting: false, updated_at: clock() });
      finish(study, message(0, "analyst", "Принял ответ и обновил докладную. Новых вопросов нет.", { status: "done", file: study.file }));
      return { ok: true, output: `said to ${slug}` };
    },
    reflect({ order, tasks = [], since, repos = [] }) {
      if (tasks.length && (since !== undefined || repos.length)) return fail("--task не сочетается с --since и --repo");
      let slug = reflectSlug(new Date());
      while (view.studies.some((item) => item.slug === slug)) slug += "x";
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
      return { ok: true, output: `started ${slug}`, slug };
    },
  };
  return async (route, body) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return routes[route](body);
  };
}
