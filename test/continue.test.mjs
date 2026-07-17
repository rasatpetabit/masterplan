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

import { continueRun, dispatchPlanFanout } from '../lib/continue.mjs';
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

test('recover_and_redispatch: mixed in-WT + external-repo scope resets each repo with its own git (no "outside the repository")', () => {
  // A wave whose declared scope MIXES a relative in-worktree path with an ABSOLUTE path under a
  // DIFFERENT git repo (the external-repo task pattern, e.g. /srv/dev/ras/masterplan/...). The
  // phase-1 launching marker (no task_id) crashed before launch → recover_and_redispatch must
  // reset each repo with its own `git -C`, not funnel the external path through the worktree's
  // git (which rejects it as "outside the repository").
  const fx = makeFixture({
    slug: 't23ext',
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
  });
  // A separate git checkout (the external repo), not under MAIN.
  const EXT = path.join(fx.tmp, 'external');
  fs.mkdirSync(EXT, { recursive: true });
  git(EXT, 'init', '--initial-branch=main');
  git(EXT, 'config', 'user.email', 'test@test');
  git(EXT, 'config', 'user.name', 'test');
  git(EXT, 'config', 'commit.gpgsign', 'false');
  write(EXT, 'README.txt', 'base\n');
  git(EXT, 'add', '.');
  git(EXT, 'commit', '-q', '-m', 'initial');
  const extAbs = path.join(EXT, 'ext.mjs');
  // Rewrite the task + planIndex so files mix a relative in-WT path with the external absolute path.
  writeState(fx.statePath, {
    ...readState(fx.statePath),
    slug: 't23ext',
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt', extAbs] }],
    active_run: { wave: 1, phase: 'launching', scope: ['src/a.txt', extAbs], baseline: [] },
  });
  write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks: [planEntry(1, 1, ['src/a.txt', extAbs])] }));
  // Worktree + partial edits in BOTH repos (the dead foreground's leftover work).
  const WT = path.join(fx.MAIN, '.worktrees', 't23ext');
  git(fx.MAIN, 'worktree', 'add', '-q', '-b', 'masterplan/t23ext', WT);
  writeState(fx.statePath, { ...readState(fx.statePath), worktree: WT });
  write(WT, 'src/a.txt', 'half-finished\n'); // partial in-WT edit (untracked)
  write(EXT, 'ext.mjs', 'half-finished-external\n'); // partial external edit (untracked)

  // Phase-1 marker (no task_id) → no reap probe; straight to reset + re-dispatch.
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, alive: false });
  assert.equal(op.op, 'launch_workflow', 'reset + re-dispatch succeeds (no "outside the repository")');
  assert.equal(op.args.wave, 1);
  assert.equal(fs.existsSync(path.join(WT, 'src/a.txt')), false, 'in-WT partial cleaned by the worktree git');
  assert.equal(fs.existsSync(extAbs), false, 'external partial cleaned by the external repo git, not the worktree git');
  const marker = readState(fx.statePath).active_run;
  assert.equal(marker.phase, 'launching', 'fresh phase-1 marker re-issued');
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

test('review-mode derivation: nested state.review.adversary arms the wave (regression — the dispatch path once read only legacy codex.review)', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 't23rev',
    extra: { review: { adversary: true } },
  });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(op.op, 'launch_workflow');
  assert.equal(op.args.review, 'on', 'state.review.adversary=true must launch the wave review-armed');
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
  assert.equal(rel.op, 'dispatch_fanout');
  assert.equal(rel.kind, 'plan');
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

