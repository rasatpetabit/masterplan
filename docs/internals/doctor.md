# Doctor Checks — Internals

> **Audience:** Maintainers adding or fixing doctor checks.
> **Phase file:** `parts/doctor.md` (loaded internally by coordinator-doctor; not loaded into orchestrator context directly in v6.0+).
> **Coordinator:** `coordinator-doctor` (Sonnet tier).

## Coordinator Dispatch

The orchestrator dispatches 1 Sonnet coordinator for `/masterplan doctor [--fix]`. The coordinator loads `parts/doctor.md` internally, runs all checks, and returns compact findings JSON.

**Return shape:**
```json
{
  "pass": 30,
  "warn": 4,
  "error": 2,
  "findings": [
    {"id": "#18", "severity": "error", "summary": "...", "fix_available": true},
    {"id": "#35", "severity": "warn", "summary": "...", "fix_available": false}
  ],
  "fix_applied": ["#18"],
  "coordinator_version": "1"
}
```

## Adding a New Check

1. Add to `parts/doctor.md` following the existing format (1-sentence Why:).
2. Update the total check count in the parallelization brief.
3. Verify `pass + warn + error` still sums correctly in the return shape.

## Per-Check Extended Rationale

When a check's Why: was too complex for 1 sentence, the full rationale appears here as §Check #N:

*(Append entries here as needed during Phase 1 prose pruning.)*
