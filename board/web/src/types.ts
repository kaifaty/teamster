// Board data contract v1 (board/CONTRACT.md). Keep this file in step with the contract.
// All times are Unix seconds (float) or null.

export type Column = "running" | "sleeping" | "review_me" | "attention" | "closed";
export type Phase = "turn" | "check" | "review" | "fix" | "ci" | "sleeping" | "idle";

export interface Activity {
  at: number | null;
  kind: "command" | "edit" | "message" | "tool" | "thinking";
  text: string; // one line, ≤ 200 chars
}

/** One completed phase of a task, or the lead's verdict on it, from the worker's journal. */
export interface LogEvent {
  at: number;
  started: number | null;
  slug: string | null;
  repo: string | null;
  kind: "work" | "review" | "scout" | "verdict";
  phase: string | null; // "work", "fix", "check", "base_check", "review", "wrapup", "scout", "turn"
  turn: number | null;
  round: number | null;
  outcome: string | null;
  result_status: string | null;
  verdict: string | null;
  findings: number | null;
  severe_findings: number | null;
  angle: string | null;
  account: string | null;
  reviewer: string | null;
  provider: string | null;
  model: string | null;
  task_type: string | null;
  ci: string | null; // only ci.outcome from the journal row
  note: string | null; // verdict only; one line, ≤ 200 chars
}

export interface Events {
  since: number;
  until: number;
  events: LogEvent[]; // ascending at, at most 5000 newest matching events
  truncated?: true; // present only when older matching events were dropped by the limit
}

/** GET /api/report: the same envelope as Accounts, with `report --json` output as `data`. */
export interface Report {
  fetched_at: number | null;
  error: string | null;
  data: unknown | null;
}

export interface TaskSummary {
  slug: string;
  kind: "work" | "review" | "scout" | "reflect" | "session";
  title: string | null; // desktop session title; null for tasks
  link: string | null; // claude://claude.ai/epitaxy/<sessionId>; null for tasks
  repo: string; // repository basename; see the session mapping in the contract
  branch: string | null;
  task_type: string | null; // e.g. "feature", "fix", "layout"
  executor: "codex" | "claude";
  account: string | null; // Codex account, or the Claude pool account for a Claude executor
  reviewer: "codex" | "claude" | null;
  model: string | null;
  effort: string | null;
  column: Column;
  phase: Phase;
  phase_started_at: number | null;
  alive: boolean; // task supervisor running, or session PID running with status busy
  turn: number; // turns so far
  fix_round: number; // automatic fix rounds in the current cycle
  outcome: string | null; // state.json "outcome" as written by the plugin
  result_status: string | null; // "done" | "partial" | "needs_decision" | "blocked" | null
  summary: string | null; // first line of the last result summary, ≤ 200 chars
  pr: string | null; // PR URL
  ci: string | null; // "pending" | "passed" | "failed" | "skipped" | "timeout" | "none" | null
  sleeping_until: number | null;
  created: number | null;
  updated_at: number; // task state mtime, or session lastActivityAt / 1000
  activity: Activity | null; // latest activity, only while alive
  scheduled?: string | null; // a session's scheduled task id; null for tasks; absent from older servers
  // What the task came back with ("cargo"); null and 0 for sessions and older records.
  check: string | null; // outcome of this turn's last saved check: "passed" | "failed" | "timeout" | …; null without one
  review: "clean" | "defects" | null; // the saved review's verdict
  findings_left: number; // findings in the saved review
  stop: string | null; // why the automatic fix loop stopped: "clean", "only P3", "base conflict", … ; one line
  left: number; // remaining items plus questions in the last result
}

export type TaskFile = "brief" | "last" | "review" | "check";

/** A repository's own map pictures, as URLs; a missing one falls back to the shared art. */
export interface RepoArt {
  sky?: string;
  planet?: string;
  emblem?: string;
}

/** By repository; repositories without art are absent. */
export type ArtIndex = Record<string, RepoArt>;

/** GET /api/constellations: groups of repositories the galaxy draws together; `*` in a pattern stands for any run. */
export interface Constellations {
  constellations: { name: string; repos: string[] }[];
  /** Why the file could not be read; null when it was, or when there is none. */
  error: string | null;
}

