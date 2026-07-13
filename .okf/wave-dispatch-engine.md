---
type: reference
title: masterplan — wave-dispatch execution engine
timestamp: 2026-07-13T00:00:00Z
privacy: private
tags: [masterplan, wave-dispatch, workflow, execute]
---

# Wave-dispatch execution engine

The L2 layer — `workflows/execute.workflow.js` and `lib/wave.mjs` /
`lib/dispatch/` — handles wave-by-wave task dispatch to L3 subagents
(`agents/mp-*.md`) during the `execute` phase. Each launch of the execute
workflow processes exactly one wave of tasks; results come back as
structured digests that get merged into plan state via
`lib/plan-merge.mjs`.

Critically, this layer never writes disk or git directly — it returns
digests/fragments only, and the L1 `mp` CLI (`bin/masterplan.mjs`) is the
one that persists any resulting state change. This keeps the workflow engine
stateless between launches and lets the L0/L1 resume engine remain the
sole source of truth for run progress.

See [`docs/internals/wave-dispatch.md`](../docs/internals/wave-dispatch.md)
for the full design.
</content>

New seeds default `state.dispatch.fabric: true`, so `mp continue` emits `dispatch_fabric` → `mp dispatch-wave` (agent-dispatch broker) unless `--fabric=off` at seed. See [`docs/internals/wave-dispatch.md`](../docs/internals/wave-dispatch.md).
