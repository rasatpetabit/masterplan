# Telemetry signals

Per-turn JSONL records appended to `<plan>-telemetry.jsonl` (sibling to the plan's status file). Two writers:

- `hooks/superflow-telemetry.sh` — Stop hook (manually installed; per-turn cadence; `turn_kind: "stop"`)
- `commands/superflow.md` Step C step 1 — inline orchestrator snapshot (every Step C entry; `turn_kind: "step_c_entry"`)

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
| `branch` | Current branch | Useful for cross-worktree analysis |
| `cwd` | Working directory at hook fire | Distinguishes worktrees |

## Degraded records

When `$CLAUDE_SESSION_ID` isn't exposed by the harness AND the most-recent-jsonl fallback fails, `transcript_bytes` and `transcript_lines` are 0. The record still has all other fields; treat zero as "unknown," not "actually zero."

## Useful jq queries

### Tokens-per-turn estimate (transcript bytes growth between consecutive Stop entries)

```bash
jq -s '
  [.[] | select(.turn_kind=="stop")]
  | [foreach .[] as $r (null; $r; if . == null then null
      else {ts: $r.ts, growth: ($r.transcript_bytes - .transcript_bytes)} end)]
  | map(select(. != null and .growth >= 0))
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

## Rotation

Doctor check #12 catches `<plan>-telemetry.jsonl` files > 5 MB. `--fix` rotates to `<plan>-telemetry-archive.jsonl`. Active file becomes empty; new appends start fresh. Archives are append-only and never auto-deleted.

## Privacy

These records contain file paths and branch names — no message content. The transcript file itself is referenced by size only, not contents. If you publish a telemetry archive, redact `cwd` and `branch` if your branch names are sensitive.
