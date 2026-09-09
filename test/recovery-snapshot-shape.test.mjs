// test/recovery-snapshot-shape.test.mjs — per-entry structural validation of the launch
// watch baseline in the committed-recovery preservation gate.
//
// The recovery preflight (lib/recovery-preflight.mjs) dereferences each baseline snapshot
// entry through snapshotWatchList BEFORE snapshotWatchList; a malformed entry (null /
// array / missing repo / wrong prefix / isMain / head / entries) used to throw
// (`Cannot read properties of null (reading 'repo')`), letting a corrupt baseline escape
// the read-only gate. It must instead FAIL CLOSED as a preservation violation, with zero
// destructive git and zero state/event writes.
//
// REAL git in disposable temp repos (no injection): the preflight's value is that it runs
// the same integrity checks the normal transaction would, so the tests exercise genuine
// MAIN + linked-worktree pairs against a real launch baseline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';
import { preflightRecovery } from '../lib/recovery-preflight.mjs';
import { captureWatchBaseline, writeWatchBaseline } from '../lib/watch-integrity.mjs';

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/**
 * Disposable committed-recovery fixture: MAIN with a base commit plus the recovered HEAD,
 * a linked worktree at HEAD (clean), and a bundle whose active_run scopes `src/a.txt`.
 * A REAL launch baseline is captured (the validator must not over-reject); tests that
 * exercise a malformed baseline replace it with overrideSnapshots().
 */
function makeSnapshotFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-snapshape-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const BASE = git(MAIN, 'rev-parse', 'HEAD');
  // The recovered commit (what the wave actually did) lands on MAIN.
  write(MAIN, 'src/a.txt', 'recovered change\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'recovered wave work');
  const HEAD = git(MAIN, 'rev-parse', 'HEAD');
  const WT = path.join(MAIN, '.worktrees', 'recovery');
  git(MAIN, 'worktree', 'add', '-q', WT, 'HEAD');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', 'recovery');
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8,
    slug: 'recovery',
    status: 'in-progress',
    phase: 'execute',
    worktree: WT,
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    active_run: {
      wave: 1, run_id: 'recovery', task_id: 'wf1', epoch: 5, scope: ['src/a.txt'], baseline: [],
    },
    concurrency: { owner_lock: 'off' }, // single-agent fixture — skip the owner heartbeat
  });
  write(bundleDir, 'plan.index.json', JSON.stringify({
    tasks: [{ id: 1, wave: 1, files: ['src/a.txt'], description: 'task 1', verify_commands: [] }],
  }));
  const self = buildOwnerIdentity({ host: 'h1', session: 'sess-snapshape', slug: 'recovery', now: 1000 });
  writeWatchBaseline(bundleDir, 1, captureWatchBaseline({
    mainRoot: MAIN, bundleDir, worktree: WT, slug: 'recovery', scopePaths: ['src/a.txt'],
  }));
  return { tmp, MAIN, WT, bundleDir, statePath, self, BASE, HEAD };
}

/** Replace the fixture's launch watch baseline with the given (possibly malformed) snapshots. */
function overrideSnapshots(fx, snapshots) {
  writeWatchBaseline(fx.bundleDir, 1, { snapshots, bundle: {} });
}

/** A recovery result the controller would accept — only reached if preflight passes. */
const recoveryResult = (fx) => ({
  wave: 1,
  epoch: 5,
  tasks: [{ task_id: 1, digest: { task_id: 1, status: 'done', start_sha: 'abc123', files_changed: [], verify: [], summary: 'done', blockers: null } }],
});

/**
 * Drive a malformed baseline through the REAL consumer (recordWaveResult recovery:true) and
 * assert the fail-closed contract: a preservation violation, never a throw, with zero
 * destructive git and zero state/event writes.
 */
