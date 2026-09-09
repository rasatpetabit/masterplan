// test/recovery-heartbeat.test.mjs — recovery-mode owner-heartbeat DEFERRAL regression.
//
// Defect (zero-write contract, fixed in lib/wave-commit.mjs): the strict owner heartbeat ran
// at transaction step 0 — BEFORE the committed-recovery preservation preflight (~149 vs ~177).
// A refused/malformed recovery therefore wrote the owner heartbeat sentinel (`.owner.hb.*`)
// even though the transaction must refuse with ZERO bytes written (state, events, owner lock,
// heartbeat all untouched).
//
// Contract under test (REAL owner lock ON — this file never uses the owner_lock:'off'
// escape hatch; the fixture mirrors the real dispatch-wave acquireAndWatch ordering: acquire →
// heartbeat → capture launch watch baseline → commit the recovered work base→head → persist
// the wave-dispatch record with the frozen review_context):
//   - Deferred success: a clean committed recovery whose preservation preflight passes runs
//     the deferred heartbeat and records — valid ownership is still required BEFORE writes.
//   - Malformed/refused recovery (missing watch baseline; committed path outside the declared
//     scope): outcome is recovery-preservation-violation and the owner lock, owner heartbeat,
//     state.yml and events.jsonl are BYTE-FOR-BYTE unchanged — no heartbeat write leaks out.
//   - Lost ownership (lock held by a foreign owner) with a passing preflight still refuses
//     with zero state/event writes.
//
// REAL git in disposable temp repos (no injection), mirroring recovery-committed-locus.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity, ownerLockPath, ownerHeartbeatPath } from '../lib/owner.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';
import { captureWatchBaseline, writeWatchBaseline } from '../lib/watch-integrity.mjs';
import { writeWaveDispatchRecord } from '../lib/dispatch-wave.mjs';

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const workerDigest = (id, status = 'done') => ({
  task_id: id, status, start_sha: 'abc123', files_changed: [],
  verify: [], summary: `task ${id} ${status}`, blockers: null,
});

/**
 * Committed-recovery fixture with the REAL owner lock ON:
 *   1. MAIN + base commit; linked worktree at base.
 *   2. Bundle written with concurrency.owner_lock 'on'.
 *   3. Owner lock acquired + heartbeated (the dispatch-wave acquireAndWatch ordering) BEFORE
 *      the launch watch baseline is captured at base.
 *   4. The wave's work is committed base→head on the edit locus (WT).
 *   5. Persisted wave-dispatch record freezes review_context.base_sha = base and the single
 *      edit locus.
 *
 * `commitFiles` overrides which paths the recovered commit touches (default: the scope).
 * `skipAcquire` leaves the bundle WITHOUT the owner lock (for the lost-ownership test).
 */
function makeHeartbeatFixture({ scope = ['src/a.txt'], commitFiles = null, skipAcquire = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-recovery-hb-'));
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
  const WT = path.join(MAIN, '.worktrees', 'recovery');
  git(MAIN, 'worktree', 'add', '-q', WT, BASE);
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', 'recovery');
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8,
    slug: 'recovery',
    status: 'in-progress',
    phase: 'execute',
    worktree: WT,
    tasks: [{ id: 1, status: 'pending', wave: 1, files: scope }],
    active_run: {
      wave: 1, run_id: 'recovery', task_id: 'wf1', epoch: 5, scope, baseline: [],
    },
    dispatch: { fabric: true },
    review: { adversary: true },
    // The REAL owner lock is ON — this fixture never opts out of Guard D.
    concurrency: { owner_lock: 'on' },
  });
  write(bundleDir, 'plan.index.json', JSON.stringify({
    tasks: [{ id: 1, wave: 1, files: scope, description: 'task 1', verify_commands: [] }],
  }));
  const self = buildOwnerIdentity({ host: 'h1', session: 'sess-heartbeat', slug: 'recovery', now: 1000 });
  // Mirror the real acquireAndWatch ordering: Guard D ownership first (acquire + heartbeat),
  // THEN the launch watch baseline capture at the edit-locus base.
  if (!skipAcquire) {
    const acq = acquireOwner(bundleDir, self, { now: 1000 });
    assert.equal(acq.outcome, 'acquire');
  }
  const baseline = captureWatchBaseline({
    mainRoot: MAIN, bundleDir, worktree: WT, slug: 'recovery', scopePaths: scope,
  });
  writeWatchBaseline(bundleDir, 1, baseline);
  const baselinePath = path.join(bundleDir, '.wave-1.watch.json');
  // The wave's work is committed on the edit locus (WT), base→head.
  const files = commitFiles ?? scope;
  for (const f of files) write(WT, f, 'recovered change\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'recovered wave work');
  const HEAD = git(WT, 'rev-parse', 'HEAD');
  writeWaveDispatchRecord(bundleDir, 1, {
    key: 'mp-wave-dispatch-v1:recovery:1:dispatch_fabric',
    run_id: 'recovery',
    wave: 1,
    op: 'dispatch_fabric',
    contract_version: 'fabric-native-v1',
    status: 'pending',
    attempt: 2,
    wave_token: 'mp-recovery-w1-a2',
    handles: [],
    dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
    review_context: {
      enabled: true,
      base_sha: BASE,
      tasks: [{ task_id: 1, description: 'task 1', class: 'bounded-edit', repo: WT }],
    },
  });
  return { tmp, MAIN, WT, bundleDir, statePath, baselinePath, self, BASE, HEAD };
}

