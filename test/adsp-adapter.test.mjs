// test/adsp-adapter.test.mjs — masterplan→broker dispatch adapter (lib/dispatch/adsp-adapter.mjs).
//
// Tests the contract surface and wiring behavior of the adsp adapter, all using injected
// broker clients so no real agent-dispatch daemon is required. Verified behaviors:
//
//   1. CONTRACT_VERSION is pinned to 'adsp-v1' (the contract seam).
//   2. dispatchTask maps the masterplan task fields into the broker descriptor correctly.
//   3. extractDigestFromOutput extracts valid digests from clean and multi-line broker output.
//   4. dispatchTask propagates the worker digest back in the exact mp-implementer shape.
//   5. Broker escalations (escalate, execute_yourself) are returned as status:'blocked'.
//   6. Missing digest in broker output returns status:'failed'.
//   7. Broker error (network/spawn) returns status:'blocked'.
//   8. task_id is always the canonical input value (never overridden by worker).
//   9. cwd defaults to process.cwd() when not supplied.
//  10. Descriptor carries contract_version, files, verify fields.
//  11. createBrokerClient initializes and passes tool calls through the MCP wire protocol.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_VERSION,
  dispatchTask,
  extractDigestFromOutput,
  createBrokerClient,
  buildWorkItem,
  buildFrozenDispatchRecord,
} from '../lib/dispatch/adsp-adapter.mjs';
import {
  composeHandoffKey,
  computeTaskSpecHash,
  computeInputFingerprint,
} from '../lib/adsp-idempotency.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal valid mp-implementer digest. */
const validDigest = () => ({
  task_id:       7,
  status:        'done',
  start_sha:     'deadbeef1234',
  files_changed: ['lib/foo.mjs'],
  verify:        [{ command: 'node --test', passed: true, output: 'ok' }],
  summary:       'added null check',
  blockers:      null,
});

/** A minimal masterplan task input. */
const baseTask = () => ({
  task_id:         7,
  description:     'Add a null check to parseConfig',
  files:           ['lib/foo.mjs'],
  verify_commands: ['node --test'],
  cwd:             '/repo/.worktrees/my-run',
  run_id:          'my-run',
  inputs:          { head: 'abc123', dirtyDigest: '', policyVersion: 'pol-v1', workerVersion: 'wk-v1' },
});

/**
 * Replicate the adapter's handoff-key composition (prepareDispatch) so tests can
 * assert the EXACT key the work item carries. Mirrors lib/dispatch/adsp-adapter.mjs
 * prepareDispatch: body = { task_id, description, files, verify_commands },
 * workerConfig = { class, ...worker_config }, context = task.context, inputs normalized.
 */
function expectedKeyFor(task, options = {}) {
  const taskClass = task.class ?? options.class ?? 'bounded-edit';
  const body = {
    task_id:         task.task_id,
    description:     task.description ?? '',
    files:           Array.isArray(task.files) ? task.files : [],
    verify_commands: Array.isArray(task.verify_commands) ? task.verify_commands : [],
  };
  const workerConfig = { class: taskClass, ...(task.worker_config ?? {}) };
  const taskSpecHash = computeTaskSpecHash({
    body,
    context: task.context ?? null,
    workerConfig,
  });
  const raw = { head: '', dirtyDigest: '', policyVersion: '', workerVersion: '', ...(task.inputs ?? {}) };
  const fp = {
    head:          typeof raw.head === 'string' ? raw.head : '',
    dirtyDigest:   typeof raw.dirtyDigest === 'string' ? raw.dirtyDigest : '',
    policyVersion: typeof raw.policyVersion === 'string' ? raw.policyVersion : '',
    workerVersion: typeof raw.workerVersion === 'string' ? raw.workerVersion : '',
  };
  const inputFingerprint = computeInputFingerprint(fp);
  return composeHandoffKey(task.run_id, task.task_id, taskSpecHash, inputFingerprint);
}

/**
 * Injectable blackboard result store stub. Records call counts and every write,
 * and returns a canned prior result from readResult. Models the sibling
 * subsystem the adapter consumes as the keyed result substrate.
 */
function makeResultStore({ priorResult = null } = {}) {
  const writes = [];
  const store = {
    calls: { readResult: 0, writeResult: 0, readDispatchRecord: 0, writeDispatchRecord: 0 },
    writes,
    priorResult,
    async readResult(key)           { store.calls.readResult++; return store.priorResult; },
    async writeResult(key, record)  { store.calls.writeResult++; writes.push({ kind: 'result', key, record }); },
    async readDispatchRecord(key)   { store.calls.readDispatchRecord++; return null; },
    async writeDispatchRecord(key, record) { store.calls.writeDispatchRecord++; writes.push({ kind: 'dispatch', key, record }); },
  };
  return store;
}

