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
import { formatBanner, applyPlanIndex, readPluginVersion, shouldSuppressWorkflow } from '../bin/masterplan.mjs';
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
// Satisfy a pre-execute gate the honest way: mint a structured receipt for the gate's CURRENT artifacts
// and record it as done so enforceGateReview lets the transition proceed — exercising the real gate-
// satisfied path, NEVER --force. The gate is fail-closed (required artifacts must exist on disk), so we
// stub spec.md / plan.md / plan.index.json if the fixture didn't create them; `ensure` never clobbers a
// file the test wrote. We learn the exact { hash, artifacts } via `gate-hash` and echo them into the
// receipt (the same --plan-md/--plan-index in `extra` go to both, so the hashes match). Asserts it landed.
function passGate(statePath, gate, extra = []) {
  const dir = path.dirname(statePath);
  const ensure = (name, content) => {
    const fp = path.join(dir, name);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, content);
  };
  ensure('spec.md', '# spec\nstub spec for gate test\n');
  if (gate === 'plan') {
    ensure('plan.md', '# plan\nstub plan for gate test\n');
    ensure('plan.index.json', JSON.stringify({ schema_version: '6.0', tasks: [] }));
  }
  const gh = run(['gate-hash', `--state=${statePath}`, `--gate=${gate}`, ...extra]);
  assert.equal(gh.status, 0, `passGate(${gate}) gate-hash must succeed: ${gh.stderr}`);
  const { hash, artifacts } = JSON.parse(gh.stdout);
  const receiptPath = path.join(dir, `gate-${gate}-receipt.json`);
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      gate,
      hash,
      artifacts,
      dispatch_id: 'test-dispatch',
      provider: 'test',
      model: 'test-model',
      output_tokens: 1,
      status: 'done',
      ts: '2026-01-01T00:00:00Z',
      digest: 'test findings: none blocking',
    })
  );
  const r = run([
    'record-gate-review',
    `--state=${statePath}`,
    `--gate=${gate}`,
    '--status=done',
    `--receipt=${receiptPath}`,
    ...extra,
  ]);
  assert.equal(r.status, 0, `passGate(${gate}) must record cleanly: ${r.stderr}`);
}
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

test('shouldSuppressWorkflow: Pi/no-workflow hosts use foreground dispatch instead of launch_workflow', () => {
  assert.equal(shouldSuppressWorkflow({}, {}), false);
  assert.equal(shouldSuppressWorkflow({ 'codex-suppressed': true }, {}), true);
  assert.equal(shouldSuppressWorkflow({ 'no-workflow': true }, {}), true);
  assert.equal(shouldSuppressWorkflow({}, { PI_CODING_AGENT: 'true' }), true);
  assert.equal(shouldSuppressWorkflow({}, { PI_CODING_AGENT: 'false' }), false);
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
test('detect-host: codex signal -> isCodex true; none -> false', () => {
  const yes = JSON.parse(run(['detect-host', '--agent-is-codex']).stdout);
  assert.equal(yes.isCodex, true);
  const no = JSON.parse(run(['detect-host']).stdout);
  assert.equal(no.isCodex, false);
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

  passGate(p, 'plan');
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

// ---- integration: plan.html render artifact (auto-emit at load-plan + the render-plan verb) ----
test('load-plan: also auto-emits a static plan.html (minimal bundle: no spec.md/plan.md needed)', () => {
  const dir = tmpDir('mp-loadplan-html-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ phase: 'plan', tasks: [], slug: 'demo-run' })));
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));

  passGate(p, 'plan');
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 0);
  const html = fs.readFileSync(path.join(dir, 'plan.html'), 'utf8');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('greet') && html.includes('farewell') && html.includes('index'));
  assert.ok(html.includes('badge status-pending'), 'freshly materialized tasks render as pending');
  assert.ok(html.includes('demo-run'), 'title derives from the bundle slug');
  // self-containment / headless-safety: no executable or remote-resource markup
  assert.ok(!/<(script|img|iframe|link)\b/i.test(html), 'no script/img/iframe/link tags');
});

test('load-plan: a plan.html write failure is swallowed and never fails the atomic state write', () => {
  const dir = tmpDir('mp-loadplan-htmlfail-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ phase: 'plan', tasks: [] })));
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  fs.mkdirSync(path.join(dir, 'plan.html')); // EISDIR on write → forces a render/write failure

  passGate(p, 'plan');
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 0, 'load-plan must succeed despite the artifact write failure');
  assert.deepEqual(JSON.parse(r.stdout), { loaded: 3, waves: 2, phase: 'execute' });
  assert.equal(read(p).phase, 'execute'); // the state transition still landed
});

test('render-plan: writes plan.html with live status from state.tasks and leaves state.yml byte-unchanged', () => {
  const dir = tmpDir('mp-render-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({
    phase: 'execute',
    slug: 'live-run',
    tasks: [
      { id: 1, status: 'done', wave: 0, files: ['a.txt'] },
      { id: 2, status: 'failed', wave: 1, files: ['b.txt'] },
      { id: 3, status: 'in_progress', wave: 1, files: ['c.txt'] }, // not in the badge whitelist
    ],
  })));
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify({
    schema_version: '6.0',
    tasks: [
      { id: 1, wave: 0, description: 'first', files: ['a.txt'], verify_commands: ['true'], codex: null },
      { id: 2, wave: 1, description: 'second', files: ['b.txt'], verify_commands: ['true'], codex: null },
      { id: 3, wave: 1, description: 'third', files: ['c.txt'], verify_commands: ['true'], codex: null },
    ],
  }));
  const before = fs.readFileSync(p);

  const r = run(['render-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 0);
  const html = fs.readFileSync(path.join(dir, 'plan.html'), 'utf8');
  assert.ok(html.includes('badge status-done'), 'task 1 → done');
  assert.ok(html.includes('badge status-failed'), 'task 2 → failed');
  assert.ok(html.includes('badge status-pending'), 'task 3 unknown status → pending fallback');
  assert.ok(!html.includes('badge status-in_progress'), 'unknown status never becomes a badge class');
  assert.ok(html.includes('live-run'), 'title from slug');

  assert.deepEqual(fs.readFileSync(p), before, 'render-plan must not mutate state.yml (read-only)');
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
  passGate(withTasks, 'plan');
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

test('mark-task: --status=blocked requires --reason and attaches block_reason', () => {
  const p = tmpBundle(v8());
  // missing --reason -> refused (so a block is always diagnosable later)
  const noReason = run(['mark-task', `--state=${p}`, '--id=1', '--status=blocked']);
  assert.notEqual(noReason.status, 0, 'blocked without --reason must fail');
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'pending', 'state unchanged on refusal');
  // with --reason -> block_reason recorded
  const ok = run(['mark-task', `--state=${p}`, '--id=1', '--status=blocked', '--reason=HIL GPU offline']);
  assert.equal(ok.status, 0, ok.stderr);
  const t = read(p).tasks.find((x) => x.id === 1);
  assert.equal(t.status, 'blocked');
  assert.equal(t.block_reason, 'HIL GPU offline');
});

test('mark-task: --status=waived is refused (waived is waive-task-only)', () => {
  const p = tmpBundle(v8());
  const r = run(['mark-task', `--state=${p}`, '--id=1', '--status=waived']);
  assert.notEqual(r.status, 0, 'mark-task --status=waived must be refused');
  assert.match(r.stderr, /waive-task/);
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'pending', 'state unchanged on refusal');
});

test('mark-task: --status=blocked under a live active_run requires --force (emits audit event)', () => {
  // task 1 is in-flight under an active_run whose task_id covers it
  const p = tmpBundle(v8({ active_run: { run_id: 'wf_1', task_id: '1', wave: 0, phase: 'running' } }));
  const refused = run(['mark-task', `--state=${p}`, '--id=1', '--status=blocked', '--reason=halt']);
  assert.notEqual(refused.status, 0, 'blocking an in-flight task without --force must fail');
  assert.match(refused.stderr, /active_run|--force/);
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'pending', 'state unchanged on refusal');
  // --force proceeds AND emits the task_blocked_under_active_run audit event
  const eventsBefore = fs.existsSync(path.join(path.dirname(p), 'events.jsonl'))
    ? fs.readFileSync(path.join(path.dirname(p), 'events.jsonl'), 'utf8').trim().split('\n').length
    : 0;
  const forced = run(['mark-task', `--state=${p}`, '--id=1', '--status=blocked', '--reason=halt', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'blocked');
  const eventsAfter = fs.readFileSync(path.join(path.dirname(p), 'events.jsonl'), 'utf8').trim().split('\n');
  assert.ok(eventsAfter.length > eventsBefore, 'a task_blocked_under_active_run event was appended');
  assert.ok(eventsAfter.some((l) => l.includes('task_blocked_under_active_run')));
});