const recoveryResult = () => ({
  wave: 1,
  epoch: 5, // matches the fixture's active_run.epoch so recordWaveResult does not stale-epoch
  tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
});

function callRecovery(fx, { self, now = 4000, head = fx.HEAD, result = recoveryResult() } = {}) {
  return recordWaveResult({
    statePath: fx.statePath,
    result,
    self: self ?? fx.self,
    now,
    worktree: fx.WT,
    deferredEvents: [],
    recovery: true,
    recoverySelector: { repo: fx.WT, head },
  });
}

/** Snapshot the owner sentinels + state + events so a refused recovery can prove zero writes. */
function snapshotWriteTargets(fx) {
  const lockPath = ownerLockPath(fx.bundleDir);
  const hbPath = ownerHeartbeatPath(fx.bundleDir, fx.self);
  const eventsPath = path.join(fx.bundleDir, 'events.jsonl');
  return {
    lock: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null,
    hb: fs.existsSync(hbPath) ? fs.readFileSync(hbPath, 'utf8') : null,
    state: fs.readFileSync(fx.statePath, 'utf8'),
    events: fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8') : null,
    lockExists: fs.existsSync(lockPath),
    hbExists: fs.existsSync(hbPath),
    eventsExists: fs.existsSync(eventsPath),
  };
}

function assertWriteTargetsUnchanged(fx, before) {
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), before.state, 'state.yml byte-identical');
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending', 'task not marked');
  const eventsPath = path.join(fx.bundleDir, 'events.jsonl');
  assert.equal(fs.existsSync(eventsPath), before.eventsExists, 'events.jsonl presence unchanged');
  if (before.eventsExists) {
    assert.equal(fs.readFileSync(eventsPath, 'utf8'), before.events, 'events.jsonl byte-identical');
  }
  const lockPath = ownerLockPath(fx.bundleDir);
  assert.equal(fs.existsSync(lockPath), before.lockExists, 'owner lock presence unchanged');
  if (before.lockExists) {
    assert.equal(fs.readFileSync(lockPath, 'utf8'), before.lock, 'owner lock byte-identical');
  }
  const hbPath = ownerHeartbeatPath(fx.bundleDir, fx.self);
  assert.equal(fs.existsSync(hbPath), before.hbExists, 'owner heartbeat presence unchanged');
  if (before.hbExists) {
    assert.equal(fs.readFileSync(hbPath, 'utf8'), before.hb,
      'owner heartbeat byte-identical — the refused recovery must not refresh it');
  }
}

test('recovery-heartbeat: invalid task throws before refreshing the heartbeat', () => {
  const fx = makeHeartbeatFixture();
  const before = snapshotWriteTargets(fx);
  const result = recoveryResult();
  result.tasks.push({ task_id: 999, digest: workerDigest(999, 'done') });
  assert.throws(() => callRecovery(fx, { result }), /999/);
  assertWriteTargetsUnchanged(fx, before);
});

