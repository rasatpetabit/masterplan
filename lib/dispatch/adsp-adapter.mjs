// lib/dispatch/adsp-adapter.mjs — masterplan's SOLE delegation seam (adsp-v1 contract, spec §5.5).
//
// STATUS (adsp-v1): the formal seam between masterplan's L1 record-result
// transaction and the agent-dispatch fabric. dispatchTask is the single
// delegation surface: it builds a fabric work item carrying the bundle's stable
// task_id, the composed handoff-idempotency key, declared file scope, verify
// commands, the run's existing worktree cwd (NEVER a second worktree), and
// contract_version; translates returned digests back into the EXACT
// mp-implementer digest shape so L1's record-result/reconcile stays untouched;
// and consumes the blackboard result store (a sibling subsystem) as the keyed
// result substrate — reading/writing results by handoff key.
//
// The handoff-idempotency key is composed from lib/adsp-idempotency.mjs
// (mp-seam.idempotency-key): (run_id, task_id, task_spec_hash, input_fingerprint).
// The seam is at-least-once with idempotent recording: a re-dispatch of an
// unchanged item against unchanged inputs is a no-op read of the prior
// blackboard result (the broker is never called); a replanned task body or a
// changed repo/policy fingerprint produces a different key, so a stale result
// can never be reused. All key inputs are frozen in a dispatch record written
// to the blackboard at dispatch time; resume/duplicate-detection compare
// against that frozen record's key, never recomputing from current state.
//
// Contract version: adsp-v1.1 (pinned; carried on every request/response for
// auditability). The version is the seam that allows protocol evolution without
// silent breakage. v1.1 adds ONE optional namespaced digest field —
// `dispatch: { outcome, reason, degraded_fallback?, decision_id? }` — carrying
// dispatch provenance so L1 can distinguish designed Claude-tier inline routing
// (outcome:'inline_designed') from a broker outage (outcome:'broker_error') and
// a broker escalation (outcome:'escalate'). v1 digests (no dispatch field)
// remain valid; the field is additive and optional.
//
// Seam surface (the only agent-dispatch meeting points for masterplan)
// -------------------------------------------------------------------
//   dispatchTask(task, options)               — sole delegation surface (async → Digest)
//   buildWorkItem(task, options)              — pure work-item constructor (no I/O)
//   buildFrozenDispatchRecord(task, options)  — pure frozen-record constructor (no I/O)
//   escalateCrossReview(...)                  — cross-review escalation bridge (spec §6.8)
//   revertCrossReview(...)                    — cross-review revert bridge (spec §6.8)
//
// Degraded / escalate mapping (design decision — spec §5.5 "at-least-once")
// -------------------------------------------------------------------------
//   broker execute_yourself (Claude-tier)  → status:'blocked' ("route inline") — L1 shell dispatches inline;
//                                            dispatch.outcome:'inline_designed' (degraded_fallback passed through when present)
//   broker escalate (no route/budget_breach/guard_deny) → status:'blocked' (reason carried); dispatch.outcome:'escalate'
//   broker client error (spawn/network)    → status:'blocked'; dispatch.outcome:'broker_error'
//   successful worker dispatch             → dispatch.outcome:'worker' (decision_id/degraded_fallback passed through)
//   every blocked digest                   → persisted to the blackboard best-effort BEFORE returning (audit, never
//                                            reuse — REUSABLE_STATUSES is done-only; a persistence failure is swallowed)
//   no parseable digest in worker output    → status:'failed'
//   no run_id on the task                   → degraded: handoff_key=null, no idempotency read/write (still dispatches)
//   no _resultStore injected                → degraded: no blackboard read/write (key still composed & carried)
//   blackboard read/write error            → non-fatal: proceeds to dispatch / still returns the digest
//
// In/out contract
// ---------------
// Input (dispatchTask):
//   task:
//     task_id:          number          — the bundle's stable task id
//     description:      string          — task brief (human-readable)
//     files:            string[]        — declared file scope (honor exactly)
//     verify_commands:  string[]        — commands to run and report output for
//     cwd:              string          — the run's existing worktree path (never a second worktree);
//                                         defaults to process.cwd() when omitted
//     class?:           string          — task class; defaults to 'bounded-edit'
//     run_id?:          string          — bundle/run slug; required to compose the handoff key
//     inputs?:          { head, dirtyDigest, policyVersion, workerVersion } — environmental facts
//                                         for the input fingerprint (captured shell-side by the caller)
//     context?:         object          — dispatch-time context (task_spec_hash input)
//     worker_config?:   object          — worker config (task_spec_hash input)
//   options:
//     _brokerClient?:   object          — injectable MCP client for tests
//     _resultStore?:    object          — injectable blackboard result store (readResult/writeResult/
//                                         readDispatchRecord/writeDispatchRecord, keyed by handoff key)
//     brokerBin?:       string          — override path to agent-dispatch binary
//     class?:           string          — class override (lower precedence than task.class)
//
// Output (dispatchTask returns a Promise<Digest>):
//   {
//     task_id:       number,
//     status:        'done' | 'failed' | 'blocked',
//     start_sha:     string,
//     files_changed: string[],
//     verify:        Array<{ command: string, passed: boolean, output: string }>,
//     summary:       string,
//     blockers:      string | null,
//     dispatch?:     {                                    // OPTIONAL (adsp-v1.1) dispatch provenance
//       outcome:            'worker' | 'inline_designed' | 'escalate' | 'broker_error',
//       reason:             string,
//       degraded_fallback?: object,   // broker passthrough: {skipped:[{backend,cause}]} (absent on older brokers)
//       decision_id?:       string    // broker passthrough (absent on older brokers)
//     }
//   }
// The base shape matches EXACTLY what mp-implementer returns today so
// masterplan's D6 scope checking and record protocol stay untouched; the ONLY
// addition is the optional adsp-v1.1 `dispatch` provenance field, which
// record-result consumes for degradation-visibility events and otherwise
// ignores.
//
// No imports from the platform repo: the adapter is standalone (spawns the
// broker via its CLI/stdio surface using the injectable seam, never imports
// from /srv/dev/ai/agent-dispatch). The MCP wire protocol is the seam; the
// blackboard result store is consumed via an injectable interface (a sibling
// subsystem supplies the live implementation).

