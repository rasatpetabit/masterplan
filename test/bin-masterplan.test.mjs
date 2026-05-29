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
import { formatBanner, applyPlanIndex } from '../bin/masterplan.mjs';
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
  assert.equal(read(p).schema_version, '6.0');
  assert.equal(JSON.parse(run(['migrate-bundle', `--state=${p}`]).stdout).migrated, false); // idempotent
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

// ---- integration: CD-7 single-writer ops ----
test('mark-task: write updates status; decide then advances to the next wave', () => {
  const p = tmpBundle(v8());
  run(['mark-task', `--state=${p}`, '--id=1', '--status=done']);
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'done');
  assert.equal(JSON.parse(run(['decide', `--state=${p}`]).stdout).wave, 1);
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
