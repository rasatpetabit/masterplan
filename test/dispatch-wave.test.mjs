// test/dispatch-wave.test.mjs — the dispatch_fabric op consumer (lib/dispatch-wave.mjs).
//
// REAL git in temp repos (the continue.test.mjs pattern): the module's value is the exact
// interleaving of the idempotency record, the broker fanout seam, coord pairing, and the
// record-result transaction, so the tests drive genuine MAIN+worktree bundles through
// `mp continue` (which writes the phase-1 marker dispatch-wave consumes) and inject only
// the broker client / coord seams. Covered behaviors (the chunk-B review mandates):
//
//   1. Flag-off → no-op: state.dispatch.fabric unset → outcome 'flag-off', broker untouched.
//   2. Full flow: one descriptor per routed task (adapter buildWorkItem shape), ONE
//      dispatch_fanout call, worker digests recorded via recordWaveResult (task done,
//      marker cleared, wave_recorded event, dispatch.outcome:'worker' — no degradation events).
//   3. Idempotent re-invoke: an existing 'pending' record (accepted-but-unobserved) is
//      returned as-is — the broker is NOT called again (injected-client assert).
//   4. --takeover supersedes a stuck pending attempt (attempt N+1, history archived).
//   5. A 'dispatched' record re-drives record-result from the stored digests — broker untouched.
//   6. Coord open/close are PAIRED — including when the dispatch fails (the leaked-open-jobs fix).
//   7. Broker failure → blocked/broker_error digests → dispatch_degraded events, tasks stay
//      pending, record 'recorded'; a follow-up invoke starts attempt 2 (observed retry).
//   8. Key/record substrate unit behavior (encoding, atomic create-or-return-existing).
//   9. Per-task adversary review (config-gated on state.review.adversary): FULL working
//      diff in the payload (never scope-filtered), verdict in digest.review /
//      item.review → blocking_reviews[], run+task+sha re-entry idempotency, degraded
//      lane → skipped event + inconclusive, review-off → no lane calls and no writes,
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
  composeWaveDispatchKey,
  waveDispatchRecordPath,
  readWaveDispatchRecord,
  createWaveDispatchRecord,
  writeWaveDispatchRecord,
  claimAttemptMarker,
  WAVE_DISPATCH_KEY_VERSION,
  captureFullWorkingDiff,
  segmentDiffPayload,
  mergeReviewVerdicts,
  mapAdversaryLaneVerdict,
} from '../lib/dispatch-wave.mjs';
import { continueRun } from '../lib/continue.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { buildTaskReviewEvent } from '../lib/reentry-guard.mjs';

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

/** A worker digest the broker's stdout carries back. */
const workerDigest = (id, status = 'done', files = []) => ({
  task_id: id, status, start_sha: 'abc123', files_changed: files,
  verify: [], summary: `task ${id} ${status}`, blockers: null,
});

/** Injected broker client: records calls; per-descriptor result via resultFor. */
function brokerStub(resultFor) {
  const calls = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      return { results: args.descriptors.map((d) => resultFor(d)) };
    },
  };
}

/** A route+digest result for one descriptor (the broker's dispatch_task shape). */
const routeResult = (d) => ({
  decision: { decision: 'route', backend: 'pi' },
  stdout: JSON.stringify(workerDigest(d.task_id)),
});

/** Injected coord seam: enabled handle with attach + close spies. */
function coordStub() {
  const state = { opens: 0, closes: 0, attached: [] };
  const open = ({ wave, tasks }) => {
    state.opens += 1;
    return {
      enabled: true,
      jobId: `stub-job-${wave}`,
      root: '/tmp/coord-root',
      lead: 'mp-lead',
      workerIds: tasks.map((_, i) => `mp-${wave}-${i}`),
      attachToTask(task, idx) {
        state.attached.push(idx);
        return { ...task, coord: { root: '/tmp/coord-root', jobId: `stub-job-${wave}`, agentId: `mp-${wave}-${idx}`, lead: 'mp-lead' } };
      },
      close() { state.closes += 1; return { ok: true }; },
    };
  };
  return { state, open };
}

const disabledCoord = () => ({
  enabled: false, jobId: 'x', root: '/tmp', workerIds: [],
  attachToTask: (t) => t, close: () => ({ skipped: true }),
});

const neverBroker = () => ({
  async callTool() { assert.fail('broker must NOT be called on this path'); },
});

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

test('flag-off → no-op: no dispatch, no record, broker untouched', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    fabric: false,
    slug: 'dw-off',
  });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: neverBroker(), _openCoord: () => assert.fail('coord must not open on flag-off'),
  });
  assert.equal(res.outcome, 'flag-off');
  assert.equal(res.dispatched, false);
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1), null, 'no record written');
});

// ---------------------------------------------------------------------------
// 2. Full flow — descriptors, one fanout, record transaction, provenance
// ---------------------------------------------------------------------------

