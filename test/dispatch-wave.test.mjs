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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  dispatchWaveViaFabric,
  composeWaveDispatchKey,
  waveDispatchRecordPath,
  readWaveDispatchRecord,
  createWaveDispatchRecord,
  writeWaveDispatchRecord,
  claimAttemptMarker,
  WAVE_DISPATCH_KEY_VERSION,
} from '../lib/dispatch-wave.mjs';
import { continueRun } from '../lib/continue.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';

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
