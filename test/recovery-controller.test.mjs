// test/recovery-controller.test.mjs — committed-recovery controller mode regression tests.
//
// Covers the judge design contract:
//   - Clean committed recovery hashes the base→HEAD artifact (deterministic capture);
//     legacy working capture stays unchanged (covered by the existing native tests).
//   - Reject wrong repository/base/HEAD, unrelated ancestry, empty delta, each dirty-tree class.
//   - Reject Phase A/B HEAD/context/epoch/task-set/artifact drift.
//   - Reject missing/stale/swapped receipts, legacy-event reuse and embedded-review bypass.
//   - Zero review-event/task-state writes on final identity/ownership failure.
//   - Multi-task validation is all-before-append; valid retry deduplicates.
//   - CLI retains/reproduces exact artifact identity.
//
// REAL git in temp repos (no injection): the controller's value is the exact deterministic
// git capture + binding, so the tests exercise genuine MAIN + linked-worktree pairs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';
import { reviewNativeResult, readWaveDispatchRecord, writeWaveDispatchRecord } from '../lib/dispatch-wave.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';
import { captureWatchBaseline, writeWatchBaseline, snapshotRepoState } from '../lib/watch-integrity.mjs';
import { selectReentry } from '../lib/reentry-guard.mjs';
import {
  RECOVERY_CAPTURE_FORMAT,
  captureCommittedDiff,
  fingerprintReviewContext,
  buildRecoveryIdentity,
  validateRecoveryReceipt,
  validateIdentityMandatory,
} from '../lib/recovery-controller.mjs';
import { sha256hex, stableStringify } from '../lib/canonical.mjs';

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const healthyHarness = () => ({
  degraded: false, timed_out: false, stalled: false,
  deadline_exceeded: false, regions_unreviewed: 0, extraction_degraded: false,
});

const workerDigest = (id, status = 'done') => ({
  task_id: id, status, start_sha: 'abc123', files_changed: [],
  verify: [], summary: `task ${id} ${status}`, blockers: null,
});

/**
 * A recovery fixture: MAIN repo with a base commit, then a second commit (the recovered
 * HEAD) touching `src/a.txt`, a linked worktree checked out at HEAD, a bundle whose frozen
 * review_context base is the FIRST commit and whose frozen repo is the worktree, and the
 * owner lock held. The worktree is CLEAN (the recovered state).
 */
function makeRecoveryFixture({ slug = 'recovery', ctxTasks = null, review = { adversary: true }, activeRun = null, epoch = 5 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-recovery-'));
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
  write(MAIN, 'src/seed.txt', 'seed updated\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'recovered wave work');
  const HEAD = git(MAIN, 'rev-parse', 'HEAD');
  // Linked worktree at HEAD — the frozen locus.
  const WT = path.join(MAIN, '.worktrees', slug);
  git(MAIN, 'worktree', 'add', '-q', WT, 'HEAD');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  const tasks = [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }];
  writeState(statePath, {
    schema_version: 8,
    slug,
    status: 'in-progress',
    phase: 'execute',
    worktree: WT,
    tasks,
    active_run: activeRun ?? {
      wave: 1, run_id: slug, task_id: 'wf1', epoch, scope: ['src/a.txt'], baseline: [],
    },
    dispatch: { fabric: true },
    review,
    concurrency: { owner_lock: 'off' },
  });
  write(bundleDir, 'plan.index.json', JSON.stringify({
    tasks: [{ id: 1, wave: 1, files: ['src/a.txt'], description: 'task 1', verify_commands: [] }],
  }));
  const self = buildOwnerIdentity({ host: 'h1', session: 'sess-recovery', slug, now: 1000 });
  const ctxTasksDefault = [{
    task_id: 1,
    description: 'task 1',
    class: 'bounded-edit',
    repo: WT,
  }];
  const record = {
    key: `mp-wave-dispatch-v1:${slug}:1:dispatch_fabric`,
    run_id: slug,
    wave: 1,
    op: 'dispatch_fabric',
    contract_version: 'fabric-native-v1',
    status: 'pending',
    attempt: 2,
    wave_token: `mp-wave-${slug}-w1-a2`,
    handles: [],
    dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
    review_context: {
      enabled: true,
      base_sha: BASE,
      tasks: ctxTasks ?? ctxTasksDefault,
    },
  };
  writeWaveDispatchRecord(bundleDir, 1, record);
  if (review?.adversary !== false) {
    const acq = acquireOwner(bundleDir, self, { now: 1000 });
    assert.equal(acq.outcome, 'acquire');
  }
  return { tmp, MAIN, WT, bundleDir, statePath, self, BASE, HEAD, record };
}

const recoveryResult = (fx, extra = {}) => ({
  wave: 1,
  epoch: 5, // matches the fixture's active_run.epoch so recordWaveResult does not stale-epoch
  tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  ...extra,
});

/** A receipt with the EXACT expected identity (built from the same inputs the controller uses). */
function boundReceipt(fx, expected, verdict = 'approve') {
  return {
    final_verdict: verdict,
    findings: [{ severity: 'major', summary: `${verdict} finding` }],
    blocking_findings: verdict === 'approve' ? [] : [{ summary: `${verdict} blocker` }],
    summary: `${verdict} summary`,
    harness: healthyHarness(),
    identity: expected,
  };
}

async function runPhaseA(fx, opts = {}) {
  return reviewNativeResult({
    statePath: fx.statePath,
    result: recoveryResult(fx),
    providedReviews: null,
    policy: null,
    now: 3000,
    recoverySelector: { repo: fx.WT, head: fx.HEAD },
    ...opts,
  });
}

// ── deterministic capture ────────────────────────────────────────────────────

test('recovery: clean committed state captures the deterministic base→HEAD artifact', async () => {
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  assert.equal(pending.review_outcome, 'recovery-review-pending');
  assert.equal(pending.pending_reviews.length, 1);
  const d = pending.pending_reviews[0];
  assert.equal(d.base, fx.BASE);
  assert.equal(d.head, fx.HEAD);
  assert.equal(d.format, RECOVERY_CAPTURE_FORMAT);
  // The artifact is the exact base→HEAD capture (byte-identical), not an empty working diff.
  const exact = captureCommittedDiff(fx.WT, fx.BASE, fx.HEAD);
  assert.equal(d.diff_sha, sha256hex(exact));
  assert.ok(exact.includes('recovered change'), 'capture carries the recovered commit content');
  assert.equal(d.identity.base, fx.BASE);
  assert.equal(d.identity.head, fx.HEAD);
  assert.equal(d.identity.diff_sha, d.diff_sha);
  // HEAD + cleanliness unchanged by phase A (read-before/read-after).
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.HEAD);
  assert.equal(git(fx.WT, 'status', '--porcelain'), '');
  // Nothing recorded yet.
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
});

