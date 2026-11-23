# Lead guide

The lead plans, writes the brief, reviews the result and merges; the worker implements in its own git worktree.

Reference detail lives in the package docs. Read any file below with `teamster docs <name>`
(use its name without `.md`), only when its topic comes up:

| File (`teamster docs <name>`) | Read it when |
|---|---|
| [results.md](results.md) | reading `wait` output: result and review fields, CI, outcomes, wrap-ups |
| [budgets.md](budgets.md) | time and weekly caps, exhaustion, or headroom warnings |
| [ci.md](ci.md) | CI waiting and repair rounds |
| [checks.md](checks.md) | `wait` prints `guarded files changed` or `base tests`, or you consider `--guard` or `--base-check` |
| [review-cycle.md](review-cycle.md) | angle choices, fix-round mechanics and automatic stops |
| [settings.md](settings.md) | brief language, standing-rules override, default caps, `config.toml` trust |
| [sandbox.md](sandbox.md) | the user wants `--sandbox workspace`, or `wait` prints `== sandbox: workspace` |
| [accounts.md](accounts.md) | subscriptions and rotation, credits and their floor, `auto-continue at`, `needs login`, reset credits, the duty account |
| [duty-chat.md](duty-chat.md) | the user talks to the duty (`duty chat`), or a task's state has `started_by: "duty"` |
| [notifications.md](notifications.md) | the user asks about task notifications |
| [telemetry.md](telemetry.md) | `report`, or deciding whether fix rounds or review angles pay off |
| [reflection.md](reflection.md) | after `clean` of a task whose fix cycle did not converge or that ended `blocked`; the weekly batch; before changing `AGENTS.md` or standing rules |
| [desktop-threads.md](desktop-threads.md) | the thread runs in the Codex desktop app, not under this tool |

## Delegate or do it yourself

Delegate when the task is code with a clear end: one feature step, a bug fix with a reproduction, engine or
C++ work, a benchmark or test harness, a refactor with tests, a batch of mechanical edits.

Keep it yourself when:

