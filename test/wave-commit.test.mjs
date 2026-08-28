// test/wave-commit.test.mjs — recordWaveResult: the §2a wave-completion transaction in code (T2.2).
// REAL git in temp repos (no injection): the module's value is the exact interleaving of atomic
// state writes with -C-qualified local git, so the tests exercise genuine MAIN+worktree pairs.
// The five plan-mandated cases: clean wave, out-of-scope revert, dirty-WT crash reconcile,
// split-commit isolation, lost-to-other abort — plus the failed-task marker semantics and the
// precondition guards (foreign wave / plan run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { recordWaveResult } from '../lib/wave-commit.mjs';
import { captureWatchBaseline, writeWatchBaseline, snapshotRepoState } from '../lib/watch-integrity.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// A MAIN repo (initial commit: rogue.txt + src/seed.txt), a real linked worktree on
// masterplan/<slug>, a bundle with the given tasks + active_run marker, and the owner
// lock held by identity sess-A (record-result's heartbeat is STRICT: acquire precedes).
function makeFixture({ tasks, activeRun, slug = 't22' }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wavecommit-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'rogue.txt', 'original\n');
  write(MAIN, 'src/seed.txt', 'seed\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const WT = path.join(MAIN, '.worktrees', slug);
  git(MAIN, 'worktree', 'add', '-q', '-b', `masterplan/${slug}`, WT);
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8,
    slug,
    status: 'in-progress',
    phase: 'execute',
    worktree: WT,
    tasks,
    active_run: activeRun,
  });
  const self = buildOwnerIdentity({ host: 'h1', session: 'sess-A', slug, now: 1000 });
  const acq = acquireOwner(bundleDir, self, { now: 1000 });
  assert.equal(acq.outcome, 'acquire');
  return { tmp, MAIN, WT, bundleDir, statePath, self };
}

const digest = (id, status, extra = {}) => ({
  task_id: id,
  digest: { task_id: id, status, files_changed: [], summary: '', blockers: [], ...extra.digest },
  review: extra.review ?? null,
});

test('clean wave: marks done, split commit lands, marker clears, next=complete', () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] },
    ],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt', 'src/b.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');
  write(fx.WT, 'src/b.txt', 'B\n');
  const mainHeadBefore = git(fx.MAIN, 'rev-parse', 'HEAD');

  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: {
      wave: 1,
      baseline: [],
      tasks: [digest(1, 'done'), digest(2, 'done', { review: { verdict: 'blocking', findings: ['F1'] } })],
    },
  });

  assert.equal(res.outcome, 'recorded');
  assert.deepEqual(res.recorded, [1, 2]);
  assert.deepEqual(res.failed, []);
  assert.equal(res.scope.ok, true);
  assert.deepEqual(res.reverted, []);
  // blocking review on a DONE task still surfaces (review gate is independent of status).
  // Legacy 'blocking' normalizes to 'reject'; findings land once in blocking_findings
  // (not duplicated into findings).
  assert.deepEqual(res.blocking_reviews, [{ id: 2, verdict: 'reject', findings: ['F1'] }]);
  assert.equal(res.cleared, true);
  assert.equal(res.next.action, 'complete');

  // Code commit: both files, WT clean after.
  assert.ok(res.commits.code);
  const codeFiles = git(fx.WT, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.deepEqual(codeFiles.sort(), ['src/a.txt', 'src/b.txt']);
  assert.equal(git(fx.WT, 'status', '--porcelain'), '');

  // State commit in MAIN: bundle paths only, marker gone, tasks done, event in the SAME commit.
  assert.ok(res.commits.state);
  assert.notEqual(git(fx.MAIN, 'rev-parse', 'HEAD'), mainHeadBefore);
  const stateFiles = git(fx.MAIN, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.deepEqual(stateFiles.sort(), [`docs/masterplan/t22/events.jsonl`, `docs/masterplan/t22/state.yml`]);
  const after = readState(fx.statePath);
  assert.equal(after.active_run, null);
  assert.deepEqual(after.tasks.map((t) => t.status), ['done', 'done']);
  const events = fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'wave_recorded');
});