// ---- waive-task: the ONLY writer of status:'waived' (blocked-only, --reason required) ----
test('waive-task: waives a blocked task, sets waive_reason, emits task_waived event', () => {
  const p = tmpBundle(v8());
  // First block the task
  run(['mark-task', `--state=${p}`, '--id=1', '--status=blocked', '--reason=HIL GPU offline']);
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'blocked');
  // Now waive it
  const r = run(['waive-task', `--state=${p}`, '--id=1', '--reason=HIL permanently decommissioned']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.waived, [1]);
  const st = read(p);
  const t = st.tasks.find((x) => x.id === 1);
  assert.equal(t.status, 'waived');
  assert.equal(t.waive_reason, 'HIL permanently decommissioned');
  assert.ok(!('block_reason' in t), 'block_reason deleted on waive');
  // event emitted
  const events = fs.readFileSync(path.join(path.dirname(p), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const waived = events.filter((e) => e.type === 'task_waived');
  assert.equal(waived.length, 1);
  assert.equal(waived[0].data.id, 1);
  assert.equal(waived[0].data.reason, 'HIL permanently decommissioned');
  assert.match(waived[0].summary, /task 1 waived/);
});

test('waive-task --all: waives every blocked task, one event each; non-blocked tasks untouched', () => {
  const p = tmpBundle(v8({ tasks: [
    { id: 1, status: 'blocked', wave: 0, files: ['a.txt'], block_reason: 'HIL down' },
    { id: 2, status: 'blocked', wave: 0, files: ['b.txt'], block_reason: 'HIL down' },
    { id: 3, status: 'pending', wave: 1, files: ['c.txt'] },
  ] }));
  const r = run(['waive-task', `--state=${p}`, '--all', '--reason=HIL permanently decommissioned']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).waived.sort((a, b) => a - b), [1, 2]);
  const st = read(p);
  assert.equal(st.tasks.find((t) => t.id === 1).status, 'waived');
  assert.equal(st.tasks.find((t) => t.id === 2).status, 'waived');
  assert.equal(st.tasks.find((t) => t.id === 3).status, 'pending', 'non-blocked task untouched');
  assert.equal(st.tasks.find((t) => t.id === 1).waive_reason, 'HIL permanently decommissioned');
  assert.ok(!('block_reason' in st.tasks.find((t) => t.id === 1)), 'block_reason deleted');
  // one task_waived event per waived task
  const events = fs.readFileSync(path.join(path.dirname(p), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const waived = events.filter((e) => e.type === 'task_waived');
  assert.equal(waived.length, 2);
});

test('waive-task: refuses a non-blocked task (pending/done/in_progress) with state unchanged', () => {
  const p = tmpBundle(v8({ tasks: [
    { id: 1, status: 'pending', wave: 0, files: ['a.txt'] },
    { id: 2, status: 'done', wave: 0, files: ['b.txt'] },
    { id: 3, status: 'in_progress', wave: 0, files: ['c.txt'] },
  ] }));
  // pending
  const rp = run(['waive-task', `--state=${p}`, '--id=1', '--reason=test']);
  assert.notEqual(rp.status, 0, 'pending task must be refused');
  assert.match(rp.stderr, /status 'pending'/);
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'pending', 'unchanged');
  // done
  const rd = run(['waive-task', `--state=${p}`, '--id=2', '--reason=test']);
  assert.notEqual(rd.status, 0, 'done task must be refused');
  assert.match(rd.stderr, /status 'done'/);
  assert.equal(read(p).tasks.find((t) => t.id === 2).status, 'done', 'unchanged');
  // in_progress
  const ri = run(['waive-task', `--state=${p}`, '--id=3', '--reason=test']);
  assert.notEqual(ri.status, 0, 'in_progress task must be refused');
  assert.match(ri.stderr, /status 'in_progress'/);
  assert.equal(read(p).tasks.find((t) => t.id === 3).status, 'in_progress', 'unchanged');
});

test('waive-task: --reason is required (missing/empty -> non-zero exit)', () => {
  const p = tmpBundle(v8({ tasks: [{ id: 1, status: 'blocked', wave: 0, files: ['a.txt'], block_reason: 'x' }] }));
  // missing
  const noReason = run(['waive-task', `--state=${p}`, '--id=1']);
  assert.notEqual(noReason.status, 0, 'missing --reason must fail');
  assert.match(noReason.stderr, /--reason is required/);
  // empty/whitespace
  const emptyReason = run(['waive-task', `--state=${p}`, '--id=1', '--reason=  ']);
  assert.notEqual(emptyReason.status, 0, 'empty --reason must fail');
  assert.match(emptyReason.stderr, /--reason is required/);
  // state unchanged
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'blocked');
});

test('waive-task: refuses under a live active_run without --force; --force succeeds + emits audit event', () => {
  const p = tmpBundle(v8({ tasks: [
    { id: 1, status: 'blocked', wave: 0, files: ['a.txt'], block_reason: 'x' },
  ], active_run: { run_id: 'wf_1', task_id: '1', wave: 0, phase: 'running' } }));
  // refused without --force
  const refused = run(['waive-task', `--state=${p}`, '--id=1', '--reason=halt']);
  assert.notEqual(refused.status, 0, 'waiving under active_run without --force must fail');
  assert.match(refused.stderr, /active_run|--force/);
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'blocked', 'state unchanged on refusal');
  // succeeds with --force
  const forced = run(['waive-task', `--state=${p}`, '--id=1', '--reason=halt', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'waived');
  // audit event emitted
  const events = fs.readFileSync(path.join(path.dirname(p), 'events.jsonl'), 'utf8').trim().split('\n');
  assert.ok(events.some((l) => l.includes('task_blocked_under_active_run')), 'audit event emitted');
  assert.ok(events.some((l) => l.includes('task_waived')), 'task_waived event emitted');
});

// ---- amend-tasks (D4): status-preserving upsert (mp amend-tasks) ----
function writeIdx(tasks) {
  const d = tmpDir('mp-idx-');
  const ip = path.join(d, 'plan.index.json');
  fs.writeFileSync(ip, JSON.stringify({ schema_version: 1, tasks, plan_hash: 'x', generated_at: 't' }));
  return ip;
}
test('amend-tasks: appends new ids as pending, refreshes existing, PRESERVES status + reasons', () => {
  const p = tmpBundle(v8({ tasks: [
    { id: 1, status: 'done', wave: 0, files: ['old1.txt'] },
    { id: 2, status: 'blocked', wave: 1, files: ['old2.txt'], block_reason: 'HIL' },
  ] }));
  const idx = writeIdx([
    { id: 1, wave: 9, files: ['new1.txt'] }, // existing -> refresh, keep done
    { id: 2, wave: 8, files: ['new2.txt'] }, // existing -> refresh, keep blocked+reason
    { id: 5, wave: 3, files: ['c.mjs'] },    // new -> append pending
  ]);
  const r = run(['amend-tasks', `--state=${p}`, `--plan-index=${idx}`]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.amend_tasks, 'upserted');
  assert.deepEqual(out.appended, [5]);
  assert.deepEqual(out.refreshed.sort(), [1, 2]);
  assert.deepEqual(out.pruned, []);
  const st = read(p);
  const t1 = st.tasks.find((x) => x.id === 1);
  assert.equal(t1.status, 'done'); assert.equal(t1.wave, 9); assert.deepEqual(t1.files, ['new1.txt']);
  const t2 = st.tasks.find((x) => x.id === 2);
  assert.equal(t2.status, 'blocked'); assert.equal(t2.block_reason, 'HIL'); assert.equal(t2.wave, 8);
  const t5 = st.tasks.find((x) => x.id === 5);
  assert.equal(t5.status, 'pending'); assert.equal(t5.wave, 3);
});

test('amend-tasks: absent ids kept verbatim by default; --prune drops bare pending only', () => {
  const base = () => v8({ tasks: [
    { id: 1, status: 'done', wave: 0, files: [] },
    { id: 2, status: 'pending', wave: 1, files: ['x.txt'] }, // bare pending
  ] });
  const idx = writeIdx([{ id: 1, wave: 0, files: [] }]); // id 2 absent
  const p1 = tmpBundle(base());
  const r1 = run(['amend-tasks', `--state=${p1}`, `--plan-index=${idx}`]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(read(p1).tasks.find((t) => t.id === 2).status, 'pending'); // kept
  assert.deepEqual(JSON.parse(r1.stdout).pruned, []);
  const p2 = tmpBundle(base());
  const r2 = run(['amend-tasks', `--state=${p2}`, `--plan-index=${idx}`, '--prune']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout).pruned, [2]);
  assert.equal(read(p2).tasks.find((t) => t.id === 2), undefined); // dropped
});

