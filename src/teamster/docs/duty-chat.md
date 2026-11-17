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

The only account-home file teamster reads for the duty transport is `auth.json`, read-only. It parses
that document and sends only `tokens.access_token` and `tokens.account_id` to
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
The tests exercise these boundaries with fake servers and fake credential refresh; they do not
establish live backend acceptance or guarantee that an account owner has refreshed an expired token.

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

The action tools are `exec_command`, `write_stdin` and `apply_patch`. Agent, app, plugin, MCP,
browser, computer, image, memory, goal, history-note, permission and skill-install actions are
disabled, as are inherited hooks, automatic review and reusable grants. Inert planning, time,
sleep and context tools may remain. A model may select Code Mode's V8 wrappers; they provide no
imports, filesystem, process or network APIs, and their nested command and file calls use the same
approval checks. The adapter does not rely on Codex hooks or prefix allow rules to enforce the duty
policy.

Codex also starts with a sandbox whose writable area is the room. This is an extra, best-effort
layer: an accepted command may request escalation or automatically retry outside it after a
sandbox failure, without another teamster decision. In either case the exact command has already
passed the guard. Turn cleanup interrupts the turn, cleans its background terminals and shuts the
server down so Codex can end its command groups. The time limit, stop and orphan checks apply to
both transports; independently started teamster tasks keep running under their own supervisors.
Codex 0.169.0 exposes terminal session handles rather than command operating-system PIDs.
Environment markers are only a best-effort cleanup aid: after an app-server crash, teamster cannot
guarantee forced cleanup of native commands. Even a file-based command can stall on a named pipe,
device or network resource. If both the supervisor and app-server are killed, no cleanup code runs.

The difference from Claude is Codex's `write_stdin`: input may still be sent to a command that the
guard already accepted. The allowed commands do not execute their input as a program; `teamster`,
`git` and `gh` are also forbidden from taking hidden work through stdin paths or Git's `--stdin`,
as described below. Sending input therefore adds no action beyond the accepted command.

To avoid deliberately persistent readers that could outlive a crashed app-server, the Codex guard
also refuses `tail -f`, `-F` and `--follow`, including combined short options and `--follow=…`.
`cat`, `head`, `tail`, `wc` and `rg` must name their input files: a form that waits for stdin, or an
explicit stdin operand such as `-` or `/dev/stdin`, is refused. Unknown or ambiguous reader options
are declined with a reason; ordinary file-based forms such as `cat README.md`, `head -n 20 notes.md`
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
| `duty.chat_codex_model` | `null` | model of Codex duty chat turns; null uses the isolated Codex default |
| `duty.chat_codex_effort` | `null` | nonempty effort string for Codex duty chat turns, or null to use the isolated Codex default |
| `duty.chat_max_minutes` | `20` | active time budget of one duty chat turn |
| `duty.chat_auto_turns_per_hour` | `12` | nonnegative integer; note-driven turns per hour, the rest wait for the next user message |