test('fabric strangler flag: continueRun emits a single dispatch_fabric op; record-result drives the same lifecycle', () => {
  const fx = makeFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 2, files: ['src/b.txt'] },
    ],
    planIndex: [planEntry(1, 1, ['src/a.txt']), planEntry(2, 2, ['src/b.txt'])],
    slug: 't38fab',
  });
  const base = { statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true };

  // 1. Single fabric op: routed tasks, frozen baseline, the record-result advisory.
  const op1 = continueRun(base);
  assert.equal(op1.op, 'dispatch_fabric');
  assert.equal(op1.wave, 1);
  assert.equal(op1.next, 'record-result');
  assert.deepEqual(op1.tasks.map((t) => t.id), [1]);
  assert.deepEqual(op1.baseline, []);
  assert.equal(op1.review, 'off');
  const WT = op1.cwd;
  assert.ok(fs.existsSync(path.join(WT, '.git')), 'worktree created');
  const marker = readState(fx.statePath).active_run;
  assert.equal(marker.phase, 'launching');
  assert.equal(marker.task_id, undefined, 'phase-1 marker only');

  // 2. The fabric's digests feed the SAME record transaction; next wave dispatches fabric again.
  write(WT, 'src/a.txt', 'A\n');
  const rec1 = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2000, result: { wave: 1, baseline: [], tasks: [digest(1, 'done')] } });
  assert.equal(rec1.outcome, 'recorded');
  const op2 = continueRun(base);
  assert.equal(op2.op, 'dispatch_fabric');
  assert.equal(op2.wave, 2);
  assert.equal(op2.cwd, WT, 'same worktree reused');
  write(WT, 'src/b.txt', 'B\n');
  recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2000, result: { wave: 2, baseline: [], tasks: [digest(2, 'done')] } });
  assert.deepEqual(continueRun(base), { op: 'run_skill', skill: 'finish' });

  // Flag off on the same-shaped bundle → the legacy launch_workflow path (rollback is a flag flip).
  const fx2 = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 't38leg',
  });
  const legacy = continueRun({ statePath: fx2.statePath, self: fx2.self, now: 2000 });
  assert.equal(legacy.op, 'launch_workflow');
});

test('awaiting_waiver: a blocked-only bundle surfaces the waiver gate, not decide-error / finish', async () => {
  const blockers = [{ id: 1, block_reason: 'no upstream API' }];
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'blocked', wave: 1, files: ['src/a.txt'], block_reason: 'no upstream API' }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'awaiting-waiver',
  });

  // Task 1 (lib/resume.mjs, concurrent same-wave) lands decideNextAction's `awaiting_waiver` arm;
  // it may not be on disk when this test runs. Probe the real decideNextAction: if it already emits
  // awaiting_waiver for blocked state, exercise the real path. If not, stub decideNextAction via
  // mock.module (Node 22.13+) against a fresh dynamic import of continue.mjs so the switch arm this
  // change adds is still covered. Post-wave-0 (all three tasks landed) the real decideNextAction
  // drives the assertion without any stub.
  const { decideNextAction: realDecide } = await import('../lib/resume.mjs');
  const realArm = realDecide(readState(fx.statePath), { alive: false });
  let run = continueRun;
  const { mock } = await import('node:test');
  const stubbed = realArm?.action !== 'awaiting_waiver' && typeof mock.module === 'function';
  if (stubbed) {
    await mock.module(new URL('../lib/resume.mjs', import.meta.url).href, () => ({
      decideNextAction: () => ({ action: 'awaiting_waiver', blockers }),
    }));
    run = (await import('../lib/continue.mjs?awaiting-waiver-stub=1')).continueRun;
  }

  const op = run({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'awaiting_waiver');
  assert.ok(Array.isArray(op.blockers) && op.blockers.length >= 1, 'blockers carried from decide');
  if (stubbed) assert.deepEqual(op.blockers, blockers);
  if (stubbed) mock.restoreAll();
});

// ---- the broker planning fan-out (task 5: planning-fanout) ----------------------

