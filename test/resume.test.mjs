// test/resume.test.mjs — exhaustive branch coverage for the L1 control-loop core.
// decideNextAction is PURE (no I/O, no LLM), so every branch is asserted directly here.
// Grounding for the contract: docs/spike-0.5-findings.md (deltas D1, D2, D5; findings F2/F3/F6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideNextAction, BLACKBOARD_STATES } from '../lib/resume.mjs';
import { composeHandoffKey, computeTaskSpecHash, computeInputFingerprint, IDEMPOTENCY_VERSION } from '../lib/adsp-idempotency.mjs';

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

test('planning active_run phase-1 (launching, NO task_id) -> recover_plan_run with null staleTaskId', () => {
  const s = base({ active_run: { kind: 'plan', phase: 'launching' }, tasks: [t(1, null, 'pending', ['a.txt'])] });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'recover_plan_run');
  assert.equal(d.staleTaskId, null);
});

test('planning active_run phase-2 alive -> wait', () => {
  const run = { kind: 'plan', run_id: 'r', task_id: 't' };
  const s = base({ active_run: run, tasks: [t(1, null, 'pending', ['a.txt'])] });
  const d = decideNextAction(s, { alive: true });
  assert.equal(d.action, 'wait');
  assert.deepEqual(d.run, run);
});

test('planning active_run phase-2 dead -> recover_plan_run with staleTaskId', () => {
  const s = base({ active_run: { kind: 'plan', run_id: 'r', task_id: 't' }, tasks: [t(1, null, 'pending', ['a.txt'])] });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_plan_run');
  assert.equal(d.staleTaskId, 't');
});

