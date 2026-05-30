// test/paths.test.mjs — path/config-dir resolution (pure; env + home injected for testing).
// Absorbs v7's scattered ~/.claude and docs/masterplan path sites into one module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  resolveConfigDir,
  resolveRunsDir,
  resolveBundleDir,
  resolveStatePath,
  bundleArtifacts,
  expandTilde,
} from '../lib/paths.mjs';

const HOME = '/home/u';

test('resolveConfigDir defaults to ~/.claude', () => {
  assert.equal(resolveConfigDir({}, HOME), path.join(HOME, '.claude'));
});
test('resolveConfigDir honors CLAUDE_CONFIG_DIR', () => {
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: '/x/cfg' }, HOME), '/x/cfg');
});
test('resolveConfigDir expands ~ inside CLAUDE_CONFIG_DIR', () => {
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: '~/alt' }, HOME), path.join(HOME, 'alt'));
});
test('resolveConfigDir ignores a blank CLAUDE_CONFIG_DIR', () => {
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: '   ' }, HOME), path.join(HOME, '.claude'));
});

test('resolveRunsDir defaults to <root>/docs/masterplan', () => {
  assert.equal(resolveRunsDir('/repo', {}), '/repo/docs/masterplan');
});
test('resolveRunsDir honors MASTERPLAN_RUNS_DIR (relative -> under root)', () => {
  assert.equal(resolveRunsDir('/repo', { MASTERPLAN_RUNS_DIR: 'runs' }), '/repo/runs');
});
test('resolveRunsDir honors MASTERPLAN_RUNS_DIR (absolute -> as-is)', () => {
  assert.equal(resolveRunsDir('/repo', { MASTERPLAN_RUNS_DIR: '/abs/runs' }), '/abs/runs');
});

test('resolveBundleDir joins the slug', () => {
  assert.equal(resolveBundleDir('/repo', 'my-run', {}), '/repo/docs/masterplan/my-run');
});
test('resolveStatePath -> bundle/state.yml', () => {
  assert.equal(resolveStatePath('/repo', 'my-run', {}), '/repo/docs/masterplan/my-run/state.yml');
});

test('bundleArtifacts maps every bundle file under the bundle dir', () => {
  const a = bundleArtifacts('/repo', 'r', {});
  assert.equal(a.dir, '/repo/docs/masterplan/r');
  assert.equal(a.state, '/repo/docs/masterplan/r/state.yml');
  assert.equal(a.planIndex, '/repo/docs/masterplan/r/plan.index.json');
  assert.equal(a.events, '/repo/docs/masterplan/r/events.jsonl');
  assert.equal(a.retro, '/repo/docs/masterplan/r/retro.md');
});

test('expandTilde handles bare ~, ~/x, and non-tilde paths', () => {
  assert.equal(expandTilde('~', HOME), HOME);
  assert.equal(expandTilde('~/a/b', HOME), path.join(HOME, 'a/b'));
  assert.equal(expandTilde('/abs', HOME), '/abs');
  assert.equal(expandTilde('rel/x', HOME), 'rel/x');
});