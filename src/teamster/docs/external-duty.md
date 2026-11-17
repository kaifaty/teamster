# External duty API v1

The Board server can expose a JSON API to a local duty client at `/api/external-duty/v1`. Teamster
owns the tasks, worktrees and worker results. The API projects the same task records that people
see in Board and runs Teamster's `start`, `say` and `stop` commands. Its operation journal and event
feed survive server restarts.

## Enable the API

Set `BOARD_EXTERNAL_DUTY_CONFIG` to the absolute path of a private JSON file readable by the
Board process. Use Board and a Teamster executable from the same updated checkout or release,
selecting the executable with `teamster-board --teamster PATH`. Use the same Teamster data home
for Board and the worker. A configuration looks like this:

```json
{
  "actor": "local-duty-client",
  "token": "replace-with-a-unique-random-token",
  "repositories": ["/absolute/path/to/main-checkout"],
  "max_parallel": 1,
  "task_timeout_seconds": 600
}
```

`actor` is a nonempty name of up to 100 characters and identifies the caller in the operation
journal. Use a fresh token of 32–256 characters from `[A-Za-z0-9._~-]`. Give absolute canonical paths to main checkouts and use the same paths
in requests. `max_parallel` (1–32) counts live task supervisors in allowed repositories, including
those waiting for capacity. `task_timeout_seconds` (1–86400) sets a wall-clock deadline that
applies across follow-ups, executor waits and Board restarts. Every route requires a loopback
connection and `Authorization: Bearer TOKEN`. Omit the configuration to leave the API disabled.
`--read-only` allows reads and disables mutations.

## Requests and responses

| Method and route under `/api/external-duty/v1` | Body or query | Success |
| --- | --- | --- |
| `GET /tasks` | | `200 {"tasks":[card, ...]}` |
| `GET /tasks/{id}` | | `200 {"task":card}` |
| `POST /tasks` | `{"request_id":"…","repository":"…","goal":"…","done_when":["…"]}` | `201 {"ok":true,"task":card}` |
| `POST /tasks/{id}/say` | `{"request_id":"…","version":"…","message":"…"}` | `200 {"ok":true,"task":card}` |
| `POST /tasks/{id}/stop` | `{"request_id":"…","version":"…"}` | `200 {"ok":true,"task":card}` |
| `GET /events` | `after` (default `0`), `limit` (default `100`, 1–100) | `200 {"events":[event, ...],"next_cursor":0}` |

Send `Content-Type: application/json` with POST requests. Start always uses `--no-push` and takes
a goal of up to 12,000 characters and 1–20 criteria of up to 1,000 characters each. The server
fixes the arguments to Teamster. `say` takes a message of up to 4,000 characters, continues the
same API-started task and queues the message if its supervisor is busy. `stop` stops a live task
in an allowed repository, including a task a person originally started. Cards can change
immediately after an operation. Refresh before deciding what to do next.

`request_id` is a caller-generated key matching `[A-Za-z0-9._-]{1,100}`. Repeat the same method,
target and JSON with the same key when the response is lost. The key is scoped to the configured
actor. A recorded result replays with its original HTTP status and JSON, even if the task has
changed since then. Reusing the key for a different operation or content returns
`409 idempotency_conflict`. The journal at `<data home>/external-duty/commands.sqlite3` records the
actor, time, operation, arguments and result. After an interrupted start, the server checks
Teamster for the reserved task before responding. An unconfirmed `say` or `stop` is never
repeated automatically. `503 operation_unknown` means the server cannot prove the result.
Inspect the task in Board before deciding whether to issue a new operation.

Send the `version` from the latest card for each `say` and `stop`. If the task changed, including
through a Board action, the server returns `409` with the latest card and
`{"ok":false,"error":{"code":"version_conflict"},"task":card}`. Read that card and decide whether
the command still applies. Use a new request ID to send a revised command.

Only Teamster work tasks in allowed repositories appear in the queue and feed. Archive history
follows Board's snapshot window, and individual archived records are addressable while retained.
`id` and `version` are opaque strings. The task ID stays the same across turns, restarts and
archiving. Pass it as a single URL path segment, with percent encoding when required by the HTTP
client. `slug` is the Teamster/Board task address and may be reused for a different task later.
The card has these fields:

| Fields | Meaning |
| --- | --- |
| `id`, `slug`, `repository` | Task identity, Teamster slug and canonical checkout path. |
| `goal`, `executor`, `account` | Original goal when available, executor and current account when known. |
| `status`, `phase`, `outcome`, `result_status`, `turn` | API lifecycle status, current Board phase, Teamster supervisor outcome, worker result status and turn number. `outcome` and `result_status` can be null. |
| `created_at`, `updated_at`, `deadline_at` | Unix seconds. `deadline_at` is null if no task deadline was set. |
| `blocker`, `question`, `summary`, `pr` | Text or null. `question` comes from an explicit request for a decision. `pr` is a URL when available. |
| `checks` | `saved` is a recorded check (`command`, `outcome`, `exit`, `seconds`, `at`) or null. `reported` contains worker-reported `{command,outcome,details}` rows. `ci` is a summary (`outcome`, `passed`, `failed`, `total`, `failing`, `seconds`, `rounds`, `reason`) or null. |
| `alive`, `stop_requested`, `archived`, `no_push` | Booleans about the supervisor and task record. |
| `host_status`, `version` | `online` on a successful read and the current version for writes. |

Statuses are `running` (including phase `sleeping`), `stopping`, `needs_decision`, `blocked`,
`succeeded`, `partial`, `failed`, `stopped` and `idle`. Check the `checks` field separately from
`status` when deciding whether a result passed verification. Host reachability is independent of
task status. On a connection failure or `503 host_unreachable`, mark the host as unreachable and keep
the last known task status. The API returns summary data and check results. Board retains the full activity
and logs for people who need them.

Errors from the API have the shape `{"ok":false,"error":{"code":"…"}}`, with `task` included when
an error returns the current card.

| Status | Codes |
| --- | --- |
| 400 | `invalid_request`, `invalid_cursor` |
| 403 | `forbidden`, `read_only`, `repository_not_allowed`, `task_not_managed` |
| 404 | `task_not_found` |
| 409 | `version_conflict`, `idempotency_conflict`, `task_not_actionable`, `deadline_exceeded`, `parallel_limit`, `repository_unavailable`, `teamster_rejected` |
| 413 | `invalid_request` (body exceeds 64 KiB) |
| 503 | `host_unreachable`, `no_teamster`, `operation_unknown` |

## Resume the event feed

Start at `after=0`. Persist `next_cursor` once you have processed the page and send it as `after`
on the next request, including after a restart. The cursor can advance on an empty page when
records for repositories outside the allowlist were skipped. Use event `id` as the deduplication
key. Keep `<data home>/external-duty-events.jsonl` to retain the feed across restarts. If a saved
cursor is no longer available, read the current task cards before starting over at `after=0`.

Each event has `id`, `type`, `task_id`, `repository`, `turn`, `at` (Unix seconds), `status`,
`outcome`, `result_status`, `summary`, `checks` and `pr`. A finished work turn emits one of:

- `needs_decision` when the typed result explicitly asks for a decision. `question` contains the
  first explicit question. A pause in output does not emit an event.
- `task_finished` for the other work turn outcomes, including failed or stopped turns. A later
  turn of the same task can emit a new event with the same `task_id`.

Board initializes the event journal when the API is enabled. The worker then writes to it as
turns finish, including while Board is down. The feed starts with turns recorded after
initialization. See [Task notifications](notifications.md) for the existing notification hooks.

## Run a local task

Run these commands from the source checkout with `uv`, `git`, `curl`, `jq`, and an executor
that is already signed in. The example creates a local Git origin and uses a temporary Teamster
data home. With default settings it uses Codex. The Board and Teamster executables are installed
alongside the scratch repository.

