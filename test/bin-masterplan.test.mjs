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
  const lines = fs.readFileSync(ep, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { type: 'seeded', ts: 'T1', phase: 'brainstorm' });
  assert.deepEqual(JSON.parse(lines[1]), { type: 'gate_opened', ts: 'T2', data: { id: 'plan_approval' } });
});
test('event: rejects non-JSON --data', () => {
  const p = path.join(tmpDir('mp-event2-'), 'state.yml');
  const r = run(['event', `--state=${p}`, '--type=x', '--data=not json']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be valid JSON/);
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
