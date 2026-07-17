// test/adsp-idempotency.test.mjs — handoff-idempotency key module (lib/adsp-idempotency.mjs).
//
// Verified behaviors:
//   1. canonicalJson is stable under object key reordering (at every depth).
//   2. computeTaskSpecHash: stable under reordering; changes with body/context/workerConfig.
//   3. computeInputFingerprint: deterministic; changes with any input; validates args.
//   4. composeHandoffKey: binds ALL FOUR parts; encodes ':' in ids; validates hashes.
//   5. decideReuse: reuses only on full-key match + 'done' status; a changed
//      input fingerprint NEVER reuses a stale result (the review-fix case).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDEMPOTENCY_VERSION,
  canonicalJson,
  canonicalHash,
  computeTaskSpecHash,
  computeInputFingerprint,
  composeHandoffKey,
  decideReuse,
} from '../lib/adsp-idempotency.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const body = () => ({
  task_id: 35,
  description: 'Design and implement the pure handoff-idempotency key module',
  files: ['lib/adsp-idempotency.mjs'],
  verify_commands: ['node --test test/adsp-idempotency.test.mjs'],
});

const specArgs = () => ({
  body: body(),
  context: { wave: 2, run: 'agentic-platform-unification' },
  workerConfig: { class: 'bounded-edit', tier: 'qwen36-27b' },
});

const fpArgs = () => ({
  head: 'a'.repeat(40),
  dirtyDigest: 'b'.repeat(64),
  policyVersion: 'policy-v3',
  workerVersion: 'worker-digest@8.1.0',
});

// ---------------------------------------------------------------------------
// 1. canonicalJson stability
// ---------------------------------------------------------------------------