// Research: what the reflection learned from finished tasks (GET /api/research).

export type LessonStatus = "proposed" | "accepted" | "applied" | "declined" | "other";
export type Signal =
  | "blocked"
  | "refused"
  | "needs_decision"
  | "escalate"
  | "round_cap"
  | "fix_rounds"
  | "check_failed"
  | "ci_repair"
  | "budget_exhausted";

/** One row of the reflection index, in file order. */
export interface Lesson {
  date: string;
  entry: string;
  scope: "invariant" | "domain" | "other";
  scope_text: string;
  repos: string[]; // for a domain lesson, the repositories it names
  cue: string;
  status: LessonStatus;
  status_text: string;
  /** The lesson's own section in its report; absent on older servers. `evidence` keeps its line breaks. */
  title?: string | null;
  lesson?: string | null;
  proposal?: string | null;
  evidence?: string | null;
  caveats?: string | null;
  /** Files outside every git repository that the proposal names, as `~/…`; absent on older servers. */
  outside?: string[];
  /** The task that implements the lesson, the newest one; absent on older servers. */
  implementation?: Implementation | null;
}

/** A teamster task started by «Внедрить» to make a lesson's change and open its PR. */
export interface Implementation {
  slug: string;
  archived: boolean;
  alive: boolean;
  repo: string; // the repository's directory name
  result_status: string | null; // "done" | "partial" | "needs_decision" | "blocked" | null
  pr: string | null; // the PR's URL
  questions: string[];
  summary: string | null;
  created: number;
  updated_at: number;
}

/** «scanning» until the first search ends; «denied» when it skipped a repository it could not read. */
export type ReposAccess = "ok" | "scanning" | "denied";

/** A repository a lesson can be implemented in. */
export interface ResearchRepo {
  name: string;
  path: string;
}

/** The newest batch reflection. */
export interface ResearchBatch {
  name: string;
  date: string | null;
  through: string | null;
  records: number;
  repos: Record<string, number>;
}

export interface PendingRecord {
  slug: string;
  repo: string;
  stamp: string;
  signals: Signal[];
}

export interface StudyQuestion {
  text: string;
  options: string[];
}

/** An order, an analyst's report, or a lead's reply in a reflection task. */
export interface StudyMessage {
  at: number;
  from: "lead" | "analyst";
  text: string | null; // lead text is at most 4000 characters
  status: "done" | "needs_decision" | null;
  questions: StudyQuestion[];
  lessons: {
    id: string;
    cue: string;
    entry: string;
    scope: "invariant" | "domain" | null;
    lesson: string | null; // at most 600 characters
    proposal: string | null; // at most 600 characters
  }[];
  file: string | null;
}

/** A live or recently archived reflection task, newest first in ResearchView.studies. */
export interface Study {
  slug: string; // the task slug, without an archive timestamp
  archived: boolean;
  mode: "batch" | "study";
  alive: boolean;
  outcome: string | null;
  error: string | null; // at most 300 characters
  executor: string;
  account: string | null;
  created: number;
  updated_at: number;
  records: number;
  file: string | null;
  waiting: boolean; // not alive and the last message is an analyst asking for a decision
  messages: StudyMessage[]; // the order first, then reports and replies by at
}

/** A step of starting a lesson's implementation or a study, as the server reports it. */
export type LaunchStage = "accepting" | "fetching" | "worktree" | "preparing" | "starting" | "done" | "failed";

/**
 * A start the server runs in the background after `POST /api/actions/implement` or `/reflect` answered: in
 * `GET /api/research` while it goes and for 10 minutes after, and as a `launch` message at each change of stage.
 */
export interface Launch {
  slug: string; // the task's slug
  kind: "implement" | "reflect";
  entry: string | null; // implement: the lesson's entry
  repo: string | null; // implement: the repository's directory name
  stage: LaunchStage;
  steps: { stage: LaunchStage; at: number }[]; // the stages in order with their Unix time; the last one is `stage`
  error: string | null; // only when failed
  started_at: number;
}