test('planning active_run does not require an integer wave', () => {
  const s = base({ active_run: { kind: 'plan', phase: 'launching' }, tasks: [t(1, null, 'pending', ['a.txt'])] });
  assert.doesNotThrow(() => decideNextAction(s, {}));
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

test('no tasks, NO phase (phaseless/legacy) -> complete', () => {
  // base() sets no `phase`. A phaseless/legacy bundle keeps the disk-derived completion semantics
  // (this is the read-only status/next path on completed & migrated runs). Only a bundle whose
  // phase is explicitly a pre-execute phase diverts — see the resume_phase tests below.
  assert.equal(decideNextAction(base(), {}).action, 'complete');
});

test('PRE-EXECUTE GUARD: brainstorm phase + tasks:[] -> resume_phase (a fresh seed is NOT finished)', () => {
  // A just-seeded bundle (phase:brainstorm, no plan built). `complete` here would archive a run
  // that never ran. Hand to §3 instead.
  const d = decideNextAction(base({ phase: 'brainstorm' }), {});
  assert.equal(d.action, 'resume_phase');
  assert.equal(d.phase, 'brainstorm');
});

test('PRE-EXECUTE GUARD: plan phase + tasks:[] -> resume_phase (the live openxcvr data-loss hazard)', () => {
  // The exact shape of commercial-license-lock: phase:plan, tasks:[]. A bare `/masterplan` resume
  // must NOT finalize/archive a mid-plan run.
  const d = decideNextAction(base({ phase: 'plan' }), {});
  assert.equal(d.action, 'resume_phase');
  assert.equal(d.phase, 'plan');
});

test('PRE-EXECUTE GUARD: plan phase + tasks:[] echoes planning_mode', () => {
  const d = decideNextAction(base({ phase: 'plan', planning_mode: 'parallel' }), {});
  assert.equal(d.action, 'resume_phase');
  assert.equal(d.phase, 'plan');
  assert.equal(d.planning_mode, 'parallel');
});

test('PRE-EXECUTE GUARD: plan phase + tasks:[] defaults planning_mode to auto', () => {
  const d = decideNextAction(base({ phase: 'plan' }), {});
  assert.equal(d.action, 'resume_phase');
  assert.equal(d.phase, 'plan');
  assert.equal(d.planning_mode, 'auto');
});

test('execute phase, all tasks done -> complete (genuinely finished run still finalizes)', () => {
  // The guard is scoped to PRE-execute phases AND tasks:[] — a real run that built tasks and ran
  // them all `done` finalizes regardless of phase label. Completion is a disk fact, not a label.
  assert.equal(decideNextAction(base({ phase: 'execute', tasks: [t(1, 1, 'done')] }), {}).action, 'complete');
});

test('ISSUE G GUARD: execute phase + tasks:[] throws — an unseeded run must not silently finalize', () => {
  // The execute-phase counterpart to the pre-execute guard above. brainstorm|plan + tasks:[] is a
  // resumable mid-design state (resume_phase); execute + tasks:[] is IMPOSSIBLE under correct
  // operation — §3 runs `mp seed-tasks` BEFORE `set-phase execute`. It only arises when that ordering
  // was violated (hand-edit / migration / --force). Returning `complete` would archive a planned-but-
  // unseeded run (the plan's work abandoned as "done" = data loss). Fail loud, like the wave guard.
  assert.throws(() => decideNextAction(base({ phase: 'execute' }), {}), /phase is 'execute' but state\.tasks is empty/);
});

test('plan phase WITH pending tasks -> dispatch_wave (never reaches the guard)', () => {
  // A plan-phase bundle that already built tasks dispatches normally — pending.length>0 short-
  // circuits the pending===0 branch entirely, so the pre-execute guard is irrelevant here.
  const d = decideNextAction(base({ phase: 'plan', tasks: [t(1, 1, 'pending', ['a.txt'])] }), {});
  assert.equal(d.action, 'dispatch_wave');
  assert.equal(d.wave, 1);
});

test('GUARD: a pending task with a non-integer (null) wave throws — waves not backfilled', () => {
  // A just-migrated legacy bundle carries wave:null until the shell re-derives waves from
  // plan.index.json. Math.min(null,…) coerces to 0 but `wave === 0` matches nothing -> a SILENT
  // empty dispatch and the run stalls. The guard fails loud instead. (Caught via migrate(SAMPLE).)
  const s = base({ tasks: [t(1, null, 'pending'), t(2, null, 'pending')] });
  assert.throws(() => decideNextAction(s, {}), /backfill waves from plan\.index\.json/);
});

test('GUARD: all-done tasks with null waves still resume to complete (guard not reached)', () => {
  // Migrated all-complete bundle (e.g. codex-routing-fix): zero pending -> early `complete` return
  // BEFORE the wave guard, so null-wave DONE tasks never trip it.
  const s = base({ tasks: [t(1, null, 'done'), t(2, null, 'done')] });
  assert.equal(decideNextAction(s, {}).action, 'complete');
});

// ---------------------------------------------------------------------------
// A9 — Coordination gate: uncoordinated path byte-identical
// ---------------------------------------------------------------------------

test('A9: no coordination object -> dispatch_wave (single-agent path unchanged)', () => {
  // An uncoordinated run (no `coordination` field in state) must produce exactly
  // the same dispatch_wave decision it would under a pre-coordination build.
  // The coordination gate must be entirely absent from the decision path.
  const s = base({ tasks: [t(1, 1, 'pending', ['a.txt']), t(2, 2, 'pending', ['b.txt'])] });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'dispatch_wave');
  assert.equal(d.wave, 1);
  assert.deepEqual(d.tasks.map((x) => x.id), [1]);
});

test('A9: coordination: null -> dispatch_wave (explicit null treated as uncoordinated)', () => {
  const s = base({
    coordination: null,
    tasks: [t(1, 1, 'pending', ['a.txt'])],
  });
  assert.equal(decideNextAction(s, {}).action, 'dispatch_wave');
});

// ---------------------------------------------------------------------------
// A7 — Coordination gate: publish_needed / coordinate ordering
// ---------------------------------------------------------------------------

test('A7: coordinated run, current wave has unpublished pending tasks -> publish_needed', () => {
  // Task 1 is pending and absent from issue_map -> unpublished.
  // publish_needed fires so a partial/failed publish is recovered before stranding the run.
  const s = base({
    coordination: { mode: 'github', current_wave: 1, issue_map: {} },
    tasks: [t(1, 1, 'pending', ['a.txt']), t(2, 2, 'pending', ['b.txt'])],
  });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'publish_needed');
  assert.equal(d.wave, 1);
  assert.deepEqual(d.tasks.map((x) => x.id), [1]);
});

