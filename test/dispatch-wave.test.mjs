// test/dispatch-wave.test.mjs — the dispatch_fabric op consumer (lib/dispatch-wave.mjs).
//
// REAL git in temp repos (the continue.test.mjs pattern): the module's value is the exact
// interleaving of the idempotency record, the broker fanout seam, coord pairing, and the
// record-result transaction, so the tests drive genuine MAIN+worktree bundles through
// `mp continue` (which writes the phase-1 marker dispatch-wave consumes) and inject only
// the broker client / coord seams. Covered behaviors (the chunk-B review mandates):
//
//   1. Flag-off → no-op: state.dispatch.fabric unset → outcome 'flag-off', broker untouched.
//   2. Full flow: one descriptor per routed task (adapter buildWorkItem shape), a
//      bounded pool of dispatch_task calls, worker digests recorded via recordWaveResult (task done,
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
  buildNativeSpawnPlan,
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

/** Injected broker client: records calls; supports dispatch_task + dispatch_review. */
function brokerStub({ dispatchResult = routeResult, reviewResult = approveRecord } = {}) {
  const calls = [];
  return {
    calls,
    async initialize() {},
    async callTool(tool, args) {
      calls.push({ tool, args });
      if (tool === 'dispatch_task') {
        return typeof dispatchResult === 'function'
          ? dispatchResult(args.descriptor)
          : dispatchResult;
      }
      if (tool === 'dispatch_review') {
        if (typeof reviewResult === 'function') return reviewResult(args);
        if (reviewResult instanceof Error) throw reviewResult;
        return reviewResult;
      }
      throw new Error(`unexpected tool ${tool}`);
    },
    close() {},
  };
}
const reviewCalls = (stub) => stub.calls.filter((c) => c.tool === 'dispatch_review');
/** Collect descriptors from a dispatch_task pool (or legacy fanout) call log. */
function callDescriptors(stub) {
  const taskCalls = stub.calls.filter((c) => c.tool === 'dispatch_task' || c.tool === 'dispatch_task');
  if (!taskCalls.length) return [];
  if (taskCalls[0].tool === 'dispatch_task' || taskCalls[0].name === 'dispatch_task') {
    return taskCalls.map((c) => c.args.descriptor);
  }
  return taskCalls[0].args?.descriptors ?? [];
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

test('full flow: one descriptor per routed task, per-task dispatch_task pool, digests recorded with worker provenance', async () => {
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
  const stub = brokerStub();

  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });

  // Bounded pool of per-task dispatch_task calls (broker fan-out tool retired).
  assert.equal(stub.calls.length, 2);
  assert.ok(stub.calls.every((c) => c.tool === 'dispatch_task'));
  const descriptors = stub.calls.map((c) => c.args.descriptor);
  assert.equal(descriptors.length, 2);
  // Order may be concurrent — sort by task_id for assertions.
  descriptors.sort((a, b) => a.task_id - b.task_id);
  for (const [i, d] of descriptors.entries()) {
    assert.equal(d.task_id, i + 1);
    assert.equal(d.class, 'masterplan-implementation', 'default fabric class');
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

  const stub = brokerStub();
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
  const stub = brokerStub();
  await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: coord.open,
  });
  assert.equal(coord.state.opens, 1);
  assert.equal(coord.state.closes, 1, 'coord job closed exactly once (in the finally)');
  const descriptors = callDescriptors(stub).slice().sort((a, b) => a.task_id - b.task_id);
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
  assert.ok(state.active_run, 'marker survives a failed wave (recover_wave owns it)');
  const degraded = readEvents(fx.bundleDir).filter((e) => e.type === 'dispatch_degraded');
  assert.equal(degraded.length, 2);
  assert.ok(degraded.every((e) => e.outcome === 'broker_error'));
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).status, 'recorded');

  // 7b. The failure was OBSERVED (recorded) — a follow-up invoke is a legitimate
  // retry and starts attempt 2 (never blocked by the idempotency record).
  const stub = brokerStub();
  const res2 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  assert.equal(res2.outcome, 'dispatched');
  assert.equal(res2.attempt, 2);
  assert.equal(stub.calls.length, 2, 'attempt 2 dispatches one dispatch_task per pending task');
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
    async callTool(tool, args) {
      this.calls.push({ tool, args });
      await gate;
      if (tool === 'dispatch_task') return routeResult(args.descriptor);
      throw new Error(`unexpected tool ${tool}`);
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
  const stub = brokerStub();
  await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000, codexSuppressed: true,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  // Descriptors correspond 1:1 to the launch op's prepared payload.
  const descriptors = callDescriptors(stub).slice().sort((a, b) => a.task_id - b.task_id);
  const opTasks = op.tasks.slice().sort((a, b) => a.id - b.id);
  assert.deepEqual(
    descriptors.map((d) => ({ id: d.task_id, class: d.class, brief: d.brief, files: d.files })),
    opTasks.map((t) => ({ id: t.id, class: t.class, brief: t.description, files: t.files })),
    'descriptors must match what the launch marker promised (verify packaging is wire-only)',
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
  const stub = brokerStub();
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
  const stub = brokerStub({ dispatchResult: (descriptor) => {
    write(descriptor.repo, descriptor.files[0], 'generated\n');
    return routeResult(descriptor);
  }});
  const localVerifyCalls = [];
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
    _localVerifyExec: (command, options) => {
      localVerifyCalls.push({ command, cwd: options.cwd });
      return '';
    },
  });

  const [descriptor] = callDescriptors(stub);
  assert.equal(descriptor.repo, WT);
  assert.deepEqual(descriptor.files, ['src/generated.txt']);
  assert.deepEqual(localVerifyCalls, [{
    command: `test -f ${path.join(WT, 'src/generated.txt')}`,
    cwd: WT,
  }]);
  assert.equal(res.record.scope.ok, true);
  assert.deepEqual(res.record.scope.outOfScope, []);
  assert.equal(res.record.watch.ok, true);
  assert.deepEqual(res.record.watch.violations, []);
  assert.deepEqual(res.record.watch.reverted, []);
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
  const stub = brokerStub();
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  assert.equal(res.outcome, 'dispatched');
  assert.equal(stub.calls.length, 2);
  const descriptors = callDescriptors(stub).slice().sort((a, b) => a.task_id - b.task_id);
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