const healthyHarness = {
  degraded: false, timed_out: false, stalled: false,
  deadline_exceeded: false, regions_unreviewed: 0,
  extraction_degraded: false,
};

const canonicalReview = (verdict, extra = {}) => ({
  verdict,
  findings: [{ file: 'src/a.txt', line: 1, summary: `${verdict} finding`, severity: 'major' }],
  blocking_findings: verdict === 'approve' ? [] : [{ summary: `${verdict} blocker` }],
  summary: `${verdict} summary`,
  harness: { ...healthyHarness },
  ...extra,
});

for (const verdict of ['rework', 'reject', 'error']) {
  test(`record-result surfaces canonical ${verdict} in blocking_reviews`, () => {
    const fx = makeFixture({
      tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
      activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
    });
    write(fx.WT, 'src/a.txt', 'A\n');
    const review = canonicalReview(verdict);
    const res = recordWaveResult({
      statePath: fx.statePath, self: fx.self, now: 2000,
      result: { wave: 1, baseline: [], tasks: [{
        task_id: 1,
        review,
        digest: { ...digest(1, 'done').digest, review },
      }] },
    });
    assert.equal(res.blocking_reviews.length, 1);
    assert.equal(res.blocking_reviews[0].id, 1);
    assert.equal(res.blocking_reviews[0].verdict, verdict);
    assert.ok(Array.isArray(res.blocking_reviews[0].findings));
  });
}

test('record-result blocks a degraded approve', () => {
  const fx = makeFixture({ tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }], activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] } });
  write(fx.WT, 'src/a.txt', 'A\n');
  const review = canonicalReview('approve', { harness: { ...healthyHarness, degraded: true } });
  const res = recordWaveResult({
    statePath: fx.statePath, self: fx.self, now: 2000,
    result: { wave: 1, baseline: [], tasks: [{
      task_id: 1, review, digest: { ...digest(1, 'done').digest, review },
    }] },
  });
  assert.equal(res.blocking_reviews[0].verdict, 'error');
});

test('record-result accepts a healthy canonical approve', () => {
  const fx = makeFixture({ tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }], activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] } });
  write(fx.WT, 'src/a.txt', 'A\n');
  const review = canonicalReview('approve');
  const res = recordWaveResult({
    statePath: fx.statePath, self: fx.self, now: 2000,
    result: { wave: 1, baseline: [], tasks: [{
      task_id: 1, review, digest: { ...digest(1, 'done').digest, review },
    }] },
  });
  assert.deepEqual(res.blocking_reviews, []);
});

test('record-result preserves legacy blocking review on redrive', () => {
  const fx = makeFixture({ tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }], activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] } });
  write(fx.WT, 'src/a.txt', 'A\n');
  const review = { verdict: 'blocking', findings: 'legacy blocker' };
  const res = recordWaveResult({
    statePath: fx.statePath, self: fx.self, now: 2000,
    result: { wave: 1, baseline: [], tasks: [{
      task_id: 1, review, digest: { ...digest(1, 'done').digest, review },
    }] },
  });
  assert.ok(Array.isArray(res.blocking_reviews[0].findings));
  assert.match(JSON.stringify(res.blocking_reviews[0].findings), /legacy blocker/);
});