test('amend-tasks --prune: refuses accumulated state w/o --prune-non-pending (exit 1, unchanged)', () => {
  const p = tmpBundle(v8({ tasks: [
    { id: 1, status: 'done', wave: 0, files: [] }, // accumulated
  ] }));
  const idx = writeIdx([]); // id 1 absent
  const rRefuse = run(['amend-tasks', `--state=${p}`, `--plan-index=${idx}`, '--prune']);
  assert.notEqual(rRefuse.status, 0, 'must refuse to prune accumulated state');
  assert.match(rRefuse.stderr, /--prune-non-pending/);
  assert.equal(read(p).tasks.find((t) => t.id === 1).status, 'done'); // unchanged
  const rOk = run(['amend-tasks', `--state=${p}`, `--plan-index=${idx}`, '--prune', '--prune-non-pending']);
  assert.equal(rOk.status, 0, rOk.stderr);
  assert.deepEqual(JSON.parse(rOk.stdout).pruned, [1]);
  assert.equal(read(p).tasks.length, 0);
});

test('amend-tasks: wave-less stuck-guard fails loud before write (exit 1)', () => {
  const p = tmpBundle(v8({ tasks: [{ id: 1, status: 'done', wave: 0, files: [] }] }));
  const idx = writeIdx([
    { id: 1, wave: 0, files: [] },
    { id: 9, wave: null, files: ['z.mjs'] }, // new pending, no integer wave -> stuck
  ]);
  const r = run(['amend-tasks', `--state=${p}`, `--plan-index=${idx}`]);
  assert.notEqual(r.status, 0, 'must fail on a wave-less pending task');
  assert.match(r.stderr, /no integer wave/);
  assert.match(r.stderr, /9/);
});

