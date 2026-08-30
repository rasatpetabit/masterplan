// test/resume.test.mjs — exhaustive branch coverage for the L1 control-loop core.
// decideNextAction is PURE (no I/O, no LLM), so every branch is asserted directly here.
// Grounding for the contract: docs/spike-0.5-findings.md (deltas D1, D2, D5; findings F2/F3/F6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decideNextAction, classifyLegacyMarker } from '../lib/resume.mjs';

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
  assert.equal(d.action, 'recover_wave');
  assert.equal(d.wave, 2);
  assert.deepEqual(d.tasks.map((x) => x.id), [2]);
  assert.deepEqual(d.resetPaths, ['b.txt', 'c.txt']);
  assert.equal(d.staleTaskId, 'k1'); // the shell reconciles (TaskList/TaskStop) before reset+redispatch
});

test('missing liveness while active run set (has task_id) -> treated as dead -> recover, staleTaskId carried', () => {
  const run = { run_id: 'wf_1', task_id: 'k1', wave: 1 };
  const s = base({ active_run: run, tasks: [t(1, 1, 'pending', ['a.txt'])] });
  const d = decideNextAction(s);
  assert.equal(d.action, 'recover_wave');
  assert.equal(d.staleTaskId, 'k1');
});

test('active_run phase-1 (launching, NO task_id) -> recover, staleTaskId null (crashed in the launch gap)', () => {
  // The marker is written {wave, phase:'launching'} BEFORE launch returns a task_id. A crash here
  // has no task to probe and nothing to reconcile (no task_id), so reset+redispatch is safe and
  // prevents a double-dispatch onto a Workflow that may or may not have actually started.
  const s = base({ active_run: { wave: 2, phase: 'launching' }, tasks: [t(1, 1, 'done'), t(2, 2, 'pending', ['b.txt'])] });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'recover_wave');
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
// Blocked-task dispatch exclusion (D1/D2) — blocked tasks are not dispatchable
// ---------------------------------------------------------------------------

test('G1: an entirely-blocked wave is SKIPPED — next runnable wave dispatched, never the blocked one', () => {
  // Blocked tasks are excluded from the dispatchable set, so a wave made up entirely of
  // blocked tasks is skipped: decideNextAction dispatches the next wave with pending work.
  const s = base({
    tasks: [t(1, 1, 'blocked', ['a.txt']), t(2, 2, 'pending', ['b.txt'])],
  });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'dispatch_wave');
  assert.equal(d.wave, 2);
  assert.deepEqual(d.tasks.map((x) => x.id), [2]);
});

test('G2: only blocked tasks remain (no dispatchable work) -> awaiting_waiver, never complete', () => {
  // Every non-done task is blocked -> pending.length===0 (blocked excluded from dispatchable),
  // but the bundle is NOT complete: it is awaiting a waiver. The blockers-before-complete guard
  // (D2) fires before the `complete` return.
  const s = base({ tasks: [t(1, 1, 'done', ['a.txt']), t(2, 2, 'blocked', ['b.txt'])] });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'awaiting_waiver');
  assert.deepEqual(d.blockers.map((x) => x.id), [2]);
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
  // The HIGH regression: promote-run with no phase-1 launching marker wrote {wave:null,…};
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
// Dead-run recovery — only executable recovery actions
// ---------------------------------------------------------------------------
//
// Recovery is derived from disk state alone. There is no blackboard-backed
// replay path (the old record-replay action had no handler in the continue
// loop and could only surface as a decide-error). A dead run with work
// outstanding ALWAYS resumes via `recover_wave` — reset the incomplete
// wave's declared file scope and re-dispatch. A dead run whose wave is
// complete finalizes; a live run waits. These are the only three outcomes.

test('dead run with work outstanding -> recover_wave: resets only the wave\'s incomplete file scope', () => {
  const run = { run_id: 'run-x', task_id: 7, wave: 1 };
  const s = base({
    active_run: run,
    tasks: [
      t(1, 1, 'done', ['a.txt']),
      t(2, 1, 'pending', ['b.txt', 'c.txt']),
    ],
  });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_wave');
  assert.equal(d.wave, 1);
  assert.deepEqual(d.tasks, [t(2, 1, 'pending', ['b.txt', 'c.txt'])]);
  assert.deepEqual(d.resetPaths.sort(), ['b.txt', 'c.txt']);
  assert.equal(d.staleTaskId, 7);
});

test('dead run, all wave tasks done -> finalize_run (never re-dispatch completed work)', () => {
  const run = { run_id: 'run-x', task_id: 7, wave: 1 };
  const s = base({ active_run: run, tasks: [t(1, 1, 'done', ['a.txt']), t(2, 1, 'done', ['b.txt'])] });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'finalize_run');
  assert.deepEqual(d.run, run);
});

test('live run -> wait (never second-guess a promoted run)', () => {
  const run = { run_id: 'run-x', task_id: 7, wave: 1 };
  const s = base({ active_run: run, tasks: [t(1, 1, 'pending', ['a.txt'])] });
  const d = decideNextAction(s, { alive: true });
  assert.equal(d.action, 'wait');
  assert.deepEqual(d.run, run);
});

