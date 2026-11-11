# Task notifications

The user can configure task notifications with `notify` in the settings (`~/.teamster/config.json`): `"macos"`, or
an argv list that receives the event JSON as its final argument. `notify_events` optionally filters
event types. Hooks run asynchronously and write their output or launch errors to the task's
`notify.log`; the repository README has examples and the full event list.

- `review_done` includes the review's `round` and `angles`.
- `turn_finished` fires once at the end of the whole cycle and includes `guarded_changed`, the number
  of changed guarded files, the typed `outcome`, including `budget_exhausted` or `stuck`, and the
  final `ci` result.
- Separate `budget_exhausted` and `stuck` events obey `notify_events` too.
- `queue_sent` fires after `turn_finished` when a completed cycle sends the messages queued with
  `say --queue` as a new turn; it includes `count`, the number of messages, and `turn`, the new turn's number.
- `queue_dropped` fires after `turn_finished` when a cycle with queued messages ends with any other outcome
  (or is stopped while finishing); it includes `outcome` and `texts`, the dropped messages. They stay in
  `queue.json` under `dropped` (the last 10) and are not written to `messages.jsonl`.
