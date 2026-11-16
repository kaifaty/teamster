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
command refuses). `status duty` shows the room and the number of answers; `clean duty` removes the
room and archives the record, and the next message starts a new conversation.

Without a duty account (`duty.json` absent or its `account` null) the command fails with
`no duty account` and starts nothing. A Codex duty is refused the same way: the chat needs a Claude
duty. The turn always runs on the current duty account and never on another one: when `duty tick`
moved the duty, the next turn continues on the new account with the rotation handoff (the brief, the
messages so far and the duty's earlier replies), and `status` shows the rotation. A limit on the duty
account ends the turn `unavailable`; the next turn runs once the account recovers or the duty moves.

The turn's system prompt is the [lead guide](lead-guide.md), the duty's role (`duty-role.md` in the
package: how to answer, when to ask instead of starting, one task per independent piece, briefs in the
room, the limits below), the user's own standing rules from `~/.teamster/duty-rules.md` when that file
exists, the known repositories (name and path of every live or archived work task's repository) and
the room's path.

## Limits

The turn never uses `bypassPermissions`: it runs with `--permission-mode dontAsk`, the tools `Read`,
`Grep`, `Glob`, `Bash`, `Write` and `Edit`, and a PreToolUse hook (`bash_guard.py --duty-room ROOM`)
on `Bash`, `Write`, `Edit`, `MultiEdit` and `NotebookEdit`. The hook fails closed and allows:

- `teamster start|say|scout|review|stop|status|wait|report|docs|accounts` and `teamster duty status`,
  except `say`, `stop`, `review` and `wait` on the duty conversation itself;
- read-only `git log|diff|show|status|fetch|ls-files|grep`, with no global option but `-C DIR`
  (outside the room) and `--no-pager`, and without `--output`, `-O`/`--open-files-in-pager` or
  `--upload-pack`;
- read-only `gh pr view|diff|checks|list` and `gh run view|list`;
- `ls`, `cat`, `head`, `tail`, `wc` and `rg` (without `--pre` or `--hostname-bin`).

Everything else is refused, in particular `gh pr merge`, `git push|commit|merge|rebase|reset|checkout`,
`teamster clean|verdict|login|claude-login|duty tick|duty clear`, `scripts/bump_version.py`, package
managers, `curl` and `rm`. Commands run by path and variable assignments are refused. A compound
command (`;`, `&&`, `||`, `|`, a subshell) is judged by every part; shell expansions (`$VAR`, `$(…)`,
backticks, arithmetic, globs, braces, the body of an unquoted heredoc that expands) and control
keywords are refused. Redirections and the file tools may write only inside the room and outside its
`.git` (`/dev/null` and `2>&1` are fine). The duty never merges, releases or accepts work: that stays
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
followed by what `wait` prints (result, checks, review, CI, PR). A cycle that sent the task's own
queued orders goes on, and the end of the next one notes the duty. The note joins the running duty
turn's queue, or starts a note-driven turn while the duty is idle. At most
`duty.chat_auto_turns_per_hour` note-driven turns start in an hour; the rest wait in
`tasks/duty/notes.json` and go out with the next user message, as do notes held while the duty is
not a Claude account or after a failed or stopped duty turn. The duty conversation's own turns never
notify, and a failure to queue a note is logged in the task's `stderr.log`, never failing its cycle.

## Settings

| Key | Default | Effect |
|---|---|---|
| `duty.chat_model` | `claude.model` | model of the duty chat turns (a nonempty string or null) |
| `duty.chat_effort` | `"high"` | effort of the duty chat turns: `low`, `medium`, `high`, `xhigh` or `max` |
| `duty.chat_max_minutes` | `20` | active time budget of one duty chat turn |
| `duty.chat_auto_turns_per_hour` | `12` | nonnegative integer; note-driven turns per hour, the rest wait for the next user message |