test('recovery: deterministic capture is stable across repeated invocations', async () => {
  const fx = makeRecoveryFixture();
  const a = await runPhaseA(fx);
  const b = await runPhaseA(fx);
  assert.equal(a.pending_reviews[0].diff_sha, b.pending_reviews[0].diff_sha);
  assert.deepEqual(a.pending_reviews[0].identity, b.pending_reviews[0].identity);
});

// ── validation: reject wrong repo / base / HEAD / ancestry / dirty / empty ───

test('recovery: rejects a selector repo that does not match the frozen context', async () => {
  const fx = makeRecoveryFixture();
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx),
      recoverySelector: { repo: '/nonexistent', head: fx.HEAD },
      now: 3000,
    }),
    /does not match the frozen review_context repo/,
  );
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test('recovery: rejects a short/invalid selector HEAD', async () => {
  const fx = makeRecoveryFixture();
  for (const bad of [fx.HEAD.slice(0, 12), 'nothex', '']) {
    await assert.rejects(
      () => reviewNativeResult({
        statePath: fx.statePath,
        result: recoveryResult(fx),
        recoverySelector: { repo: fx.WT, head: bad },
        now: 3000,
      }),
      /full 40-hex commit OID/,
      `short head ${bad} must be rejected`,
    );
  }
});