test('full flow: one descriptor per routed task, ONE dispatch_fanout, digests recorded with worker provenance', async () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] },
    ],
    planIndex: [planEntry(1, 1, ['src/a.txt']), planEntry(2, 1, ['src/b.txt'])],
    slug: 'dw-full',
  });
  const op = launchViaContinue(fx);
  const WT = op.cwd;
  const stub = brokerStub(routeResult);

  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });

  // ONE fanout call carrying ALL descriptors (never N per-task spawns).
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].name, 'dispatch_fanout');
  const { descriptors, fail_mode } = stub.calls[0].args;
  assert.equal(fail_mode, 'isolated');
  assert.equal(descriptors.length, 2);
  for (const [i, d] of descriptors.entries()) {
    assert.equal(d.task_id, i + 1);
    assert.equal(d.class, 'bounded-edit', 'default fabric class');
    assert.equal(d.repo, WT, "the run's EXISTING worktree — never a second one");
    assert.equal(d.contract_version, 'adsp-v1.1');
    assert.equal(d.brief, `task ${i + 1}`);
    assert.match(d.handoff_key, /^adsp-idem-v1:dw-full:/, 'per-task handoff key composed from run/task/spec/fingerprint');
  }

  // The record transaction ran (the SAME recordWaveResult flow).
  assert.equal(res.outcome, 'dispatched');
  assert.equal(res.dispatched, true);
  assert.equal(res.attempt, 1);
  assert.equal(res.key, composeWaveDispatchKey('dw-full', 1));
  assert.deepEqual(res.tasks, [
    { task_id: 1, status: 'done', dispatch: 'worker' },
    { task_id: 2, status: 'done', dispatch: 'worker' },
  ]);
  assert.equal(res.record.outcome, 'recorded');
  assert.deepEqual(res.record.recorded, [1, 2]);

  // Durable effects: tasks done, marker cleared, wave_recorded event, NO degradation events.
  const state = readState(fx.statePath);
  assert.ok(state.tasks.every((t) => t.status === 'done'));
  assert.equal(state.active_run, null);
  const events = readEvents(fx.bundleDir);
  assert.ok(events.some((e) => e.type === 'wave_recorded'));
  assert.ok(!events.some((e) => e.type === 'dispatch_degraded'), 'worker outcomes emit no degradation events');

  // The wave-dispatch record finalized.
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal(rec.status, 'recorded');
  assert.equal(rec.op, 'dispatch_fabric');
  assert.equal(rec.attempt, 1);
  assert.deepEqual(rec.tasks.map((t) => t.task_id), [1, 2]);
  assert.deepEqual(rec.record_outcome.recorded, [1, 2]);
});

// ---------------------------------------------------------------------------
// 3. Idempotency — the accepted-but-unobserved window
// ---------------------------------------------------------------------------

test('idempotent re-invoke: an existing pending record is returned — the broker is NOT called again', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-idem',
  });
  launchViaContinue(fx);
  // Simulate a prior invocation that persisted the record and died after the
  // broker may have accepted (the crash window the key exists for).
  const key = composeWaveDispatchKey('dw-idem', 1);
  const { created } = createWaveDispatchRecord(fx.bundleDir, {
    key, run_id: 'dw-idem', wave: 1, op: 'dispatch_fabric',
    contract_version: 'adsp-v1.1', status: 'pending', attempt: 1,
    dispatched_at: 'T0', tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
  });
  assert.equal(created, true);

  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: neverBroker(), _openCoord: () => assert.fail('coord must not open on reuse'),
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
    contract_version: 'adsp-v1.1', status: 'pending', attempt: 1,
    dispatched_at: 'T0', tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
  });

  const stub = brokerStub(routeResult);
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000, takeover: true,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  assert.equal(res.outcome, 'dispatched');
  assert.equal(res.attempt, 2);
  assert.equal(stub.calls.length, 1);
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal(rec.status, 'recorded');
  assert.equal(rec.attempt, 2);
  assert.equal(rec.history.length, 1);
  assert.equal(rec.history[0].status, 'superseded');
});

test("a 'dispatched' record re-drives record-result from the stored digests — broker untouched", async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-redrive',
  });
  launchViaContinue(fx);
  // A prior attempt got digests durable but died before the record transaction.
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    key: composeWaveDispatchKey('dw-redrive', 1), run_id: 'dw-redrive', wave: 1, op: 'dispatch_fabric',
    contract_version: 'adsp-v1.1', status: 'dispatched', attempt: 1, dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
    result: { wave: 1, tasks: [{ task_id: 1, digest: { ...workerDigest(1), dispatch: { outcome: 'worker', reason: "routed to backend 'pi'" } } }] },
  });

  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: neverBroker(), _openCoord: () => assert.fail('coord must not open on re-drive'),
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

// ---------------------------------------------------------------------------
// 6/7. Coord pairing + broker failure → degradation-visible record
// ---------------------------------------------------------------------------

test('coord open/close are paired on success, and descriptors carry the attached coord context', async () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] },
    ],
    planIndex: [planEntry(1, 1, ['src/a.txt']), planEntry(2, 1, ['src/b.txt'])],
    slug: 'dw-coord',
  });
  launchViaContinue(fx);
  const coord = coordStub();
  const stub = brokerStub(routeResult);
  await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: coord.open,
  });
  assert.equal(coord.state.opens, 1);
  assert.equal(coord.state.closes, 1, 'coord job closed exactly once (in the finally)');
  const { descriptors } = stub.calls[0].args;
  assert.deepEqual(descriptors.map((d) => d.coord?.agentId), ['mp-1-0', 'mp-1-1']);
});

test('broker failure: blocked/broker_error digests recorded, dispatch_degraded events emitted, coord STILL closed', async () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] },
    ],
    planIndex: [planEntry(1, 1, ['src/a.txt']), planEntry(2, 1, ['src/b.txt'])],
    slug: 'dw-fail',
  });
  launchViaContinue(fx);
  const coord = coordStub();
  const failing = {
    async callTool() { throw new Error('connection refused'); },
  };
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: failing, _openCoord: coord.open,
  });

  // The leaked-open-jobs fix: close fires even though the dispatch failed.
  assert.equal(coord.state.opens, 1);
  assert.equal(coord.state.closes, 1);

  // Every task blocked with broker_error provenance; the outage is RECORDED, not lost.
  assert.equal(res.outcome, 'dispatched');
  assert.deepEqual(res.tasks, [
    { task_id: 1, status: 'blocked', dispatch: 'broker_error' },
    { task_id: 2, status: 'blocked', dispatch: 'broker_error' },
  ]);
  assert.equal(res.record.outcome, 'recorded');
  assert.equal(res.record.failed.length, 2);

  const state = readState(fx.statePath);
  assert.ok(state.tasks.every((t) => t.status === 'pending'), 'blocked digests leave tasks pending for recovery');
  assert.ok(state.active_run, 'marker survives a failed wave (recover_and_redispatch owns it)');
  const degraded = readEvents(fx.bundleDir).filter((e) => e.type === 'dispatch_degraded');
  assert.equal(degraded.length, 2);
  assert.ok(degraded.every((e) => e.outcome === 'broker_error'));
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).status, 'recorded');

  // 7b. The failure was OBSERVED (recorded) — a follow-up invoke is a legitimate
  // retry and starts attempt 2 (never blocked by the idempotency record).
  const stub = brokerStub(routeResult);
  const res2 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  assert.equal(res2.outcome, 'dispatched');
  assert.equal(res2.attempt, 2);
  assert.equal(stub.calls.length, 1);
  assert.ok(readState(fx.statePath).tasks.every((t) => t.status === 'done'));
});