function assertMalformedRejected(fx, label, expectPattern) {
  const stateBytes = fs.readFileSync(fx.statePath, 'utf8');
  const beforeHead = git(fx.WT, 'rev-parse', 'HEAD');
  const beforeMainHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  let res;
  try {
    res = recordWaveResult({
      statePath: fx.statePath,
      result: recoveryResult(fx),
      self: fx.self,
      now: 4000,
      worktree: fx.WT,
      deferredEvents: [],
      recovery: true,
    });
  } catch (err) {
    assert.fail(`[${label}] recordWaveResult THREW instead of returning a preservation violation: ${err.message}`);
  }
  assert.equal(res.outcome, 'recovery-preservation-violation', `[${label}] outcome`);
  assert.ok(
    res.violations.some((v) => expectPattern.test(v)),
    `[${label}] violations name the malformed entry: ${res.violations.join('; ')}`,
  );
  // Zero destructive git: HEAD and tree untouched, no new masterplan commit in MAIN.
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), beforeHead, `[${label}] WT HEAD untouched`);
  assert.equal(git(fx.WT, 'status', '--porcelain'), '', `[${label}] WT tree clean`);
  assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD'), beforeMainHead, `[${label}] no commit moved MAIN HEAD`);
  // Zero state/event writes.
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), stateBytes, `[${label}] state untouched`);
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending', `[${label}] task not marked`);
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false, `[${label}] no event appended`);
}

test('snapshot-shape: a VALID real launch baseline passes preflight (validator does not over-reject)', () => {
  const fx = makeSnapshotFixture();
  const res = preflightRecovery({
    statePath: fx.statePath,
    state: readState(fx.statePath),
    run: { wave: 1, run_id: 'recovery', task_id: 'wf1', epoch: 5, scope: ['src/a.txt'], baseline: [] },
    wave: 1,
    WT: fx.WT,
    MAIN: fx.MAIN,
    slug: 'recovery',
    baseline: [],
    captureWtFiles: () => [],
    captureWorkspaceRoot: () => [],
  });
  assert.equal(res.ok, true, `valid baseline must preflight ok: ${res.violations.join('; ')}`);
  assert.ok(res.watch.checked, 'watch delta was checked');
  assert.equal(res.watch.ok, true, 'watch delta clean');
});

test('snapshot-shape: a null snapshot entry is a preservation violation, never a throw', () => {
  const fx = makeSnapshotFixture();
  overrideSnapshots(fx, { [fx.MAIN]: null });
  assertMalformedRejected(fx, 'null entry', /expected an object, got null/);
});

test('snapshot-shape: a snapshot entry that is an ARRAY is a preservation violation', () => {
  const fx = makeSnapshotFixture();
  overrideSnapshots(fx, { [fx.MAIN]: [] });
  assertMalformedRejected(fx, 'array entry', /expected an object, got an array/);
});

test('snapshot-shape: a snapshot entry with a non-string key repo is a preservation violation', () => {
  // The key is authoritative for the violation message; the entry itself carries no repo.
  const fx = makeSnapshotFixture();
  overrideSnapshots(fx, { 'repo': { head: 'x', entries: {}, unparsed: [], prefix: null, isMain: true } });
  assertMalformedRejected(fx, 'missing repo', /missing or non-string repo/);
});

test('snapshot-shape: a snapshot entry with a null-ish (non-object) repo value is a preservation violation', () => {
  const fx = makeSnapshotFixture();
  overrideSnapshots(fx, { 'repo': 'not-an-object' });
  assertMalformedRejected(fx, 'string entry', /expected an object, got string/);
});

test('snapshot-shape: a snapshot entry with wrong prefix/isMain is a preservation violation', () => {
  const fx = makeSnapshotFixture();
  overrideSnapshots(fx, {
    'repo': { repo: 'repo', head: 'x', entries: {}, unparsed: [], prefix: 42, isMain: 1 },
  });
  assertMalformedRejected(fx, 'wrong prefix/isMain', /prefix must be a string or null/);
});

test('snapshot-shape: a snapshot entry with missing head/entries is a preservation violation', () => {
  const fx = makeSnapshotFixture();
  overrideSnapshots(fx, {
    'repo': { repo: 'repo', entries: {}, unparsed: [], prefix: null, isMain: true },
  });
  assertMalformedRejected(fx, 'missing head', /missing or non-string head/);
});

