# Run B spec — masterplan-repo half of simplify-dedup-2

**Umbrella:** `/srv/dev/ras/masterplan` · **Branch:** `masterplan/simplify-dedup-2`
(adopted; 5 task commits already landed atop `f946f77`).
**Cross-run design of record:** `/srv/dev/ai/agent-dispatch/docs/masterplan/simplify-dedup-2/split-spec.md`
(v2, user-approved 2026-07-16, cross-vendor reviewed). This file is the Run-B-local
restatement the plan gate reviews; the split-spec is authoritative for the two-run
choreography.

## Why this run exists

The agent-dispatch run's engine commits exactly one git locus (its umbrella worktree), so
any task declaring files under `/srv/dev/ras/masterplan` was orphaned by construction.
Run B gives that work a run whose umbrella IS the masterplan repo, where the one-locus
assumption holds and every task's code commits cleanly. See split-spec §1–3.

## Scope — 13 tasks (migrated from the agent-dispatch run, paths rebased to this umbrella)

- **Fabric consolidation (G1):** `l2-deletion`, `planning-fanout`, `marker-reconcile`,
  `cmd-docs`, `dogfood-v1`, `codex-suppressed-smoke`, `class-default` — make `mp
  dispatch-wave` (fabric/broker) the sole wave-execution and planning fan-out path; delete
  the legacy L2 workflow surface; reconcile persisted legacy markers without crashing.
- **Per-task adversary review parity (G2):** `per-task-review` — fabric runs per-task
  adversary review over each task's full diff, blocking verdicts surfaced at wave
  completion.
- **qctl seam (G3):** `qctl-seam` — retain qctl scaffolding dormant, reachable from a
  documented fabric seam, proven by an executable flag-on test + a flag-off negative test.
- **Skynet inversion on masterplan surfaces (G4):** `wrapper-rewire` (MP half),
  `verify-transport-seam` — no `mcp__skynet__`/`skynet_` reference on live masterplan
  surfaces; the five wrapper agents route through agent-dispatch lanes.
- **Keyed re-entry guard (G5):** `reentry-guard-rewire` — rewire `bin/masterplan.mjs`,
  `finish-step.mjs`, `gate-review.mjs`, `review-companion.mjs` onto the single keyed guard
  module (already landed as task 1, commit cc13f70).
- **Release version bump (G6):** `plugin-version-bump` — bump the plugin version above
  9.5.0 with the four version-bearing files in agreement (post-bump `jq` equality
  replacing the deleted doctor check #30); suite + doctor green at that version. Merge and
  cache-install are finish / orchestrator steps, not tasks (split-spec §3).

## Constraints

- **C3:** every task lands as a reviewable commit on `masterplan/simplify-dedup-2`, merged
  at finish. Base = `20f5fa7` (current branch tip).
- **Adopted history:** tasks 1, 3, 40, 46, 48 are already landed (commits on the branch);
  they are NOT re-run — external deps to them are pre-satisfied by the base and were
  dropped from the migrated graph.
- **Both-repo halves:** `class-default` (32) and `wrapper-rewire` (41) carry ONLY their
  masterplan files here; their agent-dispatch halves (the `masterplan.jsonc` overlay +
  `effective-policy.test.mjs`) are separate Run A tasks with a cross-repo consistency gate
  (split-spec §5).
- **Finish:** `--choice=merge` lands the branch on `main`; the orchestrator then pushes and
  installs the released version to the plugin cache (split-spec §3 8b/8c).

## Acceptance

The six frozen goals in `goals.md` (G1–G6), verified per their declared signal/evidence.
