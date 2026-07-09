// lib/dispatch/ops.mjs — the dispatch-op decision: HOW a prepared wave reaches its agents.
//
// Lifted out of lib/continue.mjs's dispatchWave tail at the dispatch-module consolidation
// (2026-06-10). Pure — the caller (the continue trampoline) owns all state reads/writes,
// git, and the phase-1 launching marker; this module only encodes the topology choice and
// the op shapes, so the "which dispatch vehicle" decision is testable in isolation and
// portable toward the unified dispatch system.
//
//   normalizeReviewMode(raw) -> 'on' | 'off'
//     Collapses the persisted/flag review config (true/'on'/'true' vs everything else)
//     into the binary the L2 engine and the foreground path both consume.
//
//   buildWaveDispatchOp({wave, cwd, tasks, baseline, review, codexSuppressed,
//                        orchestratorHost, orchestratorHead}) -> op
//     The Residual-3B fork, as data:
//       codexSuppressed → { op:'dispatch_foreground', wave, cwd, tasks, baseline, review,
//                           next:'record-result' }
//         A suppressed host has no Workflow tool, so the wave dispatches FOREGROUND-
//         SEQUENTIAL in the host's own session (Codex inline; a CC fallback runs one Agent
//         per task, sequentially). Same routed payloads, same frozen scope/baseline, same
//         phase-1 launching marker — so a crash mid-wave resumes through the identical
//         recover_and_redispatch path (no task_id is ever promoted; there is no background
//         task to probe). The host assembles the standard result shape
//         ({wave, tasks:[{task_id, digest}]}) and feeds it to the SAME `mp record-result`.
//       otherwise        → { op:'launch_workflow', workflow:'execute', cwd,
//                           args:{wave, tasks, baseline, repoRoot:cwd, review,
//                                 [orchestratorHost], [orchestratorHead]},
//                           next:'promote-active-run' }
//         The L2 engine path (workflows/execute.workflow.js) — one background Workflow run
//         per wave; the shell promotes the launching marker once the task_id exists.
//         orchestratorHost/orchestratorHead (when the caller probed them) carry the L1 host's
//         machine-id + repo HEAD so the L2 reviewer's Layer-4 host-identity guard can prove it
//         shares the orchestrator's filesystem before any local git; omitted → legacy unguarded.
//       fabric=true      → { op:'dispatch_fabric', wave, cwd, tasks, baseline, review,
//                           next:'record-result' }
//         The L1->fabric seam: a single op that supersedes the two-branch fork, gated so
//         rollback is a flag flip.

export function normalizeReviewMode(raw) {
  return raw === true || raw === 'on' || raw === 'true' ? 'on' : 'off';
}

export function buildWaveDispatchOp({ wave, cwd, tasks, baseline, review, codexSuppressed = false, fabric = false, orchestratorHost = null, orchestratorHead = null } = {}) {
  if (fabric) {
    // Strangler phase flag: L1 emits ONE op the fabric wave-op executor consumes, replacing
    // both the L2 Workflow launch and the foreground-sequential fork. The fabric owns the
    // execution topology (parallel vs sequential); L1 just hands it the routed payloads and
    // the frozen scope/baseline. Digests route back through the SAME `mp record-result`
    // transaction (next:'record-result'), so rollback is flipping this flag off, not a revert.
    return {
      op: 'dispatch_fabric',
      wave,
      cwd,
      tasks,
      baseline,
      review,
      next: 'record-result',
    };
  }
  if (codexSuppressed) {
    return {
      op: 'dispatch_foreground',
      wave,
      cwd,
      tasks,
      baseline,
      review,
      next: 'record-result',
    };
  }
  return {
    op: 'launch_workflow',
    workflow: 'execute',
    cwd,
    // Layer-4 host-identity provenance is CONDITIONALLY spread: when the caller could not probe
    // the orchestrator's machine-id/HEAD (or on a legacy caller), the keys are absent and L2 runs
    // the unguarded status quo — never worse than before, and the default args stay byte-identical.
    args: {
      wave, tasks, baseline, repoRoot: cwd, review,
      ...(orchestratorHost ? { orchestratorHost } : {}),
      ...(orchestratorHead ? { orchestratorHead } : {}),
    },
    next: 'promote-active-run',
  };
}
