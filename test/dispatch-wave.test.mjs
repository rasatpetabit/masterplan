// test/dispatch-wave.test.mjs — the dispatch_fabric op consumer (lib/dispatch-wave.mjs).
//
// REAL git in temp repos (the continue.test.mjs pattern): the module's value is the exact
// interleaving of the idempotency record, the native spawn-plan seam, and the
// record-result transaction, so the tests drive genuine MAIN+worktree bundles through
// `mp continue` (which writes the phase-1 marker dispatch-wave consumes) and inject only
// the routing-resolution / review seams. Covered behaviors:
//
//   1. Flag-off → fail-closed (A3): state.dispatch.fabric unset → outcome 'flag-off',
//      nothing re-launched, reason names fabric as the only wave path and the bundle
//      as unexecutable (the legacy L2 ops it used to cite are deleted).
//   2. Native spawn plan: one descriptor per routed task (buildWorkItem shape) resolved
//      from the repo-local routing policy; worker digests recorded via recordWaveResult
//      (task done, marker cleared, wave_recorded event, dispatch.outcome:'worker').
//   3. Idempotent re-invoke: an existing 'pending' record (accepted-but-unobserved) is
//      returned as-is — nothing is re-launched.
//   4. --takeover supersedes a stuck pending attempt (attempt N+1, history archived).
//   5. A 'dispatched' record re-drives record-result from the stored digests — nothing re-launched.
//   6. Ownership: a live foreign owner blocks launch and re-drive; a pre-claimed attempt
//      marker makes the second writer lose the O_EXCL claim (no double dispatch).
//   7. Routing inputs are frozen in the record at attempt 1 and reused on retries; a
//      codex-suppressed host produces descriptors identical to the launch op payload.
//   8. Multi-repo locus: absolute MAIN scope canonicalizes to the run worktree; sibling
//      prefixed files land on a sibling worktree with create_files + stripped paths.
//   9. Key/record substrate unit behavior (encoding, atomic create-or-return-existing).
//  10. Per-task adversary review (config-gated on state.review.adversary): FULL working
//      diff in the payload (never scope-filtered), verdict in digest.review /
//      item.review → blocking_reviews[], run+task+sha re-entry idempotency, owed-but-absent
//      review → skipped event + verdict 'error', review-off → no lane calls and no writes,
//      and D6 independence (approve never bypasses verify-scope).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  dispatchWaveViaFabric,
  reviewNativeResult,
  composeWaveDispatchKey,
  waveDispatchRecordPath,
  readWaveDispatchRecord,
  createWaveDispatchRecord,
  writeWaveDispatchRecord,
  claimAttemptMarker,
  WAVE_DISPATCH_KEY_VERSION,
  captureFullWorkingDiff,
  buildNativeSpawnPlan,
  gateAndValidate,
  resolveWaveContext,
  buildDescriptors,
  acquireAndWatch,
} from '../lib/dispatch-wave.mjs';
import { buildWaveLaunchContext } from '../lib/wave.mjs';
import { continueRun } from '../lib/continue.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { buildTaskReviewEvent } from '../lib/reentry-guard.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const planEntry = (id, wave, files) => ({
  id, wave, files, description: `task ${id}`, verify_commands: [],
});

// A MAIN repo, a fabric-flagged v8 bundle, and plan.index.json beside it (the
// continue.test.mjs fixture shape + state.dispatch.fabric — the live gate).
function makeFixture({ tasks, planIndex, slug = 'dwave', fabric = true, extra = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-dwave-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8,
    slug,
    status: 'in-progress',
    phase: 'execute',
    tasks,
    active_run: null,
    ...(fabric ? { dispatch: { fabric: true } } : {}),
    ...extra,
  });
  if (planIndex) write(bundleDir, 'plan.index.json', JSON.stringify({ tasks: planIndex }));
  const self = buildOwnerIdentity({ host: 'h1', session: 'sess-A', slug, now: 1000 });
  return { tmp, MAIN, bundleDir, statePath, self };
}

// Run `mp continue` to create the worktree + phase-1 launching marker and return
// the emitted dispatch_fabric op (the exact state dispatch-wave consumes).
function launchViaContinue(fx) {
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(op.op, 'dispatch_fabric', `expected dispatch_fabric, got ${JSON.stringify(op)}`);
  return op;
}

/** A worker digest the child's report carries back. */
const workerDigest = (id, status = 'done', files = []) => ({
  task_id: id, status, start_sha: 'abc123', files_changed: files,
  verify: [], summary: `task ${id} ${status}`, blockers: null,
});

const healthyHarness = () => ({
  degraded: false, timed_out: false, stalled: false,
  deadline_exceeded: false, regions_unreviewed: 0, extraction_degraded: false,
});

const approveRecord = {
  final_verdict: 'approve', findings: [], blocking_findings: [],
  summary: 'looks fine', harness: healthyHarness(),
};

const rejectRecord = {
  final_verdict: 'reject',
  findings: [{ severity: 'high', summary: 'introduces a data race' }],
  blocking_findings: [{ summary: 'introduces a data race', proof: 'data race' }],
  summary: 'blocking data race',
  harness: healthyHarness(),
};

