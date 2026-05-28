// lib/routing.mjs — Codex eligibility as a PURE function (build step 1).
//
// Replaces the v7 6-bullet eligibility checklist that lived as LLM-interpreted
// prose (fragility source #2: name-aliasing reasoning errors). Deterministic,
// zero-token, node:test'able with fixtures.
//   routeTask(task, config, host) -> { target: 'codex'|'inline', reason }
// Honors: <=3 files, no design-judgment verbs, has verify cmds, not sensitive,
// not conversational; the `codex` annotation (ok/no); codexRouting config; host
// suppression.
// TODO(step 1): implement + fixture-driven tests (the eligibility truth table).
export {};