test('recovery-heartbeat: clean committed recovery with the owner lock ON records (deferred heartbeat passes, ownership still required)', () => {
  const fx = makeHeartbeatFixture();
  const lockPath = ownerLockPath(fx.bundleDir);
  const hbPath = ownerHeartbeatPath(fx.bundleDir, fx.self);
  // Sanity: the fixture really holds the lock with a heartbeat on disk.
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(fs.existsSync(hbPath), true);
  const res = callRecovery(fx);
  assert.equal(res.outcome, 'recorded', JSON.stringify(res));
  assert.deepEqual(res.recorded, [1]);
  assert.equal(res.commits.code, fx.HEAD, 'recovery never creates a new masterplan commit');
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.HEAD, 'WT HEAD is the recovered head');
  assert.equal(readState(fx.statePath).tasks[0].status, 'done', 'task marked done');
  // The deferred heartbeat legitimately refreshed our own sentinel after preservation passed.
  const hb = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
  assert.equal(hb.lastHeartbeat, 4000, 'the deferred heartbeat refreshed our own hb to the record time');
  assert.ok(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), 'the recorded recovery appended events');
});

test('recovery-heartbeat: a MALFORMED recovery (missing watch baseline) refuses with owner lock, heartbeat, state and events BYTE-UNCHANGED', () => {
  const fx = makeHeartbeatFixture();
  // Remove the launch watch baseline — the preflight must fail closed (cannot prove no drift).
  fs.unlinkSync(fx.baselinePath);
  const before = snapshotWriteTargets(fx);
  const res = callRecovery(fx);
  assert.equal(res.outcome, 'recovery-preservation-violation');
  assert.ok(res.violations.some((v) => /watch baseline is missing or unparseable/.test(v)),
    `violations name the missing baseline: ${res.violations.join('; ')}`);
  assertWriteTargetsUnchanged(fx, before);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.HEAD, 'WT HEAD untouched');
});

test('recovery-heartbeat: a REFUSED recovery (committed path outside the declared scope) leaves the owner heartbeat BYTE-UNCHANGED', () => {
  const fx = makeHeartbeatFixture({ commitFiles: ['src/a.txt', 'src/other.txt'] });
  const before = snapshotWriteTargets(fx);
  const res = callRecovery(fx);
  assert.equal(res.outcome, 'recovery-preservation-violation');
  assert.ok(res.violations.some((v) => /outside the declared scope/.test(v)),
    `violations name the scope breach: ${res.violations.join('; ')}`);
  assertWriteTargetsUnchanged(fx, before);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.HEAD, 'WT HEAD untouched');
  assert.equal(git(fx.WT, 'status', '--porcelain'), '', 'WT tree untouched (clean)');
});

test('recovery-heartbeat: valid ownership is still required — a passing preflight under a FOREIGN lock refuses lost-to-other with zero state/event writes', () => {
  const fx = makeHeartbeatFixture({ skipAcquire: true });
  // A different session holds the lock (the rightful owner), not fx.self.
  const other = buildOwnerIdentity({ host: 'h1', session: 'sess-other', slug: 'recovery', now: 1000 });
  const acq = acquireOwner(fx.bundleDir, other, { now: 1000 });
  assert.equal(acq.outcome, 'acquire');
  const stateBytes = fs.readFileSync(fx.statePath, 'utf8');
  const hbPath = ownerHeartbeatPath(fx.bundleDir, fx.self);
  const lockBytes = fs.readFileSync(ownerLockPath(fx.bundleDir), 'utf8');
  const res = callRecovery(fx, { self: fx.self });
  assert.equal(res.outcome, 'lost-to-other');
  // Zero writes: state untouched, no events, our heartbeat never created, foreign lock intact.
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), stateBytes, 'state untouched');
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending', 'task not marked');
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false, 'no event appended');
  assert.equal(fs.existsSync(hbPath), false, "the non-owner's heartbeat file is never created");
  assert.equal(fs.readFileSync(ownerLockPath(fx.bundleDir), 'utf8'), lockBytes, 'the foreign owner lock is untouched');
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.HEAD, 'WT HEAD untouched');
});