test('A7: publish_needed carries only the unpublished tasks (partial publish)', () => {
  // Task 1 already published (in issue_map), task 2 not yet.
  const s = base({
    coordination: {
      mode: 'github',
      current_wave: 1,
      issue_map: { '1': { issue: 10, pr: null, merge_sha: null, status: 'open' } },
    },
    tasks: [t(1, 1, 'pending', ['a.txt']), t(2, 1, 'pending', ['b.txt'])],
  });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'publish_needed');
  assert.equal(d.wave, 1);
  assert.deepEqual(d.tasks.map((x) => x.id), [2]); // only the unpublished task
});

test('A7: coordinated run, fully published wave with pending tasks -> coordinate (halt local dispatch)', () => {
  // Both wave-1 tasks are in issue_map -> fully published. Tasks still pending locally.
  // coordinate must fire; never dispatch_wave.
  const s = base({
    coordination: {
      mode: 'github',
      current_wave: 1,
      issue_map: {
        '1': { issue: 10, pr: null, merge_sha: null, status: 'open' },
        '2': { issue: 11, pr: null, merge_sha: null, status: 'open' },
      },
    },
    tasks: [t(1, 1, 'pending', ['a.txt']), t(2, 1, 'pending', ['b.txt'])],
  });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'coordinate');
  assert.equal(d.wave, 1);
});

test('A7: ordering — publish_needed fires BEFORE coordinate (unpublished tasks present)', () => {
  // When there are both published and unpublished tasks, publish_needed fires first —
  // it takes priority over coordinate in the ordering.
  const s = base({
    coordination: {
      mode: 'github',
      current_wave: 2,
      issue_map: {
        '1': { issue: 10, pr: null, merge_sha: null, status: 'open' }, // wave 2, published
      },
    },
    tasks: [
      t(1, 2, 'pending', ['a.txt']), // published
      t(2, 2, 'pending', ['b.txt']), // unpublished → triggers publish_needed
    ],
  });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'publish_needed'); // NOT coordinate
});

test('A7: coordinated run with ALL tasks done -> complete (coordination gate not reached)', () => {
  // All tasks done -> pending.length === 0 -> early complete before the coordination gate.
  const s = base({
    coordination: { mode: 'github', current_wave: 1, issue_map: { '1': {} } },
    tasks: [t(1, 1, 'done', ['a.txt'])],
  });
  assert.equal(decideNextAction(s, {}).action, 'complete');
});

test('A7: coordinated run, done tasks in wave do not count as unpublished', () => {
  // Done tasks are filtered out of `pending` before the coordination gate is reached.
  // Only pending tasks that lack an issue_map entry are "unpublished".
  const s = base({
    coordination: {
      mode: 'github',
      current_wave: 1,
      issue_map: {
        '2': { issue: 11, pr: null, merge_sha: null, status: 'open' },
      },
    },
    tasks: [
      t(1, 1, 'done', ['a.txt']),    // done — not counted
      t(2, 1, 'pending', ['b.txt']), // pending + published -> coordinate
    ],
  });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'coordinate'); // not publish_needed, because task 2 is published
  assert.equal(d.wave, 1);
});

test('is pure: does not mutate the input state', () => {
  const s = base({ active_run: { run_id: 'wf_1', task_id: 'k1', wave: 1 }, tasks: [t(1, 1, 'pending', ['a'])] });
  const snapshot = JSON.stringify(s);
  decideNextAction(s, { alive: false });
  assert.equal(JSON.stringify(s), snapshot);
});

