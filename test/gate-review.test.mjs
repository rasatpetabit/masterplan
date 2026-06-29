// test/gate-review.test.mjs — the pure spec/plan gate re-entry guard (`selectGateReview`). Like the
// finish guard's test, but for the two pre-execute gates, and exercising the two deliberate
// inversions: keyed on data.hash (content), and a *_skipped record SATISFIES the gate (fail-soft).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectGateReview, gateEventTypes, validateGateReceipt } from '../lib/gate-review.mjs';

const HASH = 'sha256:deadbeef';
const lines = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('selectGateReview: present (done) at hash → {present, status:done, digest, count, base}', () => {
  const text = lines(
    { type: 'text', ts: 't0', summary: 'spec written' },
    {
      type: 'spec_adversary_review',
      ts: 't1',
      summary: 'adversary review complete (spec) — 2 findings',
      data: { hash: HASH, base: null, count: 2 },
      note: 'P2: dataflow gap; P3: naming',
    },
  );
  assert.deepEqual(selectGateReview(text, 'spec', HASH), {
    present: true,
    status: 'done',
    digest: 'P2: dataflow gap; P3: naming',
    count: 2,
    base: null,
  });
});

test('selectGateReview: a *_skipped (degraded) record SATISFIES the gate (fail-soft — inverse of finish guard)', () => {
  const text = lines({
    type: 'plan_adversary_review_skipped',
    ts: 't1',
    summary: 'plan adversary-review skipped (degraded) — lane unavailable',
    data: { hash: HASH },
    note: 'skipped: gateway down',
  });
  assert.deepEqual(selectGateReview(text, 'plan', HASH), {
    present: true,
    status: 'skipped',
    digest: 'skipped: gateway down',
    count: null,
    base: null,
  });
});

test('selectGateReview: no record at this hash → {present:false} (edited artifact re-arms the gate)', () => {
  const text = lines({ type: 'spec_adversary_review', data: { hash: 'sha256:other', count: 1 }, note: 'x' });
  assert.deepEqual(selectGateReview(text, 'spec', HASH), {
    present: false, status: null, digest: null, count: null, base: null,
  });
});

test('selectGateReview: a clean zero-findings review is present (count:0, not absent)', () => {
  const text = lines({ type: 'plan_adversary_review', data: { hash: HASH, count: 0 }, note: 'no findings' });
  assert.deepEqual(selectGateReview(text, 'plan', HASH), {
    present: true, status: 'done', digest: 'no findings', count: 0, base: null,
  });
});

test('selectGateReview: the gates are distinct — a spec record does NOT satisfy the plan gate', () => {
  const text = lines({ type: 'spec_adversary_review', data: { hash: HASH, count: 1 }, note: 'spec ok' });
  assert.equal(selectGateReview(text, 'spec', HASH).present, true);
  assert.equal(selectGateReview(text, 'plan', HASH).present, false);
});

test('selectGateReview: last matching line at the hash wins (a re-review supersedes)', () => {
  const text = lines(
    { type: 'spec_adversary_review', data: { hash: HASH, count: 5 }, note: 'first pass' },
    { type: 'spec_adversary_review_skipped', data: { hash: HASH }, note: 'second pass (skip)' },
  );
  const got = selectGateReview(text, 'spec', HASH);
  assert.equal(got.status, 'skipped');
  assert.equal(got.digest, 'second pass (skip)');
});

test('selectGateReview: blank + malformed lines are skipped, not fatal', () => {
  const text =
    '\n' +
    'not json at all\n' +
    JSON.stringify({ type: 'plan_adversary_review', data: { hash: HASH, base: 'main', count: 3 }, note: 'ok' }) +
    '\n\n';
  assert.deepEqual(selectGateReview(text, 'plan', HASH), {
    present: true, status: 'done', digest: 'ok', count: 3, base: 'main',
  });
});

test('selectGateReview: empty text / empty hash / non-string → {present:false} (no throw)', () => {
  const absent = { present: false, status: null, digest: null, count: null, base: null };
  assert.deepEqual(selectGateReview('', 'spec', HASH), absent);
  assert.deepEqual(selectGateReview(lines({ type: 'spec_adversary_review', data: { hash: HASH } }), 'spec', ''), absent);
  assert.deepEqual(selectGateReview(null, 'spec', HASH), absent);
  assert.deepEqual(selectGateReview('{}', 'spec', HASH), absent);
});

test('selectGateReview: record missing note/count/base normalizes to null (not undefined)', () => {
  const text = lines({ type: 'spec_adversary_review', data: { hash: HASH } });
  assert.deepEqual(selectGateReview(text, 'spec', HASH), {
    present: true, status: 'done', digest: null, count: null, base: null,
  });
});