test('fanout without a results array (e.g. disabled by policy) maps every task through the escalate branch', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-esc',
  });
  launchViaContinue(fx);
  const client = { async callTool() { return { error: 'fanout disabled by policy' }; } };
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: client, _openCoord: disabledCoord,
  });
  assert.deepEqual(res.tasks, [{ task_id: 1, status: 'blocked', dispatch: 'escalate' }]);
  const degraded = readEvents(fx.bundleDir).filter((e) => e.type === 'dispatch_degraded');
  assert.equal(degraded.length, 1);
  assert.match(degraded[0].reason, /fanout disabled by policy/);
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
    _brokerClient: neverBroker(), _openCoord: () => assert.fail('no coord for an empty wave'),
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

test('ownership-denied: a live foreign owner → loud throw, nothing written, broker untouched', async () => {
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
      _brokerClient: neverBroker(), _openCoord: () => assert.fail('coord must not open when ownership is denied'),
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
    contract_version: 'adsp-v1.1', status: 'dispatched', attempt: 1, dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
    result: { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1) }] },
  });
  await assert.rejects(
    dispatchWaveViaFabric({
      statePath: fx.statePath, self: fx.self, now: 2100, _brokerClient: neverBroker(),
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
  // Attempt 1: broker outage, recorded with failures (tasks stay pending).
  const failing = { async callTool() { throw new Error('down'); } };
  const res1 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: failing, _openCoord: disabledCoord,
  });
  assert.equal(res1.record.failed.length, 1);
  // A concurrent retry already claimed attempt 2 (its record rewrite may not have
  // landed yet) — this writer MUST lose the O_EXCL claim and not dispatch.
  assert.equal(claimAttemptMarker(fx.bundleDir, 1, 2, { key: res1.key }).claimed, true);
  const res2 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2100,
    _brokerClient: neverBroker(), _openCoord: disabledCoord,
  });
  assert.equal(res2.outcome, 'reused');
  assert.equal(res2.dispatched, false);
  assert.match(res2.reason, /attempt-2 claim race/);
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).attempt, 1, 'the loser did not transition the record');
});

test('concurrent retry (live interleave): while attempt 2 is in flight, a second invocation reuses the pending record', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-race2',
  });
  launchViaContinue(fx);
  const failing = { async callTool() { throw new Error('down'); } };
  await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: failing, _openCoord: disabledCoord,
  });

  // Racer A: attempt 2 with a broker gated on a promise we control.
  let release;
  const gate = new Promise((r) => { release = r; });
  const gated = {
    calls: [],
    async callTool(name, args) {
      this.calls.push({ name, args });
      await gate;
      return { results: args.descriptors.map((d) => routeResult(d)) };
    },
  };
  const p1 = dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2100,
    _brokerClient: gated, _openCoord: disabledCoord,
  });
  // Wait until A has claimed attempt 2, written 'pending', and reached the broker.
  for (let i = 0; i < 1000 && gated.calls.length === 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(gated.calls.length, 1, 'racer A reached the broker');

  // Racer B: must observe A's in-flight attempt and return WITHOUT dispatching.
  const res2 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2200,
    _brokerClient: neverBroker(), _openCoord: disabledCoord,
  });
  assert.equal(res2.outcome, 'reused');
  assert.equal(res2.status, 'pending');

  // Release A — it completes normally.
  release();
  const res1 = await p1;
  assert.equal(res1.outcome, 'dispatched');
  assert.equal(res1.attempt, 2);
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
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
  const stub = brokerStub(routeResult);
  await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000, codexSuppressed: true,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  // Descriptors correspond 1:1 to the launch op's prepared payload.
  const { descriptors } = stub.calls[0].args;
  assert.deepEqual(
    descriptors.map((d) => ({ id: d.task_id, class: d.class, brief: d.brief, files: d.files, verify: d.verify })),
    op.tasks.map((t) => ({ id: t.id, class: t.class, brief: t.description, files: t.files, verify: t.verify_commands })),
    'descriptors must match what the launch marker promised',
  );
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
  // Attempt 1 under a suppressed host, broker down → recorded with failures.
  const failing = { async callTool() { throw new Error('down'); } };
  await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000, codexSuppressed: true,
    _brokerClient: failing, _openCoord: disabledCoord,
  });
  // Retry WITHOUT the flag — the persisted attempt-1 inputs must win.
  const stub = brokerStub(routeResult);
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2100, codexSuppressed: false,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  assert.equal(res.attempt, 2);
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal(rec.routing_inputs.codex_host_suppressed, true, 'attempt 2 re-prepared from the frozen attempt-1 inputs');
});

// ---------------------------------------------------------------------------
// Multi-repo locus (umbrella + sibling) — the amd64-first-class fabric fix
// ---------------------------------------------------------------------------

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
  const stub = brokerStub(routeResult);
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  assert.equal(res.outcome, 'dispatched');
  assert.equal(stub.calls.length, 1);
  const { descriptors } = stub.calls[0].args;
  assert.equal(descriptors.length, 2);

  // Task 1: umbrella new file → WT + create_files
  assert.equal(descriptors[0].task_id, 1);
  assert.equal(descriptors[0].repo, WT);
  assert.deepEqual(descriptors[0].files, ['docs/new-report.md']);
  assert.equal(descriptors[0].create_files, true);

  // Task 2: sibling path → sibling worktree + stripped files + create_files
  const sibWt = path.join(SIB, '.worktrees', 'dw-mrepo');
  assert.equal(descriptors[1].task_id, 2);
  assert.equal(descriptors[1].repo, sibWt);
  assert.deepEqual(descriptors[1].files, ['kas/board.yaml']);
  assert.equal(descriptors[1].create_files, true);
  assert.equal(descriptors[1].branch, 'masterplan/dw-mrepo');
  assert.ok(fs.existsSync(sibWt), 'sibling worktree auto-created');
});

