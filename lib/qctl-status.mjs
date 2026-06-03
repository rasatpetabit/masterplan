// lib/qctl-status.mjs — lossless qctl → masterplan task-status mapping (pure).
//
// Spec: docs/superpowers/specs/2026-06-02-skynet-inference-platform-design.md §6.2
//
// mapQctlStatus({ producerStatus, applyResult, d6Result })
//   -> { task_status: 'done'|'failed'|'blocked', flags: string[], producer_status: string }
//
// CONTRACT:
//   • Base table (producer gate → task status):
//       'accepted'    → done,   flags: []
//       'review'      → done,   flags: ['claude-review']  (gate-green, human sign-off pending)
//       'dead-letter' → failed, flags: []
//       unknown       → failed, flags: ['unknown-producer-status']
//
//   • Override precedence (checked AFTER the base table; overrides task_status/flags addend):
//       applyResult.ok === false → status overrides to 'blocked'  (patch did not apply;
//                                   cannot proceed — the textbook blocked condition)
//       d6Result.ok    === false → status overrides to 'failed'   (patch applied but
//                                   scope/verify failed — the textbook failed condition)
//       apply is tested first because a failed apply means d6 never ran.
//
//   • producer_status is ALWAYS the raw input producerStatus — never collapsed,
//     never rewritten by an override. Flags from the base table survive overrides
//     (e.g. review + apply-fail → task_status:blocked, flags:['claude-review']).
//
//   • undefined applyResult / d6Result means the stage was not evaluated → no override.
//
// This is a pure mapping table with no I/O, no process access, no imports.

const BASE_TABLE = {
  'accepted':    { task_status: 'done',   addFlags: [] },
  'review':      { task_status: 'done',   addFlags: ['claude-review'] },
  'dead-letter': { task_status: 'failed', addFlags: [] },
};

/**
 * @param {{ producerStatus: string, applyResult?: {ok: boolean}, d6Result?: {ok: boolean} }} input
 * @returns {{ task_status: 'done'|'failed'|'blocked', flags: string[], producer_status: string }}
 */
export function mapQctlStatus({ producerStatus, applyResult, d6Result } = {}) {
  // --- base table lookup ---
  const base = BASE_TABLE[producerStatus];
  let task_status;
  let flags;

  if (base) {
    task_status = base.task_status;
    flags = [...base.addFlags];
  } else {
    // Unknown producer status — treat as failed, flag it.
    task_status = 'failed';
    flags = ['unknown-producer-status'];
  }

  // --- override precedence (apply checked first; d6 never runs if apply fails) ---
  if (applyResult !== undefined && applyResult.ok === false) {
    // Patch did not apply: cannot proceed → blocked.
    task_status = 'blocked';
    // Flags from the base table survive (lossless); no additional override flag needed.
  } else if (d6Result !== undefined && d6Result.ok === false) {
    // Patch applied but scope/verify failed → failed.
    task_status = 'failed';
  }

  return {
    task_status,
    flags,
    // Producer gate status is kept SEPARATE, always echoes the raw input.
    producer_status: producerStatus,
  };
}
