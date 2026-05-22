# Wave Dispatch — Internals

> **Audience:** Maintainers changing Step C2 wave batch assembly or Codex routing.
> **Phase file:** `parts/step-c-dispatch.md`.

## Wave Assembly

Tasks in the plan are grouped into waves by `**Parallel-group:**` annotations. All tasks with the same group name are dispatched concurrently; tasks with `**Parallel-group:** none` are dispatched serially.

### Rules

- Parallel-grouped tasks must have exhaustive `**Files:**` blocks (required at `complexity == high`).
- Codex-eligible tasks (`**Codex:** true`) are dispatched to `codex:codex-rescue`.
- Parallel-grouped tasks must be read-only or write only to gitignored paths.

### Codex Routing Decision Tree

1. Task `**Codex:** true` AND `codex_routing != off` → route to Codex.
2. Task `**Codex:** false` OR `codex_routing == off` → route inline (Sonnet/Haiku subagent).
3. Codex unavailable (step-0 degraded) → route inline; suffix `(codex degraded — plugin missing)` per task banner.

### Wave Completion

A wave is complete when all members return. Orchestrator verifies each result before dispatching the next wave. Failed tasks trigger the CD-4 blocker-re-engagement ladder.