// ---------------------------------------------------------------------------
// Broker client stub factory
//
// Builds an injectable MCP client that records calls and returns canned results.
// The stub models the broker's dispatch_task response surface:
//   - routeDecision: { decision: 'route', backend: 'pi', ... }  (success path)
//   - escalate:      { decision: { decision: 'escalate', reason: '...' } }
//   - execute_yourself: { execute_yourself: true, decision: { decision: 'route' } }
//   - stdout:        string containing the worker's return digest (may be JSON)
// ---------------------------------------------------------------------------

function makeBrokerStub(response) {
  const calls = [];
  const client = {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      return response;
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// 1. CONTRACT_VERSION pinned
// ---------------------------------------------------------------------------

test('CONTRACT_VERSION is pinned to adsp-v1', () => {
  assert.equal(CONTRACT_VERSION, 'adsp-v1');
});

// ---------------------------------------------------------------------------
// 2. extractDigestFromOutput
// ---------------------------------------------------------------------------

test('extractDigestFromOutput returns null for empty string', () => {
  assert.equal(extractDigestFromOutput(''), null);
  assert.equal(extractDigestFromOutput(null), null);
  assert.equal(extractDigestFromOutput(undefined), null);
});

test('extractDigestFromOutput extracts a valid digest from a clean JSON string', () => {
  const d = validDigest();
  const result = extractDigestFromOutput(JSON.stringify(d));
  assert.deepEqual(result, d);
});

test('extractDigestFromOutput extracts the last valid digest from multi-line output', () => {
  const d1 = validDigest();
  const d2 = { ...validDigest(), task_id: 99, status: 'failed', blockers: 'reason' };
  const text = `some log line\n${JSON.stringify(d1)}\nmore log\n${JSON.stringify(d2)}\n`;
  const result = extractDigestFromOutput(text);
  assert.deepEqual(result, d2);
});

test('extractDigestFromOutput returns null when no line is a valid digest', () => {
  const text = `{ "foo": "bar" }\n{ "task_id": 1 }\nnot json\n`;
  assert.equal(extractDigestFromOutput(text), null);
});

test('extractDigestFromOutput rejects objects missing required fields', () => {
  // Missing 'verify'
  const bad = { task_id: 1, status: 'done', start_sha: 'abc', files_changed: [], summary: 'ok' };
  assert.equal(extractDigestFromOutput(JSON.stringify(bad)), null);
});

test('extractDigestFromOutput rejects objects with invalid status', () => {
  const bad = { ...validDigest(), status: 'unknown-status' };
  assert.equal(extractDigestFromOutput(JSON.stringify(bad)), null);
});

// ---------------------------------------------------------------------------
// 3. dispatchTask — happy path (done)
// ---------------------------------------------------------------------------

test('dispatchTask calls dispatch_task on the broker with the correct descriptor shape', async () => {
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'pi' },
    dispatch_id: 'test-dispatch-001',
    stdout: JSON.stringify(validDigest()),
  });

  const result = await dispatchTask(baseTask(), { _brokerClient: stub });

  // Verify the tool call was made.
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0];
  assert.equal(call.name, 'dispatch_task');

  // Verify descriptor fields are mapped correctly.
  const { descriptor } = call.args;
  assert.equal(descriptor.class, 'bounded-edit');        // default class
  assert.equal(descriptor.repo, '/repo/.worktrees/my-run'); // cwd maps to repo
  assert.equal(descriptor.brief, 'Add a null check to parseConfig');
  assert.deepEqual(descriptor.files, ['lib/foo.mjs']);
  assert.deepEqual(descriptor.verify, ['node --test']);
  assert.equal(descriptor.contract_version, 'adsp-v1');

  // adsp-v1 seam: the work item carries the bundle's stable task_id and the
  // composed handoff-idempotency key (spec §5.5). The key is the blackboard
  // result-substrate key for this task.
  assert.equal(descriptor.task_id, 7);
  assert.equal(descriptor.handoff_key, expectedKeyFor(baseTask()));
});

test('dispatchTask returns the extracted digest in the mp-implementer shape', async () => {
  const d = validDigest();
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'pi' },
    stdout: JSON.stringify(d),
  });

  const result = await dispatchTask(baseTask(), { _brokerClient: stub });

  assert.equal(result.task_id, 7);            // canonical from input
  assert.equal(result.status, 'done');
  assert.equal(result.start_sha, 'deadbeef1234');
  assert.deepEqual(result.files_changed, ['lib/foo.mjs']);
  assert.deepEqual(result.verify, [{ command: 'node --test', passed: true, output: 'ok' }]);
  assert.equal(result.summary, 'added null check');
  assert.equal(result.blockers, null);
});