test('set-phase / set-status: write the lifecycle fields; reject a value outside the enum', () => {
  // The CD-7 closure for the line-333 hand-edit: there is now an `mp` write for the phase/status
  // fields, so the orchestrator never hand-edits state.yml to advance a phase or archive a run.
  const p = tmpBundle(v8());
  passGate(p, 'spec');
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

test('rebase-paths: rewrite the absolute path fields under a new repo root (CD-7 writer for repo relocation)', () => {
  // Closing the 2026-06-22 hand-edit gap: the bundle's absolute path fields (spec_path / plan_path /
  // plan_index_path / worktree) get stale when the repo moves. `mp rebase-paths` is the single-writer
  // (CD-7) replacement for hand-editing state.yml after a repo move. Reports the rebased field count.
  const p = tmpBundle(v8({
    spec_path: '/tmp/old-masterplan/docs/b/spec.md',
    plan_path: '/tmp/old-masterplan/docs/b/plan.md',
    plan_index_path: '/tmp/old-masterplan/docs/b/plan.index.json',
    worktree: '/tmp/old-masterplan/.worktrees/b',
    topic: 'unrelated',
  }));
  const out = JSON.parse(run(['rebase-paths', `--state=${p}`, '--from=/tmp/old-masterplan', '--to=/srv/dev/ras/masterplan']).stdout);
  assert.equal(out.rebased, 4);
  const after = read(p);
  assert.equal(after.spec_path, '/srv/dev/ras/masterplan/docs/b/spec.md');
  assert.equal(after.plan_path, '/srv/dev/ras/masterplan/docs/b/plan.md');
  assert.equal(after.plan_index_path, '/srv/dev/ras/masterplan/docs/b/plan.index.json');
  assert.equal(after.worktree, '/srv/dev/ras/masterplan/.worktrees/b');
  assert.equal(after.topic, 'unrelated'); // unrelated field untouched
});

test('rebase-paths: re-running with the same `from` is a no-op (idempotent re-rebase)', () => {
  const p = tmpBundle(v8({
    spec_path: '/tmp/old-masterplan/docs/b/spec.md',
    plan_path: '/tmp/old-masterplan/docs/b/plan.md',
    plan_index_path: '/tmp/old-masterplan/docs/b/plan.index.json',
    worktree: '/tmp/old-masterplan/.worktrees/b',
  }));
  run(['rebase-paths', `--state=${p}`, '--from=/tmp/old-masterplan', '--to=/srv/dev/ras/masterplan']);
  const second = JSON.parse(run(['rebase-paths', `--state=${p}`, '--from=/tmp/old-masterplan', '--to=/srv/dev/ras/masterplan']).stdout);
  assert.equal(second.rebased, 0); // already rebased — prefix no longer matches
});

test('rebase-paths: rejects a relative root at the bin boundary (validation surface)', () => {
  const p = tmpBundle(v8({ spec_path: '/tmp/old-masterplan/docs/b/spec.md' }));
  const bad = run(['rebase-paths', `--state=${p}`, '--from=relative/from', '--to=/srv/x']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /must be absolute paths/);
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
test('set-review-config: writes state.review.adversary (+ legacy routing); merge-preserve; reject bad value / empty patch (CD-7)', () => {
  // The review-arm config the finish-step gate reads (state.review.adversary) has an `mp` writer, so
  // turning review off for a bundle never forces a raw hand-edit. --routing is the legacy per-task
  // dispatch default (state.codex.routing) the prepare-wave path still reads for in-flight bundles.
  const p = tmpBundle(v8());
  const o = JSON.parse(run(['set-review-config', `--state=${p}`, '--routing=off', '--review=false']).stdout);
  assert.deepEqual(o.review, { routing: 'off', adversary: false });
  assert.deepEqual(read(p).review, { adversary: false }); // review arm persisted to state.review
  assert.deepEqual(read(p).codex, { routing: 'off' });     // legacy routing persisted to state.codex
  // partial set merge-preserves the other facet: flip routing back to auto, review stays false
  assert.deepEqual(JSON.parse(run(['set-review-config', `--state=${p}`, '--routing=auto']).stdout).review, { routing: 'auto' });
  assert.deepEqual(read(p).codex, { routing: 'auto' });
  assert.deepEqual(read(p).review, { adversary: false });
  // review normalizes on/true -> the boolean `true` the gate predicate compares against
  const q = tmpBundle(v8());
  assert.equal(JSON.parse(run(['set-review-config', `--state=${q}`, '--review=on']).stdout).review.adversary, true);
  assert.equal(read(q).review.adversary, true);
  // Back-compat: the old command name `set-codex-config` is a hidden alias for the same handler.
  const r = tmpBundle(v8());
  assert.equal(JSON.parse(run(['set-codex-config', `--state=${r}`, '--review=on']).stdout).review.adversary, true);
  assert.equal(read(r).review.adversary, true);
  // Enum guard + empty-patch guard: both die at the bin boundary, leaving state untouched.
  const badRouting = run(['set-review-config', `--state=${p}`, '--routing=sometimes']);
  assert.notEqual(badRouting.status, 0);
  assert.match(badRouting.stderr, /invalid --routing/);
  const empty = run(['set-review-config', `--state=${p}`]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /at least one of --routing or --review/);
  assert.deepEqual(read(p).review, { adversary: false }); // unchanged by the rejected writes
});
test('finish-status: adversary_review mirrors state.review.adversary (the predicate that arms the §2c whole-branch gate)', () => {
  // The §2c finish-gate runs the whole-branch adversary review only when review is armed. finish-status
  // surfaces that as a normalized boolean using the SAME predicate as the dispatch/prepare-wave path
  // (raw === true|'on'|'true'), so the gate and the wave workflow can never disagree on "review is on".
  const p = tmpBundle(v8());
  // Default bundle — no review config → not armed.
  assert.equal(JSON.parse(run(['finish-status', `--state=${p}`]).stdout).adversary_review, false);
  // set-review-config --review=on persists the boolean true; finish-status reports the gate armed.
  run(['set-review-config', `--state=${p}`, '--review=on']);
  assert.equal(JSON.parse(run(['finish-status', `--state=${p}`]).stdout).adversary_review, true);
  // …and back off — the gate disarms (the value is read live from state each snapshot).
  run(['set-review-config', `--state=${p}`, '--review=off']);
  assert.equal(JSON.parse(run(['finish-status', `--state=${p}`]).stdout).adversary_review, false);
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
test('seed: defaults state.review.adversary=true at seed time (spec §4.1 default-on)', () => {
  const p = path.join(tmpDir('mp-seed-review-default-'), 'state.yml');
  const r = run(['seed', `--state=${p}`, '--slug=demo', '--topic=A topic']);
  assert.equal(r.status, 0);
  assert.deepEqual(read(p).review, { adversary: true });
  assert.ok(!('codex' in read(p)), 'vestigial state.codex routing is no longer seeded');
});
test('seed: --adversary-review=on arms explicitly (matches default behavior)', () => {
  const p = path.join(tmpDir('mp-seed-review-on-'), 'state.yml');
  const r = run(['seed', `--state=${p}`, '--slug=demo', '--topic=A topic', '--adversary-review=on']);
  assert.equal(r.status, 0);
  assert.deepEqual(read(p).review, { adversary: true });
});
test('seed: --codex-review=on is a hidden back-compat alias for --adversary-review', () => {
  const p = path.join(tmpDir('mp-seed-review-alias-'), 'state.yml');
  const r = run(['seed', `--state=${p}`, '--slug=demo', '--topic=A topic', '--codex-review=on']);
  assert.equal(r.status, 0);
  assert.deepEqual(read(p).review, { adversary: true });
});
test('seed: --adversary-review=off opts out (omits state.review entirely, A9 absent-field style)', () => {
  const p = path.join(tmpDir('mp-seed-review-off-'), 'state.yml');
  const r = run(['seed', `--state=${p}`, '--slug=demo', '--topic=A topic', '--adversary-review=off']);
  assert.equal(r.status, 0);
  assert.ok(!('review' in read(p)), 'explicit opt-out must leave state.review absent');
});
test('seed: --adversary-review rejects bogus values loud (on/off only)', () => {
  const p = path.join(tmpDir('mp-seed-review-bogus-'), 'state.yml');
  const r = run(['seed', `--state=${p}`, '--slug=demo', '--topic=A topic', '--adversary-review=maybe']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid --adversary-review/);
});

test('seed: defaults state.dispatch.fabric=true at seed time (fabric default-on)', () => {
  const p = path.join(tmpDir('mp-seed-fabric-default-'), 'state.yml');
  const r = run(['seed', `--state=${p}`, '--slug=demo', '--topic=A topic']);
  assert.equal(r.status, 0);
  assert.deepEqual(read(p).dispatch, { fabric: true });
});
test('seed: --fabric=on arms explicitly (matches default)', () => {
  const p = path.join(tmpDir('mp-seed-fabric-on-'), 'state.yml');
  const r = run(['seed', `--state=${p}`, '--slug=demo', '--topic=A topic', '--fabric=on']);
  assert.equal(r.status, 0);
  assert.deepEqual(read(p).dispatch, { fabric: true });
});
test('seed: --fabric=off opts out (omits state.dispatch, A9 absent-field style)', () => {
  const p = path.join(tmpDir('mp-seed-fabric-off-'), 'state.yml');
  const r = run(['seed', `--state=${p}`, '--slug=demo', '--topic=A topic', '--fabric=off']);
  assert.equal(r.status, 0);
  assert.ok(!('dispatch' in read(p)), 'explicit fabric opt-out must leave state.dispatch absent');
});
test('seed: --fabric rejects bogus values loud (on/off only)', () => {
  const p = path.join(tmpDir('mp-seed-fabric-bogus-'), 'state.yml');
  const r = run(['seed', `--state=${p}`, '--slug=demo', '--topic=A topic', '--fabric=maybe']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid --fabric/);
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

// ---- integration: adversary-review-status (the §2c step-7 durable re-entry guard's fs front) ----
test('adversary-review-status: reads back a durable adversary_review event for a given HEAD (the P2 re-entry guard)', () => {
  // The §2c finish-gate writes an adversary_review event (data:{sha,base,count}, note:<digest>) BEFORE
  // open-gate. On resume the step-7 guard reads it via this subcommand: present at HEAD ⇒ skip the
  // network re-run + rehydrate the digest. End-to-end: `mp event` writes, `mp adversary-review-status` reads.
  const p = path.join(tmpDir('mp-ars-'), 'state.yml');
  const HEAD = 'deadbeef123';
  // Absent events.jsonl → {present:false}, no throw.
  assert.deepEqual(JSON.parse(run(['adversary-review-status', `--state=${p}`, `--sha=${HEAD}`]).stdout),
    { present: false, digest: null, count: null, base: null });
  // Write the durable record exactly as step-7's exit-0 path does (the channel split: scalars→--data,
  // free-text digest→--note, audit signal→--summary).
  run(['event', `--state=${p}`, '--type=adversary_review', '--ts=T1',
    '--summary=adversary review complete (whole-branch, base main) — 2 findings',
    `--data={"sha":"${HEAD}","base":"main","count":2}`, '--note=P2: stale lock; P3: naming']);
  assert.deepEqual(JSON.parse(run(['adversary-review-status', `--state=${p}`, `--sha=${HEAD}`]).stdout),
    { present: true, digest: 'P2: stale lock; P3: naming', count: 2, base: 'main' });
  // A different HEAD does not match (the guard keys on the exact tree).
  assert.equal(JSON.parse(run(['adversary-review-status', `--state=${p}`, '--sha=other999']).stdout).present, false);
  // A degraded adversary_review_skipped record at HEAD must NOT satisfy the guard (a skip ≠ a review).
  run(['event', `--state=${p}`, '--type=adversary_review_skipped', '--ts=T2',
    '--summary=whole-branch adversary-review skipped (degraded) — no network',
    `--data={"sha":"${HEAD}"}`]);
  // The earlier success still wins; the skip is ignored either way.
  assert.equal(JSON.parse(run(['adversary-review-status', `--state=${p}`, `--sha=${HEAD}`]).stdout).present, true);
});

test('adversary-review-status: the codex-review-status alias still works AND a legacy codex_review event satisfies the guard', () => {
  // In-flight bundles: a run started before the rename writes type:'codex_review' and the orchestrator
  // prose may still call `mp codex-review-status`. Both the alias command name and the legacy event
  // family must keep working so a resumed run is not re-reviewed.
  const p = path.join(tmpDir('mp-ars-legacy-'), 'state.yml');
  const HEAD = 'legacyf00d';
  run(['event', `--state=${p}`, '--type=codex_review', '--ts=T1',
    '--summary=codex review complete (whole-branch, base main) — 1 findings',
    `--data={"sha":"${HEAD}","base":"main","count":1}`, '--note=legacy digest']);
  // Read via the new command name…
  assert.deepEqual(JSON.parse(run(['adversary-review-status', `--state=${p}`, `--sha=${HEAD}`]).stdout),
    { present: true, digest: 'legacy digest', count: 1, base: 'main' });
  // …and via the back-compat alias.
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
  const status = JSON.parse(run(['adversary-review-status', `--state=${p}`, `--sha=${HEAD}`]).stdout);
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

test('adversary-review-status: a non-ENOENT events.jsonl read error fails loud (never masquerades as present:false)', () => {
  // ENOENT == no review yet → {present:false}. But any OTHER read error (here: events.jsonl is a
  // directory → EISDIR) must NOT be swallowed — a silent {present:false} would falsely re-run the
  // network gate or look "skipped". The subcommand must die.
  const dir = tmpDir('mp-crs-eisdir-');
  const p = path.join(dir, 'state.yml');
  fs.mkdirSync(path.join(dir, 'events.jsonl')); // sibling of state.yml, as a directory
  const r = run(['adversary-review-status', `--state=${p}`, '--sha=deadbeef']);
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
  freezeInitialGoals(p, dir); // seeded bundle is goals_enabled — capture the goal set before planning
  passGate(p, 'spec');
  assert.equal(JSON.parse(run(['set-phase', `--state=${p}`, '--phase=plan']).stdout).phase, 'plan');
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
  passGate(p, 'plan');
  assert.equal(JSON.parse(run(['set-phase', `--state=${p}`, '--phase=execute']).stdout).phase, 'execute');
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
  freezeInitialGoals(p, dir); // seeded bundle is goals_enabled — capture the goal set before planning
  passGate(p, 'spec');
  assert.equal(JSON.parse(run(['set-phase', `--state=${p}`, '--phase=plan']).stdout).phase, 'plan');
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

// ---- integration: pre-execute gate enforcement (the adversarial-triage hardening) ----
// Helpers local to this block: build a plan-phase bundle (tasks:[] to dodge the clobber guard) with the
// required artifacts on disk so the plan gate is satisfiable.
function planBundleWithArtifacts() {
  const p = tmpBundle(v8({ phase: 'plan', tasks: [] }));
  const dir = path.dirname(p);
  fs.writeFileSync(path.join(dir, 'spec.md'), '# spec\nreal spec\n');
  fs.writeFileSync(path.join(dir, 'plan.md'), '# plan\nreal plan\n');
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  return { p, dir, planIdx };
}

test('gate: unsatisfied set-phase→plan exits 3 with a run_gate_review op and does NOT advance phase', () => {
  const p = tmpBundle(v8());
  const dir = path.dirname(p);
  fs.writeFileSync(path.join(dir, 'spec.md'), '# spec\nreal\n');
  const before = read(p).phase;
  const r = run(['set-phase', `--state=${p}`, '--phase=plan']);
  assert.equal(r.status, 3, `expected exit 3, got ${r.status}: ${r.stderr}`);
  const op = JSON.parse(r.stdout);
  assert.equal(op.op, 'run_gate_review');
  assert.equal(op.gate, 'spec');
  assert.deepEqual(op.artifacts, ['spec.md']);
  assert.equal(read(p).phase, before, 'phase must be unchanged when the gate refuses');
});

test('gate: unsatisfied load-plan exits 3 AFTER index validation and writes no tasks', () => {
  const { p, planIdx } = planBundleWithArtifacts();
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 3, `expected exit 3, got ${r.status}: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).gate, 'plan');
  assert.equal(read(p).tasks.length, 0, 'no tasks materialized when the gate refuses');
});

test('gate: editing spec.md re-arms the spec gate (a stale review no longer satisfies it)', () => {
  const p = tmpBundle(v8());
  passGate(p, 'spec'); // records done at the current spec.md hash
  // set-phase would pass now; mutate the reviewed artifact and it must re-arm.
  fs.appendFileSync(path.join(path.dirname(p), 'spec.md'), '\nNEW CONTENT after review\n');
  const r = run(['set-phase', `--state=${p}`, '--phase=plan']);
  assert.equal(r.status, 3, 'editing spec.md must re-arm the gate');
  assert.equal(JSON.parse(r.stdout).gate, 'spec');
});

test('gate: editing ONLY plan_hash/generated_at does NOT re-arm the plan gate (they are normalized out)', () => {
  const { p, planIdx } = planBundleWithArtifacts();
  passGate(p, 'plan'); // records done over the normalized index
  const idx = JSON.parse(fs.readFileSync(planIdx, 'utf8'));
  idx.plan_hash = 'deadbeefdeadbeef';
  idx.generated_at = '2026-06-25T12:00:00Z';
  fs.writeFileSync(planIdx, JSON.stringify(idx));
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 0, `gate should still pass (normalized hash unchanged): ${r.stderr}${r.stdout}`);
  assert.ok(read(p).tasks.length > 0, 'tasks materialized — the transition proceeded');
});

test('gate: --status=skipped requires both --reason and a non-empty --digest-file', () => {
  const p = tmpBundle(v8());
  fs.writeFileSync(path.join(path.dirname(p), 'spec.md'), '# spec\n');
  // no digest-file (missing required flag → usage error)
  const noDigest = run(['record-gate-review', `--state=${p}`, '--gate=spec', '--status=skipped', '--reason=lane down']);
  assert.notEqual(noDigest.status, 0);
  assert.match(noDigest.stderr, /digest-file/);
  // empty digest-file
  const empty = path.join(path.dirname(p), 'empty.txt');
  fs.writeFileSync(empty, '   \n');
  const emptyDigest = run(['record-gate-review', `--state=${p}`, '--gate=spec', '--status=skipped', '--reason=lane down', `--digest-file=${empty}`]);
  assert.equal(emptyDigest.status, 1);
  assert.match(emptyDigest.stderr, /empty/);
});

test('gate: a recorded skip (with evidence) satisfies the gate — fail-soft', () => {
  const p = tmpBundle(v8());
  fs.writeFileSync(path.join(path.dirname(p), 'spec.md'), '# spec\n');
  const notes = path.join(path.dirname(p), 'lane-error.txt');
  fs.writeFileSync(notes, 'gateway 503 — adversary lane unreachable\n');
  const rec = run(['record-gate-review', `--state=${p}`, '--gate=spec', '--status=skipped', '--reason=gateway 503', `--digest-file=${notes}`]);
  assert.equal(rec.status, 0, rec.stderr);
  const sp = run(['set-phase', `--state=${p}`, '--phase=plan']);
  assert.equal(sp.status, 0, `a recorded skip must satisfy the gate: ${sp.stderr}${sp.stdout}`);
  assert.equal(read(p).phase, 'plan');
});

test('gate: a fabricated done is rejected — receipt must echo the recomputed hash and carry tokens', () => {
  const { p, planIdx } = planBundleWithArtifacts();
  const gh = JSON.parse(run(['gate-hash', `--state=${p}`, '--gate=plan']).stdout);
  const base = { gate: 'plan', hash: gh.hash, artifacts: gh.artifacts, dispatch_id: 'd', provider: 'pv', model: 'm', output_tokens: 5, status: 'done', ts: 't', digest: 'ok' };
  const write = (obj) => { const f = path.join(path.dirname(p), 'r.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
  // wrong hash
  let r = run(['record-gate-review', `--state=${p}`, '--gate=plan', '--status=done', `--receipt=${write({ ...base, hash: 'sha256:stale' })}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /receipt rejected/);
  // zero tokens
  r = run(['record-gate-review', `--state=${p}`, '--gate=plan', '--status=done', `--receipt=${write({ ...base, output_tokens: 0 })}`]);
  assert.equal(r.status, 1);
  // a valid receipt is accepted, and then satisfies load-plan
  const ok = run(['record-gate-review', `--state=${p}`, '--gate=plan', '--status=done', `--receipt=${write(base)}`]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]).status, 0);
});

test('gate: fail-closed on a missing required artifact — exit 1, not a silent empty-hash pass', () => {
  const p = tmpBundle(v8()); // no spec.md on disk
  const r = run(['set-phase', `--state=${p}`, '--phase=plan']);
  assert.equal(r.status, 1, 'a missing spec.md must hard-fail, never hash as empty');
  assert.match(r.stderr, /spec\.md.*(unreadable|fail-closed)/);
  assert.notEqual(read(p).phase, 'plan');
});

test('gate: a --plan-md outside the bundle is refused (path/symlink escape)', () => {
  const { p, planIdx } = planBundleWithArtifacts();
  const outsideMd = path.join(tmpDir('mp-outside-'), 'plan.md');
  fs.writeFileSync(outsideMd, '# evil\n');
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`, `--plan-md=${outsideMd}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside the bundle/);
});

test('gate: a symlinked spec.md escaping the bundle is refused', () => {
  const p = tmpBundle(v8());
  const outside = path.join(tmpDir('mp-outside-'), 'real-spec.md');
  fs.writeFileSync(outside, '# elsewhere\n');
  fs.symlinkSync(outside, path.join(path.dirname(p), 'spec.md'));
  const r = run(['set-phase', `--state=${p}`, '--phase=plan']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside the bundle/);
});

test('gate: populated load-plan is refused at the clobber guard BEFORE index validation', () => {
  const p = tmpBundle(v8()); // v8() ships 2 tasks
  const dir = path.dirname(p);
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify({ not: 'a valid index' })); // would fail validation IF reached
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already has 2 task/);
  assert.doesNotMatch(r.stderr, /invalid plan|schema_version/, 'clobber must precede validation');
});

test('gate: --force bypasses set-phase→plan and appends a spec_gate_bypassed audit event', () => {
  const p = tmpBundle(v8()); // no spec.md — --force must still work (recovery, no resolve/hash)
  const r = run(['set-phase', `--state=${p}`, '--phase=plan', '--force']);
  assert.equal(r.status, 0, `--force should bypass the gate: ${r.stderr}`);
  assert.equal(read(p).phase, 'plan');
  const events = fs.readFileSync(path.join(path.dirname(p), 'events.jsonl'), 'utf8');
  assert.match(events, /spec_gate_bypassed/);
});

// ---- goals-load: freeze goals.md into the bundle (one-shot capture + approval receipt) ----
import { goalsHash as goalsHashFn } from '../lib/goals.mjs';
function goalsBundle(over = {}) {
  return tmpBundle(v8({ phase: 'brainstorm', goals_enabled: true, goals: [], tasks: [], ...over }));
}
const GOALS_MD = 'topic: ship the widget\n\n## G1: the widget compiles\nsignal: command\n\n## G2: the widget is documented\nsignal: docs\n';
function writeGoals(dir, md = GOALS_MD) {
  const gp = path.join(dir, 'src-goals.md');
  fs.writeFileSync(gp, md);
  return gp;
}
function writeApproval(dir, hash, over = {}) {
  const ap = path.join(dir, 'approval.json');
  fs.writeFileSync(ap, JSON.stringify({ attested_by: 'user', purpose: 'goal_load', goals_hash: hash, question: 'Approve these goals?', answer: 'yes', ts: '2026-07-01T00:00:00Z', ...over }));
  return ap;
}

test('goals-load: freezes goals into state + appends goals_frozen with the approval receipt', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const gp = writeGoals(dir);
  const hash = goalsHashFn(GOALS_MD);
  const ap = writeApproval(dir, hash);
  const r = run(['goals-load', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--ts=2026-07-01T00:00:00Z']);
  assert.equal(r.status, 0, `goals-load should succeed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.goals_load, 'frozen');
  assert.equal(out.goals_hash, hash);
  assert.equal(out.goals, 2);
  const st = read(p);
  assert.equal(st.goals_md_hash, hash);
  assert.equal(st.goals.length, 2);
  assert.equal(st.goals[0].id, 'G1');
  assert.equal(fs.readFileSync(path.join(dir, 'goals.md'), 'utf8'), GOALS_MD);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const frozen = events.filter((e) => e.type === 'goals_frozen');
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0].data.goals_hash, hash);
  assert.equal(frozen[0].data.approval.attested_by, 'user');
});

test('goals-load: rejects a malformed goals.md (validation failure)', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const bad = 'topic: x\n\n## G1: only a title\nsignal: not-a-class\n';
  const gp = writeGoals(dir, bad);
  const ap = writeApproval(dir, goalsHashFn(bad));
  const r = run(['goals-load', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid goals\.md/);
});

test('goals-load: rejects a missing/invalid approval receipt', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const gp = writeGoals(dir);
  const ap = writeApproval(dir, 'sha256:wronghash');
  const r = run(['goals-load', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /approval receipt/);
});

test('goals-load: one-shot — a re-freeze with DIFFERENT goals is rejected (no laundering)', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const gp = writeGoals(dir);
  const hash = goalsHashFn(GOALS_MD);
  const ap = writeApproval(dir, hash);
  assert.equal(run(['goals-load', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`]).status, 0);
  const md2 = 'topic: different\n\n## G1: a changed goal\nsignal: test\n';
  const gp2 = writeGoals(dir, md2);
  const ap2 = writeApproval(dir, goalsHashFn(md2));
  const r = run(['goals-load', `--state=${p}`, `--goals=${gp2}`, `--approval=${ap2}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /different hash|launder/);
});

test('goals-load: idempotent roll-forward — re-run at the SAME hash succeeds without a second event', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const gp = writeGoals(dir);
  const hash = goalsHashFn(GOALS_MD);
  const ap = writeApproval(dir, hash);
  assert.equal(run(['goals-load', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`]).status, 0);
  const r2 = run(['goals-load', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`]);
  assert.equal(r2.status, 0, `re-run should be idempotent: ${r2.stderr}`);
  assert.equal(JSON.parse(r2.stdout).goals_load, 'idempotent');
  const frozen = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'goals_frozen');
  assert.equal(frozen.length, 1, 'no second goals_frozen event on idempotent re-run');
});

test('goals-load: one-shot — rejected once another goal lifecycle event exists', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const gp = writeGoals(dir);
  const hash = goalsHashFn(GOALS_MD);
  const ap = writeApproval(dir, hash);
  run(['event', `--state=${p}`, '--type=goal_waived', '--data={"goals_hash":"sha256:x"}']);
  const r = run(['goals-load', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /past initial capture|lifecycle event/);
});

test('goals-load: one-shot — rejected when phase is past capture (not brainstorm)', () => {
  const p = goalsBundle({ phase: 'plan' });
  const dir = path.dirname(p);
  const gp = writeGoals(dir);
  const hash = goalsHashFn(GOALS_MD);
  const ap = writeApproval(dir, hash);
  const r = run(['goals-load', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /past the goal-capture window|brainstorm/);
});

test('goals-load: the seed-time capability event does NOT block the first goals-load', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  run(['event', `--state=${p}`, '--type=bundle_created', '--data={"goals_enabled":true}']);
  const gp = writeGoals(dir);
  const hash = goalsHashFn(GOALS_MD);
  const ap = writeApproval(dir, hash);
  const r = run(['goals-load', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`]);
  assert.equal(r.status, 0, `capability event must not block first load: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).goals_load, 'frozen');
});

// ---- goals-amend: the only sanctioned mid-run goal change (fresh approval, ids stable, tombstones) ----
// A valid amendment of GOALS_MD (ids G1/G2 preserved): G1 text modified, G2 tombstoned (kept, not
// deleted), G3 added with a strictly-greater number.
const AMEND_MD =
  'topic: ship the widget\n\n## G1: the widget compiles fast\nsignal: command\n\n## G2: the widget is documented\nsignal: docs\ntombstone_reason: descoped\ntombstone_at: 2026-07-02T00:00:00Z\n\n## G3: the widget ships to prod\nsignal: test\n';
function freezeInitialGoals(p, dir) {
  const gp = writeGoals(dir);
  const hash = goalsHashFn(GOALS_MD);
  const ap = writeApproval(dir, hash);
  const r = run(['goals-load', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`]);
  assert.equal(r.status, 0, `goals-load setup should succeed: ${r.stderr}`);
  return hash;
}
function writeAmendApproval(dir, oldHash, newHash, over = {}) {
  const ap = path.join(dir, 'amend-approval.json');
  fs.writeFileSync(
    ap,
    JSON.stringify({
      attested_by: 'user',
      purpose: 'goal_amend',
      goals_hash: newHash,
      old_goals_hash: oldHash,
      question: 'Approve this goal amendment?',
      answer: 'yes',
      ts: '2026-07-02T00:00:00Z',
      ...over,
    })
  );
  return ap;
}
function writeAmendGoals(dir, md) {
  const gp = path.join(dir, 'amend-goals.md');
  fs.writeFileSync(gp, md);
  return gp;
}

test('goals-amend: amends goals — updates state + goals.md + appends goal_amended with old->new hash, reason, and full per-goal changes', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const oldHash = freezeInitialGoals(p, dir);
  const newHash = goalsHashFn(AMEND_MD);
  const gp = writeAmendGoals(dir, AMEND_MD);
  const ap = writeAmendApproval(dir, oldHash, newHash);
  const r = run(['goals-amend', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--reason=descope docs goal', '--ts=2026-07-02T00:00:00Z']);
  assert.equal(r.status, 0, `goals-amend should succeed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.goals_amend, 'amended');
  assert.equal(out.old_goals_hash, oldHash);
  assert.equal(out.new_goals_hash, newHash);
  assert.equal(out.changes, 3);
  const st = read(p);
  assert.equal(st.goals_md_hash, newHash);
  assert.equal(st.goals.length, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'goals.md'), 'utf8'), AMEND_MD);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const amended = events.filter((e) => e.type === 'goal_amended');
  assert.equal(amended.length, 1);
  assert.equal(amended[0].data.old_goals_hash, oldHash);
  assert.equal(amended[0].data.new_goals_hash, newHash);
  assert.equal(amended[0].data.reason, 'descope docs goal');
  const byId = Object.fromEntries(amended[0].data.changes.map((c) => [c.id, c]));
  assert.equal(byId.G1.change, 'modified');
  assert.equal(byId.G1.old.text, 'the widget compiles');
  assert.equal(byId.G1.new.text, 'the widget compiles fast');
  assert.equal(byId.G2.change, 'tombstoned');
  assert.equal(byId.G3.change, 'added');
  assert.equal(byId.G3.new.signal, 'test');
});

test('goals-amend: rejected when no goals_frozen exists yet (nothing to amend)', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const newHash = goalsHashFn(AMEND_MD);
  const gp = writeAmendGoals(dir, AMEND_MD);
  const ap = writeAmendApproval(dir, 'sha256:none', newHash);
  const r = run(['goals-amend', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--reason=x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing to amend|no goals_frozen/);
});

test('goals-amend: rejects a bare deletion — a removed goal must become a tombstone', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const oldHash = freezeInitialGoals(p, dir);
  const md = 'topic: ship the widget\n\n## G1: the widget compiles\nsignal: command\n';
  const newHash = goalsHashFn(md);
  const gp = writeAmendGoals(dir, md);
  const ap = writeAmendApproval(dir, oldHash, newHash);
  const r = run(['goals-amend', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--reason=drop G2']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /removed|tombstone/);
});

test('goals-amend: rejects renumbering — a new goal must not reuse a number <= the max old id', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const oldHash = freezeInitialGoals(p, dir);
  const md = 'topic: ship the widget\n\n## G0: sneaky early goal\nsignal: test\n\n## G1: the widget compiles\nsignal: command\n\n## G2: the widget is documented\nsignal: docs\n';
  const newHash = goalsHashFn(md);
  const gp = writeAmendGoals(dir, md);
  const ap = writeAmendApproval(dir, oldHash, newHash);
  const r = run(['goals-amend', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--reason=renumber']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /renumber/);
});

test('goals-amend: rejects an approval receipt not bound to the prior goals hash (stale/replay)', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  freezeInitialGoals(p, dir);
  const newHash = goalsHashFn(AMEND_MD);
  const gp = writeAmendGoals(dir, AMEND_MD);
  const ap = writeAmendApproval(dir, 'sha256:wrongold', newHash);
  const r = run(['goals-amend', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--reason=x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /approval receipt/);
});

test('goals-amend: rejects an approval receipt with the wrong purpose (goal_load replayed as amend)', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const oldHash = freezeInitialGoals(p, dir);
  const newHash = goalsHashFn(AMEND_MD);
  const gp = writeAmendGoals(dir, AMEND_MD);
  const ap = writeAmendApproval(dir, oldHash, newHash, { purpose: 'goal_load' });
  const r = run(['goals-amend', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--reason=x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /approval receipt/);
});

test('goals-amend: idempotent roll-forward — re-running the same amendment does not append a second event', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const oldHash = freezeInitialGoals(p, dir);
  const newHash = goalsHashFn(AMEND_MD);
  const gp = writeAmendGoals(dir, AMEND_MD);
  const ap = writeAmendApproval(dir, oldHash, newHash);
  assert.equal(run(['goals-amend', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--reason=first']).status, 0);
  const r2 = run(['goals-amend', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--reason=first']);
  assert.equal(r2.status, 0, `re-run should be idempotent: ${r2.stderr}`);
  assert.equal(JSON.parse(r2.stdout).goals_amend, 'idempotent');
  const amended = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'goal_amended');
  assert.equal(amended.length, 1, 'no second goal_amended event on idempotent re-run');
});

test('goals-amend: invalidates existing goal-check receipts and waivers keyed to the old hash', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const oldHash = freezeInitialGoals(p, dir);
  // Seed a goal_check and a goal_waived event keyed to the CURRENT (old) goals hash.
  run(['event', `--state=${p}`, '--type=goal_check', `--data=${JSON.stringify({ goals_hash: oldHash })}`]);
  run(['event', `--state=${p}`, '--type=goal_waived', `--data=${JSON.stringify({ goals_hash: oldHash })}`]);
  const newHash = goalsHashFn(AMEND_MD);
  const gp = writeAmendGoals(dir, AMEND_MD);
  const ap = writeAmendApproval(dir, oldHash, newHash);
  const r = run(['goals-amend', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--reason=descope']);
  assert.equal(r.status, 0, `goals-amend should succeed: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).invalidated_receipts, 2);
  const st = read(p);
  assert.equal(st.goals_md_hash, newHash);
  assert.notEqual(st.goals_md_hash, oldHash);
});

test('goals-status: unfrozen bundle reports no frozen goals', () => {
  const p = goalsBundle();
  const r = run(['goals-status', `--state=${p}`]);
  assert.equal(r.status, 0, `goals-status should succeed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.goals_status, 'unfrozen');
  assert.equal(out.frozen, false);
  assert.equal(out.amendments, 0);
  assert.deepEqual(out.goals, []);
});

test('goals-status: after goals-load reports frozen hash + active goals derived from goals.md', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const hash = freezeInitialGoals(p, dir);
  const r = run(['goals-status', `--state=${p}`]);
  assert.equal(r.status, 0, `goals-status should succeed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.goals_status, 'frozen');
  assert.equal(out.frozen, true);
  assert.equal(out.frozen_hash, hash);
  assert.equal(out.current_hash, hash);
  assert.equal(out.amendments, 0);
  assert.equal(out.hash_ok, true);
  assert.equal(out.active, 2);
  assert.equal(out.tombstoned, 0);
  assert.equal(out.goals.length, 2);
  assert.equal(out.goals[0].id, 'G1');
  assert.equal(out.goals[0].tombstoned, false);
});

test('goals-status: after goals-amend reflects amended hash + tombstones', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const oldHash = freezeInitialGoals(p, dir);
  const newHash = goalsHashFn(AMEND_MD);
  const gp = writeAmendGoals(dir, AMEND_MD);
  const ap = writeAmendApproval(dir, oldHash, newHash);
  assert.equal(
    run(['goals-amend', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--reason=descope']).status,
    0
  );
  const r = run(['goals-status', `--state=${p}`]);
  assert.equal(r.status, 0, `goals-status should succeed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.goals_status, 'amended');
  assert.equal(out.frozen_hash, oldHash);
  assert.equal(out.current_hash, newHash);
  assert.equal(out.amendments, 1);
  assert.equal(out.hash_ok, true);
  assert.equal(out.active, 2);
  assert.equal(out.tombstoned, 1);
  const g2 = out.goals.find((g) => g.id === 'G2');
  assert.equal(g2.tombstoned, true);
  assert.equal(g2.tombstone_reason, 'descoped');
});

test('goals-status: derives from goals.md + events, not the stale state.goals cache', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const hash = freezeInitialGoals(p, dir);
  const st = read(p);
  fs.writeFileSync(p, serializeState({ ...st, goals: [{ id: 'G9', text: 'stale cached goal', signal: 'test' }] }));
  const r = run(['goals-status', `--state=${p}`]);
  assert.equal(r.status, 0, `goals-status should succeed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.goals.length, 2);
  assert.ok(!out.goals.some((g) => g.id === 'G9'));
  assert.equal(out.current_hash, hash);
});

// ---- goal-transition guards: capture gate + split-brain hash guard (task 7) --------------------
// Fixtures reused from the goals sections above (goalsBundle, freezeInitialGoals, AMEND_MD,
// writeAmendGoals, writeAmendApproval, goalsHashFn, passGate, planIndexFixture, v8, tmpBundle).

test('capture gate: set-phase --phase=plan on a goals_enabled bundle with UNFROZEN goals exits 3 with a run_goals_capture op and does NOT advance', () => {
  const p = goalsBundle();
  fs.writeFileSync(path.join(path.dirname(p), 'spec.md'), '# spec\n');
  const r = run(['set-phase', `--state=${p}`, '--phase=plan']);
  assert.equal(r.status, 3, `expected exit 3, got ${r.status}: ${r.stderr}`);
  const op = JSON.parse(r.stdout);
  assert.equal(op.op, 'run_goals_capture');
  assert.equal(op.gate, 'goals');
  assert.equal(read(p).phase, 'brainstorm');
});

test('capture gate: once goals are frozen, set-phase --phase=plan clears capture and reaches the SPEC gate (which now covers goals.md)', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  freezeInitialGoals(p, dir);
  fs.writeFileSync(path.join(dir, 'spec.md'), '# spec\n');
  const r = run(['set-phase', `--state=${p}`, '--phase=plan']);
  assert.equal(r.status, 3, `expected spec-gate exit 3, got ${r.status}: ${r.stderr}`);
  const op = JSON.parse(r.stdout);
  assert.equal(op.op, 'run_gate_review');
  assert.equal(op.gate, 'spec');
  assert.deepEqual(op.artifacts, ['spec.md', 'goals.md']);
});

test('spec gate: gate-hash on a goals_enabled bundle includes goals.md alongside spec.md', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  freezeInitialGoals(p, dir);
  fs.writeFileSync(path.join(dir, 'spec.md'), '# spec\n');
  const gh = JSON.parse(run(['gate-hash', `--state=${p}`, '--gate=spec']).stdout);
  assert.deepEqual(gh.artifacts, ['spec.md', 'goals.md']);
});

test('goals happy path: frozen goals + a recorded spec review lets set-phase --phase=plan advance', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  freezeInitialGoals(p, dir);
  fs.writeFileSync(path.join(dir, 'spec.md'), '# spec\n');
  passGate(p, 'spec');
  const r = run(['set-phase', `--state=${p}`, '--phase=plan']);
  assert.equal(r.status, 0, `should advance: ${r.stderr}${r.stdout}`);
  assert.equal(read(p).phase, 'plan');
});

test('spec gate re-arm: goals-amend rewrites goals.md and re-arms the spec gate (a stale review no longer satisfies it)', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const oldHash = freezeInitialGoals(p, dir);
  fs.writeFileSync(path.join(dir, 'spec.md'), '# spec\n');
  passGate(p, 'spec');
  const newHash = goalsHashFn(AMEND_MD);
  const gp = writeAmendGoals(dir, AMEND_MD);
  const ap = writeAmendApproval(dir, oldHash, newHash);
  assert.equal(
    run(['goals-amend', `--state=${p}`, `--goals=${gp}`, `--approval=${ap}`, '--reason=descope G2', '--ts=2026-07-02T00:00:00Z']).status,
    0
  );
  const r = run(['set-phase', `--state=${p}`, '--phase=plan']);
  assert.equal(r.status, 3, `goals-amend must re-arm the spec gate: ${r.stderr}`);
  const op = JSON.parse(r.stdout);
  assert.equal(op.op, 'run_gate_review');
  assert.equal(op.gate, 'spec');
});

test('split-brain guard (set-phase): goals.md drifted out-of-band from the committed hash → reconcile error, no advance', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  freezeInitialGoals(p, dir);
  fs.writeFileSync(path.join(dir, 'spec.md'), '# spec\n');
  fs.writeFileSync(path.join(dir, 'goals.md'), 'topic: tampered\n\n## G1: something else\nsignal: command\n');
  const r = run(['set-phase', `--state=${p}`, '--phase=plan']);
  assert.equal(r.status, 1, `split brain must hard-fail: ${r.stdout}`);
  assert.match(r.stderr, /split brain|does not match the committed/);
  assert.equal(read(p).phase, 'brainstorm');
});

