// test/recovery-committed-locus.test.mjs — committed-recovery SELECTOR gate (contract item 7).
//
// Covers the explicit pinned-selector flow end-to-end through recordWaveResult:
//   - Success: a REAL linked worktree whose launch watch baseline was captured BEFORE the
//     recovered commit landed (baseline edit-locus HEAD == frozen base), then the wave's
//     work is committed base→head on the edit locus, and recordWaveResult({recovery:true,
//     recoverySelector}) records it. Only the edit-locus HEAD movement is permitted in the
//     watch comparison; the on-disk launch baseline stays byte-for-byte unchanged.
//   - Failures (zero writes, zero destructive git): recovered commit touches a path outside
//     the declared scope; selector head != live WT HEAD; launch baseline edit-locus HEAD !=
//     frozen base; a NON-edit-locus watched repo (MAIN) moves its HEAD.
//
// REAL git in disposable temp repos (no injection): the gate's value is that it re-checks the
// same integrity the wave relied on at launch against genuine MAIN + linked-worktree pairs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';
import { captureWatchBaseline, writeWatchBaseline, readWatchBaseline } from '../lib/watch-integrity.mjs';
import { writeWaveDispatchRecord } from '../lib/dispatch-wave.mjs';
import { committedDeltaPaths, preflightRecovery } from '../lib/recovery-preflight.mjs';

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
 * Committed-recovery fixture with a BASELINE-BEFORE-COMMIT edit locus:
 *   1. MAIN + base commit; linked worktree at base.
 *   2. Bundle written; launch watch baseline captured while the edit locus sits at base
 *      (the exact launch-time state the real acquireAndWatch protocol freezes).
 *   3. The wave's work is committed base→head on the edit locus (WT).
 *   4. Persisted wave-dispatch record freezes review_context.base_sha = base and the
 *      single edit locus.
 *
 * `commitFiles` overrides which paths the recovered commit touches (default: the scope, so
 * the recovered commit is in scope). `overrideBaseline` lets a test corrupt the on-disk
 * launch baseline after capture.
 */
function makeCommittedLocusFixture({ scope = ['src/a.txt'], commitFiles = null, overrideBaseline = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-committed-locus-'));
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
  // Linked worktree at BASE — the edit locus BEFORE any wave work.
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
    concurrency: { owner_lock: 'off' }, // single-agent fixture — skip the owner heartbeat
  });
  write(bundleDir, 'plan.index.json', JSON.stringify({
    tasks: [{ id: 1, wave: 1, files: scope, description: 'task 1', verify_commands: [] }],
  }));
  // LAUNCH WATCH BASELINE captured BEFORE the recovered commit: the edit locus sits at BASE.
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
  // Persisted wave-dispatch record: frozen review_context (base_sha = BASE, single locus).
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
  if (overrideBaseline) {
    // The test rewrites the on-disk baseline (a corruption the gate must detect, not fix).
    fs.writeFileSync(baselinePath, JSON.stringify(overrideBaseline(baseline, { BASE, HEAD, WT }), null, 2) + '\n', 'utf8');
  }
  const self = buildOwnerIdentity({ host: 'h1', session: 'sess-committed-locus', slug: 'recovery', now: 1000 });
  return { tmp, MAIN, WT, bundleDir, statePath, baselinePath, self, BASE, HEAD };
}

const recoveryResult = (fx) => ({
  wave: 1,
  epoch: 5, // matches the fixture's active_run.epoch so recordWaveResult does not stale-epoch
  tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
});

function callRecovery(fx, selectorHead) {
  return recordWaveResult({
    statePath: fx.statePath,
    result: recoveryResult(fx),
    self: fx.self,
    now: 4000,
    worktree: fx.WT,
    deferredEvents: [],
    recovery: true,
    recoverySelector: { repo: fx.WT, head: selectorHead ?? fx.HEAD },
  });
}

/** A recovery that must FAIL CLOSED: preservation violation with zero writes / destructive git. */
function assertPreservationViolation(fx, expectPatterns, selectorHead = fx.HEAD) {
  const stateBytes = fs.readFileSync(fx.statePath, 'utf8');
  const baselineBytes = fs.readFileSync(fx.baselinePath, 'utf8');
  const beforeWtHead = git(fx.WT, 'rev-parse', 'HEAD');
  const beforeMainHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  let res;
  try {
    res = callRecovery(fx, selectorHead);
  } catch (err) {
    assert.fail(`recordWaveResult THREW instead of returning a preservation violation: ${err.message}`);
  }
  assert.equal(res.outcome, 'recovery-preservation-violation', `outcome: ${JSON.stringify(res)}`);
  for (const re of expectPatterns) {
    assert.ok(res.violations.some((v) => re.test(v)), `violations match ${re}: ${res.violations.join('; ')}`);
  }
  // Zero writes / zero destructive ops.
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), stateBytes, 'state untouched');
  assert.equal(fs.readFileSync(fx.baselinePath, 'utf8'), baselineBytes, 'launch watch baseline untouched');
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending', 'task not marked');
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), beforeWtHead, 'WT HEAD untouched');
  assert.equal(git(fx.WT, 'status', '--porcelain'), '', 'WT tree untouched (clean)');
  assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD'), beforeMainHead, 'no MAIN commit moved HEAD');
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false, 'no event appended');
}

// ── SUCCESS: baseline-before-commit through recordWaveResult ───────────────