test('snapshot-shape: a snapshot entry with non-object entries is a preservation violation', () => {
  const fx = makeSnapshotFixture();
  overrideSnapshots(fx, {
    'repo': { repo: 'repo', head: 'x', entries: 'nope', unparsed: [], prefix: null, isMain: true },
  });
  assertMalformedRejected(fx, 'non-object entries', /entries must be an object/);
});

test('snapshot-shape: a snapshot entry with malformed per-path entry values is a preservation violation', () => {
  const fx = makeSnapshotFixture();
  overrideSnapshots(fx, {
    'repo': { repo: 'repo', head: 'x', entries: { 'src/a.txt': { xy: 7, hash: 'zz' } }, unparsed: [], prefix: null, isMain: true },
  });
  assertMalformedRejected(fx, 'bad per-path xy', /has a missing or non-string xy/);
});

test('snapshot-shape: a snapshot entry with non-array unparsed is a preservation violation', () => {
  const fx = makeSnapshotFixture();
  overrideSnapshots(fx, {
    'repo': { repo: 'repo', head: 'x', entries: {}, unparsed: 'nope', prefix: null, isMain: true },
  });
  assertMalformedRejected(fx, 'non-array unparsed', /unparsed must be an array/);
});

test('snapshot-shape: a launch-failure entry ({repo,error}) is VALID and reaches the watch delta, not the shape gate', () => {
  // snapshotWatchList records an un-snapshottable repo as { repo, error, prefix, isMain } —
  // a real launch-time failure, not a structural corruption. The shape gate must accept it
  // and let the delta check turn it into a watched-repo failure (a violation, but for the
  // RIGHT reason: the launch snapshot failed, not that the baseline is malformed).
  const fx = makeSnapshotFixture();
  overrideSnapshots(fx, {
    [fx.MAIN]: { repo: fx.MAIN, error: 'boom at launch', prefix: null, isMain: true },
  });
  const res = preflightRecovery({
    statePath: fx.statePath,
    state: readState(fx.statePath),
    run: { wave: 1, run_id: 'recovery', task_id: 'wf1', epoch: 5, scope: ['src/a.txt'], baseline: [] },
    wave: 1,
    WT: fx.WT,
    MAIN: fx.MAIN,
    slug: 'recovery',
    baseline: [],
    captureWtFiles: () => [],
    captureWorkspaceRoot: () => [],
  });
  assert.equal(res.ok, false, 'launch-failure entry fails closed');
  assert.ok(
    res.violations.some((v) => /malformed/.test(v)) === false,
    `must NOT be a shape violation: ${res.violations.join('; ')}`,
  );
  assert.ok(
    res.violations.some((v) => /watch-list violation.*snapshot failed/.test(v)),
    `delta check reports the launch failure: ${res.violations.join('; ')}`,
  );
});

test('snapshot-shape: MULTIPLE malformed entries each produce a preservation violation', () => {
  const fx = makeSnapshotFixture();
  overrideSnapshots(fx, {
    'a': null,
    'b': { repo: 'b', head: 'x', entries: 'nope', unparsed: [], prefix: null, isMain: true },
  });
  const stateBytes = fs.readFileSync(fx.statePath, 'utf8');
  let res;
  try {
    res = recordWaveResult({
      statePath: fx.statePath,
      result: recoveryResult(fx),
      self: fx.self,
      now: 4000,
      worktree: fx.WT,
      deferredEvents: [],
      recovery: true,
    });
  } catch (err) {
    assert.fail(`recordWaveResult THREW on multiple malformed entries: ${err.message}`);
  }
  assert.equal(res.outcome, 'recovery-preservation-violation');
  assert.equal(res.violations.filter((v) => /snapshot entry .* is malformed/.test(v)).length, 2, `two shape violations: ${res.violations.join('; ')}`);
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), stateBytes, 'state untouched');
});
