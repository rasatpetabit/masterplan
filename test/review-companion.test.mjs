// test/review-companion.test.mjs — the durable whole-branch review re-entry guard
// (`selectCodexReviewForHead`), moved out of the retired codex-companion module. Pure: an
// events.jsonl text + a HEAD sha in, a {present,digest,count,base} record out. No fs, no process —
// the file read lives in the `adversary-review-status` subcommand. The plugin-path resolvers that
// used to live alongside it (selectCodexInstall / companionScriptPath) are deleted with the
// codex-companion subsystem; only this re-entry guard survives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCodexReviewForHead } from '../lib/review-companion.mjs';

// A realistic events.jsonl text: each line one JSON event record (as `mp event` appends them).
const HEAD = 'aaaa111';
const lines = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('selectCodexReviewForHead: present (new adversary_review) at HEAD → {present, digest, count, base}', () => {
  const text = lines(
    { type: 'verification', ts: 't0', summary: 'suite green' },
    {
      type: 'adversary_review',
      ts: 't1',
      summary: 'adversary review complete (whole-branch, base main) — 2 findings',
      data: { sha: HEAD, base: 'main', count: 2 },
      note: 'P2: stale lock; P3: naming',
    },
  );
  assert.deepEqual(selectCodexReviewForHead(text, HEAD), {
    present: true,
    digest: 'P2: stale lock; P3: naming',
    count: 2,
    base: 'main',
  });
});

test('selectCodexReviewForHead: a LEGACY codex_review record still satisfies the guard (in-flight bundles)', () => {
  // A run started before the rename writes type:'codex_review'; a resume after the rename must
  // recognise it and NOT re-review the same tree.
  const text = lines({
    type: 'codex_review',
    ts: 't1',
    summary: 'codex review complete (whole-branch, base main) — 2 findings',
    data: { sha: HEAD, base: 'main', count: 2 },
    note: 'legacy digest',
  });
  assert.deepEqual(selectCodexReviewForHead(text, HEAD), {
    present: true, digest: 'legacy digest', count: 2, base: 'main',
  });
});

test('selectCodexReviewForHead: no record for this sha → {present:false}', () => {
  const text = lines({ type: 'adversary_review', data: { sha: 'other999', base: 'main', count: 1 }, note: 'x' });
  assert.deepEqual(selectCodexReviewForHead(text, HEAD), { present: false, digest: null, count: null, base: null });
});

test('selectCodexReviewForHead: a clean zero-findings review is still present (count:0, not absent)', () => {
  const text = lines({ type: 'adversary_review', data: { sha: HEAD, base: 'main', count: 0 }, note: 'no findings' });
  assert.deepEqual(selectCodexReviewForHead(text, HEAD), { present: true, digest: 'no findings', count: 0, base: 'main' });
});

test('selectCodexReviewForHead: a *_review_skipped (degraded) record is ignored (both families)', () => {
  for (const type of ['adversary_review_skipped', 'codex_review_skipped']) {
    const text = lines({ type, summary: 'whole-branch adversary-review skipped (degraded) — no network', data: { sha: HEAD } });
    assert.deepEqual(selectCodexReviewForHead(text, HEAD), { present: false, digest: null, count: null, base: null });
  }
});

test('selectCodexReviewForHead: last matching line at the sha wins (a re-review supersedes)', () => {
  const text = lines(
    { type: 'adversary_review', data: { sha: HEAD, base: 'main', count: 5 }, note: 'first pass' },
    { type: 'adversary_review', data: { sha: HEAD, base: 'main', count: 1 }, note: 'second pass' },
  );
  const got = selectCodexReviewForHead(text, HEAD);
  assert.equal(got.count, 1);
  assert.equal(got.digest, 'second pass');
});

test('selectCodexReviewForHead: blank + malformed lines are skipped, not fatal', () => {
  const text =
    '\n' +
    'not json at all\n' +
    JSON.stringify({ type: 'adversary_review', data: { sha: HEAD, base: 'main', count: 3 }, note: 'ok' }) +
    '\n\n';
  assert.deepEqual(selectCodexReviewForHead(text, HEAD), { present: true, digest: 'ok', count: 3, base: 'main' });
});

test('selectCodexReviewForHead: empty text / empty sha / non-string → {present:false} (no throw)', () => {
  const absent = { present: false, digest: null, count: null, base: null };
  assert.deepEqual(selectCodexReviewForHead('', HEAD), absent);
  assert.deepEqual(selectCodexReviewForHead(lines({ type: 'adversary_review', data: { sha: HEAD } }), ''), absent);
  assert.deepEqual(selectCodexReviewForHead(null, HEAD), absent);
  assert.deepEqual(selectCodexReviewForHead('{}', HEAD), absent);
});

test('selectCodexReviewForHead: record missing note/count normalizes to null (not undefined)', () => {
  const text = lines({ type: 'adversary_review', data: { sha: HEAD, base: 'main' } });
  assert.deepEqual(selectCodexReviewForHead(text, HEAD), { present: true, digest: null, count: null, base: 'main' });
});