test('REGRESSION: the controller\'s own Guard-D heartbeat is not a watch breach', () => {
  // e2e finding 7 (test/e2e-native-wave-report.md): .owner* was excluded from the state-
  // commit pathspec but NOT from MAIN_TRANSACTION_FILES, so every single record reported
  // "MAIN changed outside the controller's transaction files: …owner.hb…" — a false
  // positive on a file the controller refreshes on every §2 entry, by design.
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  const baseline = captureWatchBaseline({
    mainRoot: fx.MAIN, bundleDir: fx.bundleDir, worktree: fx.WT, slug: 't22', scopePaths: ['src/a.txt'],
  });
  writeWatchBaseline(fx.bundleDir, 1, baseline);

  // The heartbeat moves DURING the wave — that is what a live owner does.
  const hb = fs.readdirSync(fx.bundleDir).find((f) => f.startsWith('.owner.hb.'));
  assert.ok(hb, 'the fixture holds the lock, so a heartbeat sentinel exists');
  fs.writeFileSync(path.join(fx.bundleDir, hb), JSON.stringify({ beat: 2 }));
  write(fx.WT, 'src/a.txt', 'A\n');

  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] },
  });

  assert.equal(res.outcome, 'recorded');
  assert.equal(res.watch.checked, true, 'the watch ran — this is not a vacuous pass');
  assert.equal(res.watch.ok, true, `heartbeat must not breach; got ${JSON.stringify(res.watch.violations)}`);
  assert.equal(
    res.watch.violations.filter((v) => String(v.path).includes('.owner')).length, 0,
    'no violation names an owner sentinel',
  );
  // …and the sentinel is still never committed (the pathspec exclusion is untouched).
  const stateFiles = git(fx.MAIN, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.ok(!stateFiles.some((f) => f.includes('.owner')), 'owner sentinels stay out of the state commit');
});

test('REGRESSION: excluding the heartbeat did not blind the watch to a real MAIN write', () => {
  // The negative control for the test above: the fix must be an exclusion of two known
  // controller-written sentinels, not a weakening of the MAIN allowed-delta check.
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  const baseline = captureWatchBaseline({
    mainRoot: fx.MAIN, bundleDir: fx.bundleDir, worktree: fx.WT, slug: 't22', scopePaths: ['src/a.txt'],
  });
  writeWatchBaseline(fx.bundleDir, 1, baseline);

  write(fx.MAIN, 'child-main.txt', 'MAIN-BREACH\n'); // a child writing into MAIN
  write(fx.WT, 'src/a.txt', 'A\n');

  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] },
  });

  assert.equal(res.watch.ok, false, 'a real MAIN write still fails the wave loud');
  assert.ok(
    res.watch.violations.some((v) => String(v.path).includes('child-main.txt')),
    `the offending path is named; got ${JSON.stringify(res.watch.violations)}`,
  );
});

test('out-of-scope revert: tracked offender restored via checkout, untracked removed via clean; in-scope work stands', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n'); // in scope
  write(fx.WT, 'rogue.txt', 'tampered\n'); // tracked, OUT of scope
  write(fx.WT, 'evil.txt', 'evil\n'); // untracked, OUT of scope

  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] },
  });

  assert.equal(res.scope.ok, false);
  assert.deepEqual(res.reverted.sort(), ['evil.txt', 'rogue.txt']);
  assert.equal(fs.readFileSync(path.join(fx.WT, 'rogue.txt'), 'utf8'), 'original\n');
  assert.equal(fs.existsSync(path.join(fx.WT, 'evil.txt')), false);
  // Code commit carries ONLY the in-scope file; the wave still completes.
  const codeFiles = git(fx.WT, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.deepEqual(codeFiles, ['src/a.txt']);
  assert.equal(res.cleared, true);
});

test('dirty-WT crash reconcile (result:null): no marks, the verify→revert→commit→clear tail re-runs off the persisted baseline', () => {
  // Crash simulation: marks were already written (tasks done) but the marker is intact and
  // the WT still holds the wave's uncommitted in-scope work — the §2 finalize_run row.
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');

  const res = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2000, result: null });

  assert.equal(res.mode, 'reconcile');
  assert.deepEqual(res.recorded, []);
  assert.ok(res.commits.code, 'the stranded in-scope work gets its code commit');
  assert.equal(res.cleared, true);
  assert.ok(res.commits.state);
  assert.equal(readState(fx.statePath).active_run, null);
  assert.equal(res.next.action, 'complete');
  // Idempotence: a second reconcile (clean WT, no marker) has nothing to do — and indeed
  // refuses loudly rather than inventing a transaction.
  assert.throws(
    () => recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 3000, result: null }),
    /no active_run/
  );
});

