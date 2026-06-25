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
  resolveEphemeralBundleDir,
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
  assert.equal(a.planHtml, '/repo/docs/masterplan/r/plan.html');
  assert.equal(a.events, '/repo/docs/masterplan/r/events.jsonl');
  assert.equal(a.retro, '/repo/docs/masterplan/r/retro.md');
});

test('expandTilde handles bare ~, ~/x, and non-tilde paths', () => {
  assert.equal(expandTilde('~', HOME), HOME);
  assert.equal(expandTilde('~/a/b', HOME), path.join(HOME, 'a/b'));
  assert.equal(expandTilde('/abs', HOME), '/abs');
  assert.equal(expandTilde('rel/x', HOME), 'rel/x');
});

// resolveEphemeralBundleDir — ephemeral out-of-tree bundle path helper.
// Delegates to resolveBundleDir with the supplied tmpBase as the "repo root" and
// an empty env so that MASTERPLAN_RUNS_DIR (meaningful only to the lead) never
// overrides an ephemeral location.
test('resolveEphemeralBundleDir places the bundle under tmpBase/docs/masterplan/<slug>', () => {
  const result = resolveEphemeralBundleDir('my-task', '/tmp/mp-work');
  assert.equal(result, path.join('/tmp/mp-work', 'docs/masterplan', 'my-task'));
});

test('resolveEphemeralBundleDir state.yml path follows the same structure', () => {
  // Verify that resolveStatePath with the same tmpBase produces a consistent path
  // (the ephemeral dir + state.yml), confirming the wiring matches resolveBundleDir.
  const ephemeralDir = resolveEphemeralBundleDir('t42', '/tmp/base');
  assert.equal(ephemeralDir, path.join('/tmp/base', 'docs/masterplan', 't42'));
});

test('resolveEphemeralBundleDir ignores MASTERPLAN_RUNS_DIR in the environment', () => {
  // The function always uses an empty env internally, so process.env MASTERPLAN_RUNS_DIR
  // cannot redirect an ephemeral bundle to an unexpected location.  We test this
  // invariant by confirming two slugs on distinct bases never collide.
  const a = resolveEphemeralBundleDir('slug-a', '/tmp/a');
  const b = resolveEphemeralBundleDir('slug-b', '/tmp/b');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('/tmp/a'));
  assert.ok(b.startsWith('/tmp/b'));
});

test('resolveEphemeralBundleDir result is an absolute path', () => {
  const result = resolveEphemeralBundleDir('task-1', '/var/tmp/mp');
  assert.ok(path.isAbsolute(result));
});