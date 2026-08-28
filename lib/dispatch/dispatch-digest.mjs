// lib/dispatch/dispatch-digest.mjs — work-item prep + worker-digest normalization.
//
// Transport-agnostic core of the masterplan↔fabric handoff seam:
//   Validation: isValidDispatchField, isValidDigest, extractDigestFromOutput
//   Work items: normalizeInputs, prepareDispatch, buildWorkItem,
//               buildFrozenDispatchRecord, frozenRecordFromPrep
//   Digests:    buildDispatchField, stampDigest, blockedDigest, failedDigest
//
// Execution is NOT here: waves launch through harness-native spawn descriptors
// (lib/dispatch-wave.mjs buildNativeSpawnPlan); results are recorded via
// `mp record-result`. This module stays pure — no child_process, no fs, no
// network. All environmental facts arrive as plain data on the task.

import {
  composeHandoffKey,
  computeTaskSpecHash,
  computeInputFingerprint,
} from '../fabric-idempotency.mjs';
import { CONTRACT_VERSION } from './verify-transport.mjs';

// ---------------------------------------------------------------------------
// Adapter-local defaults (dispatch surface)
// ---------------------------------------------------------------------------

/** Default task class when neither the task nor the caller specifies one. */
const DEFAULT_TASK_CLASS = 'bounded-edit';

// ---------------------------------------------------------------------------
// Digest extraction
// ---------------------------------------------------------------------------

/**
 * The required fields of the worker-digest return digest shape.
 * Used to validate a candidate digest extracted from child output.
 */
const DIGEST_REQUIRED_FIELDS = ['task_id', 'status', 'start_sha', 'files_changed', 'verify', 'summary'];
const VALID_STATUSES = new Set(['done', 'failed', 'blocked']);

/** Valid values of the optional `dispatch` provenance field on a digest. */
const VALID_DISPATCH_OUTCOMES = new Set(['worker', 'inline_designed', 'escalate', 'error']);

/**
 * Shape-check the OPTIONAL `dispatch` provenance field.
 * outcome must be one of VALID_DISPATCH_OUTCOMES, reason a string.
 *
 * @param {unknown} d
 * @returns {boolean}
 */
export function isValidDispatchField(d) {
  if (d == null || typeof d !== 'object' || Array.isArray(d)) return false;
  if (!VALID_DISPATCH_OUTCOMES.has(d.outcome)) return false;
  if (typeof d.reason !== 'string') return false;
  return true;
}

/**
 * Check whether a parsed object has the required shape of a worker-digest digest.
 *
 * The `dispatch` field is OPTIONAL — a digest without it (or with it null) is
 * valid; when present it must pass the shape check.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
function isValidDigest(obj) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  for (const f of DIGEST_REQUIRED_FIELDS) {
    if (!(f in obj)) return false;
  }
  if (!VALID_STATUSES.has(obj.status)) return false;
  if (!Array.isArray(obj.files_changed)) return false;
  if (!Array.isArray(obj.verify)) return false;
  if (obj.dispatch != null && !isValidDispatchField(obj.dispatch)) return false;
  return true;
}

/**
 * Extract a worker-digest return digest from a child's stdout output.
 *
 * Scans the text for JSON objects matching the digest shape, taking the last
 * one found (the worker's final output may be preceded by logging).
 *
 * @param {string} text  Raw child stdout text.
 * @returns {object|null}  Parsed digest or null if no valid digest found.
 */
export function extractDigestFromOutput(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  // Try the whole text as a single JSON object first (common case: clean output).
  try {
    const parsed = JSON.parse(text.trim());
    if (isValidDigest(parsed)) return parsed;
  } catch {
    // Fall through to line-by-line scan.
  }

  // Scan line-by-line for JSON objects that match the digest shape.
  let lastDigest = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isValidDigest(parsed)) lastDigest = parsed;
    } catch {
      // Skip non-JSON lines.
    }
  }

  return lastDigest;
}

// ---------------------------------------------------------------------------
// Work-item + handoff-key construction (pure — no I/O)
// ---------------------------------------------------------------------------
//
// prepareDispatch is the single source of truth for the work item and the
// handoff key. It is pure (no fs, no clock, no subprocess): all environmental
// facts (git HEAD, dirty-state digest, policy/worker version) are captured
// shell-side by the caller and passed in on the task. Determinism of the key
// is guaranteed by lib/fabric-idempotency.mjs's canonical JSON serialization.

/**
 * Normalize the input-fingerprint facts to four strings (defaults to empty).
 * The idempotency module requires all four to be strings; partial inputs are
 * filled with '' so a caller that only knows HEAD still gets a stable key.
 *
 * @param {{ head?: string, dirtyDigest?: string, policyVersion?: string, workerVersion?: string } | undefined} raw
 * @returns {{ head: string, dirtyDigest: string, policyVersion: string, workerVersion: string }}
 */