import { spawn } from 'node:child_process';
import { resolveMasterplanBin } from '../paths.mjs';
import {
  composeHandoffKey,
  computeTaskSpecHash,
  computeInputFingerprint,
  decideReuse,
} from '../adsp-idempotency.mjs';

// ---------------------------------------------------------------------------
// Contract version (pinned; both sides must agree)
// ---------------------------------------------------------------------------

/** Pinned contract version for this adapter. */
export const CONTRACT_VERSION = 'adsp-v1.1';

/** Default task class when neither the task nor the caller specifies one. */
const DEFAULT_TASK_CLASS = 'bounded-edit';

/** Default agent-dispatch binary name (resolved via PATH). */
const DEFAULT_BROKER_BIN = 'agent-dispatch';

// ---------------------------------------------------------------------------
// MCP stdio client (broker wire protocol)
// ---------------------------------------------------------------------------

/**
 * Create a minimal MCP stdio client that speaks newline-delimited JSON-RPC.
 *
 * Spawns `agent-dispatch serve-mcp` (or the injected binary) and manages the
 * request/response lifecycle. Caller is responsible for calling client.close()
 * when done (the broker process is killed).
 *
 * This is the only I/O seam the adapter uses — injectable for tests via
 * `options._brokerClient` so no real broker process is spawned in unit tests.
 *
 * @param {{ bin?: string }} [opts]
 * @returns {{ callTool: Function, initialize: Function, close: Function }}
 */
