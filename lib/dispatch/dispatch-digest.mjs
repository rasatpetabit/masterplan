// lib/dispatch/dispatch-digest.mjs — work-item prep for the native fabric seam.
//
// Transport-agnostic core of the masterplan↔fabric handoff seam:
//   Work items: normalizeInputs, prepareDispatch, buildWorkItem
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
  // RAW (strings) so the task-spec hash reads the same raw strings, keeping
  // handoff keys stable across verify-command re-execution.
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
