// test/bin-masterplan.test.mjs — the L1 deterministic adapter's CLI contract (build step 2).
// Unit-tests the two exported helpers directly; integration-tests every subcommand by spawning the
// real CLI over temp bundles (the contract the markdown shell depends on). bin is fs-only: no git
// here. Results land on stdout; errors exit non-zero with a stderr hint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatBanner, applyPlanIndex, readPluginVersion } from '../bin/masterplan.mjs';
import { serializeState, parseState } from '../lib/bundle.mjs';
import { createHash } from 'node:crypto';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/legacy-bundles/5.0-inflight-sample.yml', import.meta.url));

function run(args, opts = {}) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', ...opts }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function tmpBundle(stateObj) {
  const p = path.join(tmpDir('mp-bin-'), 'state.yml');
  fs.writeFileSync(p, serializeState(stateObj));
  return p;
}
const read = (p) => parseState(fs.readFileSync(p, 'utf8'));
const v8 = (over = {}) => ({
  schema_version: '6.0', slug: 'demo', pending_gate: null, active_run: null,
  tasks: [
    { id: 1, status: 'pending', wave: 0, files: ['a.txt'] },
    { id: 2, status: 'pending', wave: 1, files: ['b.txt'] },
  ],
  ...over,
});

// ---- unit: the two exported helpers (logic is in lib; these are the bin-local formatters) ----
test('formatBanner: version + args + cwd', () => {
  assert.equal(formatBanner('1.2.3', 'doctor --fix', '/x'), "→ /masterplan v1.2.3 args: 'doctor --fix' cwd: /x");
});
test('formatBanner: no version -> vUNKNOWN; empty args -> (empty)', () => {
  assert.equal(formatBanner(null, '', '/x'), "→ /masterplan vUNKNOWN args: '(empty)' cwd: /x");
});
test('readPluginVersion: CLAUDE_PLUGIN_ROOT (the loaded plugin) wins over marketplace-name-specific paths', () => {
  // regression: a registry swap under a non-canonical marketplace name (masterplan-v8 scoped deploy)
  // must still report the RUNNING version, not fall back to a stale same-named rasatpetabit clone.
  const root = tmpDir('mp-root-');
  fs.mkdirSync(path.join(root, '.claude-plugin'));
  fs.writeFileSync(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ version: '9.9.9' }));
  assert.equal(readPluginVersion('/nonexistent', { CLAUDE_PLUGIN_ROOT: root }), '9.9.9');
});
test('applyPlanIndex: sets wave+files by id; parallel_group->wave; {tasks:[]} & bare-array; unmatched untouched', () => {
  const state = { tasks: [
    { id: 1, status: 'pending', wave: null, files: [] },
    { id: 2, status: 'done', wave: null, files: [] },
    { id: 3, status: 'pending', wave: null, files: [] },
  ] };
  const r = applyPlanIndex(state, { tasks: [{ id: 1, wave: 0, files: ['a'] }, { id: 2, parallel_group: 1, files: ['b'] }] });
  assert.equal(r.tasks[0].wave, 0);
  assert.deepEqual(r.tasks[0].files, ['a']);
  assert.equal(r.tasks[1].wave, 1); // parallel_group -> wave
  assert.equal(r.tasks[2].wave, null); // unmatched task left untouched
  assert.equal(applyPlanIndex(state, [{ id: 3, wave: 5, files: ['c'] }]).tasks[2].wave, 5); // bare array
});

// ---- integration: version + host detection ----
test('version: emits the CC-2 banner (the lone CC-2/CC-3 survivor)', () => {
  const r = run(['version', '--args=doctor', '--cwd=/repo/x']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^→ \/masterplan v.+ args: 'doctor' cwd: \/repo\/x/);
});
test('detect-host: codex signal -> isCodex + suppressRescue; none -> both false', () => {
  const yes = JSON.parse(run(['detect-host', '--agent-is-codex']).stdout);
  assert.equal(yes.isCodex, true);
  assert.equal(yes.suppressRescue, true);
  const no = JSON.parse(run(['detect-host']).stdout);
  assert.equal(no.isCodex, false);
  assert.equal(no.suppressRescue, false);
});

// ---- integration: decide (resume controller over the wire) ----
test('decide: v8 pending tasks -> dispatch_wave (lowest wave only)', () => {
  const d = JSON.parse(run(['decide', `--state=${tmpBundle(v8())}`]).stdout);
  assert.equal(d.action, 'dispatch_wave');
  assert.equal(d.wave, 0);
  assert.deepEqual(d.tasks.map((t) => t.id), [1]);
});
test('decide: all-done -> complete; open gate -> surface_gate', () => {
  assert.equal(JSON.parse(run(['decide', `--state=${tmpBundle(v8({ tasks: [{ id: 1, status: 'done', wave: 0, files: [] }] }))}`]).stdout).action, 'complete');
  const g = JSON.parse(run(['decide', `--state=${tmpBundle(v8({ pending_gate: { id: 'plan_approval', opened_at: 't' } }))}`]).stdout);
  assert.equal(g.action, 'surface_gate');
  assert.equal(g.gate.id, 'plan_approval');
});
test('decide: legacy bundle migrates in-memory; null waves trip the guard -> exit 2 + backfill hint', () => {
  const r = run(['decide', `--state=${SAMPLE}`]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /backfill waves from plan\.index\.json/);
});

// ---- integration: migrate-bundle + backfill-waves (the on-load migrate contract) ----
test('migrate-bundle: backs up original + rewrites as v8; second run is a no-op', () => {
  const p = path.join(tmpDir('mp-mig-'), 'state.yml');
  fs.copyFileSync(SAMPLE, p);
  const r = JSON.parse(run(['migrate-bundle', `--state=${p}`]).stdout);
  assert.equal(r.migrated, true);
  assert.equal(r.from, '5.0');
  assert.ok(fs.existsSync(r.backup)); // original preserved verbatim
  const migrated = read(p);
  assert.equal(migrated.schema_version, 8); // canonical v8 schema NUMBER (was string '6.0' — the doctor false-ERROR fix)
  assert.equal(typeof migrated.schema_version, 'number'); // on-disk type the doctor's validateCoreState requires
  assert.equal(JSON.parse(run(['migrate-bundle', `--state=${p}`]).stdout).migrated, false); // idempotent
});
test('ISSUE H: migrate-bundle on a sub-5.0 bundle refuses + surfaces the CD-7/seed-fresh guidance over the WIRE (operator surface, not just lib)', () => {
  // The operator never calls migrate() directly — they hit `mp migrate-bundle`, whose throw->die wrapper
  // (bin :320-322) must carry the refusal GUIDANCE intact to stderr. Pins that operator-facing contract so
  // a future bin change can't silently swallow the CD-7 prohibition. Real phase-37 was schema-3; migrate()
  // throws BEFORE the backup/write (:325-327), so the original stays byte-identical (refuse, never corrupt).
  const orig = 'schema_version: 3\nslug: ancient\nphase: execution\n';
  const p = path.join(tmpDir('mp-h-'), 'state.yml');
  fs.writeFileSync(p, orig);
  const r = run(['migrate-bundle', `--state=${p}`]);
  assert.equal(r.status, 2);                              // refused, non-zero exit
  assert.match(r.stderr, /predates the supported floor/); // the deliberate R3 floor refusal
  assert.match(r.stderr, /do not hand-rewrite|CD-7/i);    // 2A: the CD-7 prohibition reaches the operator
  assert.match(r.stderr, /mp seed|seed-tasks|fresh/i);    // 2A: the seed-fresh recovery path reaches the operator
  assert.equal(fs.readFileSync(p, 'utf8'), orig);         // refused BEFORE writing — original untouched
});
test('migrated bundle: backfill-waves satisfies the guard -> decide dispatches', () => {
  const dir = tmpDir('mp-bf-');
  const p = path.join(dir, 'state.yml');
  fs.copyFileSync(SAMPLE, p);
  run(['migrate-bundle', `--state=${p}`]);
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(Array.from({ length: 32 }, (_, i) => ({ id: i + 1, wave: 0, files: [] }))));
  assert.equal(JSON.parse(run(['backfill-waves', `--state=${p}`, `--plan-index=${planIdx}`]).stdout).updated, 32);
  const d = JSON.parse(run(['decide', `--state=${p}`]).stdout);
  assert.equal(d.action, 'dispatch_wave'); // ids 28 + 32 were the only non-done tasks
  assert.equal(d.wave, 0);
});

