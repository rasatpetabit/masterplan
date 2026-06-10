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
//   buildWaveDispatchOp({wave, cwd, tasks, baseline, review, codexSuppressed}) -> op
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
//                           args:{wave, tasks, baseline, repoRoot:cwd, review},
//                           next:'promote-active-run' }
//         The L2 engine path (workflows/execute.workflow.js) — one background Workflow run
//         per wave; the shell promotes the launching marker once the task_id exists.

export function normalizeReviewMode(raw) {
  return raw === true || raw === 'on' || raw === 'true' ? 'on' : 'off';
}

export function buildWaveDispatchOp({ wave, cwd, tasks, baseline, review, codexSuppressed = false } = {}) {
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
    args: { wave, tasks, baseline, repoRoot: cwd, review },
    next: 'promote-active-run',
  };
}