```sh
trial=$(mktemp -d)
trial=$(cd "$trial" && pwd -P)
repo="$trial/greeting"
git init --bare --initial-branch=main "$trial/origin.git"
git clone "$trial/origin.git" "$repo"
git -C "$repo" config user.name 'Teamster Trial'
git -C "$repo" config user.email trial@example.invalid
git -C "$repo" config commit.gpgsign false
git -C "$repo" commit --allow-empty -m 'Initial commit'
git -C "$repo" push origin main
git -C "$repo" remote set-head origin -a

uv venv "$trial/venv"
uv pip install --python "$trial/venv/bin/python" . ./board/server
export TEAMSTER_HOME="$trial/teamster"
export BOARD_TEAMSTER_COMMAND="$PWD/src/teamster/__main__.py"
export BOARD_EXTERNAL_DUTY_CONFIG="$trial/duty.json"
token=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
(umask 077; jq -n --arg repo "$repo" --arg token "$token" \
  '{actor:"greeting-trial", token:$token, repositories:[$repo], max_parallel:1, task_timeout_seconds:600}' \
  > "$BOARD_EXTERNAL_DUTY_CONFIG")

base=http://127.0.0.1:8877
api() {
  curl --silent --show-error --max-time 135 -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' "$@"
}
run_board() {
  "$trial/venv/bin/teamster-board" --port 8877 --no-land \
    --teamster "$trial/venv/bin/teamster" > "$trial/board.log" 2>&1 &
  board_pid=$!
  until curl --silent --fail -o /dev/null "$base/api/snapshot"; do
    kill -0 "$board_pid" || return 1
    sleep 1
  done
}
run_board
v1="$base/api/external-duty/v1"
api "$v1/tasks"
```

The empty queue returns `{"tasks":[]}`. Submit the goal and its criteria as JSON. The example
asks for an explicit decision before work begins so the same task can take a follow-up.

```sh
start=$(jq -n --arg repo "$repo" '{request_id:"greeting-start",repository:$repo,
  goal:"Add greeting.txt. Before changing any file, return needs_decision and ask: Hello or Hi? Wait for my answer.",
  done_when:["greeting.txt contains exactly the chosen greeting and a newline.",
             "Run grep -qx for the chosen greeting in greeting.txt and report the check."]}')
initial=$(api -X POST --data "$start" "$v1/tasks")
printf '%s\n' "$initial" | jq '{ok,task:{id:.task.id,status:.task.status,no_push:.task.no_push}}'
id=$(printf '%s\n' "$initial" | jq -er .task.id)
api "$v1/tasks/$id" | jq '.task | {status,phase,question}'
```

Selected fields from the start response look like
`{"ok":true,"task":{"id":"…","status":"running","no_push":true}}`. Repeat the detail read
until the card says `{"status":"needs_decision","phase":"idle","question":"Hello or Hi?"}`.
Read the decision event and save the returned cursor, then answer using the current card version.

```sh
page=$(api "$v1/events?after=0")
printf '%s\n' "$page" | jq '.events[] | {type,task_id,question}'
cursor=$(printf '%s\n' "$page" | jq -er .next_cursor)
version=$(api "$v1/tasks/$id" | jq -er .task.version)
say=$(jq -n --arg version "$version" '{request_id:"greeting-answer",version:$version,
  message:"Choose Hello. Make the change now and run grep -qx Hello greeting.txt."}')
answer=$(api -X POST --data "$say" "$v1/tasks/$id/say")
printf '%s\n' "$answer" | jq '{ok,task:{id:.task.id,turn:.task.turn}}'
```

The decision event includes `{"type":"needs_decision","task_id":"…","question":"Hello or Hi?"}`.
The response to `say` includes `{"ok":true,"task":{"id":"…","turn":2}}`. Restart Board with
its original configuration, replay both requests and read the feed after the saved cursor.

```sh
kill "$board_pid"
wait "$board_pid" || true
run_board
api -X POST --data "$start" "$v1/tasks" | jq -e --argjson expected "$initial" '. == $expected'
api -X POST --data "$say" "$v1/tasks/$id/say" | jq -e --argjson expected "$answer" '. == $expected'
api "$v1/events?after=$cursor" | jq '.events[] | {type,task_id,status,checks,pr}'
api "$v1/tasks/$id" | jq '.task | {status,checks,pr}'
git --git-dir="$trial/origin.git" for-each-ref --format='%(refname)' refs/heads
```

If the second turn is still running, repeat the event and detail reads. The final event is
`task_finished` and the card shows a result like this (selected fields):

```json
{
  "status": "succeeded",
  "checks": {
    "saved": null,
    "reported": [{"command":"grep -qx Hello greeting.txt","outcome":"passed","details":"Exit 0."}],
    "ci": null
  },
  "pr": null
}
```

The bare origin still has only `refs/heads/main`. When finished, stop the example Board with
`kill "$board_pid"`. The automated acceptance test uses the same CLI and HTTP routes with a
scripted executor and a temporary home. It also exercises repository refusal and stale writes
following a human stop from Board.

```sh
(cd board/server && uv run --locked pytest -q tests/test_app.py -k external_duty_lifecycle)
```
