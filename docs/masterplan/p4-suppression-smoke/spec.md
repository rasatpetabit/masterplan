# p4-suppression-smoke — Verification smoke bundle for v4.1.1

## Purpose

Verify v4.1.1's per-state-write `TaskUpdate` priming actually suppresses the harness `<system-reminder>` during Step C wave execution.

This bundle is the release gate for `docs/masterplan/p4-suppression-fix/` — v4.1.1 tag (Task 14 of that plan) is conditional on a successful smoke run here.

## Mandatory observation contract

The orchestrator running this bundle MUST append a `smoke_observation` event to `docs/masterplan/p4-suppression-smoke/events.jsonl` **BEFORE** writing any other event on every turn during Step C. Schema:

```json
{
  "ts": "<ISO-8601>",
  "event": "smoke_observation",
  "turn_n": <int, 1-indexed within Step C>,
  "tools_called": ["<tool-name>", ...],
  "reminder_fired": <bool — did the harness emit a system-reminder this turn>,
  "preceding_state_write": <bool — did this turn perform a state.yml write before the reminder check>,
  "last_task_update_age_turns": <int — turns since the last TaskUpdate call, -1 if never>
}
```

**Absence of `smoke_observation` for any Step C turn is a verification failure.** "No event recorded" cannot be inferred as "no reminder". The orchestrator must affirmatively log each turn.

## Success criterion

For every turn within Step C wave execution where `preceding_state_write == true`:

```
reminder_fired == false
```

Grading command (run after the smoke completes):

```bash
grep '"event":"smoke_observation"' docs/masterplan/p4-suppression-smoke/events.jsonl \
  | grep '"preceding_state_write":true' \
  | grep -c '"reminder_fired":true'
# expect: 0
```

## Failure handling

If any state-write turn has `reminder_fired == true`:

1. Halt the smoke run.
2. Append `smoke_failed` to `docs/masterplan/p4-suppression-fix/events.jsonl` with the failing turn details.
3. Route to v4.1.1 R1 Option D rescope (idle-turn heartbeat) per `docs/masterplan/p4-suppression-fix/spec.md`.

## Tasks

3 no-op tasks designed to exercise the wave-dispatch path without doing real work. See `plan.md`.

## How to run

In a **fresh Claude Code session** (not the one that authored v4.1.1):

```
Use masterplan execute docs/masterplan/p4-suppression-smoke/state.yml
```

The orchestrator enters Step C against this bundle, dispatches the 3 no-op tasks, and produces the per-turn observation evidence in `events.jsonl`.