test('GUARD: a promoted active_run with a non-integer (null) wave throws — never silently finalizes', () => {
  // The HIGH regression: promote-active-run with no phase-1 launching marker wrote {wave:null,…};
  // the activeRun branch then computed incomplete=[] (null matches no integer-wave task) and
  // returned finalize_run while tasks were still pending — clearing the marker, orphaning the run.
  // The guard mirrors the dispatch-branch non-integer-wave guard: fail loud, don't finalize.
  const s = base({
    active_run: { run_id: 'wf_1', task_id: 'k1', wave: null },
    tasks: [t(1, 1, 'pending', ['a.txt'])],
  });
  assert.throws(() => decideNextAction(s, { alive: false }), /non-integer wave/);
});

// ---------------------------------------------------------------------------
// Blackboard-backed crash recovery (spec §5.5 handoff idempotency — Task 39)
// ---------------------------------------------------------------------------
//
// The dead-run-with-work-outstanding path consults `state.blackboard` (a map of the dead run's
// dispatch records keyed by the FULL handoff key) and resolves each incomplete task against its
// recorded result instead of blindly re-dispatching. The crash window is the MISMATCH between
// the two completion surfaces: every incomplete task is `pending` in state.yml (the L1
// record-result commit never ran) while the blackboard item status discriminates the recovery.

// Build a real adsp-idem-v1 handoff key so tests mirror the actual blackboard key shape: the
// record's map key IS the full composed handoff key (per the §5.5 REVIEW FIX).
function makeHandoffKey(taskId = 't1') {
  const specHash = computeTaskSpecHash({ body: { id: taskId, description: 'do thing', files: [`${taskId}.txt`] } });
  const fp = computeInputFingerprint({
    head: '0'.repeat(40),
    dirtyDigest: '',
    policyVersion: 'pv1',
    workerVersion: 'wv1',
  });
  return composeHandoffKey('run-x', taskId, specHash, fp);
}

// A task with a handoff_key for the blackboard-backed path.
function bt(id, wave, status, files, handoff_key) {
  return { ...t(id, wave, status, files), handoff_key };
}

// Blackboard map keyed by each record's handoff_key.
function bb(records) {
  const map = {};
  for (const r of records) map[r.handoff_key] = r;
  return map;
}

test("'result exists, commit missing' (blackboard done) -> REPLAY, no re-run: resetPaths empty, not in redispatch", () => {
  const key = makeHandoffKey('t1');
  const record = { handoff_key: key, status: 'done', result: { commit: 'abc123', patch: 'patch-digest' } };
  const task = bt('t1', 1, 'pending', ['t1.txt'], key);
  const s = base({ active_run: { run_id: 'run-x', task_id: 7, wave: 1 }, tasks: [task], blackboard: bb([record]) });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_from_blackboard');
  assert.equal(d.replay.length, 1);
  assert.equal(d.replay[0].task, task);
  assert.equal(d.replay[0].record, record);
  assert.deepEqual(d.redispatch, []);
  assert.deepEqual(d.refused, []);
  // Replayed task completed -> its file scope must NOT be reset (no re-run).
  assert.deepEqual(d.resetPaths, []);
  assert.equal(d.staleTaskId, 7);
  assert.equal(d.wave, 1);
});

test("'genuine re-dispatch needed' (pending/claimed/failed) -> REDISPATCH, not replay", () => {
  for (const status of ['pending', 'claimed', 'failed']) {
    const key = makeHandoffKey('t1');
    const record = { handoff_key: key, status };
    const task = bt('t1', 1, 'pending', ['t1.txt'], key);
    const s = base({ active_run: { run_id: 'run-x', task_id: 7, wave: 1 }, tasks: [task], blackboard: bb([record]) });
    const d = decideNextAction(s, { alive: false });
    assert.equal(d.action, 'recover_from_blackboard', `status=${status}`);
    assert.deepEqual(d.replay, [], `status=${status} must not replay`);
    assert.equal(d.redispatch.length, 1, `status=${status} must redispatch`);
    assert.deepEqual(d.refused, [], `status=${status} must not refuse`);
    // Genuine re-dispatch resets the declared file scope.
    assert.deepEqual(d.resetPaths, ['t1.txt'], `status=${status} resets scope`);
  }
});

