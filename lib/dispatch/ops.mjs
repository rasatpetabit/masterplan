// lib/dispatch/ops.mjs — the dispatch-op decision: HOW a prepared wave reaches its agents.
//
// L2 deletion (simplify-dedup-2 task 8): fabric is the ONLY wave vehicle.
// dispatch_fabric / dispatch_fabric removed. Codex-suppressed hosts use the
// same dispatch_fabric op consumed by `mp dispatch-wave --codex-suppressed`.
//
//   normalizeReviewMode(raw) -> 'on' | 'off'
//   buildWaveDispatchOp({wave, cwd, tasks, baseline, review, ...}) -> op
//     Always { op:'dispatch_fabric', wave, cwd, tasks, baseline, review, next:'record-result' }
//   buildPlanFanoutOp({cwd, specPath, roots?}) -> op
//     Broker planning fan-out (kind:'plan') — READ-ONLY capability class.

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
 * The READ-ONLY capability class planning drafters dispatch through — the
 * agent-dispatch overlay's masterplan-planning lane.
 */
export const PLAN_FANOUT_CLASS = 'masterplan-planning';

// Planning fan-out op name. Consumer is `mp dispatch-plan` (deterministic).
// Not the retired MCP dispatch_fanout transport — this is a masterplan op name
// for the planning verb's broker fan-out shape.
const PLAN_FANOUT_OP = 'dispatch_plan';

/**
 * The broker planning fan-out op: subsystem-planner work items go through the
 * READ-ONLY PLAN_FANOUT_CLASS with explicitly enumerated accessible roots.
 *
 * @param {{ cwd: string, specPath?: string|null, roots?: string[]|null }} args
 */
export function buildPlanFanoutOp({ cwd, specPath = null, roots = null } = {}) {
  const accessibleRoots = Array.isArray(roots) && roots.length
    ? roots
    : [cwd, ...(specPath ? [specPath] : [])].filter(Boolean);
  return {
    op: 'dispatch_plan', // PLAN_FANOUT_OP
    kind: 'plan',
    cwd,
    class: PLAN_FANOUT_CLASS,
    read_only: true,
    roots: accessibleRoots,
    spec_path: specPath,
    specPath,
    next: 'stage-plan-fragments',
  };
}