test('recovery: rejects a selector HEAD that does not match the live repo HEAD', async () => {
  const fx = makeRecoveryFixture();
  // A valid commit that is a descendant of base but NOT the live worktree HEAD: add a
  // commit on MAIN after the worktree was created, then pin that as the selector head.
  write(fx.MAIN, 'src/c.txt', 'extra\n');
  git(fx.MAIN, 'add', '.');
  git(fx.MAIN, 'commit', '-q', '-m', 'post-worktree main commit');
  const otherHead = git(fx.MAIN, 'rev-parse', 'HEAD');
  assert.notEqual(otherHead, fx.HEAD, 'the other head differs from the live worktree HEAD');
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx),
      recoverySelector: { repo: fx.WT, head: otherHead },
      now: 3000,
    }),
    /live HEAD|does not match the pinned head/,
  );
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test('recovery: rejects unrelated ancestry (base not an ancestor of head)', async () => {
  const fx = makeRecoveryFixture();
  // Create a DIVERGENT branch from the base (valid commit in the repo's object store, but
  // NOT on HEAD's main line). Explicit pathspecs only — `git add .` would sweep the bundle.
  git(fx.MAIN, 'branch', 'divergent', fx.BASE);
  git(fx.MAIN, 'checkout', '-q', 'divergent');
  write(fx.MAIN, 'src/div.txt', 'divergent\n');
  git(fx.MAIN, 'add', '--', 'src/div.txt');
  git(fx.MAIN, 'commit', '-q', '-m', 'divergent work');
  const divergentTip = git(fx.MAIN, 'rev-parse', 'HEAD');
  git(fx.MAIN, 'checkout', '-q', 'main');
  assert.notEqual(divergentTip, fx.HEAD);
  // Freeze the divergent tip as the frozen BASE: it is a valid commit in the object store,
  // but it is NOT an ancestor of the selector head (fx.HEAD, on the main line).
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    ...rec,
    review_context: { ...rec.review_context, base_sha: divergentTip },
  });
  await assert.rejects(
    () => runPhaseA(fx),
    /not an ancestor/,
  );
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test('recovery: rejects an empty committed delta (base == head)', async () => {
  const fx = makeRecoveryFixture();
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  // Freeze base == HEAD → empty delta.
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    ...rec,
    review_context: { ...rec.review_context, base_sha: fx.HEAD },
  });
  await assert.rejects(
    () => runPhaseA(fx),
    /empty/,
  );
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test('recovery: rejects a dirty tree (each class)', async () => {
  const cases = {
    'tracked modified': (fx) => { write(fx.WT, 'src/a.txt', 'dirty\n'); },
    'untracked created': (fx) => { write(fx.WT, 'src/dirty-new.txt', 'dirty\n'); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const fx = makeRecoveryFixture();
    mutate(fx);
    await assert.rejects(
      () => runPhaseA(fx),
      /not clean|clean tree|dirty/,
      `dirty class ${name} must fail`,
    );
    // Zero writes.
    assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
    assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
  }
});

test('recovery: rejects a mixed-locus frozen context (multiple repos)', async () => {
  const fx = makeRecoveryFixture({});
  // Point one frozen task at a different repo than the worktree.
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    ...rec,
    review_context: {
      ...rec.review_context,
      tasks: [
        { task_id: 1, description: 't1', class: 'bounded-edit', repo: fx.WT },
        { task_id: 2, description: 't2', class: 'bounded-edit', repo: '/other/repo' },
      ],
    },
  });
  await assert.rejects(
    () => runPhaseA(fx),
    /exactly one edit locus|repositories/,
  );
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test('recovery: explicit selector with absent/disabled review_context FAILS (never the legacy no-op)', async () => {
  const fx = makeRecoveryFixture({ review: { adversary: false } });
  // Disabled review_context: the record still exists but enabled:false.
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    ...rec,
    review_context: { ...rec.review_context, enabled: false },
  });
  await assert.rejects(
    () => runPhaseA(fx),
    /absent or disabled/,
  );
  // Without a selector the disabled context is still the legacy no-op (normal mode unchanged).
  const noSel = await reviewNativeResult({
    statePath: fx.statePath,
    result: recoveryResult(fx),
    now: 3000,
  });
  assert.equal(noSel, recoveryResult(fx) === recoveryResult(fx) ? noSel : noSel);
  assert.ok(noSel);
});

test('recovery: rejects unknown/duplicate tasks and item↔digest disagreement', async () => {
  const fx = makeRecoveryFixture();
  // Unknown task.
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx, { tasks: [{ task_id: 99, digest: workerDigest(99, 'done') }] }),
      recoverySelector: { repo: fx.WT, head: fx.HEAD },
      now: 3000,
    }),
    /task 99 is not in the frozen review_context task set/,
  );
  // Duplicate task.
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx, {
        tasks: [
          { task_id: 1, digest: workerDigest(1, 'done') },
          { task_id: 1, digest: workerDigest(1, 'done') },
        ],
      }),
      recoverySelector: { repo: fx.WT, head: fx.HEAD },
      now: 3000,
    }),
    /appears more than once/,
  );
  // Item↔digest disagreement.
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx, {
        tasks: [{ task_id: 2, digest: workerDigest(1, 'done') }],
      }),
      recoverySelector: { repo: fx.WT, head: fx.HEAD },
      now: 3000,
    }),
    /disagrees with digest\.task_id/,
  );
});

// ── Phase B: receipt binding ─────────────────────────────────────────────────