/** The Claude desktop task that schedules batch reflection, in the server's local time zone. */
export interface ReflectionSchedule {
  source: "desktop";
  name: string | null;
  cron: string;
  enabled: boolean;
  last_run_at: number | null;
  last_scheduled_for: number | null;
  next_at: number | null;
}

export interface ResearchView {
  lessons: Lesson[];
  /** Where «Внедрить» can start a task; absent on older servers. */
  repos?: ResearchRepo[];
  /** Whether the search for `repos` could read every repository's disk; absent on older servers. */
  repos_access?: ReposAccess;
  studies: Study[];
  batch: ResearchBatch | null;
  /** Archived records after the newest batch: the next batch's material. */
  pending: { records: number; signals: number; repos: Record<string, number>; items: PendingRecord[] };
  /** Sessions whose `scheduled` is this id are runs of the reflection. */
  reflection_task: string;
  /** Absent on older servers; null when no matching desktop task exists. */
  schedule?: ReflectionSchedule | null;
  /** Whether the board runs the station's actions; absent on older servers, which only read. */
  actions?: ResearchActions;
  /** Starts that go on or ended in the last 10 minutes; absent on older servers. */
  launches?: Launch[];
}

/** Why the board only reads: started with --read-only, or no teamster command to run. */
export type ActionsOff = "read_only" | "no_teamster";

export interface ResearchActions {
  enabled: boolean;
  reason: ActionsOff | null;
}

export interface CargoCheck {
  command: string;
  outcome: string;
  exit: number | null;
  seconds: number | null;
  at: number | null;
}

export interface CargoFinding {
  id: string;
  severity: string;
  title: string;
  file: string | null;
  line: number | null;
}

export interface CargoCi {
  outcome: string | null;
  passed: number; // checks with bucket "pass"
  failed: number; // checks with bucket "fail" or "cancel"
  total: number;
  failing: string[]; // names of the failed checks, at most 10
  seconds: number | null;
  rounds: number; // CI repair rounds
  reason: string | null;
}

/** What a task came back with: its saved check, review, fix loop stop, CI, base merge and open items. */
export interface Cargo {
  check: CargoCheck | null; // the same entry as summary.check
  claims: { command: string; outcome: string; details: string }[]; // the executor's own report, at most 10
  review: {
    verdict: "clean" | "defects" | null;
    summary: string | null;
    findings: CargoFinding[]; // at most 30, in written order
    reviews: number; // reviews so far
  } | null;
  stop: string | null; // as summary.stop
  ci: CargoCi | null;
  base: { base: string; outcome: string; files: string[] } | null; // the last base merge; files at most 20
  remaining: string[]; // at most 20
  questions: string[]; // at most 20
  decisions: { fixed: number; rejected: number }; // the executor's decisions on review findings
}

/** A task's limits and the rounds it has spent against them. */
export interface TaskLimits {
  max_turn_minutes: number | null; // the turn's limit, minutes
  weekly_used_percent: number | null; // how much of the account's week the task has spent, %
  max_weekly_percent: number | null; // the task's budget, % of the week; null without a budget
  fix_rounds: number | null; // fix rounds allowed after a review
  review_rounds: number; // rounds done in the current cycle
  ci_rounds: number | null; // attempts allowed to repair CI
  ci_enabled: boolean;
  review_angles: string[];
  check: string | null; // the check's command
  rotations: { at: number; from: string | null; to: string | null; reason: string | null }[]; // account changes
}

/** A message to the task: the lead's order, a review's or CI's report. */
export interface TaskMessage {
  at: number;
  source: "lead" | "review" | "ci";
  text: string;
  queued_at?: number | null; // an order sent from the queue: when it was queued; absent from older servers
}

/** Orders queued with `say --queue` while the ship was busy: waiting for the end of its cycle, or dropped by it. */
export interface TaskQueue {
  waiting: { at: number; text: string }[];
  dropped: { at: number; text: string; dropped_at: number | null; outcome: string | null }[];
}