// ---- integration: load-plan (the plan→execute seam — step 7) ----
// REGRESSION for the cutover-blocker the fresh-eyes review caught: a planned bundle that lands on
// phase=execute with tasks:[] is data loss, because decideNextAction reads the TASK LIST (not the
// phase label) — a bare `set-phase execute` would make the very next `decide` return `complete` →
// ARCHIVE the just-planned bundle. The suite was 299/299 WITH this bug present (the dogfood hand-
// seeded `tasks`), so the regression must drive the ACTUAL transition end-to-end, not a unit test.
function planIndexFixture() {
  return {
    schema_version: '6.0',
    tasks: [
      { id: 1, wave: 0, description: 'greet', files: ['src/greet.mjs'], verify_commands: ['true'], codex: null },
      { id: 2, wave: 0, description: 'farewell', files: ['src/farewell.mjs'], verify_commands: ['true'], codex: null },
      { id: 3, wave: 1, description: 'index', files: ['src/index.mjs'], verify_commands: ['true'], codex: 'ok' },
    ],
  };
}
test('load-plan: materializes tasks + advances phase→execute atomically; decide then DISPATCHES (not completes)', () => {
  const dir = tmpDir('mp-loadplan-');
  const p = path.join(dir, 'state.yml');
  // a freshly-planned bundle: phase=plan, NO tasks yet (the exact seam the dogfood hand-seeded around)
  fs.writeFileSync(p, serializeState(v8({ phase: 'plan', tasks: [] })));
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));

  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { loaded: 3, waves: 2, phase: 'execute' });

  const s = read(p);
  assert.equal(s.phase, 'execute');                                   // phase advanced…
  assert.deepEqual(s.tasks.map((t) => t.id), [1, 2, 3]);             // …AND tasks materialized (atomic)
  assert.deepEqual(s.tasks.map((t) => t.status), ['pending', 'pending', 'pending']);
  assert.deepEqual(s.tasks.map((t) => t.wave), [0, 0, 1]);
  assert.deepEqual(s.tasks[2].files, ['src/index.mjs']);
  // state.tasks carries ONLY {id,status,wave,files}; codex stays in plan.index.json (no drift — the
  // exact field-duplication class 3dbad7f was built to kill; prepare-wave reads codex from the index).
  assert.ok(!('codex' in s.tasks[2]), 'state.tasks must NOT duplicate the codex routing field');

  // THE regression: decide must DISPATCH the planned wave, not COMPLETE→archive it.
  const d = JSON.parse(run(['decide', `--state=${p}`]).stdout);
  assert.equal(d.action, 'dispatch_wave');
  assert.equal(d.wave, 0);

  // …and the codex:"ok" task (wave 1) routes by ANNOTATION, not the heuristic — empirical proof the
  // {id,status,wave,files} field set is correct (prepare-wave sources codex from the index by id).
  const pw = JSON.parse(run(['prepare-wave', `--state=${p}`, `--plan-index=${planIdx}`, '--wave=1']).stdout);
  const t3 = pw.tasks.find((t) => t.id === 3);
  assert.equal(t3.target, 'codex');
  assert.equal(t3.eligible, true);
  assert.equal(t3.reason, 'annotation-ok');
});
test('load-plan: refuses a bundle that already has tasks (no clobber of execution state)', () => {
  const dir = tmpDir('mp-loadplan2-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ phase: 'plan' })));        // v8() ships 2 tasks
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already has 2 task/);
  assert.equal(read(p).phase, 'plan');                               // untouched — NOT advanced to execute
});
test('load-plan: refuses an invalid plan.index.json (the compensating gate for the direct mp-planner write)', () => {
  const dir = tmpDir('mp-loadplan3-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ phase: 'plan', tasks: [] })));
  const planIdx = path.join(dir, 'plan.index.json');
  // codex:"maybe" is the exact silent-heuristic-fallthrough class validatePlanIndex rejects.
  // schema_version:'6.0' clears the v8-floor gate so this exercises the STRUCTURAL rejection, not the floor.
  fs.writeFileSync(planIdx, JSON.stringify({ schema_version: '6.0', tasks: [{ id: 1, wave: 0, description: 'x', files: [], codex: 'maybe' }] }));
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /codex must be/);
  assert.deepEqual(read(p).tasks, []);                               // nothing materialized
});
test('load-plan: refuses an un-migrated legacy bundle (no silent overwrite before backup)', () => {
  const dir = tmpDir('mp-loadplan4-');
  const p = path.join(dir, 'state.yml');
  fs.copyFileSync(SAMPLE, p);                                        // schema 5.0 — pre-v8
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /migrate-bundle/);
});
test('load-plan: refuses a pre-v8 plan.index.json (schema_version floor — mirrors the doctor + loadForWrite major<6 gate)', () => {
  const dir = tmpDir('mp-loadplan5-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ phase: 'plan', tasks: [] })));
  const planIdx = path.join(dir, 'plan.index.json');
  // structurally fine, but a legacy schema_version — must be refused at the seam, BEFORE materializing.
  fs.writeFileSync(planIdx, JSON.stringify({ ...planIndexFixture(), schema_version: 5 }));
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /schema_version|v8 floor/);
  assert.deepEqual(read(p).tasks, []);                               // nothing materialized
  assert.equal(read(p).phase, 'plan');                               // phase untouched
});
test('set-phase: refuses --phase=execute on an empty-tasks bundle, names both seed-tasks + load-plan, honors --force', () => {
  // Even a hand-run `set-phase --phase=execute` on a freshly-planned bundle (tasks:[]) must die — it
  // would strand the bundle in the state where the next `decide` throws (refuses to finalize an unseeded
  // run). The guard names BOTH materialization remedies: `seed-tasks` (populate only) and `load-plan`
  // (populate + advance phase atomically). --force still moves the phase pointer (recovery/scripting) —
  // but the decide-layer backstop (resume.test.mjs) still refuses to finalize the resulting empty run.
  const empty = tmpBundle(v8({ phase: 'plan', tasks: [] }));
  const r = run(['set-phase', `--state=${empty}`, '--phase=execute']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to enter 'execute' with 0 tasks/);
  assert.match(r.stderr, /seed-tasks/);                              // the populate-only remedy
  assert.match(r.stderr, /load-plan/);                               // the atomic populate+advance remedy
  assert.equal(read(empty).phase, 'plan');                           // untouched — NOT advanced to execute
  // --force escape: advances the phase pointer even on an empty-tasks bundle (recovery / scripting).
  const forced = tmpBundle(v8({ phase: 'plan', tasks: [] }));
  assert.equal(JSON.parse(run(['set-phase', `--state=${forced}`, '--phase=execute', '--force']).stdout).phase, 'execute');
  assert.equal(read(forced).phase, 'execute');
  // …and advancing a bundle that DOES have tasks (v8 ships 2) is still allowed without --force.
  const withTasks = tmpBundle(v8({ phase: 'plan' }));
  assert.equal(JSON.parse(run(['set-phase', `--state=${withTasks}`, '--phase=execute']).stdout).phase, 'execute');
  assert.equal(read(withTasks).phase, 'execute');
});

// ---- integration: CD-7 single-writer ops ----
test('mark-task: write updates status; decide then advances to the next wave', () => {
  const p = tmpBundle(v8());
  run(['mark-task', `--state=${p}`, '--id=1', '--status=done']);
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'done');
  assert.equal(JSON.parse(run(['decide', `--state=${p}`]).stdout).wave, 1);
});
test('set-phase / set-status: write the lifecycle fields; reject a value outside the enum', () => {
  // The CD-7 closure for the line-333 hand-edit: there is now an `mp` write for the phase/status
  // fields, so the orchestrator never hand-edits state.yml to advance a phase or archive a run.
  const p = tmpBundle(v8());
  assert.equal(JSON.parse(run(['set-phase', `--state=${p}`, '--phase=plan']).stdout).phase, 'plan');
  assert.equal(read(p).phase, 'plan');
  assert.equal(JSON.parse(run(['set-status', `--state=${p}`, '--status=archived']).stdout).status, 'archived');
  assert.equal(read(p).status, 'archived');
  // Enum guard: a typo ('planning'/'archive') PASSES validateCoreState (presence-only) yet would break
  // the §2 discover filter (status==='archived') or the resume.mjs pre-execute guard (phase ∈ {…}).
  // It must die at the bin boundary, leaving the field untouched.
  const badPhase = run(['set-phase', `--state=${p}`, '--phase=planning']);
  assert.notEqual(badPhase.status, 0);
  assert.match(badPhase.stderr, /invalid --phase/);
  const badStatus = run(['set-status', `--state=${p}`, '--status=archive']);
  assert.notEqual(badStatus.status, 0);
  assert.match(badStatus.stderr, /invalid --status/);
  assert.equal(read(p).phase, 'plan');       // unchanged by the rejected writes
  assert.equal(read(p).status, 'archived');
});
test('set-worktree-disposition: write the field; reject a value outside the enum (C3)', () => {
  // CD-7 closure for the worktree-integrity fix message: the disposition the doctor reads to SKIP a retired
  // worktree now has an `mp` writer, so a post-merge active→removed_after_merge transition never forces a
  // raw hand-edit of state.yml (the only path that existed before this verb).
  const p = tmpBundle(v8());
  assert.equal(
    JSON.parse(run(['set-worktree-disposition', `--state=${p}`, '--disposition=removed_after_merge']).stdout).worktree_disposition,
    'removed_after_merge');
  assert.equal(read(p).worktree_disposition, 'removed_after_merge');
  // revertible via the SAME verb — 'active' is a valid value, so a premature retirement isn't a one-way door
  assert.equal(JSON.parse(run(['set-worktree-disposition', `--state=${p}`, '--disposition=active']).stdout).worktree_disposition, 'active');
  assert.equal(read(p).worktree_disposition, 'active');
  // Enum guard: a typo must die at the bin boundary, leaving the field untouched.
  const bad = run(['set-worktree-disposition', `--state=${p}`, '--disposition=removed']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /invalid --disposition/);
  assert.equal(read(p).worktree_disposition, 'active'); // unchanged by the rejected write
});

// ---- worktree plan|record|reconcile (Phase 1 lifecycle subcommands) ----------

test('worktree plan: a fresh kickoff emits a create plan with `git worktree add … -b <branch>`', () => {
  const out = JSON.parse(run(['worktree', 'plan', '--slug=brave-fox', '--repo-root=/r']).stdout);
  assert.equal(out.action, 'create');
  assert.equal(out.path, '/r/.worktrees/brave-fox');
  assert.equal(out.branch, 'masterplan/brave-fox');
  assert.deepEqual(out.gitArgs, ['worktree', 'add', '/r/.worktrees/brave-fox', '-b', 'masterplan/brave-fox']);
});

test('worktree plan: reads slug + existing worktree from --state; canonical existing → reuse', () => {
  const p = tmpBundle(v8({ slug: 'brave-fox', worktree: '/r/.worktrees/brave-fox' }));
  const out = JSON.parse(run(['worktree', 'plan', `--state=${p}`, '--repo-root=/r']).stdout);
  assert.equal(out.action, 'reuse');
  assert.equal(out.gitArgs, undefined);
});

test('worktree plan: --branch-exists drops `-b` (attach the existing branch)', () => {
  const out = JSON.parse(run(['worktree', 'plan', '--slug=x', '--repo-root=/r', '--branch-exists']).stdout);
  assert.deepEqual(out.gitArgs, ['worktree', 'add', '/r/.worktrees/x', 'masterplan/x']);
});

test('worktree plan: missing --repo-root dies', () => {
  const bad = run(['worktree', 'plan', '--slug=x']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /repo-root/);
});

test('worktree record: --worktree records the path; --disposition records the lifecycle field', () => {
  const p = tmpBundle(v8());
  const out = JSON.parse(
    run(['worktree', 'record', `--state=${p}`, '--worktree=/r/.worktrees/demo', '--disposition=active']).stdout
  );
  assert.equal(out.worktree, '/r/.worktrees/demo');
  assert.equal(out.worktree_disposition, 'active');
  assert.equal(read(p).worktree, '/r/.worktrees/demo');
  assert.equal(read(p).worktree_disposition, 'active');
});

test('worktree record: legacy --disposition=missing is NORMALIZED to removed_after_merge', () => {
  const p = tmpBundle(v8());
  const out = JSON.parse(run(['worktree', 'record', `--state=${p}`, '--disposition=missing']).stdout);
  assert.equal(out.worktree_disposition, 'removed_after_merge');
  assert.equal(read(p).worktree_disposition, 'removed_after_merge');
});

test('worktree record: an unknown disposition dies, leaving state untouched', () => {
  const p = tmpBundle(v8({ worktree_disposition: 'active' }));
  const bad = run(['worktree', 'record', `--state=${p}`, '--disposition=bogus']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /invalid --disposition/);
  assert.equal(read(p).worktree_disposition, 'active');
});

test('worktree record: neither --worktree, --disposition, nor --choice dies', () => {
  const p = tmpBundle(v8());
  const bad = run(['worktree', 'record', `--state=${p}`]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /at least one of --worktree, --disposition, or --choice/);
});

test('worktree record: --choice=merge --removal-confirmed records removed_after_merge', () => {
  const p = tmpBundle(v8({ worktree_disposition: 'active' }));
  const out = JSON.parse(
    run(['worktree', 'record', `--state=${p}`, '--choice=merge', '--removal-confirmed']).stdout
  );
  assert.equal(out.worktree_disposition, 'removed_after_merge');
  assert.equal(read(p).worktree_disposition, 'removed_after_merge');
});

test('worktree record: --choice=merge WITHOUT --removal-confirmed stays active (unconfirmed teardown)', () => {
  const p = tmpBundle(v8({ worktree_disposition: 'active' }));
  const out = JSON.parse(run(['worktree', 'record', `--state=${p}`, '--choice=merge']).stdout);
  assert.equal(out.worktree_disposition, 'active');
  assert.equal(read(p).worktree_disposition, 'active');
});

test('worktree record: --choice=keep records kept_by_user regardless of removal-confirmed', () => {
  const p = tmpBundle(v8());
  const out = JSON.parse(run(['worktree', 'record', `--state=${p}`, '--choice=keep']).stdout);
  assert.equal(out.worktree_disposition, 'kept_by_user');
});

