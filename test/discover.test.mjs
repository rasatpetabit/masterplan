import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverBundles } from '../lib/discover.mjs';

test('discoverBundles finds state.yml under the configured runs dir', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mp-disc-'));
  try {
    const runs = path.join(root, 'RUNS');
    mkdirSync(path.join(runs, 'alpha'), { recursive: true });
    writeFileSync(path.join(runs, 'alpha', 'state.yml'), 'status: in-progress\n');
    const found = discoverBundles(root, { MASTERPLAN_RUNS_DIR: 'RUNS' });
    assert.deepEqual(found, [path.join(runs, 'alpha', 'state.yml')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverBundles defaults to docs/masterplan when env unset', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mp-disc-'));
  try {
    const runs = path.join(root, 'docs', 'masterplan', 'beta');
    mkdirSync(runs, { recursive: true });
    writeFileSync(path.join(runs, 'state.yml'), 'status: in-progress\n');
    const found = discoverBundles(root, {});
    assert.deepEqual(found, [path.join(runs, 'state.yml')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverBundles returns only real bundles, sorted, ignoring non-bundle dirs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mp-disc-'));
  try {
    const runs = path.join(root, 'RUNS');
    mkdirSync(path.join(runs, 'zeta'), { recursive: true });
    writeFileSync(path.join(runs, 'zeta', 'state.yml'), 'status: in-progress\n');
    mkdirSync(path.join(runs, 'alpha'), { recursive: true });
    writeFileSync(path.join(runs, 'alpha', 'state.yml'), 'status: in-progress\n');
    mkdirSync(path.join(runs, 'notabundle'), { recursive: true }); // no state.yml -> ignored
    const found = discoverBundles(root, { MASTERPLAN_RUNS_DIR: 'RUNS' });
    assert.deepEqual(found, [
      path.join(runs, 'alpha', 'state.yml'),
      path.join(runs, 'zeta', 'state.yml'),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
