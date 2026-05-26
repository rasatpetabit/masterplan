# /masterplan Verbs Cheat Sheet

This is a human reference. The orchestrator does NOT load this file at runtime.

## `full`
Begin a new run end-to-end. Routes through: `step-0.md` → `step-b.md` (B0→B1→B2→B3) → `step-c-resume.md` (C).

## `brainstorm`
Run brainstorm phase only (B0→B1). Halts at B1 close-out gate. Routes through: `step-0.md` → `step-b.md`.

## `plan`
Run plan phase only (B2→B3). Halts at B3 close-out gate. Routes through: `step-0.md` → `step-a.md` (spec-pick) or `step-b.md`.
Flags: `--from-spec` to use an existing spec without re-brainstorming.

## `execute`
Resume or begin execution. Routes through: `step-0.md` → `step-c-resume.md` (state-path resume) or `step-a.md` (picker when no active bundle).
Flags: `--resume=<path>` to resume a specific bundle path directly.

## `retro`
Generate a retrospective for a completed run. Routes through: `step-0.md` → `step-c-resume.md` (Step R subroutine).

## `import`
Migrate legacy planning artifacts into a new run bundle. Routes through: `step-0.md` → `import.md`.

## `doctor`
Run all 52 doctor checks against the repo + active run bundles. Routes through: `step-0.md` → `doctor.md`.
Report-only by default; `--fix` for safe auto-fixes where supported.

## `status`
Print current run state. Routes through: `step-0.md` (status logic lives there). No state mutation.

## `stats`
Print telemetry roll-up for active and archived run bundles. Routes through: `step-0.md` (Step T subroutine).

## `clean`
Archive stale bundles and prune orphan artifacts. Routes through: `step-0.md` (Step CL subroutine).

## `validate`
Validate `~/.masterplan.yaml` or a per-run config against `docs/config-schema.md`. Routes through: `step-0.md` (reads config-schema.md inline).

## `next`
What's-next router — surfaces the most actionable pending item across all active bundles. Routes through: `step-0.md` (Step N subroutine).