test('worktree record: an unknown --choice dies, leaving state untouched', () => {
  const p = tmpBundle(v8({ worktree_disposition: 'active' }));
  const bad = run(['worktree', 'record', `--state=${p}`, '--choice=bogus']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown --choice/);
  assert.equal(read(p).worktree_disposition, 'active');
});

test('worktree record: --disposition and --choice together die (mutually exclusive)', () => {
  const p = tmpBundle(v8({ worktree_disposition: 'active' }));
  const bad = run(['worktree', 'record', `--state=${p}`, '--disposition=active', '--choice=merge']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /mutually exclusive/);
  assert.equal(read(p).worktree_disposition, 'active');
});

test('worktree reconcile: classifies a foreign-leftover (remove) + a legacy-missing bundle (normalize)', () => {
  const root = tmpDir('mp-wt-');
  // The repo's OWN admin dir must EXIST on disk so the bin caller's realpath resolves it (a `remove`
  // requires BOTH sides canonicalize — the Codex Round-2 BLOCKER; an unresolvable repo .git can never
  // auto-remove a stray). A real repo always has one.
  fs.mkdirSync(path.join(root, '.git', 'worktrees'), { recursive: true });
  // A foreign-repo leftover checkout under .worktrees/ (its .git points at a DIFFERENT repo). The
  // foreign admin dir must EXIST on disk so canonicalization can PROVE it foreign — an unresolvable
  // target is left untouched as foreign-unverified, never auto-removed (the Codex realpath BLOCKER).
  const foreignAdmin = path.join(tmpDir('mp-foreign-'), '.git', 'worktrees', 'cc3');
  fs.mkdirSync(foreignAdmin, { recursive: true });
  fs.mkdirSync(path.join(root, '.worktrees', 'cc3'), { recursive: true });
  fs.writeFileSync(path.join(root, '.worktrees', 'cc3', '.git'), `gitdir: ${foreignAdmin}\n`);
  // A bundle still carrying the phantom `missing` disposition.
  const bdir = path.join(root, 'docs', 'masterplan', 'legacy');
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(
    path.join(bdir, 'state.yml'),
    serializeState({
      schema_version: '6.0', slug: 'legacy', status: 'archived', phase: 'execute',
      worktree: '/x', worktree_disposition: 'missing',
    })
  );
  const res = run(['worktree', 'reconcile', `--repo-root=${root}`, `--repo-git-dir=${root}/.git`, '--worktree-list=']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const foreign = out.actions.find((a) => a.reason === 'foreign-leftover');
  assert.ok(foreign, 'expected a foreign-leftover action');
  assert.equal(foreign.action, 'remove');
  assert.equal(foreign.registered, false);
  const norm = out.actions.find((a) => a.reason === 'legacy-missing');
  assert.ok(norm, 'expected a legacy-missing normalize action');
  assert.equal(norm.action, 'normalize');
  assert.equal(norm.slug, 'legacy');
  assert.equal(out.findings.length, 2); // both non-none actions surface as WARN findings
});

test('worktree reconcile: a repo with no .worktrees/ and no bundles → empty plan', () => {
  const root = tmpDir('mp-wt-empty-');
  const out = JSON.parse(
    run(['worktree', 'reconcile', `--repo-root=${root}`, '--worktree-list=']).stdout
  );
  assert.deepEqual(out, { actions: [], findings: [] });
});

test('worktree: an unknown subcommand dies with the expected list', () => {
  const bad = run(['worktree', 'frobnicate']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /plan \| record \| reconcile/);
});
test('set-codex-config: write NESTED codex.{routing,review}; merge-preserve; reject bad value / empty patch (codex CD-7)', () => {
  // CD-7 closure for the codex-plugin-presence fix message: the codex config the dispatch path reads
  // (state.codex.routing/.review) now has an `mp` writer, so turning codex off for a bundle never forces a
  // raw hand-edit of state.yml. Writes the NESTED shape — not the flat codex_routing the old fix text named.
  const p = tmpBundle(v8());
  const o = JSON.parse(run(['set-codex-config', `--state=${p}`, '--routing=off', '--review=false']).stdout);
  assert.deepEqual(o.codex, { routing: 'off', review: false });
  assert.deepEqual(read(p).codex, { routing: 'off', review: false }); // persisted as the nested object
  // partial set merge-preserves the other facet: flip routing back to auto, review stays false
  assert.deepEqual(JSON.parse(run(['set-codex-config', `--state=${p}`, '--routing=auto']).stdout).codex, { routing: 'auto' });
  assert.deepEqual(read(p).codex, { routing: 'auto', review: false });
  // review normalizes on/true -> the boolean `true` the dispatch path and wantsCodex compare against
  const q = tmpBundle(v8());
  assert.equal(JSON.parse(run(['set-codex-config', `--state=${q}`, '--review=on']).stdout).codex.review, true);
  assert.equal(read(q).codex.review, true);
  // Enum guard + empty-patch guard: both die at the bin boundary, leaving state untouched.
  const badRouting = run(['set-codex-config', `--state=${p}`, '--routing=sometimes']);
  assert.notEqual(badRouting.status, 0);
  assert.match(badRouting.stderr, /invalid --routing/);
  const empty = run(['set-codex-config', `--state=${p}`]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /at least one of --routing or --review/);
  assert.deepEqual(read(p).codex, { routing: 'auto', review: false }); // unchanged by the rejected writes
});
test('finish-status: codex_review mirrors state.codex.review (the predicate that arms the §2c whole-branch gate)', () => {
  // The §2c finish-gate runs the whole-branch codex-companion review only when review is armed. finish-status
  // surfaces that as a normalized boolean using the SAME predicate as the dispatch/prepare-wave path
  // (rawReview === true|'on'|'true'), so the gate and the wave workflow can never disagree on "review is on".
  const p = tmpBundle(v8());
  // Default bundle — no codex config → not armed.
  assert.equal(JSON.parse(run(['finish-status', `--state=${p}`]).stdout).codex_review, false);
  // set-codex-config --review=on persists the boolean true; finish-status reports the gate armed.
  run(['set-codex-config', `--state=${p}`, '--review=on']);
  assert.equal(JSON.parse(run(['finish-status', `--state=${p}`]).stdout).codex_review, true);
  // …and back off — the gate disarms (the value is read live from state each snapshot).
  run(['set-codex-config', `--state=${p}`, '--review=off']);
  assert.equal(JSON.parse(run(['finish-status', `--state=${p}`]).stdout).codex_review, false);
});
test('active_run two-phase: set (launching) -> recover w/ null staleTaskId; promote -> wait(alive)/recover(dead, staleTaskId)', () => {
  const p = tmpBundle(v8());
  assert.deepEqual(JSON.parse(run(['set-active-run', `--state=${p}`, '--wave=0']).stdout).active_run, { wave: 0, phase: 'launching' });
  const d1 = JSON.parse(run(['decide', `--state=${p}`]).stdout);
  assert.equal(d1.action, 'recover_and_redispatch');
  assert.equal(d1.staleTaskId, null); // crashed in the launch gap — nothing to reconcile
  assert.deepEqual(JSON.parse(run(['promote-active-run', `--state=${p}`, '--run-id=wf_9', '--task-id=k9']).stdout).active_run,
    { wave: 0, run_id: 'wf_9', task_id: 'k9' });
  assert.equal(JSON.parse(run(['decide', `--state=${p}`, '--alive']).stdout).action, 'wait');
  const d2 = JSON.parse(run(['decide', `--state=${p}`]).stdout);
  assert.equal(d2.action, 'recover_and_redispatch');
  assert.equal(d2.staleTaskId, 'k9'); // dead -> shell reconciles this handle before reset+redispatch
  run(['clear-active-run', `--state=${p}`]);
  assert.equal(read(p).active_run, null);
});
test('F-SCOPE snapshot: set-active-run --scope freezes the allow-set; promote preserves it; verify-scope reads it (immune to a mid-wave state.tasks edit)', () => {
  const p = tmpBundle(v8({ tasks: [{ id: 1, status: 'pending', wave: 0, files: ['a.js'] }] }));
  // 1) Launch-time snapshot: set-active-run --wave --scope freezes the resolved file union.
  const set = JSON.parse(run(['set-active-run', `--state=${p}`, '--wave=0', '--scope=["a.js"]']).stdout);
  assert.deepEqual(set.active_run, { wave: 0, phase: 'launching', scope: ['a.js'] });
  // 2) Promotion preserves the frozen scope through the phase-1 -> phase-2 transition.
  const prom = JSON.parse(run(['promote-active-run', `--state=${p}`, '--run-id=wf_1', '--task-id=k1']).stdout);
  assert.deepEqual(prom.active_run, { wave: 0, run_id: 'wf_1', task_id: 'k1', scope: ['a.js'] });
  // 3) Simulate a ROGUE mid-wave widening of state.tasks[].files to include rogue.js — exactly the tamper
  //    the snapshot defends against. If verify-scope re-derived the allow-set from state (the pre-fix
  //    path), rogue.js would now be ALLOWED and this test would pass vacuously. It must instead read the
  //    frozen active_run.scope (['a.js']) and STILL reject rogue.js.
  const tampered = read(p);
  tampered.tasks[0].files = ['a.js', 'rogue.js'];
  fs.writeFileSync(p, serializeState(tampered));
  assert.deepEqual(read(p).active_run.scope, ['a.js'], 'the frozen snapshot survives the state.tasks tamper');
  const vs = JSON.parse(run(['verify-scope', `--state=${p}`, '--wave=0', '--before=[]', '--after=["a.js","rogue.js"]']).stdout);
  assert.equal(vs.ok, false);
  assert.deepEqual(vs.outOfScope, ['rogue.js']);
});
test('F-SCOPE snapshot: a run with NO active_run.scope falls back to state-only declaredScope (back-compat)', () => {
  const p = tmpBundle(v8({ tasks: [{ id: 1, status: 'pending', wave: 0, files: ['a.js'] }], active_run: null }));
  // No snapshot -> declared comes from state.tasks[].files; a.js is allowed, rogue.js is the breach.
  const vs = JSON.parse(run(['verify-scope', `--state=${p}`, '--wave=0', '--before=[]', '--after=["a.js","rogue.js"]']).stdout);
  assert.equal(vs.ok, false);
  assert.deepEqual(vs.outOfScope, ['rogue.js']);
});
test('set-active-run --scope rejects a non-array JSON value (fail loud)', () => {
  const p = tmpBundle(v8());
  const bad = run(['set-active-run', `--state=${p}`, '--wave=0', '--scope={"x":1}']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /must be a JSON array/);
});
test('D6 baseline: set-active-run --baseline persists; promote carries it; verify-scope falls back to it when --before is omitted (crash-resume)', () => {
  const p = tmpBundle(v8({ tasks: [{ id: 1, status: 'pending', wave: 0, files: ['a.js'] }] }));
  // 1) Launch: freeze BOTH the scope allow-set and the D6 `before` baseline into the phase-1 marker.
  const set = JSON.parse(run(['set-active-run', `--state=${p}`, '--wave=0', '--scope=["a.js"]', '--baseline=["pre.js"]']).stdout);
  assert.deepEqual(set.active_run, { wave: 0, phase: 'launching', scope: ['a.js'], baseline: ['pre.js'] });
  // 2) Promotion carries the baseline forward (mirror of scope) so a post-completion-crash resume still has it.
  const prom = JSON.parse(run(['promote-active-run', `--state=${p}`, '--run-id=wf_1', '--task-id=k1']).stdout);
  assert.deepEqual(prom.active_run, { wave: 0, run_id: 'wf_1', task_id: 'k1', scope: ['a.js'], baseline: ['pre.js'] });
  // 3) finalize_run RESUME path: verify-scope is called with NO --before (the workflow result is gone),
  //    so it must fall back to active_run.baseline (['pre.js']). pre.js is in `before` -> excluded from the
  //    diff; a.js is in scope -> allowed; rogue.js is the out-of-scope breach the re-run still catches.
  const vs = JSON.parse(run(['verify-scope', `--state=${p}`, '--wave=0', '--after=["pre.js","a.js","rogue.js"]']).stdout);
  assert.equal(vs.ok, false);
  assert.deepEqual(vs.outOfScope, ['rogue.js']);
});
test('set-active-run --baseline rejects a non-array JSON value (fail loud)', () => {
  const p = tmpBundle(v8());
  const bad = run(['set-active-run', `--state=${p}`, '--wave=0', '--baseline={"x":1}']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /must be a JSON array/);
});
test('worktree plan --worktree-registered reuses even with no recorded worktree (crash-between-add-and-record idempotency)', () => {
  const p = tmpBundle(v8({ slug: 'reg-slug' }));
  // No state.worktree recorded; the canonical path is already a registered worktree (the shell probed it).
  const r = run(['worktree', 'plan', `--state=${p}`, '--repo-root=/r', '--branch=masterplan/reg-slug', '--branch-exists', '--worktree-registered']);
  assert.equal(r.status, 0);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.action, 'reuse');
  assert.equal(plan.gitArgs, undefined);
});
test('planning active_run: set --kind=plan writes launching marker without --wave', () => {
  const p = tmpBundle(v8());
  const r = run(['set-active-run', `--state=${p}`, '--kind=plan']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).active_run, { kind: 'plan', phase: 'launching' });
  assert.deepEqual(read(p).active_run, { kind: 'plan', phase: 'launching' });
});
test('planning active_run: promote attaches run and task handles without a wave', () => {
  const p = tmpBundle(v8({ active_run: { kind: 'plan', phase: 'launching' } }));
  const r = run(['promote-active-run', `--state=${p}`, '--run-id=R', '--task-id=T']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).active_run, { kind: 'plan', run_id: 'R', task_id: 'T' });
  assert.deepEqual(read(p).active_run, { kind: 'plan', run_id: 'R', task_id: 'T' });
});
test('open-gate / clear-gate write the durable marker', () => {
  const p = tmpBundle(v8());
  run(['open-gate', `--state=${p}`, '--id=spec_approval', '--opened-at=2026-05-28']);
  assert.equal(JSON.parse(run(['decide', `--state=${p}`]).stdout).action, 'surface_gate');
  run(['clear-gate', `--state=${p}`]);
  assert.equal(JSON.parse(run(['decide', `--state=${p}`]).stdout).action, 'dispatch_wave');
});
test('write ops refuse an un-migrated legacy bundle (no silent overwrite before backup)', () => {
  const p = path.join(tmpDir('mp-guard-'), 'state.yml');
  fs.copyFileSync(SAMPLE, p);
  const r = run(['mark-task', `--state=${p}`, '--id=1', '--status=done']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /migrate-bundle/);
});

