# Doctor Checks — Internals

> **Audience:** Maintainers adding or fixing doctor checks.
> **Phase file:** `parts/doctor.md` (loaded internally by coordinator-doctor; not loaded into orchestrator context directly in v6.0+).
> **Coordinator:** `coordinator-doctor` (Sonnet tier).

## Coordinator Dispatch

The orchestrator dispatches 1 Sonnet coordinator for `/masterplan doctor [--fix]`. The coordinator loads `parts/doctor.md` internally, runs all checks, and returns compact findings JSON.

**Return shape:**
```json
{
  "pass": 40,
  "warn": 5,
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

1. Add `## Check #N` section to `parts/doctor.md` with a `**Scope:**` field set to
   `Plan-scoped`, `Repo-scoped`, `Global`, or `Prompt-scoped`.
2. Register the check in the right routing slot based on its Scope:
   - **Plan-scoped**: add to the parallelization brief list (line 20) and the relevant
     complexity sets (lines 58–60).
   - **Repo/Global/Prompt-scoped**: add to the repo-scoped batch:
     - line 22 (prose description list),
     - line 29 (Goal count + check list),
     - line 32 (Return shape `checks_processed` array),
     - line 35 (partial-failure comparison array),
     - `commands/masterplan-contracts.md` §Contract: doctor.repo_scoped.schema_v1
       (`purpose` count + `algorithm` entry + `checks_processed` array).
3. Run `bash tests/static/test-doctor-tier-drift.sh` — it validates Scope: field → routing slot
   consistency for all explicit-Scope checks. FAIL means the check is in the wrong slot.
4. Update the doctor file title (`# Doctor — Self-Host Checks (#1 .. #N)`) and preamble comment
   on line 3 to include the new check's version provenance.
5. Verify `pass + warn + error` still sums correctly in the return shape example above.

## Per-Check Extended Rationale

When a check's Why: was too complex for 1 sentence, the full rationale appears here as §Check #N:

*(Append entries here as needed during Phase 1 prose pruning.)*
