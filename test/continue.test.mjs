// test/continue.test.mjs — continueRun: the §2 trampoline in code (T2.3).
// REAL git in temp repos (the wave-commit.test.mjs pattern): the module's value is the exact
// interleaving of Guard D, durable state writes, and -C-qualified local git, so the tests
// exercise genuine MAIN+worktree pairs. The plan-mandated op-sequence test drives a seeded
// bundle through seed → launch → injected result → record → next wave → complete, plus the
// gate cases: owner-blocked, owner_lock=off, migrate-on-load, wave backfill, probe gating,
// and the inline finalize_run reconcile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { continueRun } from '../lib/continue.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';
import { goalsHash } from '../lib/goals.mjs';

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

// A MAIN repo (initial commit: src/seed.txt), a bundle with the given tasks/marker, and a
// plan.index.json beside it. NO worktree pre-created — ensureWorktree's create path is under test.
function makeFixture({ tasks, activeRun = null, phase = 'execute', planIndex, slug = 't23', extra = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-continue-'));
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
    phase,
    tasks,
    active_run: activeRun,
    ...extra,
  });
  if (planIndex) write(bundleDir, 'plan.index.json', JSON.stringify({ tasks: planIndex }));
  const self = buildOwnerIdentity({ host: 'h1', session: 'sess-A', slug, now: 1000 });
  return { tmp, MAIN, bundleDir, statePath, self };
}

const digest = (id, status) => ({
  task_id: id,
  digest: { task_id: id, status, files_changed: [], summary: '', blockers: [] },
  review: null,
});

test('op sequence: launch wave 1 → record → launch wave 2 → record → finish (the plan-mandated lifecycle)', () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 2, files: ['src/b.txt'] },
    ],
    planIndex: [planEntry(1, 1, ['src/a.txt']), planEntry(2, 2, ['src/b.txt'])],
  });
  const base = { statePath: fx.statePath, self: fx.self, now: 2000 };

  // 1. First continue: creates the worktree, writes the phase-1 marker, returns the launch op.
  const op1 = continueRun(base);
  assert.equal(op1.op, 'launch_workflow');
  assert.equal(op1.workflow, 'execute');
  assert.equal(op1.next, 'promote-active-run');
  assert.equal(op1.args.wave, 1);
  assert.deepEqual(op1.args.tasks.map((t) => t.id), [1]);
  assert.deepEqual(op1.args.baseline, []);
  assert.equal(op1.args.review, 'off');
  const WT = op1.cwd;
  assert.ok(fs.existsSync(path.join(WT, '.git')), 'worktree created');
  assert.equal(git(WT, 'rev-parse', '--abbrev-ref', 'HEAD'), 'masterplan/t23');
  let st = readState(fx.statePath);
  assert.equal(st.worktree, WT, 'worktree recorded durably');
  assert.deepEqual(st.active_run, { wave: 1, phase: 'launching', scope: ['src/a.txt'], baseline: [] });

  // 2. The L2 result lands; the shell records it (record_result is the result-in-hand protocol).
  write(WT, 'src/a.txt', 'A\n');
  const rec1 = recordWaveResult({ ...base, result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] } });
  assert.equal(rec1.outcome, 'recorded');
  assert.equal(rec1.cleared, true);
  assert.equal(rec1.next.action, 'dispatch_wave');
  assert.equal(rec1.next.wave, 2);

  // 3. Next continue: reuses the worktree (no second create) and launches wave 2.
  const op2 = continueRun(base);
  assert.equal(op2.op, 'launch_workflow');
  assert.equal(op2.args.wave, 2);
  assert.equal(op2.cwd, WT, 'same worktree reused');
  assert.deepEqual(op2.args.tasks.map((t) => t.id), [2]);
  assert.deepEqual(readState(fx.statePath).active_run.scope, ['src/b.txt']);

  // 4. Wave 2 records done → 5. final continue hands off to the finish flow (§2c stays prose until T2.4).
  write(WT, 'src/b.txt', 'B\n');
  const rec2 = recordWaveResult({ ...base, result: { wave: 2, baseline: [], tasks: [digest(2, 'done')] } });
  assert.equal(rec2.next.action, 'complete');
  assert.deepEqual(continueRun(base), { op: 'run_skill', skill: 'finish' });
});