test('split-commit isolation: pathspec commits never sweep unrelated staged content in MAIN or the WT', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');
  // Foreign staged content: the user's own in-flight work in MAIN, and a staged tracked
  // modification in the WT that is not the wave's (e.g. a sibling agent's prepared edit).
  write(fx.MAIN, 'unrelated.txt', 'user work\n');
  git(fx.MAIN, 'add', 'unrelated.txt');
  write(fx.WT, 'src/seed.txt', 'foreign staged edit\n');
  git(fx.WT, 'add', 'src/seed.txt');

  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] },
  });

  // Code commit: ONLY the wave's pathspec, regardless of what else was staged in the WT.
  const codeFiles = git(fx.WT, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.deepEqual(codeFiles, ['src/a.txt']);
  // State commit: ONLY the bundle dir; the user's staged file survives, still staged.
  const stateFiles = git(fx.MAIN, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.ok(stateFiles.every((f) => f.startsWith('docs/masterplan/')), `unexpected sweep: ${stateFiles}`);
  assert.match(git(fx.MAIN, 'status', '--porcelain', '--', 'unrelated.txt'), /^A /);
  assert.ok(res.commits.code && res.commits.state);
});

test('lost-to-other: aborts with ZERO writes — no marks, no commits, no events', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');
  const mainHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  const wtHead = git(fx.WT, 'rev-parse', 'HEAD');
  const stateBytes = fs.readFileSync(fx.statePath, 'utf8');

  const other = buildOwnerIdentity({ host: 'h1', session: 'sess-B', slug: 't22', now: 1500 });
  const res = recordWaveResult({
    statePath: fx.statePath,
    self: other,
    now: 2000,
    result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] },
  });

  assert.equal(res.outcome, 'lost-to-other');
  assert.ok(res.incumbent);
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), stateBytes, 'state untouched');
  assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD'), mainHead);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), wtHead);
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false, 'no event appended');
  assert.equal(fs.existsSync(path.join(fx.WT, 'src/a.txt')), true, 'work left in place for the owner');
});

test('failed task: left pending, marker intact, partial edits stay UNCOMMITTED, next=recover_wave', () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] },
    ],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt', 'src/b.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n'); // done task's work
  write(fx.WT, 'src/b.txt', 'partial\n'); // FAILED task's partial edit

  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: {
      wave: 1,
      baseline: [],
      tasks: [
        digest(1, 'done'),
        digest(2, 'failed', { digest: { summary: 'tests red', blockers: ['suite fails'] } }),
      ],
    },
  });

  assert.deepEqual(res.recorded, [1]);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].id, 2);
  assert.deepEqual(res.failed[0].blockers, ['suite fails']);
  // Done task's file committed; failed task's partial edit NOT (recover's checkout must reset it).
  const codeFiles = git(fx.WT, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.deepEqual(codeFiles, ['src/a.txt']);
  assert.match(git(fx.WT, 'status', '--porcelain', '--', 'src/b.txt'), /src\/b\.txt/);
  // Marker stays so decide can recover; task 2 is the redispatch target.
  assert.equal(res.cleared, false);
  const after = readState(fx.statePath);
  assert.equal(after.active_run.wave, 1);
  assert.deepEqual(after.tasks.map((t) => t.status), ['done', 'pending']);
  assert.equal(res.next.action, 'recover_wave');
  assert.deepEqual(res.next.tasks.map((t) => t.id), [2]);
  assert.deepEqual(res.next.resetPaths, ['src/b.txt']);
});

