# teamster board

A read-only local view of teamster tasks and Claude Code sessions from the Claude desktop app,
with phases, accounts, live activity and configured machine metrics. The server reads JSON and event logs from disk without
importing the plugin or changing source files. REST and WebSocket
payloads are defined in [CONTRACT.md](CONTRACT.md).

From the repository root, with Python 3.10+ and uv installed:

```sh
uv run --project board/server teamster-board
```

Open http://localhost:8787. The server listens on `127.0.0.1` by default; CLI options are
`--host` (default `127.0.0.1`) and `--port` (default `8787`). Requests must use a localhost Host header;
WebSocket Origins, when present, must also be localhost. The server reads task files and machine
metrics and listens on localhost; it has no task control endpoints.

The frontend builds into `board/web/dist`, which the server serves with an SPA fallback:

```sh
npm --prefix board/web ci && npm --prefix board/web run build
```

Until that directory exists, `/` returns a short build instruction. The API is available independently.

The header switches between two views of the same data: «Доска», the columns, and «Карта», a space fleet
in painted art, drawn with PixiJS (loaded only when the tab opens). The galaxy shows every repository as a star, and nothing joins them: no supply lines and no
tankers. The stars stand on a hexagonal lattice whose step follows their count, so a few stand wide apart and many fill
the galaxy evenly, clear of the science station, the columns at the edges, the toolbar and the ship's log; a star keeps
its place while it fits there (`galaxyLayout` in `board/web/src/map/layout/stars.ts`).
Every subscription stands as a fuel tank in a column on the left edge of the galaxy, Codex above Claude, under the toolbar
and above the ship's log (`fuelPositions`); on a phone the tanks stand in a row under the toolbar. The fuel in a tank's
glass is the week's limit left, in the family's colour and red at 20% or less, where a warning light blinks; an
exhausted, limited or logged-out tank turns grey. Seven lamps beside it burn one per day until it refills: the weekly
reset, or the end of the limit that ran out. The admiral's badge crowns the duty account, the one teamster keeps for the
orchestrator and new tasks skip. The label on the right tells the name, the share left and the time to the refill
(«83% · ↻ 5 д»), with a spare cell for every free reset of a Codex account; its title has the five-hour window, the
reset times and when the free resets expire.
Every machine of the machines strip stands as a reactor in a column on the right edge of the galaxy
(`machinePositions`), in three rings, outside in: CPU, memory and the GPU — its video memory where it has its own, else
its load (`machineRings` in `board/web/src/lib/machines.ts`). A ring's arc is the share in use and its dark rest what is
free: calm in its own colour, gold when busy and pulsing red when overloaded, by the machines strip's thresholds; a thin
outer ring shows the fullest disk while it runs low. The core's glow tells the status — green free, amber busy, pulsing
red overloaded — and it turns faster the busier the CPU; a grey reactor has no connection or no data. The label on its
left tells the name and what is free, each figure after a dot of its ring's colour («● 22 ядра ● 22 ГБ ● 9,7 ГБ»), the
status instead when the machine is offline, and the name alone on a phone. A click on the reactor or its label opens the
same machine card as on «Доска»; like the tanks, the reactors stay live during a replay. The map
tab has no machines strip: there the machines live in the galaxy, as the accounts do.
A busy star's label is one line: its name, its ships and badges for alarms, ships waiting for you and sleeping ones.
Labels stand around their stars without overlapping, alarms first (`board/web/src/map/declutter.ts`); one with no room,
and a quiet star's name, shows on zooming in or under the pointer. A click on a star flies into its system: the
sun is the main branch, and each task is a ship that moves towards it, from the yard through the range, the
inspection and the hypergate to the roadstead, where it waits for you. The yard is an orbital dock over the limb of
the system's home world, a large planet at its left edge from which new ships fly in. The inspection is a checkpoint, an
open frame with its name over it like a sign: the ships under review stand in its lanes, each under a scanner beam of its
reviewer's colour, and the rest queue before its entrance (`lanesOf` in `board/web/src/map/layout/parking.ts`). A ship leaves it
with a green tick over a clean review, or with a red ring back to the yard, where it carries a red mark per finding while
it fixes them, and «Корабли системы» tells their count. Sleeping ships drift in the
cryofield, the lead's sessions stay at the command station. A system is laid out in the part of the window the toolbar, the list of
its ships and the folded log leave free, and its world takes that part's shape. Each station parks its ships on one
arc on its own side, away from its name, the ships in trouble first; a station shows a few ships, and a count «+N»
stands for the rest and opens the list at that station (`parkingOf` in `board/web/src/map/layout/parking.ts`). The list
«Корабли системы» names every ship by station at the right of the map, and «Корабли» in the toolbar hides it; on a
phone it opens over the map. The galaxy and a system move alike: a mouse wheel zooms around the
pointer, two fingers on a trackpad move the camera in any direction and a pinch zooms, dragging moves the camera, and
`+`, `-`, the arrows and `0` (the whole view) work on the focused map; zoomed in, every edge of a system can be brought
out from under the panels. Zooming on past the closest galaxy over a star enters
its system; past the full view of a system, or Esc, goes back. `board/web/src/map/navigation.ts` tells a mouse wheel
from a trackpad. `board/web/src/map/placement.ts` decides the station and the action.
`board/web/art/` holds the prompts of the art and the script that prepares it.
A repository may look like itself: `<data home>/board-art/<repo>/` can hold its own `sky.jpg`, `planet.png` and `emblem.png`, outside
this public repository. The sky replaces the system's shared sky, the planet its home world, and the emblem stands next to the star's
label and in the system's toolbar; whatever is missing stays shared art. The server serves these files read-only through `GET /api/art`.
Generation is manual: see "The art of one project" in [PROMPTS.md](web/art/PROMPTS.md).
Related projects can stand together as a constellation: `<data home>/board-constellations.json` lists each
constellation's name and its repositories, where `*` stands for any run of characters, for example
`{"constellations": [{"name": "MyWallet", "repos": ["mytonwallet-*", "my-pulse", "my-support"]}]}`. The galaxy
gathers their stars in one place under a faint cloud with the constellation's name, and the system picker groups them.
The server reads the file on each request through `GET /api/constellations`; it stays outside this public repository.
In the lower right corner of the galaxy, apart from the systems it studies, stands the science station, fed by
`GET /api/research`. It shows the reflection
([reflection.md](../src/teamster/docs/reflection.md)): a gold light while lessons wait for your decision, gold rings running out
from its core while the analyst waits for your answer, and probes flying to the systems with archived records while a run
is going. A run is a `teamster reflect` task (or, before it, a desktop session of the reflection's scheduled task); it stays
at the station and is not counted in any system.
A click on the station opens its own screen over the map (`board/web/src/map/station/`; «← Галактика» or Esc goes back,
and the galaxy stops drawing meanwhile). A resource bar on top counts the analyst's open questions, lessons to decide,
accepted lessons waiting for their change, applied lessons, the records in the hold with how many carry a signal, and the
time to the planned reflection; each gauge brings its deck into view. The decks:
- «Ядро станции»: the station inside a chronometer ring that fills from the last planned run to the next one
  (`schedule` in `GET /api/research`, read from the Claude desktop scheduled task; `board/web/src/map/schedule.ts` puts the
  cron into words), a teal sweep while a run works, the last run and batch, «Внеочередной разбор» and «Вопрос к архиву».
- «Экипаж»: the analyst (at work, waiting for your answer, stopped by a failed turn, or free; a click opens its channel) and
  the archive keeper with the hold's count.
- «Рубка связи»: one channel per study and the open channel's conversation — your order, the analyst's reports with dockets
  (a lesson to accept, decline or ask about) and questions with answer options, and your replies.
- «Лаборатория»: lessons on one line, «на решение» › «к внедрению» › «внедрено», with «отклонено» aside; a proposed lesson
  is accepted, declined or asked about, and an accepted one is marked «Внедрено» with where it landed.
- «Трюм архива»: one capsule per record the next planned reflection will read, lit when it carries a signal, the records per
  project and per signal, and the signalled records, each of which can be ordered into a study.
- «Передатчик» gathers a round's decisions and answers from every deck, or a new order, into one command
  (`teamster lesson … && teamster say …`, or `teamster reflect …`) and copies it: the board never runs it.

Like the tanks, the station stays live during a replay.
The ship's log at the bottom of the map tells the last day's completed phases and lead verdicts (`GET /api/events` and
live `event` messages) in the map's words, newest first; in a system it shows only that system and folds to its newest
line, as on a phone, opening over the map on demand together with the replay's scale. A line leads to its
system and selects the ship while it is still there. «Сводка дня» shows today's `teamster report --by executor` and
the day's verdicts. The scale over the log replays a day — the last 24 hours, or any of the 31 days before
today: a slider, play and pause at ×60, ×600 or ×3600, marks at verdicts and CI failures, and «В эфир» back to the
live fleet. `board/web/src/map/replay.ts` rebuilds the fleet at each moment from the log's events alone (with two
hours before the day for ships already under way), shaped like live tasks, so ships, stars and storms show the past
while live updates wait; the tanks stay live, since the accounts' past is not recorded. In replay the log
marks the lines up to the moment, and a click on a line moves the scale to it. A task card, on both views, has a «Команды» block that copies ready `teamster` commands
(`status`, `wait`, `stop`, `review`, `clean`, `verdict`, `say`) to the clipboard; the board never runs them. Above the commands
stands the order the task's state calls for, one reason and one command, and the other commands fold under «Все команды».
A finished task shows its «Груз» above the commands (the saved check, the review and its findings, why the fix loop stopped, CI, the base merge, what is left and the questions), and on the roadstead «вернуть на доработку» puts all of it into one `say` text, while «принять» goes back to the verdict.
`npm --prefix board/web run dev:fixture` adds a «Сценарий» source to the map that takes three demo ships through
every station; both fixture sources include a day of log events, with a ship that reaches the sun, one turned back at the gate and one in trouble, and a day's report.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `TEAMSTER_HOME`, `CODEX_TASK_HOME` | `~/.teamster` | The worker's data home, found by the worker's rules (`teamster docs settings`). Read tasks from `tasks/` and archives from `tasks/.archive/` (`claude-tasks/` in a legacy home in `~/.codex`). Snapshots include at most 50 closed records together, ranked by state mtime. |
| `BOARD_POLL_SECONDS` | `1.0` | Interval between file mtime and size polls, in seconds. |
| `BOARD_ACCOUNTS_SECONDS` | `300` | Minimum interval between account subprocess calls, in seconds. A new `account_login` journal row from `teamster login` or `claude-login` refreshes accounts at once, at most once per 5 seconds; rows already in the journal at startup do not. |
| `BOARD_MACHINES_FILE` | `<data home>/board-machines.json` | Machine configuration; reread when mtime or size changes. Missing means no machines; invalid files preserve the last valid list and expose `config_error`. |
| `BOARD_MACHINES_SECONDS` | `30` | Interval between parallel machine and optional physical host probe cycles, in seconds. |
| `BOARD_STALE_DAYS` | `7` | Close non-alive tasks older than this many days by state mtime. Non-alive scouts are always closed; alive tasks are exempt from the age rule. |
| `BOARD_CLAUDE_DESKTOP_DIR` | `~/Library/Application Support/Claude` | Read desktop metadata from `claude-code-sessions/*/*/local_*.json`. Missing directories are skipped. |
| `BOARD_CLAUDE_HOME` | `~/.claude` | Read live state from `sessions/<pid>.json` and activity from `projects/*/<cliSessionId>.jsonl`. Key files are never opened. |
| `BOARD_SESSIONS_SECONDS` | `5` | Interval between desktop metadata scans, in seconds; unchanged files are not read again. Live state is read on every board poll. |
| `BOARD_SESSION_STALE_HOURS` | `48` | Close inactive sessions older than this many hours by `lastActivityAt`. Busy sessions and sessions awaiting a person take precedence. |
| `BOARD_RESEARCH_SECONDS` | `30` | Minimum interval between rebuilds of `GET /api/research` from `tasks/.archive/`, in seconds; unchanged record states are not read again. |
| `BOARD_REFLECTION_TASK` | `codex-batch-reflection` | Scheduled task id of the Claude Desktop sessions that run the batch reflection, returned as `reflection_task`. |
| `BOARD_TEAMSTER_COMMAND` (fallback `BOARD_CODEX_TASK`) | Repository `src/teamster/__main__.py` | Script called as `python3 -I <script> accounts --json`, without `--refresh`, with a 60-second timeout. |