// ---------------------------------------------------------------------------
// Per-task adversary review — caller-owned behaviors via dispatch_review
// ---------------------------------------------------------------------------

test('review ON delegates the full edit-locus diff to canonical dispatch_review', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-central-review',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  const WT = op.cwd;
  write(WT, 'src/a.txt', 'declared\n');
  write(WT, 'src/oops.txt', 'undeclared\n');
  const head = git(WT, 'rev-parse', 'HEAD');
  const stub = brokerStub();
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  const calls = reviewCalls(stub);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.class, 'adversary');
  assert.equal(calls[0].args.mode, 'diff');
  assert.equal(calls[0].args.intensity, 'standard');
  assert.match(calls[0].args.diff, /src\/a\.txt/);
  assert.match(calls[0].args.diff, /src\/oops\.txt/);
  assert.equal(res.tasks[0].review, 'approve');
  assert.deepEqual(res.record.blocking_reviews, []);
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data.run, 'dw-central-review');
  assert.equal(String(evs[0].data.task), '1');
  const payloadSha = createHash('sha256').update(calls[0].args.diff, 'utf8').digest('hex');
  assert.equal(evs[0].data.sha, payloadSha);
  assert.equal(evs[0].data.base, head);
  assert.equal(evs[0].data.review.verdict, 'approve');
  // Same injected broker client handled both tools.
  assert.ok(stub.calls.some((c) => c.tool === 'dispatch_task'));
  assert.ok(stub.calls.some((c) => c.tool === 'dispatch_review'));
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
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub(), _openCoord: disabledCoord,
  });
  assert.equal(res.tasks[0].review, 'approve');
  assert.ok(res.record.reverted.includes('src/oops.txt'), 'out-of-scope write reverted despite the approve verdict');
  assert.equal(fs.existsSync(path.join(WT, 'src/oops.txt')), false, 'the undeclared file is gone from the worktree');
  assert.equal(readState(fx.statePath).tasks[0].status, 'done', 'the in-scope work still records');
});

