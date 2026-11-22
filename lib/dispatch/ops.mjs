// lib/dispatch/ops.mjs — the dispatch-op decision: HOW a prepared wave reaches its agents.
//
// Fabric is the ONLY wave vehicle: the dispatch_fabric op consumed by
// `mp dispatch-wave` (native spawn plans on every host).
//
//   normalizeReviewMode(raw) -> 'on' | 'off'
//   buildWaveDispatchOp({wave, cwd, tasks, baseline, review, ...}) -> op
//     Always { op:'dispatch_fabric', wave, cwd, tasks, baseline, review, next:'record-result' }
//   buildPlanFanoutOp({cwd, specPath, roots?}) -> op
//     Native planning fan-out (kind:'plan') — READ-ONLY policy class.

export function normalizeReviewMode(raw) {
  return raw === true || raw === 'on' || raw === 'true' ? 'on' : 'off';
}

export function buildWaveDispatchOp({
  wave,
  cwd,
  tasks,
  baseline,
  review,
  codexSuppressed = false,
  fabric = true,
  orchestratorHost = null,
  orchestratorHead = null,
} = {}) {
  // Call-site compatibility: unused after L2 deletion (always fabric).
  void codexSuppressed;
  void fabric;
  void orchestratorHost;
  void orchestratorHead;
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

/**
 * The native planning fan-out op: subsystem-planner spawn descriptors run under the
 * read-only planning class with explicitly enumerated accessible roots.
 *
 * @param {{ cwd: string, specPath?: string|null, roots?: string[]|null }} args
 */
export function buildPlanFanoutOp({ cwd, specPath = null, roots = null } = {}) {
  const accessibleRoots = Array.isArray(roots) && roots.length
    ? roots
    : [cwd, ...(specPath ? [specPath] : [])].filter(Boolean);
  return {
    op: 'dispatch_plan',
    kind: 'plan',
    cwd,
    phase: 'plan',
    read_only: true,
    roots: accessibleRoots,
    spec_path: specPath,
    specPath,
    next: 'stage-plan-fragments',
  };
}
