# TaskCreate Projection — Implementation Plan

**Bundle slug:** `masterplan-taskcreate-projection`  
**Date:** 2026-05-12  
**Status:** Implementation complete — one deferred verification task remains

---

## Verify before continuing

All implementation tasks (Tasks 2–10) are complete via the `p4-suppression-fix` bundle (status: `completed`). Verify before treating this plan as open work:

| Task | Evidence | What to check |
|---|---|---|
| Task 2: Schema section | `parts/contracts/taskcreate-projection.md` | File exists and contains `## Projection schema` |
| Task 3: Rehydration wiring (Step M + Step C) | `parts/step-c.md` lines ~19–34 | Contains `Rehydrate or reconcile TaskCreate projection` and `step_c_session_init_sha` |
| Task 4: Transition mirror hooks | `parts/step-c.md` lines ~34+ | Contains `Mirror every state.yml task-transition to TaskList` |
| Task 5: Drift recovery | `parts/contracts/taskcreate-projection.md` | Contains `## Drift recovery` section with correction table |
| Task 6: Codex no-op gate | `parts/contracts/taskcreate-projection.md` | Contains `## Codex no-op gate`; `bin/masterplan-self-host-audit.sh --taskcreate-gate` passes |
| Task 7: Events documented | `parts/contracts/taskcreate-projection.md` | Contains `## Events emitted by this layer` with all four events (`taskcreate_projection_rehydrated`, `taskcreate_mirror_failed`, `taskcreate_drift_corrected`, `taskcreate_orphan_cancelled`) |
| Task 8: Wave fan-out tool-budget cost | Implementation live in `parts/step-c.md` | Batched `TaskUpdate` on wave dispatch present; empirical validation part of p4-suppression-fix scope |
| Task 9: Audit-script discriminators | `bin/masterplan-self-host-audit.sh` | `check_taskcreate_gate` function exists (line ~969); `--taskcreate-gate` flag wired at line ~1079 |
| Task 10: Docs + version bump | Plugin at v5.0.0 | `CHANGELOG.md` covers v5.0; `docs/internals.md` and `README.md` updated during v5.0 restructure |

---

## Active tasks

### Task 1: Run the reminder-suppression smoke test (deferred)

**Status:** Deferred — tracked in `p4-suppression-smoke`

This is an observational test, not an implementation task. It answers whether the harness reminder fires when `TaskList` contains only `pending` tasks (vs. when no tasks exist at all). The answer determines whether the initial-status mitigation in the projection schema needs to be activated by default.

**Existing bundle:** `docs/masterplan/p4-suppression-smoke/state.yml`  
**Bundle status:** `in_progress`, phase: `ready_to_execute`  
**Next action (from state.yml):** Enter Step C; execute 3 no-op tasks; observe reminder firings via `smoke_observation` events.

**To execute:** In a fresh session, run:

```
masterplan execute docs/masterplan/p4-suppression-smoke/state.yml
```

Do not execute this within the `masterplan-taskcreate-projection` bundle's session — the smoke test must run in isolation to observe uncontaminated reminder behavior.

**Expected outcome:** The smoke run appends `smoke_observation` events to `p4-suppression-smoke/events.jsonl` recording whether reminders fired. The retro for `p4-suppression-smoke` documents the finding. No changes to `parts/contracts/taskcreate-projection.md` are expected unless the smoke test reveals the mitigation must be activated by default.

---

## Completion criteria

This plan is complete when:

1. `p4-suppression-smoke` reaches status `completed` with a retro documenting the reminder-suppression finding.
2. If the smoke test reveals the initial-status mitigation must be activated by default, `parts/contracts/taskcreate-projection.md` is updated accordingly (new task, new bundle).