// ---------------------------------------------------------------------------
// 9. Per-task adversary review (config-gated; run+task+sha re-entry guard)
// ---------------------------------------------------------------------------

/** Injected review lane: records payloads; returns a canned lane record. */
function reviewLaneStub(result) {
  const calls = [];
  return {
    calls,
    async lane(args) {
      calls.push(args);
      return typeof result === 'function' ? result(args) : result;
    },
  };
}

const approveLane = { final_verdict: 'approve', findings: [], blocking_findings: [], summary: 'looks fine' };

test('review ON: FULL working diff (incl. an undeclared file) is the payload, verdict lands in the digest, and the run+task+sha event is written', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-rev',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const WT = op.cwd;
  // Simulate the worker's edits landing in the worktree: the declared file AND
  // an out-of-scope write the review payload must still cover (V1 negative (a)).
  write(WT, 'src/a.txt', 'declared edit\n');
  write(WT, 'src/oops.txt', 'undeclared write\n');
  // The launch-time HEAD rides in the event's data.base (audit) — capture it
  // BEFORE dispatch (recordWaveResult commits, advancing HEAD afterwards).
  const head = git(WT, 'rev-parse', 'HEAD');
  const rl = reviewLaneStub(approveLane);
  const stub = brokerStub(routeResult);

  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord, _reviewLane: rl.lane,
  });
  assert.equal(res.outcome, 'dispatched');

  // (a) The payload is the FULL working diff — the undeclared file is IN it.
  assert.equal(rl.calls.length, 1);
  assert.match(rl.calls[0].diff, /src\/a\.txt/);
  assert.match(rl.calls[0].diff, /src\/oops\.txt/, 'FULL diff: undeclared file present in the review payload');
  assert.match(rl.calls[0].diff, /undeclared write/);

  // Verdict written into the task digest AND the result item; clean → no blockers.
  assert.deepEqual(res.tasks, [{ task_id: 1, status: 'done', dispatch: 'worker', review: 'clean' }]);
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal(rec.result.tasks[0].digest.review.verdict, 'clean');
  assert.equal(rec.result.tasks[0].review.verdict, 'clean');
  assert.deepEqual(res.record.blocking_reviews, []);

  // The re-entry guard write uses the checked-in run+task+sha vocabulary.
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data.run, 'dw-rev');
  assert.equal(String(evs[0].data.task), '1');
  const payloadSha = createHash('sha256').update(rl.calls[0].diff, 'utf8').digest('hex');
  assert.equal(evs[0].data.sha, payloadSha, 'keyed to the sha256 of the reviewed payload, not the branch HEAD');
  assert.equal(evs[0].data.base, head, 'launch HEAD recorded as data.base for audit');
  assert.match(evs[0].note, /verdict: clean/);
});

test('D6 independence: an approve verdict does NOT bypass verify-scope — the out-of-scope write is still reverted', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-d6',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const WT = op.cwd;
  write(WT, 'src/a.txt', 'declared edit\n');
  write(WT, 'src/oops.txt', 'undeclared write\n');
  const rl = reviewLaneStub(approveLane);
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord, _reviewLane: rl.lane,
  });
  // Review approved (clean) — scope enforcement fires anyway (V1 negative (c)).
  assert.equal(res.tasks[0].review, 'clean');
  assert.ok(res.record.reverted.includes('src/oops.txt'), 'out-of-scope write reverted despite the approve verdict');
  assert.equal(fs.existsSync(path.join(WT, 'src/oops.txt')), false, 'the undeclared file is gone from the worktree');
  assert.equal(readState(fx.statePath).tasks[0].status, 'done', 'the in-scope work still records');
});

test('review OFF (state.review.adversary=false): lane never called, no review fields, no re-entry guard writes', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-revoff',
    extra: { review: { adversary: false } },
  });
  const op = launchViaContinue(fx);
  write(op.cwd, 'src/a.txt', 'edit\n');
  const stub = brokerStub(routeResult);
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
    _reviewLane: async () => assert.fail('review lane must NOT be called when review is off'),
  });
  // (b) No review fields anywhere, no re-entry guard writes.
  assert.equal(res.outcome, 'dispatched');
  assert.equal('review' in res.tasks[0], false);
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal('review' in rec.result.tasks[0], false);
  assert.equal('review' in rec.result.tasks[0].digest, false);
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review' || e.type === 'task_adversary_review_skipped');
  assert.equal(evs.length, 0, 'no re-entry guard writes on the disable path');
  assert.deepEqual(res.record.blocking_reviews, []);
  // The work-item descriptor advertises NO review requirement on the wire.
  assert.equal('review' in stub.calls[0].args.descriptors[0], false, 'disabled review is omitted from the descriptor');
});

test('blocking verdict: surfaces via blocking_reviews[] in the wave-completion protocol (task still records per its digest)', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-block',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  write(op.cwd, 'src/a.txt', 'edit\n');
  const rl = reviewLaneStub({
    final_verdict: 'reject',
    findings: [{ severity: 'high', note: 'introduces a data race' }],
    blocking_findings: [{ severity: 'high', note: 'introduces a data race' }],
    summary: 'blocking data race',
  });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord, _reviewLane: rl.lane,
  });
  assert.equal(res.tasks[0].review, 'blocking');
  assert.equal(res.record.blocking_reviews.length, 1);
  assert.equal(res.record.blocking_reviews[0].id, 1);
  // The ACTUAL canonical finding content survives into the digest/record —
  // never just counts (round-3 P2).
  assert.match(String(res.record.blocking_reviews[0].findings), /BLOCKING: \[high\] introduces a data race/, 'the finding item itself is serialized');
  assert.match(String(readWaveDispatchRecord(fx.bundleDir, 1).result.tasks[0].digest.review.findings), /introduces a data race/, 'finding text reaches digest.review.findings');
  // The verdict is advisory metadata: the done digest still records (the
  // orchestrator acts on blocking_reviews[], the transaction does not).
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
});