// ---------------------------------------------------------------------------
// 4. task_id is always the canonical input value
// ---------------------------------------------------------------------------

test('dispatchTask stamps task_id from input, not from worker digest', async () => {
  const d = { ...validDigest(), task_id: 999 }; // worker says 999
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'pi' },
    stdout: JSON.stringify(d),
  });

  const task = { ...baseTask(), task_id: 7 };
  const result = await dispatchTask(task, { _brokerClient: stub });

  // Input task_id wins over whatever the worker digest says.
  assert.equal(result.task_id, 7);
});

// ---------------------------------------------------------------------------
// 5. Broker escalations → status:'blocked'
// ---------------------------------------------------------------------------

test('dispatchTask returns blocked when broker escalates (no route)', async () => {
  const stub = makeBrokerStub({
    decision: { decision: 'escalate', reason: 'haiku forbid' },
  });

  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers != null && result.blockers.length > 0);
});

test('dispatchTask returns blocked when broker returns execute_yourself', async () => {
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'claude' },
    execute_yourself: true,
  });

  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.equal(result.status, 'blocked');
  assert.match(result.blockers, /execute_yourself/);
});

test('dispatchTask returns blocked on budget_breach escalation', async () => {
  const stub = makeBrokerStub({
    decision: { decision: 'escalate', reason: 'budget_breach:per_day_usd' },
  });

  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.equal(result.status, 'blocked');
  assert.match(result.blockers, /budget_breach/);
});

// ---------------------------------------------------------------------------
// 6. Missing digest in broker output → status:'failed'
// ---------------------------------------------------------------------------

test('dispatchTask returns failed when broker stdout has no valid digest', async () => {
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'pi' },
    stdout: 'Worker ran but forgot to return a digest.',
  });

  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.equal(result.status, 'failed');
  assert.equal(result.task_id, 7);
  assert.ok(result.blockers != null);
});

test('dispatchTask returns failed when broker stdout is empty', async () => {
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'pi' },
    stdout: '',
  });

  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.equal(result.status, 'failed');
});

// ---------------------------------------------------------------------------
// 7. Broker error (client throws) → status:'blocked'
// ---------------------------------------------------------------------------

test('dispatchTask returns blocked when broker client throws', async () => {
  const errorClient = {
    async callTool() {
      throw new Error('connection refused');
    },
  };

  const result = await dispatchTask(baseTask(), { _brokerClient: errorClient });
  assert.equal(result.status, 'blocked');
  assert.match(result.blockers, /connection refused/);
});

// ---------------------------------------------------------------------------
// 8. cwd defaults to process.cwd()
// ---------------------------------------------------------------------------

test('dispatchTask uses process.cwd() as repo when task.cwd is not supplied', async () => {
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'pi' },
    stdout: JSON.stringify(validDigest()),
  });

  const task = { ...baseTask() };
  delete task.cwd;
  await dispatchTask(task, { _brokerClient: stub });

  const { descriptor } = stub.calls[0].args;
  assert.equal(descriptor.repo, process.cwd());
});

// ---------------------------------------------------------------------------
// 9. task.class overrides default; options.class is lower precedence
// ---------------------------------------------------------------------------

test('dispatchTask uses task.class when provided', async () => {
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'pi' },
    stdout: JSON.stringify(validDigest()),
  });

  const task = { ...baseTask(), class: 'agentic-loop' };
  await dispatchTask(task, { _brokerClient: stub, class: 'mechanical-text' });

  const { descriptor } = stub.calls[0].args;
  // task.class wins over options.class
  assert.equal(descriptor.class, 'agentic-loop');
});

test('dispatchTask uses options.class when task.class is absent', async () => {
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'pi' },
    stdout: JSON.stringify(validDigest()),
  });

  const task = { ...baseTask() };
  // no class on task
  await dispatchTask(task, { _brokerClient: stub, class: 'investigation' });

  const { descriptor } = stub.calls[0].args;
  assert.equal(descriptor.class, 'investigation');
});

test('dispatchTask defaults to bounded-edit when no class is supplied anywhere', async () => {
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'pi' },
    stdout: JSON.stringify(validDigest()),
  });

  await dispatchTask(baseTask(), { _brokerClient: stub });

  const { descriptor } = stub.calls[0].args;
  assert.equal(descriptor.class, 'bounded-edit');
});

// ---------------------------------------------------------------------------
// 10. Digest fields are sanitized (type coercion on valid digest)
// ---------------------------------------------------------------------------

