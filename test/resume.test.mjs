// test/resume.test.mjs — exhaustive branch coverage for the L1 control-loop core.
// decideNextAction is PURE (no I/O, no LLM), so every branch is asserted directly here.
// Grounding for the contract: docs/spike-0.5-findings.md (deltas D1, D2, D5; findings F2/F3/F6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideNextAction } from '../lib/resume.mjs';

const t = (id, wave, status, files = []) => ({ id, wave, status, files });
const base = (over = {}) => ({ pending_gate: null, active_run: null, tasks: [], ...over });

test('pending_gate takes priority over an in-flight run and pending tasks', () => {
  const gate = { id: 'plan_approval', opened_at: 'X' };
  const s = base({
    pending_gate: gate,
    active_run: { run_id: 'wf_1', task_id: 'k1', wave: 1 },
    tasks: [t(1, 1, 'pending')],
  });
  const d = decideNextAction(s, { alive: true, resultsRecorded: false });
  assert.equal(d.action, 'surface_gate');
  assert.deepEqual(d.gate, gate);
});

test('pending_gate takes priority with no active run', () => {
  const gate = { id: 'spec_approval', opened_at: 'Y' };
  const s = base({ pending_gate: gate, tasks: [t(1, 1, 'pending')] });
  assert.equal(decideNextAction(s, {}).action, 'surface_gate');
});

test('active run alive -> wait (drop liveness.resultsRecorded — completion now derives from disk)', () => {
  const run = { run_id: 'wf_1', task_id: 'k1', wave: 1 };
  const s = base({ active_run: run, tasks: [t(1, 1, 'pending')] });
  const d = decideNextAction(s, { alive: true });
  assert.equal(d.action, 'wait');
  assert.deepEqual(d.run, run);
});

test('active run alive even with all wave tasks done -> wait (never second-guess a live run)', () => {
  const run = { run_id: 'wf_1', task_id: 'k1', wave: 1 };
  const s = base({ active_run: run, tasks: [t(1, 1, 'done')] });
  assert.equal(decideNextAction(s, { alive: true }).action, 'wait');
});

test('active run dead, ALL wave tasks done on disk -> finalize_run (orphan window: run set, work recorded)', () => {
  // "results recorded" is DERIVED — every task of the run's wave is `done` in state.yml — not a probe.
  const run = { run_id: 'wf_1', task_id: 'k1', wave: 1 };
  const s = base({ active_run: run, tasks: [t(1, 1, 'done'), t(2, 1, 'done')] });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'finalize_run');
  assert.deepEqual(d.run, run);
});

test('active run dead with work outstanding -> recover; reset only the wave\'s incomplete tasks + carry staleTaskId', () => {
  const run = { run_id: 'wf_1', task_id: 'k1', wave: 2 };
  const s = base({
    active_run: run,
    tasks: [
      t(1, 1, 'done', ['a.txt']),
      t(2, 2, 'pending', ['b.txt', 'c.txt']),
      t(3, 2, 'done', ['d.txt']), // already done in the wave: not reset, not re-dispatched
      t(4, 3, 'pending', ['e.txt']),
    ],
  });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_and_redispatch');
  assert.equal(d.wave, 2);
  assert.deepEqual(d.tasks.map((x) => x.id), [2]);
  assert.deepEqual(d.resetPaths, ['b.txt', 'c.txt']);
  assert.equal(d.staleTaskId, 'k1'); // the shell reconciles (TaskList/TaskStop) before reset+redispatch
});

test('missing liveness while active run set (has task_id) -> treated as dead -> recover, staleTaskId carried', () => {
  const run = { run_id: 'wf_1', task_id: 'k1', wave: 1 };
  const s = base({ active_run: run, tasks: [t(1, 1, 'pending', ['a.txt'])] });
  const d = decideNextAction(s);
  assert.equal(d.action, 'recover_and_redispatch');
  assert.equal(d.staleTaskId, 'k1');
});

test('active_run phase-1 (launching, NO task_id) -> recover, staleTaskId null (crashed in the launch gap)', () => {
  // The marker is written {wave, phase:'launching'} BEFORE launch returns a task_id. A crash here
  // has no task to probe and nothing to reconcile (no task_id), so reset+redispatch is safe and
  // prevents a double-dispatch onto a Workflow that may or may not have actually started.
  const s = base({ active_run: { wave: 2, phase: 'launching' }, tasks: [t(1, 1, 'done'), t(2, 2, 'pending', ['b.txt'])] });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'recover_and_redispatch');
  assert.equal(d.wave, 2);
  assert.deepEqual(d.tasks.map((x) => x.id), [2]);
  assert.equal(d.staleTaskId, null);
});

test('no active run, pending tasks -> dispatch the lowest pending wave only', () => {
  const s = base({
    tasks: [t(1, 1, 'done'), t(2, 2, 'pending', ['b.txt']), t(3, 2, 'pending', ['c.txt']), t(4, 3, 'pending', ['e.txt'])],
  });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'dispatch_wave');
  assert.equal(d.wave, 2);
  assert.deepEqual(d.tasks.map((x) => x.id), [2, 3]);
});

test('no active run, partially-done lowest wave -> dispatch only its pending tasks', () => {
  const s = base({ tasks: [t(1, 1, 'done'), t(2, 1, 'pending', ['b.txt']), t(3, 2, 'pending', ['c.txt'])] });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'dispatch_wave');
  assert.equal(d.wave, 1);
  assert.deepEqual(d.tasks.map((x) => x.id), [2]);
});

test('all tasks done -> complete', () => {
  assert.equal(decideNextAction(base({ tasks: [t(1, 1, 'done'), t(2, 2, 'done')] }), {}).action, 'complete');
});

test('no tasks -> complete', () => {
  assert.equal(decideNextAction(base(), {}).action, 'complete');
});

test('GUARD: a pending task with a non-integer (null) wave throws — waves not backfilled', () => {
  // A just-migrated legacy bundle carries wave:null until the shell re-derives waves from
  // plan.index.json. Math.min(null,…) coerces to 0 but `wave === 0` matches nothing -> a SILENT
  // empty dispatch and the run stalls. The guard fails loud instead. (Caught via migrate(WBN).)
  const s = base({ tasks: [t(1, null, 'pending'), t(2, null, 'pending')] });
  assert.throws(() => decideNextAction(s, {}), /backfill waves from plan\.index\.json/);
});

test('GUARD: all-done tasks with null waves still resume to complete (guard not reached)', () => {
  // Migrated all-complete bundle (e.g. codex-routing-fix): zero pending -> early `complete` return
  // BEFORE the wave guard, so null-wave DONE tasks never trip it.
  const s = base({ tasks: [t(1, null, 'done'), t(2, null, 'done')] });
  assert.equal(decideNextAction(s, {}).action, 'complete');
});

test('is pure: does not mutate the input state', () => {
  const s = base({ active_run: { run_id: 'wf_1', task_id: 'k1', wave: 1 }, tasks: [t(1, 1, 'pending', ['a'])] });
  const snapshot = JSON.stringify(s);
  decideNextAction(s, { alive: false });
  assert.equal(JSON.stringify(s), snapshot);
});