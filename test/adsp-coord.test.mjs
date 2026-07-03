// test/adsp-coord.test.mjs — masterplan-side coord lifecycle (T11).
//
// Covers the fail-open, idempotent contract of lib/dispatch/adsp-coord.mjs against
// an injected execFileSync stub (no real `agent-dispatch` CLI is spawned):
//   - single-task wave -> disabled, no CLI calls
//   - multi-task wave -> open + register each worker + attach per-task coord context + close
//   - open degraded / execFile throws -> disabled, fail-open (no throw)
//   - closeWaveCoord: missing jobId skipped; close called; throw -> degraded envelope

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openWaveCoord, closeWaveCoord, resolveCoordRoot } from '../lib/dispatch/adsp-coord.mjs';

// Recording execFile stub — returns JSON the CLI would, records calls.
function recordingExec({ openDegraded, registerDegraded, closeThrows } = {}) {
  const calls = [];
  const exec = (bin, args, _opts) => {
    calls.push(args);
    const sub = args[1]; // 'coord'
    const op = args[2]; // 'job' | 'register' | 'post' ...
    if (op === 'open' || (sub === 'job' && op === 'open')) {
      return Buffer.from(JSON.stringify(openDegraded ? { degraded: true, reason: 'stub open degraded' } : { ok: true, job_id: args[4] }));
    }
    if (op === 'register' || sub === 'register') {
      return Buffer.from(JSON.stringify(registerDegraded ? { degraded: true, reason: 'stub register degraded' } : { ok: true, roster: [args[4]] }));
    }
    if (op === 'close' || (sub === 'job' && op === 'close')) {
      if (closeThrows) throw new Error('stub close throws');
      return Buffer.from(JSON.stringify({ ok: true, state: 'closed', closed_ts: '2026-07-02T00:00:00.000Z' }));
    }
    return Buffer.from(JSON.stringify({ ok: true }));
  };
  return { exec, calls };
}

describe('openWaveCoord — gating', () => {
  it('single-task wave -> disabled, no CLI calls', () => {
    const { exec, calls } = recordingExec();
    const h = openWaveCoord({ root: '/bb', wave: 3, tasks: [{ id: 't1' }], lead: 'lead', execFile: exec });
    assert.equal(h.enabled, false);
    assert.equal(calls.length, 0);
    assert.equal(h.attachToTask({ id: 't1' }, 0).coord, undefined);
    assert.equal(h.close().skipped, true);
  });

  it('zero/non-array tasks -> disabled', () => {
    const { exec, calls } = recordingExec();
    const h = openWaveCoord({ root: '/bb', wave: 3, tasks: [], execFile: exec });
    assert.equal(h.enabled, false);
    assert.equal(calls.length, 0);
  });
});

describe('openWaveCoord — multi-task happy path', () => {
  it('opens the job, registers each worker, attaches per-slot coord, closes', () => {
    const { exec, calls } = recordingExec();
    const tasks = [{ id: 't0' }, { id: 't1' }, { id: 't2' }];
    const h = openWaveCoord({ root: '/bb', wave: 5, tasks, lead: 'lead', goal: 'ship it', execFile: exec });

    assert.equal(h.enabled, true);
    assert.ok(h.jobId);
    assert.match(h.jobId, /^mp-wave-5-/);
    assert.equal(h.workerIds.length, 3);

    // open called once; register called once per worker
    const openCalls = calls.filter((a) => a[2] === 'open');
    const regCalls = calls.filter((a) => a[1] === 'register');
    assert.equal(openCalls.length, 1);
    assert.equal(regCalls.length, 3);

    // attachToTask threads per-slot coord context; original task not mutated
    const e0 = h.attachToTask(tasks[0], 0);
    assert.notEqual(e0, tasks[0]);
    assert.equal(e0.coord.root, '/bb');
    assert.equal(e0.coord.jobId, h.jobId);
    assert.equal(e0.coord.agentId, h.workerIds[0]);
    assert.equal(e0.coord.lead, 'lead');
    assert.equal(tasks[0].coord, undefined, 'original task must not be mutated');

    const e1 = h.attachToTask(tasks[1], 1);
    assert.equal(e1.coord.agentId, h.workerIds[1]);

    // close calls coord job close once on the right job
    const r = h.close();
    assert.equal(r.ok, true);
    assert.equal(r.state, 'closed');
    const closeCalls = calls.filter((a) => a[2] === 'close');
    assert.equal(closeCalls.length, 1);
    assert.ok(closeCalls[0].includes(h.jobId));
  });
});

describe('openWaveCoord — fail-open', () => {
  it('open degraded -> disabled, no register calls, no throw', () => {
    const { exec, calls } = recordingExec({ openDegraded: true });
    const h = openWaveCoord({ root: '/bb', wave: 2, tasks: [{ id: 't0' }, { id: 't1' }], execFile: exec });
    assert.equal(h.enabled, false);
    assert.match(h.reason, /open degraded/);
    assert.equal(calls.filter((a) => a[1] === 'register').length, 0);
    assert.equal(h.close().skipped, true);
  });

  it('execFile throws -> disabled, fail-open (no throw)', () => {
    const exec = () => { throw new Error('cli unavailable'); };
    const h = openWaveCoord({ root: '/bb', wave: 2, tasks: [{ id: 't0' }, { id: 't1' }], execFile: exec });
    assert.equal(h.enabled, false);
    assert.match(h.reason, /cli unavailable/);
  });
});

describe('closeWaveCoord', () => {
  it('missing jobId -> skipped', () => {
    const { exec, calls } = recordingExec();
    assert.equal(closeWaveCoord({ execFile: exec }).skipped, true);
    assert.equal(calls.length, 0);
  });

  it('close throws -> degraded envelope, no throw', () => {
    const { exec } = recordingExec({ closeThrows: true });
    const r = closeWaveCoord({ root: '/bb', jobId: 'j1', execFile: exec });
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.match(r.reason, /close failed/);
  });
});

describe('resolveCoordRoot', () => {
  it('explicit > env > default', () => {
    assert.equal(resolveCoordRoot('/explicit'), '/explicit');
    assert.ok(resolveCoordRoot().length > 0);
  });
});