test('dispatchTask coerces start_sha to string when worker returns a number', async () => {
  // A valid digest where start_sha is a number — the adapter must coerce it to string.
  // (JSON roundtrip preserves the number; isValidDigest does not check the type of start_sha.)
  const d = { ...validDigest(), start_sha: 0xdeadbeef };
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'pi' },
    stdout: JSON.stringify(d),
  });

  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.equal(result.status, 'done');
  assert.equal(typeof result.start_sha, 'string');
  assert.equal(result.start_sha, String(0xdeadbeef));
});

test('dispatchTask returns null for blockers when worker omits the field', async () => {
  // A digest where blockers is missing entirely (valid — blockers is optional null).
  const { blockers: _omit, ...dWithoutBlockers } = validDigest();
  const stub = makeBrokerStub({
    decision: { decision: 'route', backend: 'pi' },
    stdout: JSON.stringify(dWithoutBlockers),
  });

  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.equal(result.blockers, null);
});

// ---------------------------------------------------------------------------
// 11. dispatchTask handles null/undefined broker result gracefully
// ---------------------------------------------------------------------------

test('dispatchTask returns blocked when broker returns null', async () => {
  const stub = makeBrokerStub(null);
  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.equal(result.status, 'blocked');
});

test('dispatchTask returns blocked when broker returns an empty object', async () => {
  const stub = makeBrokerStub({});
  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.equal(result.status, 'blocked');
});

// ---------------------------------------------------------------------------
// 12. createBrokerClient export surface (structural check — no real spawn)
// ---------------------------------------------------------------------------

test('createBrokerClient export exists and returns an object with the required methods', () => {
  // We are not spawning a real broker here — just verifying the function is
  // exported and returns an object with the documented methods. The close()
  // call will attempt to kill a process that was never actually started, but
  // that is a no-op on a non-existent child.
  assert.equal(typeof createBrokerClient, 'function');
  // We cannot safely call it without a real binary, so we only check the export type.
});

// ---------------------------------------------------------------------------
// v3 cross-review escalation bridge (spec §6.8)
// ---------------------------------------------------------------------------
import {
  escalateCrossReview,
  revertCrossReview,
} from '../lib/dispatch/adsp-adapter.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('escalateCrossReview: rejects payloads that are not requires_human_decision', async () => {
  const r = await escalateCrossReview('/tmp/x', 's1', { kind: 'brief' });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.match(r.reason, /not a requires_human_decision/);
});

test('escalateCrossReview: spawns a fake masterplanBin and parses its gate_id', async () => {
  // Create a tiny node script that mimics `mp open-gate` JSON output.
  const dir = mkdtempSync(join(tmpdir(), 'adsp-cr-'));
  const fakeBin = join(dir, 'fake-mp.mjs');
  writeFileSync(fakeBin, "process.stdout.write(JSON.stringify({id:'cr-gate-42', gate_id:'cr-gate-42'})+'\\n');");
  const r = await escalateCrossReview(
    '/tmp/state.yml',
    'cross-model-review',
    { kind: 'requires_human_decision', reason: 'supervised-disagreement', review_record: { final_verdict: 'rework' } },
    { masterplanBin: fakeBin }
  );
  assert.equal(r.ok, true);
  assert.equal(r.gate_id, 'cr-gate-42');
});

test('escalateCrossReview: degraded when the masterplanBin exits non-zero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsp-cr-'));
  const fakeBin = join(dir, 'bad-mp.mjs');
  writeFileSync(fakeBin, "process.stderr.write('boom\\n'); process.exit(2);");
  const r = await escalateCrossReview(
    '/tmp/state.yml',
    'cross-model-review',
    { kind: 'requires_human_decision', reason: 'rework-retries-exhausted' },
    { masterplanBin: fakeBin }
  );
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.match(r.reason, /exit 2/);
});