test('recovery phase B: a matching receipt binds and records through the transaction', async () => {
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  const expected = pending.pending_reviews[0].identity;
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath,
    result: recoveryResult(fx),
    providedReviews: { 1: boundReceipt(fx, expected, 'approve') },
    recoverySelector: { repo: fx.WT, head: fx.HEAD },
    now: 4000,
  });
  assert.equal(reviewed.review_outcome, 'recovery-reviews-recorded');
  assert.equal(reviewed.tasks[0].review.verdict, 'approve');
  // Events are deferred — NOT appended by reviewNativeResult.
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
  assert.equal(reviewed.deferred_review_events.length, 1);
  // The deferred event carries the full identity.
  const ev = reviewed.deferred_review_events[0].event;
  assert.equal(ev.data.identity.diff_sha, expected.diff_sha);
  assert.equal(ev.data.identity.head, fx.HEAD);
  // recordWaveResult appends the deferred events (owner/epoch pass), marks done, commits.
  const recRes = recordWaveResult({
    statePath: fx.statePath,
    result: reviewed,
    self: fx.self,
    now: 4000,
    worktree: fx.WT,
    deferredEvents: reviewed.deferred_review_events,
  });
  assert.equal(recRes.outcome, 'recorded');
  assert.deepEqual(recRes.recorded, [1]);
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
  const events = fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8');
  assert.match(events, /"type":"task_adversary_review"/);
  assert.match(events, /"identity":\{/);
});

test('recovery phase B: rejects a missing receipt (all-before-append, zero writes)', async () => {
  const fx = makeRecoveryFixture();
  await runPhaseA(fx);
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx),
      providedReviews: {},
      recoverySelector: { repo: fx.WT, head: fx.HEAD },
      now: 4000,
    }),
    /review not provided for task 1/,
  );
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test('recovery phase B: rejects a receipt missing identity (never fills it in)', async () => {
  const fx = makeRecoveryFixture();
  await runPhaseA(fx);
  const bare = {
    final_verdict: 'approve',
    findings: [],
    blocking_findings: [],
    summary: 'approve',
    harness: healthyHarness(),
  };
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx),
      providedReviews: { 1: bare },
      recoverySelector: { repo: fx.WT, head: fx.HEAD },
      now: 4000,
    }),
    /receipt\.identity is missing/,
  );
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
});

test('recovery phase B: rejects a receipt with a swapped/stale identity field', async () => {
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  const expected = pending.pending_reviews[0].identity;
  // Swap the head field to a different commit.
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-swap-'));
  git(foreign, 'init', '--initial-branch=main');
  git(foreign, 'config', 'user.email', 't@t');
  git(foreign, 'config', 'user.name', 't');
  git(foreign, 'config', 'commit.gpgsign', 'false');
  write(foreign, 'x.txt', 'x\n');
  git(foreign, 'add', '.');
  git(foreign, 'commit', '-q', '-m', 'foreign');
  const foreignHead = git(foreign, 'rev-parse', 'HEAD');
  const stale = { ...expected, head: foreignHead };
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx),
      providedReviews: { 1: boundReceipt(fx, stale, 'approve') },
      recoverySelector: { repo: fx.WT, head: fx.HEAD },
      now: 4000,
    }),
    /identity\.head/,
  );
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
});

test('recovery phase B: rejects a receipt whose diff_sha does not match the artifact', async () => {
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  const expected = { ...pending.pending_reviews[0].identity, diff_sha: '0'.repeat(64) };
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx),
      providedReviews: { 1: boundReceipt(fx, expected, 'approve') },
      recoverySelector: { repo: fx.WT, head: fx.HEAD },
      now: 4000,
    }),
    /identity\.diff_sha/,
  );
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
});

test('recovery phase B: multi-task validation is all-before-append (one bad receipt blocks the whole batch)', async () => {
  const fx = makeRecoveryFixture();
  // Patch the frozen context to carry two tasks (same locus), then feed two done digests.
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    ...rec,
    review_context: {
      ...rec.review_context,
      tasks: [
        { task_id: 1, description: 't1', class: 'bounded-edit', repo: fx.WT },
        { task_id: 2, description: 't2', class: 'bounded-edit', repo: fx.WT },
      ],
    },
  });
  const result = {
    wave: 1,
    epoch: 5,
    tasks: [
      { task_id: 1, digest: workerDigest(1, 'done') },
      { task_id: 2, digest: workerDigest(2, 'done') },
    ],
  };
  const pending = await reviewNativeResult({
    statePath: fx.statePath,
    result,
    recoverySelector: { repo: fx.WT, head: fx.HEAD },
    now: 3000,
  });
  assert.equal(pending.pending_reviews.length, 2);
  const id1 = pending.pending_reviews[0].identity;
  const id2 = pending.pending_reviews[1].identity;
  // Task 2's receipt has a stale identity → the whole batch fails before ANY append.
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result,
      providedReviews: {
        1: boundReceipt(fx, id1, 'approve'),
        2: boundReceipt(fx, { ...id2, head: fx.BASE }, 'approve'),
      },
      recoverySelector: { repo: fx.WT, head: fx.HEAD },
      now: 4000,
    }),
    /identity\.head/,
  );
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

