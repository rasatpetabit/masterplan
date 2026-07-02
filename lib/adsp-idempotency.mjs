// lib/adsp-idempotency.mjs — pure handoff-idempotency key module (spec §5.5).
//
// STATUS (adsp-v1): correctness core for the masterplan↔fabric handoff seam.
// The seam is at-least-once with idempotent recording: fabric work items and
// blackboard results are keyed by the FULL composed handoff key
// (run_id, task_id, task_spec_hash, input_fingerprint) — NEVER by
// (run_id, task_id, task_spec_hash) alone. A re-dispatch of an unchanged item
// against unchanged inputs resolves to a no-op read of the prior blackboard
// result; a replanned task body OR a changed repo/policy fingerprint must
// never reuse a stale result.
//
// Purity contract
// ---------------
// This module is deliberately impurity-free: no child_process, no fs, no
// network. All environmental facts (git HEAD, dirty-state digest, policy and
// worker versions) are captured shell-side by the caller and passed in as
// plain data. node:crypto is the only runtime import. Determinism is
// guaranteed by canonical JSON serialization — object key order never changes
// a hash.
//
// Frozen dispatch record (spec §5.5): all inputs to the key are persisted on
// the blackboard at dispatch time. Resume/duplicate-detection compare against
// the ORIGINAL record's key parts (via decideReuse) — they never recompute
// the key from current policy/catalog state.

import { createHash } from 'node:crypto';

/** Pinned contract version for the idempotency key scheme. */
export const IDEMPOTENCY_VERSION = 'adsp-idem-v1';

// ---------------------------------------------------------------------------
// Canonical JSON (stable serialization — key order must not change the hash)
// ---------------------------------------------------------------------------

/**
 * Serialize a value to canonical JSON: object keys sorted lexicographically
 * at every depth, arrays kept in order, undefined properties omitted (as in
 * JSON.stringify). Rejects values JSON cannot represent deterministically.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return serialize(value);
}

function serialize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalJson: non-finite number ${value}`);
    }
    return JSON.stringify(value);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new TypeError(`canonicalJson: cannot serialize top-level ${t}`);
  }
  if (Array.isArray(value)) {
    // Inside arrays JSON.stringify maps undefined/function to null; mirror that.
    return `[${value.map((v) =>
      (v === undefined || typeof v === 'function' || typeof v === 'symbol')
        ? 'null'
        : serialize(v)
    ).join(',')}]`;
  }
  // Plain object: sorted keys, undefined-valued keys omitted (JSON semantics).
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    parts.push(`${JSON.stringify(k)}:${serialize(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * SHA-256 hex digest of a value's canonical JSON form.
 *
 * @param {unknown} value
 * @returns {string} 64-char lowercase hex
 */
export function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// task_spec_hash — covers task body, context, and worker config
// ---------------------------------------------------------------------------

/**
 * Compute the task spec hash over the task body, its context, and the worker
 * configuration. Any change to any of the three (a replanned description,
 * different file scope, new verify commands, different worker settings)
 * produces a different hash — and therefore a different handoff key.
 *
 * @param {object} spec
 * @param {object} spec.body          — task body (id, description, files, verify_commands, …)
 * @param {object} [spec.context]     — dispatch-time context handed to the worker
 * @param {object} [spec.workerConfig] — worker configuration (class, tier, limits, …)
 * @returns {string} sha256 hex
 */
export function computeTaskSpecHash({ body, context = null, workerConfig = null } = {}) {
  if (body == null || typeof body !== 'object') {
    throw new TypeError('computeTaskSpecHash: spec.body (object) is required');
  }
  return canonicalHash({
    v: IDEMPOTENCY_VERSION,
    body,
    context,
    worker_config: workerConfig,
  });
}

// ---------------------------------------------------------------------------
// input fingerprint — repo + policy/worker version state, passed in as data
// ---------------------------------------------------------------------------

/**
 * Compute the input fingerprint from environmental facts captured shell-side:
 * git HEAD of the target worktree, a digest of its dirty state, and the
 * policy/worker versions in effect at dispatch time. The module never shells
 * out — callers capture these and pass them as strings.
 *
 * @param {object} inputs
 * @param {string} inputs.head          — git HEAD sha of the target worktree
 * @param {string} inputs.dirtyDigest   — digest of uncommitted state ('' or a stable hash)
 * @param {string} inputs.policyVersion — effective dispatch-policy version/hash
 * @param {string} inputs.workerVersion — worker implementation/config version
 * @returns {string} sha256 hex
 */