test('preconditions: foreign-wave result, plan-run marker, no marker, unknown task id all refuse loudly', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  const base = { statePath: fx.statePath, self: fx.self, now: 2000 };
  assert.throws(
    () => recordWaveResult({ ...base, result: { wave: 2, tasks: [digest(1, 'done')] } }),
    /foreign result/
  );
  // Unknown task id: markTask throws BEFORE any write — state on disk is untouched.
  const bytes = fs.readFileSync(fx.statePath, 'utf8');
  assert.throws(() => recordWaveResult({ ...base, result: { wave: 1, tasks: [digest(99, 'done')] } }), /no task with id 99/);
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), bytes);

  const planState = { ...readState(fx.statePath), active_run: { kind: 'plan', task_id: 'p1' } };
  writeState(fx.statePath, planState);
  assert.throws(() => recordWaveResult({ ...base, result: { tasks: [] } }), /plan run/);
  writeState(fx.statePath, { ...planState, active_run: null });
  assert.throws(() => recordWaveResult({ ...base, result: { tasks: [] } }), /no active_run/);
});

test('qctl digest: stays pending (not a failure), surfaced with its backend descriptor', () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] },
    ],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt', 'src/b.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');

  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: {
      wave: 1,
      baseline: [],
      tasks: [
        digest(1, 'done'),
        { task_id: 2, backend: { kind: 'qctl', queue: 'gpu' }, digest: { task_id: 2, status: 'qctl' }, review: null },
      ],
    },
  });

  assert.deepEqual(res.recorded, [1]);
  assert.deepEqual(res.failed, []);
  assert.deepEqual(res.qctl, [{ id: 2, backend: { kind: 'qctl', queue: 'gpu' } }]);
  assert.equal(res.cleared, false, 'qctl task is still pending — marker stays for the L1 qctl path');
  assert.deepEqual(readState(fx.statePath).tasks.map((t) => t.status), ['done', 'pending']);
});

test('bin record-result honors owner_lock=off: no session id required (Codex P2 regression)', () => {
  // The bin glue must NOT resolve a Guard D identity before recordWaveResult's own
  // owner_lock check — a Codex/single-agent host has no CLAUDE_CODE_SESSION_ID at all.
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  writeState(fx.statePath, { ...readState(fx.statePath), concurrency: { owner_lock: 'off' } });
  write(fx.WT, 'src/a.txt', 'A\n');
  const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'masterplan.mjs');
  const resultPath = path.join(fx.bundleDir, 'r.json');
  fs.writeFileSync(resultPath, JSON.stringify({ wave: 1, baseline: [], tasks: [digest(1, 'done')] }));
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  const stdout = String(execFileSync('node', [BIN, 'record-result',
    `--state=${fx.statePath}`, `--result-file=${resultPath}`], { encoding: 'utf8', env }));
  const res = JSON.parse(stdout.slice(stdout.indexOf('{')));
  assert.equal(res.outcome, 'recorded');
  assert.deepEqual(res.recorded, [1]);
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
});

test('stale-epoch: a reaped worker resuming late is rejected before any state byte — reject beats the markTask pass', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', epoch: 5, scope: ['src/a.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');
  const mainHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  const wtHead = git(fx.WT, 'rev-parse', 'HEAD');
  const stateBytes = fs.readFileSync(fx.statePath, 'utf8');
  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: { wave: 1, epoch: 3, baseline: [], tasks: [digest(1, 'done')] },
  });
  assert.equal(res.outcome, 'stale-epoch');
  assert.equal(res.resultEpoch, 3);
  assert.equal(res.currentEpoch, 5);
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), stateBytes, 'state untouched');
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
  assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD'), mainHead);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), wtHead);
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false, 'no event appended');
});

test('current-epoch: a result whose epoch matches the marker records normally', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', epoch: 5, scope: ['src/a.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');
  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: { wave: 1, epoch: 5, baseline: [], tasks: [digest(1, 'done')] },
  });
  assert.equal(res.outcome, 'recorded');
  assert.deepEqual(res.recorded, [1]);
  assert.equal(res.cleared, true);
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
});

test('stale-epoch: an epoch-fenced marker rejects a result that carries no epoch', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', epoch: 2, scope: ['src/a.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');
  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] },
  });
  assert.equal(res.outcome, 'stale-epoch');
  assert.equal(res.resultEpoch, null);
  assert.equal(res.currentEpoch, 2);
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test('no-epoch marker: backward-compatible, no fencing applied', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');
  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] },
  });
  assert.equal(res.outcome, 'recorded');
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
});