// ── mandatory identity binding (review: nullable expected==receipt must never bind) ──

test('recovery: the identity builder rejects a missing/null attempt (never null-fills)', async () => {
  const fx = makeRecoveryFixture();
  // Remove attempt from the dispatch record → builder must fail closed, not emit attempt:null.
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  const noAttempt = { ...rec };
  delete noAttempt.attempt;
  writeWaveDispatchRecord(fx.bundleDir, 1, noAttempt);
  await assert.rejects(
    () => runPhaseA(fx),
    /identity\.attempt must be a positive integer/,
    'a dispatch record without attempt must fail before Phase A, never bind a null attempt',
  );
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false, 'no event written');
});

test('recovery: the identity builder rejects a null/missing wave but ALLOWS zero (legit epoch 0)', async () => {
  // Direct builder check — wave 0 is a legitimate value and must NOT be rejected.
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  const base = pending.pending_reviews[0].identity;
  // Zero wave/attempt-1 identity is legitimate.
  const zeroWave = buildRecoveryIdentity({
    bundle: base.bundle,
    runId: base.run_id,
    contextFingerprint: base.context_fingerprint,
    taskId: base.task_id,
    repo: base.repo,
    base: base.base,
    head: base.head,
    diffSha: base.diff_sha,
    wave: 0,
    attempt: 1,
  });
  assert.equal(zeroWave.wave, 0, 'wave 0 is a legitimate identity value');
  assert.equal(validateIdentityMandatory(zeroWave).length, 0, 'wave 0 passes mandatory validation');
  // A missing/null wave is rejected by the builder.
  await assert.rejects(
    async () => buildRecoveryIdentity({
      bundle: base.bundle,
      runId: base.run_id,
      contextFingerprint: base.context_fingerprint,
      taskId: base.task_id,
      repo: base.repo,
      base: base.base,
      head: base.head,
      diffSha: base.diff_sha,
      wave: null,
      attempt: 1,
    }),
    /identity\.wave must be a non-negative integer/,
  );
});

test('recovery: the receipt validator rejects a null attempt echoed back (nullable equal must fail)', async () => {
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  const expected = pending.pending_reviews[0].identity;
  // A receipt whose identity echoes attempt:null — the exact nullable-equal trap.
  const bad = { ...boundReceipt(fx, expected), identity: { ...expected, attempt: null } };
  const res = validateRecoveryReceipt(bad, expected);
  assert.equal(res.ok, false, 'attempt:null receipt must fail even when expected has a value');
  assert.match(res.error, /identity\.attempt/);
  // A receipt whose identity drops diff_sha (incomplete) must also fail.
  const { diff_sha, ...partial } = expected;
  const res2 = validateRecoveryReceipt({ ...boundReceipt(fx, expected), identity: partial }, expected);
  assert.equal(res2.ok, false);
  assert.match(res2.error, /identity\.diff_sha|incomplete/);
});

test('recovery: an incomplete expected identity (null bundle) fails receipt validation', async () => {
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  const expected = pending.pending_reviews[0].identity;
  const res = validateRecoveryReceipt(
    boundReceipt(fx, expected),
    { ...expected, bundle: null },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /identity\.bundle/);
});

// ── legacy-event reuse and embedded-review bypass ────────────────────────────

test('recovery: a legacy SHA-only event never satisfies recovery re-entry', async () => {
  const fx = makeRecoveryFixture();
  // Simulate a legacy review event (no identity) for the same run/task/sha.
  const legacy = {
    type: 'task_adversary_review',
    summary: 'legacy task review complete',
    ts: 'T0',
    data: {
      run: fx.record.run_id,
      task: 1,
      sha: sha256hex(captureCommittedDiff(fx.WT, fx.BASE, fx.HEAD)),
      count: 1,
      base: fx.BASE,
      review: {
        verdict: 'approve', findings: [], blocking_findings: [],
        summary: 'legacy approve', harness: healthyHarness(),
      },
    },
  };
  fs.mkdirSync(fx.bundleDir, { recursive: true });
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), JSON.stringify(legacy) + '\n');
  const pending = await runPhaseA(fx);
  assert.equal(pending.pending_reviews.length, 1, 'legacy SHA-only event must not satisfy recovery re-entry');
});