Account calls run outside the event loop. Errors preserve the previous account data and expose an
error string. A malformed or partially written state file preserves its last successfully read state.
The server never reads credentials or account homes directly. Desktop session files are internal
application data, not a public API. Only the metadata fields listed in [CONTRACT.md](CONTRACT.md) are
retained; malformed files preserve their previous valid state, and symbolic links are skipped.
Archived sessions are omitted. Sessions and tasks share the snapshot limit of 50 newest closed records
by `updated_at`. Live session transcripts use the same bounded incremental activity reader as tasks;
only events from the current busy period are shown. Transcript paths use ASCII letters and digits for
cwd encoding. Until a transcript is found, its direct path is checked on every poll and fallback searches
across project directories run at most once per 60 seconds; a found path is cached.

## Run as a service

On macOS, launchd can keep the board running: it starts at login and restarts after a crash.
`teamster-board plist` prints the job and installs nothing. It accepts `--host` and `--port` with
the defaults above. It sets `TEAMSTER_HOME` to a new-layout data home (also setting `TEAMSTER_CODEX_HOME` from that variable or `CODEX_TASK_HOME`
when set) or `CODEX_TASK_HOME` to a legacy one, and copies every `BOARD_*` variable set in the current
environment into the job. Logs go to `<data home>/board-server.log`.