test('gateEventTypes: unknown gate throws (caller bug, not data)', () => {
  assert.throws(() => gateEventTypes('finish'), /unknown gate/);
  assert.throws(() => selectGateReview('', 'bogus', HASH), /unknown gate/);
  assert.deepEqual(gateEventTypes('spec'), { done: 'spec_adversary_review', skipped: 'spec_adversary_review_skipped' });
  assert.deepEqual(gateEventTypes('plan'), { done: 'plan_adversary_review', skipped: 'plan_adversary_review_skipped' });
});

// ── validateGateReceipt (the structured `done` receipt binding) ──────────────────────────────────
const GATE_CTX = { gate: 'plan', hash: 'sha256:abc123', artifacts: ['spec.md', 'plan.md', 'plan.index.json'] };
const goodReceipt = (over = {}) => ({
  gate: 'plan',
  hash: 'sha256:abc123',
  artifacts: ['plan.index.json', 'spec.md', 'plan.md'], // order-insensitive (set compare)
  dispatch_id: 'disp-1',
  provider: 'skynet',
  model: 'gpt-5.5',
  output_tokens: 4096,
  status: 'done',
  ts: '2026-06-25T00:00:00Z',
  digest: 'P1: none; P2: tighten error path',
  ...over,
});

test('validateGateReceipt: a complete, matching receipt is accepted (artifact order-insensitive)', () => {
  const v = validateGateReceipt(goodReceipt(), GATE_CTX);
  assert.equal(v.ok, true);
  assert.deepEqual(v.normalized.artifacts, ['plan.index.json', 'plan.md', 'spec.md']); // sorted
  assert.equal(v.normalized.output_tokens, 4096);
});

test('validateGateReceipt: completion_tokens is accepted as an alias for output_tokens', () => {
  const r = goodReceipt();
  delete r.output_tokens;
  r.completion_tokens = 12;
  const v = validateGateReceipt(r, GATE_CTX);
  assert.equal(v.ok, true);
  assert.equal(v.normalized.output_tokens, 12);
});

test('validateGateReceipt: rejects a hash that does not echo the recomputed hash', () => {
  const v = validateGateReceipt(goodReceipt({ hash: 'sha256:stale' }), GATE_CTX);
  assert.equal(v.ok, false);
  assert.match(v.error, /hash/);
});

test('validateGateReceipt: rejects a gate mismatch', () => {
  const v = validateGateReceipt(goodReceipt({ gate: 'spec' }), GATE_CTX);
  assert.equal(v.ok, false);
  assert.match(v.error, /gate/);
});

test('validateGateReceipt: rejects an artifact set that is not equal (missing one)', () => {
  const v = validateGateReceipt(goodReceipt({ artifacts: ['spec.md', 'plan.md'] }), GATE_CTX);
  assert.equal(v.ok, false);
  assert.match(v.error, /artifacts/);
});

test('validateGateReceipt: rejects zero / non-positive token counts (a real lane produces tokens)', () => {
  assert.equal(validateGateReceipt(goodReceipt({ output_tokens: 0 }), GATE_CTX).ok, false);
  assert.equal(validateGateReceipt(goodReceipt({ output_tokens: -1 }), GATE_CTX).ok, false);
  const noTok = goodReceipt();
  delete noTok.output_tokens;
  assert.equal(validateGateReceipt(noTok, GATE_CTX).ok, false);
});

test('validateGateReceipt: rejects empty provenance (dispatch_id/provider/model) and empty digest', () => {
  assert.match(validateGateReceipt(goodReceipt({ dispatch_id: '' }), GATE_CTX).error, /dispatch_id/);
  assert.match(validateGateReceipt(goodReceipt({ provider: '   ' }), GATE_CTX).error, /provider/);
  assert.match(validateGateReceipt(goodReceipt({ model: '' }), GATE_CTX).error, /model/);
  assert.match(validateGateReceipt(goodReceipt({ digest: '' }), GATE_CTX).error, /digest/);
});

test('validateGateReceipt: rejects status != done, and non-object receipts', () => {
  assert.match(validateGateReceipt(goodReceipt({ status: 'skipped' }), GATE_CTX).error, /status/);
  assert.equal(validateGateReceipt(null, GATE_CTX).ok, false);
  assert.equal(validateGateReceipt([], GATE_CTX).ok, false);
  assert.equal(validateGateReceipt('{}', GATE_CTX).ok, false);
});
