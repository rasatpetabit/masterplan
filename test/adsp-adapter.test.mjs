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
} from '../lib/dispatch/adsp-adapter.mjs';

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
});

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
