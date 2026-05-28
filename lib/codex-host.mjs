// lib/codex-host.mjs — Codex-host dual-targeting, minimized (build step 1).
//
// detectHost(), suppressRescue(), normalizeResumeHint(), goal-bridge.
// Recursive-dispatch suppression and the `$masterplan` shell-trap normalization
// are CORRECTNESS invariants, carried forward verbatim from v7. The old bespoke
// codex_host_perf_guard budget block is dropped in favor of the Workflow tool's
// native `budget`.
// TODO(step 1): implement + tests for host detection and the suppression matrix.
export {};