test('review OFF (state.review.adversary=false): no dispatch_review call, no review fields, no re-entry guard writes', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-revoff',
    extra: { review: { adversary: false } },
  });
  const op = launchViaContinue(fx);
  write(op.cwd, 'src/a.txt', 'edit\n');
  const stub = brokerStub();
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  assert.equal(res.outcome, 'dispatched');
  assert.equal(reviewCalls(stub).length, 0);
  assert.equal('review' in res.tasks[0], false);
  const rec = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal('review' in rec.result.tasks[0], false);
  assert.equal('review' in rec.result.tasks[0].digest, false);
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review' || e.type === 'task_adversary_review_skipped');
  assert.equal(evs.length, 0, 'no re-entry guard writes on the disable path');
  assert.deepEqual(res.record.blocking_reviews, []);
  assert.equal('review' in callDescriptors(stub)[0], false, 'disabled review is omitted from the descriptor');
});

test('reject surfaces structured blocking_reviews[] while the done digest still records', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-block',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  write(op.cwd, 'src/a.txt', 'edit\n');
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub({ reviewResult: rejectRecord }), _openCoord: disabledCoord,
  });
  assert.equal(res.tasks[0].review, 'reject');
  assert.equal(res.record.blocking_reviews.length, 1);
  assert.equal(res.record.blocking_reviews[0].id, 1);
  assert.equal(res.record.blocking_reviews[0].verdict, 'reject');
  assert.ok(res.record.blocking_reviews[0].findings.some((f) => String(f.summary ?? f).includes('data race')));
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
});

test('review idempotency: a prior structured run+task+sha done event short-circuits dispatch_review', async () => {
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
  const stub = brokerStub({ reviewResult: () => assert.fail('completed event must satisfy re-entry') });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  assert.equal(reviewCalls(stub).length, 0);
  assert.equal(res.tasks[0].review, 'rework');
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
  write(op.cwd, 'src/a.txt', 'edit\n');
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub({ reviewResult: new Error('lane wedged') }), _openCoord: disabledCoord,
  });
  assert.equal(res.tasks[0].review, 'error');
  assert.equal(res.record.blocking_reviews.length, 1);
  assert.equal(res.record.blocking_reviews[0].verdict, 'error');
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
  const stub = brokerStub();
  await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  const calls = reviewCalls(stub);
  assert.equal(calls.length, 1, 'stale-payload approval must NOT suppress review of different code');
  const freshSha = createHash('sha256').update(calls[0].args.diff, 'utf8').digest('hex');
  assert.notEqual(freshSha, staleSha, 'the changed diff produces a different key');
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
  const stub1 = brokerStub({ reviewResult: new Error('lane wedged') });
  const res1 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub1, _openCoord: disabledCoord,
  });
  assert.equal(reviewCalls(stub1).length, 1);
  assert.equal(res1.tasks[0].review, 'error');
  const st = readState(fx.statePath);
  writeState(fx.statePath, {
    ...st,
    tasks: st.tasks.map((t) => ({ ...t, status: 'pending' })),
    active_run: { wave: 1, phase: 'launching', scope: ['src/a.txt'], baseline: [] },
  });
  const stub2 = brokerStub();
  const res2 = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2100,
    _brokerClient: stub2, _openCoord: disabledCoord,
  });
  assert.equal(reviewCalls(stub2).length, 1, 'the skipped event did NOT satisfy re-entry');
  assert.equal(res2.tasks[0].review, 'approve');
  const evs = readEvents(fx.bundleDir);
  const skipped = evs.filter((e) => e.type === 'task_adversary_review_skipped');
  const done = evs.filter((e) => e.type === 'task_adversary_review');
  assert.equal(skipped.length, 1);
  assert.equal(done.length, 1);
  assert.equal(done[0].data.sha, skipped[0].data.sha);
});