function readEvents(bundleDir) {
  try {
    return fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 1. Flag gate
// ---------------------------------------------------------------------------

test('flag-off → fail-closed: fabric is the only wave path since L2 deletion (A3)', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    fabric: false,
    slug: 'dw-off',
  });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  assert.equal(res.outcome, 'flag-off');
  assert.equal(res.dispatched, false);
  // A3: the reason must no longer cite deleted legacy ops — it must state that
  // fabric is the ONLY wave path and the bundle is unexecutable.
  assert.match(res.reason, /ONLY wave path/);
  assert.match(res.reason, /unexecutable/);
  assert.doesNotMatch(res.reason, /legacy dispatch_fabric\/dispatch_fabric ops apply/);
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1), null, 'no record written');
});


// Simulate the harness executing the native spawn plan: edits applied in the
// wave worktree, the child reports a digest per task, and the orchestrator
// ingests the provided native reviews then records the result.
async function recordNativeWave(fx, res, { edits = {}, providedReviews = null, statuses = {} } = {}) {
  const WT = res.plan.tasks[0].cwd;
  for (const [rel, content] of Object.entries(edits)) write(WT, rel, content);
  const result = {
    wave: res.wave,
    tasks: res.plan.tasks.map((t) => ({
      task_id: t.task_id,
      digest: workerDigest(t.task_id, statuses[t.task_id] ?? 'done'),
    })),
  };
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath, result, providedReviews, now: 3000,
  });
  if (reviewed.review_outcome === 'native-review-pending') return { result, reviewed };
  const recorded = recordWaveResult({
    statePath: fx.statePath, result: reviewed, self: fx.self, now: 3100, worktree: WT,
  });
  // bin/record-result parity: a successful record finalizes the wave-dispatch record.
  const existing = readWaveDispatchRecord(fx.bundleDir, res.wave);
  if (existing && existing.status === 'pending') {
    writeWaveDispatchRecord(fx.bundleDir, res.wave, {
      ...existing, status: 'recorded', completed_at: 'T-rec',
      record_outcome: { recorded: recorded.recorded, failed: recorded.failed, cleared: recorded.cleared },
    });
  }
  return { result, reviewed, recorded };
}

// ---------------------------------------------------------------------------
// 3. Idempotency — the accepted-but-unobserved window
// ---------------------------------------------------------------------------

test('idempotent re-invoke: an existing pending record is returned — nothing is re-launched', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-idem',
  });
  launchViaContinue(fx);
  // Simulate a prior invocation that persisted the record and died after the
  // spawn may have been accepted (the crash window the key exists for).
  const key = composeWaveDispatchKey('dw-idem', 1);
  const { created } = createWaveDispatchRecord(fx.bundleDir, {
    key, run_id: 'dw-idem', wave: 1, op: 'dispatch_fabric',
    contract_version: 'fabric-native-v1', status: 'pending', attempt: 1,
    dispatched_at: 'T0', tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
  });
  assert.equal(created, true);

  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  assert.equal(res.outcome, 'reused');
  assert.equal(res.dispatched, false);
  assert.equal(res.reused, true);
  assert.equal(res.status, 'pending');
  assert.equal(res.record.attempt, 1);
  // Nothing recorded, task untouched.
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test('--takeover supersedes a stuck pending attempt: attempt 2 dispatches, history archives attempt 1', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-take',
  });
  launchViaContinue(fx);
  createWaveDispatchRecord(fx.bundleDir, {
    key: composeWaveDispatchKey('dw-take', 1), run_id: 'dw-take', wave: 1, op: 'dispatch_fabric',
    contract_version: 'fabric-native-v1', status: 'pending', attempt: 1,
    dispatched_at: 'T0', tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
  });

  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000, takeover: true,
  });
  assert.equal(res.outcome, 'native-spawn-plan');
  assert.equal(res.record.attempt, 2);
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal(rec.status, 'pending', 'the new attempt persists pending BEFORE launch');
  assert.equal(rec.attempt, 2);
  assert.equal(rec.history.length, 1);
  assert.equal(rec.history[0].status, 'superseded');
});

test("a 'dispatched' record re-drives record-result from the stored digests — nothing re-launched", async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-redrive',
  });
  launchViaContinue(fx);
  // A prior attempt got digests durable but died before the record transaction.
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    key: composeWaveDispatchKey('dw-redrive', 1), run_id: 'dw-redrive', wave: 1, op: 'dispatch_fabric',
    contract_version: 'fabric-native-v1', status: 'dispatched', attempt: 1, dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
    result: { wave: 1, tasks: [{ task_id: 1, digest: { ...workerDigest(1), dispatch: { outcome: 'worker', reason: "routed to backend 'pi'" } } }] },
  });

  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  assert.equal(res.outcome, 'reused');
  assert.equal(res.redrove_record, true);
  assert.equal(res.record_result.outcome, 'recorded');
  assert.equal(res.status, 'recorded');
  // The stored digests reached the SAME record transaction: task done, marker cleared.
  const state = readState(fx.statePath);
  assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.active_run, null);
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).status, 'recorded');
});

test('no pending tasks in the wave → no dispatch (nothing to do)', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-none',
  });
  // Hand-write a marker (continue would route to finish on an all-done bundle).
  const st = readState(fx.statePath);
  writeState(fx.statePath, { ...st, active_run: { wave: 1, phase: 'launching', scope: ['src/a.txt'], baseline: [] } });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  assert.equal(res.outcome, 'no-pending-tasks');
  assert.equal(res.dispatched, false);
});

// ---------------------------------------------------------------------------
// 8. Key + record substrate
// ---------------------------------------------------------------------------