test('committed-locus: baseline-before-commit recovery records through recordWaveResult with the selector', () => {
  const fx = makeCommittedLocusFixture();
  const baselineBytes = fs.readFileSync(fx.baselinePath, 'utf8');
  // The PREFLIGHT-level recovery-aware watch comparison (this module's contract) permits
  // ONLY the checked edit-locus HEAD move and reports a clean verdict BEFORE any write.
  const pre = preflightRecovery({
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
    recoverySelector: { repo: fx.WT, head: fx.HEAD },
  });
  assert.equal(pre.ok, true, `preflight must pass the committed-locus recovery: ${pre.violations.join('; ')}`);
  assert.ok(pre.watch.checked, 'preflight watch comparison ran');
  assert.equal(pre.watch.ok, true, 'preflight watch comparison permits ONLY the edit-locus HEAD move');
  // The full transaction then records through recordWaveResult with the selector.
  const res = callRecovery(fx);
  assert.equal(res.outcome, 'recorded', JSON.stringify(res));
  assert.deepEqual(res.recorded, [1]);
  assert.equal(res.watch.ok, true, 'recording retains the recovery-aware watch verdict');
  assert.ok(!fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8').includes('watch_list_breach'),
    'authorized recovered HEAD must not emit a false watch breach');
  // The code sha is the recovered HEAD — recovery never creates a new masterplan commit.
  assert.equal(res.commits.code, fx.HEAD);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.HEAD, 'WT HEAD is the recovered head');
  assert.equal(git(fx.WT, 'status', '--porcelain'), '', 'WT tree clean');
  assert.equal(readState(fx.statePath).tasks[0].status, 'done', 'task marked done');
  // The launch watch baseline file is byte-for-byte unchanged (comparison used a local view).
  assert.equal(fs.readFileSync(fx.baselinePath, 'utf8'), baselineBytes, 'baseline file preserved');
});

// ── FAILURES: out-of-scope / HEAD mismatch / base mismatch / other-repo drift ─

test('committed-locus: a recovered commit touching a path outside the declared scope is rejected', () => {
  const fx = makeCommittedLocusFixture({ commitFiles: ['src/a.txt', 'src/other.txt'] });
  assertPreservationViolation(fx, [/outside the declared scope/]);
});

test('committed-locus: a selector head that does not match the live WT HEAD is rejected', () => {
  const fx = makeCommittedLocusFixture();
  // A post-baseline MAIN commit that is NOT the live worktree HEAD (the worktree is detached
  // at the recovered commit). Pin that as the selector head — live HEAD must win.
  write(fx.MAIN, 'src/extra.txt', 'extra\n');
  git(fx.MAIN, 'add', '--', 'src/extra.txt');
  git(fx.MAIN, 'commit', '-q', '-m', 'post-baseline main commit');
  const otherHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  assert.notEqual(otherHead, fx.HEAD, 'the other head differs from the live worktree HEAD');
  assertPreservationViolation(fx, [/live HEAD .* does not match the pinned head/], otherHead);
});

test('committed-locus: committedDeltaPaths rejects a non-round-trippable (invalid UTF-8) path', () => {
  const fx = makeCommittedLocusFixture();
  const invalid = Buffer.from([0x80, 0x00]); // lone continuation byte + NUL terminator
  const fakeExec = () => invalid;
  assert.throws(
    () => committedDeltaPaths(fx.WT, fx.BASE, fx.HEAD, fakeExec),
    /not valid UTF-8/,
  );
});

test('committed-locus: disabled review_context fails preflight (never a silent ok)', () => {
  const fx = makeCommittedLocusFixture();
  const recPath = path.join(fx.bundleDir, 'wave-1.dispatch.json');
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  rec.review_context = { ...rec.review_context, enabled: false };
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2));
  const pre = preflightRecovery({
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
    recoverySelector: { repo: fx.WT, head: fx.HEAD },
  });
  assert.equal(pre.ok, false, `disabled context must not pass: ${pre.violations.join('; ')}`);
  assert.ok(
    pre.violations.some((v) => /disabled/.test(v)),
    `violations name the disabled context: ${pre.violations.join('; ')}`,
  );
});

test('committed-locus: a launch baseline whose edit-locus HEAD differs from the frozen base is rejected', () => {
  // R6: the ORIGINAL-baseline head constraint is enforced in verifyRecoverySelector
  // BEFORE compareWatchWithRecoveryHead substitutes the recovered head. A baseline
  // whose edit-locus HEAD is not the frozen base is an unauthorized pre-launch move
  // and must reject — substitution must not mask it.
  // Corrupt the on-disk baseline: claim the edit locus was at the RECOVERED head at launch,
  // while the frozen base (and the real launch) was at BASE. The gate must detect that the
  // recovered commit does not provably build on the frozen base.
  const fx = makeCommittedLocusFixture({
    overrideBaseline: (baseline, { HEAD, WT }) => {
      const snapshots = {};
      for (const [key, s] of Object.entries(baseline.snapshots)) {
        if (s && s.isMain === false && path.resolve(String(s.repo ?? '')) === path.resolve(WT)) {
          snapshots[key] = { ...s, head: HEAD };
        } else {
          snapshots[key] = s;
        }
      }
      return { ...baseline, snapshots };
    },
  });
  assertPreservationViolation(fx, [/edit-locus HEAD .* does not equal the frozen base/]);
});

test('committed-locus: HEAD movement in a NON-edit-locus watched repo (MAIN) is rejected', () => {
  const fx = makeCommittedLocusFixture();
  // MAIN is a watched repo but NOT the edit locus — its HEAD must not move at all.
  write(fx.MAIN, 'src/extra.txt', 'extra\n');
  git(fx.MAIN, 'add', '--', 'src/extra.txt');
  git(fx.MAIN, 'commit', '-q', '-m', 'main head moved during the wave');
  assertPreservationViolation(fx, [/watch-list violation.*HEAD moved/]);
});