test('review idempotency: a prior run+task+sha done event short-circuits the lane and rehydrates the stored verdict', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-reuse',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const WT = op.cwd;
  write(WT, 'src/a.txt', 'edit\n');
  // Pre-seed the durable event with the module's OWN builder (round-trip
  // guarantee): same run, task, and the exact PAYLOAD HASH the dispatcher
  // will key on (sha256 of the full working diff).
  const payloadSha = createHash('sha256').update(captureFullWorkingDiff(WT), 'utf8').digest('hex');
  const prior = buildTaskReviewEvent({
    run: 'dw-reuse', task: 1, sha: payloadSha, status: 'done', count: 2,
    digest: 'prior findings digest. verdict: advisory',
  });
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), JSON.stringify(prior) + '\n');

  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord,
    _reviewLane: async () => assert.fail('lane must NOT be called — the re-entry guard satisfies the review'),
  });
  assert.equal(res.tasks[0].review, 'advisory', 'verdict rehydrated from the stored findings digest');
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review');
  assert.equal(evs.length, 1, 'no NEW review event — the prior one satisfied re-entry');
});

test('degraded lane: throws → skipped event (never satisfies re-entry), verdict inconclusive, wave not blocked', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-degr',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  write(op.cwd, 'src/a.txt', 'edit\n');
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord,
    _reviewLane: async () => { throw new Error('lane wedged'); },
  });
  assert.equal(res.tasks[0].review, 'inconclusive');
  assert.deepEqual(res.record.blocking_reviews, [], 'a wedged reviewer never blocks the wave');
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
  const evs = readEvents(fx.bundleDir);
  assert.equal(evs.filter((e) => e.type === 'task_adversary_review_skipped').length, 1);
  assert.equal(evs.filter((e) => e.type === 'task_adversary_review').length, 0);
});

test('re-entry key binds to the PAYLOAD: changed code at the SAME HEAD triggers a fresh lane call (stale approve never carries over)', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-rearm',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const WT = op.cwd;
  // Version A of the uncommitted work gets an approve on record…
  write(WT, 'src/a.txt', 'version A\n');
  const staleSha = createHash('sha256').update(captureFullWorkingDiff(WT), 'utf8').digest('hex');
  const stale = buildTaskReviewEvent({
    run: 'dw-rearm', task: 1, sha: staleSha, status: 'done', count: 0,
    digest: 'stale approve of version A. verdict: clean',
  });
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), JSON.stringify(stale) + '\n');
  // …then the code CHANGES while HEAD stays identical.
  write(WT, 'src/a.txt', 'version B\n');
  const headBefore = git(WT, 'rev-parse', 'HEAD');
  const rl = reviewLaneStub(approveLane);
  await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord, _reviewLane: rl.lane,
  });
  assert.equal(rl.calls.length, 1, 'stale-payload approval must NOT suppress review of different code');
  const freshSha = createHash('sha256').update(rl.calls[0].diff, 'utf8').digest('hex');
  assert.notEqual(freshSha, staleSha, 'the changed diff produces a different key');
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review');
  assert.equal(evs.length, 2, 'a FRESH review event lands beside the stale one');
  assert.ok(evs.some((e) => e.data.sha === freshSha));
  assert.equal(evs.find((e) => e.data.sha === freshSha).data.base, headBefore, 'same HEAD both times — only the payload changed');
});

test('skipped never satisfies re-entry END-TO-END: after a degraded skipped event, the next attempt over the SAME payload runs the lane again', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-skipsat',
    extra: { review: { adversary: true } },
  });
  launchViaContinue(fx);
  // NO worktree edits: the payload (empty diff) — and therefore the key
  // {run, task, sha} — is byte-identical across both attempts; only the skip
  // semantics can make the second lane call happen.
  const rl1 = reviewLaneStub(() => { throw new Error('lane wedged'); });
  const res1 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord, _reviewLane: rl1.lane,
  });
  assert.equal(rl1.calls.length, 1);
  assert.equal(res1.tasks[0].review, 'inconclusive');
  // Rewind task + marker to simulate the next attempt (the clean worktree means
  // recordWaveResult committed nothing — HEAD and the payload are unchanged).
  const st = readState(fx.statePath);
  writeState(fx.statePath, {
    ...st,
    tasks: st.tasks.map((t) => ({ ...t, status: 'pending' })),
    active_run: { wave: 1, phase: 'launching', scope: ['src/a.txt'], baseline: [] },
  });
  const rl2 = reviewLaneStub(approveLane);
  const res2 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2100,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord, _reviewLane: rl2.lane,
  });
  assert.equal(rl2.calls.length, 1, 'the skipped event did NOT satisfy re-entry — the lane ran AGAIN on the same key');
  assert.equal(res2.tasks[0].review, 'clean');
  const evs = readEvents(fx.bundleDir);
  const skipped = evs.filter((e) => e.type === 'task_adversary_review_skipped');
  const done = evs.filter((e) => e.type === 'task_adversary_review');
  assert.equal(skipped.length, 1);
  assert.equal(done.length, 1);
  assert.equal(done[0].data.sha, skipped[0].data.sha, 'same key both times — the done event supersedes the skip');
});

test('multi-task wave: one review per task — two lane calls, per-task verdicts, two task-specific re-entry events', async () => {
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
  write(op.cwd, 'src/a.txt', 'edit a\n');
  write(op.cwd, 'src/b.txt', 'edit b\n');
  // Distinct verdict per task — a copy-one-verdict-to-all implementation fails here.
  const rl = reviewLaneStub((args) => (args.task_id === 1
    ? approveLane
    : { final_verdict: 'reject', findings: [{ note: 'bad' }], blocking_findings: [{ note: 'bad' }], summary: 'nope' }));
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord, _reviewLane: rl.lane,
  });
  assert.equal(rl.calls.length, 2, 'one lane call PER TASK, never one per wave');
  assert.deepEqual(rl.calls.map((c) => c.task_id), [1, 2]);
  assert.equal(res.tasks[0].review, 'clean');
  assert.equal(res.tasks[1].review, 'blocking');
  assert.deepEqual(res.record.blocking_reviews.map((b) => b.id), [2], 'only task 2 blocks');
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review');
  assert.deepEqual(evs.map((e) => String(e.data.task)).sort(), ['1', '2'], 'two task-specific re-entry events');
  assert.equal(evs[0].data.sha, evs[1].data.sha, 'same edit locus → same payload hash; the TASK component keys them apart');
});