// ===========================================================================
// dispatch provenance → degradation-visibility events (chunk A2)
// ===========================================================================

function readEvents(bundleDir) {
  const p = path.join(bundleDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('dispatch_degraded: emitted for a digest with dispatch.outcome=escalate, carrying task_id/outcome/reason/decision_id', () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] },
    ],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt', 'src/b.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');

  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: {
      wave: 1,
      baseline: [],
      tasks: [
        digest(1, 'done'),
        digest(2, 'blocked', { digest: {
          summary: 'execution escalated: backend_unconfigured',
          blockers: 'backend_unconfigured',
          dispatch: { outcome: 'escalate', reason: 'backend_unconfigured', decision_id: 'dec-77' },
        } }),
      ],
    },
  });

  assert.equal(res.outcome, 'recorded');
  const events = readEvents(fx.bundleDir);
  const degraded = events.filter((e) => e.type === 'dispatch_degraded');
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].task_id, 2);
  assert.equal(degraded[0].outcome, 'escalate');
  assert.equal(degraded[0].reason, 'backend_unconfigured');
  assert.equal(degraded[0].decision_id, 'dec-77');
  // The event lands BEFORE wave_recorded (same transaction, ordered).
  const idxDegraded = events.findIndex((e) => e.type === 'dispatch_degraded');
  const idxWave = events.findIndex((e) => e.type === 'wave_recorded');
  assert.ok(idxDegraded < idxWave, 'dispatch_degraded precedes wave_recorded');
  // Recording still proceeded: fail-VISIBLE, not fail-blocked.
  assert.deepEqual(res.recorded, [1]);
  assert.equal(res.failed[0].id, 2);
});

test('dispatch_degraded: emitted for dispatch.outcome=error', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });

  recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: {
      wave: 1,
      baseline: [],
      tasks: [
        digest(1, 'blocked', { digest: {
          summary: 'execution error during native spawn: connection refused',
          blockers: 'connection refused',
          dispatch: { outcome: 'error', reason: 'connection refused' },
        } }),
      ],
    },
  });

  const degraded = readEvents(fx.bundleDir).filter((e) => e.type === 'dispatch_degraded');
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].outcome, 'error');
  assert.equal(degraded[0].reason, 'connection refused');
  assert.equal(degraded[0].decision_id, null, 'absent decision_id normalizes to null');
});

test('dispatch_degraded: emitted when degraded_fallback is present even on a successful worker outcome, fallback carried verbatim', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');
  const fallback = { skipped: [{ backend: 'qwen-local', cause: 'health_probe_failed' }] };

  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: {
      wave: 1,
      baseline: [],
      tasks: [
        digest(1, 'done', { digest: {
          dispatch: { outcome: 'worker', reason: "routed to backend 'pi'", decision_id: 'dec-9', degraded_fallback: fallback },
        } }),
      ],
    },
  });

  assert.deepEqual(res.recorded, [1], 'done task records normally — degradation is visibility, not a block');
  const degraded = readEvents(fx.bundleDir).filter((e) => e.type === 'dispatch_degraded');
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].outcome, 'worker');
  assert.deepEqual(degraded[0].degraded_fallback, fallback);
});

test('dispatch_inline_designed: a clean inline_designed digest gets its own queryable event, NOT dispatch_degraded', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });

  recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: {
      wave: 1,
      baseline: [],
      tasks: [
        digest(1, 'blocked', { digest: {
          summary: 'execution returned execute_yourself',
          blockers: 'execute_yourself: Claude-tier route; route inline',
          dispatch: { outcome: 'inline_designed', reason: 'execute_yourself: Claude-tier route', decision_id: 'dec-5' },
        } }),
      ],
    },
  });

  const events = readEvents(fx.bundleDir);
  assert.equal(events.filter((e) => e.type === 'dispatch_degraded').length, 0, 'designed inline is NOT degraded');
  const inline = events.filter((e) => e.type === 'dispatch_inline_designed');
  assert.equal(inline.length, 1);
  assert.equal(inline[0].task_id, 1);
  assert.equal(inline[0].outcome, 'inline_designed');
  assert.equal(inline[0].decision_id, 'dec-5');
});

