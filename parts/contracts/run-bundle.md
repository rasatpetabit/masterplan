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
