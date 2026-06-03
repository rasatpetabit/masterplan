// lib/qctl-requeue.mjs — base-drift requeue decision as a PURE function.
//
// A patch issued by qctl carries the SHA it was built against (recordedBase).
// Before the shell applies that patch, it probes the current tree HEAD
// (currentHead) and passes both in. This module decides:
//
//   apply  — recorded base exactly matches current HEAD; no drift, safe to apply.
//   requeue — bases differ (or are missing); reissue against currentHead so the
//             implementer rebuilds against the current tree.
//
// The safety invariant: when there is any doubt, NEVER force-apply. The only
// way to get action:'apply' is for recordedBase === currentHead (string equality,
// both non-empty). Everything else — drift, missing SHAs, anything ambiguous —
// produces action:'requeue' with requeueBase set to currentHead exactly.
//
// The git facts (recordedBase, currentHead) are captured and passed in by the
// shell; this module contains zero I/O. declaredScope is carried through for
// consumers but plays no role in the decision (it is a task-dispatch field, not
// a base-drift discriminator).
//
//   decideBaseDrift({recordedBase, currentHead, declaredScope})
//     -> { action: 'apply'|'requeue', requeueBase: string|null }

export function decideBaseDrift({ recordedBase, currentHead, declaredScope } = {}) {
  // Safety first: both SHAs must be present non-empty strings that match exactly.
  if (
    typeof recordedBase === 'string' && recordedBase.length > 0 &&
    typeof currentHead === 'string'  && currentHead.length  > 0 &&
    recordedBase === currentHead
  ) {
    // No drift — patch is safe to apply against the current tree.
    return { action: 'apply', requeueBase: null };
  }

  // Any other case (drift, missing/null/undefined SHA) → requeue.
  // requeueBase is ALWAYS currentHead on this path so the implementer targets
  // the exact commit the shell currently has, not the stale recorded base.
  const requeueBase = (typeof currentHead === 'string' && currentHead.length > 0)
    ? currentHead
    : null;

  return { action: 'requeue', requeueBase };
}