test('composeWaveDispatchKey: stable shape, colon-safe encoding, integer-wave guard', () => {
  assert.equal(
    composeWaveDispatchKey('my-run', 3),
    `${WAVE_DISPATCH_KEY_VERSION}:my-run:3:dispatch_fabric`,
  );
  assert.equal(
    composeWaveDispatchKey('a:b%c', 0),
    `${WAVE_DISPATCH_KEY_VERSION}:a%3Ab%25c:0:dispatch_fabric`,
  );
  assert.throws(() => composeWaveDispatchKey('', 1), TypeError);
  assert.throws(() => composeWaveDispatchKey('run', '1'), TypeError);
  assert.throws(() => composeWaveDispatchKey('run', 1.5), TypeError);
});

test('createWaveDispatchRecord: atomic create-or-return-existing (the O_EXCL gate)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-dwrec-'));
  const rec = { key: composeWaveDispatchKey('r', 2), run_id: 'r', wave: 2, op: 'dispatch_fabric', status: 'pending', attempt: 1 };
  const first = createWaveDispatchRecord(dir, rec);
  assert.equal(first.created, true);
  const second = createWaveDispatchRecord(dir, { ...rec, status: 'recorded' });
  assert.equal(second.created, false, 'second create loses');
  assert.equal(second.record.status, 'pending', "the winner's record is returned verbatim");
  assert.equal(waveDispatchRecordPath(dir, 2), path.join(dir, 'wave-2.dispatch.json'));
});

// ---------------------------------------------------------------------------
// Review findings 1+2: Guard-D ownership, atomic attempt claim, routing parity
// ---------------------------------------------------------------------------

test('ownership-denied: a live foreign owner → loud throw, nothing written, nothing re-launched', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-own',
  });
  // The INCUMBENT session drives continue (marker + worktree + fresh lock)…
  const incumbent = buildOwnerIdentity({ host: 'h1', session: 'sess-INCUMBENT', slug: 'dw-own', now: 1000 });
  const op = continueRun({ statePath: fx.statePath, self: incumbent, now: 2000 });
  assert.equal(op.op, 'dispatch_fabric');
  // …and a DIFFERENT session tries to dispatch while the incumbent is live.
  await assert.rejects(
    dispatchWaveViaFabric({
      statePath: fx.statePath, self: fx.self, now: 2100,
    }),
    /owned by another live session \(sess-INCUMBENT/,
  );
  // Nothing dispatched, no idempotency record created, task untouched.
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1), null);
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test("ownership-denied on the re-drive path too (a 'dispatched' record still needs the lock)", async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-own2',
  });
  const incumbent = buildOwnerIdentity({ host: 'h1', session: 'sess-INCUMBENT', slug: 'dw-own2', now: 1000 });
  continueRun({ statePath: fx.statePath, self: incumbent, now: 2000 });
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    key: composeWaveDispatchKey('dw-own2', 1), run_id: 'dw-own2', wave: 1, op: 'dispatch_fabric',
    contract_version: 'fabric-native-v1', status: 'dispatched', attempt: 1, dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
    result: { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1) }] },
  });
  await assert.rejects(
    dispatchWaveViaFabric({
      statePath: fx.statePath, self: fx.self, now: 2100,
    }),
    /owned by another live session/,
  );
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending', 're-drive did not run under a foreign lock');
});

test('concurrent retry (pre-claimed attempt marker): the second writer observes the first and returns without dispatching', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-race',
  });
  launchViaContinue(fx);
  // Attempt 1: launched, child reported blocked, record finalized with the task
  // still pending (blocked = needs orchestrator action, retryable).
  const res1 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  assert.equal(res1.outcome, 'native-spawn-plan');
  await recordNativeWave(fx, res1, { statuses: { 1: 'blocked' } });
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending', 'blocked keeps the task retryable');
  // A concurrent retry already claimed attempt 2 (its record rewrite may not have
  // landed yet) — this writer MUST lose the O_EXCL claim and not dispatch.
  assert.equal(claimAttemptMarker(fx.bundleDir, 1, 2, { key: res1.key }).claimed, true);
  const res2 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2100,
  });
  assert.equal(res2.outcome, 'reused');
  assert.equal(res2.dispatched, false);
  assert.match(res2.reason, /attempt-2 claim race/);
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).attempt, 1, 'the loser did not transition the record');
});

test('routing-input parity: a codex-suppressed host produces descriptors identical to the launch op payload, and the inputs are frozen in the record', async () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] },
    ],
    planIndex: [planEntry(1, 1, ['src/a.txt']), planEntry(2, 1, ['src/b.txt'])],
    slug: 'dw-par',
  });
  // Prepare via continue on a SUPPRESSED host — the exact inputs the marker promised.
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, codexSuppressed: true });
  assert.equal(op.op, 'dispatch_fabric', 'fabric flag wins even under codexSuppressed');
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000, codexSuppressed: true,
  });
  assert.equal(res.outcome, 'native-spawn-plan');
  // Spawn descriptors correspond 1:1 to the launch op's prepared payload.
  const spawns = res.plan.tasks.slice().sort((a, b) => a.task_id - b.task_id);
  const opTasks = op.tasks.slice().sort((a, b) => a.id - b.id);
  assert.deepEqual(
    spawns.map((d) => ({ id: d.task_id, class: d.class, files: d.files })),
    opTasks.map((t) => ({ id: t.id, class: t.class, files: t.files })),
    'spawn descriptors must match what the launch marker promised',
  );
  for (const d of spawns) {
    const t = opTasks.find((x) => x.id === d.task_id);
    assert.ok(d.prompt.includes(t.description), 'the task brief rides the prompt');
  }
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.deepEqual(rec.routing_inputs, { routing: 'auto', codex_host_suppressed: true, linked_worktree: true });
  assert.deepEqual(rec.payload.map((t) => t.id), [1, 2], 'the prepared lean payload is frozen in the record');
});