test('Guard D: a live concurrent owner blocks; --force steals; owner_lock=off skips the sentinel entirely', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
  });
  const incumbent = buildOwnerIdentity({ host: 'h1', session: 'sess-INCUMBENT', slug: 't23', now: 1000 });
  assert.equal(acquireOwner(fx.bundleDir, incumbent, { now: 1000 }).outcome, 'acquire');

  const blocked = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(blocked.op, 'ask');
  assert.equal(blocked.ask, 'owner-blocked');
  assert.ok(blocked.incumbent);

  // force is the explicit user-approved steal — proceeds to the launch op.
  const stolen = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, force: true });
  assert.equal(stolen.op, 'launch_workflow');

  // Guard D on + no identity → loud throw, never a silent unguarded run.
  assert.throws(() => continueRun({ statePath: fx.statePath, self: null, now: 2000 }), /owner identity required/);

  // The seeded escape hatch: owner_lock=off ⇒ no identity needed, no sentinel touched.
  const fx2 = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 't23off',
    extra: { concurrency: { owner_lock: 'off' } },
  });
  const op = continueRun({ statePath: fx2.statePath, self: null, now: 2000 });
  assert.equal(op.op, 'launch_workflow');
  assert.equal(fs.existsSync(path.join(fx2.bundleDir, '.owner.lock')), false, 'sentinel never created');
});

test('probe gating: a promoted marker with liveness unknown → probe op; alive → stop/wait; dead+done → inline finalize → finish', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
  });
  // Worktree must exist for the reconcile leg below.
  const WT = path.join(fx.MAIN, '.worktrees', 't23');
  git(fx.MAIN, 'worktree', 'add', '-q', '-b', 'masterplan/t23', WT);
  writeState(fx.statePath, { ...readState(fx.statePath), worktree: WT });
  const base = { statePath: fx.statePath, self: fx.self, now: 2000 };

  const probe = continueRun(base); // alive omitted = unknown
  assert.deepEqual(probe, { op: 'probe', kind: 'alive', task_id: 'wf1', run_id: 'r1' });

  const wait = continueRun({ ...base, alive: true });
  assert.equal(wait.op, 'stop');
  assert.equal(wait.reason, 'wait');

  // Dead with the wave's tasks all done: the finalize_run row runs INLINE (reconcile mode),
  // clears the marker, and the loop re-decides to the next op in the SAME call.
  write(WT, 'src/a.txt', 'A\n'); // stranded in-scope work the reconcile must commit
  const op = continueRun({ ...base, alive: false });
  assert.deepEqual(op, { op: 'run_skill', skill: 'finish' });
  assert.equal(readState(fx.statePath).active_run, null, 'marker cleared by the inline reconcile');
  const codeFiles = git(WT, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.deepEqual(codeFiles, ['src/a.txt'], 'stranded work committed by the inline reconcile');
});

test('recover_and_redispatch: dead run with work outstanding → reap probe first, then scope reset + re-launch', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r1', task_id: 'wf1', scope: ['src/a.txt'], baseline: [] },
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
  });
  const WT = path.join(fx.MAIN, '.worktrees', 't23');
  git(fx.MAIN, 'worktree', 'add', '-q', '-b', 'masterplan/t23', WT);
  writeState(fx.statePath, { ...readState(fx.statePath), worktree: WT });
  write(WT, 'src/a.txt', 'half-finished\n'); // the dead run's partial edit
  const base = { statePath: fx.statePath, self: fx.self, now: 2000, alive: false };

  // staleTaskId present and not yet reconciled → the shell must TaskStop/reap first.
  const reap = continueRun(base);
  assert.deepEqual(reap, { op: 'probe', kind: 'reap', task_id: 'wf1' });

  // Reaped → scope reset (the partial edit is cleaned) + fresh phase-1 marker + re-launch.
  const op = continueRun({ ...base, staleReconciled: true });
  assert.equal(op.op, 'launch_workflow');
  assert.equal(op.args.wave, 1);
  assert.equal(fs.existsSync(path.join(WT, 'src/a.txt')), false, 'partial edit reset before re-dispatch');
  const marker = readState(fx.statePath).active_run;
  assert.equal(marker.phase, 'launching');
  assert.equal(marker.task_id, undefined, 'fresh phase-1 marker, not the stale promoted one');
});

