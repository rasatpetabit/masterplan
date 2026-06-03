// test/codex-companion.test.mjs — the version-agnostic companion-path resolver behind
// `mp codex-companion-path` (the §2c finish-gate review's path source). Pure functions: a parsed
// installed_plugins.json object in, an install record / script path out. No fs, no process — the
// file read + existence probe live in the subcommand, so the selection logic is testable without
// a real plugin cache. Mirrors lib/finish.mjs's boundaries (see test/finish.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCodexInstall, companionScriptPath, selectCodexReviewForHead } from '../lib/codex-companion.mjs';

// A realistic installed_plugins.json fixture (shape from the live host).
const REAL = {
  version: 2,
  plugins: {
    'codex@openai-codex': [
      {
        scope: 'user',
        installPath: '/home/ras/.claude/plugins/cache/openai-codex/codex/1.0.4',
        version: '1.0.4',
        installedAt: '2026-04-22T22:41:14.070Z',
        lastUpdated: '2026-04-22T22:41:14.070Z',
        gitCommitSha: '807e03ac9d5aa23bc395fdec8c3767500a86b3cf',
      },
    ],
    'masterplan@rasatpetabit': [
      { scope: 'user', installPath: '/home/ras/.claude/plugins/cache/rasatpetabit/masterplan/8.0.0', version: '8.0.0' },
    ],
  },
};

// ---- selectCodexInstall ------------------------------------------------------

test('selectCodexInstall: resolves the active codex install from the real shape', () => {
  const got = selectCodexInstall(REAL);
  assert.deepEqual(got, {
    key: 'codex@openai-codex',
    installPath: '/home/ras/.claude/plugins/cache/openai-codex/codex/1.0.4',
    version: '1.0.4',
    scope: 'user',
  });
});

test('selectCodexInstall: null/garbage input is null (no throw)', () => {
  assert.equal(selectCodexInstall(null), null);
  assert.equal(selectCodexInstall(undefined), null);
  assert.equal(selectCodexInstall({}), null);
  assert.equal(selectCodexInstall({ plugins: null }), null);
  assert.equal(selectCodexInstall({ plugins: 'nope' }), null);
  assert.equal(selectCodexInstall('not an object'), null);
});

test('selectCodexInstall: no codex entry → null', () => {
  assert.equal(selectCodexInstall({ plugins: { 'masterplan@rasatpetabit': [{ installPath: '/x' }] } }), null);
});

test('selectCodexInstall: a codex entry with an empty record array → null', () => {
  assert.equal(selectCodexInstall({ plugins: { 'codex@openai-codex': [] } }), null);
});

test('selectCodexInstall: a record with no installPath → null', () => {
  assert.equal(selectCodexInstall({ plugins: { 'codex@openai-codex': [{ scope: 'user', version: '1.0.4' }] } }), null);
});

test('selectCodexInstall: matches the literal codex plugin, not a codex-prefixed sibling', () => {
  // Stricter than the doctor's startsWith('codex') probe — we want the real codex plugin only.
  const got = selectCodexInstall({ plugins: { 'codex-helper@vendor': [{ scope: 'user', installPath: '/x', version: '0.1.0' }] } });
  assert.equal(got, null);
});

test('selectCodexInstall: a bare key with no @marketplace still matches on the name', () => {
  const got = selectCodexInstall({ plugins: { codex: [{ scope: 'user', installPath: '/c', version: '2.0.0' }] } });
  assert.equal(got.key, 'codex');
  assert.equal(got.installPath, '/c');
});

test('selectCodexInstall: among multiple scopes, prefers scope user', () => {
  const got = selectCodexInstall({
    plugins: {
      'codex@openai-codex': [
        { scope: 'project', installPath: '/proj/codex/1.0.3', version: '1.0.3' },
        { scope: 'user', installPath: '/user/codex/1.0.4', version: '1.0.4' },
      ],
    },
  });
  assert.equal(got.scope, 'user');
  assert.equal(got.installPath, '/user/codex/1.0.4');
});

test('selectCodexInstall: no user scope → falls back to the first record', () => {
  const got = selectCodexInstall({
    plugins: {
      'codex@openai-codex': [
        { scope: 'project', installPath: '/proj/codex/1.0.3', version: '1.0.3' },
        { scope: 'local', installPath: '/local/codex/1.0.2', version: '1.0.2' },
      ],
    },
  });
  assert.equal(got.scope, 'project');
  assert.equal(got.installPath, '/proj/codex/1.0.3');
});