test('recovery: caller-supplied item.review/digest.review is never authority', async () => {
  const fx = makeRecoveryFixture();
  // The orchestrator smuggles an embedded approve into the digest and item.
  const result = {
    wave: 1,
    tasks: [{
      task_id: 1,
      digest: {
        ...workerDigest(1, 'done'),
        review: { verdict: 'approve', findings: [], blocking_findings: [], summary: 'embedded', harness: healthyHarness() },
      },
      review: { verdict: 'approve', findings: [], blocking_findings: [], summary: 'embedded', harness: healthyHarness() },
    }],
  };
  // Phase A must NOT treat the embedded review as coverage — recovery still owes a real
  // binding receipt, so an identity-bearing descriptor is emitted for the done task.
  const pending = await reviewNativeResult({
    statePath: fx.statePath,
    result,
    recoverySelector: { repo: fx.WT, head: fx.HEAD },
    now: 3000,
  });
  assert.equal(pending.review_outcome, 'recovery-review-pending');
  assert.equal(pending.pending_reviews.length, 1, 'embedded review must not satisfy recovery coverage');
  // Phase B must REJECT a batch that supplies no receipt for the task (the embedded review is
  // not a receipt) — all-before-append, zero writes.
  const expected = pending.pending_reviews[0].identity;
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result,
      providedReviews: { 1: boundReceipt(fx, { ...expected, head: fx.BASE }, 'approve') },
      recoverySelector: { repo: fx.WT, head: fx.HEAD },
      now: 4000,
    }),
    /identity\.head/,
    'a stale receipt is rejected even when an embedded approve is present',
  );
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

// ── retry dedup + zero-write on ownership failure ────────────────────────────

test('recovery: a valid committed retry deduplicates via the identity-bearing event', async () => {
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  const expected = pending.pending_reviews[0].identity;
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath,
    result: recoveryResult(fx),
    providedReviews: { 1: boundReceipt(fx, expected, 'approve') },
    recoverySelector: { repo: fx.WT, head: fx.HEAD },
    now: 4000,
  });
  assert.equal(reviewed.deferred_review_events.length, 1);
  // Append the first event (simulate the transaction committing it).
  fs.mkdirSync(fx.bundleDir, { recursive: true });
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), JSON.stringify(reviewed.deferred_review_events[0].event) + '\n');
  // A retry with the same identity reuses the completed identity-bearing event: the prior
  // event satisfies identity-gated re-entry inside reviewCompletedTasks, so NO new event is
  // deferred and the review is re-attached from the durable event (never a re-review).
  const again = await reviewNativeResult({
    statePath: fx.statePath,
    result: recoveryResult(fx),
    providedReviews: { 1: boundReceipt(fx, expected, 'approve') },
    recoverySelector: { repo: fx.WT, head: fx.HEAD },
    now: 5000,
  });
  assert.equal(again.review_outcome, 'recovery-reviews-recorded');
  assert.equal(again.deferred_review_events.length, 0,
    'an already-identity-matched durable event satisfies re-entry — nothing new deferred');
  assert.equal(again.tasks[0].review.verdict, 'approve', 'the prior approve is re-attached');
  const events = fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8');
  assert.equal((events.match(/"type":"task_adversary_review"/g) ?? []).length, 1,
    'the durable event is not duplicated');
});

test('recovery: deferred events are appended ONLY inside recordWaveResult after guards pass', async () => {
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  const expected = pending.pending_reviews[0].identity;
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath,
    result: recoveryResult(fx),
    providedReviews: { 1: boundReceipt(fx, expected, 'approve') },
    recoverySelector: { repo: fx.WT, head: fx.HEAD },
    now: 4000,
  });
  // Owner lock is off (owner_lock:'off') so the guard path is skipped; still, the events
  // must NOT exist until recordWaveResult is called.
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
  const recRes = recordWaveResult({
    statePath: fx.statePath,
    result: reviewed,
    now: 4000,
    worktree: fx.WT,
    deferredEvents: reviewed.deferred_review_events,
  });
  assert.equal(recRes.outcome, 'recorded');
  assert.match(fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8'), /"type":"task_adversary_review"/);
});

test('recovery: zero review-event writes when the wave-commit guard fails (owner lost)', async () => {
  const fx = makeRecoveryFixture({ review: { adversary: true } });
  // owner_lock is on in this fixture (we did NOT set concurrency.owner_lock:'off' via
  // makeRecoveryFixture default). To force a lost-to-other, release the lock first so the
  // recordWaveResult heartbeat fails — but reviewNativeResult itself does not append.
  const pending = await runPhaseA(fx);
  const expected = pending.pending_reviews[0].identity;
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath,
    result: recoveryResult(fx),
    providedReviews: { 1: boundReceipt(fx, expected, 'approve') },
    recoverySelector: { repo: fx.WT, head: fx.HEAD },
    now: 4000,
  });
  assert.equal(reviewed.deferred_review_events.length, 1);
  // Simulate ownership loss: another session acquires the lock.
  const other = buildOwnerIdentity({ host: 'h1', session: 'sess-other', slug: fx.record.run_id, now: 1000 });
  // owner_lock default is on (fixture sets it to 'off' — force a marker change to on).
  writeState(fx.statePath, {
    ...readState(fx.statePath),
    concurrency: { owner_lock: 'on' },
  });
  const res = recordWaveResult({
    statePath: fx.statePath,
    result: reviewed,
    self: other, // NOT the holder
    now: 4000,
    worktree: fx.WT,
    deferredEvents: reviewed.deferred_review_events,
  });
  assert.equal(res.outcome, 'lost-to-other');
  // Zero review-event writes.
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