test('wave backfill: wave:null tasks are durably backfilled from plan.index.json; absent index → ask', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: null, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
  });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(op.op, 'launch_workflow', 'backfill then dispatch in one call');
  assert.equal(readState(fx.statePath).tasks[0].wave, 1, 'backfill is durable');

  const fx2 = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: null, files: ['src/a.txt'] }],
    slug: 't23nofix', // no planIndex written
  });
  const ask = continueRun({ statePath: fx2.statePath, self: fx2.self, now: 2000 });
  assert.equal(ask.op, 'ask');
  assert.equal(ask.ask, 'waves-unbackfillable');
});

test('migrate-on-load: a legacy 5.x bundle is backed up, migrated, written through the CD-7 writer', () => {
  const legacy = fs.readFileSync(new URL('./fixtures/legacy-bundles/5.0-inflight-sample.yml', import.meta.url), 'utf8');
  const fx = makeFixture({ tasks: [], slug: 't23legacy' });
  fs.writeFileSync(fx.statePath, legacy); // overwrite with the raw legacy bundle

  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  // The in-flight sample has tasks with no waves and no plan.index.json → the backfill ask,
  // but the migration itself already happened durably.
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'waves-unbackfillable');
  assert.ok(fs.existsSync(`${fx.statePath}.v5.0.bak`), 'pre-migration backup written');
  assert.equal(readState(fx.statePath).schema_version, 8, 'migrated state written through writeState');
});

test('lifecycle handoffs: pending gate → ask gate; brainstorm phase → run_skill resume-phase', () => {
  const fx = makeFixture({
    tasks: [],
    phase: 'brainstorm',
    extra: { pending_gate: null },
  });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(op.op, 'run_skill');
  assert.equal(op.skill, 'resume-phase');
  assert.equal(op.phase, 'brainstorm');

  writeState(fx.statePath, { ...readState(fx.statePath), pending_gate: { id: 'spec_approval', opened_at: 't' } });
  const gate = continueRun({ statePath: fx.statePath, self: fx.self, now: 3000 });
  assert.equal(gate.op, 'ask');
  assert.equal(gate.ask, 'gate');
  assert.equal(gate.gate.id, 'spec_approval');
});

test('dispatch guards: missing plan.index at dispatch, and prepareWave drift, surface as ask dispatch-error', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    // no planIndex → tasks have integer waves (no backfill), but dispatch can't resolve routing
  });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'dispatch-error');
  assert.match(op.error, /plan\.index\.json not found/);

  // Divergent file sets (plan vs state) → prepareWave's loud throw, surfaced as the same ask.
  const fx2 = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/OTHER.txt'])],
    slug: 't23drift',
  });
  const op2 = continueRun({ statePath: fx2.statePath, self: fx2.self, now: 2000 });
  assert.equal(op2.ask, 'dispatch-error');
  assert.match(op2.error, /divergent file sets/);
});

