// test/sweep.test.mjs — sweepWorktrees: the §2e orphan-sweep prose absorbed into code (T2.3).
// The safety inversion under test: dry-run is the DEFAULT (report-only), `--apply` executes,
// and `manual` classifications are never automated in either mode. Real git in temp repos —
// the classifier's proof-gated remove ladder is exactly what must hold against live gitdirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { sweepWorktrees } from '../lib/sweep.mjs';
import { readState, writeState } from '../lib/bundle.mjs';

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'test@test');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
}
function writeBundle(MAIN, slug, fields) {
  writeState(path.join(MAIN, 'docs', 'masterplan', slug, 'state.yml'), {
    schema_version: 8, slug, status: 'in-progress', phase: 'execute', tasks: [], ...fields,
  });
}
const registeredPaths = (MAIN) =>
  git(MAIN, 'worktree', 'list', '--porcelain').split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));

// One fixture, four pathologies — exactly the action ladder's executable rows plus a manual:
//   s1 crash-leak  — registered + on disk, bundle disposition removed_after_merge → remove (git's)
//   s2 normalize   — legacy raw disposition 'missing' → durable state rewrite
//   s3 prune       — registered managed path GONE from disk, bundle retired → worktree prune
//   stray manual   — unregistered dir, gitdir pointer that resolves nowhere → foreign-unverified
function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-sweep-'));
  const MAIN = path.join(tmp, 'main');
  initRepo(MAIN);

  const wt1 = path.join(MAIN, '.worktrees', 's1');
  git(MAIN, 'worktree', 'add', '-q', '-b', 'masterplan/s1', wt1);
  writeBundle(MAIN, 's1', { worktree: wt1, worktree_disposition: 'removed_after_merge' });

  writeBundle(MAIN, 's2', { worktree: null, worktree_disposition: 'missing' });

  const wt3 = path.join(MAIN, '.worktrees', 's3');
  git(MAIN, 'worktree', 'add', '-q', '-b', 'masterplan/s3', wt3);
  fs.rmSync(wt3, { recursive: true, force: true }); // gone from disk, registration dangles
  writeBundle(MAIN, 's3', { worktree: wt3, worktree_disposition: 'removed_after_merge' });

  const stray = path.join(MAIN, '.worktrees', 'stray');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, '.git'), `gitdir: ${path.join(tmp, 'nonexistent', '.git', 'worktrees', 'x')}\n`);

  return { tmp, MAIN, wt1, wt3, stray };
}

test('dry-run (the default) classifies everything and touches NOTHING', () => {
  const fx = makeFixture();
  const res = sweepWorktrees({ repoRoot: fx.MAIN });

  assert.equal(res.mode, 'dry-run');
  assert.deepEqual(res.executed, []);
  const byReason = Object.fromEntries(res.actions.map((a) => [a.reason, a]));
  assert.equal(byReason['crash-leak'].action, 'remove');
  assert.equal(byReason['crash-leak'].registered, true);
  assert.equal(byReason['legacy-missing'].action, 'normalize');
  assert.equal(byReason['prune'].action, 'prune');
  assert.equal(byReason['foreign-unverified'].action, 'manual');
  assert.equal(res.findings.length, res.actions.length, 'one WARN finding per non-none action');

  // The whole point of the inversion: zero disk/state mutation without apply.
  assert.ok(fs.existsSync(fx.wt1), 'crash-leak worktree untouched');
  assert.ok(registeredPaths(fx.MAIN).includes(fx.wt1), 'still registered');
  assert.ok(registeredPaths(fx.MAIN).includes(fx.wt3), 'dangling registration not pruned');
  assert.equal(readState(path.join(fx.MAIN, 'docs/masterplan/s2/state.yml')).worktree_disposition, 'missing');
});

test('apply executes remove/normalize/prune — and still NEVER touches manual', () => {
  const fx = makeFixture();
  const res = sweepWorktrees({ repoRoot: fx.MAIN, apply: true });

  assert.equal(res.mode, 'apply');
  const results = Object.fromEntries(res.executed.map((e) => [e.reason, e.result]));
  assert.equal(results['crash-leak'], 'removed');
  assert.equal(results['legacy-missing'], 'normalized');
  assert.equal(results['prune'], 'pruned');

  assert.equal(fs.existsSync(fx.wt1), false, 'crash-leak worktree removed');
  const reg = registeredPaths(fx.MAIN);
  assert.ok(!reg.includes(fx.wt1) && !reg.includes(fx.wt3), 'both registrations gone');
  assert.equal(
    readState(path.join(fx.MAIN, 'docs/masterplan/s2/state.yml')).worktree_disposition,
    'removed_after_merge', 'legacy missing durably normalized through the CD-7 writer',
  );

  // manual: skipped under apply, directory survives.
  assert.deepEqual(res.skipped.map((s) => s.result), ['manual-never-automated']);
  assert.equal(res.skipped[0].reason, 'foreign-unverified');
  assert.ok(fs.existsSync(fx.stray), 'manual stray untouched');
});

test('a PROVABLY foreign leftover is rm-able; second sweep is empty (idempotent)', () => {
  const fx = makeFixture();
  // A real second repo whose worktree leaked into OUR .worktrees/ (the cc3-visibility case):
  // gitdir resolves into the FOREIGN admin dir → provably foreign → remove (registered:false).
  const FOREIGN = path.join(fx.tmp, 'foreign');
  initRepo(FOREIGN);
  const leak = path.join(fx.MAIN, '.worktrees', 'leak');
  git(FOREIGN, 'worktree', 'add', '-q', '-b', 'leaked', leak);

  const dry = sweepWorktrees({ repoRoot: fx.MAIN });
  const leakAction = dry.actions.find((a) => a.path === leak);
  assert.equal(leakAction.action, 'remove');
  assert.equal(leakAction.reason, 'foreign-leftover');
  assert.equal(leakAction.registered, false);

  const res = sweepWorktrees({ repoRoot: fx.MAIN, apply: true });
  assert.equal(res.executed.find((e) => e.path === leak)?.result, 'removed');
  assert.equal(fs.existsSync(leak), false, 'foreign leftover rm`d');

  // Idempotence: everything executable is gone; only the manual stray remains classified.
  const again = sweepWorktrees({ repoRoot: fx.MAIN, apply: true });
  assert.deepEqual(again.executed, []);
  assert.deepEqual(again.skipped.map((s) => s.reason), ['foreign-unverified']);
});
