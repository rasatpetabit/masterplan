// test/qctl-status.test.mjs — unit tests for lib/qctl-status.mjs (pure status mapping).
// Covers spec §6.2 results-contract status semantics:
//   accepted→done, review→done+claude-review, dead-letter→failed;
//   L1 apply failure OVERRIDES to blocked; D6 verify-scope failure OVERRIDES to failed;
//   producer_status always echoes the raw input (never collapsed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapQctlStatus } from '../lib/qctl-status.mjs';

// --- base table: producer gate status → task status, no overrides ---

test('accepted -> done, no flags', () => {
  const r = mapQctlStatus({ producerStatus: 'accepted' });
  assert.equal(r.task_status, 'done');
  assert.deepEqual(r.flags, []);
  assert.equal(r.producer_status, 'accepted');
});

test('review -> done, claude-review flag (gate-green but human sign-off pending)', () => {
  const r = mapQctlStatus({ producerStatus: 'review' });
  assert.equal(r.task_status, 'done');
  assert.deepEqual(r.flags, ['claude-review']);
  assert.equal(r.producer_status, 'review');
});

test('dead-letter -> failed, no flags', () => {
  const r = mapQctlStatus({ producerStatus: 'dead-letter' });
  assert.equal(r.task_status, 'failed');
  assert.deepEqual(r.flags, []);
  assert.equal(r.producer_status, 'dead-letter');
});

test('unknown producerStatus -> failed, unknown-producer-status flag', () => {
  const r = mapQctlStatus({ producerStatus: 'unrecognized' });
  assert.equal(r.task_status, 'failed');
  assert.ok(r.flags.includes('unknown-producer-status'), 'unknown-producer-status flag expected');
  assert.equal(r.producer_status, 'unrecognized');
});

// --- apply failure override: blocked regardless of producer status ---

test('accepted + applyResult.ok=false -> blocked (patch did not apply; cannot proceed)', () => {
  const r = mapQctlStatus({ producerStatus: 'accepted', applyResult: { ok: false } });
  assert.equal(r.task_status, 'blocked');
  assert.equal(r.producer_status, 'accepted');
});

test('review + applyResult.ok=false -> blocked, claude-review flag SURVIVES (lossless)', () => {
  const r = mapQctlStatus({ producerStatus: 'review', applyResult: { ok: false } });
  assert.equal(r.task_status, 'blocked');
  // The claude-review flag records the producer's gate result independently of disposition.
  assert.ok(r.flags.includes('claude-review'), 'claude-review flag must survive an apply override');
  assert.equal(r.producer_status, 'review');
});

test('dead-letter + applyResult.ok=false -> blocked (override wins over base-table failed)', () => {
  const r = mapQctlStatus({ producerStatus: 'dead-letter', applyResult: { ok: false } });
  assert.equal(r.task_status, 'blocked');
  assert.equal(r.producer_status, 'dead-letter');
});

// --- d6 failure override: failed regardless of producer status ---

test('accepted + d6Result.ok=false -> failed (patch applied but scope/verify failed)', () => {
  const r = mapQctlStatus({ producerStatus: 'accepted', d6Result: { ok: false } });
  assert.equal(r.task_status, 'failed');
  assert.equal(r.producer_status, 'accepted');
});

test('review + d6Result.ok=false -> failed, claude-review flag SURVIVES (lossless)', () => {
  const r = mapQctlStatus({ producerStatus: 'review', d6Result: { ok: false } });
  assert.equal(r.task_status, 'failed');
  assert.ok(r.flags.includes('claude-review'), 'claude-review flag must survive a d6 override');
  assert.equal(r.producer_status, 'review');
});

test('dead-letter + d6Result.ok=false -> failed (d6 override; same as base but for different reason)', () => {
  const r = mapQctlStatus({ producerStatus: 'dead-letter', d6Result: { ok: false } });
  assert.equal(r.task_status, 'failed');
  assert.equal(r.producer_status, 'dead-letter');
});

// --- apply takes precedence over d6 (apply runs first; d6 never runs if apply fails) ---

test('apply-fail + d6-fail -> blocked (apply override wins; apply is checked first)', () => {
  const r = mapQctlStatus({
    producerStatus: 'accepted',
    applyResult: { ok: false },
    d6Result: { ok: false },
  });
  assert.equal(r.task_status, 'blocked');
  assert.equal(r.producer_status, 'accepted');
});

// --- applyResult/d6Result undefined (stage not evaluated) -> no override ---

test('accepted + applyResult undefined -> no override -> done', () => {
  const r = mapQctlStatus({ producerStatus: 'accepted', applyResult: undefined });
  assert.equal(r.task_status, 'done');
});

test('accepted + d6Result undefined -> no override -> done', () => {
  const r = mapQctlStatus({ producerStatus: 'accepted', d6Result: undefined });
  assert.equal(r.task_status, 'done');
});

test('applyResult.ok=true (apply succeeded) -> no override', () => {
  const r = mapQctlStatus({ producerStatus: 'accepted', applyResult: { ok: true } });
  assert.equal(r.task_status, 'done');
});

test('d6Result.ok=true (d6 passed) -> no override', () => {
  const r = mapQctlStatus({ producerStatus: 'accepted', d6Result: { ok: true } });
  assert.equal(r.task_status, 'done');
});

// --- producer_status is ALWAYS the raw input (lossless / never collapsed) ---

test('producer_status is always the raw producerStatus, even under apply override', () => {
  const r = mapQctlStatus({ producerStatus: 'accepted', applyResult: { ok: false } });
  assert.equal(r.producer_status, 'accepted', 'producer_status must not be rewritten by an override');
});

test('producer_status is always the raw producerStatus, even under d6 override', () => {
  const r = mapQctlStatus({ producerStatus: 'review', d6Result: { ok: false } });
  assert.equal(r.producer_status, 'review', 'producer_status must not be rewritten by an override');
});

test('producer_status echoes unknown values too (lossless)', () => {
  const r = mapQctlStatus({ producerStatus: 'whatever' });
  assert.equal(r.producer_status, 'whatever');
});

// --- output shape invariants ---

test('always returns exactly three keys: task_status, flags, producer_status', () => {
  const r = mapQctlStatus({ producerStatus: 'accepted' });
  assert.deepEqual(Object.keys(r).sort(), ['flags', 'producer_status', 'task_status']);
});

test('flags is always an array', () => {
  for (const ps of ['accepted', 'review', 'dead-letter', 'unknown']) {
    const r = mapQctlStatus({ producerStatus: ps });
    assert.ok(Array.isArray(r.flags), `flags must be an array for producerStatus=${ps}`);
  }
});

// --- does not mutate inputs ---

test('does not mutate the input object', () => {
  const input = { producerStatus: 'accepted', applyResult: { ok: false }, d6Result: { ok: false } };
  const frozen = JSON.stringify(input);
  mapQctlStatus(input);
  assert.equal(JSON.stringify(input), frozen);
});

// --- no-argument / partial calls (robustness) ---

test('called with empty object -> producerStatus undefined -> failed + unknown-producer-status', () => {
  const r = mapQctlStatus({});
  assert.equal(r.task_status, 'failed');
  assert.ok(r.flags.includes('unknown-producer-status'));
  assert.equal(r.producer_status, undefined);
});

test('called with no argument -> returns valid object, does not throw', () => {
  assert.doesNotThrow(() => mapQctlStatus());
  const r = mapQctlStatus();
  assert.equal(r.task_status, 'failed');
});