test('codex-suppressed (Residual 3B): waves dispatch as dispatch_foreground; record-result drives the same lifecycle', () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 2, files: ['src/b.txt'] },
    ],
    planIndex: [planEntry(1, 1, ['src/a.txt']), planEntry(2, 2, ['src/b.txt'])],
    slug: 't25fg',
  });
  const base = { statePath: fx.statePath, self: fx.self, now: 2000, codexSuppressed: true };

  // 1. Foreground op — routed tasks, frozen baseline, the record-result advisory. No promote handle:
  //    there is no background task, so no task_id ever lands on the marker.
  const op1 = continueRun(base);
  assert.equal(op1.op, 'dispatch_foreground');
  assert.equal(op1.wave, 1);
  assert.equal(op1.next, 'record-result');
  assert.deepEqual(op1.tasks.map((t) => t.id), [1]);
  assert.deepEqual(op1.baseline, []);
  assert.equal(op1.review, 'off');
  const WT = op1.cwd;
  assert.ok(fs.existsSync(path.join(WT, '.git')), 'worktree created');
  const marker = readState(fx.statePath).active_run;
  assert.equal(marker.phase, 'launching');
  assert.equal(marker.task_id, undefined, 'phase-1 marker only — nothing to probe');

  // 2. A crash mid-foreground resumes through recover_and_redispatch and re-emits the SAME op
  //    (no reap probe — no task_id means no background run to stop).
  const again = continueRun(base);
  assert.equal(again.op, 'dispatch_foreground');
  assert.equal(again.wave, 1);

  // 3. The host's sequential digests feed the standard record transaction, and the next continue
  //    dispatches wave 2 foreground; the final continue hands to finish — identical lifecycle.
  write(WT, 'src/a.txt', 'A\n');
  const rec1 = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2000, result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] } });
  assert.equal(rec1.outcome, 'recorded');
  const op2 = continueRun(base);
  assert.equal(op2.op, 'dispatch_foreground');
  assert.equal(op2.wave, 2);
  assert.equal(op2.cwd, WT, 'same worktree reused');
  write(WT, 'src/b.txt', 'B\n');
  recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2000, result: { wave: 2, baseline: [], tasks: [digest(2, 'done')] } });
  assert.deepEqual(continueRun(base), { op: 'run_skill', skill: 'finish' });

  // Suppression off on the SAME bundle → the background path again (the flag is per-invocation,
  // never persisted): a fresh wave-2-style fixture isn't needed — assert via a new pending task.
  const fx2 = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 't25bg',
  });
  const bg = continueRun({ statePath: fx2.statePath, self: fx2.self, now: 2000, codexSuppressed: false });
  assert.equal(bg.op, 'launch_workflow');
});

test('codex-suppressed planning (Codex r6 P2): serial forced on resume_phase; plan-run recovery reroutes to serial instead of launch_workflow', () => {
  // (a) Fresh plan-phase entry: the resume-phase op must carry planning_mode 'serial' under
  // suppression regardless of the seeded mode — the plan fan-out needs the Workflow tool.
  const fx = makeFixture({
    tasks: [],
    phase: 'plan',
    slug: 't25plan',
    extra: { planning_mode: 'auto' },
  });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, codexSuppressed: true });
  assert.equal(op.op, 'run_skill');
  assert.equal(op.skill, 'resume-phase');
  assert.equal(op.phase, 'plan');
  assert.equal(op.planning_mode, 'serial');
  // Unsuppressed, the seeded mode passes through untouched.
  const cc = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(cc.planning_mode, 'auto');

  // (b) Cross-host resume of a CC-launched plan fan-out: a suppressed host can't relaunch the
  // workflow — the marker is dropped and §3a's serial path takes over.
  const fx2 = makeFixture({
    tasks: [],
    phase: 'plan',
    activeRun: { kind: 'plan', phase: 'launching' },
    slug: 't25prec',
  });
  const rec = continueRun({ statePath: fx2.statePath, self: fx2.self, now: 2000, codexSuppressed: true });
  assert.equal(rec.op, 'run_skill');
  assert.equal(rec.skill, 'resume-phase');
  assert.equal(rec.planning_mode, 'serial');
  assert.equal(readState(fx2.statePath).active_run, null, 'plan marker dropped durably');
  // Unsuppressed recovery still relaunches the fan-out.
  const fx3 = makeFixture({
    tasks: [],
    phase: 'plan',
    activeRun: { kind: 'plan', phase: 'launching' },
    slug: 't25prel',
  });
  const rel = continueRun({ statePath: fx3.statePath, self: fx3.self, now: 2000 });
  assert.equal(rel.op, 'launch_workflow');
  assert.equal(rel.workflow, 'plan');
});