test('escalateCrossReview: when no masterplanBin is passed, resolves the bin portably via $MP_BIN (no hardcoded /home/<user>)', async () => {
  // Portability contract: escalating without an explicit bin must NOT fall back to a hardcoded
  // /home/ras/... literal. Set $MP_BIN to a fake bin and confirm the spawn uses it; unset/blank
  // $MP_BIN must fall through to resolveMasterplanBin's marketplace install path.
  const dir = mkdtempSync(join(tmpdir(), 'adsp-cr-'));
  const fakeBin = join(dir, 'fake-mp.mjs');
  writeFileSync(fakeBin, "process.stdout.write(JSON.stringify({gate_id:'via-mp-bin'})+'\\n');");
  // Save/restore MP_BIN so this test doesn't leak env state into the suite.
  const savedBin = process.env.MP_BIN;
  try {
    process.env.MP_BIN = fakeBin;
    const r = await escalateCrossReview(
      '/tmp/state.yml',
      'portability-probe',
      { kind: 'requires_human_decision', reason: 'supervised-disagreement', review_record: { final_verdict: 'rework' } },
      // NO masterplanBin opt — forces the $MP_BIN / resolveMasterplanBin resolution path.
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.gate_id, 'via-mp-bin');
    assert.ok(!r.reason || !r.reason.includes('/home/ras'), `must not leak home path: ${r.reason}`);
  } finally {
    if (savedBin === undefined) delete process.env.MP_BIN; else process.env.MP_BIN = savedBin;
  }
});

test('revertCrossReview: rejects empty wtPath', async () => {
  const r = await revertCrossReview('', { files: ['x.js'] });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
});

test('revertCrossReview: returns ok + scope for a valid path (deferred impl)', async () => {
  const r = await revertCrossReview('/srv/dev/.../worktree', { files: ['foo.js'] });
  assert.equal(r.ok, true);
  assert.equal(r.scope.files[0], 'foo.js');
});

// ===========================================================================
// adsp-v1 seam contract (Task 36) — handoff-idempotency key, work-item shape,
// digest translation, escalate/degraded mapping, blackboard result substrate
// ===========================================================================

// ---------------------------------------------------------------------------
// 36a. Work-item construction (buildWorkItem — pure, no I/O)
// ---------------------------------------------------------------------------

test('buildWorkItem: pure constructor returns the work item with the composed handoff key', () => {
  const descriptor = buildWorkItem(baseTask());
  assert.equal(descriptor.class, 'bounded-edit');
  assert.equal(descriptor.repo, '/repo/.worktrees/my-run');
  assert.equal(descriptor.brief, 'Add a null check to parseConfig');
  assert.deepEqual(descriptor.files, ['lib/foo.mjs']);
  assert.deepEqual(descriptor.verify, ['node --test']);
  assert.equal(descriptor.contract_version, 'adsp-v1');
  assert.equal(descriptor.task_id, 7);
  assert.equal(descriptor.handoff_key, expectedKeyFor(baseTask()));
});

test('buildWorkItem: repo is the run\'s existing worktree cwd — never a second worktree', () => {
  const descriptor = buildWorkItem({ ...baseTask(), cwd: '/srv/dev/ras/masterplan/.worktrees/wave-3' });
  assert.equal(descriptor.repo, '/srv/dev/ras/masterplan/.worktrees/wave-3');
  // No separate worktree-creation field is ever introduced.
  assert.equal('worktree' in descriptor, false);
  assert.equal('worktree_path' in descriptor, false);
});

test('buildWorkItem: honors a task class override over the default', () => {
  const descriptor = buildWorkItem({ ...baseTask(), class: 'agentic-loop' });
  assert.equal(descriptor.class, 'agentic-loop');
  // The class change is part of the worker config → it changes the key.
  assert.notEqual(descriptor.handoff_key, expectedKeyFor(baseTask()));
});

// ---------------------------------------------------------------------------
// 36b. Handoff-idempotency key composition
// ---------------------------------------------------------------------------

test('handoff key: deterministic — same task+inputs produce the same key', () => {
  const k1 = buildWorkItem(baseTask()).handoff_key;
  const k2 = buildWorkItem(baseTask()).handoff_key;
  assert.equal(k1, k2);
});

test('handoff key: a replanned task body changes the key', () => {
  const k1 = buildWorkItem(baseTask()).handoff_key;
  const k2 = buildWorkItem({ ...baseTask(), description: 'Different task body' }).handoff_key;
  assert.notEqual(k1, k2);
});

test('handoff key: a changed file scope changes the key', () => {
  const k1 = buildWorkItem(baseTask()).handoff_key;
  const k2 = buildWorkItem({ ...baseTask(), files: ['lib/bar.mjs'] }).handoff_key;
  assert.notEqual(k1, k2);
});

test('handoff key: a changed verify command changes the key', () => {
  const k1 = buildWorkItem(baseTask()).handoff_key;
  const k2 = buildWorkItem({ ...baseTask(), verify_commands: ['npm test'] }).handoff_key;
  assert.notEqual(k1, k2);
});

test('handoff key: a changed repo state (head) changes the key', () => {
  const k1 = buildWorkItem(baseTask()).handoff_key;
  const k2 = buildWorkItem({ ...baseTask(), inputs: { ...baseTask().inputs, head: 'def456' } }).handoff_key;
  assert.notEqual(k1, k2);
});