function normalizeInputs(raw) {
  const r = raw ?? {};
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    head:          str(r.head),
    dirtyDigest:   str(r.dirtyDigest),
    policyVersion: str(r.policyVersion),
    workerVersion: str(r.workerVersion),
  };
}

/**
 * Resolve all dispatch-time facts for a task: the work item (fabric descriptor),
 * the composed handoff key, and the key components. Pure.
 *
 * The task_spec_hash covers the logical task body (task_id, description, files,
 * verify_commands) plus the dispatch context and worker config (class). The
 * input fingerprint covers the worktree HEAD, dirty-state digest, and the
 * policy/worker versions in effect. Together they form the composed handoff
 * key — the result-substrate key for idempotent re-drive.
 *
 * If `run_id` is absent the key cannot be composed: the work item still
 * dispatches (degraded) but carries handoff_key=null and no idempotency
 * read/write happens for it.
 *
 * @param {object} task
 * @param {object} [options]
 * @returns {{
 *   descriptor: object, handoffKey: string|null, taskSpecHash: string|null,
 *   inputFingerprint: string|null, runId: string, taskId: number,
 *   taskClass: string, cwd: string, inputs: object, description: string,
 *   files: string[], verifyCommands: string[]
 * }}
 */
function prepareDispatch(task, options = {}) {
  const taskId = task.task_id;
  const description = task.description ?? '';
  const files = Array.isArray(task.files) ? task.files : [];
  const verifyCommands = Array.isArray(task.verify_commands) ? task.verify_commands : [];
  const cwd = task.cwd ?? process.cwd();
  const taskClass = task.class ?? options.class ?? DEFAULT_TASK_CLASS;
  const runId = task.run_id;
  const inputs = normalizeInputs(task.inputs);

  // Compose the handoff key from (run_id, task_id, task_spec_hash, input_fingerprint).
  // run_id is the gate: without it the seam degrades (no key, no idempotency).
  let handoffKey = null;
  let taskSpecHash = null;
  let inputFingerprint = null;
  if (runId != null && String(runId).length > 0) {
    // The task spec body — the logical task. cwd (the worktree PATH) is
    // deliberately excluded: a relocated worktree with the same HEAD+dirty
    // state is the same task. The worktree STATE is captured in the
    // input fingerprint, not the task spec.
    const body = {
      task_id:         taskId,
      description,
      files,
      verify_commands: verifyCommands,
    };
    const workerConfig = { class: taskClass, ...(task.worker_config ?? {}) };
    taskSpecHash = computeTaskSpecHash({
      body,
      context: task.context ?? null,
      workerConfig,
    });
    inputFingerprint = computeInputFingerprint(inputs);
    handoffKey = composeHandoffKey(runId, taskId, taskSpecHash, inputFingerprint);
  }

  // The fabric work item / native spawn descriptor body. Verify commands ride
  // RAW (strings): native children run them locally via runLocalVerifyCommands,
  // and the task-spec hash reads the same raw strings, so handoff keys are
  // stable.
  const descriptor = {
    class:            taskClass,
    repo:             cwd,            // the run's EXISTING worktree — never a second worktree
    brief:            description,
    task:             description,    // brief alias kept for descriptor consumers
    files,            // declared file scope (honor exactly)
    verify:           verifyCommands,
    contract_version: CONTRACT_VERSION,
    task_id:          taskId,         // the bundle's stable task id
    handoff_key:      handoffKey,     // composed idempotency key (result substrate key)
  };

  // Optional per-task adversary-review requirement (descriptor-only, additive):
  // carried so the dispatcher can see this item's output will be adversary-
  // reviewed. EXCLUDED from the task-spec hash, so toggling review never
  // changes handoff keys. Falsy means review OFF → the field is OMITTED.
  if (task.review) descriptor.review = task.review;

  // Optional implementer-backend discriminator (dormant seam —
  // docs/design/qctl-multi-repo-apply.md): absent and {kind:'agent'} are both
  // OMITTED so default descriptors stay byte-identical.
  if (task.backend != null && typeof task.backend === 'object'
      && task.backend.kind != null && task.backend.kind !== 'agent') {
    descriptor.backend = task.backend;
  }

  return {
    descriptor,
    handoffKey,
    taskSpecHash,
    inputFingerprint,
    runId,
    taskId,
    taskClass,
    cwd,
    inputs,
    description,
    files,
    verifyCommands,
  };
}