- it is a decision, a design question, a plan, or a talk with the user;
- it is small — a few edits or tool calls cost less than writing a brief and reviewing a PR;
- it needs the user's live systems you are trusted with and Codex is not (accounts, publishing, uploads);
- the spec is still fuzzy: settle it first (with the user if needed), then delegate;
- the user's or the repository's instructions keep this kind of work for the lead, for example visual or 3D
  work. Codex then gets no task, scout or review of it, and none of the code that serves it: split a mixed
  task and delegate only the rest. Codex helps there only in the way those instructions name, such as
  [one tool run](#one-codex-tool-with-your-prompt).

Such instructions win over this guide's defaults, including delegating by default and asking scouts instead
of reading code yourself.

## The brief

A task costs what its turns last, not its reasoning level: a sprawling multi-hour thread with
self-invented protocols can consume a weekly quota. The brief keeps the turn short and the goal clear.
Write it in the language set by `language` in the settings (`~/.teamster/config.json`) (`"en"` by default, `"ru"`
for Russian), translating this structure as needed:

```
<What to do — one sentence.>

Why: <one or two sentences of context, links to docs/ and files to start with>.

Done when:
- <a verifiable condition, preferably a number or test>
- <…>

Checks: <the test, benchmark, or end-to-end test that proves it is done>.
Do not touch: <what is outside the task>.
```

`start` appends the [standing rules](settings.md#standing-rules); don't repeat them in the
brief. PR fields and publication receipts are described in [results.md](results.md).

Done when lists only what the worker can do: no PR, publication or CI step, because the supervisor does them.

Codex must not wait for remote CI inside a turn: push and finish the turn; the supervisor waits with `--ci` for GitHub or `--ci-command CMD` for other hosts.

One task per brief; split independent parts into several tasks (stacked branches with `--base` when one
builds on another). Before starting, split any task that promises more than about 60 minutes of work.
Decisions that belong to the user are not Codex's to make: put them in the brief as settled facts, or ask
the user first.

Put these in "Done when" when they apply:

- Network calls, retries or caches: the failure paths. An error is not an empty result, a lost response is
  reconciled before a retry, and side effects are idempotent.
- Changes to shared code: the neighbouring paths that must behave as on the base branch, with a test that
  pins them.
- Ordering, sync or concurrency mechanisms: every interleaving that must hold, one per line, each pinned by a test.
- Wording that matters (docs, messages, UI text): the exact text, marked as verbatim.
- Probes whose non-zero exit is a normal answer, such as a process search that finds nothing: make absence an explicit success value (for example `pgrep -f NAME || echo absent`), or the repeat guard reads it as the same failure again.

Before `start`, check that every "Done when" item can be reached within "Do not touch" and on the machine that runs it: a binary, account or service it needs exists, and a test that must fail first does fail on the base. Otherwise settle it first; a brief that cannot be finished ends in `needs_decision`.

## Commands

Run every command below as `teamster …`. Teamster finds Codex through `TEAMSTER_CODEX`, then the
ChatGPT.app bundle if present, then `codex` on `PATH`. Codex supplies its configured model and effort
when Teamster has no work overrides. The adapter uses the selected account's `CODEX_HOME`.
Existing tasks resume their saved native Codex thread. If that thread is unavailable, Teamster
reports the resume error before sending the order.
Use `start --model M` for work and `--review-model M` on `start`, `say`, or `review` for Codex reviews; `say` inherits or replaces them, and `default` clears an override. Read `accounts --json` before choosing ([models and JSON fields](settings.md#task-models)).
A task keeps the teamster version it started on after an upgrade: `say` and `review` re-run in it while it is installed; `say --upgrade` moves the task to the current version ([versioned installs](settings.md#versioned-installs)).
Use `start --task-type LABEL` to select a configured [task profile](settings.md#task-profiles) and label telemetry. `say` and `review` inherit the label, and `say --task-type LABEL` replaces it ([labels and grouped reports](telemetry.md)).
Use `start --executor codex|claude|opencode` to pin the task worker. Automatic selection starts with a task profile's executor when present, then follows the [work role profile](settings.md#role-profiles) or the configured executor default. The saved executor handles `say`, review fixes, CI repairs and wrap-up. Claude and OpenCode work require `--sandbox off`.
The [review role profile](settings.md#role-profiles) chooses the reviewer order. Without it, Claude tasks prefer Codex reviews and other workers use the configured reviewer. Use `--reviewer claude` on `start`, `say`, or `review` to select the isolated Claude pool. It prefers another account when Claude also implements. See [account setup](accounts.md#claude-account-pool).

Ordinary Codex and Claude tasks, reviews, scouts and reflections use ACP v1 over stdio. Install
`@agentclientprotocol/codex-acp` or `@agentclientprotocol/claude-agent-acp` for the corresponding
provider. The supervisor needs its `codex-acp` or `claude-agent-acp` executable on `PATH` alongside the native CLI.
Teamster opens an ACP session for a new task and saves its native cursor before the prompt.
`say`, review fixes and CI repairs continue the worker's session. A review starts its own session.
The Board's task actions use the same supervisor, saved checks, budgets and publication cycle.
Its **Открыть чат** action opens a separate interactive conversation in the worktree.

Codex uses the selected account's app-server behind the adapter for sandbox settings and native
structured output. Claude supplies its role's tools, hooks and output schema through the adapter.
Login and account probes still use the providers' native commands. Protected duty uses Teamster's
private ACP agent for the elected family. [Duty guards and handoffs](duty-chat.md)

To delegate to OpenCode from either duty family, select the worker and its configured provider/model explicitly. A direct CLI launch can use `OPENAI_API_KEY`. Codex duty clears `OPENAI_*` variables before running commands, so a provider that relies on that key needs credentials saved in OpenCode and accessible to the worker.

```sh
teamster start update-parser --brief brief.md --repo . --executor opencode --model provider/model --sandbox off --max-minutes 20
teamster wait update-parser
teamster say update-parser "Handle the empty input case."
teamster wait update-parser
```

Teamster starts a separate `opencode acp` process in the task worktree for each turn using OpenCode 2.3.2 on `PATH`. It creates the session with ACP `session/new`, saves its native ID and resumes that ID on follow-ups. Before the first prompt, Teamster sets the task slug as the session title using the standalone `session.update` metadata operation. OpenCode 2.3.2 has no ACP rename command. Setting the title avoids a model request for automatic naming. In sandbox-off mode the worker grants one-time tool permissions offered by OpenCode. Separate reviews use the selected Teamster reviewer and its account. [OpenCode CLI commands](https://opencode.ai/docs/cli/commands/)

| Step | Command |
|---|---|
| Read documentation | `teamster docs` lists documents; `teamster docs <name>` prints one |
| Find package files | `teamster path` prints the installed package directory |
| Check the version | `teamster --version` |
| Start a task | `teamster start <slug> --brief brief.md [--repo DIR] [--base origin/<branch>] [--branch NAME] [--no-push] [--task-type LABEL] [--executor codex\|claude\|opencode] [--model M] [--effort E] [--sandbox off\|workspace] --max-minutes M [--max-weekly P] --review [--review-angles LIST] --fix-rounds 2 [--ci] [--ci-rounds N] --check "<command from Checks>" [--check-timeout SEC] [--guard GLOB] [--base-check]` (base defaults to the remote's default branch; `--branch` overrides `codex/<slug>` and must pass `git check-ref-format --branch`; `--guard` is repeatable; `--no-push` keeps commits local through follow-ups, reviews, fixes and wrap-up, with no branch or PR publication and no CI) |
| Scout code | `teamster scout <slug> "question"` or `teamster scout <slug> --file Q.md`, with `[--repo DIR] [--executor codex\|claude] [--effort E] [--model M]`; read-only in the existing directory (default `.`), no worktree or branch |
| Batch reflection | `teamster reflect <slug> ["order"]` or `teamster reflect <slug> --file FILE`, with `[--executor codex\|claude] [--effort E] [--model M] [--max-minutes M]`; read-only [batch](reflection.md#batch) over the archived records since the newest `batch-*.md`, in a reading room copy; teamster writes the batch file and `INDEX.md` rows from its answer |
| Study records | `teamster reflect <slug> "order"` with `--task SLUG` (repeatable) or `[--since YYYY-MM-DD\|Nd] [--repo NAME]` (`--repo` repeatable); read-only [study](reflection.md#study) of the chosen records, written to `study-<date>-<slug>.md`; does not move the batch's `through:` |
| Lesson decision | `teamster lesson "<entry>" accepted\|applied\|declined\|proposed [--note TEXT]`; replaces the status cell of that lesson's `INDEX.md` row (see [Applying](reflection.md#applying)) |
| Wait for the cycle | `teamster wait <slug> [--through-sleep]` as a background task that reports completion when the whole review/fix cycle ends; if your harness has no such tasks, run `teamster wait` as an ordinary command or check `teamster status`; read its [output](results.md#what-wait-prints) |
| Follow-up / fix request | `teamster say <slug> "…"` or `teamster say <slug> --file FILE`, with `--max-minutes M [--max-weekly P] [--effort E] [--review] [--review-angles LIST] [--fix-rounds 2] [--ci\|--no-ci] [--ci-rounds N]` (only when idle), then `teamster wait` again; the saved check is inherited unless replaced with `--check CMD` or removed with `--no-check`; `--no-base-check` drops inherited base tests |
| Queue a follow-up | `teamster say <slug> "…" --queue` (or `teamster say <slug> --file FILE --queue`) with any `say` option except `--upgrade`: on an idle task it sends at once like `say`; while a turn runs or sleeps until a limit reset it prints `queued for <slug>: N waiting; sent when the current cycle ends`. When the cycle (turn, check, review, fix rounds, CI) ends `completed`, every queued message goes out as one turn, in order, separated by blank lines, with their options merged (later ones win); any other outcome, including `stop`, drops them unsent. Orders left by a supervisor that died before its cycle ended are dropped as `interrupted` by the next `say`, `review` or `start`, which says so. A running `wait` reports the finished cycle, `== queued orders sent: N, turn T started`, and follows the new turn; `status` shows `queued orders N`. The queue is `queue.json` in the task record ([notifications](notifications.md)) |
| First review | `teamster review <slug> [--effort E] [--review-angles LIST] [--max-weekly P]` (only when idle), then `teamster wait` |
| Look | `teamster status [<slug>]` — executor, account, state, PR, commits, last message (up to three saved messages for Claude), and the last turn's `result` |
| Cost | `teamster stats <slug>` — per-turn time, tool calls, tokens, weekly-limit % across all Codex threads; Claude work shows UTC start, active minutes, account, session, model, effort, input/output/cache tokens, dollar cost and seven-day usage growth with totals, followed by Codex reviews |
| Compare costs and outcomes | `teamster report [--since 7d\|30d\|YYYY-MM-DD] [--repo NAME] [--slug SLUG] [--by task-type\|effort\|model\|executor\|reviewer] [--json]`; `--by executor` or `--by reviewer` groups tasks by the worker or reviewer that handled them ([telemetry.md](telemetry.md#compare-executors-and-reviewers)) |
| Record your verdict | `teamster verdict <slug> accepted\|revised\|redone\|dropped [--note TEXT]` when you merge or drop the work: `accepted` merged as is, `revised` merged after your edits, `redone` redone elsewhere, `dropped` not merged; works after `teamster clean` too, and the latest verdict counts |
| Record a delegated verdict | `teamster verdict <slug> accepted\|dropped --note TEXT --expect-created TIME --expect-turn N --operation-id ID` records the selected verdict once for the exact completed turn. |
| Accounts | `teamster accounts [--json]` — logins, plans, limits, reset times and credits; JSON includes Codex and Claude pools, thresholds and the credit floor (`credits_floor`, [accounts.md](accounts.md#credits)); `teamster reset-credit <account> [--credit ID] [--yes]` |
| Sign in | `teamster login <name> [--browser]` — the human signs in with a device code, or in the browser; `login` then prints the account's `accounts` row and exits nonzero for a duplicate ChatGPT account or a failed sign-in; `teamster claude-login <name> [--config-dir DIR] [--keychain SERVICE]` saves an isolated Claude CLI account with a token entered at the Keychain prompt, then probes it; a failed probe leaves the account saved and exits nonzero |
| Probe a Claude account | `teamster claude-probe <name>` — send one short request to check its token and cache five-hour and seven-day limits |
| Rename a Claude account | `teamster claude-rename <old> <new>` — rename its pool entry and cached limits, keeping its config directory and Keychain service |
| Duty account | `teamster duty tick` — refresh stale limits and elect the duty account that new work skips; `teamster duty status [--json]` — duty, reason, pinned or elected, rooms and check age, warning after 90 minutes; `teamster duty set <account> [--family codex|claude]` — pin the duty by hand, kept by every tick; `teamster duty auto` — remove the pin and elect at once; `teamster duty clear` — no duty and no pin; `teamster duty plist [--minutes 30]` — print a launchd job for `teamster duty tick` ([accounts.md](accounts.md#duty-account)) |
| Remove a Claude account | `teamster claude-remove <name>` — remove its pool entry and cached limits, leaving its directory and Keychain entry for manual deletion; the last account cannot be removed |
| Interrupt | `teamster stop <slug>` (there is no mid-turn steer for exec; stop, then `teamster say`); a stop drops messages queued with `say --queue` |
| Continue after a signal | `teamster resume <slug>...` or `teamster resume --all` when `wait` or `status` prints `interrupted externally by <signal> at <time>; continue: teamster resume <slug>`: a restart of the machine or the supervisor cut the cycle short. It continues each such task from the step it stopped at, with its saved settings (`--all`: every such task at once), then `teamster wait` again; `stop` and finished cycles are refused. See [resuming](results.md#resuming-an-interrupted-cycle) |
| Finish | `teamster clean <slug>` after the PR is merged: removes the worktree, deletes the local branch, archives every thread, and saves the task record in `~/.teamster/tasks/.archive/` except `events.jsonl` and `state.lock`; it reminds you when the task has no `teamster verdict` |
| Archive a delegated run | `teamster clean <slug> --archive-safe --expect-created TIME --expect-turn N --expect-head SHA --expect-verdict VERDICT --operation-id ID` verifies a completed managed worktree, preserves its branch and task logs, and archives untracked and ignored artifacts before removing the staged worktree. Use the same operation ID to recover its receipt. |
| Archive an accepted run's journal | Add `--archive-record-from BASE` when both the managed checkout and branch are already absent. Pass the merged PR's commit as `--expect-head`; it must be reachable from `origin/BASE`. This archives the task record without removing any project files. |

The worktree is `~/.teamster/worktrees/claude-<slug>/<repo>` on branch `codex/<slug>` (or `--branch NAME`); state and logs are in
`~/.teamster/tasks/<slug>/` (a legacy home uses `~/.codex/worktrees` and `~/.codex/claude-tasks`; `teamster migrate-home` moves it, see `teamster docs settings`). Only one task runs at a time unless you pass `--parallel`; use that only
when the tasks' builds and tests cannot interfere. A task's turn survives the end of your session; in a
new session `status` and `wait` pick it up again.

When parallel tasks touch the same shared files, land the sibling PRs that are ready together, then send each branch still open one `say` to merge the base; or tell Codex to merge `origin/<base>` once, right before its final push. Merging siblings one at a time costs every open branch a merge round and a full CI wait each time.

A PR far behind its base (hundreds of commits) is not a plain merge task. Before the brief, compare what its scenarios or tests do on the base now, name in the brief the base commits that rewrote the files it touches, and decide whether to port the change onto the base instead of merging. Do not run it while sibling tasks are rewriting the same files: land them first, or the base moves under the task every round.

Scouts need no `--parallel`: run several at once, one question each, alongside tasks. `say` continues a
scout's read-only thread; `--check`, `--review`, `--review-angles`, `--fix-rounds` and `review` don't
apply to scouts. `clean` on a scout archives its record the same way, never the inspected directory.

Scouts use their [role profile](settings.md#role-profiles) when configured and otherwise prefer Codex.
Use `scout --executor claude` to pin the Claude pool. A Claude scout needs a directory inside a git
work tree. It uses review-role accounts and `max_review_minutes`. After Claude is selected, an
unavailable pool stops the scout. Its answer is free text. `say` resumes the same session and
account when available. Claude scouts use the review tool restrictions, and teamster compares git snapshots
before and after every turn: any change fails the turn and discards its answer, leaving the change
visible for inspection. Existing uncommitted changes alone do not fail a turn.

### One Codex tool with your prompt

When the instructions allow Codex only one tool for work kept for the lead, for example image generation, run
it as a scout with `--executor codex` and `--repo` set to a new empty directory. Run `git init` there first: Codex refuses a
directory that is neither trusted nor a git repository. Put your prompt in the question verbatim and ask
only for the output file paths and the prompt as sent, not for an assessment. Judge the output yourself.

## ACP conversations

`teamster acp` starts a local Agent Client Protocol v1 agent over stdio. Pass the
executable and its arguments after `--`. The agent runs with your environment
and its own permissions in the directory selected by `--repo DIR` (default: the current
directory). To chat in a task's worktree, pass that worktree as the directory.

```sh
teamster acp --repo . -- opencode acp
```

To use a specific OpenCode subscription, pass the exact provider/model ID from
`opencode models`, for example `--model alibaba-token-plan/qwen4-max` before
`-- opencode acp`. Teamster waits for the agent to confirm the selected model
before it accepts the first prompt. An unavailable or unconfirmed selection ends the session.

Sign in using the agent's own CLI, or select an agent-managed authentication method with
`--auth-method ID`. Enter one message per line. Teamster streams the reply to stdout and
prints the session ID, tool activity and permission choices to stderr. Choose a numbered
option at a terminal. An empty choice or piped input cancels the permission request.
Ctrl-C during a turn requests cancellation. EOF at the prompt ends the conversation.

The Board uses `--events` for a bidirectional stream of JSON lines. After `ready`,
send `{"type":"prompt","text":"..."}`. The client emits text in `chunk` events and
ends each reply with `done` and its `stopReason`. A `permission` event contains the
tool call, options and request ID. Reply with `{"type":"permission","id":1,"optionId":"..."}`
using the displayed ID and one of its options, or `null` to cancel. Keep stdin open
for the conversation. Closing it ends the agent, including a pending turn or permission.

To continue a conversation, use the same agent and directory with `--resume SESSION_ID`
if the agent supports restoring sessions. The agent restores its context, and the CLI
prints replies to new messages. These conversations are driven by their caller and use
the agent's own session storage.

## Budgets and checks

Pass `--max-minutes M` on every implementation `start` and `say`, sized to the task. Use
`--max-weekly P` to bound weekly usage; allow extra budget for parallel work on one account.
See [budgets.md](budgets.md) for cap mechanics and [telemetry.md](telemetry.md)
for usage accounting. Saved checks and their output are described in [checks.md](checks.md).
A script that `--check` runs must live in the repository or a stable directory such as
`~/.codex/checks/<repo>/`, never in a temporary session directory, which is deleted with its session.

## The loop

Before briefing unfamiliar code, ask scouts instead of reading files yourself, then `wait` for their
reports. Verify key facts by reading only the cited `file:line` locations; use `say` for follow-ups.

1. Write the brief to a file outside the repository (a temporary directory),
   so it cannot enter a checkout commit. Run
   `start --max-minutes M --max-weekly 10 --review --fix-rounds 2 --ci --check "<command from Checks>"`
   for GitHub repositories (use `--ci-command CMD` for other hosts), then
   one `wait` for the whole cycle as a background task that reports completion. If your harness has no
   such tasks, run `wait` as an ordinary command or check `status`. Add `--review-angles auto` for large or risky PRs (processes, concurrency,
   security), `--base-check` when behavior must stay the same (refactoring, optimization), and `--guard`
   for test files the check reaches only through `sh -c`. Tell the user in a line what went to Codex and
   that you will report back; don't sit and poll.
2. When `wait` returns, follow the [turn outcome table](results.md#turn-outcomes), then read
   `result`:
   - `needs_decision`: decide yourself if the decision is within the task, otherwise ask the user; send
     the decision with `say`. `blocked`: resolve the blocker or take it to the user. `partial`: `say`
     the next instructions.
   - `done`: read the check result and the latest review; if there was no `--review`, run `review` and
     `wait` again. If the check failed and the cycle stopped, send a fix request before a review.
   - `result` unknown: read the original final message and continue the same way.

   The supervisor's check result is objective evidence for that command; the summary, finding decisions
   and rejection reasons are worker claims to verify.

   You can queue a message with `say --queue` instead of waiting for the turn to end: it goes out as the
   next turn when the current cycle completes, and the same background `wait` follows that turn too.
3. Read the actual diff (`gh pr diff <n>` or `git -C <worktree> diff <base>`), the latest review and
   every rejection reason. Check each finding and rejection against the code, then review the parts the
   findings did not cover for real failures. On `guarded files changed`, read every named file in full
   (a deleted file's base version too) and make sure no assertion was removed, no test skipped, no
   tolerance widened, and no mock replaced the code under test. Examine any base-test failure before
   accepting the work, even when the check and review pass. Follow the repo's review rules. Check the
   numbers against "Done when". A passing check does not replace reading the diff.
4. Problems found, or findings left after the round limit → one `say` with all of them, each with what's
   wrong, what to do and how it is checked, with `--max-minutes M --review --fix-rounds 2 --ci` for another
   bounded cycle. Before a `say` that dictates a mechanism or a behaviour rule, read the touched subtree's `AGENTS.md` and the behaviour on the base branch; if you have not, state the outcome and the constraints, leave the mechanism to the worker and ask it to check the repository's rules first. Group findings of different angles that describe one defect before you write the fix request.
   A `say` that merges the base keeps the saved check and `--fix-rounds`: name extra tests in
   addition to the check, never instead of it. Decide yourself whether P3 findings and work rejected as
   `out of scope` belong in a separate task, and record deferred work in issues when appropriate.
   After a stop on `only P3`, send every P3 worth fixing in one `say`; P3 findings that the next review raises in new code go to a follow-up task, not into another `say`. Test P3 findings left after a stop on `only P3` (a test that stays green under a break, a check that misses a removal) go to the task's follow-ups or a separate task, not into a new `say`.
5. For a GitHub PR, merge only when `wait` reports `CI … passed`; `failed`, `timeout`, `none`, and
   `skipped` need resolution first. Immediately before merging, run `gh pr checks <url>` again and
   verify all checks pass or skip. Merge per the repo's rules, then `clean`. If the task failed expensively,
   [reflect](reflection.md#when) on its record now; other records wait for the weekly batch.
   Report to the user: what Codex did, what you checked, what is still open, the PR link, and any account
   switch `wait` reported.

## Stop rules

- Read the [automatic stop reason](review-cycle.md#cycle-stops) and decide what happens
  to remaining P3 findings.
- On `escalate`, read the finding and the named fix round's diff. Choose one: simplify with a narrow
  `say` instruction to remove the extra mechanism; accept the finding as P3 or record an issue; or
  allow one focused round with `say <slug> "…" --max-minutes M --review --fix-rounds 1`.
- After two rounds on the same point, take it to the user.
- After two `budget_exhausted` turns in a row, don't send another continuation. Split what remains into
  new briefs that each fit one turn.
- A Codex PR you started through this tool is your work for the repo's merge rules; still ask the user
  before merging anything they asked to see first, or anything that breaks what is in use.

## Pitfalls

- Tasks run local Codex tools with the user's Codex configuration. Make the task boundaries explicit in
  the brief and follow the repository's rules.
- Do not add accounts or enable rotation unless the user tells you to
  ([accounts.md](accounts.md)).
- `clean` removes the task worktree and saves its record in `~/.teamster/tasks/.archive/` except `events.jsonl` and `state.lock`; run it only after reviewing and merging the result.
