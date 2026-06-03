// lib/qctl-enqueue.mjs — idempotent enqueue key + UPSERT decision for the L1-owned
// async qctl backend (spec §6.1 dispatch-locus). PURE module: no fs, no clock, no
// randomness, no subprocess. bin and the shell own any git/subprocess/UUID minting.
//
// Exports:
//   computeEnqueueKey({ run_slug, wave, task_id, base, scope }) -> sha256 hex string
//   decideEnqueue(existingJob, key) -> { action: 'reuse' | 'upsert', job }
//
// computeEnqueueKey produces a stable, collision-resistant key over the canonical tuple
// (sorted scope, exact base SHA). Scope is sorted before hashing so that
// ['a','b'] and ['b','a'] produce the same key — field order in the JSON is fixed to
// prevent field-boundary collisions ('run_slug:"a",wave:"bc"' vs 'run_slug:"ab",wave:"c"').
//
// decideEnqueue compares the stored job's key to the requested key:
//   - null existingJob  -> action:'upsert', job:null   (no prior row, shell must enqueue)
//   - key matches       -> action:'reuse', job:existingJob  (idempotent, same run)
//   - key mismatch      -> action:'upsert', job:null   (base/scope drifted -> new identity)
//
// For 'upsert' the returned job is null because this module is pure: the shell (L1) is
// the only entity that holds a UUID generator and the qctl CLI. The caller stamps the
// new job_id when it executes the actual enqueue.

import { createHash } from 'node:crypto';

/**
 * Compute a stable sha256 hex key for the given (run_slug, wave, task_id, base, scope)
 * tuple. scope is sorted before hashing; the canonical JSON field order is fixed.
 *
 * @param {object} params
 * @param {string} params.run_slug
 * @param {number|string} params.wave
 * @param {number|string} params.task_id
 * @param {string} params.base    - exact base-commit SHA the patch applies against
 * @param {string[]} [params.scope] - declared file list (order-independent)
 * @returns {string} lowercase hex sha256
 */
export function computeEnqueueKey({ run_slug, wave, task_id, base, scope = [] }) {
  const canonical = JSON.stringify({
    base,
    run_slug,
    scope: [...scope].sort(),   // copy before sort — never mutate caller's array
    task_id,
    wave,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Decide whether to reuse an existing qctl job or upsert a new one.
 *
 * @param {object|null} existingJob  - the job row already in run-state, or null
 * @param {string}      key          - the key produced by computeEnqueueKey for this attempt
 * @returns {{ action: 'reuse'|'upsert', job: object|null }}
 *   action:'reuse' -> job is the existing row (caller does nothing, waits on it)
 *   action:'upsert'-> job is null (caller calls `qctl enqueue` and persists the new row)
 */
export function decideEnqueue(existingJob, key) {
  if (existingJob !== null && existingJob !== undefined && existingJob.key === key) {
    return { action: 'reuse', job: existingJob };
  }
  return { action: 'upsert', job: null };
}