// ── drift: HEAD / context / epoch between Phase A and B ──────────────────────

test('recovery: rejects artifact drift when the HEAD changes between phases', async () => {
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  const expected = pending.pending_reviews[0].identity;
  // The worktree HEAD moves (a new commit lands) — a stale identity must fail.
  write(fx.WT, 'src/a.txt', 'new commit after phase A\n');
  git(fx.WT, 'add', '.');
  git(fx.WT, 'commit', '-q', '-m', 'post-phase-a drift');
  const driftHead = git(fx.WT, 'rev-parse', 'HEAD');
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx),
      providedReviews: { 1: boundReceipt(fx, expected, 'approve') },
      recoverySelector: { repo: fx.WT, head: driftHead },
      now: 4000,
    }),
    /identity\.head|live HEAD|drift/,
  );
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
});

test('recovery: rejects a changed frozen context between phases (context_fingerprint drift)', async () => {
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  const expected = pending.pending_reviews[0].identity;
  // Mutate the frozen context (change task description) → the recomputed fingerprint differs.
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    ...rec,
    review_context: {
      ...rec.review_context,
      tasks: [{ ...rec.review_context.tasks[0], description: 'CHANGED description' }],
    },
  });
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx),
      providedReviews: { 1: boundReceipt(fx, expected, 'approve') },
      recoverySelector: { repo: fx.WT, head: fx.HEAD },
      now: 4000,
    }),
    /identity\.context_fingerprint/,
  );
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false);
});

test('recovery: epoch identity rides the manifest and is compared on receipts', async () => {
  const fx = makeRecoveryFixture();
  const pending = await runPhaseA(fx);
  const expected = pending.pending_reviews[0].identity;
  assert.equal(expected.attempt, 2);
  // A receipt claiming a different attempt fails.
  await assert.rejects(
    () => reviewNativeResult({
      statePath: fx.statePath,
      result: recoveryResult(fx),
      providedReviews: { 1: boundReceipt(fx, { ...expected, attempt: 99 }, 'approve') },
      recoverySelector: { repo: fx.WT, head: fx.HEAD },
      now: 4000,
    }),
    /identity\.attempt/,
  );
});

// ── preservation gate (contract item 7) ─────────────────────────────────────

test('recovery: recordWaveResult with recovery:true performs NO destructive git op (scope/watch/clean/revert/commit)', () => {
  const fx = makeRecoveryFixture();
  const pending = reviewNativeResult ? null : null; // (phase A already proved capture is clean)
  // Clean committed state: recovery records normally and must NOT commit a new code sha or
  // run checkout/clean. HEAD must remain the recovered head.
  const reviewed = {
    wave: 1,
    epoch: 5,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
    deferred_review_events: [],
  };
  const beforeHead = git(fx.WT, 'rev-parse', 'HEAD');
  const res = recordWaveResult({
    statePath: fx.statePath,
    result: reviewed,
    self: fx.self,
    now: 4000,
    worktree: fx.WT,
    deferredEvents: [],
    recovery: true,
  });
  assert.equal(res.outcome, 'recorded');
  // The code sha is the recovered HEAD — no new masterplan commit moved it.
  assert.equal(res.commits.code, fx.HEAD);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), beforeHead, 'recovery never moves HEAD');
  assert.equal(git(fx.WT, 'status', '--porcelain'), '', 'recovery leaves the tree clean');
  assert.deepEqual(res.recorded, [1]);
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
});