test('dispatch_degraded: an inline_designed digest WITH degraded_fallback is degraded (health-pruned chain), not designed-clean', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  const fallback = { skipped: [{ backend: 'pi', cause: 'backend_down' }] };

  recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: {
      wave: 1,
      baseline: [],
      tasks: [
        digest(1, 'blocked', { digest: {
          dispatch: { outcome: 'inline_designed', reason: 'execute_yourself: Claude-tier route', degraded_fallback: fallback },
        } }),
      ],
    },
  });

  const events = readEvents(fx.bundleDir);
  assert.equal(events.filter((e) => e.type === 'dispatch_inline_designed').length, 0);
  const degraded = events.filter((e) => e.type === 'dispatch_degraded');
  assert.equal(degraded.length, 1);
  assert.deepEqual(degraded[0].degraded_fallback, fallback);
});

test('dispatch events: v1 digests (no dispatch field) and clean worker outcomes emit NO dispatch events', () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] },
    ],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt', 'src/b.txt'], baseline: [] },
  });
  write(fx.WT, 'src/a.txt', 'A\n');
  write(fx.WT, 'src/b.txt', 'B\n');

  recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: {
      wave: 1,
      baseline: [],
      tasks: [
        digest(1, 'done'), // v1: no dispatch field at all
        digest(2, 'done', { digest: { dispatch: { outcome: 'worker', reason: "routed to backend 'pi'" } } }), // clean worker
      ],
    },
  });

  const events = readEvents(fx.bundleDir);
  assert.equal(events.filter((e) => e.type === 'dispatch_degraded').length, 0);
  assert.equal(events.filter((e) => e.type === 'dispatch_inline_designed').length, 0);
  assert.equal(events.at(-1).type, 'wave_recorded', 'the transaction event still lands');
});

test('dispatch events: land in the same MAIN state commit as wave_recorded', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });

  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: {
      wave: 1,
      baseline: [],
      tasks: [
        digest(1, 'blocked', { digest: {
          dispatch: { outcome: 'error', reason: 'spawn ENOENT' },
        } }),
      ],
    },
  });

  assert.ok(res.commits.state, 'a state commit exists');
  const stateFiles = git(fx.MAIN, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.ok(stateFiles.includes('docs/masterplan/t22/events.jsonl'), 'events.jsonl is in the state commit');
  const degraded = readEvents(fx.bundleDir).filter((e) => e.type === 'dispatch_degraded');
  assert.equal(degraded.length, 1);
});