test('split-brain guard (load-plan): drifted goals.md blocks materialization with a reconcile error', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  freezeInitialGoals(p, dir);
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  fs.writeFileSync(path.join(dir, 'goals.md'), 'topic: tampered\n\n## G1: drift\nsignal: command\n');
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 1, `split brain must hard-fail load-plan: ${r.stdout}`);
  assert.match(r.stderr, /split brain|does not match the committed/);
  assert.equal(read(p).tasks.length, 0);
});

test('split-brain guard NO-OPS pre-capture: a goals_enabled bundle with no goals_frozen event reaches the plan gate (not a reconcile error) on load-plan', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexFixture()));
  fs.writeFileSync(path.join(dir, 'spec.md'), '# spec\n'); // plan gate is fail-closed on missing artifacts
  fs.writeFileSync(path.join(dir, 'plan.md'), '# plan\n');
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 3, `expected the plan gate, got ${r.status}: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).gate, 'plan');
});

test('pre-feature exempt: a non-goals bundle (no goals_enabled marker) skips the capture gate entirely', () => {
  const p = tmpBundle(v8({ phase: 'brainstorm', tasks: [] }));
  fs.writeFileSync(path.join(path.dirname(p), 'spec.md'), '# spec\n');
  const r = run(['set-phase', `--state=${p}`, '--phase=plan']);
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).op, 'run_gate_review');
});

// ---- plan-index goal coverage: validate-plan-index + merge-plan-fragments enforce coverage ----
// (goalsBundle / freezeInitialGoals / GOALS_MD reused from the goals sections above. freezeInitialGoals
// freezes G1 + G2 into goals.md, state.goals, and the event log; coverage is enforced centrally by
// validatePlanIndex once loadGoalsForCoverage feeds it the frozen goal list.)
function writeCoverageIndex(dir, tasks) {
  const ip = path.join(dir, 'plan.index.json');
  fs.writeFileSync(ip, JSON.stringify({ schema_version: '6.0', tasks }));
  return ip;
}
function writeCoverageFragments(dir, tasks) {
  const fp = path.join(dir, 'fragments.json');
  fs.writeFileSync(fp, JSON.stringify([{ key: 'sub', tasks }]));
  return fp;
}

test('validate-plan-index: goals_enabled bundle passes when every goal is covered', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  freezeInitialGoals(p, dir);
  const ip = writeCoverageIndex(dir, [
    { id: 1, description: 'compile the widget', wave: 0, files: ['a.js'], verify_commands: [], codex: 'no', goals: ['G1'] },
    { id: 2, description: 'document the widget', wave: 0, files: ['b.js'], verify_commands: [], codex: 'no', goals: ['G2'] },
  ]);
  const r = run(['validate-plan-index', `--plan-index=${ip}`]);
  assert.equal(r.status, 0, `coverage should pass: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).valid, true);
});

