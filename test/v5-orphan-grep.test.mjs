// test/v5-orphan-grep.test.mjs — self-test for scripts/v5-orphan-grep.sh (V5 gate, Task 40).
//
// Fixture-based via --root: these tests never depend on live-tree deletion
// state. The LIVE clean run belongs to the L2-deletion task and to preflight.
//
// PLAN-REVIEW FIX R3 (2026-07-15, F10): table-driven — one seeded drift
// fixture per frozen symbol, each asserted to fail individually, plus the
// clean fixture must-pass. A symbol the script misses fails this self-test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'v5-orphan-grep.sh');

// FROZEN symbol list — must stay in lockstep with scripts/v5-orphan-grep.sh.
const FROZEN_SYMBOLS = [
  'launch_workflow',
  'dispatch_foreground',
  'plan.workflow',
  'execute.workflow',
  'promote-active-run',
  'recover_and_redispatch',
  'mp-implementer',
];

function runGate(root) {
  return spawnSync('bash', [script, '--root', root], { encoding: 'utf8' });
}

/**
 * Builds a fixture tree that must PASS the gate: live files are clean, and
 * frozen symbols appear only in allowlisted locations (run bundles,
 * CHANGELOG, WORKLOG) — proving the exclusion allowlist actually excludes.
 */
function makeCleanTree() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'v5-orphan-grep-'));
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'lib', 'wave.mjs'), 'export const fabricOnly = true;\n');
  mkdirSync(path.join(dir, 'docs', 'masterplan', 'old-run'), { recursive: true });
  writeFileSync(
    path.join(dir, 'docs', 'masterplan', 'old-run', 'retro.md'),
    'historical bundle: launch_workflow / execute.workflow / worker-digest\n',
  );
  writeFileSync(path.join(dir, 'CHANGELOG.md'), 'v9: removed the dispatch_foreground op\n');
  writeFileSync(path.join(dir, 'WORKLOG.md'), 'deleted agents/worker-digest.md and plan.workflow.js\n');
  return dir;
}

test('clean fixture tree passes; allowlisted mentions do not count as orphans', () => {
  const dir = makeCleanTree();
  try {
    const res = runGate(dir);
    assert.equal(
      res.status,
      0,
      `expected clean pass, got exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Table-driven drift fixtures: one per frozen symbol (R3/F10). Each seeds a
// single orphaned reference on a live surface and must fail individually.
for (const symbol of FROZEN_SYMBOLS) {
  test(`drift fixture: orphaned "${symbol}" reference fails non-zero`, () => {
    const dir = makeCleanTree();
    try {
      writeFileSync(path.join(dir, 'lib', 'stale.mjs'), `// stale V5 reference: ${symbol}\n`);
      const res = runGate(dir);
      assert.equal(
        res.status,
        1,
        `expected exit 1 for orphaned ${symbol}, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
      );
      assert.ok(
        res.stderr.includes('lib/stale.mjs'),
        `report should name the offending file, got: ${res.stderr}`,
      );
      assert.ok(
        res.stderr.includes(symbol),
        `report should include the matched symbol line for ${symbol}, got: ${res.stderr}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('missing --root directory fails closed with exit 2', () => {
  const res = runGate(path.join(os.tmpdir(), 'v5-orphan-grep-does-not-exist'));
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}\nstderr: ${res.stderr}`);
});
