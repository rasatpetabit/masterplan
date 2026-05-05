# Telemetry signals

Two JSONL telemetry files sit alongside each `/masterplan` plan's status file:
one per-turn aggregate stream (`<plan>-telemetry.jsonl`) and one
per-Agent-dispatch detail stream (`<plan>-subagents.jsonl`).

Telemetry files are local runtime data, not project artifacts. Before writing,
the hook and the Step C inline snapshot path ensure `.git/info/exclude` contains
ignore rules for `**/*-telemetry.jsonl`, `**/*-telemetry-archive.jsonl`,
`**/*-subagents.jsonl`, `**/*-subagents-archive.jsonl`, and
`**/*-subagents-cursor`; if the target file is already tracked or cannot be
ignored, telemetry is skipped rather than risk being committed.

**Per-turn writers** (write to `<plan>-telemetry.jsonl`):

- `hooks/masterplan-telemetry.sh` — Stop hook (manually installed; per-turn cadence; `turn_kind: "stop"`)
- `commands/masterplan.md` Step C step 1 — inline orchestrator snapshot (every Step C entry; `turn_kind: "step_c_entry"`)

**Per-subagent writer** (writes to `<plan>-subagents.jsonl`, v2.3.0+):

- `hooks/masterplan-telemetry.sh` — same Stop hook also parses the parent transcript at end-of-turn, emitting one record per Agent tool dispatch (subagent_type, model, dispatch_site, full token breakdown, duration, tool_stats)

Both telemetry streams honor: per-plan opt-out via `telemetry: off` in status frontmatter; global toggle via `config.telemetry.enabled`.

**Aggregated cross-plan view** (v2.4.0+): the `bin/masterplan-routing-stats.sh` script combines per-plan signals from all three sources (activity-log routing tags, `<slug>-subagents.jsonl` token totals + `routing_class` field, `<slug>-eligibility-cache.json` `decision_source`) into a unified codex-vs-inline distribution + inline model breakdown + token totals report. Invoke via `/masterplan stats` (Step T) or directly. See `commands/masterplan.md` §Step T for the verb wiring; the script is the canonical implementation.

## Per-turn record shape

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

## Subagent dispatch records (v2.3.0+)

`<plan>-subagents.jsonl` — one record per `Agent` tool dispatch. Written by the Stop hook from the parent session transcript's `tool_use` + `toolUseResult` pairs at end-of-turn. v2.4.0+ dedups by `agent_id` — each Agent dispatch carries a unique 16-byte hex ID in the result message's `toolUseResult.agentId`; the hook reads the existing JSONL into a seen-set and skips records already emitted. Replaces the v2.3.0 `<plan>-subagents-cursor` line-cursor approach which was plan-keyed (not transcript-keyed) and silently dropped dispatches across multi-session runs (typical symptom: 0-line subagents.jsonl despite many actual dispatches). Old cursor files lingering on disk are harmless and flagged by doctor check #19. Each record carries a `routing_class` field (`"codex"` / `"sdd"` / `"explore"` / `"general"`) for greppable codex-routing distribution.

### Record shape

```json
{
  "ts": "2026-05-02T06:11:44.420Z",
  "plan": "foundations-spike",
  "session_id": "32d22d35-6998-41f8-a8d5-1b44669be4da",
  "tool_use_id": "toolu_01EJLiRes3EwM2u2BbT31uC4",
  "agent_id": "af8ad97a75649d71a",
  "subagent_type": "codex:codex-rescue",
  "model": null,
  "description": "T12 Yocto recipe stubs via Codex",
  "dispatch_site": "Step C 3a Codex EXEC (task 12)",
  "status": "completed",
  "prompt_chars": 2890,
  "prompt_first_line": "DISPATCH-SITE: Step C 3a Codex EXEC (task 12)",
  "duration_ms": 172662,
  "total_tokens": 15894,
  "input_tokens": 1,
  "output_tokens": 618,
  "cache_creation_tokens": 4123,
  "cache_read_tokens": 11152,
  "tool_uses_in_subagent": 1,
  "tool_stats": {"bash": 1, "edit": 0, "read": 0, "search": 0, "other": 0, "lines_added": 0, "lines_removed": 0},
  "result_chars": 1284,
  "branch": "main",
  "cwd": "/home/.../petabit-junos"
}
```