export function createBrokerClient(opts = {}) {
  const bin = opts.bin ?? DEFAULT_BROKER_BIN;
  const child = spawn(bin, ['serve-mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  let buffer = '';
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (msg.id == null) continue;
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(new Error(msg.error.message ?? 'broker error'));
      } else {
        waiter.resolve(msg.result);
      }
    }
  });

  child.on('error', (err) => {
    for (const w of pending.values()) w.reject(err);
    pending.clear();
  });

  child.on('close', (code, signal) => {
    if (pending.size === 0) return;
    const err = new Error(`broker process exited: code=${code} signal=${signal}`);
    for (const w of pending.values()) w.reject(err);
    pending.clear();
  });

  function request(method, params) {
    const id = nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    child.stdin.write(frame);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  return {
    /** Send the MCP initialize handshake (required before any tool/method calls). */
    async initialize() {
      const result = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'adsp-adapter', version: CONTRACT_VERSION },
      });
      notify('notifications/initialized', {});
      return result;
    },

    /**
     * Call a broker tool by name.
     * @param {string} name   Tool name (e.g. 'dispatch_task').
     * @param {object} args   Tool arguments object.
     * @returns {Promise<object>}
     */
    async callTool(name, args) {
      const result = await request('tools/call', { name, arguments: args });
      // MCP tools/call returns { content: [{type:'text', text: ...}] }
      if (Array.isArray(result?.content)) {
        const text = result.content.map((c) => c.text ?? '').join('');
        try {
          return JSON.parse(text);
        } catch {
          return { _raw: text };
        }
      }
      return result;
    },

    /** Kill the broker process and clean up pending requests. */
    close() {
      child.kill();
    },
  };
}

// ---------------------------------------------------------------------------
// Digest extraction
// ---------------------------------------------------------------------------

/**
 * The required fields of the mp-implementer return digest shape.
 * Used to validate a candidate digest extracted from broker output.
 */
const DIGEST_REQUIRED_FIELDS = ['task_id', 'status', 'start_sha', 'files_changed', 'verify', 'summary'];
const VALID_STATUSES = new Set(['done', 'failed', 'blocked']);

/** Valid values for the optional adsp-v1.1 dispatch.outcome provenance field. */
const VALID_DISPATCH_OUTCOMES = new Set(['worker', 'inline_designed', 'escalate', 'broker_error']);

/**
 * Shape-check the OPTIONAL adsp-v1.1 `dispatch` provenance field.
 * outcome must be one of VALID_DISPATCH_OUTCOMES, reason a string;
 * decision_id (when present) must be a string; degraded_fallback is an
 * opaque broker passthrough (no shape imposed beyond "not a primitive lie" —
 * it is carried verbatim for audit).
 *
 * @param {unknown} d
 * @returns {boolean}
 */
export function isValidDispatchField(d) {
  if (d == null || typeof d !== 'object' || Array.isArray(d)) return false;
  if (!VALID_DISPATCH_OUTCOMES.has(d.outcome)) return false;
  if (typeof d.reason !== 'string') return false;
  if (d.decision_id != null && typeof d.decision_id !== 'string') return false;
  return true;
}