// ---------------------------------------------------------------------------
// Round-2 review fixes: segmentation (no truncation), structured verdicts,
// verdict-shape gating in the record protocol
// ---------------------------------------------------------------------------

test('segmentDiffPayload: byte-accounted, line-boundary, LOSSLESS (multibyte-safe; oversized lines hard-split)', () => {
  // Multibyte lines: é (2 bytes) + ★ (3 bytes) — byte length ≠ char length.
  const line = 'é★abc\n'; // 9 bytes, 6 chars
  const text = line.repeat(100);
  const segs = segmentDiffPayload(text, 64);
  assert.ok(segs.length > 1);
  assert.equal(segs.join(''), text, 'lossless reconstruction');
  for (const s of segs) assert.ok(Buffer.byteLength(s, 'utf8') <= 64, 'every segment within the BYTE budget');
  for (const s of segs.slice(0, -1)) assert.ok(s.endsWith('\n'), 'segments break at line boundaries');
  // A single line larger than the budget is hard-split without char corruption.
  const big = 'x'.repeat(10) + '★'.repeat(50);
  const segs2 = segmentDiffPayload(big, 32);
  assert.ok(segs2.length > 1);
  assert.equal(segs2.join(''), big);
  for (const s of segs2) assert.ok(Buffer.byteLength(s, 'utf8') <= 32);
  // Small payload → single verbatim segment (incl. the empty diff).
  assert.deepEqual(segmentDiffPayload('tiny', 100), ['tiny']);
  assert.deepEqual(segmentDiffPayload('', 100), ['']);
});

test('mergeReviewVerdicts: worst-wins (blocking > advisory > inconclusive > clean), findings union, counts sum', () => {
  const mk = (v, c = 1, f = `f-${v}`) => ({ verdict: v, count: c, findings: f });
  assert.equal(mergeReviewVerdicts(mk('clean'), mk('blocking')).verdict, 'blocking');
  assert.equal(mergeReviewVerdicts(mk('blocking'), mk('clean')).verdict, 'blocking');
  assert.equal(mergeReviewVerdicts(mk('clean'), mk('advisory')).verdict, 'advisory');
  assert.equal(mergeReviewVerdicts(mk('inconclusive'), mk('clean')).verdict, 'inconclusive');
  assert.equal(mergeReviewVerdicts(mk('advisory'), mk('inconclusive')).verdict, 'advisory');
  const merged = mergeReviewVerdicts(mk('clean', 2, 'first-half'), mk('blocking', 3, 'second-half'));
  assert.equal(merged.count, 5);
  assert.match(merged.findings, /first-half/);
  assert.match(merged.findings, /second-half/);
  // null-tolerant fold seed
  assert.equal(mergeReviewVerdicts(null, mk('clean')).verdict, 'clean');
  assert.equal(mergeReviewVerdicts(mk('clean'), null).verdict, 'clean');
});

test('large multibyte diff: one lane call PER SEGMENT covering ALL bytes — no truncation marker, worst-wins across segments', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-seg',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const WT = op.cwd;
  // >200KB of multibyte content → several ≤100KB-byte segments.
  write(WT, 'src/a.txt', 'é★ padded content line — segment fodder ★é\n'.repeat(6000));
  const fullDiff = captureFullWorkingDiff(WT);
  assert.ok(Buffer.byteLength(fullDiff, 'utf8') > 200_000, 'fixture diff is large enough to force segmentation');
  // clean on segment 1, blocking on a later segment — worst must win.
  const rl = reviewLaneStub((args) => (args.segment === 1
    ? approveLane
    : { final_verdict: 'reject', findings: [{ note: 'late-segment bug' }], blocking_findings: [{ note: 'late-segment bug' }], summary: 'blocker in a later segment' }));
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord, _reviewLane: rl.lane,
  });
  assert.ok(rl.calls.length > 1, 'multiple lane calls (one per segment)');
  for (const c of rl.calls) {
    assert.ok(Buffer.byteLength(c.diff, 'utf8') <= 100_000, 'every segment argv-safe by BYTES');
  }
  const joined = rl.calls.map((c) => c.diff).join('');
  assert.equal(joined, fullDiff, 'concatenated segments reconstruct the FULL diff — nothing dropped');
  assert.ok(!/truncated/.test(joined), 'no truncation marker anywhere in the payload');
  assert.equal(res.tasks[0].review, 'blocking', 'worst-wins across segments');
  assert.equal(res.record.blocking_reviews.length, 1);
  // The guard event's sha covers the COMPLETE payload, and the structured
  // verdict rides on the event.
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data.sha, createHash('sha256').update(fullDiff, 'utf8').digest('hex'));
  assert.equal(evs[0].data.verdict, 'blocking');
});

test('re-entry rehydrates the STRUCTURED verdict for every vocabulary value (text has no marker — a text-parse would fail-closed to blocking)', async () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] },
      { id: 3, status: 'pending', wave: 1, files: ['src/c.txt'] },
      { id: 4, status: 'pending', wave: 1, files: ['src/d.txt'] },
    ],
    planIndex: [
      planEntry(1, 1, ['src/a.txt']), planEntry(2, 1, ['src/b.txt']),
      planEntry(3, 1, ['src/c.txt']), planEntry(4, 1, ['src/d.txt']),
    ],
    slug: 'dw-verd',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const payloadSha = createHash('sha256').update(captureFullWorkingDiff(op.cwd), 'utf8').digest('hex');
  const verdicts = { 1: 'blocking', 2: 'advisory', 3: 'clean', 4: 'inconclusive' };
  for (const [task, verdict] of Object.entries(verdicts)) {
    const ev = buildTaskReviewEvent({
      run: 'dw-verd', task: Number(task), sha: payloadSha, status: 'done', count: 0,
      digest: `stored findings for task ${task} with NO verdict marker`,
    });
    ev.data.verdict = verdict; // the ADDITIVE structured field production writes
    fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), JSON.stringify(ev) + '\n');
  }
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord,
    _reviewLane: async () => assert.fail('lane must NOT be called — all four reviews are satisfied'),
  });
  assert.deepEqual(res.tasks.map((t) => t.review), ['blocking', 'advisory', 'clean', 'inconclusive']);
  assert.deepEqual(res.record.blocking_reviews.map((b) => b.id), [1], 'only the structured blocking verdict blocks');
});

