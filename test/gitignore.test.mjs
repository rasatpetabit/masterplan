// test/gitignore.test.mjs — verify .gitignore secret-glob hardening under test/fixtures/**
//
// These are pure rule-matching tests; the fixture paths need not exist on disk.
// `git check-ignore` exits 0 when a path is ignored, 1 when it is not.
// We treat exit 1 as "not ignored" and exit 128 (git error) as an error so it
// cannot masquerade as a "not ignored" result and produce a false pass on the
// auth.json assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Returns true when git considers the path to be ignored.
 * Throws if git itself errors (exit 128) rather than silently claiming "not ignored".
 */
function isIgnored(relPath) {
  try {
    execFileSync('git', ['check-ignore', relPath], { cwd: repoRoot, stdio: 'pipe' });
    return true;
  } catch (err) {
    // exit 1 means "not ignored" — the expected success case for auth.json
    if (err.status === 1) return false;
    // exit 128 or other git errors are real errors, not a match outcome
    throw err;
  }
}

test('.gitignore: test/fixtures/**/.env is ignored', () => {
  assert.equal(isIgnored('test/fixtures/x/.env'), true);
});

test('.gitignore: test/fixtures/**/secret.key is ignored', () => {
  assert.equal(isIgnored('test/fixtures/x/secret.key'), true);
});

test('.gitignore: test/fixtures/**/cert.pem is ignored', () => {
  assert.equal(isIgnored('test/fixtures/x/cert.pem'), true);
});

test('.gitignore: test/fixtures/doctor/codex-auth/warn-malformed auth.json is NOT ignored', () => {
  assert.equal(
    isIgnored('test/fixtures/doctor/codex-auth/warn-malformed/home/.codex/auth.json'),
    false,
  );
});
