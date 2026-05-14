# Retrospective: masterplan-taskcreate-projection

**Date:** 2026-05-13
**Status:** complete
**Outcome:** TaskCreate projection design finalized and delivered; harness token-theft suppression shipped in p4-suppression-fix bundle.

## What happened

This plan (P4 of the v5.x decomposition) designed the projection of masterplan wave/parallel-group progress into Claude Code's native TaskCreate ledger. The goal was twofold: surface run progress in the harness UI, and suppress the "you have N pending tasks, consider TaskUpdate" reminders that were consuming tokens mid-run. Implementation was handed off to the **p4-suppression-fix** execution bundle, which delivered the canonical artifacts. One smoke-test task was deferred to the **p4-suppression-smoke** bundle. This bundle was imported from legacy plan+spec artifacts on 2026-05-13.

## What went well

- Clean separation of concerns: projection is derived/read-only; state.yml remains canonical per CD-7.
- TaskList-rebuild-per-session pattern avoids stale ledger state across compactions.
- Codex no-op gate was a correct call — no TaskCreate equivalent in current Codex tool contract, so no dead code was introduced.
- Canonical contract captured in `parts/contracts/taskcreate-projection.md` for future reference.
- Suppression fix landed cleanly in the v5.0 restructure without blocking other P4 work.

## What could improve

- Smoke verification was deferred (Task 1 → p4-suppression-smoke); ideally the execution bundle completes smoke before closing the design bundle.
- The import hydration path meant this bundle never had a live execution phase — harder to validate that the design matched what was actually shipped.
- Token-theft suppression should have been scoped as a blocker earlier; it was discovered as a side-effect of the projection work rather than a stated requirement.

## Follow-up items

- Smoke test tracked in `p4-suppression-smoke` bundle — verify harness reminder suppression end-to-end.
- Confirm `bin/masterplan-self-host-audit.sh --taskcreate-gate` gate passes after smoke completes.
- Consider promoting TaskCreate projection pattern to internals.md§Harness integration once smoke passes.