test('multi-task wave: one dispatch_review per task with per-task verdicts and events', async () => {
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
  let n = 0;
  const stub = brokerStub({
    reviewResult: () => {
      n += 1;
      return n === 1 ? approveRecord : rejectRecord;
    },
  });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  assert.equal(reviewCalls(stub).length, 2, 'one review call PER TASK, never one per wave');
  assert.equal(res.tasks[0].review, 'approve');
  assert.equal(res.tasks[1].review, 'reject');
  assert.deepEqual(res.record.blocking_reviews.map((b) => b.id), [2], 'only task 2 blocks');
  const evs = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review');
  assert.deepEqual(evs.map((e) => String(e.data.task)).sort(), ['1', '2']);
  assert.equal(evs[0].data.sha, evs[1].data.sha, 'same edit locus → same payload hash; the TASK component keys them apart');
});

test('degraded approve surfaces as a blocking error review', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-deg-approve',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  write(op.cwd, 'src/a.txt', 'edit\n');
  const degradedApprove = {
    final_verdict: 'approve', findings: [], blocking_findings: [],
    summary: 'approve but incomplete',
    harness: { ...healthyHarness(), degraded: true, regions_unreviewed: 1 },
  };
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: brokerStub({ reviewResult: degradedApprove }), _openCoord: disabledCoord,
  });
  assert.equal(res.tasks[0].review, 'approve');
  assert.equal(res.record.blocking_reviews.length, 1);
  assert.equal(res.record.blocking_reviews[0].verdict, 'error');
  const skipped = readEvents(fx.bundleDir).filter((e) => e.type === 'task_adversary_review_skipped');
  assert.equal(skipped.length, 1, 'incomplete approve coverage uses skipped and never satisfies re-entry');
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
    contract_version: 'adsp-v1.1', status: 'dispatched', attempt: 1, dispatched_at: 'T0',
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
    _brokerClient: neverBroker(), _openCoord: () => assert.fail('coord must not open on re-drive'),
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
    contract_version: 'adsp-v1.1', status: 'dispatched', attempt: 1, dispatched_at: 'T0',
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
    _brokerClient: neverBroker(), _openCoord: () => assert.fail('coord must not open on re-drive'),
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
    _resolve: () => ({ lane: 'dispatch-agentic-loop', agent: 'builder', effort: 'high', capability: 'edit', backend: 'dispatch-gateway', provider: 'grok-4.5', resolved: true }),
  });
  assert.equal(plan.tasks[0].cwd, '/tmp/wt/toy');
});

test('an explicit cwd still wins over repo', () => {
  const plan = buildNativeSpawnPlan({
    tasks: [{ id: 1, class: 'masterplan-implementation', files: [] }],
    descriptors: [{ cwd: '/explicit', repo: '/tmp/wt/toy' }],
    token: 'tok',
    _resolve: () => ({ lane: 'dispatch-agentic-loop', agent: 'builder', effort: 'high', capability: 'edit', backend: 'dispatch-gateway', provider: 'grok-4.5', resolved: true }),
  });
  assert.equal(plan.tasks[0].cwd, '/explicit');
});

test('cwd stays null when the descriptor names no locus at all', () => {
  const plan = buildNativeSpawnPlan({
    tasks: [{ id: 1, class: 'masterplan-implementation', files: [] }],
    descriptors: [{}],
    token: 'tok',
    _resolve: () => ({ lane: 'dispatch-agentic-loop', agent: 'builder', effort: 'high', capability: 'edit', backend: 'dispatch-gateway', provider: 'grok-4.5', resolved: true }),
  });
  assert.equal(plan.tasks[0].cwd, null, 'absence is reported, never invented');
});