/**
 * Check whether a parsed object has the required shape of an mp-implementer digest.
 *
 * Back-compat: the adsp-v1.1 `dispatch` field is OPTIONAL — a v1 digest without
 * it (or with it null) is valid; when present it must pass the shape check.
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
  // Optional adsp-v1.1 dispatch provenance: absent/null is fine (v1 back-compat);
  // present-but-malformed is rejected.
  if (obj.dispatch != null && !isValidDispatchField(obj.dispatch)) return false;
  return true;
}

/**
 * Extract an mp-implementer return digest from the broker's stdout output.
 *
 * Scans the text for JSON objects matching the digest shape, taking the last
 * one found (the worker's final output may be preceded by logging).
 *
 * @param {string} text  Raw broker stdout text.
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
// is guaranteed by lib/adsp-idempotency.mjs's canonical JSON serialization.

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
 * key — the blackboard work-item/result key.
 *
 * If `run_id` is absent the key cannot be composed: the work item still
 * dispatches (degraded) but carries handoff_key=null and the adapter performs
 * no idempotency read/write.
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

  // The fabric work item. This is the exact object handed to the broker's
  // dispatch_task tool; it carries every field the spec §5.5 seam requires.
  const descriptor = {
    class:            taskClass,
    repo:             cwd,            // the run's EXISTING worktree — never a second worktree
    brief:            description,
    files,            // declared file scope (honor exactly)
    verify:           verifyCommands, // verify commands to run and report
    contract_version: CONTRACT_VERSION,
    task_id:          taskId,         // the bundle's stable task id
    handoff_key:      handoffKey,     // composed idempotency key (blackboard result substrate key)
  };

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
 * Pure: no broker, no blackboard, no clock. Exported so callers and tests can
 * inspect the exact work item that dispatchTask would send — including the
 * composed handoff_key — without any I/O.
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
 * Per spec §5.5: ALL inputs to the idempotency key are persisted in a dispatch
 * record on the blackboard at dispatch time. Resume/duplicate-detection read
 * the original record's key — they never recompute it from current state, so a
 * policy/catalog/config change while work is in flight cannot orphan a
 * completed result or trigger a spurious rerun.
 *
 * Pure: no I/O. The record's `dispatched_at`/`status` placeholders are set by
 * dispatchTask at actual dispatch time (the live write carries the real
 * timestamp and status='pending'); this constructor returns the frozen key
 * inputs with a stable, null-timestamp skeleton.
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
// Digest normalization (the EXACT mp-implementer return shape)
// ---------------------------------------------------------------------------

/**
 * Build the OPTIONAL adsp-v1.1 `dispatch` provenance field for a digest.
 *
 * decision_id and degraded_fallback are broker passthroughs (chunk A1 adds
 * them broker-side); both may be absent on older brokers — coded defensively,
 * omitted when not present so a v1-era broker still yields a clean field.
 *
 * @param {'worker'|'inline_designed'|'escalate'|'broker_error'} outcome
 * @param {string} reason
 * @param {object|null} [brokerResult]  — the broker's dispatch_task response (may be null)
 * @returns {{ outcome: string, reason: string, degraded_fallback?: object, decision_id?: string }}
 */
function buildDispatchField(outcome, reason, brokerResult = null) {
  const field = { outcome, reason: String(reason ?? '') };
  if (typeof brokerResult?.decision_id === 'string' && brokerResult.decision_id.length > 0) {
    field.decision_id = brokerResult.decision_id;
  }
  if (brokerResult?.degraded_fallback != null) {
    field.degraded_fallback = brokerResult.degraded_fallback;
  }
  return field;
}

/**
 * Normalize a worker digest into the exact mp-implementer return shape and
 * stamp task_id from the canonical input (the worker's task_id is never
 * trusted). The ONLY field beyond the base mp-implementer shape is the
 * optional adsp-v1.1 `dispatch` provenance field: attached when the caller
 * supplies one, else preserved from the source digest when it already carries
 * a valid one (the blackboard reuse path), else omitted (v1 back-compat).
 *
 * @param {object} digest
 * @param {number} taskId
 * @param {object} [dispatch]  — adsp-v1.1 dispatch provenance to attach
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

/** Build a 'blocked' digest (broker escalate / error / execute_yourself). */
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

/**
 * Best-effort persist a blocked digest to the blackboard result store BEFORE
 * returning it, so the frozen dispatch record is not stranded at 'pending'
 * with no result to audit. NEVER throws — a persistence failure is swallowed
 * (the digest is still returned to L1). This write is for AUDIT, not reuse:
 * decideReuse's REUSABLE_STATUSES (lib/adsp-idempotency.mjs) is done-only, so
 * a persisted 'blocked' result can never be wrongly replayed as a prior result.
 *
 * @param {object|null} resultStore
 * @param {string|null} handoffKey
 * @param {object} digest  — a status:'blocked' digest
 * @returns {Promise<void>}
 */
async function persistBlockedResult(resultStore, handoffKey, digest) {
  if (resultStore == null || handoffKey == null) return;
  try {
    await resultStore.writeResult(handoffKey, {
      handoff_key:      handoffKey,
      status:           digest.status,
      digest,
      completed_at:     new Date().toISOString(),
      contract_version: CONTRACT_VERSION,
    });
  } catch {
    // Best-effort audit write — never throw from the persistence attempt.
  }
}

