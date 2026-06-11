// lib/dispatch/adsp-adapter.mjs — thin masterplan→broker dispatch adapter (spec §9).
//
// Routes wave implementer tasks through the agent-dispatch broker's dispatch_task
// MCP surface. Masterplan owns worktree creation; the adapter NEVER creates a second
// worktree when cwd is supplied (spec §9: "Pi workers reusing the run's existing
// worktree"). This is pure wiring — no domain logic, no state machine changes.
//
// Contract version: adsp-v1 (pinned here; carried on every request/response for
// auditability). The version number is the seam that allows protocol evolution
// without silent breakage — a future v2 will be flagged explicitly.
//
// In/out contract
// ---------------
// Input (dispatchTask):
//   task:
//     task_id:          number          — masterplan task id
//     description:      string          — task brief (human-readable)
//     files:            string[]        — declared file scope (honor exactly)
//     verify_commands:  string[]        — commands to run and report output for
//     cwd:              string          — worktree path; if omitted, defaults to process.cwd()
//     class?:           string          — task class; defaults to 'bounded-edit'
//   options:
//     _brokerClient?:   object          — injectable MCP client for tests (see createBrokerClient)
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
//     blockers:      string | null
//   }
//
// The shape matches exactly what mp-implementer returns today so masterplan's
// D6 scope checking, record protocol, and the L1 shell stay untouched.
//
// Wiring invariants
// -----------------
// 1. adsp-v1 is the only version this module produces. When the broker returns
//    execute_yourself (Claude-tier task), the adapter returns status:'blocked'
//    with a reason that allows the L1 shell to route inline instead.
// 2. Digest extraction: the broker's dispatch_task returns worker output in
//    stdout (the Paseo agent's final message). The adapter extracts the last
//    JSON object that matches the return-digest shape. If no valid JSON digest
//    is found in the output, the adapter returns status:'failed'.
// 3. Degraded broker: if the broker itself escalates (no route, budget breach,
//    guard deny), the adapter returns status:'blocked' carrying the escalation
//    reason so the L1 shell can surface it.
// 4. No imports from the platform repo: the adapter is standalone (spawns the
//    broker via its CLI/stdio surface using the injectable seam, never imports
//    from /srv/dev/ai/agentic-dispatch). This keeps the masterplan repo free
//    of a hard dep on the platform internals; the MCP wire protocol is the seam.

import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Contract version (pinned; both sides must agree)
// ---------------------------------------------------------------------------

/** Pinned contract version for this adapter. */
export const CONTRACT_VERSION = 'adsp-v1';

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

/**
 * Check whether a parsed object has the required shape of an mp-implementer digest.
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
// Main dispatch surface
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TaskInput
 * @property {number}   task_id          — masterplan task id
 * @property {string}   description      — human-readable task brief
 * @property {string[]} files            — declared file scope (honor exactly)
 * @property {string[]} verify_commands  — verify commands to run
 * @property {string}   [cwd]            — worktree working directory
 * @property {string}   [class]          — task class (overrides default)
 */

/**
 * @typedef {Object} DispatchOptions
 * @property {object}  [_brokerClient]   — injectable MCP client (for tests)
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
 */

/**
 * Dispatch a masterplan implementer task through the agent-dispatch broker.
 *
 * This is the single public surface. It:
 *  1. Connects to the broker via the injectable MCP client (or spawns one).
 *  2. Sends `dispatch_task` with the task descriptor, file scope, verify
 *     commands, and the run's existing cwd (no second worktree ever created).
 *  3. Extracts the return digest from the worker's final output.
 *  4. Returns the digest in the exact mp-implementer shape.
 *
 * On broker escalate (no route, budget breach, guard deny, execute_yourself):
 * returns status:'blocked' so the L1 shell can route inline.
 *
 * @param {TaskInput}       task     — masterplan task descriptor
 * @param {DispatchOptions} [options]
 * @returns {Promise<Digest>}
 */
export async function dispatchTask(task, options = {}) {
  const taskId = task.task_id;
  const description = task.description ?? '';
  const files = Array.isArray(task.files) ? task.files : [];
  const verifyCommands = Array.isArray(task.verify_commands) ? task.verify_commands : [];
  const cwd = task.cwd ?? process.cwd();
  const taskClass = task.class ?? options.class ?? DEFAULT_TASK_CLASS;

  // Build the broker descriptor. File scope and verify commands are first-class
  // fields — the broker carries them to the worker via buildBrief (spec §5.1).
  const descriptor = {
    class:   taskClass,
    repo:    cwd,
    brief:   description,
    files,
    verify:  verifyCommands,
    // contract_version is carried as a top-level field so any future broker can
    // assert compatibility and flag mismatches explicitly.
    contract_version: CONTRACT_VERSION,
  };

  // Obtain a broker client — use the injected test double or spawn a real one.
  const usingInjected = options._brokerClient != null;
  const client = usingInjected ? options._brokerClient : createBrokerClient({ bin: options.brokerBin });

  let brokerResult;
  try {
    if (!usingInjected) {
      await client.initialize();
    }
    brokerResult = await client.callTool('dispatch_task', { descriptor });
  } catch (err) {
    return {
      task_id:       taskId,
      status:        'blocked',
      start_sha:     '',
      files_changed: [],
      verify:        [],
      summary:       `broker error during dispatch_task: ${err.message}`,
      blockers:      err.message,
    };
  } finally {
    if (!usingInjected) {
      client.close();
    }
  }

  // execute_yourself check FIRST (highest precedence): Claude-tier routing — L1 shell dispatches inline.
  if (brokerResult?.execute_yourself === true) {
    return {
      task_id:       taskId,
      status:        'blocked',
      start_sha:     '',
      files_changed: [],
      verify:        [],
      summary:       'broker returned execute_yourself — task requires Claude-tier routing; use inline dispatch',
      blockers:      'execute_yourself: Claude-tier route; route inline',
    };
  }

  // Broker returned a non-route decision (escalate, budget_breach, guard_deny, null, etc.)
  if (!brokerResult || brokerResult.decision?.decision !== 'route') {
    const reason = brokerResult?.decision?.reason ?? brokerResult?.reason ?? 'broker did not return a route decision';
    return {
      task_id:       taskId,
      status:        'blocked',
      start_sha:     '',
      files_changed: [],
      verify:        [],
      summary:       `broker escalated: ${reason}`,
      blockers:      reason,
    };
  }

  // The broker dispatched the task. Extract the worker's return digest from stdout.
  const rawOutput = brokerResult?.stdout ?? brokerResult?.final_message ?? '';
  const digest = extractDigestFromOutput(rawOutput);

  if (digest === null) {
    // Worker output is present but contains no valid digest — treat as failed.
    return {
      task_id:       taskId,
      status:        'failed',
      start_sha:     '',
      files_changed: [],
      verify:        [],
      summary:       'worker completed but returned no parseable digest',
      blockers:      `raw output (first 200 chars): ${String(rawOutput).slice(0, 200)}`,
    };
  }

  // Return the digest, always stamping task_id from our input (canonical source).
  return {
    task_id:       taskId,
    status:        digest.status,
    start_sha:     String(digest.start_sha ?? ''),
    files_changed: Array.isArray(digest.files_changed) ? digest.files_changed : [],
    verify:        Array.isArray(digest.verify) ? digest.verify : [],
    summary:       String(digest.summary ?? ''),
    blockers:      digest.blockers ?? null,
  };
}