test('canonicalJson is identical under key reordering at every depth', () => {
  const a = { x: 1, y: { b: [1, 2], a: 'z' }, w: null };
  const b = { w: null, y: { a: 'z', b: [1, 2] }, x: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test('canonicalJson preserves array order (arrays are not sorted)', () => {
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
});

test('canonicalJson omits undefined-valued keys like JSON.stringify', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
});

test('canonicalJson rejects non-finite numbers', () => {
  assert.throws(() => canonicalJson({ a: Infinity }), TypeError);
});

test('canonicalHash is a 64-char sha256 hex and stable under reordering', () => {
  const h1 = canonicalHash({ a: 1, b: 2 });
  const h2 = canonicalHash({ b: 2, a: 1 });
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(h1, h2);
});

// ---------------------------------------------------------------------------
// 2. computeTaskSpecHash
// ---------------------------------------------------------------------------

test('computeTaskSpecHash is stable under key reordering of body/context/config', () => {
  const h1 = computeTaskSpecHash(specArgs());
  const reordered = {
    workerConfig: { tier: 'qwen36-27b', class: 'bounded-edit' },
    context: { run: 'agentic-platform-unification', wave: 2 },
    body: {
      verify_commands: ['node --test test/adsp-idempotency.test.mjs'],
      files: ['lib/adsp-idempotency.mjs'],
      description: 'Design and implement the pure handoff-idempotency key module',
      task_id: 35,
    },
  };
  assert.equal(h1, computeTaskSpecHash(reordered));
});

test('computeTaskSpecHash changes when the task body changes (replan)', () => {
  const base = computeTaskSpecHash(specArgs());
  const replanned = specArgs();
  replanned.body.description = 'REPLANNED: different brief';
  assert.notEqual(base, computeTaskSpecHash(replanned));
});

test('computeTaskSpecHash changes when context or workerConfig changes', () => {
  const base = computeTaskSpecHash(specArgs());
  const ctx = specArgs();
  ctx.context = { wave: 3, run: 'agentic-platform-unification' };
  assert.notEqual(base, computeTaskSpecHash(ctx));
  const cfg = specArgs();
  cfg.workerConfig = { class: 'agentic-loop', tier: 'glm-5.2' };
  assert.notEqual(base, computeTaskSpecHash(cfg));
});

test('computeTaskSpecHash requires a body object', () => {
  assert.throws(() => computeTaskSpecHash({}), TypeError);
  assert.throws(() => computeTaskSpecHash(), TypeError);
});

// ---------------------------------------------------------------------------
// 3. computeInputFingerprint
// ---------------------------------------------------------------------------

test('computeInputFingerprint is deterministic for identical inputs', () => {
  assert.equal(computeInputFingerprint(fpArgs()), computeInputFingerprint(fpArgs()));
});

test('computeInputFingerprint changes with each individual input', () => {
  const base = computeInputFingerprint(fpArgs());
  for (const [k, v] of [
    ['head', 'c'.repeat(40)],
    ['dirtyDigest', 'd'.repeat(64)],
    ['policyVersion', 'policy-v4'],
    ['workerVersion', 'worker-digest@9.0.0'],
  ]) {
    assert.notEqual(base, computeInputFingerprint({ ...fpArgs(), [k]: v }), `changing ${k} must change the fingerprint`);
  }
});

test('computeInputFingerprint requires all four string inputs', () => {
  assert.throws(() => computeInputFingerprint({ ...fpArgs(), head: undefined }), TypeError);
  assert.throws(() => computeInputFingerprint({ ...fpArgs(), dirtyDigest: 42 }), TypeError);
  assert.throws(() => computeInputFingerprint(), TypeError);
});

// ---------------------------------------------------------------------------
// 4. composeHandoffKey
// ---------------------------------------------------------------------------

test('composeHandoffKey binds run, task, spec hash AND input fingerprint', () => {
  const spec = computeTaskSpecHash(specArgs());
  const fp = computeInputFingerprint(fpArgs());
  const key = composeHandoffKey('my-run', 35, spec, fp);
  assert.equal(key, `${IDEMPOTENCY_VERSION}:my-run:35:${spec}:${fp}`);
  // Every part changes the key.
  assert.notEqual(key, composeHandoffKey('other-run', 35, spec, fp));
  assert.notEqual(key, composeHandoffKey('my-run', 36, spec, fp));
  const otherSpec = computeTaskSpecHash({ ...specArgs(), context: { changed: true } });
  assert.notEqual(key, composeHandoffKey('my-run', 35, otherSpec, fp));
  const otherFp = computeInputFingerprint({ ...fpArgs(), head: 'e'.repeat(40) });
  assert.notEqual(key, composeHandoffKey('my-run', 35, spec, otherFp));
});

test('composeHandoffKey encodes colons in run/task ids unambiguously', () => {
  const spec = computeTaskSpecHash(specArgs());
  const fp = computeInputFingerprint(fpArgs());
  const key = composeHandoffKey('run:a', 'b', spec, fp);
  const key2 = composeHandoffKey('run', 'a:b', spec, fp);
  assert.notEqual(key, key2);
});

test('composeHandoffKey validates its parts', () => {
  const spec = computeTaskSpecHash(specArgs());
  const fp = computeInputFingerprint(fpArgs());
  assert.throws(() => composeHandoffKey('', 35, spec, fp), TypeError);
  assert.throws(() => composeHandoffKey('run', null, spec, fp), TypeError);
  assert.throws(() => composeHandoffKey('run', 35, 'not-a-hash', fp), TypeError);
  assert.throws(() => composeHandoffKey('run', 35, spec, 'not-a-hash'), TypeError);
});

// ---------------------------------------------------------------------------
// 5. decideReuse — reuse-vs-rerun predicate
// ---------------------------------------------------------------------------

function keys() {
  const spec = computeTaskSpecHash(specArgs());
  const fp = computeInputFingerprint(fpArgs());
  return { spec, fp, key: composeHandoffKey('my-run', 35, spec, fp) };
}

test('decideReuse: unchanged item against unchanged inputs is a no-op read (reuse)', () => {
  const { key } = keys();
  const prior = { handoff_key: key, status: 'done' };
  const d = decideReuse({ priorRecord: prior, currentKey: key });
  assert.equal(d.reuse, true);
});

test('decideReuse: no prior record means rerun', () => {
  const { key } = keys();
  assert.equal(decideReuse({ priorRecord: null, currentKey: key }).reuse, false);
});

test('decideReuse: replanned task body (changed spec hash) never reuses', () => {
  const { key, fp } = keys();
  const replanned = specArgs();
  replanned.body.description = 'REPLANNED';
  const newKey = composeHandoffKey('my-run', 35, computeTaskSpecHash(replanned), fp);
  const prior = { handoff_key: key, status: 'done' };
  assert.equal(decideReuse({ priorRecord: prior, currentKey: newKey }).reuse, false);
});

test('decideReuse: changed input fingerprint NEVER reuses a stale result (review fix)', () => {
  const { key, spec } = keys();
  // Same run, same task, same task_spec_hash — only the repo/policy state moved.
  const newFp = computeInputFingerprint({ ...fpArgs(), head: 'f'.repeat(40) });
  const newKey = composeHandoffKey('my-run', 35, spec, newFp);
  assert.notEqual(key, newKey, 'fingerprint must be part of the composed key');
  const prior = { handoff_key: key, status: 'done' };
  const d = decideReuse({ priorRecord: prior, currentKey: newKey });
  assert.equal(d.reuse, false);
  assert.match(d.reason, /mismatch/);
});

test('decideReuse: dirty-state change alone forces rerun', () => {
  const { key, spec } = keys();
  const newFp = computeInputFingerprint({ ...fpArgs(), dirtyDigest: '0'.repeat(64) });
  const newKey = composeHandoffKey('my-run', 35, spec, newFp);
  const prior = { handoff_key: key, status: 'done' };
  assert.equal(decideReuse({ priorRecord: prior, currentKey: newKey }).reuse, false);
});

test('decideReuse: non-done prior statuses are not reusable', () => {
  const { key } = keys();
  for (const status of ['failed', 'blocked', 'pending', 'claimed', 'cancelled']) {
    const d = decideReuse({ priorRecord: { handoff_key: key, status }, currentKey: key });
    assert.equal(d.reuse, false, `status '${status}' must not reuse`);
  }
});

test('decideReuse: prior record without handoff_key is not reusable', () => {
  const { key } = keys();
  assert.equal(decideReuse({ priorRecord: { status: 'done' }, currentKey: key }).reuse, false);
});

test('decideReuse requires currentKey', () => {
  assert.throws(() => decideReuse({ priorRecord: null }), TypeError);
});