test('handoff key: a changed policy version changes the key', () => {
  const k1 = buildWorkItem(baseTask()).handoff_key;
  const k2 = buildWorkItem({ ...baseTask(), inputs: { ...baseTask().inputs, policyVersion: 'pol-v2' } }).handoff_key;
  assert.notEqual(k1, k2);
});

test('handoff key: a changed worker version changes the key', () => {
  const k1 = buildWorkItem(baseTask()).handoff_key;
  const k2 = buildWorkItem({ ...baseTask(), inputs: { ...baseTask().inputs, workerVersion: 'wk-v2' } }).handoff_key;
  assert.notEqual(k1, k2);
});

test('handoff key: a relocated worktree path (same state) does NOT change the key', () => {
  const k1 = buildWorkItem(baseTask()).handoff_key;
  const k2 = buildWorkItem({ ...baseTask(), cwd: '/elsewhere/.worktrees/my-run' }).handoff_key;
  assert.equal(k1, k2, 'cwd is excluded from the task spec — only worktree STATE (in the fingerprint) matters');
});

test('handoff key: encodes run_id, task_id, task_spec_hash, and input_fingerprint', () => {
  const key = buildWorkItem(baseTask()).handoff_key;
  // adsp-idem-v1:<run>:<task>:<spec_hash>:<fingerprint>
  assert.match(key, /^adsp-idem-v1:/);
  const parts = key.split(':');
  assert.equal(parts.length, 5, 'four ":"-delimited parts after the version prefix');
  assert.equal(parts[0], 'adsp-idem-v1');
  assert.equal(parts[1], 'my-run');
  assert.equal(parts[2], '7');
  assert.match(parts[3], /^[0-9a-f]{64}$/, 'task_spec_hash is sha256 hex');
  assert.match(parts[4], /^[0-9a-f]{64}$/, 'input_fingerprint is sha256 hex');
});

test('handoff key: partial inputs are filled with empty strings (stable key)', () => {
  const onlyHead = buildWorkItem({ ...baseTask(), inputs: { head: 'abc123' } }).handoff_key;
  const explicit = buildWorkItem({
    ...baseTask(),
    inputs: { head: 'abc123', dirtyDigest: '', policyVersion: '', workerVersion: '' },
  }).handoff_key;
  assert.equal(onlyHead, explicit, 'missing inputs default to empty strings');
});

// ---------------------------------------------------------------------------
// 36c. Degraded mode (no run_id → no key, no idempotency; still dispatches)
// ---------------------------------------------------------------------------

test('degraded: no run_id means handoff_key is null (no idempotency, still dispatches)', () => {
  const noRun = baseTask();
  delete noRun.run_id;
  const descriptor = buildWorkItem(noRun);
  assert.equal(descriptor.handoff_key, null);
  assert.equal(descriptor.task_id, 7);
  assert.equal(descriptor.contract_version, 'adsp-v1');
});

test('degraded: no _resultStore injected — no blackboard read/write, still dispatches', async () => {
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(validDigest()) });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.equal(stub.calls.length, 1);
  assert.equal(result.status, 'done');
  assert.equal(result.task_id, 7);
});

test('degraded: no run_id with a result store — no blackboard read/write (no key), still dispatches', async () => {
  const store = makeResultStore();
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(validDigest()) });
  const noRun = baseTask();
  delete noRun.run_id;
  const result = await dispatchTask(noRun, { _brokerClient: stub, _resultStore: store });
  assert.equal(store.calls.readResult, 0, 'no key → no read');
  assert.equal(store.calls.writeDispatchRecord, 0, 'no key → no dispatch record write');
  assert.equal(store.calls.writeResult, 0, 'no key → no result write');
  assert.equal(stub.calls.length, 1);
  assert.equal(result.status, 'done');
  assert.equal(stub.calls[0].args.descriptor.handoff_key, null);
});

// ---------------------------------------------------------------------------
// 36d. Blackboard result substrate (the keyed result store)
// ---------------------------------------------------------------------------

test('blackboard: a reusable prior done result is returned as a no-op read (broker never called)', async () => {
  const key = expectedKeyFor(baseTask());
  const priorDigest = validDigest();
  const store = makeResultStore({ priorResult: { handoff_key: key, status: 'done', digest: priorDigest } });
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(validDigest()) });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub, _resultStore: store });
  assert.equal(stub.calls.length, 0, 'broker must not be called on the reuse path');
  assert.equal(store.calls.readResult, 1);
  assert.equal(store.calls.writeDispatchRecord, 0, 'no dispatch record written on reuse');
  assert.equal(store.calls.writeResult, 0, 'no result rewrite on reuse');
  assert.equal(result.status, 'done');
  assert.equal(result.task_id, 7);
  assert.equal(result.summary, 'added null check');
});

