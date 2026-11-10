# Board data contract (v1)

The board is a local web view of teamster tasks and Claude Code sessions from the Claude
desktop app. The server reads existing files and pushes changes over a WebSocket. Task orders and
science station actions run the installed `teamster` command: replies, verdicts, reviews, stopping
and cleaning tasks, lesson decisions, implementations and new reflection orders.

## Sources

- Task home: the worker's data home, resolved by the worker's rules: `$TEAMSTER_HOME`; else the path in
  `$CODEX_TASK_HOME/teamster-home`, else `$CODEX_TASK_HOME` (legacy); else `~/.teamster` if it exists, else
  `~/.codex` (legacy) if it holds `claude-tasks/` or `codex-worker.json`, else `~/.teamster`. Live tasks are
  in `tasks/<slug>/` (legacy: `claude-tasks/<slug>/`), archived ones in `tasks/.archive/<slug-and-timestamp>/`
  (legacy: `claude-tasks/.archive/`). Each holds `state.json` and, when present, `brief.md`,
  `last.md`, `review.md`, `check.log`, `messages.jsonl`.
- Live activity: `events.jsonl` (Codex executor, `codex exec --json` lines) and `claude-events.jsonl` (Claude
  executor, `claude --output-format stream-json` lines; written by teamster 1.47+). Either may be missing.
- Completed events: `log.jsonl` in the task home (legacy: `codex-worker-log.jsonl`), one JSON line per
  completed phase (`work`, `fix`, `check`, `base_check`, `review`, `wrapup`, `scout`, `turn`) or lead
  verdict (`kind: "verdict"`). The server keeps a byte cursor and reads only appended complete lines;
  an incomplete final line waits for a newline. A smaller file or a new inode resets the cursor and
  replaces the cached events. Missing files give an empty history; symbolic links are never opened.
  Malformed lines, unknown kinds and lines without a finite numeric `at` are skipped. Only the
  `LogEvent` fields below are retained, for the last 31 days, in memory; no history is written.
- Accounts: `python3 -I <script> accounts --json` (never `--refresh`), at most once per
  `BOARD_ACCOUNTS_SECONDS` (default 300). The script path comes from `BOARD_TEAMSTER_COMMAND`, then `BOARD_CODEX_TASK` and defaults to this
  repository's `src/teamster/__main__.py`. When the journal tail reads a new row with
  `"event": "account_login"` and a finite `at`, the next accounts call runs at once, ignoring that
  interval, and its result goes out as the usual `accounts` message. Such forced calls start at most once
  per 5 seconds; rows read during that pause or during a running call share one call after it, unless a
  periodic call that starts after they were read comes first. The pause never delays periodic calls. Rows
  present when the server starts, or re-read after the journal is replaced, force none. These rows are
  not `LogEvent`s.
- Reports: `python3 -I <script> report --json --since <date> [--by <dimensions>]`, using the same script
  as accounts. Both commands have a 60-second timeout and a 1 MiB stdout limit. Report stderr goes
  only to server logs; accounts errors retain their stderr reason. A report response is cached for
  60 seconds per `(since, by)` pair, including errors;
  a failed refresh retains the pair's previous successful data.
- Machines: `$BOARD_MACHINES_FILE` (default `board-machines.json` in the task home), with local or SSH
  probes every `BOARD_MACHINES_SECONDS` (default 30). The configuration and probe are described below.
- Desktop sessions: `$BOARD_CLAUDE_DESKTOP_DIR/claude-code-sessions/*/*/local_*.json` (default desktop
  directory `~/Library/Application Support/Claude`). These are internal application files, not a public
  API. Only `sessionId`, `cliSessionId`, `title`, `cwd`, `originCwd`, `model`, `effort`, `isArchived`,
  `createdAt`, `lastActivityAt`, `completedTurns`, `interruptedAwaitingPerson`, `scheduledTaskId`, and `prs`
  are retained.
  For each PR, only `url`, `state`, `branch`, and `own` are retained. Other fields are never exposed.