test('phase-1 active_run (crashed at launch, no task_id) -> recover_wave with null staleTaskId', () => {
  const s = base({ active_run: { run_id: 'run-x', wave: 1, phase: 'launching' }, tasks: [t(1, 1, 'pending', ['a.txt'])] });
  const d = decideNextAction(s, {});
  assert.equal(d.action, 'recover_wave');
  assert.equal(d.wave, 1);
  assert.deepEqual(d.resetPaths, ['a.txt']);
  assert.equal(d.staleTaskId, null);
});

test('recover_wave respects blocked/waived tasks: they are not re-dispatched, not reset', () => {
  const run = { run_id: 'run-x', task_id: 7, wave: 1 };
  const s = base({
    active_run: run,
    tasks: [
      t(1, 1, 'pending', ['a.txt']),
      t(2, 1, 'blocked', ['b.txt']),
      t(3, 1, 'waived', ['c.txt']),
    ],
  });
  const d = decideNextAction(s, { alive: false });
  assert.equal(d.action, 'recover_wave');
  assert.deepEqual(d.tasks.map((x) => x.id), [1]);
  assert.deepEqual(d.resetPaths, ['a.txt']);
});

test('recover is pure: decideNextAction does not mutate the input state', () => {
  const run = { run_id: 'run-x', task_id: 7, wave: 1 };
  const s = base({ active_run: run, tasks: [t(1, 1, 'pending', ['a.txt'])] });
  const snapshot = structuredClone(s);
  decideNextAction(s, { alive: false });
  assert.deepEqual(s, snapshot);
});

// ---------------------------------------------------------------------------
// Legacy active_run marker classification (marker-reconcile) — pure shape
// classifier for the pre-fabric L2 marker DATA the fabric continue path upgrades.
// ---------------------------------------------------------------------------

const legacyFixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/legacy-markers/${name}`, import.meta.url), 'utf8'));

test('classifyLegacyMarker: null/absent/non-object markers -> null (nothing to reconcile)', () => {
  assert.equal(classifyLegacyMarker(null), null);
  assert.equal(classifyLegacyMarker(undefined), null);
  assert.equal(classifyLegacyMarker('launching'), null);
  assert.equal(classifyLegacyMarker(7), null);
  assert.equal(classifyLegacyMarker([{ wave: 1 }]), null);
});

test('classifyLegacyMarker: plan markers — phase-1 launching vs PROMOTED (probe-expected)', () => {
  assert.deepEqual(classifyLegacyMarker({ kind: 'plan', phase: 'launching' }), { legacy: 'plan-launching' });
  assert.deepEqual(
    classifyLegacyMarker({ kind: 'plan', run_id: 'r1', task_id: 'wf1' }),
    { legacy: 'plan-promoted', staleTaskId: 'wf1' }
  );
});

test('classifyLegacyMarker: execute markers — PROMOTED (probe/reap-expected) carries wave + staleTaskId; launching carries wave', () => {
  assert.deepEqual(
    classifyLegacyMarker({ wave: 3, run_id: 'r1', task_id: 'wf1', scope: [], baseline: [] }),
    { legacy: 'execute-promoted', wave: 3, staleTaskId: 'wf1' }
  );
  assert.deepEqual(
    classifyLegacyMarker({ wave: 6, phase: 'launching', scope: [], baseline: ['docs/a.md'] }),
    { legacy: 'execute-launching', wave: 6 }
  );
  // A promoted marker with a corrupt wave still classifies (the consumer decides reconcilability).
  assert.deepEqual(
    classifyLegacyMarker({ wave: null, run_id: 'r1', task_id: 'wf1' }),
    { legacy: 'execute-promoted', wave: null, staleTaskId: 'wf1' }
  );
});

test('classifyLegacyMarker: corrupt/unknown shapes classify as unrecognized — never throw', () => {
  assert.deepEqual(classifyLegacyMarker({}), { legacy: 'unrecognized', wave: null });
  assert.deepEqual(classifyLegacyMarker({ status: 'launching' }), { legacy: 'unrecognized', wave: null });
  assert.deepEqual(classifyLegacyMarker({ wave: null, phase: 'launching' }), { legacy: 'unrecognized', wave: null });
  assert.deepEqual(classifyLegacyMarker({ wave: 2.5 }), { legacy: 'unrecognized', wave: 2.5 });
  assert.deepEqual(classifyLegacyMarker({ wave: '3', phase: 'launching' }), { legacy: 'unrecognized', wave: '3' });
});

test('classifyLegacyMarker: the sanitized legacy fixtures classify to their expected shapes', () => {
  const shape = (name) => classifyLegacyMarker(legacyFixture(name).active_run);
  assert.deepEqual(shape('active-run-plan.json'), { legacy: 'plan-launching' });
  assert.deepEqual(
    shape('active-run-fanout-durability.json'),
    { legacy: 'plan-promoted', staleTaskId: 'wf-legacy-0001' }
  );
  assert.deepEqual(shape('active-run-execute-launching.json'), { legacy: 'execute-launching', wave: 2 });
  assert.deepEqual(shape('active-run-pi-intercom.json'), { legacy: 'execute-launching', wave: 3 });
});

test('classifyLegacyMarker is pure: does not mutate the marker', () => {
  const marker = { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['a.txt'], baseline: [] };
  const snapshot = structuredClone(marker);
  classifyLegacyMarker(marker);
  assert.deepEqual(marker, snapshot);
});
