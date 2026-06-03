// test/qctl-enqueue.test.mjs — idempotent enqueue key + UPSERT decision (pure; spec §6.1).
// Covers: key stability, scope order-independence, sensitivity to each field change,
// decideEnqueue reuse/upsert logic, and no-mutation-of-inputs invariant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEnqueueKey, decideEnqueue } from '../lib/qctl-enqueue.mjs';

// A canonical set of inputs the heuristic tests anchor to.
const base = () => ({
  run_slug: 'test-run',
  wave: 3,
  task_id: 7,
  base: 'abc123def456abc123def456abc123def456abc123',
  scope: ['lib/foo.mjs', 'test/foo.test.mjs'],
});

// ---- computeEnqueueKey -----------------------------------------------------------

test('computeEnqueueKey returns a 64-char lowercase hex string', () => {
  const key = computeEnqueueKey(base());
  assert.match(key, /^[0-9a-f]{64}$/, 'expected 64-char lowercase hex');
});

test('computeEnqueueKey is deterministic (same input -> same key)', () => {
  assert.equal(computeEnqueueKey(base()), computeEnqueueKey(base()));
});

test('computeEnqueueKey is scope-order-independent', () => {
  const ascending  = computeEnqueueKey({ ...base(), scope: ['a.mjs', 'b.mjs'] });
  const descending = computeEnqueueKey({ ...base(), scope: ['b.mjs', 'a.mjs'] });
  assert.equal(ascending, descending, 'scope order must not affect the key');
});

test('computeEnqueueKey is sensitive to run_slug', () => {
  const k1 = computeEnqueueKey(base());
  const k2 = computeEnqueueKey({ ...base(), run_slug: 'other-run' });
  assert.notEqual(k1, k2);
});

test('computeEnqueueKey is sensitive to wave', () => {
  const k1 = computeEnqueueKey(base());
  const k2 = computeEnqueueKey({ ...base(), wave: 99 });
  assert.notEqual(k1, k2);
});

test('computeEnqueueKey is sensitive to task_id', () => {
  const k1 = computeEnqueueKey(base());
  const k2 = computeEnqueueKey({ ...base(), task_id: 42 });
  assert.notEqual(k1, k2);
});

test('computeEnqueueKey is sensitive to base SHA', () => {
  const k1 = computeEnqueueKey(base());
  const k2 = computeEnqueueKey({ ...base(), base: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  assert.notEqual(k1, k2);
});

test('computeEnqueueKey is sensitive to scope contents', () => {
  const k1 = computeEnqueueKey(base());
  const k2 = computeEnqueueKey({ ...base(), scope: ['lib/other.mjs'] });
  assert.notEqual(k1, k2);
});

test('computeEnqueueKey treats empty scope and absent scope the same', () => {
  const withEmpty  = computeEnqueueKey({ ...base(), scope: [] });
  const withAbsent = computeEnqueueKey({ run_slug: base().run_slug, wave: base().wave,
                                         task_id: base().task_id, base: base().base });
  assert.equal(withEmpty, withAbsent, 'absent scope defaults to []');
});

test('computeEnqueueKey does not mutate the scope array', () => {
  const scope = ['z.mjs', 'a.mjs', 'm.mjs'];
  const before = JSON.stringify(scope);
  computeEnqueueKey({ ...base(), scope });
  assert.equal(JSON.stringify(scope), before, 'scope array must not be mutated');
});

test('computeEnqueueKey does not mutate the input object', () => {
  const input = base();
  const frozen = JSON.stringify(input);
  computeEnqueueKey(input);
  assert.equal(JSON.stringify(input), frozen, 'input object must not be mutated');
});

// ---- decideEnqueue ---------------------------------------------------------------

test('decideEnqueue: null existingJob -> upsert with job:null', () => {
  const key = computeEnqueueKey(base());
  const result = decideEnqueue(null, key);
  assert.equal(result.action, 'upsert');
  assert.equal(result.job, null, 'upsert job must be null (shell mints the UUID)');
});

test('decideEnqueue: undefined existingJob -> upsert with job:null', () => {
  const key = computeEnqueueKey(base());
  const result = decideEnqueue(undefined, key);
  assert.equal(result.action, 'upsert');
  assert.equal(result.job, null);
});

test('decideEnqueue: matching key -> reuse, returns the existing job', () => {
  const key = computeEnqueueKey(base());
  const existingJob = { key, job_id: 'qwen-job-0042', status: 'running' };
  const result = decideEnqueue(existingJob, key);
  assert.equal(result.action, 'reuse');
  assert.equal(result.job, existingJob, 'reuse must return the exact existing job object');
});

test('decideEnqueue: mismatched key (base/scope drift) -> upsert with job:null', () => {
  const key1 = computeEnqueueKey(base());
  const key2 = computeEnqueueKey({ ...base(), base: 'newbaseshadeadbeefdeadbeefdeadbeefdeadbeef' });
  const existingJob = { key: key1, job_id: 'qwen-job-0001', status: 'done' };
  const result = decideEnqueue(existingJob, key2);
  assert.equal(result.action, 'upsert', 'drifted key must trigger upsert for new identity');
  assert.equal(result.job, null);
});

test('decideEnqueue: does not mutate existingJob', () => {
  const key = computeEnqueueKey(base());
  const existingJob = { key, job_id: 'qwen-job-0099' };
  const frozen = JSON.stringify(existingJob);
  decideEnqueue(existingJob, key);
  assert.equal(JSON.stringify(existingJob), frozen, 'existingJob must not be mutated');
});

test('decideEnqueue: reuse is strict identity — existingJob.key must equal key exactly', () => {
  // A job with no key field at all should NOT accidentally match.
  const key = computeEnqueueKey(base());
  const jobWithoutKey = { job_id: 'qwen-job-0011' };
  const result = decideEnqueue(jobWithoutKey, key);
  assert.equal(result.action, 'upsert', 'a job without .key must not match');
});