- Live sessions: `$BOARD_CLAUDE_HOME/sessions/<pid>.json` (default home `~/.claude`), with numeric filenames
  only. The fields used are `pid`, `sessionId` (the metadata's `cliSessionId`), `cwd`, `status`,
  `statusUpdatedAt`, and `entrypoint`. A state is valid only while its PID is alive. Files such as
  `<pid>.<hash>.key` are never opened.
- Session activity: `$BOARD_CLAUDE_HOME/projects/<encoded-cwd>/<cliSessionId>.jsonl`, where every character
  outside ASCII letters and digits in the live cwd is replaced by `-`. Only busy, live sessions are
  tailed through the same bounded incremental reader as task activity. Until a transcript is found,
  check the direct path on each poll and search `projects/*/` at most once per 60 seconds. Cache a found
  path. Assistant events may carry ISO `timestamp` values.
- Map art: `board-art/<repo>/` in the task home, holding any of `sky.jpg`, `planet.png` and `emblem.png`. It stays
  outside the repository because project names and themes can be private, and is written by hand.
- Constellations: `board-constellations.json` in the task home, written by hand and read on each request, for the same
  reason kept outside the repository: `{"constellations": [{"name": "MyWallet", "repos": ["mytonwallet-*", "my-pulse"]}]}`.
- Reflection: `tasks/.archive/INDEX.md` (the lesson table), `tasks/.archive/batch-<YYYY-MM-DD>[suffix].md`
  (batch reviews, each with a `through: <stamp>` line), archived records' `state.json`, and live and archived
  reflect tasks' `state.json` and `messages.jsonl`, read for `GET /api/research` as described below.
- The server never reads `auth.json`, credentials or account homes.

Missing directories are skipped. Malformed metadata or live-state files preserve their last valid
record. Symbolic links are never followed. Metadata scans run once per `BOARD_SESSIONS_SECONDS`
(default 5); a file is read only when its mtime or size changes. Archived metadata retains only the
information needed to detect a change. Live session state is read on each board poll.

## Types

All times are Unix seconds (float) or `null`. Strings that come from task text are cut to the stated length.

```ts
type Column = "running" | "sleeping" | "review_me" | "attention" | "closed";
type Phase = "turn" | "check" | "review" | "fix" | "ci" | "sleeping" | "idle";

interface Activity {
  at: number | null;
  kind: "command" | "edit" | "message" | "tool" | "thinking";
  text: string;               // one line, ≤ 200 chars
}

interface LogEvent {
  at: number;
  started: number | null;
  slug: string | null;
  repo: string | null;
  kind: "work" | "review" | "scout" | "verdict";
  phase: string | null;
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
  ci: string | null;          // only ci.outcome from the journal row
  note: string | null;        // verdict only; one line, ≤ 200 chars
}

interface Events {
  since: number;
  until: number;
  events: LogEvent[];         // ascending at, at most 5000 newest matching events
  truncated?: true;          // present only when older matching events were dropped by the limit
}

interface TaskSummary {
  slug: string;
  kind: "work" | "review" | "scout" | "reflect" | "session";
  title: string | null;       // desktop session title; null for tasks
  link: string | null;        // claude://claude.ai/epitaxy/<sessionId>; null for tasks
  repo: string;               // repository basename; see session mapping below
  branch: string | null;
  task_type: string | null;   // e.g. "feature", "fix", "layout"
  executor: "codex" | "claude";
  account: string | null;     // Codex account, or the Claude pool account for a Claude executor
  reviewer: "codex" | "claude" | null;
  model: string | null;
  effort: string | null;
  column: Column;
  phase: Phase;
  phase_started_at: number | null;
  alive: boolean;             // task supervisor running, or session PID running with status busy
  turn: number;               // turns so far
  fix_round: number;          // automatic fix rounds in the current cycle
  outcome: string | null;     // state.json "outcome" as written by the plugin
  result_status: string | null; // "done" | "partial" | "needs_decision" | "blocked" | null
  summary: string | null;     // first line of the last result summary, ≤ 200 chars
  pr: string | null;          // PR URL
  ci: string | null;          // "pending" | "passed" | "failed" | "skipped" | "timeout" | "none" | null
  sleeping_until: number | null;
  created: number | null;
  updated_at: number;         // task state mtime, or session lastActivityAt / 1000
  activity: Activity | null;  // latest activity, only while alive
  scheduled: string | null;   // session scheduledTaskId; null for tasks
  // Cargo fields (see "Task cargo" below); null and 0 for sessions.
  check: string | null;       // outcome of the current turn's latest check ("passed" | "failed" | "timeout" | …)
  review: "clean" | "defects" | null; // review_result.verdict
  findings_left: number;      // object entries of review_result.findings
  stop: string | null;        // auto_fix_stop: why the automatic cycle stopped, one line ≤ 200 chars
  left: number;               // result.remaining lines plus result.questions lines
}

interface TaskDetail extends TaskSummary {
  timeline: { at: number; text: string }[];   // task events (≤ 200), or session creation and last activity
  files: ("brief" | "last" | "review" | "check")[];   // which files exist
  cargo: Cargo | null;        // always an object for tasks, possibly empty; null for sessions
  limits: TaskLimits | null;  // null for desktop sessions
  messages: TaskMessage[];    // ≤ 50 newest by at, ascending at; [] for sessions
  activity_log: Activity[];   // ≤ 10 latest, newest first; [] unless the task is alive; [] for sessions
  actions: { enabled: boolean; reason: "read_only" | "no_teamster" | null; // same as ResearchView.actions
             queue: boolean };   // the installed teamster queues say to a busy task (1.60.0 and later)
  queue: TaskQueue;           // queue.json; empty lists for sessions
}

interface TaskQueue {         // orders sent with `say --queue` while the task was busy; options are not exposed
  waiting: { at: number; text: string }[];   // sent as one turn when the current cycle completes
  dropped: { at: number; text: string; dropped_at: number | null; outcome: string | null }[];
  // dropped when the cycle ended otherwise: outcome "stopped", "interrupted", "failed", …
}

interface TaskLimits {
  max_turn_minutes: number | null;
  weekly_used_percent: number | null;
  max_weekly_percent: number | null; // state.max_task_weekly_percent
  fix_rounds: number | null;        // permitted review fix rounds, state.fix_rounds
  review_rounds: number;            // completed rounds in this cycle, len(state.rounds); 0 without a list
  ci_rounds: number | null;         // permitted CI repair attempts, state.ci_rounds
  ci_enabled: boolean;             // state.ci_enabled is true or state.ci_command is a nonempty string
  review_angles: string[];          // state.review_angles only if a list of strings, else []
  check: string | null;            // state.check, one line ≤ 200 chars
  rotations: { at: number; from: string | null; to: string | null; reason: string | null }[];
  // state.rotations: ≤ 20 newest by at, ascending at; strings are one line ≤ 200 chars
}

interface TaskMessage {
  at: number;
  source: "lead" | "review" | "ci"; // claude, missing and any other source map to lead
  text: string;                    // ≤ 4000 chars
  queued_at: number | null;        // when an order sent from the queue was queued; null otherwise
}

interface Cargo {             // every string is one line, ≤ 200 chars
  check: {                    // the same entry as summary.check
    command: string;          // "cmd"
    outcome: string;
    exit: number | null;
    seconds: number | null;
    at: number | null;
  } | null;
  claims: { command: string; outcome: string; details: string }[]; // result.checks, the executor's own report, ≤ 10
  review: {
    verdict: "clean" | "defects" | null;
    summary: string | null;
    findings: { id: string; severity: string; title: string; file: string | null; line: number | null }[]; // ≤ 30
    reviews: number;          // len(reviews)
  } | null;
  stop: string | null;        // as summary.stop
  ci: {
    outcome: string | null;
    passed: number;           // checks with bucket "pass"
    failed: number;           // checks with bucket "fail" or "cancel"
    total: number;            // all checks
    failing: string[];        // names of the failed checks, ≤ 10
    seconds: number | null;
    rounds: number;           // CI repair rounds, 0 when absent
    reason: string | null;
  } | null;
  base: { base: string; outcome: string; files: string[] } | null; // last base merge; files ≤ 20
  remaining: string[];        // result.remaining, ≤ 20
  questions: string[];        // result.questions, ≤ 20
  decisions: { fixed: number; rejected: number }; // result.findings by decision
}

interface Accounts {
  fetched_at: number | null;
  error: string | null;
  data: unknown | null;       // `accounts --json` output, passed through unchanged
}

interface Gpu {
  name: string;
  utilization_percent: number | null;
  memory_used_bytes: number | null; // null on Apple GPUs with shared memory
  memory_total_bytes: number | null;
  processes: { name: string; memory_bytes: number }[]; // ≤ 5 largest, each ≥ 100 MiB
}

interface Metrics {
  os: "linux" | "darwin" | string;
  cpu: {
    cores: number;
    load1: number;
    load5: number;
    percent: number | null; // busy share of all cores over about 1 s, 0–100; null when unknown
    average_percent: number | null; // mean of percent over the last 150 s; set by the server, null for hosts
  } | null;
  memory: { total_bytes: number; available_bytes: number } | null;
  gpus: Gpu[];
  disks: { mount: string; total_bytes: number; free_bytes: number }[];
}

type MachineStatus = "free" | "busy" | "overloaded" | "offline" | "unknown";
type MachineError = "timeout" | "unreachable" | "bad_output" | "probe_failed";

interface HostView {
  name: string;
  cpu: Metrics["cpu"];
  memory: Metrics["memory"];
  error: MachineError | null;
}

interface HistoryPoint {
  at: number;
  cpu_percent: number | null;    // cpu.percent, else load1 / cores × 100 capped at 100
  memory_percent: number | null; // (total_bytes - available_bytes) / total_bytes × 100
  gpu_percent: number | null;    // highest available GPU utilization
}

interface Machine {
  id: string;
  name: string;
  role: string | null;
  status: MachineStatus;
  reasons: string[];            // cpu, memory, gpu, gpu_memory or disk:<mount>
  checked_at: number | null;    // last attempt
  sampled_at: number | null;    // last success
  error: MachineError | null;   // last attempt's error
  metrics: Metrics | null;      // last successful metrics, retained after a failure
  host: HostView | null;        // optional physical host; never affects machine status
  history: HistoryPoint[];      // newest 120 points, held only in memory
}

interface Machines {
  config_error: string | null;
  items: Machine[];
}

interface RepoArt {           // only the pictures that exist; each value is a URL for GET /api/art/{repo}/{file}
  sky?: string;
  planet?: string;
  emblem?: string;
}

type ArtIndex = Record<string, RepoArt>;   // by `repo`; repositories without pictures are absent

interface Snapshot {
  generated_at: number;
  tasks: TaskSummary[];       // all non-closed tasks, plus at most 50 closed records with the newest updated_at
  accounts: Accounts;
  machines: Machines;
}

type LessonStatus = "proposed" | "accepted" | "applied" | "declined" | "other";
type Signal = "blocked" | "refused" | "needs_decision" | "escalate" | "round_cap"
  | "fix_rounds" | "check_failed" | "ci_repair" | "budget_exhausted";

interface Lesson {             // one row of INDEX.md, in file order
  date: string;                // first column as written
  entry: string;
  scope: "invariant" | "domain" | "other";
  scope_text: string;          // the scope column as written
  repos: string[];             // for domain: the names after "domain", split on commas and spaces; otherwise []
  cue: string;
  status: LessonStatus;        // first word: proposed / accepted / applied / declined, else other
  status_text: string;         // the status column as written
  title: string | null;        // own archive file's lesson heading
  lesson: string | null;       // own section's fields, trimmed, ≤ 2000 chars each
  proposal: string | null;
  evidence: string | null;     // preserves line breaks, including evidence lists
  caveats: string | null;
  implementation: Implementation | null;
}

interface Implementation {
  slug: string;               // teamster slug, without the archive timestamp suffix
  archived: boolean;
  alive: boolean;             // supervisor PID is alive
  repo: string;               // repository directory name, as in TaskSummary
  result_status: string | null; // as in TaskSummary
  pr: string | null;          // as in TaskSummary
  questions: string[];       // cargo.questions, at most 20
  summary: string | null;     // last result's heading or summary, at most 600 chars
  created: number;
  updated_at: number;
}

interface ResearchBatch {      // the batch file with the greatest `through:` stamp
  name: string;                // file name, e.g. "batch-2026-11-07b.md"
  date: string | null;         // YYYY-MM-DD from the file name
  through: string | null;
  records: number;             // archived records with previous batch's through < stamp <= through
  repos: Record<string, number>;  // the same records counted by repository directory name
}

interface PendingRecord { slug: string; repo: string; stamp: string; signals: Signal[]; }

interface StudyQuestion { text: string; options: string[]; }

interface StudyMessage {
  at: number;
  from: "lead" | "analyst";
  text: string | null;        // lead: order or say, ≤ 4000 chars; analyst: summary
  status: "done" | "needs_decision" | null; // analyst only
  questions: StudyQuestion[]; // analyst only; options[i] belongs to questions[i]
  lessons: {
    id: string;
    cue: string;
    entry: string;            // "<file> <id>", as in INDEX.md
    scope: "invariant" | "domain" | null;
    lesson: string | null;    // as written, ≤ 600 chars
    proposal: string | null;  // as written, ≤ 600 chars
  }[];
  file: string | null;        // analyst only
}

interface Study {
  slug: string;              // teamster slug: no archive timestamp suffix
  archived: boolean;
  mode: "batch" | "study";
  alive: boolean;            // supervisor PID is alive
  outcome: string | null;
  error: string | null;      // ≤ 300 chars
  executor: string;
  account: string | null;
  created: number;
  updated_at: number;
  records: number;           // length of reflect_records
  file: string | null;
  waiting: boolean;          // not alive and last message is analyst needs_decision
  messages: StudyMessage[];  // initial order first, then lead say and analyst turns in ascending at
}

interface ReflectionSchedule {
  source: "desktop";
  name: string | null;         // displayName
  cron: string;                // cronExpression, trimmed at both ends
  enabled: boolean;
  last_run_at: number | null;   // lastRunAt, Unix seconds
  last_scheduled_for: number | null; // lastScheduledFor, Unix seconds
  next_at: number | null;       // next instant strictly after now, or null
}

interface ResearchView {
  actions: { enabled: boolean; reason: "read_only" | "no_teamster" | null };
  lessons: Lesson[];
  repos: { name: string; path: string }[]; // known local git repositories, at most 100
  repos_access: "ok" | "scanning" | "denied";
  studies: Study[];           // live and recent archived reflect tasks, newest created first, at most 20
  batch: ResearchBatch | null;
  pending: {
    records: number;           // archived records with stamp > batch.through (all records when batch is null)
    signals: number;           // how many of them have at least one signal
    repos: Record<string, number>;  // records with a signal, by repository directory name
    items: PendingRecord[];    // records with a signal, newest first, at most 50
  };
  reflection_task: string;     // scheduled task id of reflection sessions, from BOARD_REFLECTION_TASK
  schedule: ReflectionSchedule | null; // desktop schedule; optional in the web type for older servers
}
```

### Machine configuration and probes

See [machines.example.json](machines.example.json) for a configuration containing only fictitious
machines. The file is an object with a `machines` array. Each entry requires a unique `id` matching
`^[a-z0-9-]+$` and a `name`. Exactly one of `local: true` or `ssh` selects its probe transport. Optional
`role` describes its purpose; optional `disks` is an array of absolute paths, defaulting to `["/"]`.
Optional `host: {"name": "Hypervisor", "ssh": "root@hypervisor.example"}` describes a VM's physical
host. Only its CPU and memory are published.

Every SSH target, including a host's target, must match `^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$` and cannot
start with `-`. An invalid entry rejects the entire file. The server rereads it when its mtime or size
changes. A missing file means an empty machine list with no error. A malformed or invalid file keeps
the last valid machines and sets `config_error` to a short reason without revealing an SSH target.
Targets never appear in REST or WebSocket data, including errors.

The server sends the standalone, Python 3.9-compatible `probe.py` as stdin to
`python3 -I - <disks…>` locally, or to
`ssh -o BatchMode=yes -o ConnectTimeout=5 -- <target> python3 -I - <disks…>` remotely. Remote paths are
quoted with `shlex.quote`. Probes run in parallel; each has a 15-second limit and at most 1 MiB of
stdout is read. A timed-out process is killed and awaited. Output is untrusted: fields are converted
and validated and strings are limited to 200 characters. Malformed output gives `bad_output`.
SSH exit code 255 gives `unreachable`, other nonzero exits give `probe_failed`, and expiry gives
`timeout`. Stderr is retained only in server logs.
Physical host probes use the same transport with an internal `--host` argument, collecting CPU and
memory only and skipping GPU commands.

The probe only reads state; it does not write files, control services or containers, or use sudo.
Each external command has a 5-second timeout and `stdin=DEVNULL`. It prints one JSON object and exits
successfully even when some sections are unavailable: those sections are `null` or empty arrays.
CPU uses `os.cpu_count` and `os.getloadavg`. `percent` is the busy share of all cores over one
second: on Linux, two reads of the aggregate `cpu` line of `/proc/stat` one second apart, with
`idle + iowait` as idle time; on macOS, the last `CPU usage: … % idle` line of `top -l 2 -n 0 -s 1`
(the first sample counts since boot), as `100 − idle`. A failed or unparsable sample gives `null`.
Host probes collect `percent` too. Load average is reported but is no measure of use on macOS: it has been
seen at twelve times the core count while the CPU was 64% idle.
The server accepts `percent` from 0 to 100; a probe without the field gives `null`. Linux memory uses `/proc/meminfo` (`MemTotal` and
`MemAvailable`), while macOS uses `sysctl -n hw.memsize` and the final system-wide free percentage
from `memory_pressure`. Available macOS memory is that fraction of total memory. Disks use
`os.statvfs`: total is `f_blocks × f_frsize`, free is `f_bavail × f_frsize`; missing paths are skipped.

NVIDIA metrics use `nvidia-smi` GPU queries for index, UUID, name, utilization, used memory and total
memory, and compute-app queries for GPU UUID, process name and used memory. UUID associates processes
with their GPU, `[N/A]` becomes `null`, and a missing or failed command yields an empty GPU list.
Apple GPU utilization comes from `ioreg -r -d 1 -c IOAccelerator` (`Device Utilization %`), with the
name from `sysctl -n machdep.cpu.brand_string`; GPU memory is `null` because memory is shared.
Process names are the last path component. For `python…`, `node` or `java` under `/.venv/` or `/venv/`,
the directory immediately before that segment is used instead. For example,
`/x/decider/.venv/bin/python` becomes `decider`, and `/x/build/bin/llama-server` becomes `llama-server`.
Full process paths are never published.

### Machine status and history

Status uses the machine's last successful metrics and consecutive failure count. Before any attempt,
status is `unknown`; a failure without prior successful metrics or two consecutive failures gives
`offline`. Both statuses, and `free`, have empty `reasons`. After one failed attempt with prior data,
the previous metrics still determine status and `error` describes the failed attempt. Host metrics
never affect status.

The pure `machine_status(metrics, failures)` function uses these thresholds, defined as named
constants in `machines.py`. The highest matching severity wins; reasons include every triggered
condition at that severity or above, including all applicable disk mounts.

| Condition | `busy` threshold | `overloaded` threshold | Reason |
| --- | --- | --- | --- |
| CPU `average_percent` (or `percent` before it exists) | ≥ 70% | ≥ 90% | `cpu` |
| CPU load1 / cores, only when `percent` is `null` | ≥ 0.7 | ≥ 1.5 | `cpu` |
| Available memory / total | < 25% | < 10% | `memory` |
| GPU utilization | ≥ 70% | — | `gpu` |
| GPU used memory / total | ≥ 60% | — | `gpu_memory` |
| Disk free space / total | < 15% | < 5% | `disk:<mount>` |

Otherwise status is `free`. One-second CPU samples jump, so the status follows their mean over the last
150 seconds, which is about six samples at the default interval. History retains at most 120 samples in memory and is reset on server
restart. A successful machine probe appends one point; failed probes retain history without adding
a point. Unknown percentages are `null`. `cpu_percent` is the busy percentage, or load1 / cores × 100
capped at 100 when the percentage is unknown, so every history value is between 0 and 100.

### Columns

- `running`: `alive` and not sleeping.
- `sleeping`: `outcome == "sleeping"` and `alive`.
- `review_me`: not `alive`, `result_status == "done"` and the outcome is not a failure — waiting for the lead.
- `attention`: not `alive` and anything else (`needs_decision`, `blocked`, `partial`, `failed`, `stopped`,
  `budget_exhausted`, `conflict`, a supervisor that died with `outcome == "running"` or `"sleeping"`).
- `closed`: archived records, non-alive scouts regardless of outcome, and non-alive tasks whose `updated_at`
  is older than `BOARD_STALE_DAYS` (default 7 days). Age never closes an alive task. `Snapshot.tasks` includes
  at most 50 closed records across archive and live task folders together, ranked by newest `updated_at`.
  Closed classification takes precedence over the other columns.

### Task cargo

What a task brought back and whether it can be accepted. Everything comes from the task's `state.json`, which
the supervisor writes; `check_start`, `auto_fix_stop`, `review_result`, `ci` and `base_merges` describe the
current turn (the first is set and the rest are cleared when a turn starts). The five `TaskSummary` fields are
recomputed with the summary on every `state.json` change; `TaskDetail.cargo` is built only for
`GET /api/tasks/{slug}`. The fields are additive: older records give `null`, `0` and empty lists, and older
clients ignore them.

- Current check: the last entry of `checks[check_start:]`; one that is not an object means no check. A missing or non-integer `check_start`
  counts as 0, so a record without it uses the last of all checks; a `check_start` beyond the list means the
  turn has no check (`null`). `summary.check` is its `outcome`; `cargo.check` carries its `cmd` as `command`,
  `outcome`, integer `exit`, and numeric `seconds` and `at`.
- `claims`: the first 10 entries of `result.checks` — the executor's own report, not a check the supervisor ran.
- Review: `review_result`. `verdict` is kept only when it is `clean` or `defects`. `summary.findings_left`
  counts all object entries of its `findings`; `cargo.review.findings` keeps the first 30 in recorded order with
  `id`, `severity`, `title`, `file` and integer `line`. `reviews` is the length of `state.reviews`.
- `stop`: `auto_fix_stop`, such as `clean`, `only P3`, `check failed`, `check timeout`, `base conflict`,
  `escalate`, `budget`, `budget_exhausted`, `result partial`, `result blocked`, `result needs_decision`,
  `review unknown`, `review refused`, `rounds_exhausted` or `stopped`; other values pass through.
- CI: `ci`, with its `checks` counted by `bucket`: `pass` is passed, `fail` and `cancel` are failed, and
  `failing` lists the first 10 failed names. `rounds` is 0 when absent.
- `base`: the last entry of `base_merges` (`null` when it is not an object), with its first 20 `files`.
- Open work: `result.remaining` and `result.questions`, at most 20 each in `cargo`; `summary.left` counts all
  of them. `decisions` counts the `result.findings` entries whose `decision` is `fixed` or `rejected`.

Strings are collapsed to one line and cut to 200 characters; required strings are `""` when missing, optional
ones `null`. A field of the wrong type — a string instead of a list, a number instead of an object, a list item
that is not an object, a non-string where a string is expected — counts as missing and never raises.

### Desktop session mapping

Sessions use the same `TaskSummary`, with these values:

- `slug` is `sessionId` (`local_<uuid>`); `kind` is `session`, `executor` is `claude`.
- `title` comes from metadata; `link` is `claude://claude.ai/epitaxy/<sessionId>`.
- `reviewer`, `task_type`, `account`, `ci`, `outcome`, `result_status`, `summary`, `sleeping_until`, `check`,
  `review` and `stop` are `null`; `fix_round`, `findings_left` and `left` are 0; the detail's `cargo` is `null`. `model` and `effort` come from metadata; `turn` is `completedTurns`.
- `repo` comes from `originCwd`, falling back to `cwd`: for a path containing `/.claude/worktrees/`,
  use the directory name immediately before that segment; otherwise use the last directory name.
  An application service directory inside `BOARD_CLAUDE_DESKTOP_DIR` gives `"(no folder)"`.
- `pr` is the last PR URL with `own == true`, otherwise the last PR URL. `branch` is the last own PR's
  branch, or `null` if there is no own PR.
- `alive` requires live state matching `cliSessionId`, a running PID, and `status == "busy"`.
  `phase` is `turn` when alive, otherwise `idle`; `phase_started_at` is the live `statusUpdatedAt` when
  alive, otherwise metadata `lastActivityAt`. `activity` is shown and emitted only when alive and its
  `at` is at least the current busy state's `statusUpdatedAt` (in seconds). Leaving busy clears it.
- `created` and `updated_at` are metadata `createdAt` and `lastActivityAt`. Metadata and live-state
  millisecond timestamps are converted to Unix seconds.
- `scheduled` is the metadata `scheduledTaskId` when it is a nonempty string, otherwise `null`. The daily
  batch reflection runs as a scheduled session whose id equals `ResearchView.reflection_task`.

Session columns use the first matching rule:

1. `isArchived`: omit the session entirely, including from `closed`.
2. `alive`: `running`.
3. `interruptedAwaitingPerson` is not `null`: `attention`.
4. At least one PR exists and all PR states are `MERGED` or `CLOSED`: `closed`.
5. `lastActivityAt` is older than `BOARD_SESSION_STALE_HOURS` (default 48 hours): `closed`.
6. Otherwise: `review_me`, waiting for a person after a completed turn.

Closed sessions and tasks share the limit of 50 records, ranked by `updated_at`.
The additional fields are additive; existing clients may ignore `title` and `link`.

### Research

`ResearchView` describes reflection conversations (`src/teamster/docs/reflection.md`), what they learned and
what waits for the next batch, including its planned schedule. Material and lessons live in `tasks/.archive/`:

- `lessons`: the rows of the markdown table in `INDEX.md`, skipping the header and separator rows. A row needs
  at least five cells; cells after the fourth (a `|` inside the text) are joined back into `status_text`.
  Shorter or empty rows are skipped.
  `accepted` means the lead agreed with a lesson but has not applied it yet.
- Each lesson's `entry` is `<file> <id>`, such as `batch-2026-11-09.md W2`. The five text fields
  `title`, `lesson`, `proposal`, `evidence` and `caveats` come only from that lesson's own
  `batch-*.md` or `study-*.md` file in the archive. The first heading of level 2–4 beginning with
  `<id>.` or `<id> ` opens the section; the next heading of the same or higher level closes it.
  `title` is the trimmed heading remainder. Fields begin at lines starting with `cue:`, `lesson:`,
  `evidence:`, `scope:`, `earlier:`, `caveats:` or `proposal:`. A value includes the text after the
  colon and every following line up to another field or the section's end, preserving line breaks.
  Values are trimmed and cut to 2000 characters; empty or missing fields, files or sections give `null`.
  Later files' additions are ignored. Lesson files share the batch file signature cache and 64 KiB
  read limit, and symbolic links are skipped.
- `repos`: `state.json`'s `repo` from all live task and archive directories, excluding `kind: "scout"`,
  `kind: "reflect"` and the archive directory itself. A missing `kind` counts as work.
  Only existing repositories whose common git directory's `config` contains a `[remote "origin"]`
  section with a nonempty `url` remain, so they can be used by `teamster start`.
  A linked worktree's `.git` file supplies `gitdir: <path>` (relative paths start at the worktree).
  When that git directory has `commondir`, resolve its value relative to the git directory and use
  the common git directory's parent as the main repository. Otherwise, a git directory ending in
  `/.git/worktrees/<name>` identifies the main repository before `/.git`. Missing or invalid targets
  are skipped. Discovery reads files only; it runs neither git nor subprocesses. Git metadata files
  and their immediate directories that are symbolic links are skipped; metadata reads are limited
  to 64 KiB per file. Main repository paths are resolved and deduplicated; `name` is the resolved
  directory's name. Sort by `name`, then `path`, retaining at most 100. This list is independent of
  the batch and study age windows.
- `repos_access`: `"scanning"` until the first repository search finishes; `"denied"` when the last
  completed search skipped at least one repository because its `.git` access probe failed or timed out;
  otherwise `"ok"`. Missing repositories or `.git` paths are skipped without setting `"denied"`.
  Before reading a repository's git metadata, discovery opens and closes its `.git`
  with a 3-second timeout in a daemon thread. At most one pending probe per device is allowed; another
  probe on that device immediately reports a timeout until the pending probe returns.
- `implementation`: the task with the greatest `created` across live tasks and all archive records whose
  slug starts with `lesson-` and whose first `brief.md` line matches `^Внедрить урок «([^»]+)»`.
  The captured text, trimmed at both ends, must equal the lesson's `entry`; otherwise the field is `null`.
  Archived slugs omit their timestamp suffix. Fields use the same calculation as `TaskSummary` and
  `cargo.questions`, including PR precedence and string limits. `created` falls back to the state's
  file mtime when missing; `updated_at` is that mtime. Brief files that are symbolic links are skipped.
- `batch`: among the `batch-*.md` files, the one with the greatest stamp on its first `through:` line; a file
  without one ranks lowest. Its `records` are the archived records whose stamp is greater than the next lower
  batch's `through` and at most its own.
- Records are directories `<slug>-<stamp>` with `stamp` like `20261107T051647Z`. A record's repository is the
  last path component of `state.json`'s `repo`, or `"(unknown)"`. Records with `kind: "reflect"` are studies,
  excluded from `batch.records`, `batch.repos`, `pending` and all material signals. Only `state.json` is used for signals:
  - `blocked`, `needs_decision`: `result.status`; `refused`: `result.status` or `outcome` is `refused`;
  - `escalate`: `auto_fix_stop` is `escalate`; `round_cap`: `auto_fix_stop` is `rounds_exhausted`,
    `check <outcome>` or `base conflict` (the round cap reached while the check failed or the base branch
    conflicted);
  - `fix_rounds`: `rounds` holds two or more entries;
  - `check_failed`: an entry of `checks` has an integer `exit` other than 0;
  - `ci_repair`: `ci.rounds` is greater than 0;
  - `budget_exhausted`: `outcome` or an entry of `turn_stops` has the outcome `budget_exhausted`.

`studies` reads `kind: "reflect"` tasks from `tasks/<slug>/` and archive directories stamped within the last
30 days (UTC archive stamp, regardless of state mtime). It retains at most 20 studies, ordered by newest
`created` first. Archived study slugs omit the `-<stamp>` suffix. `mode`, `records` and `file` come from
`reflect_mode`, the length of `reflect_records` and `reflect_file`; the account is `claude_account` for
the Claude executor and `account` otherwise. `alive` checks the supervisor PID.

Every conversation starts with a lead message at `created`, containing `reflect_order` or `null`.
Each object in `reflect_turns` contributes an analyst message: `summary`, `status`, `file`, paired
`questions` and `options`, and lessons with `id`, `cue` and `entry` built as `"<file> <id>"`.
Lessons also retain `scope` (`"invariant"` or `"domain"`), `lesson` and `proposal` from the turn.
The latter two preserve their text, truncated to 600 characters each. Missing or invalid fields are `null`.
Only `source: "lead"` rows from the neighboring `messages.jsonl` contribute replies. After the initial
order, all messages are sorted by `at`. Lead messages have `status: null`, empty questions and lessons,
and `file: null`. A study waits only while its supervisor is not alive and its last message is an analyst
message with `status: "needs_decision"`; a later lead reply clears `waiting` immediately.

Material uses records newer than the previous batch's `through`; archived studies use the 30-day window.
Repository and implementation discovery reads all task states. Each `state.json` and `messages.jsonl` is reread only when its mtime
or size changes. At server startup, the view is warmed once in a background thread without delaying
readiness. Requests use the ready cache or wait for the same in-progress build. The view is rebuilt
at most once per `BOARD_RESEARCH_SECONDS` (default 30), counted from build completion. Invalid text,
numbers, lists and rows are skipped or treated as missing under the existing field rules; malformed JSON
states are skipped. Task/archive directories and study message files that are symbolic links are never
followed. A missing archive leaves material empty and still permits live studies, repositories and implementations.

Repository resolution and origin checks run in a separate daemon thread outside the research lock,
including during startup warmup. Requests never wait for this search: `repos` and `repos_access` come
from the last completed search (initially an empty list and `"scanning"`). Only one search runs at a
time, and a new one starts no sooner than `BOARD_RESEARCH_SECONDS` after the previous search completes.

`schedule` reads the Claude desktop app's
`$BOARD_CLAUDE_DESKTOP_DIR/claude-code-sessions/*/*/scheduled-tasks.json` files (desktop directory defaults to
`~/Library/Application Support/Claude`). Each file is an object with a `scheduledTasks` array. Only entries
whose `id` equals `reflection_task` (`BOARD_REFLECTION_TASK`, default `codex-batch-reflection`) are considered.
Across all files, the greatest valid `lastRunAt` wins; a missing or invalid timestamp ranks lowest, and an
enabled entry wins a tie. `source` is `"desktop"`, `name` is `displayName`, and `cron` is `cronExpression`
trimmed at both ends. `last_run_at` and `last_scheduled_for` convert the timezone-bearing ISO timestamps
`lastRunAt` and `lastScheduledFor` to Unix seconds; missing or invalid optional fields are `null`. Entries
without a string `cronExpression` or boolean `enabled` are skipped. Files larger than 1 MiB, malformed JSON
and invalid object/array shapes are skipped without failing the request. Symbolic links at the configured
desktop root, session/account/organization directories or the file itself are never followed. `schedule`
is `null` when no valid matching entry exists, the directory or file is missing, or the desktop directory
is not configured. It is independent of the archive and live study files.

`next_at` is the earliest instant strictly after the view's rebuild time that matches the cron in the
server machine's local time zone. It is `null` for disabled tasks, unsupported expressions or no match
within 366 days. Cron has exactly five fields (minute 0–59, hour 0–23, day of month 1–31, month 1–12,
weekday 0–7, where both 0 and 7 mean Sunday). Supported forms are `*`, numbers, inclusive ranges `a-b`,
comma-separated lists, and steps `*/n` or `a-b/n` with a positive integer step. Names such as `MON`/`JAN`,
macros such as `@daily`, six fields and out-of-range values are unsupported; their trimmed `cron` is still
returned. When both day fields are restricted, either day-of-month or weekday may match (Vixie cron OR);
if either field starts with `*`, both must match. The search skips unsuitable days and hours rather than
scanning every minute of the year, rejects nonexistent local times during daylight saving transitions,
and considers both occurrences of repeated local times. For example, `0 9 * * *` on a UTC+3 machine
fires at 06:00 UTC. The schedule, including `next_at`, is rebuilt with every research view (at most once
per `BOARD_RESEARCH_SECONDS`); schedule files are reread only when their mtime or size changes. Older
servers omit `schedule`, so the web's `ResearchView.schedule` is optional.

The web model treats reflect tasks and legacy sessions matching `reflection_task` as research, excluding
them from the fleet. `Research.studies` holds the conversations, `waiting` counts studies waiting for a
reply, and `running` includes both alive studies and legacy sessions. Probes use an alive study's known
batch repositories when its file matches the current batch; otherwise they retain the pending-then-batch
fallback.

#### Task and science station actions

`actions.enabled` is true when the server starts without `--read-only` and an installed `teamster`
executable is available. `--teamster PATH` selects it; the default is `shutil.which("teamster")` at
startup, independently of the accounts/report script. Otherwise `actions.reason` is `read_only`
(taking precedence) or `no_teamster`; enabled actions have `reason: null`. Task details return the
same `actions` value as `/api/research`, including for desktop sessions, with one more field: `queue`
is true when the installed `teamster` is 1.60.0 or later. The server runs `teamster --version` (stdin
closed, 10-second timeout, the user's home as working directory) once, for the first task detail or
order that needs it, and keeps the answer until it restarts; the first `X.Y.Z` in its stdout is the
version. A failed, timed-out or unparsable probe means `queue: false`; disabled actions never probe.

Only these POST endpoints execute commands:

- `/api/actions/lesson`: `{entry: string, status: "accepted" | "declined" | "applied" | "proposed", note?: string}`
  runs `teamster lesson <entry> <status>`, adding `--note=<note>` only for a nonempty trimmed note.
  The trimmed entry must equal a lesson entry in the current view (404 otherwise); entry ≤ 200
  characters, note ≤ 1000.
- `/api/actions/implement`: `{entry: string, repo: string, note?: string}` starts implementation of a lesson.
  The trimmed entry must equal a current lesson entry (404 otherwise); entry ≤ 200 characters,
  trimmed note ≤ 4000. Only `proposed` and `accepted` lessons are allowed; other statuses get 409 with
  `error: "Урок уже внедрён или отклонён"`. `repo` must exactly equal a `repos[].path` (400 otherwise).
  A lesson with a non-archived implementation gets 409 with `error: "Урок уже внедряется: <slug>"`,
  even when its supervisor is idle.
  Before running any command, the server probes `<repo>/.git` with the same 3-second access timeout.
  A failed, timed-out or already pending probe returns 503 with
  `{ok: false, error: "Нет доступа к диску с репозиторием. Разреши Python доски доступ к файлам на съёмных томах: Системные настройки → Конфиденциальность и безопасность → Файлы и папки или Полный доступ к диску."}`
  and runs no commands.
  The slug is `lesson-<id>-MMDD` in UTC: `<id>` is the entry's last word, lowercased, with every character
  outside `[a-z0-9]` replaced by `-`. Add `-2`, `-3`, … while the task directory exists. The final slug
  must match `[a-z0-9][a-z0-9-]{1,40}` (400 otherwise).
  The temporary brief begins `Внедрить урок «<entry>»: <title, falling back to cue>.`, identifies the
  lesson's archive file and includes cue, lesson, proposal, evidence, caveats and the user's note in
  that order, omitting empty fields and their labels. Its fixed completion criteria require implementing
  the proposal in the selected repository, tests and affected documentation, reporting work outside
  the repository in `remaining`, and `needs_decision` with questions when a choice is needed.
  Only for a `proposed` lesson, first run
  `teamster lesson <entry> accepted --note=внедряется: <slug>` (the note is one argv word).
  A nonzero exit returns 422 and prevents the start step. Then run
  `teamster start <slug> --brief <temporary file> --repo <path> --executor claude --sandbox off --effort high --task-type feature --max-minutes 60 --review --fix-rounds 2 --parallel`.
  Append `--ci` when `git -C <path> remote get-url origin`, with stdin closed and a 10-second timeout,
  succeeds and its stdout contains `github.com`. A missing origin, failed probe or timeout omits `--ci`.
  Success returns the start step's output and `slug`; a nonzero start exit returns 422, leaving the
  lesson `accepted`. A successful acceptance invalidates research even if the start step fails.
- `/api/actions/say`: `{slug: string, text: string, options?: object}` runs
  `teamster say <slug> [options] --file <temporary file>` for any non-archived, idle task of kind
  `work`, `review` or `reflect`, including studies and lesson implementations. An alive task of these
  kinds (its turn runs or its supervisor sleeps until a limit reset) gets
  `teamster say <slug> [options] --file <temporary file> --queue` when the installed `teamster` supports
  the queue (`actions.queue`), and 409 otherwise. Archived tasks,
  scouts and desktop sessions get 409; unknown slugs get 404. The station's base-slug addresses for
  archived studies and implementations also return 409. Trimmed text must contain 1–8000 characters
  and is written to the temporary file, never passed as an argv word. Every option is optional;
  an unknown option key or invalid value gets 400. Flags appear in this order, before `--file`:
  - `model`: matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` → `--model=<value>`.
  - `effort`: `low`, `medium`, `high`, `xhigh`, `max` or `ultra` → `--effort=<value>`.
  - `max_minutes`: integer 5–600 → `--max-minutes=<value>`.
  - `max_weekly`: finite JSON number 0.5–100, excluding booleans → `--max-weekly=<value>`;
    integral values have no `.0` suffix.
  - `fix_rounds`: integer 0–5 → `--fix-rounds=<value>`.
  - `ci_rounds`: integer 0–5 → `--ci-rounds=<value>`.
  - `reviewer`: `codex` or `claude` → `--reviewer=<value>`.
  - `review_angles`: `"auto"` or a list of 1–4 distinct values from `correctness`, `concurrency`,
    `security`, `tests` → `--review-angles=auto` or `--review-angles=<comma-separated values>`.
- `/api/actions/verdict`: `{slug: string, verdict: "accepted" | "revised" | "redone" | "dropped", note?: string}`
  runs `teamster verdict <slug> <verdict>`, adding `--note=<note>` for a nonempty trimmed note ≤ 200
  characters. Live and archived `work` and `review` tasks are allowed, even while alive; other kinds
  and sessions get 409.
- `/api/actions/review`: `{slug: string, review_angles?: string | string[], reviewer?: string, effort?: string}`
  runs `teamster review <slug>`, followed by `--effort`, `--reviewer`, `--review-angles` when present,
  each as one `--option=value` word. Values have the same rules as say options. Only non-archived,
  idle `work` and `review` tasks are allowed; other kinds, alive or archived tasks and sessions get 409.
- `/api/actions/stop`: `{slug: string}` runs `teamster stop <slug>`. Only a non-archived, alive task
  is allowed; idle or archived tasks and sessions get 409 with `error: "not running"`.
- `/api/actions/clean`: `{slug: string, keep_branch?: boolean}` runs `teamster clean <slug>`, adding
  `--keep-branch` unless `keep_branch` is `false`. Only a non-archived, idle task is allowed; alive or
  archived tasks and sessions get 409. The branch is kept by default.
- `/api/actions/reflect`: `{order?: string, tasks?: string[], since?: string, repos?: string[]}`
  runs `teamster reflect <slug>`, then repeated `--task T`, `--since S`, repeated `--repo R`, and
  `--file <temporary file>` for a nonempty trimmed order. Tasks cannot be combined with since or repos
  (400). Task and repository names match `[A-Za-z0-9._-]{1,100}`, with at most 20 of each; `since` is
  `[0-9]{1,3}d` or a valid `YYYY-MM-DD` date, and order ≤ 8000 characters. The server chooses
  `reflect-MMDD-HHMMSS` in UTC, adding `-2`, `-3`, … while a name exists in the configured tasks
  directory (normally `~/.teamster/tasks`). Successful responses include this `slug`.

All responses are JSON: `{ok: true, output: string, slug?: string}` or `{ok: false, error: string}`.
Success is 200. `output` is trimmed stdout's last 2000 characters. Invalid input is 400; a nonzero
command exit is 422, with trimmed stderr's last 2000 characters (stdout if stderr is empty).
Disabled actions return 403 with `error: "read_only"` or `"no_teamster"`. Commands exceeding 120 seconds
are killed and awaited, returning 504 with `error: "timeout"`.

Every action requires the existing localhost Host check, exactly one `Origin` matching the request's
scheme, host and port, `Content-Type: application/json` and `X-Teamster-Board: 1`. A failed check returns
403 with `error: "forbidden"`; bodies over 64 KiB return 413. The server never sends CORS headers.
Commands run one at a time under a shared lock, outside the event loop, as argv lists without a shell,
with stdin closed, inherited environment and the user's home as working directory. Temporary files are
deleted after execution. Each execution logs one line with its route, argv (without say/order text) and
exit code. Success invalidates the research view, so the next GET sees changes immediately regardless
of `BOARD_RESEARCH_SECONDS`. Task orders validate slugs with the same safe-name check as task details:
one path component, no leading dot, backslash or NUL. Invalid input gets 400, unknown tasks get 404.
Tasks are store records, distinct from desktop sessions. Archived tasks use their archive folder name
in requests; the command receives that name without the `-YYYYMMDDTHHMMSSZ` suffix.
There is no merge endpoint for ordinary tasks.

## REST

- `GET /api/snapshot` → `Snapshot`.
- `GET /api/events?since=<unix>&until=<unix>` → `Events`. Both bounds are inclusive finite Unix
  seconds. `until` defaults to now; `since` defaults to 24 hours before `until`. Reversed windows,
  invalid numbers and windows longer than 31 days get 422. Only events retained for the last 31 days
  are available. If more than 5000 events match, keep the newest 5000 and set `truncated: true`.
  The response contains only `LogEvent` fields: tokens, usage, thread/session IDs, costs, weekly
  quotas and all other journal fields are discarded. Nonempty strings use the existing task text
  rules; the verdict note collapses whitespace and is cut to 200 characters. Numeric fields accept
  only finite JSON numbers, excluding booleans; missing or invalid optional fields are `null`.
- `GET /api/report?since=YYYY-MM-DD&by=<dimensions>` → `{"fetched_at", "error", "data"}`, the same
  envelope as `Accounts`, with the `report --json` output passed through as `data`. `since` is required
  and must match `[0-9]{4}-[0-9]{2}-[0-9]{2}`; optional `by` is a comma-separated list drawn from
  `task-type`, `effort`, `model`, `executor`, `reviewer`, without spaces or empty entries. Invalid
  arguments get 422 and never reach a process. Only these validated values are passed as arguments;
  the report runs on demand and is cached per argument pair as described above.
- `GET /api/tasks/{slug}` → `TaskDetail`; 404 for an unknown slug. Archived tasks are addressed by their
  archive folder name. Sessions have an empty `files` array, creation/last-activity timeline entries and
  `cargo: null`, `limits: null`, `messages: []`, `activity_log: []`.
  Limits come from `state.json`: numeric fields accept only finite JSON numbers, excluding booleans;
  missing or invalid values are `null`, except `review_rounds: 0` and empty lists. Rotations without
  a finite numeric `at` are skipped. Messages come from the last 256 KiB of the task's `messages.jsonl`,
  live or archived, through the same safe file lookup as other task files, without following symbolic
  links. If reading starts after the beginning of the file, discard the first, partial line. Malformed
  lines, non-object rows, non-finite or non-numeric `at` (including booleans), and non-string or missing
  `text` are skipped. `queued_at` is a finite number or `null`. Keep the newest 50 messages by `at`, ascending.
  The queue comes from the task's `queue.json` through the same safe lookup, read whole up to 1 MiB:
  a missing, larger or malformed file, or one that is not an object, gives empty lists. Rows of
  `waiting` and `dropped` that are not objects, or lack a finite numeric `at` or a string `text`,
  are skipped; text is cut to 4000 characters, `outcome` is one line ≤ 200 characters, and each list
  keeps its last 50 rows in file order. Activity logs retain every
  activity parsed from newly read executor lines across polls, capped to the latest 10, newest first;
  they are empty when the task is not alive. Summary activity and WebSocket activity messages still
  carry only the latest activity.
  Session paths come only from scanned records, never from a requested slug; path-like slugs return 404.
- `GET /api/tasks/{slug}/files/{name}` with `name` in `brief`, `last`, `review`, `check` → `text/plain;
  charset=utf-8`, at most the last 256 KiB; 404 when missing or for a session. No other names, no paths.
- `GET /api/research` → `ResearchView`; other methods get 405.
- `POST /api/actions/lesson`, `/api/actions/implement`, `/api/actions/say`, `/api/actions/reflect`,
  `/api/actions/verdict`, `/api/actions/review`, `/api/actions/stop`, `/api/actions/clean`
  → the task and science station actions above.
- `GET /api/constellations` → `{"constellations": [{"name": string, "repos": string[]}], "error": string | null}`.
  At most 32 constellations; a name is 1 to 60 characters and unique; `repos` lists 1 to 64 repository names or
  patterns, each at most 100 characters without slashes, where `*` stands for any run of characters. Names and
  patterns are trimmed and repeated patterns dropped. A missing file gives an empty list and no error; a symbolic link,
  a file over 64 KiB, invalid JSON or any other shape gives an empty list and the reason. The map matches the patterns
  against repository basenames; a repository that two constellations claim belongs to the first.
- `GET /api/art` → `ArtIndex`, empty when `board-art/` is missing. URLs carry the file's mtime as `?v=`, so a
  replaced picture gets a new URL.
- `GET /api/art/{repo}/{file}` with `file` in `sky.jpg` (`image/jpeg`), `planet.png`, `emblem.png` (`image/png`) →
  the file; 404 when missing. `repo` passes the same check as a task slug: one path component, no leading dot, no
  backslash. No other names, no paths, and neither `board-art/`, the repository's folder nor the file may be a
  symbolic link. A client falls back to shared art for anything absent.

## WebSocket `/ws`

Server → client only; the server ignores client messages. Every message is one JSON object:

- `{"type": "snapshot", "snapshot": Snapshot}` — first message after connect.
- `{"type": "task", "task": TaskSummary}` — a task appeared or changed.
- `{"type": "task_removed", "slug": string}` — a live task folder disappeared (it is then sent again as
  `closed` if it was archived), or a session's metadata disappeared or became archived.
- `{"type": "activity", "slug": string, "activity": Activity}` — new latest activity of a live task.
- `{"type": "event", "event": LogEvent}` — a newly read completed event, from the same polling cycle
  as tasks. Cursor resets rebuild history without resending previously published event content.
  History is fetched through `/api/events`; it is not added to `Snapshot`.
- `{"type": "accounts", "accounts": Accounts}` — new account data.
- `{"type": "machines", "machines": Machines}` — at the end of a machine polling cycle when data
  changed, comparing without `checked_at`. Metric and history changes count as changes.
- `{"type": "ping", "at": number}` — every 20 s.

The server polls file mtimes and sizes once per `BOARD_POLL_SECONDS` (default 1.0) and sends only changes.
A client that reconnects gets a fresh `snapshot`.
The `machines` snapshot field and WebSocket message are additive. Existing clients can ignore them;
the current frontend selects known snapshot fields and ignores unknown WebSocket message types.

## Serving and safety

- `teamster-board [--host 127.0.0.1] [--port 8787]` binds to `127.0.0.1` by default.
- Requests whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` (with any port) get 403, and so do
  WebSocket upgrades whose `Origin` is present and not one of those hosts — DNS-rebinding protection.
- When `board/web/dist/` exists, `/` serves it (SPA fallback to `index.html`); otherwise `/` returns a short
  text that says to build the web app.