### Field semantics

| Field | What it measures | Notes |
|---|---|---|
| `ts` | Toolresult timestamp (when the subagent returned) | ISO8601 |
| `tool_use_id` | Parent transcript's tool_use id | Joins back to source line |
| `agent_id` | Subagent's own id | Unique per dispatch; corresponds to `~/.claude/projects/<proj>/subagents/agent-<id>.jsonl` if you need the full subagent transcript |
| `subagent_type` | The `subagent_type` parameter passed | `Explore` / `general-purpose` / `codex:codex-rescue` / `feature-dev:code-explorer` / etc. — many distinct values |
| `model` | The `model` parameter passed (`haiku`/`sonnet`/`opus`) | `null` for `codex:codex-rescue` (its own routing — no `model:` parameter) |
| `dispatch_site` | The `DISPATCH-SITE: <value>` tag extracted from the prompt's first line | `null` if the brief omitted the tag (legacy or non-/masterplan dispatches); fall back to `subagent_type + description` fingerprinting |
| `status` | `completed` / `error` / etc. | From toolUseResult |
| `prompt_chars` / `prompt_first_line` | Brief size + first line | First line is truncated at 200 chars |
| `duration_ms` | Wall-clock duration | From `toolUseResult.totalDurationMs` |
| `total_tokens` | `input + output + cache_creation + cache_read` summed | From `toolUseResult.totalTokens` |
| `input_tokens` / `output_tokens` / `cache_creation_tokens` / `cache_read_tokens` | Full per-subagent token breakdown | From `toolUseResult.usage.*` — these are the SUBAGENT's tokens, not the parent's |
| `tool_uses_in_subagent` | How many tool calls the subagent itself made | From `toolUseResult.totalToolUseCount` |
| `tool_stats` | What the subagent did inside its session — `{bash, edit, read, search, other, lines_added, lines_removed}` | Useful for "did this subagent spend tokens reading or editing?" |
| `result_chars` | Length of the result text | Sum of `.text` across content array |
| `branch` / `cwd` | At hook fire | Distinguishes worktrees |

## Rotation

Doctor check #12 catches `<plan>-telemetry.jsonl` OR `<plan>-subagents.jsonl` files > 5 MB. `--fix` rotates to `<slug>-telemetry-archive.jsonl` / `<slug>-subagents-archive.jsonl` respectively. Active file becomes empty; new appends start fresh. Archives are append-only and never auto-deleted.

Rotated archives use the same local-only ignore rules as active telemetry
streams.

## Privacy

These records contain file paths, branch names, and the FIRST 200 CHARACTERS of each subagent brief (`prompt_first_line`). No full message content, no tool output, no source code. The transcript file itself is referenced by size only, not contents. If you publish a telemetry archive, redact `cwd`, `branch`, and `prompt_first_line` if any of those could be sensitive (branch names often leak product names; brief first lines often start with `DISPATCH-SITE: <step>` which is benign but the format is configurable).

## Subagent dispatch jq recipes (v2.3.0+)

Six recipes for `<plan>-subagents.jsonl`. Each returns a structured digest you can sort or eyeball.

### 1. Top 10 most expensive single dispatches

```bash
jq -s 'sort_by(-.total_tokens) | .[:10] | .[] | {ts, dispatch_site, subagent_type, model, total_tokens, duration_ms}' <plan>-subagents.jsonl
```

The single dispatches that consumed the most tokens. If one dispatch consumed 50K+ tokens, that's where briefs should be tightened first.