// ---- integration: seed + event (CD-7 writers that retire the raw-Write diff-flood) ----
test('seed: creates a core-valid v8 brainstorm bundle with sibling artifact paths; output is terse', () => {
  const dir = tmpDir('mp-seed-');
  const p = path.join(dir, 'state.yml');
  const r = run(['seed', `--state=${p}`, '--slug=demo-run', '--topic=A licensing topic', '--created-at=2026-05-29T00:00:00Z',
                 '--complexity=high', '--autonomy=loose']);
  assert.equal(r.status, 0);
  const s = read(p);
  assert.equal(s.schema_version, 8);
  assert.equal(s.phase, 'brainstorm');
  assert.equal(s.status, 'in-progress');
  assert.equal(s.slug, 'demo-run');
  assert.equal(s.topic, 'A licensing topic');
  assert.equal(s.complexity, 'high');
  assert.equal(s.autonomy, 'loose');
  assert.equal(s.planning_mode, 'auto');
  assert.deepEqual(s.tasks, []);
  assert.equal(s.active_run, null);
  assert.equal(s.pending_gate, null);
  assert.equal(s.spec_path, path.join(dir, 'spec.md')); // derived as siblings of the bundle dir
  assert.equal(s.plan_path, path.join(dir, 'plan.md'));
  assert.equal(s.plan_index_path, path.join(dir, 'plan.index.json'));
  // a fresh seed is a mid-design (brainstorm-phase, tasks:[]) bundle — NOT a finished run. `decide`
  // must hand it to the phase lifecycle, never `complete` (which would archive a run that never ran).
  const seedDecision = JSON.parse(run(['decide', `--state=${p}`]).stdout);
  assert.equal(seedDecision.action, 'resume_phase');
  assert.equal(seedDecision.phase, 'brainstorm');
  // terse stdout: a short confirmation, NOT a full-state echo (anti-flood — the whole point of the fix)
  const o = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(o).sort(), ['path', 'phase', 'seeded', 'status']);
  assert.ok(!r.stdout.includes('A licensing topic'));
});
test('seed: accepts and validates --planning-mode', () => {
  const good = path.join(tmpDir('mp-seed-plan-mode-'), 'state.yml');
  const r = run(['seed', `--state=${good}`, '--slug=demo-run', '--topic=A topic', '--planning-mode=parallel']);
  assert.equal(r.status, 0);
  assert.equal(read(good).planning_mode, 'parallel');

  const bad = path.join(tmpDir('mp-seed-plan-mode-bad-'), 'state.yml');
  const rejected = run(['seed', `--state=${bad}`, '--slug=demo-run', '--topic=A topic', '--planning-mode=bogus']);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /invalid --planning-mode/);
});
test('seed: refuses an existing bundle unless --force', () => {
  const p = path.join(tmpDir('mp-seed2-'), 'state.yml');
  assert.equal(run(['seed', `--state=${p}`, '--slug=x', '--topic=t']).status, 0);
  const refused = run(['seed', `--state=${p}`, '--slug=x', '--topic=t']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
  assert.equal(run(['seed', `--state=${p}`, '--slug=x', '--topic=t', '--force']).status, 0); // --force overwrites
});
test('seed: a missing required flag fails loud', () => {
  const p = path.join(tmpDir('mp-seed3-'), 'state.yml');
  assert.equal(run(['seed', `--state=${p}`, '--slug=x']).status, 2); // no --topic -> need() dies (exit 2)
});
test('event: appends one JSON line per call to the bundle\'s events.jsonl, accumulating', () => {
  const p = path.join(tmpDir('mp-event-'), 'state.yml');
  const ep = path.join(path.dirname(p), 'events.jsonl');
  const r1 = run(['event', `--state=${p}`, '--type=seeded', '--ts=T1', '--phase=brainstorm']);
  assert.equal(r1.status, 0);
  assert.equal(JSON.parse(r1.stdout).path, ep); // events.jsonl is a sibling of state.yml
  run(['event', `--state=${p}`, '--type=gate_opened', '--ts=T2', '--data={"id":"plan_approval"}']);
  // --summary is the structured signal channel (v7's audit scanner — lib/masterplan_session_audit.py,
  // deleted at the cutover — read type/kind/event/message/detail/summary/notes/status; NOT note). The §2c whole-branch finish-gate
  // emits its codex_review invocation here so the audit COUNTS it (suppressing
  // codex_review_configured_but_zero_invocations); --note remains the un-scanned free-text channel. Assert
  // both land as DISTINCT fields from one call.
  run(['event', `--state=${p}`, '--type=codex_review', '--ts=T3', '--note=fyi', '--summary=codex review complete (whole-branch, base main) — 3 findings']);
  const lines = fs.readFileSync(ep, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), { type: 'seeded', ts: 'T1', phase: 'brainstorm' });
  assert.deepEqual(JSON.parse(lines[1]), { type: 'gate_opened', ts: 'T2', data: { id: 'plan_approval' } });
  assert.deepEqual(JSON.parse(lines[2]), {
    type: 'codex_review', ts: 'T3', note: 'fyi',
    summary: 'codex review complete (whole-branch, base main) — 3 findings',
  });
});
test('event: rejects non-JSON --data', () => {
  const p = path.join(tmpDir('mp-event2-'), 'state.yml');
  const r = run(['event', `--state=${p}`, '--type=x', '--data=not json']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be valid JSON/);
});

// ---- integration: codex-review-status (the §2c step-5 durable re-entry guard's fs front) ----
test('codex-review-status: reads back a durable codex_review event for a given HEAD (the P2 re-entry guard)', () => {
  // The §2c finish-gate writes a codex_review event (data:{sha,base,count}, note:<digest>) BEFORE
  // open-gate. On resume the step-5 guard reads it via this subcommand: present at HEAD ⇒ skip the
  // network re-run + rehydrate the digest. End-to-end: `mp event` writes, `mp codex-review-status` reads.
  const p = path.join(tmpDir('mp-crs-'), 'state.yml');
  const HEAD = 'deadbeef123';
  // Absent events.jsonl → {present:false}, no throw.
  assert.deepEqual(JSON.parse(run(['codex-review-status', `--state=${p}`, `--sha=${HEAD}`]).stdout),
    { present: false, digest: null, count: null, base: null });
  // Write the durable record exactly as step-5's exit-0 path does (the channel split: scalars→--data,
  // free-text digest→--note, audit signal→--summary).
  run(['event', `--state=${p}`, '--type=codex_review', '--ts=T1',
    '--summary=codex review complete (whole-branch, base main) — 2 findings',
    `--data={"sha":"${HEAD}","base":"main","count":2}`, '--note=P2: stale lock; P3: naming']);
  assert.deepEqual(JSON.parse(run(['codex-review-status', `--state=${p}`, `--sha=${HEAD}`]).stdout),
    { present: true, digest: 'P2: stale lock; P3: naming', count: 2, base: 'main' });
  // A different HEAD does not match (the guard keys on the exact tree).
  assert.equal(JSON.parse(run(['codex-review-status', `--state=${p}`, '--sha=other999']).stdout).present, false);
  // A degraded codex_review_skipped record at HEAD must NOT satisfy the guard (a skip ≠ a review).
  run(['event', `--state=${p}`, '--type=codex_review_skipped', '--ts=T2',
    '--summary=whole-branch codex-companion review skipped (degraded) — no network',
    `--data={"sha":"${HEAD}"}`]);
  // The earlier success still wins; the skip is ignored either way.
  assert.equal(JSON.parse(run(['codex-review-status', `--state=${p}`, `--sha=${HEAD}`]).stdout).present, true);
});

