# Bundle Resume — Internals

> **Audience:** Maintainers changing resume controller logic.
> **Phase file:** `parts/step-c-resume.md`.
> **Coordinator:** `coordinator-bundle-resume` (Haiku tier).

## Coordinator Dispatch

On every execute-turn entry, the orchestrator dispatches 1 Haiku coordinator with the bundle path. The coordinator reads state.yml + events.jsonl + plan.md and returns a compact situation report.

**Return shape:**
```json
{
  "phase": "executing",
  "current_task": "Task 5: Update step-c-dispatch.md",
  "next_action": "dispatch Codex for T5",
  "pending_gate": null,
  "autonomy": "loose",
  "last_5_events": ["wave_2_complete", "T4_committed", "T5_started"],
  "task_summary": [
    {"idx": 1, "status": "complete"},
    {"idx": 5, "status": "in-progress"}
  ],
  "coordinator_version": "1"
}
```

## state.yml Field Semantics

See `parts/contracts/run-bundle.md §state.yml schema` for full field definitions.

## Legacy Migration Path

For legacy status paths (no matching state.yml): coordinator is not dispatched until migration completes. See `parts/step-0.md §Legacy migration` for the migration AUQ flow.

## Failure Recovery

When `critical_error` is non-null or `status: blocked`, the coordinator still returns the situation report — the orchestrator surfaces the recovery gate from `pending_gate` data.
