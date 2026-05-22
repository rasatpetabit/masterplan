# Plan Parser — Internals

> **Audience:** Maintainers changing plan format or eligibility cache build.
> **Phase file:** `parts/step-c-dispatch.md`.
> **Coordinator:** `coordinator-plan-parser` (Haiku tier).

## Coordinator Dispatch

Orchestrator dispatches 1 Haiku coordinator with the plan.md path. Coordinator reads plan.md, parses task annotations, returns structured task list. Orchestrator builds the eligibility cache from this JSON and never reads raw plan.md directly.

**Return shape:**
```json
{
  "total_tasks": 15,
  "schema_version": "5.0",
  "tasks": [
    {
      "idx": 1,
      "name": "Add turn_context_bytes event",
      "files": ["hooks/masterplan-telemetry.sh"],
      "codex_eligible": true,
      "parallel_group": "none",
      "verify_commands": ["bash -n hooks/masterplan-telemetry.sh"],
      "status": "pending"
    }
  ],
  "eligibility_cache_hash": "sha256:abc123",
  "coordinator_version": "1"
}
```

## Annotation Syntax

Per-task annotations parsed by the coordinator:
```
**Files:** path1, path2
**Parallel-group:** wave-X or none
**Codex:** true|false
**Verify:**
```bash
<commands>
```
```

A missing `**Codex:**` annotation defaults to heuristic: single-file = `true`.

## Eligibility Cache Hash

SHA256 of the structured task list JSON (before the hash field). Stored in state.yml. Invalidated when plan.md mtime changes.