test("no blackboard record for a task -> genuine re-dispatch (redispatch, empty reset of scope still applies)", () => {
  const key = makeHandoffKey('t1');
  const task = bt('t1', 1, 'pending', ['t1.txt'], key);
  // Blackboard map present but empty -> no record for this key.
  const s = base({ active_run: { run_id: 'run-x', task_id: 7, wave: 1 }, tasks: [task], blackboard: bb([]) });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_from_blackboard');
  assert.deepEqual(d.replay, []);
  assert.deepEqual(d.refused, []);
  assert.equal(d.redispatch.length, 1);
  assert.deepEqual(d.resetPaths, ['t1.txt']);
});

test('cancelled blackboard item -> claim REFUSED: not replayed, not re-dispatched, not reset', () => {
  const key = makeHandoffKey('t1');
  const record = { handoff_key: key, status: 'cancelled' };
  const task = bt('t1', 1, 'pending', ['t1.txt'], key);
  const s = base({ active_run: { run_id: 'run-x', task_id: 7, wave: 1 }, tasks: [task], blackboard: bb([record]) });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_from_blackboard');
  assert.equal(d.refused.length, 1);
  assert.equal(d.refused[0].task, task);
  assert.equal(d.refused[0].record, record);
  assert.deepEqual(d.replay, []);
  assert.deepEqual(d.redispatch, []);
  // A cancelled item is refused a claim -> not re-dispatched -> its scope is not reset.
  assert.deepEqual(d.resetPaths, []);
});

test('explicit blackboard state transitions are modelled: BLACKBOARD_STATES is exactly the spec set', () => {
  assert.deepEqual(BLACKBOARD_STATES, ['pending', 'claimed', 'done', 'failed', 'cancelled']);
});

test('mixed wave: replay + redispatch + refused partition independently; resetPaths only from redispatch', () => {
  const k1 = makeHandoffKey('t1');
  const k2 = makeHandoffKey('t2');
  const k3 = makeHandoffKey('t3');
  const k4 = makeHandoffKey('t4');
  const records = [
    { handoff_key: k1, status: 'done', result: { commit: 'c1' } },
    { handoff_key: k2, status: 'pending' },
    { handoff_key: k3, status: 'cancelled' },
    { handoff_key: k4, status: 'failed' },
  ];
  const tasks = [
    bt('t1', 1, 'pending', ['f1.txt'], k1), // done -> replay
    bt('t2', 1, 'pending', ['f2.txt'], k2), // pending -> redispatch
    bt('t3', 1, 'pending', ['f3.txt'], k3), // cancelled -> refused
    bt('t4', 1, 'pending', ['f4.txt'], k4), // failed -> redispatch (retry)
  ];
  const s = base({ active_run: { run_id: 'run-x', task_id: 7, wave: 1 }, tasks, blackboard: bb(records) });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_from_blackboard');
  assert.equal(d.replay.length, 1);
  assert.equal(d.replay[0].task.id, 't1');
  assert.equal(d.redispatch.length, 2);
  assert.deepEqual(d.redispatch.map((x) => x.id).sort(), ['t2', 't4']);
  assert.equal(d.refused.length, 1);
  assert.equal(d.refused[0].task.id, 't3');
  // resetPaths only from the genuinely re-dispatched tasks (t2, t4) — NOT replayed (t1) or refused (t3).
  assert.deepEqual(d.resetPaths.sort(), ['f2.txt', 'f4.txt']);
});

