# Teamster operator

Inkling 2 Mini reads finished work turns through Pi and recommends the next step. On a writable
Board it also maintains generated titles for current project tasks. The
[external duty API](../src/teamster/docs/external-duty.md) limits title changes to the
configured repositories.

## Run one page

Use Node.js 22.19 or newer. Start a training Board with `--read-only`, allow only its training
repository, and export its bearer token as `BOARD_TOKEN` in the operator's environment.
Run these commands from the Teamster checkout with the llama.cpp tunnel open.

```sh
npm --prefix operator ci
export BOARD_URL=http://127.0.0.1:8877
export MINI_BASE_URL=http://127.0.0.1:18779/v1
export OPERATOR_STATE="$PWD/operator/operator.sqlite"
npm --silent --prefix operator start -- --once
```

`BOARD_URL` is the Board origin. `MINI_BASE_URL` defaults to the address above and always uses
`inkling-2-mini` through OpenAI-compatible chat completions. Both URLs must use loopback HTTP.
Only Board receives the bearer token. Use a separate `OPERATOR_STATE` file for each Board.
The default file is `operator.sqlite` in the process working directory.

On a Board with actions enabled, give the operator the separate `observer_token` from the
[external duty configuration](../src/teamster/docs/external-duty.md#enable-the-api) as `BOARD_TOKEN`.

Omit `-- --once` for continuous polling. Empty pages are polled every five seconds. Stop with
Ctrl-C or SIGTERM. Reuse the same state file to resume.

The operator checks for one title to assess per poll. The Board supplies the linked brief
and latest report, then checks the context fingerprint, status and title ownership at save time.
Each context is recorded once. A user title takes precedence, including on reopened tasks.

## Inspect a run

To open the Operator panel on the Map or Board, set `BOARD_OPERATOR_STATE` in the training
Board's environment to the absolute path of the same `OPERATOR_STATE` file and start the Board
with `BOARD_EXTERNAL_DUTY_CONFIG` and `--read-only`. The panel shows a live review marker and the
latest 50 recommendations linked to retained cards in the configured repositories.
The activity panel reads the state file in read-only mode. Earlier state files show their saved history
before the updated observer starts reporting active reviews.

## Chat with Mini

Run the operator continuously with the same SQLite state file as an actions-enabled Board.
Both processes need write access to this file, and the operator uses its existing bearer credential.

**Оператор** opens the chat. Mini can list projects, search task titles and slugs across the
Board and Map, and read task evidence including dependencies, linked runs, checks, and remaining work.
**Спросить оператора** attaches the selected card. The tool routes are read-only and require an
active chat request. Background reviews keep the external duty repository scope.

Each question allows up to five model calls and six Board reads, within a 60-second model deadline
and a two-minute deadline from submission. The state file holds questions and replies temporarily
so the Board can retrieve them. The browser tab holds conversation history until the page reloads.

## Review logs and budgets

Stdout contains JSON lines. Each `board_request` identifies the method and route. Each
`model_call` identifies the event and outbound attempt. A `recommendation` includes the opaque
task ID, event ID, model call count and text. Its `source` is `mini` for a model answer after a
card read or `handoff` for a request for human review. The `page` line gives the cursor and
counts for that poll, including polls with zero model calls.

```sh
sqlite3 -header -column "$OPERATOR_STATE" \
  'SELECT event_id, task_id, model_calls, source, recommendation FROM recommendations;'
sqlite3 "$OPERATOR_STATE" 'SELECT cursor FROM feed;'
```

Each event can use at most three model calls in 60 seconds, including Board tool reads.
The operator reserves a call immediately before sending it. A restart preserves spent calls
and the original deadline. It commits the recommendation under the event ID before saving
the page cursor. If the cursor is lost, it compares current cards with recorded task IDs and
turns, lists unrecorded turns in a `reconcile` line and reads again from zero. Only an event
with its own stable ID can produce a recommendation.

## Reproduce the three outcomes

```sh
npm --prefix operator test
```

The test runs the CLI with a temporary SQLite file, an HTTP Board fixture and a scripted
chat-completions server. It checks the exact recommendation for each card, the actual HTTP
calls, replay, empty-page cursor advancement and both budgets. To read the same training
cards with the real Mini through the same CLI, run the following from the checkout.

```sh
TRIAL_MINI_URL=http://127.0.0.1:18779/v1 \
  node --test --test-name-pattern='three work outcomes' operator/test/observe.test.ts
```

The live smoke test verifies a Board read for each task ID and a recommendation with
`source=mini`. It checks the saved command and its outcome, the assigned executor's name
or a reference to the same worker on failure, and the verbatim question for the human
decision. Read the three printed recommendations to judge the next actions in Mini's own words.