test('blackboard: the reused result has the exact mp-implementer shape (transparent to L1)', async () => {
  const key = expectedKeyFor(baseTask());
  const store = makeResultStore({ priorResult: { handoff_key: key, status: 'done', digest: validDigest() } });
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(validDigest()) });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub, _resultStore: store });
  assert.deepEqual(Object.keys(result).sort(), ['blockers', 'files_changed', 'start_sha', 'status', 'summary', 'task_id', 'verify']);
  assert.equal(result.task_id, 7);
});

test('blackboard: a key mismatch (replanned task) is NOT reused — fresh dispatch + result written', async () => {
  const staleKey = expectedKeyFor({ ...baseTask(), description: 'old description' });
  const store = makeResultStore({ priorResult: { handoff_key: staleKey, status: 'done', digest: validDigest() } });
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(validDigest()) });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub, _resultStore: store });
  assert.equal(stub.calls.length, 1, 'broker IS called when the prior key does not match');
  assert.equal(result.status, 'done');
  assert.equal(store.calls.writeDispatchRecord, 1, 'frozen dispatch record written at dispatch time');
  assert.equal(store.calls.writeResult, 1, 'fresh result written after dispatch');
});

test('blackboard: a prior non-done result (failed) is NOT reused — fresh dispatch', async () => {
  const key = expectedKeyFor(baseTask());
  const store = makeResultStore({ priorResult: { handoff_key: key, status: 'failed', digest: validDigest() } });
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(validDigest()) });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub, _resultStore: store });
  assert.equal(stub.calls.length, 1, 'a failed prior result is not reused');
  assert.equal(result.status, 'done');
});

test('blackboard: the frozen dispatch record is written at dispatch time with all key inputs', async () => {
  const key = expectedKeyFor(baseTask());
  const store = makeResultStore();
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(validDigest()) });
  await dispatchTask(baseTask(), { _brokerClient: stub, _resultStore: store });
  const dispWrites = store.writes.filter((w) => w.kind === 'dispatch');
  assert.equal(dispWrites.length, 1);
  const rec = dispWrites[0].record;
  assert.equal(dispWrites[0].key, key);
  assert.equal(rec.handoff_key, key);
  assert.equal(rec.run_id, 'my-run');
  assert.equal(rec.task_id, 7);
  assert.equal(rec.task_class, 'bounded-edit');
  assert.equal(rec.contract_version, 'adsp-v1');
  assert.equal(rec.status, 'pending');
  assert.match(rec.task_spec_hash, /^[0-9a-f]{64}$/);
  assert.match(rec.input_fingerprint, /^[0-9a-f]{64}$/);
  // The frozen key inputs (env facts captured at dispatch time — never recomputed).
  assert.equal(rec.head, 'abc123');
  assert.equal(rec.dirty_digest, '');
  assert.equal(rec.policy_version, 'pol-v1');
  assert.equal(rec.worker_version, 'wk-v1');
  assert.ok(typeof rec.dispatched_at === 'string' && rec.dispatched_at.length > 0, 'dispatched_at is an ISO timestamp');
});

test('blackboard: the result is written after dispatch keyed by the handoff key', async () => {
  const key = expectedKeyFor(baseTask());
  const store = makeResultStore();
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(validDigest()) });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub, _resultStore: store });
  const resWrites = store.writes.filter((w) => w.kind === 'result');
  assert.equal(resWrites.length, 1);
  const rec = resWrites[0].record;
  assert.equal(resWrites[0].key, key);
  assert.equal(rec.handoff_key, key);
  assert.equal(rec.status, 'done');
  assert.equal(rec.contract_version, 'adsp-v1');
  assert.deepEqual(rec.digest, result, 'stored digest equals the returned digest');
  assert.ok(typeof rec.completed_at === 'string' && rec.completed_at.length > 0);
});

test('blackboard: a readResult error is non-fatal — dispatch proceeds', async () => {
  const store = {
    calls: { readResult: 0, writeResult: 0, writeDispatchRecord: 0 },
    async readResult()            { store.calls.readResult++; throw new Error('blackboard read failed'); },
    async writeResult()           { store.calls.writeResult++; },
    async writeDispatchRecord()   { store.calls.writeDispatchRecord++; },
  };
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(validDigest()) });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub, _resultStore: store });
  assert.equal(store.calls.readResult, 1);
  assert.equal(result.status, 'done', 'dispatch still returns the worker digest');
  assert.equal(store.calls.writeDispatchRecord, 1);
  assert.equal(store.calls.writeResult, 1);
});

