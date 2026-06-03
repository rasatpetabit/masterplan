// test/codex-companion.test.mjs — the version-agnostic companion-path resolver behind
// `mp codex-companion-path` (the §2c finish-gate review's path source). Pure functions: a parsed
// installed_plugins.json object in, an install record / script path out. No fs, no process — the
// file read + existence probe live in the subcommand, so the selection logic is testable without
// a real plugin cache. Mirrors lib/finish.mjs's boundaries (see test/finish.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCodexInstall, companionScriptPath } from '../lib/codex-companion.mjs';

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
