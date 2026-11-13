# How reviews, angles and fix rounds run

The lead's default cycle and response to stops are in [lead-guide.md](lead-guide.md). This file covers what
the supervisor does in between. Before each automatic review, angle, or fix round, it checks the
remaining task weekly budget. Exhaustion skips that phase and stops fixes with `auto_fix_stop: "budget"`.

## Automatic review

`--review` on `start` or `say` runs a review in a fresh thread after a `done` result and a passing
check, or after an unstructured result, for compatibility. A completed work turn with a `partial` or
`blocked` result also runs the saved check and one review when the task branch has commits beyond
its base and its HEAD is published to `origin` (or the task uses `--no-push`). It uses the same
reviewer and angles as `done`, saves the findings normally, and starts no fix rounds:
`auto_fix_stop: "result partial"` or `"result blocked"` records why, without `review_skipped`.
Without eligible commits, these results still skip review. `needs_decision` always skips automatic
review and keeps its existing saved-check behavior so the lead can answer first.

Every review prompt names the command and result of the passing saved check and tells the reviewer
not to rerun the full suite; only focused checks that confirm a specific finding run again.

The review prompt lists deleted tests and asks the reviewer to account for each contract, treating a still-valid contract removed without replacement as P2.

In the task's first review (no review recorded in `rounds` yet), both the ordinary review prompt and
the `tests` angle ask the reviewer to identify, for each test required by "Done when" (a limit, guard
or value), a small break in the tested code that leaves the test green, and report a finding naming
the break and explaining why the test misses it. Repeat reviews (fix rounds, and reviews after the
lead's `say` or `review` once `rounds` holds a review) replace that rule: the reviewer checks whether
the earlier findings about tests are resolved and looks for such breaks only in tests added or changed
since the previous review. In every review, a test that stays green under a break is P2 only when
"Done when" requires that test; for any other test it is P3.

Before the first automatic review and every repeat review after a fix, the supervisor fetches the
task's base when its first slash-separated segment names a configured remote (`git remote`),
such as `origin/main`, then runs `git merge-tree --write-tree HEAD <base>`. A SHA or local branch
(including names such as `claude/topic`) is verified with `git rev-parse --verify` and checked as is,
without a fetch. A clean merge proceeds to review without changing the task branch.
If fetching or merge-tree fails (for example, without network
access or with an older Git), or a local base cannot be resolved, the supervisor records the reason,
skips this check and proceeds to review. `teamster wait` prints `== base merge <base>: skipped (<reason>)`
for each skipped check. Standalone `review`, the CI cycle and PR publication do not run this check.
If a stacked remote base is missing, the supervisor switches once to the same remote's default branch from `refs/remotes/<remote>/HEAD` and checks that base; if the default cannot be resolved or another fetch error occurs, it records a skip reason.

When the base conflicts and a `--fix-rounds` round remains, the supervisor uses that round to merge
the base instead of starting review. The implementation prompt lists the conflicting files and asks
for an ordinary merge commit, without rebase or force-push, preserving the intent of both sides and
running the saved check in full, or only the brief's test subset for a historically long check
(see [checks.md](checks.md)). The merge is recorded in `rounds` and counts toward the same fix
limit. The saved check and review then follow as after any other fix round, including another base
merge check before review.
For a review-only `partial` or `blocked` result, a base conflict is recorded but does not prevent
review or start a merge round.

Automatic base merge rounds are unavailable in `sandbox: workspace`, where the worker cannot write
Git metadata. With a fix round remaining, a base conflict fails explicitly before spending a round;
merge the base outside the sandbox before continuing with `say`.

## Review provider

`start`, `say`, and `review` accept `--reviewer codex|claude`. The default is the `reviewer` setting
(`codex`); the task saves the selection, and follow-ups and standalone reviews inherit it unless
overridden. `--reviewer` selects the provider; `--review` still enables automatic review.

With `--reviewer claude`, each review uses a fresh Claude Code CLI process with the same review prompt
and result schema. Work and fix rounds remain in Codex. Before each review or angle, the supervisor
selects an account from the role-neutral `claude.accounts` pool: below `soft_switch_at` in both the
five-hour and seven-day windows first, then below `switch_at`, ordered by earliest seven-day reset.
Unknown limits count as available. Angles in the same review prefer different available accounts.
Claude usage does not add to the task's Codex weekly percentage. Review state, journal rows,
`report --json`, and `wait` identify the selected Claude account. `wait` prints
`== review by claude/<name> (N min)` or `== review angle X by claude/<name> (N min)`.

The supervisor removes inherited `CLAUDE*` and `ANTHROPIC*` environment variables, reads the reviewer
token from macOS Keychain immediately before launch, and supplies the isolated config directory and
token through the environment. Claude runs with `--permission-mode dontAsk`, allows
`Read,Grep,Glob,Bash`, and disallows `Edit,Write,NotebookEdit`. The supervisor disables Git filters
and compares `HEAD`, `git status --porcelain`, and raw contents of tracked and nonignored untracked
files before and after review: any change fails with `reviewer modified the worktree`, preserving
the worktree for inspection.

A rejected rate limit or 401/403 authentication failure marks the account unavailable until its
reported reset and repeats the same review on the next available Claude account. All attempts for
one angle share its `max_review_minutes` budget; switching accounts uses only the remaining time.
An unreported
reset is shown as `unknown`. `wait` prints
`== claude account <a> limited until <time>; review by <b>` once for that switch. Only when no Claude
account is available does this failure fall back to an ordinary Codex review.
The Codex fallback starts a new review with its own full `max_review_minutes` budget.
A missing Keychain token marks that account unavailable for one hour and retries another account
within the same angle budget; the switch line includes `token unavailable`. After the hour the
account is tried again: a successful token read clears the mark, a still missing token sets it for
another hour, and `claude-login <name>` clears it at once.
A missing executable
during the cycle, error result, or invalid structured output retains the immediate Codex fallback;
`wait` reports `== reviewer claude unavailable: <reason>; review by codex`. Review timeouts, `stop`, and external
signals keep their usual outcomes and do not fall back. Cancellation sends SIGINT to Claude's
process group, waits up to 10 seconds, then sends SIGTERM if needed.

Account setup is in [accounts.md](accounts.md#claude-account-pool); optional model, effort and turn
limits are in [settings.md](settings.md#claude-accounts).

## Angles

`--review-angles auto` runs `correctness,concurrency,tests` when the diff from base, including
uncommitted changes, reaches `review_angles_min_lines` changed lines; below that it runs one ordinary
review. For a specific risk, pass a comma-separated list instead:

- `correctness`: behavior and the brief's "Done when" conditions;
- `concurrency`: races, processes, signals, shared files and state, retries, and recovery;
- `security`: secrets, shell and path injection, untrusted input, permissions, and sandbox boundaries;
- `tests`: weakened or ineffective tests, uncovered brief conditions, and mocks replacing tested code.

On `start` and `say`, `--review-angles` implies `--review`.

Angles run one after another in fresh Codex threads, with ordinary account rotation and reset waiting,
or in separate Claude CLI processes with `--reviewer claude`. Each angle gets its own review record.
The supervisor combines the findings, merges duplicate locations and
titles, and labels each finding with its angles. A refused angle is marked `refused` without stopping
the others, and the verdict uses the other results.

## Fix rounds

`--fix-rounds N` (0–5, default 0) needs `--review`.

Each round sends the review's findings straight to the implementation thread, with the same account
rotation and reset waiting as `say`. Codex must verify each finding against the code, fix real defects
(with tests where useful), reject incorrect findings with a one-line reason, then commit and push.

When the review ran more than one angle, the fix prompt asks the worker to group findings from
different angles that describe one defect, fix it once, and list every id in `findings` with the
same `note`. This instruction is absent for a single angle and for base merge rounds.

Severity follows a realistic trigger: P1/P2 require behavior reachable with inputs or states from this
repository, the brief or normal use; hypothetical or synthetic inputs are P3. Unrequested scope is a
finding too: options, settings, abstractions, files or generality that "Done when" does not need are P2
when they add an unrequested interface or behavior, otherwise P3; say what to remove. Fixes use the
smallest change and narrow the solution: if a fix needs a new mechanism, make the unsupported case
fail loudly or reject the finding as `out of scope`, with the reason in its finding decision and the
work in `remaining`. Fix unrequested-scope findings by deleting the extra code.

The saved check runs before the next review, which starts in a fresh thread. That review receives the
rejected findings and their reasons, with an instruction to explain any disagreement before raising one
again. From the second review on, reviewers look for regressions introduced by fixes and unmet "Done
when" conditions; new edge cases outside the brief are P3 only. After a review with angles, the next
review runs only the angles that found defects, plus `correctness`; an ordinary single review stays a
single review.

A completed fix turn with a `partial` or `blocked` result gets the saved check and one repeat review
when it adds published commits (or commits with `--no-push`). The repeat review keeps the usual
angle selection and records its findings, then stops with `auto_fix_stop: "result partial"` or
`"result blocked"`, even if rounds remain. No new commits, unpublished commits, or `needs_decision`
keep the existing stop before another saved check or review, with `review_skipped` recording the
result. A failed saved check still prevents review; the status prevents another fix round.

A check failure after a fix spends the next available round on the last 40 lines of `check.log`
instead of review findings. If no round remains, the cycle stops without another review.

Each round records the commits added to the task branch, including supervisor commits in workspace
sandbox mode. Base merge rounds record only first-parent commits, excluding imported base commits
from fix attribution. After a fix review, a P1/P2 finding with a file and line stops the cycle with
`auto_fix_stop: "escalate"` if `git blame` at `HEAD` attributes any line within two lines of its
location to a commit from an earlier fix round. Missing files and out-of-range lines do not match;
P3 findings keep their existing behavior.

Each completed review records its P1/P2 findings that have a file and a line within it, with the function
around each: the nearest line at or above it in the file at `HEAD` that starts with a letter, `_` or `$`,
as in Git's default hunk header. This history (`review_families`) spans the task's turns, so a
`say` or standalone `review` continues it. When the fix cycle starts from a review, or after a fix review,
a new P1/P2 finding in the same file and function as a P1/P2 finding of the review just before it stops the
cycle with `auto_fix_stop: "state model"`, without spending a fix round. A finding is not new when the
previous review raised one with the same title in that file. Missing files and out-of-range lines do not
count. The `escalate` check runs first.

The lead chooses the next action as described in [lead-guide.md](lead-guide.md#stop-rules).

Round size is informational and does not stop the cycle. Base merge rounds omit size because their
diff includes imported base changes; see
[results.md](results.md#what-wait-prints) for the output.

## Cycle stops

The automatic cycle stops on a `clean` review, only P3 findings (`auto_fix_stop: "only P3"`), the round
limit, escalation, a repeated family of findings (`state model`) or the budget gate described above,
a review where every angle refused (`auto_fix_stop: "review refused"`), an incomplete implementation
result (after reviewing eligible commits as described above), or a non-completed
[turn outcome](results.md#turn-outcomes).

For turns that allow fixes, a base conflict without an available fix round stops before review with
`auto_fix_stop: "base conflict"`, including when `--fix-rounds` is omitted or zero. `wait` names the
base and conflicting files so the lead can decide how to continue.
