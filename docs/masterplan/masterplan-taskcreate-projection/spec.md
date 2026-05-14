# TaskCreate Projection — Design Spec

**Date:** 2026-05-12  
**Sub-project:** P4 of the v5.x decomposition  
**Status:** Implementation complete (see Background)

---

## Background

This spec was drafted 2026-05-12 as P4 of the v5.x masterplan decomposition. The goal was to project the masterplan run state into Claude Code's native `TaskCreate` ledger so that:

1. The harness UI surfaces wave / parallel-group progress instead of being blind to it.
2. The harness stops emitting "you have N pending tasks, consider TaskUpdate" reminders that steal tokens from the orchestrator's context.

Implementation was completed via the **`p4-suppression-fix`** bundle (status: `completed`). The canonical implementation artifacts are:

- **Schema, rehydration, drift recovery, Codex no-op gate:** `parts/contracts/taskcreate-projection.md`
- **Step C hooks (rehydration + mirror):** `parts/step-c.md` lines ~19–34
- **Audit check (`--taskcreate-gate`):** `bin/masterplan-self-host-audit.sh` (`check_taskcreate_gate` function)

The plan's original target version (v4.1.0) was bypassed — the implementation landed as part of the v5.0 restructure.

---

## Purpose

Project the masterplan run state into Claude Code's native `TaskCreate` ledger.

**This is a derived projection, not a re-platforming.** `docs/masterplan/<slug>/state.yml` remains the canonical ledger per CD-7. The `TaskCreate` output is a one-way reflection rebuilt on every session start. If the projection and `state.yml` disagree, `state.yml` wins and the `TaskList` is regenerated. The orchestrator never reads `TaskList` back as a source of truth.

---

## Out of scope

- Replacing `state.yml`'s ledger role. CD-7 is unchanged.
- Cross-session task persistence inside the harness. `TaskCreate` is session-scoped by design — the projection is rebuilt every session.
- Wave dispatch logic itself. Wave members continue returning digests; the orchestrator still writes `state.yml`. The projection just mirrors what `state.yml` records.
- Codex parity. Codex has no `TaskCreate` equivalent surfaced through the current tool contract; the projection is a no-op there (see §Codex no-op gate).

---

## Key design decisions

### One-way projection

`state.yml` is canonical. The `TaskList` is never read back as a source of truth. Drift between `TaskList` and `state.yml` is always resolved by correcting `TaskList` to match `state.yml`, never the reverse.

### Projection threshold

`tasks.projection_threshold` (default: `15`) gates both projection and per-state-write priming:

- `len(plan.tasks) <= 15` → full per-task projection + per-state-write `TaskUpdate` priming.
- `len(plan.tasks) > 15` → single sentinel `TaskCreate("masterplan: <slug>")` only; no per-task mirroring.

Configured in `~/.masterplan.yaml` under `tasks.projection_threshold`. Per-run override: `--tasks.projection_threshold=N`.

### Projection schema

One-to-one mapping: each `plan.md` task → one `TaskCreate` entry. Key fields:

| TaskCreate field | Source |
|---|---|
| `subject` | First line of plan-task heading, truncated to 80 chars. |
| `description` | Plan-task body, truncated to 500 chars. |
| `prompt` | Empty (orchestrator drives execution). |
| `metadata` | `{"masterplan": {"slug", "task_idx", "wave", "parallel_group", "plan_path", "state_path"}}` |
| Initial status | `pending`. If reminder fires on `pending`-only lists, promote `current_task` to `in_progress` at rehydration. |

DAG edges: `TaskUpdate { addBlockedBy }` in a second pass. Same-wave tasks have no blocking edges between them.

### Rehydration

Runs once per session at the first of: Step M resolving an in-progress bundle; Step C entry; Step I completing an in-progress import. Full procedure in `parts/contracts/taskcreate-projection.md § Rehydration`.

Gated on `codex_host_suppressed == false`.

### Per-state-write priming

Every Step C `state.yml` write (including non-task-transition writes such as `last_activity` bumps and `pending_gate` writes) is followed by a `TaskUpdate` re-stamp of the current task. Purpose: refresh the harness's recent-`Task*`-usage signal to suppress per-turn reminders during idle-turn gaps. Gated on projection mode and `current_task != ""`.

### Drift recovery

`state.yml` is canonical. Drift is detected at rehydration and at every Step C re-entry. `TaskList` is always corrected to match `state.yml`. No inverse reconciliation. Full table in `parts/contracts/taskcreate-projection.md § Drift recovery`.

### Codex no-op gate

The projection is Claude Code only. On Codex hosts, every `TaskCreate` / `TaskUpdate` / `TaskList` call is skipped and no `taskcreate_*` events are emitted. Gate: `codex_host_suppressed` boolean set in Step 0.

### Audit coverage

`bin/masterplan-self-host-audit.sh --taskcreate-gate` verifies that all `TaskCreate` / `TaskUpdate` / `TaskList` call sites are inside the Codex no-op gate. Wired into the default check path.

### Doctor check #33

Warns when ledger state is inconsistent with current threshold/plan size (e.g., full projection entries persist after plan grew past threshold, or single sentinel remains after plan shrank below threshold). Implemented in `parts/doctor.md` (T16).

---

## Deferred verification

**Task 1 (reminder-suppression smoke test)** was deferred and tracked separately in the `p4-suppression-smoke` bundle (status: `in_progress`, phase: `ready_to_execute`).

The open question it answers: does the harness reminder fire when tasks exist in `pending` state, or only when no tasks exist at all? If the former, reminder-suppression works as designed. If the latter, a long stretch of `pending`-only tasks could paradoxically increase reminders. The schema includes a mitigation (promote `current_task` to `in_progress` at rehydration if needed), but empirical confirmation is still pending.

To run: execute `p4-suppression-smoke` in a fresh session via `masterplan execute docs/masterplan/p4-suppression-smoke/state.yml`.
