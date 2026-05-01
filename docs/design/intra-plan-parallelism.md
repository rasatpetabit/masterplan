# Future: intra-plan task parallelism (design notes)

**Status:** not enabled. Captured here so future-you has a starting point when a plan with embarrassingly parallel tasks (e.g. multiple "add interface for service X" tasks) makes the latency win obvious.

These notes were originally inline in `commands/superflow.md` but moved here to keep the orchestrator prompt focused on operational logic.

## Annotation schema (proposed)

- `parallel-group: <name>` — tasks sharing the same group name dispatch as one wave.
- `depends-on: [<task-id>, ...]` — explicit ordering within or across groups.
- `files: [<path>, ...]` — declared file scope for static-analysis-based safety.

## Required machinery before enabling

- **Per-task git worktree isolation** — concurrent commits to the same branch race the git index. Each parallel task either commits in its own worktree (orchestrator merges after), or the dispatch enforces strict file-scope assertions and serializes commits via the orchestrator.
- **Single-writer status file** — subagents return digests; orchestrator funnels every status file write to avoid contention (per CD-7).
- **Per-task verification with rollback policy** — when one task in a wave fails, the others' results need a consistent disposition (rollback wave, mark partially complete, ask user).

## Why deferred

The per-task worktree subsystem is a meaningful undertaking and warrants its own dedicated plan. The current sequential per-task loop in `superpowers:subagent-driven-development` is correct as a default; intra-plan parallelism is an optimization on top, not a re-architecture.

## When to revisit

When real plans authored under `/superflow` show parallel-friendly task patterns and the latency cost becomes felt. Track this informally via retros (`superflow-retro` skill).
