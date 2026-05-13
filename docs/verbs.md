# /masterplan Verbs Cheat Sheet

This is a human reference. The orchestrator does NOT load this file at runtime.

## `start`
Begin a new run. Routes through: `step-0.md` → `step-a.md` → `step-b.md` → `step-c.md`.
Flags: `--autonomy={gated|loose|full}`, `--complexity={low|medium|high}`, `--halt_mode={...}`.

## `resume`
Continue an active run from `state.yml.current_phase`. Routes through: `step-0.md` → `step-{current_phase}.md`.

## `status`
Print current run state. Routes through: `step-0.md` (status logic lives there).
No state mutation.

## `doctor`
Run all 36 doctor checks against the repo + active run bundles. Routes through: `step-0.md` → `doctor.md`.
Report-only by default; `--fix` for safe auto-fixes where supported.

## `import`
Migrate legacy planning artifacts into a new run bundle. Routes through: `step-0.md` → `import.md`.

## `archive`
Archive a completed run bundle. Routes through: `step-0.md` → `step-c.md` (archive subroutine).

## `validate`
Validate `~/.masterplan.yaml` or a per-run config. Loads `docs/config-schema.md`.

## `retry`
Retry a failed wave or wave member. Routes through: `step-0.md` → `step-c.md` (wave-dispatch subroutine).