test('retry reuses the PERSISTED routing_inputs, not the current invocation flags', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-frozen',
  });
  launchViaContinue(fx);
  // Attempt 1 under a suppressed host; the child reports blocked, record finalized.
  const res1 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000, codexSuppressed: true,
  });
  await recordNativeWave(fx, res1, { statuses: { 1: 'blocked' } });
  // Retry WITHOUT the flag — the persisted attempt-1 inputs must win.
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2100, codexSuppressed: false,
  });
  assert.equal(res.outcome, 'native-spawn-plan');
  assert.equal(res.record.attempt, 2);
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal(rec.routing_inputs.codex_host_suppressed, true, 'attempt 2 re-prepared from the frozen attempt-1 inputs');
});

// ---------------------------------------------------------------------------
// Multi-repo locus (umbrella + sibling) — the amd64-first-class fabric fix
// ---------------------------------------------------------------------------

test('absolute MAIN scope and verify paths canonicalize to the run worktree', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/generated.txt'] }],
    planIndex: [planEntry(1, 1, ['src/generated.txt'])],
    slug: 'dw-absolute-main',
  });
  const absoluteMainFile = path.join(fx.MAIN, 'src/generated.txt');
  const state = readState(fx.statePath);
  state.tasks[0].files = [absoluteMainFile];
  writeState(fx.statePath, state);
  write(fx.bundleDir, 'plan.index.json', JSON.stringify({
    tasks: [{
      ...planEntry(1, 1, [absoluteMainFile]),
      verify_commands: [`test -f ${absoluteMainFile}`],
    }],
  }));

  const op = launchViaContinue(fx);
  const WT = op.cwd;
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  assert.equal(res.outcome, 'native-spawn-plan');
  // The spawn descriptor canonicalizes the absolute MAIN scope to the run worktree.
  const spawn = res.plan.tasks[0];
  assert.equal(spawn.cwd, WT);
  assert.deepEqual(spawn.files, ['src/generated.txt']);
  assert.ok(spawn.prompt.includes('test -f') && spawn.prompt.includes('generated.txt'),
    'the verify command rides the brief');
  // Simulate the child's work, then record.
  await recordNativeWave(fx, res, { edits: { 'src/generated.txt': 'generated\n' } });
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
  assert.equal(fs.readFileSync(path.join(WT, 'src/generated.txt'), 'utf8'), 'generated\n');
});

test('multi-repo: sibling-prefixed files land on sibling worktree with create_files + stripped paths', async () => {
  // Build an umbrella fixture, then plant a sibling git repo under MAIN.
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['docs/new-report.md'] },
      { id: 2, status: 'pending', wave: 1, files: ['yanos-os/kas/board.yaml'] },
    ],
    planIndex: [
      planEntry(1, 1, ['docs/new-report.md']),
      planEntry(2, 1, ['yanos-os/kas/board.yaml']),
    ],
    slug: 'dw-mrepo',
  });
  // Sibling under MAIN (gitignored-style; not part of umbrella tree).
  const SIB = path.join(fx.MAIN, 'yanos-os');
  fs.mkdirSync(SIB, { recursive: true });
  git(SIB, 'init', '--initial-branch=main');
  git(SIB, 'config', 'user.email', 't@t');
  git(SIB, 'config', 'user.name', 't');
  git(SIB, 'config', 'commit.gpgsign', 'false');
  write(SIB, 'kas/seed.yaml', 'seed\n');
  git(SIB, 'add', '.');
  git(SIB, 'commit', '-q', '-m', 'os seed');

  const op = launchViaContinue(fx);
  const WT = op.cwd;
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  assert.equal(res.outcome, 'native-spawn-plan');
  const spawns = res.plan.tasks.slice().sort((a, b) => a.task_id - b.task_id);
  assert.equal(spawns.length, 2);

  // Task 1: umbrella new file → WT + create_files
  assert.equal(spawns[0].task_id, 1);
  assert.equal(spawns[0].cwd, WT);
  assert.deepEqual(spawns[0].files, ['docs/new-report.md']);
  assert.equal(spawns[0].create_files, true);

  // Task 2: sibling path → sibling worktree + stripped files + create_files
  const sibWt = path.join(SIB, '.worktrees', 'dw-mrepo');
  assert.equal(spawns[1].task_id, 2);
  assert.equal(spawns[1].cwd, sibWt);
  assert.deepEqual(spawns[1].files, ['kas/board.yaml']);
  assert.equal(spawns[1].create_files, true);
  assert.equal(spawns[1].branch, 'masterplan/dw-mrepo');
  assert.ok(fs.existsSync(sibWt), 'sibling worktree auto-created');
});

// ---------------------------------------------------------------------------
// 9. Per-task adversary review (config-gated; run+task+sha re-entry guard)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-task adversary review — caller-owned behaviors via the native review seam
// ---------------------------------------------------------------------------