export interface TaskDetail extends TaskSummary {
  timeline: { at: number; text: string }[]; // task events (≤ 200), or session creation and last activity
  files: TaskFile[]; // which files exist
  cargo: Cargo | null; // null for sessions; always an object for tasks, possibly empty
  // Absent from older servers.
  limits?: TaskLimits | null; // null for sessions
  messages?: TaskMessage[];
  activity_log?: Activity[];
  /** `queue`: the installed teamster queues a say to a busy ship (1.60.0 and later); absent from older servers. */
  actions?: { enabled: boolean; reason: "read_only" | "no_teamster" | null; queue?: boolean };
  queue?: TaskQueue;
  /** The last result's summary in full, with its line breaks; null without one and for sessions. */
  report?: string | null;
  /** What the task's branch changed against its base; null when the worktree cannot be read, and for sessions. */
  changes?: TaskChanges | null;
}

/** GET /api/tasks/{slug}/feed: the agent's work by time. `cursor` continues it with `?after=`. */
export interface TaskFeed {
  items: FeedItem[];
  cursor: string; // opaque, stateless continuation token
  reset: boolean; // the feed is given anew: it replaces the items shown before
  truncated: boolean; // older work did not fit
}

/** One step of the agent's work: `message` and `thinking` keep their line breaks (≤ 4000 chars), the rest is one line. */
export interface FeedItem {
  at: number;
  kind: "message" | "thinking" | "command" | "edit" | "tool";
  text: string;
}

/** The branch against its base: commits, the files and lines of `git diff --shortstat`, and uncommitted paths. */
export interface TaskChanges {
  commits: number;
  files: number;
  insertions: number;
  deletions: number;
  uncommitted: number;
}

export interface Accounts {
  fetched_at: number | null;
  error: string | null;
  data: unknown | null; // `accounts --json` output, passed through unchanged
}

export interface Gpu {
  name: string;
  utilization_percent: number | null;
  memory_used_bytes: number | null; // null on Apple: the memory is shared, there is no video memory line
  memory_total_bytes: number | null;
  processes: { name: string; memory_bytes: number }[];
}

export interface Metrics {
  os: string;
  cpu: {
    cores: number;
    load1: number;
    load5: number;
    percent: number | null; // busy share of all cores over about 1 s, 0–100; null when unknown
    average_percent?: number | null; // mean of percent over the last 150 s, the status follows it; null for hosts
  } | null;
  memory: { total_bytes: number; available_bytes: number } | null;
  gpus: Gpu[];
  disks: { mount: string; total_bytes: number; free_bytes: number }[];
}

export type MachineStatus = "free" | "busy" | "overloaded" | "offline" | "unknown";
export type MachineError = "timeout" | "unreachable" | "bad_output" | "probe_failed";

/** The hypervisor or host a machine runs on; shown for context, never part of the status. */
export interface HostView {
  name: string;
  cpu: Metrics["cpu"];
  memory: Metrics["memory"];
  error: MachineError | null;
}

export interface HistoryPoint {
  at: number;
  cpu_percent: number | null; // cpu.percent, else load1 / cores × 100 capped at 100
  memory_percent: number | null;
  gpu_percent: number | null;
}

export interface Machine {
  id: string;
  name: string;
  role: string | null;
  status: MachineStatus;
  reasons: string[]; // "cpu", "memory", "gpu", "gpu_memory", "disk:<mount>"
  checked_at: number | null; // last attempt
  sampled_at: number | null; // last success; the metrics stay after a failure
  error: MachineError | null;
  metrics: Metrics | null;
  host: HostView | null;
  history: HistoryPoint[]; // up to 120 points, one per 30 s
}

export interface Machines {
  config_error: string | null;
  items: Machine[];
}

export interface Snapshot {
  generated_at: number;
  tasks: TaskSummary[]; // all non-closed tasks, plus at most 50 closed records with the newest updated_at
  accounts: Accounts;
  machines?: Machines; // missing from an older server
}

// WebSocket /ws, server → client only.
export type ServerMessage =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "task"; task: TaskSummary }
  | { type: "task_removed"; slug: string }
  | { type: "activity"; slug: string; activity: Activity }
  | { type: "event"; event: LogEvent }
  | { type: "accounts"; accounts: Accounts }
  | { type: "machines"; machines: Machines }
  | { type: "launch"; launch: Launch }
  | { type: "ping"; at: number };