export function computeInputFingerprint({ head, dirtyDigest, policyVersion, workerVersion } = {}) {
  for (const [name, v] of [
    ['head', head],
    ['dirtyDigest', dirtyDigest],
    ['policyVersion', policyVersion],
    ['workerVersion', workerVersion],
  ]) {
    if (typeof v !== 'string') {
      throw new TypeError(`computeInputFingerprint: ${name} must be a string`);
    }
  }
  return canonicalHash({
    v: IDEMPOTENCY_VERSION,
    head,
    dirty_digest: dirtyDigest,
    policy_version: policyVersion,
    worker_version: workerVersion,
  });
}

// ---------------------------------------------------------------------------
// Handoff key composition — the blackboard work-item/result key
// ---------------------------------------------------------------------------

/**
 * Compose the FULL handoff key. This exact string is the blackboard
 * work-item/result key: it binds run, task, task spec, AND input fingerprint.
 * Omitting the fingerprint from the key is a correctness bug — a changed repo
 * or policy state must produce a different key so a stale result can never
 * be reused.
 *
 * @param {string|number} runId          — masterplan run/bundle id (slug)
 * @param {string|number} taskId         — stable bundle task id
 * @param {string} taskSpecHash          — from computeTaskSpecHash
 * @param {string} inputFingerprint      — from computeInputFingerprint
 * @returns {string} 'adsp-idem-v1:<run>:<task>:<spec_hash>:<fingerprint>'
 */
export function composeHandoffKey(runId, taskId, taskSpecHash, inputFingerprint) {
  if (runId == null || String(runId).length === 0) {
    throw new TypeError('composeHandoffKey: runId is required');
  }
  if (taskId == null || String(taskId).length === 0) {
    throw new TypeError('composeHandoffKey: taskId is required');
  }
  if (typeof taskSpecHash !== 'string' || !/^[0-9a-f]{64}$/.test(taskSpecHash)) {
    throw new TypeError('composeHandoffKey: taskSpecHash must be a sha256 hex string');
  }
  if (typeof inputFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(inputFingerprint)) {
    throw new TypeError('composeHandoffKey: inputFingerprint must be a sha256 hex string');
  }
  // run/task ids may contain arbitrary slug characters; encode ':' to keep the
  // key unambiguous under simple string splitting.
  const enc = (s) => String(s).replaceAll('%', '%25').replaceAll(':', '%3A');
  return `${IDEMPOTENCY_VERSION}:${enc(runId)}:${enc(taskId)}:${taskSpecHash}:${inputFingerprint}`;
}

// ---------------------------------------------------------------------------
// Reuse-vs-rerun predicate
// ---------------------------------------------------------------------------

/** Prior-result statuses that are eligible for reuse (no-op read). */
const REUSABLE_STATUSES = new Set(['done']);

/**
 * Decide whether a prior blackboard dispatch record's result may be reused
 * for the current dispatch, or the task must be re-run.
 *
 * Reuse requires ALL of:
 *   1. the prior record's FULL handoff key equals the current composed key
 *      (same run, task, task_spec_hash AND input fingerprint), and
 *   2. the prior result status is reusable (a completed 'done' result).
 *
 * A replanned task body (different task_spec_hash) or a changed repo/policy
 *  state (different input fingerprint) changes the composed key, so this
 * predicate can never resolve to reuse against a stale result. The prior
 * record is the frozen dispatch record (spec §5.5) — its key was computed at
 * original dispatch time and is compared verbatim, never recomputed.
 *
 * @param {object} args
 * @param {{ handoff_key: string, status: string }|null} args.priorRecord
 *        — frozen dispatch record read from the blackboard (null if none)
 * @param {string} args.currentKey — full key from composeHandoffKey for the
 *        current dispatch
 * @returns {{ reuse: boolean, reason: string }}
 */
export function decideReuse({ priorRecord, currentKey } = {}) {
  if (typeof currentKey !== 'string' || currentKey.length === 0) {
    throw new TypeError('decideReuse: currentKey is required');
  }
  if (priorRecord == null) {
    return { reuse: false, reason: 'no prior dispatch record' };
  }
  if (typeof priorRecord.handoff_key !== 'string') {
    return { reuse: false, reason: 'prior record has no handoff_key' };
  }
  if (priorRecord.handoff_key !== currentKey) {
    return { reuse: false, reason: 'handoff key mismatch (task spec or input fingerprint changed)' };
  }
  if (!REUSABLE_STATUSES.has(priorRecord.status)) {
    return { reuse: false, reason: `prior result status '${priorRecord.status}' is not reusable` };
  }
  return { reuse: true, reason: 'unchanged item against unchanged inputs — no-op read of prior result' };
}