/**
 * Build the fabric work item (descriptor) for a task WITHOUT dispatching.
 *
 * Pure: no I/O. Exported so callers and tests can inspect the exact work item
 * a wave would hand to the harness — including the composed handoff_key.
 *
 * @param {object} task
 * @param {object} [options]
 * @returns {object} the work item / descriptor
 */
export function buildWorkItem(task, options = {}) {
  return prepareDispatch(task, options).descriptor;
}

/**
 * Build the frozen dispatch record for a task WITHOUT dispatching.
 *
 * ALL inputs to the idempotency key are persisted in a dispatch record at
 * dispatch time. Resume/duplicate-detection read the original record's key —
 * they never recompute it from current state, so a policy/catalog/config
 * change while work is in flight cannot orphan a completed result or trigger
 * a spurious rerun.
 *
 * Pure: no I/O. The record's `dispatched_at`/`status` placeholders are set by
 * the dispatcher at actual dispatch time.
 *
 * @param {object} task
 * @param {object} [options]
 * @returns {object} the frozen dispatch record (key inputs + status skeleton)
 */
export function buildFrozenDispatchRecord(task, options = {}) {
  const prep = prepareDispatch(task, options);
  return frozenRecordFromPrep(prep, { dispatched_at: null, status: 'pending' });
}

/**
 * Assemble the frozen dispatch record from a prepared dispatch.
 *
 * @param {object} prep   — from prepareDispatch
 * @param {{ dispatched_at?: string, status?: string }} [stamp]
 * @returns {object}
 */
function frozenRecordFromPrep(prep, stamp = {}) {
  return {
    handoff_key:      prep.handoffKey,
    run_id:           prep.runId,
    task_id:          prep.taskId,
    task_class:       prep.taskClass,
    task_spec_hash:   prep.taskSpecHash,
    input_fingerprint: prep.inputFingerprint,
    contract_version: CONTRACT_VERSION,
    status:           stamp.status ?? 'pending',
    dispatched_at:    stamp.dispatched_at ?? null,
    // The frozen key inputs (env facts captured at dispatch time — never recomputed).
    head:             prep.inputs.head,
    dirty_digest:     prep.inputs.dirtyDigest,
    policy_version:   prep.inputs.policyVersion,
    worker_version:   prep.inputs.workerVersion,
  };
}

// ---------------------------------------------------------------------------
// Digest normalization (the EXACT worker-digest return shape)
// ---------------------------------------------------------------------------

/**
 * Build the OPTIONAL `dispatch` provenance field for a digest.
 *
 * @param {string} outcome — one of VALID_DISPATCH_OUTCOMES
 * @param {string} [reason]
 * @returns {{ outcome: string, reason: string }}
 */
function buildDispatchField(outcome, reason) {
  return { outcome, reason: String(reason ?? '') };
}

/**
 * Normalize a worker digest into the exact worker-digest return shape and
 * stamp task_id from the canonical input (the worker's task_id is never
 * trusted). The ONLY field beyond the base worker-digest shape is the
 * optional `dispatch` provenance field: attached when the caller supplies
 * one, else preserved from the source digest when it already carries a valid
 * one, else omitted.
 *
 * @param {object} digest
 * @param {number} taskId
 * @param {object} [dispatch]  — dispatch provenance to attach
 * @returns {object}
 */
function stampDigest(digest, taskId, dispatch = undefined) {
  const out = {
    task_id:       taskId,
    status:        digest.status,
    start_sha:     String(digest.start_sha ?? ''),
    files_changed: Array.isArray(digest.files_changed) ? digest.files_changed : [],
    verify:        Array.isArray(digest.verify) ? digest.verify : [],
    summary:       String(digest.summary ?? ''),
    blockers:      digest.blockers ?? null,
  };
  const prov = dispatch ?? (isValidDispatchField(digest.dispatch) ? digest.dispatch : undefined);
  if (prov !== undefined) out.dispatch = prov;
  return out;
}

/** Build a 'blocked' digest (escalate / execution error / execute_yourself). */
function blockedDigest(taskId, summary, blockers, dispatch = undefined) {
  const out = {
    task_id:       taskId,
    status:        'blocked',
    start_sha:     '',
    files_changed: [],
    verify:        [],
    summary,
    blockers,
  };
  if (dispatch !== undefined) out.dispatch = dispatch;
  return out;
}

/** Build a 'failed' digest (no parseable worker digest). */
function failedDigest(taskId, summary, blockers) {
  return {
    task_id:       taskId,
    status:        'failed',
    start_sha:     '',
    files_changed: [],
    verify:        [],
    summary,
    blockers,
  };
}

export {
  buildDispatchField,
  stampDigest,
  blockedDigest,
  failedDigest,
  DIGEST_REQUIRED_FIELDS,
  VALID_STATUSES,
  VALID_DISPATCH_OUTCOMES,
};