// ---------------------------------------------------------------------------
// Main dispatch surface
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TaskInput
 * @property {number}   task_id          — the bundle's stable task id
 * @property {string}   description      — human-readable task brief
 * @property {string[]} files            — declared file scope (honor exactly)
 * @property {string[]} verify_commands  — verify commands to run
 * @property {string}   [cwd]            — the run's existing worktree path (never a second worktree)
 * @property {string}   [class]          — task class (overrides default)
 * @property {string}   [run_id]         — bundle/run slug (required to compose the handoff key)
 * @property {{ head?: string, dirtyDigest?: string, policyVersion?: string, workerVersion?: string }} [inputs]
 *                                         — environmental facts for the input fingerprint
 * @property {object}   [context]        — dispatch-time context (task_spec_hash input)
 * @property {object}   [worker_config]  — worker config (task_spec_hash input)
 */

/**
 * @typedef {Object} DispatchOptions
 * @property {object}  [_brokerClient]   — injectable MCP client (for tests)
 * @property {object}  [_resultStore]    — injectable blackboard result store (keyed by handoff key)
 * @property {string}  [brokerBin]       — override agent-dispatch binary path
 * @property {string}  [class]           — task class override (lower precedence than task.class)
 */

/**
 * @typedef {Object} Digest
 * @property {number}   task_id
 * @property {'done'|'failed'|'blocked'} status
 * @property {string}   start_sha
 * @property {string[]} files_changed
 * @property {Array<{command: string, passed: boolean, output: string}>} verify
 * @property {string}   summary
 * @property {string|null} blockers
 * @property {{ outcome: 'worker'|'inline_designed'|'escalate'|'broker_error',
 *              reason: string, degraded_fallback?: object, decision_id?: string }} [dispatch]
 *           — OPTIONAL adsp-v1.1 dispatch provenance (absent on v1 digests)
 */

/**
 * Dispatch a masterplan implementer task through the agent-dispatch fabric.
 *
 * This is masterplan's SOLE delegation seam (adsp-v1). It:
 *  1. Composes the handoff-idempotency key from (run_id, task_id,
 *     task_spec_hash, input_fingerprint) via lib/adsp-idempotency.mjs.
 *  2. If a blackboard result store is injected, reads the prior result keyed by
 *     the handoff key; a reusable 'done' result is returned as a no-op read
 *     (the broker is NEVER called) — at-least-once with idempotent recording.
 *  3. Writes the frozen dispatch record to the blackboard at dispatch time
 *     (status='pending') so resume/duplicate-detection read the original key.
 *  4. Sends `dispatch_task` to the broker with the work item (task_id,
 *     handoff_key, files, verify, the run's existing cwd, contract_version).
 *     Masterplan owns the worktree — the adapter NEVER creates a second one.
 *  5. Extracts the return digest from the worker's final output and writes it
 *     to the blackboard keyed by the handoff key (the result substrate).
 *  6. Returns the digest in the EXACT mp-implementer shape (record-result stays
 *     untouched).
 *
 * Degraded/escalate mapping (see module header): execute_yourself, broker
 * escalate, and broker errors all return status:'blocked' so the L1 shell can
 * route inline or surface the reason; an unparseable digest returns
 * 'failed'. A missing run_id or result store degrades the idempotency
 * bookkeeping but never blocks dispatch.
 *
 * @param {TaskInput}       task     — masterplan task descriptor
 * @param {DispatchOptions} [options]
 * @returns {Promise<Digest>}
 */