test('event --note-file: reads arbitrary bytes verbatim into record.note (the shell-safe digest transport)', () => {
  // The §2c finish-gate's codex-review digest is review-derived free text. Interpolating it into a
  // `--note="<digest>"` shell word is an injection/quoting hazard (quote/backtick/$()/newline). The fix:
  // the shell Writes the digest to a file (Write is not shell-evaluated) and passes the PATH; bin reads
  // the bytes verbatim. Round-trip a digest packed with every char that would break a shell word.
  const dir = tmpDir('mp-notefile-');
  const p = path.join(dir, 'state.yml');
  const HEAD = 'cafef00d';
  const adversarial = 'P2: a "quoted" $(rm -rf /) `backtick`\nsecond line; --data={"sha":"evil"}\n';
  const digestFile = path.join(dir, 'codex-review-digest.txt');
  fs.writeFileSync(digestFile, adversarial);
  run(['event', `--state=${p}`, '--type=codex_review', '--ts=T1',
    '--summary=codex review complete (whole-branch, base main) — 1 findings',
    `--data={"sha":"${HEAD}","base":"main","count":1}`, `--note-file=${digestFile}`]);
  // The bytes survive verbatim — no shell ever saw them, and the injected `--data=` is inert text.
  const status = JSON.parse(run(['codex-review-status', `--state=${p}`, `--sha=${HEAD}`]).stdout);
  assert.equal(status.present, true);
  assert.equal(status.digest, adversarial);
  assert.equal(status.count, 1);
  assert.equal(status.base, 'main');
});