test('D6 independence: an approve verdict does NOT bypass verify-scope — the out-of-scope write is still reverted', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-d6',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const WT = op.cwd;
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  // The child edits in-scope AND out-of-scope; the review approves; the record
  // transaction must still revert the out-of-scope write.
  const { reviewed, recorded } = await recordNativeWave(fx, res, {
    edits: { 'src/a.txt': 'declared edit\n', 'src/oops.txt': 'undeclared write\n' },
    providedReviews: { 1: approveRecord },
  });
  assert.equal(reviewed.tasks[0].review.verdict, 'approve');
  assert.ok(recorded.reverted.includes('src/oops.txt'), 'out-of-scope write reverted despite the approve verdict');
  assert.equal(fs.existsSync(path.join(WT, 'src/oops.txt')), false, 'the undeclared file is gone from the worktree');
  assert.equal(readState(fx.statePath).tasks[0].status, 'done', 'the in-scope work still records');
});

test('review idempotency: a prior structured run+task+sha done event short-circuits the native review', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-reuse',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const WT = op.cwd;
  write(WT, 'src/a.txt', 'edit\n');
  const payloadSha = createHash('sha256').update(captureFullWorkingDiff(WT), 'utf8').digest('hex');
  const prior = buildTaskReviewEvent({
    run: 'dw-reuse', task: 1, sha: payloadSha, status: 'done', count: 1,
    digest: 'prior rework',
    review: {
      verdict: 'rework', findings: [],
      blocking_findings: [{ summary: 'needs polish' }],
      summary: 'prior rework',
      harness: healthyHarness(),
    },
  });
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), JSON.stringify(prior) + '\n');
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  // The provided review must NOT be consumed — the prior done event satisfies re-entry.
  const { reviewed } = await recordNativeWave(fx, res, { providedReviews: { 1: approveRecord } });
  assert.equal(reviewed.tasks[0].review.verdict, 'rework', 'the prior done event wins — the provided review is not consumed');
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review');
  assert.equal(evs.length, 1, 'no NEW review event — the prior one satisfied re-entry');
});

test('failed review writes a non-satisfying skipped event and blocks with verdict error', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-degr',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  // The owed review is never provided (orchestrator failed to run it) — fail closed.
  const { reviewed, recorded } = await recordNativeWave(fx, res, {
    edits: { 'src/a.txt': 'edit\n' }, providedReviews: {},
  });
  assert.equal(reviewed.tasks[0].review.verdict, 'error');
  assert.equal(recorded.blocking_reviews.length, 1);
  assert.equal(recorded.blocking_reviews[0].verdict, 'error');
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
  const evs = readEvents(fx.bundleDir);
  assert.equal(evs.filter((e) => e.type === 'task_adversary_review_skipped').length, 1);
  assert.equal(evs.filter((e) => e.type === 'task_adversary_review').length, 0);
});

test('re-entry key binds to the PAYLOAD: changed code at the SAME HEAD triggers a fresh review call', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-rearm',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const WT = op.cwd;
  write(WT, 'src/a.txt', 'version A\n');
  const staleSha = createHash('sha256').update(captureFullWorkingDiff(WT), 'utf8').digest('hex');
  const stale = buildTaskReviewEvent({
    run: 'dw-rearm', task: 1, sha: staleSha, status: 'done', count: 0,
    digest: 'stale approve of version A',
    review: {
      verdict: 'approve', findings: [], blocking_findings: [],
      summary: 'stale approve', harness: healthyHarness(),
    },
  });
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), JSON.stringify(stale) + '\n');
  write(WT, 'src/a.txt', 'version B\n');
  const headBefore = git(WT, 'rev-parse', 'HEAD');
  // The review payload sha — computed BEFORE the record transaction commits the code.
  const freshSha = createHash('sha256').update(captureFullWorkingDiff(WT), 'utf8').digest('hex');
  assert.notEqual(freshSha, staleSha, 'the changed diff produces a different key');
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  const { reviewed } = await recordNativeWave(fx, res, { providedReviews: { 1: approveRecord } });
  assert.equal(reviewed.tasks[0].review.verdict, 'approve', 'stale-payload approval must NOT suppress review of different code');
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review');
  assert.equal(evs.length, 2, 'a FRESH review event lands beside the stale one');
  assert.ok(evs.some((e) => e.data.sha === freshSha));
  assert.equal(evs.find((e) => e.data.sha === freshSha).data.base, headBefore);
});

test('skipped never satisfies re-entry END-TO-END: after a failed review, the next attempt over the SAME payload runs again', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-skipsat',
    extra: { review: { adversary: true } },
  });
  launchViaContinue(fx);
  const res1 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  const r1 = await recordNativeWave(fx, res1, {
    edits: { 'src/a.txt': 'edit\n' }, providedReviews: {},
  });
  assert.equal(r1.reviewed.tasks[0].review.verdict, 'error', 'the owed-but-absent review fails closed');
  const WT = res1.plan.tasks[0].cwd;
  const st = readState(fx.statePath);
  writeState(fx.statePath, {
    ...st,
    tasks: st.tasks.map((t) => ({ ...t, status: 'pending' })),
    active_run: { wave: 1, phase: 'launching', scope: ['src/a.txt'], baseline: [] },
  });
  // The attempt-1 record committed the in-scope edit; the retry carries a NEW edit
  // (a different payload sha) — the skipped event must NOT satisfy re-entry for it.
  write(WT, 'src/a.txt', 'retry edit\n');
  const res2 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2100,
  });
  const r2 = await recordNativeWave(fx, res2, { providedReviews: { 1: approveRecord } });
  assert.equal(r2.reviewed.tasks[0].review.verdict, 'approve', 'the skipped event did NOT satisfy re-entry');
  const evs = readEvents(fx.bundleDir);
  const skipped = evs.filter((e) => e.type === 'task_adversary_review_skipped');
  const done = evs.filter((e) => e.type === 'task_adversary_review');
  assert.equal(skipped.length, 1);
  assert.equal(done.length, 1, 'a fresh review ran despite the prior skipped event');
  assert.notEqual(done[0].data.sha, skipped[0].data.sha, 'the retry payload changed (attempt-1 committed its edit) — re-entry keys are payload-bound');
});