export async function dispatchTask(task, options = {}) {
  const prep = prepareDispatch(task, options);
  const { descriptor, handoffKey, taskId } = prep;
  const resultStore = options._resultStore ?? null;

  // 1. Idempotency read: a re-dispatch of an unchanged item against unchanged
  //    inputs is a no-op read of the prior blackboard result. The broker is
  //    never called on the reuse path.
  if (resultStore != null && handoffKey != null) {
    let priorResult = null;
    try {
      priorResult = await resultStore.readResult(handoffKey);
    } catch {
      // A blackboard read error is non-fatal — fall through to a fresh dispatch.
      priorResult = null;
    }
    if (priorResult != null) {
      const { reuse } = decideReuse({ priorRecord: priorResult, currentKey: handoffKey });
      if (reuse) {
        // Return the prior digest in the exact mp-implementer shape, task_id
        // stamped from the canonical input. record-result treats this identically
        // to a fresh dispatch — the idempotency is transparent to L1.
        return stampDigest(priorResult.digest ?? priorResult, taskId);
      }
    }
  }

  // 2. Obtain a broker client — use the injected test double or spawn a real one.
  const usingInjected = options._brokerClient != null;
  const client = usingInjected ? options._brokerClient : createBrokerClient({ bin: options.brokerBin });

  // 3. Write the frozen dispatch record at dispatch time (status='pending').
  //    Resume/duplicate-detection read THIS record's key, never recomputing it.
  if (resultStore != null && handoffKey != null) {
    const frozenRecord = frozenRecordFromPrep(prep, {
      status: 'pending',
      dispatched_at: new Date().toISOString(),
    });
    try {
      await resultStore.writeDispatchRecord(handoffKey, frozenRecord);
    } catch {
      // Non-fatal: proceed to dispatch even if the blackboard write failed.
    }
  }

  // 4. Dispatch via the broker.
  let brokerResult;
  try {
    if (!usingInjected) {
      await client.initialize();
    }
    brokerResult = await client.callTool('dispatch_task', { descriptor });
  } catch (err) {
    // Broker client/spawn error — dispatch.outcome:'broker_error' distinguishes
    // an OUTAGE from designed inline routing. Persisted best-effort for audit.
    const digest = blockedDigest(
      taskId,
      `broker error during dispatch_task: ${err.message}`,
      err.message,
      buildDispatchField('broker_error', err.message),
    );
    await persistBlockedResult(resultStore, handoffKey, digest);
    return digest;
  } finally {
    if (!usingInjected) {
      client.close();
    }
  }

  // 5. execute_yourself FIRST (highest precedence): Claude-tier routing — the
  //    L1 shell dispatches inline. Return 'blocked' so L1 routes inline.
  //    dispatch.outcome:'inline_designed' marks this as DESIGNED routing — but
  //    if the broker reached the decision by skipping health-pruned chain steps
  //    it carries degraded_fallback through, so L1 can still see the degradation.
  if (brokerResult?.execute_yourself === true) {
    const digest = blockedDigest(
      taskId,
      'broker returned execute_yourself — task requires Claude-tier routing; use inline dispatch',
      'execute_yourself: Claude-tier route; route inline',
      buildDispatchField('inline_designed', 'execute_yourself: Claude-tier route', brokerResult),
    );
    await persistBlockedResult(resultStore, handoffKey, digest);
    return digest;
  }

  // 6. Broker returned a non-route decision (escalate, budget_breach, guard_deny,
  //    null, empty, …) — surface as 'blocked' so L1 can act on the reason.
  //    dispatch.outcome:'escalate' carries the broker's reason verbatim.
  if (!brokerResult || brokerResult.decision?.decision !== 'route') {
    const reason = brokerResult?.decision?.reason ?? brokerResult?.reason ?? 'broker did not return a route decision';
    const digest = blockedDigest(
      taskId,
      `broker escalated: ${reason}`,
      reason,
      buildDispatchField('escalate', reason, brokerResult),
    );
    await persistBlockedResult(resultStore, handoffKey, digest);
    return digest;
  }

  // 7. Extract the worker's return digest from stdout.
  const rawOutput = brokerResult?.stdout ?? brokerResult?.final_message ?? '';
  const digest = extractDigestFromOutput(rawOutput);

  if (digest === null) {
    // Worker output is present but contains no valid digest — treat as failed.
    return failedDigest(
      taskId,
      'worker completed but returned no parseable digest',
      `raw output (first 200 chars): ${String(rawOutput).slice(0, 200)}`,
    );
  }

  // 8. Translate to the exact mp-implementer shape (task_id from canonical input),
  //    stamping dispatch.outcome:'worker' provenance. degraded_fallback/decision_id
  //    pass through from the broker response when present (absent on older brokers) —
  //    a worker dispatch that skipped health-pruned chain steps stays visible.
  const backend = brokerResult?.decision?.backend;
  const result = stampDigest(digest, taskId, buildDispatchField(
    'worker',
    backend ? `routed to backend '${backend}'` : 'routed to worker backend',
    brokerResult,
  ));

  // 9. Write the result to the blackboard keyed by the handoff key (the result
  //    substrate). A crash between this write and the L1 commit is recovered
  //    by the resume path re-reading THIS result — never by re-running the task.
  if (resultStore != null && handoffKey != null) {
    try {
      await resultStore.writeResult(handoffKey, {
        handoff_key:      handoffKey,
        status:           result.status,
        digest:           result,
        completed_at:     new Date().toISOString(),
        contract_version: CONTRACT_VERSION,
      });
    } catch {
      // Non-fatal: the digest is still returned to L1 for record-result.
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// v3 cross-review escalation bridge (spec §6.8)
// ---------------------------------------------------------------------------
// The agent-dispatch runCrossReview engine emits `escalate` payloads via its
// escalate() seam. The adapter translates those into the masterplan durable-gate
// machinery (the same mp open-gate used by the finalization flow). This is the
// ONLY place agent-dispatch meets masterplan for the cross-review path; the
// engine itself stays masterplan-agnostic.

/**
 * @typedef {Object} CrossReviewEscalation
 * @property {'requires_human_decision'} kind
 * @property {string} reason
 * @property {object} review_record
 * @property {Array<object>} [suggestions]
 */

/**
 * Translate a cross-review `requires_human_decision` escalation into a durable
 * masterplan gate via `mp open-gate`. Returns the gate id (mp's `{id, gate_id}`).
 *
 * @param {string} statePath      — path to the masterplan bundle state.yml
 * @param {string} slug           — masterplan bundle slug
 * @param {CrossReviewEscalation} payload
 * @param {object} [opts]
 * @param {string} [opts.masterplanBin] — override path to masterplan.mjs
 * @returns {Promise<{ok: boolean, gate_id?: string, degraded?: boolean, reason?: string}>}
 */
export async function escalateCrossReview(statePath, slug, payload, opts = {}) {
  if (!payload || payload.kind !== 'requires_human_decision') {
    return { ok: false, degraded: true, reason: 'not a requires_human_decision payload' };
  }
  // Resolve masterplan.mjs path. Precedence: caller override > $MP_BIN > $MP_MARKETPLACE_DIR
  // > the marketplace install under <claudeConfigDir>/plugins/marketplaces/rasatpetabit-masterplan.
  // Portable across accounts (resolveMasterplanBin uses os.homedir()/resolveConfigDir — never a
  // hardcoded /home/<user> path); spawn() surfaces ENOENT loudly if the install is absent.
  const bin = opts.masterplanBin ?? resolveMasterplanBin();
  return new Promise((resolve) => {
    const child = spawn('node', [bin, 'open-gate',
      '--state', statePath,
      '--id', `${slug}-cross-review`,
      '--reason', payload.reason || 'requires_human_decision',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, degraded: true, reason: `spawn failed: ${e.message}` }));
    child.on('close', (code) => {
      if (code === 0) {
        try {
          const j = JSON.parse(out);
          resolve({ ok: true, gate_id: j.gate_id || j.id || `${slug}-cross-review` });
        } catch {
          resolve({ ok: true, gate_id: `${slug}-cross-review` });
        }
      } else {
        resolve({ ok: false, degraded: true, reason: `mp open-gate exit ${code}: ${err.slice(0, 200)}` });
      }
    });
  });
}

/**
 * Translate a cross-review `revert` request into the worktree D6 verify-scope
 * revert. Masterplan owns the worktree baseline; this is a thin wrapper that
 * shells out to the masterplan worktree-revert command (or, in a degraded
 * path, returns the scope for the caller to act on).
 *
 * @param {string} wtPath
 * @param {object} scope
 * @returns {Promise<{ok: boolean, degraded?: boolean, reason?: string}>}
 */
export async function revertCrossReview(wtPath, scope) {
  // The masterplan worktree-revert command accepts a scope and reverts the
  // changes recorded by the D6 baseline. For now this is a stub that the
  // masterplan finalization flow can replace; the seam contract is the
  // stable boundary.
  if (typeof wtPath !== 'string' || wtPath.length === 0) {
    return { ok: false, degraded: true, reason: 'wtPath required' };
  }
  return { ok: true, scope, note: 'revertCrossReview: masterplan owns the worktree baseline; the adapter signals the request and masterplan finalization performs the revert.' };
}