1. Clone the repository to a permanent place outside working directories, then build and sync:

   ```sh
   git clone https://github.com/kaifaty/teamster.git ~/teamster-board
   cd ~/teamster-board
   npm --prefix board/web ci && npm --prefix board/web run build
   uv sync --project board/server --no-dev
   ```

2. Write the job:

   ```sh
   board/server/.venv/bin/teamster-board plist > ~/Library/LaunchAgents/teamster.board.plist
   ```

3. Load it:

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/teamster.board.plist
   ```

4. Update: pull, build and sync as in step 1, then restart the job:

   ```sh
   git pull
   npm --prefix board/web ci && npm --prefix board/web run build
   uv sync --project board/server --no-dev
   launchctl kickstart -k gui/$(id -u)/teamster.board
   ```

5. Disable:

   ```sh
   launchctl bootout gui/$(id -u)/teamster.board
   ```

The port must be free, so stop a manually started server before loading the job.

## Machine metrics

Create the machine configuration outside the public repository, using
[machines.example.json](machines.example.json) as a fictitious example. The file contains a `machines`
array. Each machine requires a unique `id` matching `^[a-z0-9-]+$`, a `name`, and exactly one of
`local: true` or `ssh`. Optional `role` describes the machine; `disks` contains absolute paths and
defaults to `["/"]`. A VM may include `host: {"name": "Hypervisor", "ssh": "root@hypervisor.example"}`
to collect its physical host's CPU and memory separately. Every `ssh` must match
`^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$`; targets beginning with `-` are rejected. Any invalid entry rejects
the file. The server keeps the last valid configuration and publishes a short `config_error` until
a corrected file is loaded. Removing the file clears the list without an error.

Every 30 seconds by default, the server runs a standalone Python 3.9-compatible probe locally with
`python3 -I - <disks…>` or remotely with
`ssh -o BatchMode=yes -o ConnectTimeout=5 -- <target> python3 -I - <disks…>`, sending the probe source
through stdin and quoting remote paths. All probes run concurrently with individual 15-second
timeouts and a 1 MiB output limit. A timed-out process is killed and awaited. The probe only reads
state: no file writes, service or container control, or sudo. Its external commands use 5-second
timeouts and disconnected stdin. No SSH connection is attempted unless a target is configured.

Metrics contain OS, CPU core count and load averages, total and available memory, GPU utilization and
memory, up to five GPU processes using at least 100 MiB each, and total/free bytes for requested disks.
Linux memory comes from `/proc/meminfo`; macOS memory comes from `sysctl` and `memory_pressure`.
NVIDIA data comes from `nvidia-smi`, with UUID matching processes to GPUs; Apple GPU utilization comes
from `ioreg` and uses shared memory. Missing sections are `null` or empty lists. Missing disk paths
are skipped. Only process basenames or their virtual environment project names are exposed, never
full executable paths. Untrusted output is validated and strings are limited to 200 characters.

`GET /api/snapshot` includes `machines: {config_error, items}`. Every machine contains its identity,
`status`, `reasons`, attempt/success timestamps, last error and successful metrics, optional host
CPU/memory, and up to 120 history points in memory. Successful probes append history with CPU load
percentage (which can exceed 100%), used-memory percentage and highest GPU utilization; failures
preserve the last successful metrics and history. Error values are `timeout`, `unreachable` (SSH exit
255), `bad_output` or `probe_failed`. SSH targets never appear in API or WebSocket data, including
errors; stderr goes only to server logs. Physical host metrics do not affect machine status.

Status is `unknown` before any attempt, `offline` after a failure without successful data or two
consecutive failures, otherwise `free`, `busy` or `overloaded` based on the last successful metrics.
One failure with prior data preserves the computed status and records the error. Thresholds are:

| Metric | `busy` | `overloaded` |
| --- | --- | --- |
| CPU load1 / cores | ≥ 0.7 | ≥ 1.5 |
| Available memory / total | < 25% | < 10% |
| GPU utilization | ≥ 70% | — |
| GPU used memory / total | ≥ 60% | — |
| Disk free space / total | < 15% | < 5% |

The highest severity wins. Reasons use `cpu`, `memory`, `gpu`, `gpu_memory` and `disk:<mount>` for
matching conditions at that severity or above; `free`, `offline` and `unknown` have no reasons.
The server sends `{"type": "machines", "machines": Machines}` after each cycle whose data changed,
ignoring `checked_at` in comparison. The existing frontend ignores the added snapshot field and
unknown message type. Machine selection and the machine interface are separate work.
The complete `Metrics`, `Gpu`, `Machine`, `Machines`, host and history types are in
[CONTRACT.md](CONTRACT.md#types).

Run the server tests with temporary task and Claude directories, fake account scripts and fake SSH:

```sh
uv run --project board/server pytest board/server/tests -q
```
