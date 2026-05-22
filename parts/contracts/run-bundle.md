# Run Bundle Contract

## Location

```
docs/masterplan/<slug>/
  state.yml          (run state, v5.0 schema below)
  spec.md            (design)
  plan.md            (implementation plan, v5.0 format)
  plan.index.json    (structured task index, see below)
  retro.md           (post-run retrospective)
  handoff.md         (overflow for handoff scalar > 200 chars)
  blockers.md        (overflow for blockers list scalar > 200 chars)
  events.jsonl       (per-turn event log)
```

## state.yml v5.0 Schema

```yaml
---
schema_version: "5.0"
slug: v5-lazy-phase-prompts
plan_hash: "sha256:abc123..."

current_phase: step-c
current_wave: 2
autonomy: loose
complexity: medium

tasks:
  - idx: 1
    status: complete
    started_at: "2026-05-13T12:00:00Z"
    completed_at: "2026-05-13T12:15:00Z"
  - idx: 2
    status: in_flight
    started_at: "2026-05-13T13:00:00Z"

handoff: "*overflow at handoff.md L1*"
blockers: []
recent_events:
  - "2026-05-13T13:05Z task-2 dispatched (wave-1)"
  - "2026-05-13T13:08Z task-1 complete (digest: abc...)"
```

- **Hard write-time rule:** any scalar > 200 chars rejected at write time by `bin/masterplan-state.sh`. Overflow moved to `<slug>/handoff.md` or `<slug>/blockers.md` with `*overflow at <file> L<n>*` pointer.
- `current_phase` enables router phase-prompt dispatch.
- `plan_hash` triggers plan.index.json regeneration when plan.md changes.
- Doctor check #32 verifies cap + pointer integrity.

## plan.index.json Schema (Full v5.0)

```json
{
  "schema_version": "5.0",
  "plan_hash": "sha256:abc123...",
  "generated_at": "2026-05-13T12:34:56Z",
  "tasks": [
    {
      "idx": 1,
      "name": "Extract config schema",
      "offset": 142,
      "lines": 28,
      "files": ["docs/config-schema.md", "commands/masterplan.md"],
      "codex": false,
      "parallel_group": null,
      "verify_commands": [
        "test -f docs/config-schema.md",
        "grep -q schema_version docs/config-schema.md"
      ],
      "spec_refs": ["spec.md#L42-L67"]
    },
    {
      "idx": 2,
      "name": "Build parts/step-0.md",
      "offset": 170,
      "lines": 64,
      "files": ["parts/step-0.md"],
      "codex": false,
      "parallel_group": "wave-1",
      "verify_commands": ["test -f parts/step-0.md"],
      "spec_refs": ["spec.md#L78-L95"]
    }
  ]
}
```

- Built by: `bin/masterplan-state.sh build-index <slug>`.
- Trigger: `state.yml.plan_hash != sha256(plan.md)`. Computed lazily at Step B3 entry and Step C entry.
- Consumed by: Step B3 (cross-link refs back to spec), Step C wave dispatch (resolve `parallel_group` membership), Step C verification (run `verify_commands` per task).
- Stored alongside `state.yml` in the run bundle: `docs/masterplan/<slug>/plan.index.json`.

## Build Trigger

`state.yml.plan_hash != sha256(plan.md)` → regenerate via `bin/masterplan-state.sh build-index <slug>`. Computed at Step B3 entry and Step C entry.

## Canonical Writer

Orchestrator is the canonical writer (CD-7). Wave members emit digests only; orchestrator writes state. `bin/masterplan-state.sh` enforces.

## --resume Path Resolution

When `--resume=<path>` / `execute <path>` is given, `<path>` is relative, and `test -e <path>` fails against cwd:

1. **Build candidate set.** Collect paths matching `<cwd>/.worktrees/*/<path>` and `<repo-root>/.worktrees/*/<path>` (resolve repo-root via `git_state` cache). Filter to existing files.
2. **Resolve.**
   - **Exactly one match** → `cd` to that match's worktree, re-resolve path, emit `↻ --resume path resolved into worktree <worktree-path>; cd'd before Step C config load.`, re-run repo-local config read, then proceed to Step C step 1.
   - **Zero matches** → `AskUserQuestion("--resume path '<path>' not found …", options=["Abort (Recommended)", "Search entire repo for matching state files", "Treat <path> as topic → Step A"])`.
   - **Multiple matches** → `AskUserQuestion("--resume path '<path>' matches multiple candidates. Which one?", options=[top 3 by last_activity, "List all and abort"])`.
3. **Absolute paths** bypass this search — Step C step 1's parse guard catches missing absolutes.

Rationale: prevents silent fall-through to Step A when user is in parent dir of a worktree.

## Codex Availability Events

Detection outcome appended to `events.jsonl` on every `/masterplan` invocation:

- Stage A scan hit or `scan` mode: `<ISO-ts> codex_ping ok — detection_mode=<scan-then-ping|scan>, detection_source=scan`
- Stage B ping hit or `ping` mode success: `<ISO-ts> codex_ping ok — detection_mode=<scan-then-ping|ping>, detection_source=ping`
- `trust` mode: `<ISO-ts> codex_ping skipped — detection_mode=trust`
- `codex_host_suppressed == true`: `<ISO-ts> codex_ping skipped — codex_host_suppressed`
- Failure: covered by the `codex degraded — …` event in the degradation path

Doctor check #41 reads these events to distinguish never-ran / ok / error states.

## Codex Degradation Evidence

**Self-doubt cross-check (v5.3.0+).** Before emitting the degradation warning, run two on-disk probes:

- **Auth-healthy probe:** `~/.codex/auth.json` exists, JWT not expired > 24h, AND under `auth_mode == "chatgpt"` — `tokens.refresh_token` non-empty + `last_refresh` within 7 days (reuses Doctor Check #39's predicate).
- **Plugin-on-disk probe:** `ls ~/.claude/plugins/*/codex* 2>/dev/null | head -1` — non-empty match confirms plugin files present.

If **both probes pass** but detection returned absent, append one INFO event:

```
<ISO-ts> degradation_self_doubt — about to emit codex-degraded warning, but auth_mode=<chatgpt|apikey> healthy AND plugin manifest present on disk; detection_mode=<scan-then-ping|ping|scan>, detection_source=<scan|ping|none>, ping_result=<ok|error-msg|null>
```

The warning still fires (Step 0 cannot ground-truth the runtime path), but the breadcrumb makes the false-positive visible to Doctor Check #41 (escalates to ERROR when this event present).

**Degradation events.** Write on the next natural state write (Step B3 close for kickoff; Step C step 1 first write for resume; Step I3 for import):

- Plugin missing: `<ISO-ts> codex degraded — plugin not detected; codex_routing+codex_review forced to off for this run (configured: routing=<r>, review=<rv>). Re-install codex plugin to restore.`
- Ping error: `<ISO-ts> codex degraded — ping returned error: <error>; codex_routing+codex_review forced to off for this run (configured: routing=<r>, review=<rv>). Re-install or repair codex plugin to restore.`

If no other state write happens this turn, force one: append the event, update `last_activity`, set `last_warning: codex degraded this run — install codex plugin to restore configured routing/review`.
