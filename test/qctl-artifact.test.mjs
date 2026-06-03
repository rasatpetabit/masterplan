// test/qctl-artifact.test.mjs — unit tests for lib/qctl-artifact.mjs
//
// Two exports:
//   verifyArtifact({ declaredSha256, bytes }) -> { ok, actualSha256, reason }
//   parseQctlDigest(raw)                      -> { task_id, status, files_changed, summary }
//
// The central invariant: sha256-mismatch => reject before any git apply.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyArtifact, parseQctlDigest } from '../lib/qctl-artifact.mjs';

// Helper: compute the real sha256 of some bytes.
function sha256hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// ==========================================================================
// verifyArtifact
// ==========================================================================

test('verifyArtifact: matching Buffer -> ok:true, correct actualSha256, reason:null', () => {
  const bytes = Buffer.from('--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-old\n+new\n');
  const declared = sha256hex(bytes);
  const result = verifyArtifact({ declaredSha256: declared, bytes });
  assert.equal(result.ok, true);
  assert.equal(result.actualSha256, declared);
  assert.equal(result.reason, null);
});

test('verifyArtifact: matching string bytes -> ok:true', () => {
  const bytes = 'patch text content here';
  const declared = sha256hex(bytes);
  const result = verifyArtifact({ declaredSha256: declared, bytes });
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test('verifyArtifact: sha256-mismatch -> ok:false, reason:sha256-mismatch (the core reject-before-apply proof)', () => {
  const bytes = Buffer.from('correct patch bytes');
  const wrongDigest = sha256hex(Buffer.from('different bytes'));
  const result = verifyArtifact({ declaredSha256: wrongDigest, bytes });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sha256-mismatch');
  // actualSha256 is the real hash of the bytes (not the declared one)
  assert.equal(result.actualSha256, sha256hex(bytes));
});

test('verifyArtifact: declared uppercase hex matches lowercase actual (case-insensitive compare)', () => {
  const bytes = Buffer.from('some patch');
  const lowercase = sha256hex(bytes);
  const uppercase = lowercase.toUpperCase();
  const result = verifyArtifact({ declaredSha256: uppercase, bytes });
  assert.equal(result.ok, true, 'uppercase declared sha256 must not false-mismatch');
  assert.equal(result.reason, null);
});

test('verifyArtifact: mixed-case hex in declared digest -> ok:true', () => {
  const bytes = Buffer.from('mixed case test');
  const lower = sha256hex(bytes);
  // Alternate upper/lower to simulate a qctl that emits mixed case
  const mixed = lower.split('').map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join('');
  const result = verifyArtifact({ declaredSha256: mixed, bytes });
  assert.equal(result.ok, true);
});

test('verifyArtifact: missing bytes -> ok:false, reason:missing-bytes', () => {
  const result = verifyArtifact({ declaredSha256: 'abc123' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-bytes');
  assert.equal(result.actualSha256, null);
});

test('verifyArtifact: null bytes -> ok:false, reason:missing-bytes', () => {
  const result = verifyArtifact({ declaredSha256: 'abc123', bytes: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-bytes');
});

test('verifyArtifact: missing declaredSha256 -> ok:false, reason:missing-declared-sha256', () => {
  const bytes = Buffer.from('patch');
  const result = verifyArtifact({ bytes });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-declared-sha256');
  assert.equal(result.actualSha256, null);
});

test('verifyArtifact: empty string declaredSha256 -> ok:false, reason:missing-declared-sha256', () => {
  const bytes = Buffer.from('patch');
  const result = verifyArtifact({ declaredSha256: '', bytes });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-declared-sha256');
});

test('verifyArtifact: called with no arguments -> ok:false, reason:missing-bytes', () => {
  const result = verifyArtifact();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-bytes');
});

test('verifyArtifact: empty Buffer is a valid input (zero-byte patch)', () => {
  const bytes = Buffer.alloc(0);
  const declared = sha256hex(bytes);
  const result = verifyArtifact({ declaredSha256: declared, bytes });
  assert.equal(result.ok, true);
});

test('verifyArtifact: does not mutate inputs', () => {
  const bytes = Buffer.from('patch data');
  const declared = sha256hex(bytes);
  const orig = bytes.toString('hex');
  verifyArtifact({ declaredSha256: declared, bytes });
  assert.equal(bytes.toString('hex'), orig, 'bytes buffer must not be mutated');
});

// ==========================================================================
// parseQctlDigest
// ==========================================================================

// A minimal valid JOB_RESULT (all IMPL_DIGEST fields present)
const FULL_JOB_RESULT = {
  job_id: 'job-42',
  idempotency_key: 'key-abc',
  task_id: 7,
  attempt: 1,
  status: 'accepted',
  base: 'abc1234',
  artifact_ref: '/var/lib/petabit-qwen-queue/jobs/42/patch.diff',
  patch_sha256: 'deadbeef',
  files_changed: ['src/foo.js', 'src/bar.js'],
  summary: 'Fixed the failing test by correcting the regex.',
};

test('parseQctlDigest: parsed object -> extracts exactly {task_id,status,files_changed,summary}', () => {
  const result = parseQctlDigest(FULL_JOB_RESULT);
  assert.deepEqual(result, {
    task_id: 7,
    status: 'accepted',
    files_changed: ['src/foo.js', 'src/bar.js'],
    summary: 'Fixed the failing test by correcting the regex.',
  });
});

test('parseQctlDigest: extra JOB_RESULT fields are dropped (job_id, artifact_ref, patch_sha256, base, attempt)', () => {
  const result = parseQctlDigest(FULL_JOB_RESULT);
  assert.equal('job_id' in result, false);
  assert.equal('artifact_ref' in result, false);
  assert.equal('patch_sha256' in result, false);
  assert.equal('base' in result, false);
  assert.equal('attempt' in result, false);
  assert.equal('idempotency_key' in result, false);
  // exactly 4 keys
  assert.deepEqual(Object.keys(result).sort(), ['files_changed', 'status', 'summary', 'task_id']);
});

test('parseQctlDigest: JSON string input -> parses and projects correctly', () => {
  const raw = JSON.stringify(FULL_JOB_RESULT);
  const result = parseQctlDigest(raw);
  assert.equal(result.task_id, 7);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.files_changed, ['src/foo.js', 'src/bar.js']);
});

test('parseQctlDigest: status is preserved verbatim — producer status NOT mapped (spec §6.2 "kept separate")', () => {
  // The status mapping (accepted->done, review->done+flag, dead-letter->failed)
  // belongs to lib/qctl-status.mjs, NOT here.
  for (const status of ['accepted', 'review', 'dead-letter']) {
    const result = parseQctlDigest({ task_id: 1, status, files_changed: [], summary: '' });
    assert.equal(result.status, status, `status '${status}' must be preserved unchanged`);
  }
});

test('parseQctlDigest: missing files_changed -> defaults to []', () => {
  const result = parseQctlDigest({ task_id: 1, status: 'accepted', summary: 'ok' });
  assert.deepEqual(result.files_changed, []);
});

test('parseQctlDigest: non-array files_changed -> defaults to []', () => {
  const result = parseQctlDigest({ task_id: 1, status: 'accepted', files_changed: 'nope', summary: '' });
  assert.deepEqual(result.files_changed, []);
});

test('parseQctlDigest: missing summary -> defaults to empty string', () => {
  const result = parseQctlDigest({ task_id: 1, status: 'accepted', files_changed: [] });
  assert.equal(result.summary, '');
});

test('parseQctlDigest: missing task_id -> defaults to null', () => {
  const result = parseQctlDigest({ status: 'accepted', files_changed: [], summary: 'x' });
  assert.equal(result.task_id, null);
});

test('parseQctlDigest: missing status -> defaults to null', () => {
  const result = parseQctlDigest({ task_id: 5, files_changed: [], summary: 'x' });
  assert.equal(result.status, null);
});

test('parseQctlDigest: malformed JSON string -> sentinel (null task_id, null status, empty arrays)', () => {
  const result = parseQctlDigest('{not valid json}');
  assert.equal(result.task_id, null);
  assert.equal(result.status, null);
  assert.deepEqual(result.files_changed, []);
  assert.equal(result.summary, '');
});

test('parseQctlDigest: null raw -> sentinel', () => {
  const result = parseQctlDigest(null);
  assert.equal(result.task_id, null);
  assert.deepEqual(result.files_changed, []);
});

test('parseQctlDigest: undefined raw -> sentinel', () => {
  const result = parseQctlDigest(undefined);
  assert.equal(result.task_id, null);
});

test('parseQctlDigest: number raw -> sentinel (not a valid object or string)', () => {
  const result = parseQctlDigest(42);
  assert.equal(result.task_id, null);
  assert.equal(result.status, null);
});

test('parseQctlDigest: does not mutate the input object', () => {
  const input = { ...FULL_JOB_RESULT };
  const snapshot = JSON.stringify(input);
  parseQctlDigest(input);
  assert.equal(JSON.stringify(input), snapshot);
});
