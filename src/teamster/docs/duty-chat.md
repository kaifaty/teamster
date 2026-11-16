# Duty chat

`teamster duty chat ["text" | --file FILE] [--queue]` sends the user's message to the duty: an
orchestrator agent that runs on the [duty account](accounts.md#duty-account), answers, and may start
teamster tasks itself. The command waits for the duty's turn and prints its answer; `teamster wait duty`
follows a turn from another terminal.

## The conversation

The first message creates one long-lived task, slug `duty` and kind `duty`, with a room: a fresh git
repository in `~/.teamster/tasks/duty/room` where the duty writes its briefs. Later messages go to the
same task exactly as `say` does: the turn resumes the duty's session, and while a turn runs
`--queue` queues the message and its turn starts when the running one ends (without `--queue` the
command refuses). `teamster say duty "…"` takes the same path as `duty chat`, with the same duty
checks and held notes, but returns as soon as the turn starts; its `--effort`, `--model` and
`--max-minutes` replace `duty.chat_effort`, `duty.chat_model` and `duty.chat_max_minutes` for the
conversation, as `say` does for a task. `duty chat` returns when its turn's supervisor exits, also when
that supervisor is killed. A creation that an interruption cut short (a room without `state.json`) is
removed and made again by the next message. When a duty turn's supervisor dies before its Claude
process, that process still holds the session: the next message and `clean duty` refuse until
`teamster stop duty` ends it. `status duty` shows the room and the number of answers; `clean duty`
removes the room and archives the record, and the next message starts a new conversation.

Without a duty account (`duty.json` absent or its `account` null) the command fails with
`no duty account` and starts nothing. A Codex duty is refused the same way: the chat needs a Claude
duty. The turn always runs on the current duty account, pinned by `duty set` or elected, and never on
another one: when `duty tick` moved the duty, the next turn continues on the new account with the
rotation handoff (the brief, the messages so far and the duty's earlier replies), and `status` shows
the rotation. A limit on the duty account ends the turn `unavailable`; the next turn runs once the
account recovers or the duty moves.

The turn's system prompt is the [lead guide](lead-guide.md), the duty's role (`duty-role.md` in the
package: how to answer, when to ask instead of starting, one task per independent piece, briefs in the
room, the limits below), the user's own standing rules from `~/.teamster/duty-rules.md` when that file
exists, the known repositories (name and path of every live or archived work task's repository) and
the room's path.

## Limits

The turn never uses `bypassPermissions`: it runs with `--permission-mode dontAsk`, the tools `Read`,
`Grep`, `Glob`, `Bash`, `Write` and `Edit`, and a PreToolUse hook (`bash_guard.py --duty-room ROOM`)
on `Bash`, `Write`, `Edit`, `MultiEdit` and `NotebookEdit`; the same `--settings` set `disableAllHooks: false`,
so no account or project setting turns the hook off. The hook fails closed and allows:

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
managers, `curl` and `rm`. Commands run by path and variable assignments are refused. A compound
command (`;`, `&&`, `||`, `|`, a subshell) is judged by every part; shell expansions (`$VAR`, `$(…)`,
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
`tasks/duty/notes.json` and go out with the next user message, as do notes held while the duty is not
a Claude account, after a failed or stopped duty turn, or in the queue of a duty supervisor that died.
Held notes leave `notes.json` only once the turn that carries them has started and is saved: a start
that fails, or a command that dies first, leaves them held for the next message, at the cost of a note
journaled twice in `messages.jsonl`. The duty conversation's own turns never notify, and a failure to
queue a note is logged in the task's `stderr.log`, never failing its cycle.

## Settings

| Key | Default | Effect |
|---|---|---|
| `duty.chat_model` | `claude.model` | model of the duty chat turns (a nonempty string or null) |
| `duty.chat_effort` | `"high"` | effort of the duty chat turns: `low`, `medium`, `high`, `xhigh` or `max` |
| `duty.chat_max_minutes` | `20` | active time budget of one duty chat turn |
| `duty.chat_auto_turns_per_hour` | `12` | nonnegative integer; note-driven turns per hour, the rest wait for the next user message |