test('watch-list breach in a SIBLING repo is reverted, not merely reported (vector-5 regression)', () => {
  // The 2026-08-04 e2e detected a child write into a watched sibling repo and then left the
  // file dirty — cleanup was manual. Step 3 only reverts what verifyScope sees, which is
  // worktree-relative; the sibling half had no reverter at all.
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });

  // A watched sibling repo carrying one committed, CLEAN file and one the wave will create.
  const sibling = path.join(fx.tmp, 'sibling');
  fs.mkdirSync(sibling, { recursive: true });
  git(sibling, 'init', '--initial-branch=main');
  git(sibling, 'config', 'user.email', 'test@test');
  git(sibling, 'config', 'user.name', 'test');
  git(sibling, 'config', 'commit.gpgsign', 'false');
  write(sibling, 'other.txt', 'committed content\n');
  git(sibling, 'add', '.');
  git(sibling, 'commit', '-q', '-m', 'seed');

  const baseline = captureWatchBaseline({
    mainRoot: fx.MAIN, bundleDir: fx.bundleDir, worktree: fx.WT, slug: 't22', scopePaths: ['src/a.txt'],
  });
  // Watch the sibling explicitly (the e2e reached it via an absolute task scope).
  baseline.snapshots[sibling] = {
    ...snapshotRepoState(sibling), prefix: null, isMain: false,
  };
  writeWatchBaseline(fx.bundleDir, 1, baseline);

  write(fx.WT, 'src/a.txt', 'A\n');                    // legitimate in-scope work
  write(sibling, 'other.txt', 'SIBLING-BREACH\n');     // tracked+clean at launch → modified
  write(sibling, 'litter.txt', 'created by a child\n'); // absent at launch → created

  const res = recordWaveResult({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] },
  });

  assert.equal(res.watch.ok, false, 'the sibling breach still fails the wave loud');
  const modified = res.watch.violations.find((v) => v.rel === 'other.txt');
  assert.ok(modified, `sibling modification named; got ${JSON.stringify(res.watch.violations)}`);
  assert.match(modified.reason, /tracked file modified/, 'classified as a modification, not a creation');

  // The point of the regression: the sibling repo is CLEAN again afterwards.
  assert.equal(
    fs.readFileSync(path.join(sibling, 'other.txt'), 'utf8'), 'committed content\n',
    'the tracked sibling file is restored to its launch content',
  );
  assert.equal(
    fs.existsSync(path.join(sibling, 'litter.txt')), false,
    'the file the child created in the sibling is removed',
  );
  assert.equal(
    git(sibling, 'status', '--porcelain').trim(), '',
    'the watched sibling repo is left clean, so no hand cleanup is needed',
  );
  assert.equal(res.watch.reverted.length, 2, 'both sibling paths are reported as reverted');

  // In-scope work is untouched by the sibling revert.
  assert.equal(fs.readFileSync(path.join(fx.WT, 'src/a.txt'), 'utf8'), 'A\n');
});

test('a sibling file that was ALREADY dirty at launch is reported but never reverted (CD-2)', () => {
  // The negative control for the test above: a blanket "revert every watch violation" would
  // pass that test and destroy the user's in-progress work here.
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  const sibling = path.join(fx.tmp, 'sibling-wip');
  fs.mkdirSync(sibling, { recursive: true });
  git(sibling, 'init', '--initial-branch=main');
  git(sibling, 'config', 'user.email', 'test@test');
  git(sibling, 'config', 'user.name', 'test');
  git(sibling, 'config', 'commit.gpgsign', 'false');
  write(sibling, 'seed.txt', 'seed\n');
  git(sibling, 'add', '.');
  git(sibling, 'commit', '-q', '-m', 'seed');
  write(sibling, 'wip.txt', 'USER DRAFT\n'); // dirty BEFORE the wave — the user's work

  const baseline = captureWatchBaseline({
    mainRoot: fx.MAIN, bundleDir: fx.bundleDir, worktree: fx.WT, slug: 't22', scopePaths: ['src/a.txt'],
  });
  baseline.snapshots[sibling] = { ...snapshotRepoState(sibling), prefix: null, isMain: false };
  writeWatchBaseline(fx.bundleDir, 1, baseline);

  write(fx.WT, 'src/a.txt', 'A\n');
  write(sibling, 'wip.txt', 'CLOBBERED BY A CHILD\n');

  const res = recordWaveResult({
    statePath: fx.statePath, self: fx.self, now: 2000,
    result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] },
  });

  assert.equal(res.watch.ok, false, 'the breach is still surfaced');
  assert.equal(res.watch.reverted.length, 0, 'nothing was reverted');
  assert.ok(
    res.watch.unrestored.some((u) => String(u.path).includes('wip.txt')),
    `the un-restored breach is reported explicitly; got ${JSON.stringify(res.watch.unrestored)}`,
  );
  assert.equal(
    fs.readFileSync(path.join(sibling, 'wip.txt'), 'utf8'), 'CLOBBERED BY A CHILD\n',
    'the file is left exactly as found — the wave does not git-checkout over user WIP',
  );
});