test('validate-plan-index: goals_enabled bundle fails (exit 1) when a goal is uncovered', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  freezeInitialGoals(p, dir);
  const ip = writeCoverageIndex(dir, [
    { id: 1, description: 'compile the widget', wave: 0, files: ['a.js'], verify_commands: [], codex: 'no', goals: ['G1'] },
  ]);
  const r = run(['validate-plan-index', `--plan-index=${ip}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /goal "G2" is not covered/);
});

test('validate-plan-index: pre-feature bundle (no goals_enabled) skips coverage', () => {
  const dir = tmpDir('mp-cov-');
  const ip = writeCoverageIndex(dir, [
    { id: 1, description: 'do a thing', wave: 0, files: ['a.js'], verify_commands: [], codex: 'no' },
  ]);
  const r = run(['validate-plan-index', `--plan-index=${ip}`]);
  assert.equal(r.status, 0, `pre-feature coverage must be a no-op: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).valid, true);
});

test('merge-plan-fragments: goals_enabled bundle passes when every goal is covered', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  freezeInitialGoals(p, dir);
  const fp = writeCoverageFragments(dir, [
    { key: 't1', description: 'compile the widget', files: ['a.js'], verify_commands: [], codex: 'no', goals: ['G1'] },
    { key: 't2', description: 'document the widget', files: ['b.js'], verify_commands: [], codex: 'no', goals: ['G2'] },
  ]);
  const out = path.join(dir, 'plan.index.json');
  const r = run(['merge-plan-fragments', `--fragments=${fp}`, `--out=${out}`, '--generated-at=2026-07-01T00:00:00Z']);
  assert.equal(r.status, 0, `coverage should pass: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).tasks, 2);
});

test('merge-plan-fragments: goals_enabled bundle fails (exit 1) when a goal is uncovered', () => {
  const p = goalsBundle();
  const dir = path.dirname(p);
  freezeInitialGoals(p, dir);
  const fp = writeCoverageFragments(dir, [
    { key: 't1', description: 'compile the widget', files: ['a.js'], verify_commands: [], codex: 'no', goals: ['G1'] },
  ]);
  const out = path.join(dir, 'plan.index.json');
  const r = run(['merge-plan-fragments', `--fragments=${fp}`, `--out=${out}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /goal "G2" is not covered/);
  assert.equal(fs.existsSync(out), false, 'invalid merge must not land on disk');
});