### 2. Per-subagent_type aggregates

```bash
jq -s '
  group_by(.subagent_type)
  | map({subagent_type: .[0].subagent_type,
         dispatches: length,
         total_tokens: ([.[].total_tokens] | add),
         avg_tokens: (([.[].total_tokens] | add) / length | floor),
         total_ms: ([.[].duration_ms] | add)})
  | sort_by(-.total_tokens)
' <plan>-subagents.jsonl
```

Which subagent_type costs most overall. `codex:codex-rescue` is usually highest by total because Codex tasks are heavier per-dispatch; `Explore` may have many cheap dispatches that aggregate.

### 3. Per-dispatch-site aggregates (cost by Step)

```bash
jq -s '
  group_by(.dispatch_site // "unattributed")
  | map({dispatch_site: (.[0].dispatch_site // "unattributed"),
         dispatches: length,
         total_tokens: ([.[].total_tokens] | add),
         avg_tokens: (([.[].total_tokens] | add) / length | floor)})
  | sort_by(-.total_tokens)
' <plan>-subagents.jsonl
```

The MAIN cost-optimization view. Tells you which orchestrator step (Step C step 2 SDD vs Step I3.4 conversion vs etc.) is consuming most of the budget. Optimize the brief at the top dispatch site for the biggest win.

### 4. Per-model breakdown by site (verifies §Agent dispatch contract)

```bash
jq -s '
  group_by(.dispatch_site // "unattributed")
  | map({dispatch_site: (.[0].dispatch_site // "unattributed"),
         haiku_tokens: ([.[] | select(.model == "haiku") | .total_tokens] | add // 0),
         sonnet_tokens: ([.[] | select(.model == "sonnet") | .total_tokens] | add // 0),
         opus_tokens: ([.[] | select(.model == "opus") | .total_tokens] | add // 0),
         codex_tokens: ([.[] | select(.subagent_type == "codex:codex-rescue") | .total_tokens] | add // 0),
         null_model_tokens: ([.[] | select(.model == null and .subagent_type != "codex:codex-rescue") | .total_tokens] | add // 0)})
  | sort_by(-.opus_tokens)
' <plan>-subagents.jsonl
```

`null_model_tokens > 0` at any non-codex site means the orchestrator dropped the `model:` parameter and the subagent inherited Opus — investigate per §Agent dispatch contract. `opus_tokens` should be 0 except at sites where the user explicitly escalated via the blocker re-engagement gate.

### 5. Anomaly detection (>2σ above the type mean)

```bash
jq -s '
  group_by(.subagent_type) as $by_type
  | $by_type | map(
      .[0].subagent_type as $t
      | ([.[].total_tokens] | (add / length)) as $mean
      | ([.[].total_tokens] | map(. - $mean | . * .) | add / length | sqrt) as $stddev
      | .[] | select(.total_tokens > $mean + 2 * $stddev)
      | {subagent_type: $t, dispatch_site, ts, total_tokens, deviation_factor: ((.total_tokens - $mean) / $stddev | (. * 10 | floor) / 10)}
    )
  | flatten
  | sort_by(-.total_tokens)
' <plan>-subagents.jsonl
```

Surfaces individual dispatches that consumed dramatically more tokens than peers. Useful for catching one-off blowups (e.g., a Step C step 2 SDD task that consumed 100K tokens because the brief accidentally included the full plan file).

### 6. Cost trend over 14 days

```bash
jq -s '
  map(.ts[:10] as $day | {day: $day, total_tokens, model, subagent_type})
  | group_by(.day)
  | map({day: .[0].day,
         dispatches: length,
         total_tokens: ([.[].total_tokens] | add)})
  | sort_by(.day) | .[-14:]
' <plan>-subagents.jsonl
```

Daily cost over the last 14 days. Watch for trend lines climbing — usually means the plan's brief footprint has grown without anyone noticing.
