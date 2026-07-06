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
  assert.deepEqual(res.blocking_reviews, [{ id: 2, findings: ['F1'] }]);
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

test('failed task: left pending, marker intact, partial edits stay UNCOMMITTED, next=recover_and_redispatch', () => {
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
  assert.equal(res.next.action, 'recover_and_redispatch');
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