test('plan fan-out op: recover_plan_run emits the read-only dispatch_fanout planning op (the launch_workflow(plan) arm is retired)', () => {
  const fx = makeFixture({
    tasks: [],
    phase: 'plan',
    activeRun: { kind: 'plan', phase: 'launching' },
    slug: 't5op',
  });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(op.op, 'dispatch_fanout');
  assert.equal(op.kind, 'plan');
  assert.equal(op.read_only, true);
  assert.equal(op.class, 'masterplan-planning');
  assert.equal(op.next, 'stage-plan-fragments');
  // Explicitly enumerated accessible roots: the repo + the spec path (conventional
  // spec.md beside state.yml when state carries no spec_path).
  assert.ok(Array.isArray(op.roots) && op.roots.length === 2, 'enumerated roots: repo + spec');
  assert.equal(op.roots[0], op.cwd);
  assert.equal(op.roots[1], path.join(fx.bundleDir, 'spec.md'));
  assert.equal(op.spec_path, path.join(fx.bundleDir, 'spec.md'));
  assert.ok(!JSON.stringify(op).includes('launch_workflow'), 'no launch_workflow(plan) arm remains');
  // The fresh phase-1 plan marker is written durably BEFORE the op is returned.
  const marker = readState(fx.statePath).active_run;
  assert.equal(marker.kind, 'plan');
  assert.equal(marker.phase, 'launching');
});

test('plan fan-out executor: READ-ONLY work items through an injected broker; structured fragments returned for the shell to stage; no state written', async () => {
  const fx = makeFixture({
    tasks: [],
    phase: 'plan',
    activeRun: { kind: 'plan', phase: 'launching' },
    slug: 't5exec',
  });
  write(fx.bundleDir, 'spec.md', '# spec\n');
  const fragCore = { key: 'core', tasks: [{ key: 'core.one', description: 'd', files: ['a.js'], verify_commands: [] }] };
  const fragUi = { key: 'ui', tasks: [] };
  const sent = [];
  const broker = {
    async initialize() { throw new Error('executor must not initialize an injected client'); },
    close() { throw new Error('executor must not close an injected client'); },
    async callTool(name, args) {
      assert.equal(name, 'dispatch_fanout');
      assert.equal(args.fail_mode, 'isolated');
      sent.push(...args.descriptors);
      return {
        results: [
          { fragment: fragCore }, // structured payload
          { decision: { decision: 'route' }, stdout: 'drafting…\n' + JSON.stringify(fragUi) }, // worker-text payload
        ],
      };
    },
  };
  const res = await dispatchPlanFanout({
    statePath: fx.statePath,
    subsystems: [{ key: 'core', title: 'Core' }, { key: 'ui', description: 'the UI' }],
    _brokerClient: broker,
  });
  assert.equal(res.outcome, 'complete');
  assert.deepEqual(res.subsystems, [fragCore, fragUi], 'fragments come back as structured payloads (the shell stages .plan-fragments.json)');
  assert.deepEqual(res.requested, ['core', 'ui']);
  assert.deepEqual(res.denied, []);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.roots, [res.repoRoot, path.join(fx.bundleDir, 'spec.md')]);
  // READ-ONLY enforcement proven at the descriptor layer: the read-only class,
  // read_only:true, the enumerated roots — and NO write-scope fields at all
  // (files/repo/worktree are rejected by the broker validator on read-only lanes).
  assert.equal(sent.length, 2);
  for (const d of sent) {
    assert.equal(d.class, 'masterplan-planning');
    assert.equal(d.read_only, true);
    assert.deepEqual(d.roots, res.roots);
    assert.equal('files' in d, false, 'no write-scope field: files');
    assert.equal('repo' in d, false, 'no write-scope field: repo');
    assert.equal('worktree' in d, false, 'no write-scope field: worktree');
  }
  // The executor writes NO state (L1 stays the single durable writer): marker intact.
  assert.deepEqual(readState(fx.statePath).active_run, { kind: 'plan', phase: 'launching' });
});