test('selectCodexInstall: missing version/scope normalize to null (not undefined)', () => {
  const got = selectCodexInstall({ plugins: { 'codex@openai-codex': [{ installPath: '/c' }] } });
  assert.equal(got.installPath, '/c');
  assert.equal(got.version, null);
  assert.equal(got.scope, null);
});

// ---- companionScriptPath -----------------------------------------------------

test('companionScriptPath: appends scripts/codex-companion.mjs to the install dir', () => {
  assert.equal(
    companionScriptPath('/home/ras/.claude/plugins/cache/openai-codex/codex/1.0.4'),
    '/home/ras/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs',
  );
});

test('companionScriptPath: empty/non-string installPath → null', () => {
  assert.equal(companionScriptPath(''), null);
  assert.equal(companionScriptPath(null), null);
  assert.equal(companionScriptPath(undefined), null);
  assert.equal(companionScriptPath(42), null);
});

// ---- selectCodexReviewForHead ------------------------------------------------
// The §2c step-5 durable re-entry guard's pure core: scan an events.jsonl text for a SUCCESS
// codex_review record at a given HEAD sha (closes the P2 re-run-on-death + digest-loss window).

// A realistic events.jsonl text: each line one JSON event record (as `mp event` appends them).
const HEAD = 'aaaa111';
const lines = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('selectCodexReviewForHead: present record at HEAD → {present, digest, count, base}', () => {
  const text = lines(
    { type: 'verification', ts: 't0', summary: 'suite green' },
    {
      type: 'codex_review',
      ts: 't1',
      summary: 'codex review complete (whole-branch, base main) — 2 findings',
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

test('selectCodexReviewForHead: no record for this sha → {present:false}', () => {
  const text = lines({ type: 'codex_review', data: { sha: 'other999', base: 'main', count: 1 }, note: 'x' });
  assert.deepEqual(selectCodexReviewForHead(text, HEAD), { present: false, digest: null, count: null, base: null });
});

test('selectCodexReviewForHead: a clean zero-findings review is still present (count:0, not absent)', () => {
  // `present` keys on EXISTENCE at the sha, not count > 0 — a 0-findings review still ran.
  const text = lines({ type: 'codex_review', data: { sha: HEAD, base: 'main', count: 0 }, note: 'no findings' });
  assert.deepEqual(selectCodexReviewForHead(text, HEAD), { present: true, digest: 'no findings', count: 0, base: 'main' });
});

test('selectCodexReviewForHead: a codex_review_skipped (degraded) record is ignored', () => {
  // A prior skip must never mask a real re-run opportunity → guard still sees {present:false}.
  const text = lines({
    type: 'codex_review_skipped',
    summary: 'whole-branch codex-companion review skipped (degraded) — no network',
    data: { sha: HEAD },
  });
  assert.deepEqual(selectCodexReviewForHead(text, HEAD), { present: false, digest: null, count: null, base: null });
});

test('selectCodexReviewForHead: last matching line at the sha wins (a re-review supersedes)', () => {
  const text = lines(
    { type: 'codex_review', data: { sha: HEAD, base: 'main', count: 5 }, note: 'first pass' },
    { type: 'codex_review', data: { sha: HEAD, base: 'main', count: 1 }, note: 'second pass' },
  );
  const got = selectCodexReviewForHead(text, HEAD);
  assert.equal(got.count, 1);
  assert.equal(got.digest, 'second pass');
});

test('selectCodexReviewForHead: blank + malformed lines are skipped, not fatal', () => {
  const text =
    '\n' +
    'not json at all\n' +
    JSON.stringify({ type: 'codex_review', data: { sha: HEAD, base: 'main', count: 3 }, note: 'ok' }) +
    '\n\n';
  assert.deepEqual(selectCodexReviewForHead(text, HEAD), { present: true, digest: 'ok', count: 3, base: 'main' });
});

test('selectCodexReviewForHead: empty text / empty sha / non-string → {present:false} (no throw)', () => {
  const absent = { present: false, digest: null, count: null, base: null };
  assert.deepEqual(selectCodexReviewForHead('', HEAD), absent);
  assert.deepEqual(selectCodexReviewForHead(lines({ type: 'codex_review', data: { sha: HEAD } }), ''), absent);
  assert.deepEqual(selectCodexReviewForHead(null, HEAD), absent);
  assert.deepEqual(selectCodexReviewForHead('{}', HEAD), absent);
});

test('selectCodexReviewForHead: record missing note/count normalizes to null (not undefined)', () => {
  const text = lines({ type: 'codex_review', data: { sha: HEAD, base: 'main' } });
  assert.deepEqual(selectCodexReviewForHead(text, HEAD), { present: true, digest: null, count: null, base: 'main' });
});
