# Telemetry signals

Per-turn JSONL records appended to `<plan>-telemetry.jsonl` (sibling to the plan's status file). Two writers:

- `hooks/masterplan-telemetry.sh` — Stop hook (manually installed; per-turn cadence; `turn_kind: "stop"`)
- `commands/masterplan.md` Step C step 1 — inline orchestrator snapshot (every Step C entry; `turn_kind: "step_c_entry"`)

Both write the same field shape; orchestrator opt-out via `telemetry: off` in status frontmatter; global toggle via `config.telemetry.enabled`.

## Record shape

```json
{
  "ts": "2026-05-01T16:14:32Z",
  "plan": "<slug>",
  "turn_kind": "stop" | "step_c_entry",
  "transcript_bytes": 124533,
  "transcript_lines": 847,
  "status_bytes": 4310,
  "activity_log_entries": 42,
  "wakeup_count_24h": 3,
  "tasks_completed_this_turn": 1,
  "wave_groups": ["verification"],
  "branch": "feat/auth-refactor",
  "cwd": "/home/.../wt"
}
```

| Field | What it measures | Notes |
|---|---|---|
| `ts` | UTC ISO8601 timestamp | Append order = chronological |
| `plan` | Plan slug (basename of status file minus `-status.md`) | Joins to status file |
| `turn_kind` | Origin of the record | `stop` from Stop hook; `step_c_entry` from inline snapshot |
| `transcript_bytes` | Total bytes of the session JSONL transcript | Proxy for total token use this session |
| `transcript_lines` | Total lines (one per role+message) | Proxy for turn count |
| `status_bytes` | Bytes of the status file at this moment | Grows with activity log + notes |
| `activity_log_entries` | Number of `- ` bullets under `## Activity log` | Tasks-completed proxy |
| `wakeup_count_24h` | Wakeups recorded in `## Wakeup ledger` over the last 24h | Loop activity rate |
| `tasks_completed_this_turn` *(v2.0.0+)* | Delta of `activity_log_entries` between this and previous Stop record | 1 for serial; N for wave; 0 for no-progress turns. **First-turn caveat:** when no previous record exists for a plan, this field reports `0` rather than the absolute entry count — first-record telemetry doesn't have a baseline to subtract. Activity log rotation (entries moved to `<slug>-status-archive.md`) can decrement `activity_log_entries` between records; the hook clamps to 0. |
| `wave_groups` *(v2.0.0+)* | Distinct `[wave: <group>]` tags from the last `tasks_completed_this_turn` activity-log entries | Empty array `[]` for serial-only turns. Use to identify which parallel-group(s) dispatched this turn — useful for measuring per-group latency wins. |
| `branch` | Current branch | Useful for cross-worktree analysis |
| `cwd` | Working directory at hook fire | Distinguishes worktrees |

## Degraded records

When `$CLAUDE_SESSION_ID` isn't exposed by the harness AND the most-recent-jsonl fallback fails, `transcript_bytes` and `transcript_lines` are 0. The record still has all other fields; treat zero as "unknown," not "actually zero."

## Useful jq queries

### Tokens-per-turn estimate (transcript bytes growth between consecutive Stop entries)

```bash
jq -s '
  [.[] | select(.turn_kind=="stop")] as $entries
  | [range(1; $entries | length) as $i
     | {ts: $entries[$i].ts,
        growth: ($entries[$i].transcript_bytes - $entries[$i-1].transcript_bytes)}
     | select(.growth >= 0)]
' <plan>-telemetry.jsonl
```

Rough conversion: ~4 chars/token for English text, ~3 chars/token for code-heavy transcripts.

### Activity-log throughput (entries per hour)

```bash
jq -s '
  [.[] | select(.turn_kind=="stop")]
  | (.[-1].activity_log_entries - .[0].activity_log_entries) as $delta
  | (.[-1].ts | fromdateiso8601) - (.[0].ts | fromdateiso8601) as $secs
  | ($delta / ($secs / 3600))
' <plan>-telemetry.jsonl
```

### Wakeup rate over time

```bash
jq -c '{ts, wakeup_count_24h}' <plan>-telemetry.jsonl
```

### Last 10 turns at a glance

```bash
jq -c 'select(.turn_kind=="stop") | {ts, lines: .transcript_lines, bytes: .transcript_bytes, log: .activity_log_entries}' <plan>-telemetry.jsonl | tail -10
```

### Average tasks-per-wave-turn (v2.0.0+)

```bash
jq -s '
  [.[] | select(.turn_kind=="stop" and .tasks_completed_this_turn > 0)]
  | {wave_turns: ([.[] | select(.tasks_completed_this_turn > 1)] | length),
     serial_turns: ([.[] | select(.tasks_completed_this_turn == 1)] | length),
     avg_tasks_per_wave_turn: (
       ([.[] | select(.tasks_completed_this_turn > 1) | .tasks_completed_this_turn] | add // 0)
       /
       (([.[] | select(.tasks_completed_this_turn > 1)] | length) // 1)
     ),
     groups_seen: ([.[] | .wave_groups[]] | unique)}
' <plan>-telemetry.jsonl
```

Returns `{wave_turns, serial_turns, avg_tasks_per_wave_turn, groups_seen}`. Use to evaluate whether `parallel-group:` annotations are being authored AND exercised in practice. Non-zero `wave_turns` is the candidate trigger for the deferred Slice β/γ revisit — see [`docs/design/intra-plan-parallelism.md`](./intra-plan-parallelism.md) for the sharpened trigger condition.

## Rotation

Doctor check #12 catches `<plan>-telemetry.jsonl` files > 5 MB. `--fix` rotates to `<plan>-telemetry-archive.jsonl`. Active file becomes empty; new appends start fresh. Archives are append-only and never auto-deleted.

## Privacy

These records contain file paths and branch names — no message content. The transcript file itself is referenced by size only, not contents. If you publish a telemetry archive, redact `cwd` and `branch` if your branch names are sensitive.