test('multi-task wave: one native review record per task with per-task verdicts and events', async () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] },
    ],
    planIndex: [planEntry(1, 1, ['src/a.txt']), planEntry(2, 1, ['src/b.txt'])],
    slug: 'dw-multi',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  const { reviewed, recorded } = await recordNativeWave(fx, res, {
    edits: { 'src/a.txt': 'edit a\n', 'src/b.txt': 'edit b\n' },
    providedReviews: { 1: approveRecord, 2: rejectRecord },
  });
  assert.equal(reviewed.tasks[0].review.verdict, 'approve');
  assert.equal(reviewed.tasks[1].review.verdict, 'reject');
  assert.deepEqual(recorded.blocking_reviews.map((b) => b.id), [2], 'only task 2 blocks');
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review');
  assert.deepEqual(evs.map((e) => String(e.data.task)).sort(), ['1', '2'], 'one review record PER TASK, never one per wave');
  assert.equal(evs[0].data.sha, evs[1].data.sha, 'same edit locus → same payload hash; the TASK component keys them apart');
});

test('digest-authoritative redrive: item.review cannot mask a blocking digest.review', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-cleanmask',
  });
  launchViaContinue(fx);
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    key: composeWaveDispatchKey('dw-cleanmask', 1), run_id: 'dw-cleanmask', wave: 1, op: 'dispatch_fabric',
    contract_version: 'fabric-native-v1', status: 'dispatched', attempt: 1, dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
    result: {
      wave: 1,
      tasks: [{
        task_id: 1,
        review: {
          verdict: 'approve', findings: [], blocking_findings: [],
          summary: 'echoed clean', harness: healthyHarness(),
        },
        digest: {
          ...workerDigest(1),
          review: {
            verdict: 'reject', findings: [],
            blocking_findings: [{ summary: 'digest-embedded blocker' }],
            summary: 'digest-embedded blocker', harness: healthyHarness(),
          },
        },
      }],
    },
  });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  assert.equal(res.outcome, 'reused');
  assert.equal(res.redrove_record, true);
  assert.deepEqual(res.record_result.blocking_reviews.map((b) => b.id), [1],
    'blocking from the digest surfaces — a clean item.review never masks it');
  assert.equal(res.record_result.blocking_reviews[0].verdict, 'reject');
});

test('blocking_reviews[].findings is array-shaped on redrive of a legacy blocking review', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-arr',
  });
  launchViaContinue(fx);
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    key: composeWaveDispatchKey('dw-arr', 1), run_id: 'dw-arr', wave: 1, op: 'dispatch_fabric',
    contract_version: 'fabric-native-v1', status: 'dispatched', attempt: 1, dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
    result: {
      wave: 1,
      tasks: [{
        task_id: 1,
        review: { verdict: 'blocking', findings: ['item-side finding'] },
        digest: { ...workerDigest(1) },
      }],
    },
  });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  assert.equal(res.redrove_record, true);
  assert.equal(res.record_result.blocking_reviews.length, 1);
  const { findings, verdict } = res.record_result.blocking_reviews[0];
  assert.ok(Array.isArray(findings), 'findings stays ARRAY-shaped');
  assert.equal(verdict, 'reject');
  assert.deepEqual(findings, ['item-side finding']);
});

test('captureFullWorkingDiff: untracked paths with spaces, unicode, and embedded quotes are captured (NUL-split)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-dwdiff-'));
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, 'seed.txt', 'seed\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'seed');
  // Space + unicode + an embedded double-quote: newline-split ls-files C-quotes
  // this path and the quoted literal ENOENTs in `diff --no-index`.
  write(dir, 'notes "é★" with space.txt', 'special-path content é★\n');
  const diff = captureFullWorkingDiff(dir);
  assert.match(diff, /special-path content é★/, 'untracked special-char file content captured in the FULL diff');
});

test('native spawn descriptors carry the wave worktree as cwd (e2e finding 2)', () => {
  // buildWorkItem names the run's existing worktree `repo`; the plan read only `cwd`, so
  // every native descriptor came out cwd:null and the worktree path had to be supplied out
  // of band at the Pi spawn boundary. A child spawned without it runs in the wrong locus.
  const plan = buildNativeSpawnPlan({
    tasks: [{ id: 1, class: 'masterplan-implementation', files: ['src/a.txt'] }],
    descriptors: [{ repo: '/tmp/wt/toy', files: ['src/a.txt'], verify_commands: [] }],
    token: 'tok',
    _resolve: () => ({ lane: 'agentic', model: 'litellm/grok-4.6', agent: 'builder', effort: 'high', capability: 'edit', writes: true, panel: null, resolved: true, reason: null }),
  });
  assert.equal(plan.tasks[0].cwd, '/tmp/wt/toy');
});