test('event: --note and --note-file are mutually exclusive (die, no event written)', () => {
  const dir = tmpDir('mp-notefile-mx-');
  const p = path.join(dir, 'state.yml');
  const digestFile = path.join(dir, 'd.txt');
  fs.writeFileSync(digestFile, 'x');
  const r = run(['event', `--state=${p}`, '--type=codex_review', `--note=inline`, `--note-file=${digestFile}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /mutually exclusive/);
  // The collision aborts before any append — no events.jsonl materializes.
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false);
});

test('event: --note-file pointing at a missing path dies loud (not a silent empty note)', () => {
  const dir = tmpDir('mp-notefile-enoent-');
  const p = path.join(dir, 'state.yml');
  const r = run(['event', `--state=${p}`, '--type=codex_review', `--note-file=${path.join(dir, 'nope.txt')}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /note-file unreadable/);
});

test('codex-review-status: a non-ENOENT events.jsonl read error fails loud (never masquerades as present:false)', () => {
  // ENOENT == no review yet → {present:false}. But any OTHER read error (here: events.jsonl is a
  // directory → EISDIR) must NOT be swallowed — a silent {present:false} would falsely re-run the
  // network gate or look "skipped". The subcommand must die.
  const dir = tmpDir('mp-crs-eisdir-');
  const p = path.join(dir, 'state.yml');
  fs.mkdirSync(path.join(dir, 'events.jsonl')); // sibling of state.yml, as a directory
  const r = run(['codex-review-status', `--state=${p}`, '--sha=deadbeef']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /events\.jsonl unreadable/);
});

// ---- integration: seed-tasks (the fresh-plan plan.index.json -> state.tasks writer) ----
test('seed-tasks: populates state.tasks from plan.index.json so a freshly-planned run dispatches instead of finalizing empty', () => {
  // The fresh-plan path's missing CD-7 writer: a brainstorm bundle seeds tasks:[]; nothing loaded the
  // plan's tasks until now, forcing a hand-rewrite of state.yml (CD-7 violation + diff-flood). Feed the
  // REAL openxcvr shape — 42 tasks, numeric id/wave, the full routing key set — and assert the minimal
  // 4-field task lands, the rich fields stay in plan.index, and decide then dispatches wave 0.
  const dir = tmpDir('mp-seedtasks-');
  const p = path.join(dir, 'state.yml');
  run(['seed', `--state=${p}`, '--slug=lic-lock', '--topic=commercial license lock']);
  run(['set-phase', `--state=${p}`, '--phase=plan']);
  const planIdx = path.join(dir, 'plan.index.json');
  const planTasks = Array.from({ length: 42 }, (_, i) => ({
    id: i + 1, wave: Math.floor(i / 6), files: [`src/f${i}.rs`], description: `task ${i + 1}`,
    verify_commands: ['cargo test'], codex: i % 2 ? 'ok' : 'no', sensitive: i === 0, conversational: false,
  }));
  fs.writeFileSync(planIdx, JSON.stringify({ schema_version: '6.0', tasks: planTasks }));
  const r = run(['seed-tasks', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout);
  assert.equal(o.seeded_tasks, 42);                 // terse: count + waves only, no full-state echo (anti-flood)
  assert.deepEqual(o.waves, [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(!r.stdout.includes('cargo test'));      // routing fields never hit the screen
  const s = read(p);
  assert.equal(s.tasks.length, 42);
  assert.deepEqual(s.tasks[0], { id: 1, status: 'pending', wave: 0, files: ['src/f0.rs'] }); // minimal shell-owned shape
  assert.ok(!('description' in s.tasks[0]) && !('codex' in s.tasks[0]));                      // rich fields stay in plan.index
  // BEFORE this fix the orchestrator had to hand-write state.yml here. With tasks loaded, at
  // phase=execute decide dispatches wave 0 — NOT `complete` over an empty run.
  run(['set-phase', `--state=${p}`, '--phase=execute']);
  const d = JSON.parse(run(['decide', `--state=${p}`]).stdout);
  assert.equal(d.action, 'dispatch_wave');
  assert.equal(d.wave, 0);
});
test('seed-tasks: refuses to clobber a non-empty task list unless --force', () => {
  const p = tmpBundle(v8()); // v8() already carries 2 tasks
  const planIdx = path.join(path.dirname(p), 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify([{ id: 9, wave: 0, files: [] }]));
  const refused = run(['seed-tasks', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already has 2 task/);
  assert.equal(read(p).tasks.length, 2);            // untouched — no silent overwrite of in-flight statuses
  assert.equal(run(['seed-tasks', `--state=${p}`, `--plan-index=${planIdx}`, '--force']).status, 0);
  assert.deepEqual(read(p).tasks, [{ id: 9, status: 'pending', wave: 0, files: [] }]); // --force replaces
});
test('seed-tasks: a non-integer wave fails loud BEFORE writing (mirror of backfill-waves stuck-guard)', () => {
  const dir = tmpDir('mp-seedtasks3-');
  const p = path.join(dir, 'state.yml');
  run(['seed', `--state=${p}`, '--slug=x', '--topic=t']);
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify([{ id: 1, wave: 0, files: [] }, { id: 2, wave: '1', files: [] }]));
  const r = run(['seed-tasks', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no integer wave.*2/);
  assert.deepEqual(read(p).tasks, []);              // guard fired before writeState — bundle untouched
});
test('seed-tasks: a task with no id fails loud (mark-task could never address it)', () => {
  const dir = tmpDir('mp-seedtasks4-');
  const p = path.join(dir, 'state.yml');
  run(['seed', `--state=${p}`, '--slug=x', '--topic=t']);
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify([{ wave: 0, files: [] }]));
  const r = run(['seed-tasks', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no id/);
  assert.deepEqual(read(p).tasks, []);
});
test('ISSUE G: set-phase execute over 0 tasks is refused (--force advances but decide still refuses to finalize)', () => {
  // Write-side prevention + read-side backstop for the §3 ordering invariant (`mp seed-tasks` loads
  // the plan into state.tasks BEFORE `set-phase execute`). Without it the bundle carries tasks:[];
  // entering execute there is the exact shape decideNextAction would mis-finalize — a planned-but-
  // unseeded run archived as "done" (data loss). Same-class preventive: the openxcvr operator hand-
  // populated tasks first, so the wild run never hit this; this is the defensive completion of the
  // pre-execute (brainstorm|plan) guard for the phase it skipped.
  const dir = tmpDir('mp-issueg-');
  const p = path.join(dir, 'state.yml');
  run(['seed', `--state=${p}`, '--slug=lic-lock', '--topic=commercial license lock']);
  run(['set-phase', `--state=${p}`, '--phase=plan']);
  // (1) write guard: refuse to enter execute with 0 tasks; phase stays 'plan', nothing written.
  const refused = run(['set-phase', `--state=${p}`, '--phase=execute']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to enter 'execute' with 0 tasks/);
  assert.equal(read(p).phase, 'plan');
  // (2) --force advances the phase pointer (recovery / scripting) ...
  assert.equal(run(['set-phase', `--state=${p}`, '--phase=execute', '--force']).status, 0);
  assert.equal(read(p).phase, 'execute');
  // (3) ... but does NOT enable silent finalize: decide on the forced execute+empty bundle throws,
  //     surfaced as a clean die by the caller (NOT {action:'complete'}). The universal backstop.
  const decided = run(['decide', `--state=${p}`]);
  assert.notEqual(decided.status, 0);
  assert.match(decided.stderr, /phase is 'execute' but state\.tasks is empty/);
  // (4) seed-tasks loads the plan -> the SAME execute bundle now dispatches instead of throwing.
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify({ schema_version: '6.0', tasks: [{ id: 1, wave: 0, files: ['a.rs'], description: 'x', verify_commands: ['cargo test'] }] }));
  assert.equal(run(['seed-tasks', `--state=${p}`, `--plan-index=${planIdx}`]).status, 0);
  const d = JSON.parse(run(['decide', `--state=${p}`]).stdout);
  assert.equal(d.action, 'dispatch_wave');
  assert.equal(d.wave, 0);
});

// ---- regression coverage: the three Codex-review findings (2026-05-28) ----
test('promote-active-run without a phase-1 launching marker is refused (HIGH: no wave-less active_run)', () => {
  const p = tmpBundle(v8()); // active_run: null — no set-active-run was called
  const r = run(['promote-active-run', `--state=${p}`, '--run-id=wf_9', '--task-id=k9']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /set-active-run/);
  assert.equal(read(p).active_run, null); // state untouched — nothing orphaned
});
test('decide refuses a wave-less active_run (HIGH: fail loud, never finalize while tasks pend)', () => {
  const p = tmpBundle(v8({ active_run: { run_id: 'wf_x', task_id: 'k', wave: null } }));
  const r = run(['decide', `--state=${p}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /non-integer wave/);
});
test('mark-task refuses an unknown id and an invalid status (MEDIUM: no phantom success)', () => {
  const p = tmpBundle(v8());
  const unknown = run(['mark-task', `--state=${p}`, '--id=99', '--status=done']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /no task with id/);
  assert.deepEqual(read(p).tasks.map((t) => t.status), ['pending', 'pending']); // unchanged
  const bad = run(['mark-task', `--state=${p}`, '--id=1', '--status=DONE']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /invalid --status/);
});
test('backfill-waves fails loud when a pending task stays wave-less (LOW: no phantom success)', () => {
  const dir = tmpDir('mp-bf2-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ tasks: [
    { id: 1, status: 'pending', wave: null, files: [] },
    { id: 2, status: 'pending', wave: null, files: [] },
  ] })));
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify([{ id: 1, wave: 0, files: ['a'] }])); // omits id 2
  const r = run(['backfill-waves', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /still have no integer wave/);
});
test('applyPlanIndex matches across id type (LOW: string plan id vs numeric state id)', () => {
  const state = { tasks: [{ id: 1, status: 'pending', wave: null, files: [] }] };
  const r = applyPlanIndex(state, [{ id: '1', wave: 3, files: ['x'] }]); // string id on the plan side
  assert.equal(r.tasks[0].wave, 3);
  assert.deepEqual(r.tasks[0].files, ['x']);
});

// ---- fresh-eyes review follow-up (2026-05-28): the set-active-run origin guard + backfill message ----
test('set-active-run refuses a non-integer wave at the origin (MEDIUM: a bad --wave never persists to wedge decide)', () => {
  const p = tmpBundle(v8());
  const bad = run(['set-active-run', `--state=${p}`, '--wave=2.0']); // float string — not an integer
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--wave must be an integer/);
  assert.equal(read(p).active_run, null); // state untouched — nothing persisted to throw on the next decide
  assert.notEqual(run(['set-active-run', `--state=${p}`, '--wave']).status, 0); // bare --wave (boolean) also refused
  // happy path still works: an integer wave writes the phase-1 launching marker
  assert.deepEqual(JSON.parse(run(['set-active-run', `--state=${p}`, '--wave=0']).stdout).active_run, { wave: 0, phase: 'launching' });
});
test('backfill-waves: a present-but-string wave is caught and named (LOW: message covers non-integer, not just missing)', () => {
  const dir = tmpDir('mp-bf3-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ tasks: [{ id: 1, status: 'pending', wave: null, files: [] }] })));
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify([{ id: 1, wave: '0', files: ['a'] }])); // wave is a STRING, not 0
  const r = run(['backfill-waves', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /non-integer wave value/); // the clarified message names this cause
});

// ============================================================================
// GitHub coordination CLI subcommands (§7.3) — task 6 additions
// ============================================================================

// ---- helpers ----
function makeIssueFixture(taskId, labels, depsOverride) {
  // Build a minimal issue object with a metadata-bearing body, suitable for CLI input.
  // The body encodes the given taskId + deps; callers supply labels.
  const task = { id: taskId, deps: depsOverride ?? [] };
  // Build the body by calling gh-issue-body via the CLI (A2 round-trip), so the helper
  // uses the same serialization path under test.
  const bodyResult = run(['gh-issue-body',
    `--task=${JSON.stringify(task)}`,
    '--run-slug=test-run',
  ]);
  if (bodyResult.status !== 0) throw new Error(`makeIssueFixture failed: ${bodyResult.stderr}`);
  return { body: bodyResult.stdout.trimEnd(), labels };
}

// ---- A2: gh-issue-body / parse-issue CLI round-trip ----
test('A2 CLI: gh-issue-body emits a markdown body containing the task metadata block', () => {
  const task = { id: 7, description: 'Implement coordinator', files: ['lib/github-coord.mjs'], verify_commands: ['node --test'], deps: ['3', '4'] };
  const r = run(['gh-issue-body',
    `--task=${JSON.stringify(task)}`,
    '--run-slug=my-run',
    '--contract-ref=mp-coord/my-run/abc123',
    '--integration-branch=mp-int/my-run',
    '--base-sha=deadbeef',
    '--plan-hash=abc123',
    '--wave=2',
  ]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /T7: Implement coordinator/);
  assert.match(r.stdout, /<!-- mp-coord-meta/);
  assert.match(r.stdout, /mp-coord-meta -->/);
  assert.match(r.stdout, /"run_slug":"my-run"/);
  assert.match(r.stdout, /"task_id":"7"/);
  assert.match(r.stdout, /"wave":2/);
});

test('A2 CLI: parse-issue reads body from stdin and returns parsed metadata JSON', () => {
  const task = { id: 42, description: 'parse me', files: ['x.mjs'], verify_commands: ['true'], deps: ['1'] };
  const bodyR = run(['gh-issue-body', `--task=${JSON.stringify(task)}`, '--run-slug=slugA', '--plan-hash=hash1', '--base-sha=sha1', '--wave=3']);
  assert.equal(bodyR.status, 0);
  // pipe the body back through parse-issue
  const parseR = run(['parse-issue'], { input: bodyR.stdout });
  assert.equal(parseR.status, 0);
  const meta = JSON.parse(parseR.stdout);
  assert.equal(meta.run_slug, 'slugA');
  assert.equal(meta.task_id, '42');
  assert.equal(meta.plan_hash, 'hash1');
  assert.equal(meta.base_sha, 'sha1');
  assert.equal(meta.wave, 3);
  assert.deepEqual(meta.files, ['x.mjs']);
  assert.deepEqual(meta.verify_commands, ['true']);
  assert.deepEqual(meta.deps, ['1']);
});

test('A2 CLI: gh-issue-body/parse-issue round-trip preserves all fields (end-to-end A2)', () => {
  const task = { id: 99, description: 'round-trip', files: ['a.mjs', 'b.mjs'], verify_commands: ['npm test', 'true'], deps: ['10', '11'] };
  const opts = { runSlug: 'rt-run', contractRef: 'mp-coord/rt-run/xyz', integrationBranch: 'mp-int/rt-run', baseSha: 'cafebabe', planHash: 'hashXYZ', wave: 5 };
  const bodyR = run(['gh-issue-body',
    `--task=${JSON.stringify(task)}`,
    `--run-slug=${opts.runSlug}`,
    `--contract-ref=${opts.contractRef}`,
    `--integration-branch=${opts.integrationBranch}`,
    `--base-sha=${opts.baseSha}`,
    `--plan-hash=${opts.planHash}`,
    `--wave=${opts.wave}`,
  ]);
  assert.equal(bodyR.status, 0);
  const parseR = run(['parse-issue'], { input: bodyR.stdout });
  assert.equal(parseR.status, 0);
  const meta = JSON.parse(parseR.stdout);
  assert.equal(meta.run_slug, opts.runSlug);
  assert.equal(meta.task_id, '99');
  assert.equal(meta.contract_ref, opts.contractRef);
  assert.equal(meta.integration_branch, opts.integrationBranch);
  assert.equal(meta.base_sha, opts.baseSha);
  assert.equal(meta.plan_hash, opts.planHash);
  assert.equal(meta.wave, opts.wave);
  assert.deepEqual(meta.files, task.files);
  assert.deepEqual(meta.verify_commands, task.verify_commands);
  assert.deepEqual(meta.deps, task.deps);
});

test('A2 CLI: gh-issue-body fails without --task; parse-issue fails on body without metadata block', () => {
  // missing --task
  const noTask = run(['gh-issue-body', '--run-slug=x']);
  assert.notEqual(noTask.status, 0);
  assert.match(noTask.stderr, /missing required --task/);
  // parse-issue on a plain body
  const noMeta = run(['parse-issue'], { input: 'just a plain issue body with no metadata\n' });
  assert.notEqual(noMeta.status, 0);
  assert.match(noMeta.stderr, /no mp-coord-meta block/);
});

// ---- A3: validate-claim accept/reject ----
test('A3 CLI: validate-claim returns won for sole assignee + mp:claimed label + no PRs', () => {
  const issue = { assignees: ['alice'], labels: ['mp:claimed'], state: 'open' };
  const r = run(['validate-claim', `--issue=${JSON.stringify(issue)}`, '--actor=alice', '--prs=[]']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).result, 'won');
});

test('A3 CLI: validate-claim returns lost when another assignee holds the claim', () => {
  const issue = { assignees: ['bob'], labels: ['mp:claimed'], state: 'open' };
  const r = run(['validate-claim', `--issue=${JSON.stringify(issue)}`, '--actor=alice']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).result, 'lost');
});

test('A3 CLI: validate-claim returns lost when label is mp:open (not yet claimed)', () => {
  const issue = { assignees: ['alice'], labels: ['mp:open'] };
  const r = run(['validate-claim', `--issue=${JSON.stringify(issue)}`, '--actor=alice']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).result, 'lost');
});

test('A3 CLI: validate-claim returns lost when an existing PR is present', () => {
  const issue = { assignees: ['alice'], labels: ['mp:claimed'], state: 'open' };
  const prs = [{ number: 42, state: 'open' }];
  const r = run(['validate-claim', `--issue=${JSON.stringify(issue)}`, '--actor=alice', `--prs=${JSON.stringify(prs)}`]);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).result, 'lost');
});

test('A3 CLI: validate-claim returns lost for multiple assignees (race condition)', () => {
  const issue = { assignees: ['alice', 'bob'], labels: ['mp:claimed'] };
  const r = run(['validate-claim', `--issue=${JSON.stringify(issue)}`, '--actor=alice']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).result, 'lost');
});

test('A3 CLI: validate-claim same-assignee re-claim returns won (idempotent recover)', () => {
  // alice re-claims after a crash — sole assignee, mp:claimed present, no existing PRs
  const issue = { assignees: ['alice'], labels: ['mp:claimed'], state: 'open' };
  const r = run(['validate-claim', `--issue=${JSON.stringify(issue)}`, '--actor=alice', '--prs=[]']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).result, 'won');
});

test('A3 CLI: validate-claim fails on missing required flags', () => {
  const issue = { assignees: ['alice'], labels: ['mp:claimed'] };
  const noActor = run(['validate-claim', `--issue=${JSON.stringify(issue)}`]);
  assert.notEqual(noActor.status, 0);
  assert.match(noActor.stderr, /missing required --actor/);
  const noIssue = run(['validate-claim', '--actor=alice']);
  assert.notEqual(noIssue.status, 0);
  assert.match(noIssue.stderr, /missing required --issue/);
});

// ---- A4: select-claimable disjoint-file and wave-order (dep satisfaction) guarantees ----
test('A4 CLI: select-claimable returns all open issues with no deps and no merged tasks', () => {
  const issues = [
    makeIssueFixture(1, ['mp:open']),
    makeIssueFixture(2, ['mp:open']),
  ];
  const r = run(['select-claimable', `--issues=${JSON.stringify(issues)}`, '--merged=[]']);
  assert.equal(r.status, 0);
  const { claimable } = JSON.parse(r.stdout);
  assert.equal(claimable.length, 2);
});

test('A4 CLI: select-claimable excludes claimed/pr-open/closed issues', () => {
  const issues = [
    makeIssueFixture(1, ['mp:open']),
    makeIssueFixture(2, ['mp:claimed']),
    makeIssueFixture(3, ['mp:pr-open']),
    makeIssueFixture(4, ['mp:closed']),
  ];
  const r = run(['select-claimable', `--issues=${JSON.stringify(issues)}`]);
  assert.equal(r.status, 0);
  const { claimable } = JSON.parse(r.stdout);
  assert.equal(claimable.length, 1);
  // Only task 1 (mp:open) is claimable
  const parseR = run(['parse-issue'], { input: claimable[0].body });
  assert.equal(JSON.parse(parseR.stdout).task_id, '1');
});

test('A4 CLI: wave-order guarantee — issues with unsatisfied deps are gated out', () => {
  // Issues for tasks in a later wave with deps on earlier wave tasks.
  // File-disjointness is a plan-build property; we assert dep-gating enforces wave ordering.
  const issues = [
    makeIssueFixture(10, ['mp:open'], ['5', '6']), // deps 5 and 6 not yet merged
    makeIssueFixture(11, ['mp:open'], ['5']),       // dep 5 not merged
    makeIssueFixture(12, ['mp:open'], []),           // no deps → claimable regardless of wave
  ];
  // No merged tasks → only task 12 (no deps) is claimable
  const blocked = run(['select-claimable', `--issues=${JSON.stringify(issues)}`, '--merged=[]']);
  assert.equal(blocked.status, 0);
  const blockedResult = JSON.parse(blocked.stdout);
  assert.equal(blockedResult.claimable.length, 1);
  const bMeta = JSON.parse(run(['parse-issue'], { input: blockedResult.claimable[0].body }).stdout);
  assert.equal(bMeta.task_id, '12');

  // Once deps 5 and 6 are merged, both tasks 10 and 11 become claimable
  const satisfied = run(['select-claimable', `--issues=${JSON.stringify(issues)}`, `--merged=${JSON.stringify(['5', '6'])}`]);
  assert.equal(satisfied.status, 0);
  assert.equal(JSON.parse(satisfied.stdout).claimable.length, 3);
});

test('A4 CLI: disjoint-file guarantee — two wave-0 tasks with distinct files are both claimable concurrently', () => {
  // File disjointness is a plan-build property (§6) — NOT computed by selectClaimableUnits.
  // This test verifies that the CLI returns both issues when no deps exist, confirming that
  // concurrent claiming is possible for disjoint-file tasks (the plan builder's guarantee survives
  // the selection step unchanged).
  const issues = [
    { ...makeIssueFixture(20, ['mp:open']), files: ['lib/a.mjs'] }, // disjoint file set
    { ...makeIssueFixture(21, ['mp:open']), files: ['lib/b.mjs'] }, // disjoint file set
  ];
  const r = run(['select-claimable', `--issues=${JSON.stringify(issues)}`, '--merged=[]']);
  assert.equal(r.status, 0);
  const { claimable } = JSON.parse(r.stdout);
  // Both are claimable — disjoint files means no concurrency risk
  assert.equal(claimable.length, 2);
});

test('A4 CLI: --plan-deps override wins over body deps', () => {
  // Issue body says dep '99' (not merged), but planIndexDeps says no deps for task 30
  const issues = [makeIssueFixture(30, ['mp:open'], ['99'])]; // body says dep 99
  const planDeps = { '30': [] }; // override: no deps
  const r = run(['select-claimable', `--issues=${JSON.stringify(issues)}`, `--plan-deps=${JSON.stringify(planDeps)}`]);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).claimable.length, 1, '--plan-deps override should make the issue claimable');
});

test('A4 CLI: select-claimable returns empty on non-array or empty issues', () => {
  const r = run(['select-claimable', '--issues=[]']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).claimable, []);
});

// ---- A6: reconcile-integration idempotence ----

function makeGhIssueForReconcile(taskId, merged, prNumber, mergeSha) {
  // Build a gh-style issue object whose body has the mp-coord-meta block for the given taskId.
  const bodyR = run(['gh-issue-body', `--task=${JSON.stringify({ id: taskId })}`, '--run-slug=run']);
  if (bodyR.status !== 0) throw new Error(`makeGhIssueForReconcile failed: ${bodyR.stderr}`);
  return {
    number: 100 + Number(taskId),
    body: bodyR.stdout.trimEnd(),
    state: merged ? 'closed' : 'open',
    labels: merged ? ['mp:closed'] : ['mp:pr-open'],
    pr: merged
      ? { merged: true, number: prNumber, merge_sha: mergeSha }
      : { merged: false, number: prNumber },
  };
}

test('A6 CLI: reconcile-integration emits mark_done for merged-but-not-local-done task', () => {
  const p = tmpBundle(v8({
    tasks: [
      { id: 1, status: 'pending', wave: 0, files: ['a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['b.txt'] },
    ],
    coordination: {
      issue_map: {
        '1': { issue: 101, pr: 201, merge_sha: null, status: 'pr-open' },
        '2': { issue: 102, pr: 202, merge_sha: null, status: 'pr-open' },
      },
    },
  }));
  const ghIssues = [
    makeGhIssueForReconcile('1', true, 201, 'sha-abc'),  // merged
    makeGhIssueForReconcile('2', false, 202, null),       // not merged
  ];
  const r = run(['reconcile-integration', `--state=${p}`], { input: JSON.stringify(ghIssues) });
  assert.equal(r.status, 0);
  const { actions } = JSON.parse(r.stdout);
  const markDone = actions.filter((a) => a.action === 'mark_done');
  assert.equal(markDone.length, 1);
  assert.equal(markDone[0].task_id, '1');
  assert.equal(markDone[0].merge_sha, 'sha-abc');
  // read-only: the bundle's task statuses are unchanged
  const state = read(p);
  assert.deepEqual(state.tasks.map((t) => t.status), ['pending', 'pending']);
});

test('A6 CLI: reconcile-integration emits surface for locally-done-but-not-merged task', () => {
  const p = tmpBundle(v8({
    tasks: [
      { id: 1, status: 'done', wave: 0, files: ['a.txt'] },  // done locally
      { id: 2, status: 'pending', wave: 1, files: ['b.txt'] },
    ],
    coordination: {
      issue_map: {
        '1': { issue: 101, pr: 201, merge_sha: null, status: 'pr-open' },
        '2': { issue: 102, pr: 202, merge_sha: null, status: 'pr-open' },
      },
    },
  }));
  const ghIssues = [
    makeGhIssueForReconcile('1', false, 201, null),  // NOT merged on GitHub
    makeGhIssueForReconcile('2', false, 202, null),
  ];
  const r = run(['reconcile-integration', `--state=${p}`], { input: JSON.stringify(ghIssues) });
  assert.equal(r.status, 0);
  const { actions } = JSON.parse(r.stdout);
  const surface = actions.filter((a) => a.action === 'surface');
  assert.equal(surface.length, 1);
  assert.equal(surface[0].task_id, '1');
  assert.equal(surface[0].reason, 'locally-done-but-not-merged');
});

test('A6 CLI: reconcile-integration idempotence — applying mark_done then re-running yields zero new mark_done', () => {
  const p = tmpBundle(v8({
    tasks: [
      { id: 1, status: 'pending', wave: 0, files: ['a.txt'] },
      { id: 2, status: 'pending', wave: 1, files: ['b.txt'] },
    ],
    coordination: {
      issue_map: {
        '1': { issue: 101, pr: 201, merge_sha: null, status: 'pr-open' },
        '2': { issue: 102, pr: 202, merge_sha: null, status: 'pr-open' },
      },
    },
  }));
  const ghIssues = [
    makeGhIssueForReconcile('1', true, 201, 'sha-abc'),
    makeGhIssueForReconcile('2', true, 202, 'sha-def'),
  ];
  // First reconcile: both tasks need mark_done
  const r1 = run(['reconcile-integration', `--state=${p}`], { input: JSON.stringify(ghIssues) });
  assert.equal(r1.status, 0);
  const actions1 = JSON.parse(r1.stdout).actions.filter((a) => a.action === 'mark_done');
  assert.equal(actions1.length, 2);

  // Apply the mark_done actions via mark-task (the shell would do this)
  for (const action of actions1) {
    const mr = run(['mark-task', `--state=${p}`, `--id=${action.task_id}`, '--status=done']);
    assert.equal(mr.status, 0);
  }

  // Second reconcile: same GitHub state, tasks now done → zero new mark_done
  const r2 = run(['reconcile-integration', `--state=${p}`], { input: JSON.stringify(ghIssues) });
  assert.equal(r2.status, 0);
  const markDone2 = JSON.parse(r2.stdout).actions.filter((a) => a.action === 'mark_done');
  assert.equal(markDone2.length, 0, 'idempotent: no new mark_done actions after applying them');
});

test('A6 CLI: reconcile-integration emits no actions when local and GitHub agree (both done)', () => {
  const p = tmpBundle(v8({
    tasks: [{ id: 1, status: 'done', wave: 0, files: ['a.txt'] }],
    coordination: {
      issue_map: { '1': { issue: 101, pr: 201, merge_sha: 'sha-xyz', status: 'merged' } },
    },
  }));
  const ghIssues = [makeGhIssueForReconcile('1', true, 201, 'sha-xyz')];
  const r = run(['reconcile-integration', `--state=${p}`], { input: JSON.stringify(ghIssues) });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).actions, []);
});

// ---- coord-status: READ-ONLY snapshot ----
test('coord-status: returns null coordination when not a coordinated run', () => {
  const p = tmpBundle(v8()); // no coordination field
  const r = run(['coord-status', `--state=${p}`]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { coordination: null });
});

test('coord-status: returns the coordination object when present', () => {
  const coord = {
    mode: 'github',
    contract_ref: 'mp-coord/my-run/abc',
    integration_branch: 'mp-int/my-run',
    current_wave: 1,
    published_waves: [0],
    issue_map: {},
  };
  const p = tmpBundle(v8({ coordination: coord }));
  const r = run(['coord-status', `--state=${p}`]);
  assert.equal(r.status, 0);
  const { coordination } = JSON.parse(r.stdout);
  assert.equal(coordination.mode, 'github');
  assert.equal(coordination.contract_ref, 'mp-coord/my-run/abc');
  assert.equal(coordination.integration_branch, 'mp-int/my-run');
  assert.equal(coordination.current_wave, 1);
  assert.deepEqual(coordination.published_waves, [0]);
});

test('coord-status: is read-only (does not write to state)', () => {
  const p = tmpBundle(v8());
  const before = fs.readFileSync(p, 'utf8');
  run(['coord-status', `--state=${p}`]);
  const after = fs.readFileSync(p, 'utf8');
  assert.equal(before, after, 'coord-status must not modify the bundle');
});

// --- prepare-wave: state.implementer threads to a per-task backend descriptor (the bin wire) ---
// wave.test passes config directly; THIS proves the state.implementer -> config -> backend wire
// through the real CLI. buildSeedState never emits `implementer`, so the default is byte-identical.
//
// loadPlanTasks seeds state.tasks[].files FROM plan.index (lib/bundle.mjs), so a REAL bundle's state
// and plan file sets are identical by construction. The generic v8() uses a.txt/b.txt while
// planIndexFixture() uses src/*.mjs — independently authored, a shape that never co-occurs live — so
// these align the state files to the plan fixture, the in-sync shape prepareWave's dispatch-time
// plan/state divergence gate (lib/wave.mjs) expects. (Waves stay v8's: task 1 wave 0, task 2 wave 1.)
const v8AlignedToPlanFixture = (over = {}) => v8({
  tasks: [
    { id: 1, status: 'pending', wave: 0, files: ['src/greet.mjs'] },
    { id: 2, status: 'pending', wave: 1, files: ['src/farewell.mjs'] },
  ],
  ...over,
});
test('prepare-wave: default (no implementer in state) -> every payload task carries backend {kind:agent}', () => {
  const dir = tmpDir('mp-backend-default-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8AlignedToPlanFixture()));  // task 1 wave 0 (files match plan)
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  const pw = JSON.parse(run(['prepare-wave', `--state=${p}`, `--plan-index=${planIdx}`, '--wave=0']).stdout);
  assert.ok(pw.tasks.length >= 1);
  for (const t of pw.tasks) assert.deepEqual(t.backend, { kind: 'agent' });
});

test('prepare-wave: qctl.enabled=true with no --repos-allowlist wired -> backend {kind:agent} (predicate dormant until flip-time loader)', () => {
  // bin/masterplan.mjs calls prepareWave with 5 args (no reposAllowlist) — the production
  // allowlist loader is a deliberate flip-time precondition (see plan.index task C.flag-flip),
  // NOT implemented in this build. With the flag on but no allowlist threaded through, the
  // qctlEligible gate (lib/wave.mjs) fail-closes and downgrades {kind:qctl} -> {kind:agent}.
  // The qctl-positive descriptor (scope==task.files, deliver=patch) is proven at the lib level
  // in test/wave.test.mjs with a fixture allowlist passed directly to prepareWave.
  const dir = tmpDir('mp-backend-qctl-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8AlignedToPlanFixture({ implementer: { qctl: { enabled: true } } })));
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  const pw = JSON.parse(run(['prepare-wave', `--state=${p}`, `--plan-index=${planIdx}`, '--wave=0']).stdout);
  const t1 = pw.tasks.find((t) => t.id === 1);
  assert.deepEqual(t1.backend, { kind: 'agent' });
});

// flag-flip precondition #5: the production --repos-allowlist loader. prepare-wave now parses an
// optional --repos-allowlist (JSON = parsed repos.yml) and threads it as prepareWave's 6th arg, so
// with the flag ON the qctlEligible gate can finally pass. This is the wire the line-1025 test noted
// as deliberately absent; it is now present.
test('prepare-wave: qctl.enabled=true WITH --repos-allowlist covering the task files -> backend {kind:qctl}', () => {
  const dir = tmpDir('mp-backend-qctl-allow-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8AlignedToPlanFixture({ implementer: { qctl: { enabled: true } } })));
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  // task 1's plan.index files are ['src/greet.mjs'] (verify ['true'], non-infra) — covered by the glob.
  const allowlist = JSON.stringify({ 'test-repo': { scope: ['src/greet.mjs', 'src/**'] } });

  const pw = JSON.parse(run([
    'prepare-wave', `--state=${p}`, `--plan-index=${planIdx}`, '--wave=0', `--repos-allowlist=${allowlist}`,
  ]).stdout);
  const t1 = pw.tasks.find((t) => t.id === 1);
  assert.equal(t1.backend.kind, 'qctl');
  assert.deepEqual(t1.backend.scope, ['src/greet.mjs']);   // task 1's plan.index files
  assert.deepEqual(t1.backend.verify, ['true']);           // task 1's verify_commands
  assert.equal(t1.backend.deliver, 'patch');

  // Negative control: the gate is genuinely consulted (not flag-only). An allowlist that does NOT
  // cover the files fail-closes back to {kind:agent} even with the flag on AND parsed.
  const noCover = JSON.stringify({ 'test-repo': { scope: ['other/**'] } });
  const pw2 = JSON.parse(run([
    'prepare-wave', `--state=${p}`, `--plan-index=${planIdx}`, '--wave=0', `--repos-allowlist=${noCover}`,
  ]).stdout);
  assert.deepEqual(pw2.tasks.find((t) => t.id === 1).backend, { kind: 'agent' });
});

test('prepare-wave: a malformed --repos-allowlist (not JSON) exits non-zero with a hint', () => {
  const dir = tmpDir('mp-backend-qctl-badjson-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8AlignedToPlanFixture({ implementer: { qctl: { enabled: true } } })));
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  const r = run(['prepare-wave', `--state=${p}`, `--plan-index=${planIdx}`, '--wave=0', '--repos-allowlist=not-json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /repos-allowlist.*JSON/);
});

// ---- qctl async-loop subcommands (§6) ----

// ---- record-qctl-job: durable job_id persistence (the CD-7 single-writer path) ----
test('record-qctl-job: round-trips a durable job_id to state.qctl_jobs[task_id]', () => {
  const p = tmpBundle(v8());
  const r = run(['record-qctl-job', `--state=${p}`, '--task-id=1', '--job-id=qwen-job-0042', '--key=abc123']);
  assert.equal(r.status, 0, `expected exit 0, got stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.task_id, '1');
  assert.equal(out.job_id, 'qwen-job-0042');
  assert.equal(out.key, 'abc123');

  // Verify durable persistence: the key round-trips through serializeState/parseState
  const state = read(p);
  assert.ok(state.qctl_jobs && typeof state.qctl_jobs === 'object', 'qctl_jobs must be persisted');
  assert.equal(state.qctl_jobs['1'].job_id, 'qwen-job-0042');
  assert.equal(state.qctl_jobs['1'].key, 'abc123');
});

test('record-qctl-job: idempotent re-write with same data (overwrite is byte-identical)', () => {
  const p = tmpBundle(v8());
  run(['record-qctl-job', `--state=${p}`, '--task-id=2', '--job-id=qwen-job-0099', '--key=deadbeef']);
  // Second call with identical args
  const r2 = run(['record-qctl-job', `--state=${p}`, '--task-id=2', '--job-id=qwen-job-0099', '--key=deadbeef']);
  assert.equal(r2.status, 0);
  const state = read(p);
  assert.equal(state.qctl_jobs['2'].job_id, 'qwen-job-0099');
  assert.equal(state.qctl_jobs['2'].key, 'deadbeef');
});

test('record-qctl-job: multiple tasks stored independently', () => {
  const p = tmpBundle(v8());
  run(['record-qctl-job', `--state=${p}`, '--task-id=1', '--job-id=job-A', '--key=key-A']);
  run(['record-qctl-job', `--state=${p}`, '--task-id=2', '--job-id=job-B', '--key=key-B']);
  const state = read(p);
  assert.equal(state.qctl_jobs['1'].job_id, 'job-A');
  assert.equal(state.qctl_jobs['2'].job_id, 'job-B');
});

test('record-qctl-job: fails on missing required flags', () => {
  const p = tmpBundle(v8());
  const noJobId = run(['record-qctl-job', `--state=${p}`, '--task-id=1', '--key=k']);
  assert.notEqual(noJobId.status, 0);
  assert.match(noJobId.stderr, /missing required --job-id/);
  const noKey = run(['record-qctl-job', `--state=${p}`, '--task-id=1', '--job-id=j']);
  assert.notEqual(noKey.status, 0);
  assert.match(noKey.stderr, /missing required --key/);
});

// ---- enqueue-key: idempotency check (upsert → record → reuse) ----
test('enqueue-key: no prior job -> action:upsert with key, job:null', () => {
  const p = tmpBundle(v8());
  const r = run(['enqueue-key', `--state=${p}`, '--run-slug=my-run', '--wave=0', '--task-id=1', '--base=abc123sha']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, 'upsert');
  assert.match(out.key, /^[0-9a-f]{64}$/);
  assert.equal(out.job, null);
});

test('enqueue-key: idempotent under a repeated call — record-qctl-job then re-enqueue -> action:reuse', () => {
  const p = tmpBundle(v8());
  // First call: no job stored yet → upsert
  const r1 = run(['enqueue-key', `--state=${p}`, '--run-slug=my-run', '--wave=0', '--task-id=1', '--base=sha-abc', '--scope=["lib/a.mjs"]']);
  assert.equal(r1.status, 0);
  const out1 = JSON.parse(r1.stdout);
  assert.equal(out1.action, 'upsert');

  // Shell "mints" a job_id and persists it
  const fakeJobId = 'qwen-job-0001';
  const recR = run(['record-qctl-job', `--state=${p}`, '--task-id=1', `--job-id=${fakeJobId}`, `--key=${out1.key}`]);
  assert.equal(recR.status, 0);

  // Second call with SAME tuple → action:reuse, job contains the stored entry
  const r2 = run(['enqueue-key', `--state=${p}`, '--run-slug=my-run', '--wave=0', '--task-id=1', '--base=sha-abc', '--scope=["lib/a.mjs"]']);
  assert.equal(r2.status, 0);
  const out2 = JSON.parse(r2.stdout);
  assert.equal(out2.action, 'reuse', 'same tuple after record-qctl-job must return reuse');
  assert.equal(out2.job.job_id, fakeJobId);
  assert.equal(out2.key, out1.key, 'key must be stable across repeated calls with same inputs');
});

test('enqueue-key: drifted base SHA -> action:upsert (new identity)', () => {
  const p = tmpBundle(v8());
  // Record a job for the first base
  const r1 = run(['enqueue-key', `--state=${p}`, '--run-slug=my-run', '--wave=0', '--task-id=1', '--base=base-sha-1']);
  const key1 = JSON.parse(r1.stdout).key;
  run(['record-qctl-job', `--state=${p}`, '--task-id=1', '--job-id=job-1', `--key=${key1}`]);
  // Now call with a DIFFERENT base SHA — must upsert (new identity)
  const r2 = run(['enqueue-key', `--state=${p}`, '--run-slug=my-run', '--wave=0', '--task-id=1', '--base=base-sha-2']);
  assert.equal(r2.status, 0);
  const out2 = JSON.parse(r2.stdout);
  assert.equal(out2.action, 'upsert', 'drifted base must trigger upsert');
  assert.notEqual(out2.key, key1);
});

// ---- artifact-verify: integrity check and digest projection ----
test('artifact-verify: verifyArtifact mode — matching digest -> ok:true', () => {
  const dir = tmpDir('mp-av-');
  const patchContent = '--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-old\n+new\n';
  const patchFile = path.join(dir, 'patch.txt');
  fs.writeFileSync(patchFile, patchContent);
  const declared = createHash('sha256').update(patchContent, 'utf8').digest('hex');
  const r = run(['artifact-verify', `--declared-sha256=${declared}`, `--bytes-file=${patchFile}`]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.reason, null);
});

test('artifact-verify: verifyArtifact mode — mismatched digest -> ok:false, reason:sha256-mismatch', () => {
  const dir = tmpDir('mp-av2-');
  const patchFile = path.join(dir, 'patch.txt');
  fs.writeFileSync(patchFile, 'correct bytes');
  const wrongDigest = 'a'.repeat(64);
  const r = run(['artifact-verify', `--declared-sha256=${wrongDigest}`, `--bytes-file=${patchFile}`]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'sha256-mismatch');
});

test('artifact-verify: parseQctlDigest mode (--result=JSON) -> task_id + status + files_changed + summary', () => {
  const result = JSON.stringify({ task_id: 5, status: 'accepted', files_changed: ['a.mjs'], summary: 'ok', extra: 'ignored' });
  const r = run(['artifact-verify', `--result=${result}`]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.task_id, 5);
  assert.equal(out.status, 'accepted');
  assert.deepEqual(out.files_changed, ['a.mjs']);
  assert.equal(out.summary, 'ok');
  // extra fields are dropped
  assert.ok(!('extra' in out));
});

// ---- status-map: §6.2 qctl producer status mapping ----
test('status-map: accepted -> task_status:done, flags:[]', () => {
  const r = run(['status-map', '--producer-status=accepted']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.task_status, 'done');
  assert.deepEqual(out.flags, []);
  assert.equal(out.producer_status, 'accepted');
});

test('status-map: review -> task_status:done, flags:[claude-review]', () => {
  const r = run(['status-map', '--producer-status=review']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.task_status, 'done');
  assert.deepEqual(out.flags, ['claude-review']);
});

test('status-map: dead-letter -> task_status:failed', () => {
  const r = run(['status-map', '--producer-status=dead-letter']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).task_status, 'failed');
});

test('status-map: accepted + apply-ok=false -> task_status:blocked (override)', () => {
  const r = run(['status-map', '--producer-status=accepted', '--apply-ok=false']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).task_status, 'blocked');
});

test('status-map: accepted + d6-ok=false -> task_status:failed (override)', () => {
  const r = run(['status-map', '--producer-status=accepted', '--d6-ok=false']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).task_status, 'failed');
});

// ---- base-drift: §6.3 base-drift requeue decision ----
test('base-drift: matching SHAs -> action:apply, requeueBase:null', () => {
  const r = run(['base-drift', '--recorded-base=abc123', '--current-head=abc123']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, 'apply');
  assert.equal(out.requeueBase, null);
});

test('base-drift: differing SHAs -> action:requeue, requeueBase=currentHead', () => {
  const r = run(['base-drift', '--recorded-base=old-sha', '--current-head=new-sha']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, 'requeue');
  assert.equal(out.requeueBase, 'new-sha');
});

test('base-drift: missing recorded-base -> action:requeue (safety-first)', () => {
  const r = run(['base-drift', '--recorded-base=', '--current-head=some-head']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).action, 'requeue');
});
