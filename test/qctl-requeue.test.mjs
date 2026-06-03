// test/qctl-requeue.test.mjs — base-drift requeue decision truth table.
//
// Safety invariant: the ONLY way to get action:'apply' is when recordedBase and
// currentHead are both present, non-empty strings that match exactly. Every
// other case — drift, missing SHAs, null — must produce action:'requeue' with
// requeueBase === currentHead (the exact parent SHA the shell currently has).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBaseDrift } from '../lib/qctl-requeue.mjs';

const SHA_A = 'aabbccdd1122334455667788aabbccdd11223344';
const SHA_B = 'fedcba9876543210fedcba9876543210fedcba98';

// --- apply path: bases match exactly ---

test('matching SHAs -> apply, requeueBase null', () => {
  const d = decideBaseDrift({ recordedBase: SHA_A, currentHead: SHA_A, declaredScope: [] });
  assert.equal(d.action, 'apply');
  assert.equal(d.requeueBase, null);
});

test('apply path: declaredScope is ignored (different values, same SHA pair)', () => {
  const d1 = decideBaseDrift({ recordedBase: SHA_A, currentHead: SHA_A, declaredScope: [] });
  const d2 = decideBaseDrift({ recordedBase: SHA_A, currentHead: SHA_A, declaredScope: ['lib/foo.mjs', 'test/foo.test.mjs'] });
  assert.equal(d1.action, 'apply');
  assert.equal(d2.action, 'apply');
});

// --- requeue path: base has drifted ---

test('drift (recordedBase !== currentHead) -> requeue, requeueBase === currentHead', () => {
  const d = decideBaseDrift({ recordedBase: SHA_A, currentHead: SHA_B, declaredScope: [] });
  assert.equal(d.action, 'requeue');
  assert.equal(d.requeueBase, SHA_B);
});

// --- requeue invariant over a range of drift scenarios ---
// For any pair where recordedBase !== currentHead we must always requeue.
test('requeue invariant: diverse drift pairs always produce requeue with requeueBase=currentHead', () => {
  const driftPairs = [
    { recordedBase: SHA_A, currentHead: SHA_B },
    { recordedBase: SHA_B, currentHead: SHA_A },
    { recordedBase: 'abc', currentHead: 'def' },
    { recordedBase: '0000000000000000000000000000000000000001',
      currentHead: '0000000000000000000000000000000000000002' },
  ];
  for (const { recordedBase, currentHead } of driftPairs) {
    const d = decideBaseDrift({ recordedBase, currentHead, declaredScope: [] });
    assert.equal(d.action, 'requeue', `expected requeue for ${recordedBase} vs ${currentHead}`);
    assert.equal(d.requeueBase, currentHead, `expected requeueBase===currentHead for ${currentHead}`);
  }
});

// --- requeue path: missing / null / undefined SHAs ---

test('recordedBase null -> requeue, requeueBase === currentHead', () => {
  const d = decideBaseDrift({ recordedBase: null, currentHead: SHA_A });
  assert.equal(d.action, 'requeue');
  assert.equal(d.requeueBase, SHA_A);
});

test('recordedBase undefined -> requeue', () => {
  const d = decideBaseDrift({ recordedBase: undefined, currentHead: SHA_A });
  assert.equal(d.action, 'requeue');
  assert.equal(d.requeueBase, SHA_A);
});

test('recordedBase empty string -> requeue (not a valid SHA)', () => {
  const d = decideBaseDrift({ recordedBase: '', currentHead: SHA_A });
  assert.equal(d.action, 'requeue');
  assert.equal(d.requeueBase, SHA_A);
});

test('currentHead null -> requeue, requeueBase null (no valid target to requeue against)', () => {
  const d = decideBaseDrift({ recordedBase: SHA_A, currentHead: null });
  assert.equal(d.action, 'requeue');
  assert.equal(d.requeueBase, null);
});

test('currentHead undefined -> requeue, requeueBase null', () => {
  const d = decideBaseDrift({ recordedBase: SHA_A, currentHead: undefined });
  assert.equal(d.action, 'requeue');
  assert.equal(d.requeueBase, null);
});

test('currentHead empty string -> requeue, requeueBase null', () => {
  const d = decideBaseDrift({ recordedBase: SHA_A, currentHead: '' });
  assert.equal(d.action, 'requeue');
  assert.equal(d.requeueBase, null);
});

test('both SHAs null -> requeue, requeueBase null', () => {
  const d = decideBaseDrift({ recordedBase: null, currentHead: null });
  assert.equal(d.action, 'requeue');
  assert.equal(d.requeueBase, null);
});

test('empty args object -> requeue, requeueBase null', () => {
  const d = decideBaseDrift({});
  assert.equal(d.action, 'requeue');
  assert.equal(d.requeueBase, null);
});

test('no args at all -> requeue, requeueBase null', () => {
  const d = decideBaseDrift();
  assert.equal(d.action, 'requeue');
  assert.equal(d.requeueBase, null);
});

// --- declaredScope does not influence the decision ---

test('declaredScope present but bases match -> apply (scope is not a discriminator)', () => {
  const d = decideBaseDrift({
    recordedBase: SHA_A,
    currentHead: SHA_A,
    declaredScope: ['lib/routing.mjs', 'test/routing.test.mjs'],
  });
  assert.equal(d.action, 'apply');
});

test('declaredScope present with drift -> requeue, requeueBase === currentHead', () => {
  const d = decideBaseDrift({
    recordedBase: SHA_A,
    currentHead: SHA_B,
    declaredScope: ['lib/routing.mjs'],
  });
  assert.equal(d.action, 'requeue');
  assert.equal(d.requeueBase, SHA_B);
});

// --- no mutation ---

test('does not mutate input object', () => {
  const input = { recordedBase: SHA_A, currentHead: SHA_B, declaredScope: ['x.mjs'] };
  const frozen = JSON.stringify(input);
  decideBaseDrift(input);
  assert.equal(JSON.stringify(input), frozen);
});

// --- output shape is stable ---

test('apply result has exactly {action, requeueBase} keys', () => {
  const d = decideBaseDrift({ recordedBase: SHA_A, currentHead: SHA_A });
  assert.deepEqual(Object.keys(d).sort(), ['action', 'requeueBase']);
});

test('requeue result has exactly {action, requeueBase} keys', () => {
  const d = decideBaseDrift({ recordedBase: SHA_A, currentHead: SHA_B });
  assert.deepEqual(Object.keys(d).sort(), ['action', 'requeueBase']);
});