test('misleading findings text cannot downgrade: structured verdict blocking wins over "verdict: clean" prose', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-mislead',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const payloadSha = createHash('sha256').update(captureFullWorkingDiff(op.cwd), 'utf8').digest('hex');
  const ev = buildTaskReviewEvent({
    run: 'dw-mislead', task: 1, sha: payloadSha, status: 'done', count: 1,
    digest: 'summary says all good. verdict: clean', // prose LIES; the structured field is authoritative
  });
  ev.data.verdict = 'blocking';
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), JSON.stringify(ev) + '\n');
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord,
    _reviewLane: async () => assert.fail('lane must NOT be called — re-entry satisfied'),
  });
  assert.equal(res.tasks[0].review, 'blocking', 'the structured verdict wins over misleading prose');
  assert.deepEqual(res.record.blocking_reviews.map((b) => b.id), [1]);
});

test('legacy event without a structured verdict and unparseable text re-enters BLOCKING (fail-closed, never inconclusive)', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-legacy',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const payloadSha = createHash('sha256').update(captureFullWorkingDiff(op.cwd), 'utf8').digest('hex');
  // Plain builder output: NO data.verdict, and findings text with NO verdict marker.
  const ev = buildTaskReviewEvent({
    run: 'dw-legacy', task: 1, sha: payloadSha, status: 'done', count: 3,
    digest: 'legacy stored findings without any marker present',
  });
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), JSON.stringify(ev) + '\n');
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord,
    _reviewLane: async () => assert.fail('lane must NOT be called — re-entry satisfied'),
  });
  assert.equal(res.tasks[0].review, 'blocking', 'a lost verdict fails CLOSED to blocking');
  assert.deepEqual(res.record.blocking_reviews.map((b) => b.id), [1], 'the fail-closed verdict surfaces for attention');
});

test('descriptor-shaped item.review cannot mask the digest verdict: blocking still surfaces through the redrive record path', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-maskrev',
  });
  launchViaContinue(fx);
  // A stored result whose ITEM carries a non-verdict review object (an echoed
  // descriptor requirement) while the DIGEST embeds the real blocking verdict.
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    key: composeWaveDispatchKey('dw-maskrev', 1), run_id: 'dw-maskrev', wave: 1, op: 'dispatch_fabric',
    contract_version: 'adsp-v1.1', status: 'dispatched', attempt: 1, dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
    result: {
      wave: 1,
      tasks: [{
        task_id: 1,
        review: { adversary: true }, // NOT verdict-shaped — must not mask
        digest: { ...workerDigest(1), review: { verdict: 'blocking', findings: 'digest-embedded blocker. verdict: blocking' } },
      }],
    },
  });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: neverBroker(), _openCoord: () => assert.fail('coord must not open on re-drive'),
  });
  assert.equal(res.outcome, 'reused');
  assert.equal(res.redrove_record, true);
  assert.deepEqual(res.record_result.blocking_reviews.map((b) => b.id), [1],
    'the digest-embedded blocking verdict surfaces despite the descriptor-shaped item.review');
});

test('segment failure preserves an earlier blocking verdict: worst-wins survives a degraded later segment', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-segfail',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  // Big enough for ≥2 segments.
  write(op.cwd, 'src/a.txt', 'é★ padded content line — segment fodder ★é\n'.repeat(6000));
  // Segment 1 returns a BLOCKING record; every later segment throws.
  const rl = reviewLaneStub((args) => {
    if (args.segment === 1) {
      return { final_verdict: 'reject', findings: [{ severity: 'high', note: 'early-segment blocker' }], blocking_findings: [{ severity: 'high', note: 'early-segment blocker' }], summary: 'blocker up front' };
    }
    throw new Error('lane wedged mid-wave');
  });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord, _reviewLane: rl.lane,
  });
  assert.ok(rl.calls.length > 1, 'later segments were still attempted after the failure');
  assert.equal(res.tasks[0].review, 'blocking', 'the known blocking verdict is NEVER discarded by a later segment failure');
  assert.equal(res.record.blocking_reviews.length, 1);
  const findings = String(res.record.blocking_reviews[0].findings);
  assert.match(findings, /early-segment blocker/, 'blocking finding content preserved');
  assert.match(findings, /degraded on segment/, 'the degraded segment is visible in the findings union');
  // Round-4 P1: a PARTIALLY-reviewed payload must never satisfy re-entry —
  // the guard event is SKIPPED (skip IGNORED on re-read), while this
  // attempt's merged blocking verdict still surfaced above.
  const evs = readEvents(fx.bundleDir);
  assert.equal(evs.filter((e) => e.type === 'task_adversary_review').length, 0, 'no done event for a partial payload');
  const skipped = evs.filter((e) => e.type === 'task_adversary_review_skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].data.verdict, 'blocking', 'the merged verdict rides on the skipped event for audit');
  // A re-dispatch reviews again — the skipped event satisfies nothing.
  const st = readState(fx.statePath);
  writeState(fx.statePath, {
    ...st,
    tasks: st.tasks.map((t) => ({ ...t, status: 'pending' })),
    active_run: { wave: 1, phase: 'launching', scope: ['src/a.txt'], baseline: [] },
  });
  const rl2 = reviewLaneStub(approveLane);
  await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2100,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord, _reviewLane: rl2.lane,
  });
  assert.ok(rl2.calls.length >= 1, 'the next attempt runs the lane again — partial coverage never sticks');
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

