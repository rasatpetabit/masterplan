# Task Verification — Internals

> **Audience:** Maintainers changing Step C3 verification logic.
> **Phase file:** `parts/step-c-verification.md`.
> **Coordinator:** `coordinator-task-verify` (Haiku tier).

## Coordinator Dispatch

Orchestrator dispatches 1 Haiku coordinator with task verify commands + expected PASS pattern. Coordinator runs commands, evaluates output, returns pass/fail + excerpt.

**Return shape:**
```json
{
  "status": "pass",
  "exit_code": 0,
  "excerpt": "✓ syntax OK\n✓ 0 errors found\n",
  "commands_run": ["bash -n hooks/masterplan-telemetry.sh"],
  "pattern_matched": "PASSED?|OK|0 errors",
  "coordinator_version": "1"
}
```

## PASS Patterns

Default: `PASSED?|OK|0 errors|0 failures|exit 0|✓`

Override with `**verify-pattern:** <regex>` in the task's `**Verify:**` block.

## Trust-skip Logic

When `codex_review: on` AND the Codex implementer returned `commands_run_excerpts` showing exit 0, the orchestrator may trust-skip coordinator dispatch (G.1 mitigation). Trust-skip is opt-in; default always dispatches coordinator-task-verify.

## G.1 Mitigation

Trust-skip avoids double-verification when Codex already ran the verify commands. See `parts/contracts/agent-dispatch.md §G.1` for full trust-skip predicate.
