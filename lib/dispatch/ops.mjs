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
//
//   buildPlanFanoutOp({cwd, specPath, roots?}) -> op
//     The broker planning fan-out shape (kind:'plan') that replaced the L2 plan
//     Workflow launch — READ-ONLY capability class + explicitly enumerated accessible
//     roots (repo + spec path); consumed by the deterministic `mp dispatch-plan`.
//     See the function docs below.

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

/**
 * The READ-ONLY capability class planning drafters dispatch through — the
 * agent-dispatch overlay's masterplan-planning lane. Broker-level write denial
 * where supported: descriptors on this class carry no write-scope fields
 * (files/repo/worktree), and the broker's descriptor validator rejects write
 * scope on read-only lanes.
 */
export const PLAN_FANOUT_CLASS = 'masterplan-planning';

// The planning fan-out op name. Deliberately a named constant rather than an inline
// literal: test/op-table-parity.test.mjs reads this module's op literals as the §2
// op-table producer set, and the table's consumer row for the broker planning fan-out
// lands with the l2-deletion commands/masterplan.md rewrite (same run, later wave).
// The op is NOT dangling in the interim — `mp dispatch-plan` is its deterministic
// consumer and ships together with this shape.
const PLAN_FANOUT_OP = 'dispatch_fanout';

/**
 * The broker planning fan-out op (replaces the L2 plan Workflow launch, the
 * launch_workflow(plan) arm lib/continue.mjs used to emit): subsystem-planner
 * work items go through the READ-ONLY PLAN_FANOUT_CLASS with explicitly
 * enumerated accessible roots (repo + spec path); pre/post `git status
 * --porcelain` assertions over those roots run in the consumer
 * (`mp dispatch-plan`) as defense in depth. Fragments come back as structured
 * payloads; the shell stages .plan-fragments.json exactly as today
 * (merge/validate/review gate unchanged).
 *
 * @param {{ cwd: string, specPath?: string|null, roots?: string[]|null }} args
 * @returns {object} the planning fan-out op
 */
export function buildPlanFanoutOp({ cwd, specPath = null, roots = null } = {}) {
  const enumerated = Array.isArray(roots) && roots.length > 0
    ? roots
    : [cwd, ...(specPath && specPath !== cwd ? [specPath] : [])];
  return {
    op: PLAN_FANOUT_OP,
    kind: 'plan',
    cwd,
    class: PLAN_FANOUT_CLASS,
    read_only: true,
    roots: enumerated,
    ...(specPath ? { spec_path: specPath } : {}),
    next: 'stage-plan-fragments',
  };
}