test('serializeFindings edge: a single oversized finding keeps an actionable truncated prefix — never a bare count', () => {
  const longNote = 'races on the owner lock when two writers interleave; '.repeat(150); // ≫ 4000 chars
  const mapped = mapAdversaryLaneVerdict({
    final_verdict: 'reject',
    findings: [{ severity: 'high', note: longNote }],
    blocking_findings: [{ severity: 'high', note: longNote }],
    summary: 'one huge blocker',
  });
  assert.equal(mapped.verdict, 'blocking');
  assert.match(mapped.findings, /BLOCKING: \[high\] races on the owner lock/, 'a truncated PREFIX of the finding survives');
  assert.ok(mapped.findings.length < 4600, 'bounded near the cap');
  assert.match(mapped.findings, /verdict: blocking/, 'the trailing verdict line survives the truncation');
});

test('legacy text spoof: findings carrying both "verdict: clean" and "verdict: blocking" rehydrate as BLOCKING (worst across all matches)', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-spoof',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const payloadSha = createHash('sha256').update(captureFullWorkingDiff(op.cwd), 'utf8').digest('hex');
  // LEGACY event (no structured data.verdict): reviewer-controlled prose tries
  // to spoof an early 'verdict: clean' ahead of the real blocking marker.
  const ev = buildTaskReviewEvent({
    run: 'dw-spoof', task: 1, sha: payloadSha, status: 'done', count: 1,
    digest: 'note claims verdict: clean early on, but the record closes verdict: blocking',
  });
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), JSON.stringify(ev) + '\n');
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord,
    _reviewLane: async () => assert.fail('lane must NOT be called — re-entry satisfied'),
  });
  assert.equal(res.tasks[0].review, 'blocking', 'worst recognized verdict wins over an earlier spoofed clean');
  assert.deepEqual(res.record.blocking_reviews.map((b) => b.id), [1]);
});

test('either-source blocking wins: an echoed clean item.review cannot mask a blocking digest.review (redrive path)', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-cleanmask',
  });
  launchViaContinue(fx);
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    key: composeWaveDispatchKey('dw-cleanmask', 1), run_id: 'dw-cleanmask', wave: 1, op: 'dispatch_fabric',
    contract_version: 'adsp-v1.1', status: 'dispatched', attempt: 1, dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
    result: {
      wave: 1,
      tasks: [{
        task_id: 1,
        review: { verdict: 'clean', findings: 'echoed clean from a stale surface' }, // verdict-shaped but WRONG
        digest: { ...workerDigest(1), review: { verdict: 'blocking', findings: 'digest-embedded blocker. verdict: blocking' } },
      }],
    },
  });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: neverBroker(), _openCoord: () => assert.fail('coord must not open on re-drive'),
  });
  assert.equal(res.outcome, 'reused');
  assert.equal(res.redrove_record, true);
  assert.deepEqual(res.record_result.blocking_reviews.map((b) => b.id), [1],
    'blocking from EITHER source surfaces — a clean echo never masks it');
  assert.match(String(res.record_result.blocking_reviews[0].findings), /digest-embedded blocker/);
});

test('merged findings are re-capped: many large-findings segments still yield a bounded digest (blocking content first)', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-cap',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  // Big enough for several segments.
  write(op.cwd, 'src/a.txt', 'é★ padded content line — segment fodder ★é\n'.repeat(6000));
  // EVERY segment returns a blocking record with ~2000 chars of findings —
  // uncapped concatenation would blow far past the documented 4000-char cap.
  const rl = reviewLaneStub((args) => ({
    final_verdict: 'reject',
    findings: [{ severity: 'high', note: `segment ${args.segment} blocker: ` + 'x'.repeat(2000) }],
    blocking_findings: [{ severity: 'high', note: `segment ${args.segment} blocker: ` + 'x'.repeat(2000) }],
    summary: `segment ${args.segment}`,
  }));
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(routeResult), _openCoord: disabledCoord, _reviewLane: rl.lane,
  });
  assert.ok(rl.calls.length > 1, 'multiple segments reviewed');
  assert.equal(res.tasks[0].review, 'blocking');
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  const findings = String(rec.result.tasks[0].digest.review.findings);
  assert.ok(findings.length <= 4100, `final findings bounded by the cap (got ${findings.length})`);
  assert.match(findings, /BLOCKING: \[high\] segment 1 blocker/, 'blocking content survives first');
  assert.match(findings, /\(\+\d+ more\)/, 'the omission is explicit, never silent');
  // The guard-event note carries the SAME capped text.
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review');
  assert.ok(String(evs[0].note).length <= 4100, 'event note capped too');
});

test('blocking_reviews[].findings is array-shaped in the mixed case: array + missing-findings sources stay an array', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-arr',
  });
  launchViaContinue(fx);
  // Two DIFFERENT blocking sources: item-side carries an ARRAY of findings,
  // digest-side is verdict-shaped but omits findings entirely.
  writeWaveDispatchRecord(fx.bundleDir, 1, {
    key: composeWaveDispatchKey('dw-arr', 1), run_id: 'dw-arr', wave: 1, op: 'dispatch_fabric',
    contract_version: 'adsp-v1.1', status: 'dispatched', attempt: 1, dispatched_at: 'T0',
    tasks: [{ task_id: 1, class: 'bounded-edit', handoff_key: 'k1' }],
    result: {
      wave: 1,
      tasks: [{
        task_id: 1,
        review: { verdict: 'blocking', findings: ['item-side finding'] },
        digest: { ...workerDigest(1), review: { verdict: 'blocking' } },
      }],
    },
  });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: neverBroker(), _openCoord: () => assert.fail('coord must not open on re-drive'),
  });
  assert.equal(res.redrove_record, true);
  assert.equal(res.record_result.blocking_reviews.length, 1);
  const { findings } = res.record_result.blocking_reviews[0];
  assert.ok(Array.isArray(findings), 'findings stays ARRAY-shaped in the mixed union');
  assert.deepEqual(findings, ['item-side finding']);
});