test('an explicit cwd still wins over repo', () => {
  const plan = buildNativeSpawnPlan({
    tasks: [{ id: 1, class: 'masterplan-implementation', files: [] }],
    descriptors: [{ cwd: '/explicit', repo: '/tmp/wt/toy' }],
    token: 'tok',
    _resolve: () => ({ lane: 'agentic', model: 'litellm/grok-4.6', agent: 'builder', effort: 'high', capability: 'edit', writes: true, panel: null, resolved: true, reason: null }),
  });
  assert.equal(plan.tasks[0].cwd, '/explicit');
});

test('cwd stays null when the descriptor names no locus at all', () => {
  const plan = buildNativeSpawnPlan({
    tasks: [{ id: 1, class: 'masterplan-implementation', files: [] }],
    descriptors: [{}],
    token: 'tok',
    _resolve: () => ({ lane: 'agentic', model: 'litellm/grok-4.6', agent: 'builder', effort: 'high', capability: 'edit', writes: true, panel: null, resolved: true, reason: null }),
  });
  assert.equal(plan.tasks[0].cwd, null, 'absence is reported, never invented');
});

// ---------------------------------------------------------------------------
// Prepare-stage unit tests (gateAndValidate / resolveWaveContext / buildDescriptors)
// ---------------------------------------------------------------------------

test('gateAndValidate: flag-off fails closed when fabric is not true (A3)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gate-'));
  const statePath = path.join(dir, 'state.yml');
  writeState(statePath, { schema_version: 9, slug: 's', dispatch: { fabric: false } });
  const result = gateAndValidate({ statePath });
  assert.equal(result.outcome, 'flag-off');
  assert.equal(result.dispatched, false);
  // A3: reason names fabric as the only path and the bundle as unexecutable.
  assert.match(result.reason, /ONLY wave path/);
  assert.match(result.reason, /unexecutable/);
  assert.doesNotMatch(result.reason, /legacy dispatch_fabric\/dispatch_fabric ops apply/);
});

test('gateAndValidate: returns validated context for a fabric-flagged bundle with a wave marker', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-gate-ok',
  });
  launchViaContinue(fx);
  const result = gateAndValidate({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(result.outcome, undefined);
  assert.equal(result.wave, 1);
  assert.equal(result.runId, 'dw-gate-ok');
  assert.equal(result.key, composeWaveDispatchKey('dw-gate-ok', 1));
  assert.equal(result.absState, path.resolve(fx.statePath));
  assert.equal(result.bundleDir, fx.bundleDir);
  assert.ok(result.state);
  assert.ok(result.run);
  assert.equal(result.run.wave, 1);
  // Fresh launch: no wave-dispatch record yet.
  assert.equal(result.existing, null);
});

test('gateAndValidate: reused/pending when an existing record has status pending and no takeover', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-gate-pending',
  });
  launchViaContinue(fx);
  const key = composeWaveDispatchKey('dw-gate-pending', 1);
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    key, run_id: 'dw-gate-pending', wave: 1, op: 'dispatch_fabric',
    contract_version: 'fabric-native-v1', status: 'pending', attempt: 1, dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
  });
  const result = gateAndValidate({ statePath: fx.statePath, self: fx.self, now: 2000, takeover: false });
  assert.equal(result.outcome, 'reused');
  assert.equal(result.status, 'pending');
  assert.equal(result.reused, true);
  assert.equal(result.dispatched, false);
  assert.equal(result.wave, 1);
  assert.equal(result.key, key);
  assert.equal(result.record.status, 'pending');
});

// ---------------------------------------------------------------------------
// Execute-stage unit tests (acquireAndWatch / buildNativePlan)
// ---------------------------------------------------------------------------

/** Drive prepare stages and return the args acquireAndWatch needs. */
function prepareAcquireArgs(fx, { reviewOn = false, now = 2000 } = {}) {
  const gate = gateAndValidate({ statePath: fx.statePath, self: fx.self, now });
  assert.equal(gate.outcome, undefined, `gate unexpected: ${JSON.stringify(gate)}`);
  const ctx = resolveWaveContext({
    absState: gate.absState,
    state: gate.state,
    run: gate.run,
    wave: gate.wave,
    runId: gate.runId,
    key: gate.key,
    existing: gate.existing,
    markerWave: gate.markerWave,
  });
  assert.equal(ctx.outcome, undefined, `ctx unexpected: ${JSON.stringify(ctx)}`);
  const { descriptors } = buildDescriptors({
    tasks: ctx.tasks,
    WT: ctx.WT,
    MAIN: ctx.MAIN,
    runId: gate.runId,
    inputs: ctx.inputs,
    reviewOn,
    verifyTimeoutS: 60,
    effectiveAllowlist: 'bash -c',
  });
  return {
    absState: gate.absState,
    bundleDir: gate.bundleDir,
    state: gate.state,
    run: gate.run,
    self: fx.self,
    now,
    wave: gate.wave,
    runId: gate.runId,
    key: gate.key,
    existing: gate.existing,
    tasks: ctx.tasks,
    descriptors,
    WT: ctx.WT,
    MAIN: ctx.MAIN,
    inputs: ctx.inputs,
    routingInputs: ctx.routingInputs,
    reviewOn,
    effectiveAllowlist: 'bash -c',
  };
}