test('merge-plan-fragments: pre-feature bundle (no goals_enabled) skips coverage', () => {
  const dir = tmpDir('mp-cov-');
  const fp = writeCoverageFragments(dir, [
    { key: 't1', description: 'do a thing', files: ['a.js'], verify_commands: [], codex: 'no' },
  ]);
  const out = path.join(dir, 'plan.index.json');
  const r = run(['merge-plan-fragments', `--fragments=${fp}`, `--out=${out}`]);
  assert.equal(r.status, 0, `pre-feature coverage must be a no-op: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).tasks, 1);
});

// ---- the planning verb (task 5: planning-fanout — plan-gate fold R6 bin coverage) ----
// `continue` on a plan-marker bundle is the planning verb: it must emit the broker
// dispatch_fanout planning op (read-only class + enumerated roots) and retain no
// launch_workflow(plan) arm. continue is a git-touching verb (mainRepoRoot), so unlike
// the fs-only fixtures above this one builds a minimal real repo around the bundle.
test('continue (planning verb): a plan marker yields the read-only dispatch_fanout planning op — no launch_workflow(plan) arm remains', () => {
  const repo = tmpDir('mp-bin-plan-');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  const bundleDir = path.join(repo, 'docs', 'masterplan', 'demo');
  fs.mkdirSync(bundleDir, { recursive: true });
  const statePath = path.join(bundleDir, 'state.yml');
  fs.writeFileSync(statePath, serializeState({
    schema_version: '6.0', slug: 'demo', status: 'in-progress', phase: 'plan',
    pending_gate: null, tasks: [],
    active_run: { kind: 'plan', phase: 'launching' },
    concurrency: { owner_lock: 'off' },
  }));
  // PI_CODING_AGENT stripped: the suppressed host path (serial reroute) is not under test here.
  const r = run(['continue', `--state=${statePath}`, '--now=2000'], { env: { ...process.env, PI_CODING_AGENT: '' } });
  assert.equal(r.status, 0, r.stderr);
  const op = JSON.parse(r.stdout);
  assert.equal(op.op, 'dispatch_fanout');
  assert.equal(op.kind, 'plan');
  assert.equal(op.read_only, true);
  assert.equal(op.class, 'masterplan-planning');
  assert.equal(op.next, 'stage-plan-fragments');
  assert.ok(Array.isArray(op.roots) && op.roots.length === 2, 'enumerated roots: repo + spec');
  assert.equal(op.roots[0], op.cwd);
  assert.equal(op.roots[1], path.join(bundleDir, 'spec.md'));
  assert.equal(op.spec_path, path.join(bundleDir, 'spec.md'));
  assert.ok(!r.stdout.includes('launch_workflow'), 'the launch_workflow(plan) arm is retired');
});

test('dispatch-plan: --subsystems required and JSON-validated; a non-plan marker dies loudly (no broker touched)', () => {
  const p = tmpBundle(v8()); // active_run: null — not a plan marker
  const miss = run(['dispatch-plan', `--state=${p}`]);
  assert.notEqual(miss.status, 0);
  assert.match(miss.stderr, /--subsystems/);
  const bad = run(['dispatch-plan', `--state=${p}`, '--subsystems={not json']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /valid JSON/);
  const noMarker = run(['dispatch-plan', `--state=${p}`, '--subsystems=[{"key":"core"}]']);
  assert.notEqual(noMarker.status, 0);
  assert.match(noMarker.stderr, /plan marker/);
});
