# Duty chat

`teamster duty chat ["text" | --file FILE] [--queue]` sends the user's message to the duty: an
orchestrator agent that runs on the [duty account](accounts.md#duty-account), answers, and may start
teamster tasks itself. The command waits for the duty's turn and prints its answer; `teamster wait duty`
follows a turn from another terminal.

## The conversation

The first message creates one long-lived task, slug `duty` and kind `duty`, with a room: a fresh git
repository in `~/.teamster/tasks/duty/room` where the duty writes its briefs. Later messages go to the
same task exactly as `say` does: the turn resumes the Claude session or Codex thread, and while a turn runs
`--queue` queues the message and its turn starts when the running one ends (without `--queue` the
command refuses). `teamster say duty "…"` takes the same path as `duty chat`, with the same duty
checks and held notes, but returns as soon as the turn starts; its `--effort` and `--model` replace
the current family's chat settings, and `--max-minutes` replaces `duty.chat_max_minutes`, for the
conversation, as `say` does for a task. `duty chat` returns when its turn's supervisor exits, also when
that supervisor is killed. A creation that an interruption cut short (a room without `state.json`) is
removed and made again by the next message. When a duty turn's supervisor dies before its Claude or
Codex process, that process still holds the conversation: the next message and `clean duty` refuse until
`teamster stop duty` ends it. `status duty` shows the room and the number of answers; `clean duty`
removes the room and archives the record, and the next message starts a new conversation.

Without a duty account (`duty.json` absent or its `account` null) the command fails with
`no duty account` and starts nothing. Both Claude and Codex duties run the chat. The turn always runs
on the current duty account, pinned by `duty set` or elected, and never on another one. A change of
family or account moves the next turn by the rotation handoff: the brief, the messages so far and
the duty's earlier replies, including questions and answer options. Both session cursors are reset,
so a return to a previous family starts with the handoff instead of resuming a stale session;
saved model overrides are cleared when the family changes, before applying any new `--model`.
`status` shows the rotation. A limit on the duty account ends the turn `unavailable`; the next turn
runs once the account recovers or the duty moves.

The turn's system prompt is the [lead guide](lead-guide.md), the duty's role (`duty-role.md` in the
package: how to answer, when to ask instead of starting, one task per independent piece, briefs in the
room, the limits below), the user's own standing rules from `~/.teamster/duty-rules.md` when that file
exists, the known repositories (name and path of every live or archived work task's repository) and
the room's path.

## Limits

On both transports the limits rest on teamster's guard, `bash_guard.py --duty-room ROOM`. The system
prompt describes the limits; the guard enforces them and fails closed.

A Claude turn never uses `bypassPermissions`: it runs with `--permission-mode dontAsk`, the tools `Read`,
`Grep`, `Glob`, `Bash`, `Write` and `Edit`, and a PreToolUse hook (`bash_guard.py --duty-room ROOM`)
on `Bash`, `Write`, `Edit`, `MultiEdit` and `NotebookEdit`; the same `--settings` set `disableAllHooks: false`,
so no account or project setting turns the hook off. Teamster adds no operating-system sandbox to
this transport.

A Codex turn runs through `codex app-server` in a teamster-owned `tasks/duty/codex-home`, outside
the writable room. Both `CODEX_HOME` and the server's `HOME` point there, as does its SQLite storage.
`CODEX_SQLITE_HOME` is excluded from shell commands, so tasks they start use their own account's storage.
The home persists so later turns can resume their threads. No account configuration, `.env`, hooks,
rules, plugins, skills or instruction files are copied or linked into it. Invocation settings disable
plugins and bundled/cloud skills, stop project discovery at the room, and disable project instruction
loading. An invocation-only `projects` entry marks the room `untrusted`, preventing Codex from
automatically writing a trusted-project table into the isolated `config.toml`.
If a saved thread still belongs to the old account store, Codex reports that its rollout is missing;
teamster clears that cursor and starts a fresh thread with its existing conversation handoff, under
the same turn deadline. Other resume errors fail normally; account rollout files are never copied.
These behaviors follow the [thread startup and resume implementation](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server/src/request_processors/thread_processor.rs).
Host skill discovery in this app-server cannot be switched off with
`skip_host_skill_discovery` alone, so the isolated `HOME` also excludes the user's `.agents/skills`.
Inherited remote-executor, app-server configuration and OpenAI authentication environment settings
are removed. Guarded shell commands receive the original `HOME`, so allowed commands such as `gh`
can use their normal configuration; their command approvals still go through teamster.

For authentication, teamster reads the account home's `auth.json` read-only. It sends only
`tokens.access_token` and `tokens.account_id` to
`account/login/start` with type `chatgptAuthTokens`, over the server's stdin pipe. Codex keeps those
credentials in process-local ephemeral storage with no refresh token. Teamster never copies or
symlinks credential files, exchanges refresh tokens, writes account credentials, or logs the supplied
tokens. On `account/chatgptAuthTokens/refresh`, it rereads the same file and returns a changed access
token only if the account ID still matches. An ordinary work process may refresh and replace the
real credential file concurrently; the duty only reads its result and adds no competing OAuth
refresh. If no replacement access token is available, the duty refuses with the account's `auth.json`
path and asks for an account-owner refresh. Missing, unreadable or keyring-only credentials also
refuse with that path. Usage limits and account rotation continue to query the real account home.

This bridge is pinned to Codex 0.169.0: upstream marks `chatgptAuthTokens` as experimental and
internal-only, rather than a stable public integration contract. The source at `rust-v0.169.0`
verifies the [login and refresh protocol](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server-protocol/src/protocol/v2/account.rs),
[empty refresh token and ephemeral credential storage](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/login/src/auth/manager.rs),
[401 delegation to the client](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server/src/external_auth.rs),
[configuration discovery](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/config/src/loader/mod.rs),
and [host skill roots](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/ext/skills/src/host_roots.rs).
Live probes on a real ChatGPT account established the direct command approval path, including
guard acceptance and refusal, and an escalated `teamster status`. The regression tests use faithful
fake servers and credentials; they never run the real Codex. Neither the authentication bridge nor
the catalogue override below is a stable integration contract, and tests cannot guarantee that an
account owner has refreshed an expired token.

The adapter requires
Codex 0.169.0 and checks the server version before starting a turn. It uses protocol
`approvalPolicy: "untrusted"` and `approvalsReviewer: "user"`. The adapter sends each command
approval to the same guard as Claude, using the exact shell text to be executed. It answers only
`accept` or `decline`, with no session-wide or saved grant. For a file-change approval it matches
the request's item id to the item's changes and checks every path, including rename destinations,
with the guard's room check. Unreadable or unknown requests and unmatched changes are declined.

Before signing in and again before starting or resuming a thread, the adapter reads the effective
configuration and its layers with `config/read`, and managed requirements with
`configRequirements/read`; sign-in can activate cloud-managed configuration. It refuses nonempty
system or user configuration, enabled project layers, MCP servers, hooks and approval rules that
remain in active configuration folders. Managed requirements also cause a refusal: the protocol
does not expose enough to verify every inherited rule. Skills in the isolated home, the room's
`.codex/skills` or `.agents/skills`, or system configuration folders cannot be isolated and cause a
refusal naming the path. Settings that prevent the hardening overrides from taking effect, including
command environment filters, are refused too. Each refusal names the blocking file or setting.
Overrides apply only to this invocation; the account's configuration is not rewritten. The thread's
reply must confirm the requested approval policy, reviewer and room sandbox.

The account catalogue observed with Codex 0.169.0 gives every model
`tool_mode: "code_mode_only"`. [Model metadata takes precedence over feature flags](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/tools/mod.rs#L66-L87),
and [Code Mode Only hides direct tools](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/tools/spec_plan.rs#L887-L912).
With the Code Mode host disabled, its `exec` tool answers `code-mode host is disabled`.
For each duty turn, teamster instead reads the account home's `models_cache.json` read-only,
sets `tool_mode` to `direct`, and removes only `request_user_input_async`, its legacy name
`send_user_message_async`, and `send_message_to_user_async` from `experimental_supported_tools`.
It preserves the other metadata and prompts and writes a per-run copy into the isolated duty home.
These [async tools emit messages marked as final answers](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/tools/handlers/request_user_input_async.rs#L131-L143);
an unexpected async agent message fails the turn before its text is journaled or used as the answer.
Teamster passes the copy through the invocation's
[`model_catalog_json`](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/config/mod.rs#L2327-L2358),
then removes the copy during cleanup. No account file is written or deleted. There is one
app-server process, with no discovery process or isolated-cache deletion. The observed account
models then expose direct `exec_command`, `write_stdin` and `apply_patch` tools.

Ordinary Codex work turns create and refresh the account's cache. In the observed isolated server,
`model/list` and `thread/start` did not create it; no reliable fetch without a model turn has been
established. If the account cache is missing or unusable, the duty refuses with one sentence:
`Codex duty needs a usable <account-home>/models_cache.json; an ordinary Codex work turn creates it.`
The cached catalogue can become stale; an ordinary work turn refreshes it.
Teamster checks the required model metadata and instruction template, including the legacy
`base_instructions` form. A JSON or UTF-8 decoding failure during an in-place cache rewrite gets at most
three read attempts; a persistently invalid cache produces the same refusal.

The default model is teamster's usual `gpt-6.1-sol` when it is visible in the account catalogue,
otherwise the first model with `visibility: "list"` in cache order. Teamster does not recompute
the default from `model/list` or model priorities. `duty.chat_codex_model` and the
conversation's `--model` select another name only while it remains in that catalogue. A missing
or unavailable override uses the same fallback. Every `thread/start` and `thread/resume` receives
the selected model explicitly, so an unavailable model stored in a rollout recovers on the next
turn without a new `--model` argument.

For the direct tools, `untrusted` asks for
[every command without an explicit allow rule](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/exec_policy.rs#L910-L914)
and [every nonempty patch](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/safety.rs#L79-L87).
The [orchestrator awaits approval before running the tool](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/tools/orchestrator.rs#L210-L231).
The app-server emits `item/started`, then `item/commandExecution/requestApproval` or
`item/fileChange/requestApproval`, then `item/completed`; a refused command completes as `declined`.
Its [plain accept decision](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server/src/bespoke_event_handling.rs#L2092-L2097)
is [never cached as a session grant](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/tools/sandboxing.rs#L88-L119).
The fake tests check command output reaching the answer and refused commands producing no effect.
Unknown tool items fail the turn; unreadable or unknown approval requests are declined.

Agent, app, plugin, MCP, browser, computer, image, memory, goal, history-note, permission and
skill-install actions are disabled, as are inherited hooks, automatic review and reusable grants. Inert planning, time,
sleep and context tools may remain. The adapter does not rely on Codex hooks or prefix allow rules
to enforce the duty policy.

Codex starts with a room-only writable sandbox. In the live probe, 0.169.0 replied
`{"type": "readOnly", "networkAccess": false}`: the filesystem root is readable, the room writable,
and its `.git`, `.agents` and `.codex` directories read-only. Teamster omits `environments` from
thread and turn requests so commands use the local execution environment; an empty array instead
leaves no usable execution environment.

A guarded command can still fail inside the sandbox: even `teamster status` needs a state lock
outside the room. Codex duty instructions therefore tell the model to call `exec_command` with
`sandbox_permissions: "require_escalated"` and a short `justification` for `teamster`, `gh`, and
commands on other git repositories when they need outside writes or network access. The escalated
command comes through the same command approval path. The guard decides its exact shell text and
plain `accept` authorizes only that call outside the sandbox. `additionalPermissions`, reusable
permissions and session-wide grants remain declined. A sandbox failure does not guarantee that
Codex will request escalation or retry successfully.

TTY execution and the Code Mode host are disabled. The server
[rejects `tty: true`](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/tools/handlers/unified_exec/preparation.rs#L185-L189).
A non-TTY `write_stdin` can poll an accepted command or interrupt it;
[it cannot send ordinary input](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/unified_exec/process_manager.rs#L1017-L1026)
to that process. However, [Ctrl-C explicitly skips approval](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/unified_exec/stdin_approval.rs#L198-L205)
and interrupts the process. Codex 0.169.0 [registers `exec_command` and `write_stdin` together](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/tools/spec_plan.rs#L1311-L1320);
its public invocation settings cannot remove only `write_stdin`. This transport therefore cannot
guard the model's interruption of an already approved process. It also forbids hidden work through
stdin paths or Git's `--stdin`, as described below.

Turn cleanup interrupts the turn, cleans its background terminals and shuts the server down so
Codex can end its command groups. The time limit, stop and orphan checks apply to both transports;
independently started teamster tasks keep running under their own supervisors. Codex 0.169.0
exposes terminal session handles rather than command operating-system PIDs. Environment markers
are only a best-effort cleanup aid: after an app-server crash, teamster cannot guarantee forced
cleanup of native commands. Even a file-based command can stall on a named pipe, device or network
resource. If both the supervisor and app-server are killed, no cleanup code runs.

To avoid deliberately persistent readers that could outlive a crashed app-server, the Codex guard
also refuses `tail -f`, `-F` and `--follow`, including combined short options and `--follow=…`.
`cat`, `head`, `tail`, `wc` and `rg` must name their input files unless their stdin comes from the
previous command in the same pipeline. For example, `teamster status | head -n 285 | tail -n 110`
is allowed, while a leading `head -n 285` still waits for terminal input and is refused. Stdin
redirections on a stage or its enclosing group remove this pipe exemption. Numeric
`head -N` and `tail -N` forms are accepted only at a stage fed by a pipe.
Explicit stdin operands such as `-` or `/dev/stdin` remain refused. Unknown or ambiguous reader options are
declined with a reason; ordinary file-based forms such as `cat README.md`, `head -n 20 notes.md`
and `rg -n pattern src` remain allowed. These extra reader restrictions apply only to Codex;
Claude's hook keeps its existing reader policy. `rg --files` may enumerate the current directory
without a path argument because it does not read stdin.

The shared guard allows:

- `teamster start|say|scout|review|stop|status|wait|report|docs|accounts` and `teamster duty status`,
  except `say`, `stop`, `review` and `wait` on the duty conversation itself. Each takes only the exact
  names of its options (argparse would expand an abbreviation such as `--ci-comm`), and never `--check`,
  `--check-loaded` or `--ci-command`, whose shell command the supervisor would run outside the hook;
- read-only git in a form that keeps the repository's config from starting a program:
  `git --no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null [-C DIR]` (no other global
  option, and `-C` outside the room), then `log`, `show`, `diff`, `ls-files` or `grep`. `log`, `show`
  and `diff` also need `--no-ext-diff --no-textconv --no-show-signature --submodule=short` and refuse
  `--ext-diff`, `--textconv`, `--show-signature`, `--output`, other `--submodule` values, `%G`
  placeholders and every abbreviation of these. `log` and `show` name their format (`--oneline`,
  `--pretty`, a built-in name, or a `--format=`/`--pretty=` string), so that `format.pretty` from the
  config, which can show signatures and so run `gpg.program`, never applies. `diff` compares two
  commits written before `--` (`A...B --` or `A B --`) or the index (`--cached`), never the working tree,
  whose clean filters it would run; it takes only options without a separate value (the required
  switches, `--cached`, `--staged`, `--merge-base`, the stat and name formats, `-p`, `-w`, `--no-color`,
  and `--stat=`, `--unified=`, `--diff-filter=`, `-U` with their values attached). `ls-files` takes only `-z`, `-s`/`--stage`, `--cached`, `--full-name` and
  `--error-unmatch`; `grep` refuses `-O`/`--open-files-in-pager`, `--textconv`, `--no-index` and
  `--recurse-submodules`. `git status` (clean filters) and `git fetch` (credential helpers, ssh commands,
  proxies, upload-pack and hooks from the config) are refused;
- read-only `gh pr view|diff|checks|list` and `gh run view|list`;
- `ls`, `cat`, `head`, `tail`, `wc` and `rg` (without `--pre` or `--hostname-bin`).

Everything else is refused, in particular `gh pr merge`, `git push|commit|merge|rebase|reset|checkout`,
`teamster clean|verdict|login|claude-login|duty tick|duty set|duty auto|duty clear`, `scripts/bump_version.py`, package
managers, `curl` and `rm`. Commands run by path and variable assignments are refused.
`teamster`, `git` and `gh` refuse `-`, `/dev/stdin`,
`/dev/fd/0` and `/proc/self/fd/0` as arguments, including option values and symbolic links to these
paths; git also refuses `--stdin` and its abbreviations. Claude readers may consume standard input;
Codex readers have the additional restrictions above.
A compound command (`;`, `&&`, `||`, `|`, a subshell) is judged by every part; shell expansions (`$VAR`, `$(…)`,
backticks, ANSI-C quoting `$'…'`, arithmetic, globs, braces, the body of an unquoted heredoc that
expands) and control keywords are refused. Redirections and the file tools may write only inside the
room and outside its `.git` and `.claude` (project settings), with every symbolic link resolved (`/dev/null` and `2>&1` are fine). The duty never merges, releases or accepts work: that stays
with the user.

## The answer

Each turn ends with JSON by the duty schema:

| Field | Contents |
|---|---|
| `status` | `answered`, `needs_decision` (a question for the user) or `started` (it started tasks) |
| `reply` | plain text for the user |
| `question` | the one decision the user must make, or empty |
| `options` | 2-4 short answers to `question`, or empty for a free answer |
| `started` | slugs of the tasks it started in this turn |

A turn with an answer that breaks these rules fails and records nothing. The task's `state.json`
keeps the conversation for readers such as the board: each answer appends
`{"at", "turn", "account", "status", "reply", "question", "options", "started"}` to `duty_turns`;
`messages.jsonl` holds the user's messages (`source: "user"`) and the task notes (`source: "note"`),
one row each, in order. `needs_decision` sends the `needs_input` notification with the question.

## Task notes

A task started from inside a duty turn records `started_by: "duty"` in its `state.json` (`start` and
`scout` read `TEAMSTER_STARTED_BY=duty` from the turn's environment). When a cycle of such a task ends,
its supervisor queues a note to the conversation: `Task note: <slug> ended turn N with outcome …`
followed by what `wait` prints (result, checks, review, CI, PR). Every cycle sends one, also a cycle
whose end started the next turn for the task's own queued orders (with the report saved before that
turn began). The note joins the running duty turn's queue, or starts a note-driven turn while the duty
is idle. At most `duty.chat_auto_turns_per_hour` note-driven turns start in an hour, whether the notes
arrive while the duty is idle or wait in the queue of a running turn; the rest wait in
`tasks/duty/notes.json` and go out with the next user message, as do notes held while no configured
duty account can run the chat, after a failed or stopped duty turn, or in the queue of a duty
supervisor that died.
Held notes leave `notes.json` only once the turn that carries them has started and is saved: a start
that fails, or a command that dies first, leaves them held for the next message, at the cost of a note
journaled twice in `messages.jsonl`. The duty conversation's own turns never notify, and a failure to
queue a note is logged in the task's `stderr.log`, never failing its cycle.

## Settings

| Key | Default | Effect |
|---|---|---|
| `duty.chat_model` | `claude.model` | model of Claude duty chat turns (a nonempty string or null) |
| `duty.chat_effort` | `"high"` | effort of Claude duty chat turns: `low`, `medium`, `high`, `xhigh` or `max` |
| `duty.chat_codex_model` | `null` | model of Codex duty chat turns; null or an unavailable name selects `gpt-6.1-sol` when visible, otherwise the first visible model in cache order |
| `duty.chat_codex_effort` | `null` | nonempty effort string for Codex duty chat turns, or null to use the isolated Codex default |
| `duty.chat_max_minutes` | `20` | active time budget of one duty chat turn |
| `duty.chat_auto_turns_per_hour` | `12` | nonnegative integer; note-driven turns per hour, the rest wait for the next user message |