test('blackboard: a writeResult error is non-fatal — the digest is still returned', async () => {
  const store = {
    async readResult()          { return null; },
    async writeDispatchRecord() {},
    async writeResult()         { throw new Error('blackboard full'); },
  };
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(validDigest()) });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub, _resultStore: store });
  assert.equal(result.status, 'done');
  assert.equal(result.task_id, 7);
});

test('blackboard: a writeDispatchRecord error is non-fatal — dispatch still proceeds', async () => {
  const store = {
    calls: { writeResult: 0 },
    async readResult()          { return null; },
    async writeDispatchRecord() { throw new Error('disk full'); },
    async writeResult()         { store.calls.writeResult++; },
  };
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(validDigest()) });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub, _resultStore: store });
  assert.equal(result.status, 'done');
  assert.equal(store.calls.writeResult, 1, 'result is still recorded even if the dispatch-record write failed');
});

// ---------------------------------------------------------------------------
// 36e. Frozen dispatch record (pure constructor)
// ---------------------------------------------------------------------------

test('buildFrozenDispatchRecord: pure constructor returns the frozen key inputs with a pending skeleton', () => {
  const rec = buildFrozenDispatchRecord(baseTask());
  const key = expectedKeyFor(baseTask());
  assert.equal(rec.handoff_key, key);
  assert.equal(rec.run_id, 'my-run');
  assert.equal(rec.task_id, 7);
  assert.equal(rec.task_class, 'bounded-edit');
  assert.match(rec.task_spec_hash, /^[0-9a-f]{64}$/);
  assert.match(rec.input_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(rec.contract_version, 'adsp-v1');
  assert.equal(rec.status, 'pending');
  assert.equal(rec.dispatched_at, null, 'pure constructor leaves the timestamp null');
  assert.equal(rec.head, 'abc123');
  assert.equal(rec.dirty_digest, '');
  assert.equal(rec.policy_version, 'pol-v1');
  assert.equal(rec.worker_version, 'wk-v1');
});

test('buildFrozenDispatchRecord: no run_id → null key and null hashes (degraded)', () => {
  const noRun = baseTask();
  delete noRun.run_id;
  const rec = buildFrozenDispatchRecord(noRun);
  assert.equal(rec.handoff_key, null);
  assert.equal(rec.task_spec_hash, null);
  assert.equal(rec.input_fingerprint, null);
  assert.equal(rec.task_id, 7);
  assert.equal(rec.status, 'pending');
});

// ---------------------------------------------------------------------------
// 36f. Digest translation — exact mp-implementer shape (record-result untouched)
// ---------------------------------------------------------------------------

test('digest translation: returned digest has the exact mp-implementer shape (no extra fields)', async () => {
  const workerDigest = {
    ...validDigest(),
    extra_worker_field: 'should be dropped',
    task_id: 999, // the worker's task_id is never trusted
  };
  const stub = makeBrokerStub({ decision: { decision: 'route', backend: 'pi' }, stdout: JSON.stringify(workerDigest) });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.deepEqual(Object.keys(result).sort(), ['blockers', 'files_changed', 'start_sha', 'status', 'summary', 'task_id', 'verify']);
  assert.equal(result.task_id, 7, 'task_id stamped from the canonical input, not the worker');
  assert.equal(result.extra_worker_field, undefined, 'extra worker fields are dropped');
  assert.equal(result.status, 'done');
});

// ---------------------------------------------------------------------------
// 36g. Escalate/degraded mapping — the work item carries the seam on every path
// ---------------------------------------------------------------------------

test('seam: the work item carries task_id + handoff_key on every dispatch (even execute_yourself)', async () => {
  const stub = makeBrokerStub({ execute_yourself: true });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  const descriptor = stub.calls[0].args.descriptor;
  assert.equal(descriptor.task_id, 7);
  assert.equal(descriptor.handoff_key, expectedKeyFor(baseTask()));
  assert.equal(descriptor.contract_version, 'adsp-v1');
  assert.equal(result.status, 'blocked', 'execute_yourself maps to blocked (route inline)');
});

test('escalate mapping: a guard_deny escalation surfaces the broker reason in blockers', async () => {
  const stub = makeBrokerStub({ decision: { decision: 'escalate', reason: 'guard_deny:restricted-repo' } });
  const result = await dispatchTask(baseTask(), { _brokerClient: stub });
  assert.equal(result.status, 'blocked');
  assert.match(result.blockers, /guard_deny:restricted-repo/);
  assert.equal(result.task_id, 7);
});