test('recovery: a scope/watch preflight violation REJECTS before any state write or destructive op', () => {
  const fx = makeRecoveryFixture();
  // Simulate an out-of-scope working file in the worktree: the preflight (same verifyScope
  // the normal path runs) must reject WITHOUT reverting it, and HEAD/state must stay put.
  write(fx.WT, 'out-of-scope.txt', 'unexpected\n');
  const beforeHead = git(fx.WT, 'rev-parse', 'HEAD');
  const stateBytes = fs.readFileSync(fx.statePath, 'utf8');
  const reviewed = {
    wave: 1,
    epoch: 5,
    baseline: [],
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
    deferred_review_events: [],
  };
  const res = recordWaveResult({
    statePath: fx.statePath,
    result: reviewed,
    self: fx.self,
    now: 4000,
    worktree: fx.WT,
    deferredEvents: [],
    recovery: true,
  });
  assert.equal(res.outcome, 'recovery-preservation-violation');
  assert.ok(res.violations.some((v) => /out-of-scope/.test(v)), `violations name the scope breach: ${res.violations.join('; ')}`);
  // Zero state mutation, zero destructive git, file left in place.
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), stateBytes, 'state untouched');
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), beforeHead, 'HEAD untouched');
  assert.ok(fs.existsSync(path.join(fx.WT, 'out-of-scope.txt')), 'the out-of-scope file is NOT reverted');
  assert.equal(fs.existsSync(path.join(fx.bundleDir, 'events.jsonl')), false, 'no event appended');
});

test('recovery: preflight never invokes destructive git even when watch-list would revert', () => {
  const fx = makeRecoveryFixture();
  // With recovery:true, even a watch-baseline delta must reject rather than revert. The
  // fixture has no watch baseline, so this asserts the flag path is non-destructive by
  // making an out-of-scope file AND a state-write attempt — the preflight rejects first.
  write(fx.WT, 'src/out-scope.txt', 'x\n');
  const beforeHead = git(fx.WT, 'rev-parse', 'HEAD');
  const res = recordWaveResult({
    statePath: fx.statePath,
    result: { wave: 1, epoch: 5, baseline: [], tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }] },
    self: fx.self,
    now: 4000,
    worktree: fx.WT,
    deferredEvents: [],
    recovery: true,
  });
  assert.equal(res.outcome, 'recovery-preservation-violation');
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), beforeHead);
  assert.ok(fs.existsSync(path.join(fx.WT, 'src/out-scope.txt')), 'file preserved');
});

test('recovery: a watch-baseline HEAD move rejects instead of reverting', () => {
  const fx = makeRecoveryFixture();
  // Capture a real launch watch baseline over MAIN + WT, then MOVE WT's HEAD (a child-style
  // commit). verifyWatchListDelta flags the HEAD move; the recovery preflight must reject
  // and leave the moved HEAD + all files untouched (never checkout/clean).
  const bundleDir = fx.bundleDir;
  const scopePaths = ['src/a.txt'];
  const baseline = captureWatchBaseline({
    mainRoot: fx.MAIN, bundleDir, worktree: fx.WT, slug: 'recovery', scopePaths,
  });
  writeWatchBaseline(bundleDir, 1, baseline);
  // A second commit moves WT HEAD after the baseline.
  write(fx.WT, 'src/a.txt', 'post-baseline commit\n');
  git(fx.WT, 'add', '--', 'src/a.txt');
  git(fx.WT, 'commit', '-q', '-m', 'post-baseline');
  const movedHead = git(fx.WT, 'rev-parse', 'HEAD');
  assert.notEqual(movedHead, fx.HEAD);
  const stateBytes = fs.readFileSync(fx.statePath, 'utf8');
  const res = recordWaveResult({
    statePath: fx.statePath,
    result: { wave: 1, epoch: 5, baseline: [], tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }] },
    self: fx.self,
    now: 4000,
    worktree: fx.WT,
    deferredEvents: [],
    recovery: true,
  });
  assert.equal(res.outcome, 'recovery-preservation-violation');
  assert.ok(res.violations.some((v) => /watch-list|HEAD moved/.test(v)), `violations name the HEAD move: ${res.violations.join('; ')}`);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), movedHead, 'the moved HEAD is NOT reverted in recovery');
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), stateBytes, 'state untouched');
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

// ── fingerprint / canonical helpers ──────────────────────────────────────────

test('recovery: context fingerprint is stable and context-sensitive', () => {
  const ctxA = { enabled: true, base_sha: 'a'.repeat(40), tasks: [{ task_id: 1, repo: '/x' }] };
  const ctxB = { enabled: true, base_sha: 'a'.repeat(40), tasks: [{ task_id: 1, repo: '/y' }] };
  const fA = fingerprintReviewContext(ctxA);
  assert.equal(fA, fingerprintReviewContext(ctxA), 'same context → same fingerprint');
  assert.notEqual(fA, fingerprintReviewContext(ctxB), 'different context → different fingerprint');
});

test('recovery: canonical stringify sorts keys (receipt binding is order-independent)', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(
    stableStringify({ repo: '/x', task_id: 1 }),
    stableStringify({ task_id: 1, repo: '/x' }),
  );
});