test('frozen dispatch record: a done record whose key no longer matches the task is NOT replayed (re-dispatch)', () => {
  // The task stored one key at dispatch time, but the blackboard record carries a different key
  // (corruption / a stale result for a changed spec/input). decideReuse rejects the mismatch and
  // the resume path re-dispatches rather than replaying a result that may belong to different work.
  const taskKey = makeHandoffKey('t1');
  const differentKey = makeHandoffKey('t1-different');
  const record = { handoff_key: differentKey, status: 'done', result: { commit: 'c1' } };
  const task = bt('t1', 1, 'pending', ['t1.txt'], taskKey);
  // The blackboard map is keyed by the record's own (mismatched) key; the task references taskKey,
  // so the lookup `blackboard[taskKey]` would miss — but to exercise the key-mismatch guard inside
  // decideReuse we instead key the map by taskKey and point it at the mismatched record.
  const map = { [taskKey]: record };
  const s = base({ active_run: { run_id: 'run-x', task_id: 7, wave: 1 }, tasks: [task], blackboard: map });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_from_blackboard');
  assert.deepEqual(d.replay, []);
  assert.equal(d.redispatch.length, 1);
});

test('unknown/corrupt blackboard status is treated as absent -> re-dispatch (§5.4 durability protocol)', () => {
  const key = makeHandoffKey('t1');
  const record = { handoff_key: key, status: 'corrupt-garbage' };
  const task = bt('t1', 1, 'pending', ['t1.txt'], key);
  const s = base({ active_run: { run_id: 'run-x', task_id: 7, wave: 1 }, tasks: [task], blackboard: bb([record]) });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_from_blackboard');
  assert.deepEqual(d.replay, []);
  assert.deepEqual(d.refused, []);
  assert.equal(d.redispatch.length, 1);
});

test('no blackboard map -> legacy recover_and_redispatch (byte-identical, A9)', () => {
  // No state.blackboard -> the seam falls back to the legacy path, byte-identical to pre-blackboard.
  const key = makeHandoffKey('t1');
  const task = bt('t1', 1, 'pending', ['t1.txt'], key);
  const s = base({ active_run: { run_id: 'run-x', task_id: 7, wave: 1 }, tasks: [task] });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_and_redispatch');
  assert.deepEqual(d.tasks, [task]);
  assert.deepEqual(d.resetPaths, ['t1.txt']);
  assert.equal(d.staleTaskId, 7);
});

test('task without a stored handoff_key -> genuine re-dispatch (no record to replay against)', () => {
  // A task with no handoff_key cannot be matched to a blackboard record -> re-dispatch.
  const task = t('t1', 1, 'pending', ['t1.txt']); // no handoff_key
  const s = base({ active_run: { run_id: 'run-x', task_id: 7, wave: 1 }, tasks: [task], blackboard: bb([]) });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_from_blackboard');
  assert.deepEqual(d.replay, []);
  assert.equal(d.redispatch.length, 1);
});

test('phase-1 active_run (no task_id) with blackboard -> resolveWithRecords path with staleTaskId null', () => {
  // Crashed at launch. With blackboard records present, phase-1 also resolves per-record.
  const key = makeHandoffKey('t1');
  const record = { handoff_key: key, status: 'done', result: { commit: 'c1' } };
  const task = bt('t1', 1, 'pending', ['t1.txt'], key);
  const s = base({ active_run: { run_id: 'run-x', wave: 1, phase: 'launching' }, tasks: [task], blackboard: bb([record]) });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'recover_from_blackboard');
  assert.equal(d.replay.length, 1);
  assert.equal(d.staleTaskId, null);
});

test('resolveWithRecords is pure: does not mutate state, tasks, or the blackboard map', () => {
  const key = makeHandoffKey('t1');
  const record = { handoff_key: key, status: 'done', result: { commit: 'c1' } };
  const task = bt('t1', 1, 'pending', ['t1.txt'], key);
  const s = base({ active_run: { run_id: 'run-x', task_id: 7, wave: 1 }, tasks: [task], blackboard: bb([record]) });
  const snapshot = structuredClone(s);
  decideNextAction(s, { alive: false });
  assert.deepEqual(s, snapshot);
});

test('handoff key shape: the blackboard map key is the full adsp-idem-v1 composed key', () => {
  const key = makeHandoffKey('t1');
  assert.ok(key.startsWith(`${IDEMPOTENCY_VERSION}:run-x:t1:`), 'key carries run_id + task_id');
  // The key has 5 colon-separated segments: version, run, task, spec_hash, fingerprint.
  assert.equal(key.split(':').length, 5);
});