test('NEGATIVE (a): a planner work item that attempts a write inside the enumerated roots is denied at the broker capability level — surfaced, never faked', async () => {
  const fx = makeFixture({
    tasks: [],
    phase: 'plan',
    activeRun: { kind: 'plan', phase: 'launching' },
    slug: 't5deny',
  });
  // The injected client MODELS the broker capability layer (never a live broker call):
  // write scope on a read-only class is refused at validation, and the 'evil' drafter's
  // runtime write attempt inside the roots is refused by the OS/broker-level write denial.
  const broker = {
    async callTool(_name, { descriptors }) {
      return {
        results: descriptors.map((d) => {
          if (d.files || d.repo || d.worktree) {
            return { denied: true, reason: `capability denial: write-scope field on read-only class '${d.class}'` };
          }
          if (d.subsystem === 'evil') {
            return { denied: true, reason: `write denied: drafter attempted to modify ${d.roots[0]}/src/hack.js inside the read-only roots (capability class '${d.class}')` };
          }
          if (d.subsystem === 'guarded') {
            return { decision: { decision: 'guard_deny', reason: 'write scope denied by guard on the read-only planning lane' } };
          }
          return { fragment: { key: d.subsystem, tasks: [] } };
        }),
      };
    },
  };
  const res = await dispatchPlanFanout({
    statePath: fx.statePath,
    subsystems: [{ key: 'good' }, { key: 'evil' }, { key: 'guarded' }],
    _brokerClient: broker,
  });
  assert.equal(res.outcome, 'incomplete');
  assert.deepEqual(res.subsystems.map((f) => f.key), ['good'], 'a denied drafter never yields a faked fragment');
  assert.deepEqual(res.denied.map((d) => d.key), ['evil', 'guarded']);
  assert.match(res.denied[0].reason, /write denied/);
  assert.match(res.denied[1].reason, /denied by guard/);
});

test('NEGATIVE (b): the pre/post git status --porcelain assertion trips loudly when a drafter dirties an enumerated root mid-fan-out — breach surfaced, fragments NOT returned for staging', async () => {
  const fx = makeFixture({
    tasks: [],
    phase: 'plan',
    activeRun: { kind: 'plan', phase: 'launching' },
    slug: 't5breach',
  });
  const broker = {
    async callTool() {
      // The fixture "drafter" writes INSIDE the enumerated repo root mid-fan-out …
      write(fx.MAIN, 'src/PWNED.txt', 'not read-only\n');
      // … and still returns a perfectly valid fragment, which must NOT surface.
      return { results: [{ fragment: { key: 'core', tasks: [] } }] };
    },
  };
  await assert.rejects(
    dispatchPlanFanout({ statePath: fx.statePath, subsystems: [{ key: 'core' }], _brokerClient: broker }),
    /READ-ONLY BREACH/,
    'the wave surfaces the breach instead of staging fragments',
  );
});

test('plan fan-out executor: a non-plan marker refuses loudly (never dispatches)', async () => {
  const fx = makeFixture({ tasks: [], phase: 'plan', slug: 't5nomarker' }); // active_run: null
  await assert.rejects(
    dispatchPlanFanout({
      statePath: fx.statePath,
      subsystems: [{ key: 'core' }],
      _brokerClient: { async callTool() { throw new Error('broker must not be called'); } },
    }),
    /plan marker/,
  );
});

// ---- legacy active_run marker reconciliation (task 6: marker-reconcile) ---------
//
// Pre-fabric bundles persisted L2 marker shapes: launch_workflow execute/plan kinds —
// phase-1 {phase:'launching'} markers and PROMOTED probe/reap-expected {run_id, task_id}
// markers. Under the fabric lane `mp continue` reconciles them: auto-convert to the
// equivalent fabric op where state.tasks + plan wave data re-derive the wave, else an
// explicit `legacy-marker-unreconcilable` ask with recovery guidance — never a crash,
// never silent. The fixtures are SANITIZED from the live fanout-durability and
// pi-intercom-usage bundle marker shapes (structural shape kept, content neutralized).

const loadLegacyFixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/legacy-markers/${name}`, import.meta.url), 'utf8'));

test('legacy reconcile (fixture: plan launching): the pre-fabric plan marker converts to the dispatch_fanout planning op', () => {
  const legacy = loadLegacyFixture('active-run-plan.json');
  const fx = makeFixture({
    tasks: legacy.tasks,
    phase: legacy.phase,
    activeRun: legacy.active_run,
    slug: 'lm-plan',
    extra: { planning_mode: legacy.planning_mode },
  });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true });
  assert.equal(op.op, 'dispatch_fanout');
  assert.equal(op.kind, 'plan');
  const marker = readState(fx.statePath).active_run;
  assert.equal(marker.kind, 'plan');
  assert.equal(marker.phase, 'launching');
});

test('legacy reconcile (fixture: fanout-durability shape): a PROMOTED plan marker skips the L2 probe and re-emits the fan-out; non-fabric still probes', () => {
  const legacy = loadLegacyFixture('active-run-fanout-durability.json');
  const fx = makeFixture({
    tasks: legacy.tasks,
    phase: legacy.phase,
    activeRun: legacy.active_run,
    slug: 'lm-fd',
    extra: { planning_mode: legacy.planning_mode },
  });
  // Non-fabric: the promoted marker still routes the L2 probe protocol (byte-identical legacy path).
  const probe = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(probe.op, 'probe');
  assert.equal(probe.kind, 'alive');
  assert.equal(probe.task_id, 'wf-legacy-0001');
  // Fabric: no probe machinery — the marker reconciles straight to the planning fan-out.
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true });
  assert.equal(op.op, 'dispatch_fanout');
  assert.equal(op.kind, 'plan');
  assert.equal(op.reconciled.legacy, 'plan-promoted');
  assert.equal(op.reconciled.conversion, 'plan-fanout');
  assert.deepEqual(op.reconciled.marker, legacy.active_run);
  const marker = readState(fx.statePath).active_run;
  assert.equal(marker.kind, 'plan');
  assert.equal(marker.phase, 'launching');
  assert.equal(marker.task_id, undefined, 'stale L2 handles dropped from the fresh phase-1 marker');
});

test('legacy reconcile (fixture: execute launching): outstanding work auto-converts to dispatch_fabric; non-fabric keeps launch_workflow un-annotated', () => {
  const legacy = loadLegacyFixture('active-run-execute-launching.json');
  const planIndex = legacy.tasks.map((t) => planEntry(t.id, t.wave, t.files));
  // Fabric: the stale launching marker recovers straight to the fabric wave op.
  const fx = makeFixture({
    tasks: structuredClone(legacy.tasks),
    phase: legacy.phase,
    activeRun: structuredClone(legacy.active_run),
    planIndex,
    slug: 'lm-exl',
  });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true });
  assert.equal(op.op, 'dispatch_fabric');
  assert.equal(op.wave, legacy.active_run.wave);
  assert.deepEqual(op.tasks.map((t) => t.id), [2]);
  assert.equal(op.reconciled.legacy, 'execute-launching');
  assert.equal(op.reconciled.conversion, 'redispatch');
  assert.deepEqual(op.reconciled.marker, legacy.active_run);
  const marker = readState(fx.statePath).active_run;
  assert.equal(marker.wave, legacy.active_run.wave);
  assert.equal(marker.phase, 'launching');
  // Non-fabric: byte-identical legacy behavior — launch_workflow, no `reconciled` annotation.
  const fx2 = makeFixture({
    tasks: structuredClone(legacy.tasks),
    phase: legacy.phase,
    activeRun: structuredClone(legacy.active_run),
    planIndex,
    slug: 'lm-exl2',
  });
  const op2 = continueRun({ statePath: fx2.statePath, self: fx2.self, now: 2000 });
  assert.equal(op2.op, 'launch_workflow');
  assert.equal('reconciled' in op2, false, 'legacy L2 path stays un-annotated');
});

test('legacy reconcile (fixture: pi-intercom shape): a stale finished-wave marker finalizes inline, then the next pending wave dispatches via fabric', () => {
  const legacy = loadLegacyFixture('active-run-pi-intercom.json');
  const fx = makeFixture({
    tasks: legacy.tasks,
    phase: legacy.phase,
    activeRun: legacy.active_run,
    planIndex: legacy.tasks.map((t) => planEntry(t.id, t.wave, t.files)),
    slug: 'lm-pi',
  });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true });
  assert.equal(op.op, 'dispatch_fabric');
  assert.equal(op.wave, 1, 'stale wave-3 marker finalized; the earlier pending wave dispatches');
  assert.deepEqual(op.tasks.map((t) => t.id), [2]);
  assert.equal(op.reconciled.legacy, 'execute-launching');
  assert.equal(op.reconciled.conversion, 'finalize');
  assert.deepEqual(op.reconciled.marker, legacy.active_run);
  const marker = readState(fx.statePath).active_run;
  assert.equal(marker.wave, 1, 'fresh phase-1 marker for the re-derived wave');
  assert.equal(marker.phase, 'launching');
});

test('legacy reconcile: a PROMOTED execute marker (probe/reap-expected) redispatches via fabric without any probe op; --alive=true still defers', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r-legacy', task_id: 'wf-legacy', scope: ['src/a.txt'], baseline: [] },
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'lm-prom',
  });
  // An explicit --alive=true is respected: the reconcile never yanks a run the caller asserts is live.
  const wait = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true, alive: true });
  assert.equal(wait.op, 'stop');
  assert.equal(wait.reason, 'wait');
  // Liveness unknown: no probe (the fabric shell has none) — straight to the fabric wave op.
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true });
  assert.equal(op.op, 'dispatch_fabric');
  assert.equal(op.wave, 1);
  assert.equal(op.reconciled.legacy, 'execute-promoted');
  assert.equal(op.reconciled.conversion, 'redispatch');
  const marker = readState(fx.statePath).active_run;
  assert.equal(marker.phase, 'launching');
  assert.equal(marker.task_id, undefined, 'stale L2 handles dropped from the fresh phase-1 marker');
});

test('legacy reconcile: unreconcilable markers surface the explicit ask with recovery guidance — never a crash, never silent', () => {
  // (a) A promoted marker with a non-integer wave (the corrupt promote shape).
  const fxA = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: null, run_id: 'r-legacy', task_id: 'wf-legacy' },
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'lm-badwave',
  });
  const a = continueRun({ statePath: fxA.statePath, self: fxA.self, now: 2000, fabricDispatch: true });
  assert.equal(a.op, 'ask');
  assert.equal(a.ask, 'legacy-marker-unreconcilable');
  assert.match(a.error, /not an integer/);
  assert.match(a.guidance, /clear-active-run/);
  assert.deepEqual(a.marker, { wave: null, run_id: 'r-legacy', task_id: 'wf-legacy' });

  // (b) A launching marker whose wave matches no task — the wave cannot be re-derived.
  const fxB = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 9, phase: 'launching', scope: [], baseline: [] },
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'lm-nowave',
  });
  const b = continueRun({ statePath: fxB.statePath, self: fxB.self, now: 2000, fabricDispatch: true });
  assert.equal(b.op, 'ask');
  assert.equal(b.ask, 'legacy-marker-unreconcilable');
  assert.match(b.error, /matches no task/);
  assert.match(b.guidance, /clear-active-run/);

  // (c) An unrecognized marker shape (neither plan kind nor integer wave nor task_id).
  const fxC = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { status: 'launching' },
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'lm-shape',
  });
  const c = continueRun({ statePath: fxC.statePath, self: fxC.self, now: 2000, fabricDispatch: true });
  assert.equal(c.op, 'ask');
  assert.equal(c.ask, 'legacy-marker-unreconcilable');
  assert.match(c.error, /unrecognized legacy shape/);
});

test('legacy reconcile: an open gate still wins — the gate surfaces and the legacy marker is left for later', () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    activeRun: { wave: 1, run_id: 'r-legacy', task_id: 'wf-legacy' },
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'lm-gate',
    extra: { pending_gate: { id: 'plan_approval', opened_at: 't' } },
  });
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true, alive: false });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'gate');
  assert.equal(op.gate.id, 'plan_approval');
  assert.deepEqual(
    readState(fx.statePath).active_run,
    { wave: 1, run_id: 'r-legacy', task_id: 'wf-legacy' },
    'marker untouched while the gate is open'
  );
});