test('acquireAndWatch: precheck-failed when a task-scoped file is already dirty', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-acq-dirty',
  });
  launchViaContinue(fx);
  // Precheck only refuses dirt that was already present at the run's frozen
  // baseline (user WIP). Dirt absent from baseline is treated as prior-attempt
  // residue and is allowed (recover_wave). Force the path into baseline so the
  // dirty worktree file is classified as user work.
  const st = readState(fx.statePath);
  write(st.worktree, 'src/a.txt', 'USER WIP — must block launch\n');
  const args = prepareAcquireArgs(fx);
  args.run = { ...args.run, baseline: ['src/a.txt'] };
  const result = acquireAndWatch(args);
  assert.equal(result.outcome, 'precheck-failed');
  assert.equal(result.dispatched, false);
  assert.equal(result.wave, 1);
  assert.ok(Array.isArray(result.violations) && result.violations.length > 0);
  assert.match(result.reason, /watch-list precheck failed/);
  // No pending wave-dispatch record should have been written on the failed path.
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1), null);
});

test('acquireAndWatch: returns attempt and waveToken when precheck passes', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-acq-ok',
  });
  launchViaContinue(fx);
  const args = prepareAcquireArgs(fx, { reviewOn: true });
  const result = acquireAndWatch(args);
  assert.equal(result.outcome, undefined);
  assert.equal(result.attempt, 1);
  assert.ok(typeof result.waveToken === 'string' && result.waveToken.length > 0);
  assert.ok(result.record);
  assert.equal(result.record.status, 'pending');
  assert.equal(result.record.wave_token, result.waveToken);
  assert.equal(result.record.attempt, 1);
  assert.ok(result.watchBaseline);
  assert.equal(result.record.review_context?.enabled, true);
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1)?.status, 'pending');
});

// ---------------------------------------------------------------------------
// buildWaveLaunchContext — shared PREPARE/EXECUTE launch-context seam
// ---------------------------------------------------------------------------

test('buildWaveLaunchContext: throws on missing plan.index.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wctx-'));
  assert.throws(
    () => buildWaveLaunchContext({
      state: { slug: 's' },
      planIndexPath: path.join(dir, 'nope.json'),
      wave: 1,
      routingInputs: { routing: 'auto', codex_host_suppressed: false, linked_worktree: true },
    }),
    /plan\.index\.json not found/,
  );
});

test('buildWaveLaunchContext: returns prepared tasks + MAIN from injected routing inputs', () => {
  // Real git repo so MAIN resolves via git-common-dir on the bundleDir.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wctx-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/a.txt', 'seed\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', 'wctx');
  fs.mkdirSync(bundleDir, { recursive: true });
  const planIndexPath = path.join(bundleDir, 'plan.index.json');
  fs.writeFileSync(planIndexPath, JSON.stringify({
    tasks: [{
      id: 1,
      description: 'Wire the route',
      files: ['src/a.txt'],
      verify_commands: [],
      codex: 'ok',
    }],
  }));
  // state.codex.routing is deliberately NOT what we inject — proves routingInputs win.
  const state = {
    slug: 'wctx',
    worktree: path.join(MAIN, '.worktrees', 'wctx'),
    tasks: [{ id: 1, wave: 1, status: 'pending', files: ['src/a.txt'] }],
    codex: { routing: 'force-inline' },
    implementer: {},
  };
  const result = buildWaveLaunchContext({
    state,
    planIndexPath,
    wave: 1,
    routingInputs: { routing: 'auto', codex_host_suppressed: true, linked_worktree: true },
  });
  assert.ok(result.prepared);
  assert.ok(result.planIndex);
  assert.equal(result.MAIN, MAIN);
  assert.equal(result.prepared.tasks.length, 1);
  assert.equal(result.prepared.tasks[0].id, 1);
  // Governed-path payload (C6): the legacy routeTask codex/inline brain is deleted —
  // routing is deferred to the governed class resolver, so the payload carries only the
  // class (the worker default for an unpinned task), with no pre-baked target/reason.
  assert.equal(result.prepared.tasks[0].class, 'bounded-edit');
  assert.equal(result.prepared.tasks[0].target, undefined);
  assert.equal(result.prepared.tasks[0].reason, undefined);
});

test('buildWaveLaunchContext: reposAllowlist is optional (omitted on fabric path)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wctx-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/a.txt', 'seed\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', 'wctx-fab');
  fs.mkdirSync(bundleDir, { recursive: true });
  const planIndexPath = path.join(bundleDir, 'plan.index.json');
  fs.writeFileSync(planIndexPath, JSON.stringify({
    tasks: [{
      id: 1,
      description: 'Fabric task',
      files: ['src/a.txt'],
      verify_commands: [],
    }],
  }));
  const state = {
    slug: 'wctx-fab',
    worktree: path.join(MAIN, '.worktrees', 'wctx-fab'),
    tasks: [{ id: 1, wave: 1, status: 'pending', files: ['src/a.txt'] }],
    dispatch: { fabric: true },
    implementer: {},
  };
  // No reposAllowlist — fabric path defers routing to the routing policy.
  const result = buildWaveLaunchContext({
    state,
    planIndexPath,
    wave: 1,
    routingInputs: { routing: 'auto', codex_host_suppressed: false, linked_worktree: true },
  });
  assert.equal(result.prepared.tasks.length, 1);
  assert.equal(result.prepared.tasks[0].class, 'bounded-edit'); // worker default (A2 repoint)
  assert.equal(result.prepared.tasks[0].target, undefined);
  assert.equal(result.MAIN, MAIN);
});