const GOALS_MD = 'topic: Track goals\n\n## G1: Do the thing\nsignal: test\nevidence: it works\n';

test('goals split-brain guard: matching goals.md hash proceeds; mismatch hard-errors; no-event and pre-feature bundles are exempt', () => {
  const frozenHash = goalsHash(GOALS_MD);

  // (a) goals_enabled + goals.md matches the last goals_frozen event → normal dispatch.
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'gsb-match',
    extra: { goals_enabled: true },
  });
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), GOALS_MD);
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'),
    JSON.stringify({ type: 'goals_frozen', ts: 't', goals_hash: frozenHash }) + '\n');
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(op.op, 'launch_workflow', 'matching hash proceeds to dispatch');

  // (b) goals.md edited after freeze → hash diverges → hard error surfaced as a thrown Error.
  const fx2 = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'gsb-mismatch',
    extra: { goals_enabled: true },
  });
  fs.writeFileSync(path.join(fx2.bundleDir, 'goals.md'), GOALS_MD + '\n## G2: Another\nsignal: command\n');
  fs.writeFileSync(path.join(fx2.bundleDir, 'events.jsonl'),
    JSON.stringify({ type: 'goals_frozen', ts: 't', goals_hash: frozenHash }) + '\n');
  assert.throws(
    () => continueRun({ statePath: fx2.statePath, self: fx2.self, now: 2000 }),
    /goals split-brain/,
    'divergent goals.md hard-errors');

  // (c) goal_amended is the LAST event — its new hash is authoritative (frozen stale, amended matches).
  const amendedMd = GOALS_MD + '\n## G2: Another\nsignal: command\n';
  const amendedHash = goalsHash(amendedMd);
  const fx3 = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'gsb-amended',
    extra: { goals_enabled: true },
  });
  fs.writeFileSync(path.join(fx3.bundleDir, 'goals.md'), amendedMd);
  fs.writeFileSync(path.join(fx3.bundleDir, 'events.jsonl'),
    JSON.stringify({ type: 'goals_frozen', ts: 't1', goals_hash: frozenHash }) + '\n'
    + JSON.stringify({ type: 'goal_amended', ts: 't2', new_hash: amendedHash }) + '\n');
  const op3 = continueRun({ statePath: fx3.statePath, self: fx3.self, now: 2000 });
  assert.equal(op3.op, 'launch_workflow', 'latest goal_amended new hash is authoritative');

  // (d) goals_enabled but NO goal-lifecycle event yet → no-op (run_goals_capture owns this window).
  const fx4 = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'gsb-precapture',
    extra: { goals_enabled: true },
  });
  fs.writeFileSync(path.join(fx4.bundleDir, 'goals.md'), GOALS_MD + '\nedited freely\n');
  const op4 = continueRun({ statePath: fx4.statePath, self: fx4.self, now: 2000 });
  assert.equal(op4.op, 'launch_workflow', 'pre-capture window is a no-op');

  // (e) pre-feature bundle (no goals_enabled) is exempt even with a mismatching goals.md + event.
  const fx5 = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'gsb-prefeature',
  });
  fs.writeFileSync(path.join(fx5.bundleDir, 'goals.md'), GOALS_MD + '\ndrifted\n');
  fs.writeFileSync(path.join(fx5.bundleDir, 'events.jsonl'),
    JSON.stringify({ type: 'goals_frozen', ts: 't', goals_hash: frozenHash }) + '\n');
  const op5 = continueRun({ statePath: fx5.statePath, self: fx5.self, now: 2000 });
  assert.equal(op5.op, 'launch_workflow', 'pre-feature bundle exempt from the guard');
});
