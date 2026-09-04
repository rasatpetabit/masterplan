// test/wave.test.mjs — wave preparation + post-barrier scope verification (build step 4).
// These are the L1 helpers that bracket the L2 Workflow engine; the engine itself is a dumb
// dispatch pipe (syntax-checked only), so ALL the decidable logic that CAN be tested lives
// here and is asserted directly — deterministic, no LLM, no fs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareWave, declaredScope, verifyScope, qctlEligible, checkWaveDisjoint, captureInputFingerprint, goalsReminder, bundleGoalsReminder, waveSummary, rawIntentOutcomeLine } from '../lib/wave.mjs';
import { parseGoals, preCodeMaskGoalsHash, goalsHash } from '../lib/goals.mjs';

// A state bundle (v8 shape) + a matching plan.index.json. Two waves; task 4 already done.
const state = () => ({
  tasks: [
    { id: 1, wave: 0, status: 'pending', files: ['a.js'] },
    { id: 2, wave: 0, status: 'pending', files: ['b.js'] },
    { id: 3, wave: 0, status: 'done', files: ['c.js'] },
    { id: 4, wave: 1, status: 'pending', files: ['d.js'] },
  ],
});
const planIndex = () => ({
  schema_version: '6.0',
  tasks: [
    { id: 1, description: 'Add a null check to parseConfig', files: ['a.js'], verify_commands: ['node --test'], codex: null },
    { id: 2, description: 'Design the cache layer', files: ['b.js'], verify_commands: ['node --test'], codex: null },
    { id: 3, description: 'done task', files: ['c.js'], verify_commands: ['node --test'], codex: null },
    { id: 4, description: 'Wire the route', files: ['d.js'], verify_commands: ['node --test'], codex: 'ok' },
  ],
});

// --- prepareWave: the pending set + the merge + the class-only fabric payload ----------------

test('prepareWave routes only the wave\'s NOT-done tasks (mirrors dispatch_wave)', () => {
  const { wave, tasks } = prepareWave(state(), planIndex(), 0, {}, {});
  assert.equal(wave, 0);
  assert.deepEqual(tasks.map((t) => t.id), [1, 2]); // task 3 is done → excluded
});

test('prepareWave merges plan.index fields and carries the dispatch class per task', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, {}, {});
  const [t1, t2] = tasks;
  assert.equal(t1.description, 'Add a null check to parseConfig');
  assert.deepEqual(t1.verify_commands, ['node --test']);
  // C6: routing is deferred to the policy resolver — every task carries its class, never a
  // pre-baked target/eligible/reason.
  assert.equal(t1.class, 'bounded-edit');
  assert.equal(t2.class, 'bounded-edit');
  assert.equal(t1.target, undefined);
  assert.equal(t2.target, undefined);
});

test('prepareWave honors a plan-pinned task class', () => {
  const pidx = planIndex();
  pidx.tasks[0].class = 'architecture';
  const { tasks } = prepareWave(state(), pidx, 0, {}, {});
  assert.equal(tasks[0].class, 'architecture');
  assert.equal(tasks[1].class, 'bounded-edit'); // unpinned → default
});

test('prepareWave emits ONLY the lean payload keys (goal 3 — nothing heavy transits context)', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, {}, {});
  assert.deepEqual(
    Object.keys(tasks[0]).sort(),
    ['class', 'description', 'files', 'id', 'verify_commands'],
  );
});

// --- prepareWave: the strangler phase flag (fabric) is the ONLY path -----------------------

test('prepareWave (state.dispatch.fabric) defers routing to the seam: class-only payload, NO target/backend', () => {
  const st = state();
  st.dispatch = { fabric: true };
  const { tasks } = prepareWave(st, planIndex(), 0, {}, {});
  // Model selection is deferred to core resolve/guard — masterplan no longer pre-bakes a route.
  assert.deepEqual(
    Object.keys(tasks[0]).sort(),
    ['class', 'description', 'files', 'id', 'verify_commands'],
  );
  assert.equal(tasks[0].class, 'bounded-edit'); // worker default (A2 repoint)
  assert.equal(tasks[0].target, undefined);
  assert.equal(tasks[0].backend, undefined);
  assert.equal(tasks[0].eligible, undefined);
});

test('prepareWave (config.fabric) is the SAME strangler flag as the wave dispatch op', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, { routing: 'auto', fabric: true }, {});
  assert.equal(tasks[0].class, 'bounded-edit');
  assert.equal(tasks[0].target, undefined);
});

test('prepareWave (flag absent) still emits the class-only payload — fabric is unconditional', () => {
  // C6: there is no longer a non-fabric payload; dispatch-wave fails closed on a non-fabric
  // bundle. Every prepareWave payload is the class-only fabric shape.
  const { tasks } = prepareWave(state(), planIndex(), 0, {}, {});
  assert.equal(tasks[0].class, 'bounded-edit');
  assert.equal(tasks[0].target, undefined);
  assert.equal(tasks[0].backend, undefined);
});

test('prepareWave (fabric) still composes handoff-idempotency keys (context uses class, not target/backend)', () => {
  const st = state();
  st.dispatch = { fabric: true };
  const dispatchInputs = { runId: 'run-x', head: 'abc', dirtyDigest: '', policyVersion: 'p1', workerVersion: 'w1' };
  const { tasks, input_fingerprint } = prepareWave(st, planIndex(), 0, {}, {}, undefined, dispatchInputs);
  assert.ok(input_fingerprint);
  assert.ok(tasks[0].idempotency.task_spec_hash);
  assert.ok(tasks[0].idempotency.handoff_key);
});

test('prepareWave keys by String(id) so a "1"/1 type mismatch still merges', () => {
  const pidx = { tasks: [{ id: '1', description: 'string-id task', files: ['a.js'], verify_commands: ['node --test'], codex: null }] };
  const st = { tasks: [{ id: 1, wave: 0, status: 'pending', files: ['a.js'] }] };
  const { tasks } = prepareWave(st, pidx, 0, {}, {});
  assert.equal(tasks[0].description, 'string-id task');
});

test('prepareWave throws on a non-integer wave (no silent empty wave)', () => {
  assert.throws(() => prepareWave(state(), planIndex(), '0', {}, {}), /must be an integer/);
});

test('prepareWave throws (fail loud) on a wave task missing from plan.index', () => {
  const st = { tasks: [{ id: 9, wave: 0, status: 'pending', files: ['z.js'] }] };
  assert.throws(() => prepareWave(st, planIndex(), 0, {}, {}), /no plan\.index\.json entry/);
});

test('prepareWave does not mutate its inputs', () => {
  const st = state();
  const pidx = planIndex();
  const frozen = JSON.stringify(st) + JSON.stringify(pidx);
  prepareWave(st, pidx, 0, { routing: 'auto' }, {});
  assert.equal(JSON.stringify(st) + JSON.stringify(pidx), frozen);
});

// --- prepareWave: the two dispatch-time concurrency gates (Phase 3a) ----------------------
// Each task's dispatch files are RESOLVED once (plan-wins-when-present) and that ONE set drives
// routing, the payload, and the F-SCOPE allow-set. Two gates fail loud BEFORE launch.

test('prepareWave throws (fail loud) when a task\'s plan-side and state-side file sets DIVERGE', () => {
  const st = { tasks: [{ id: 1, wave: 0, status: 'pending', files: ['state-side.js'] }] };
  const pidx = { tasks: [{ id: 1, description: 'x', files: ['plan-side.js'], verify_commands: ['node --test'], codex: null }] };
  // Both sides declare files and they disagree → drift (dispatching one scope while F-SCOPE polices
  // the other). Mirror the no-plan-entry throw rather than silently trusting one side.
  assert.throws(() => prepareWave(st, pidx, 0, {}, {}), /divergent file sets/);
});

test('prepareWave: plan-side files win when state omits them (resolved set = plan)', () => {
  const st = { tasks: [{ id: 1, wave: 0, status: 'pending' }] }; // no files key
  const pidx = { tasks: [{ id: 1, description: 'x', files: ['plan-side.js'], verify_commands: ['node --test'], codex: null }] };
  const { tasks } = prepareWave(st, pidx, 0, {}, {});
  assert.deepEqual(tasks[0].files, ['plan-side.js']);
});

test('prepareWave: state-side files used when plan omits them (resolved set = state)', () => {
  const st = { tasks: [{ id: 1, wave: 0, status: 'pending', files: ['state-side.js'] }] };
  const pidx = { tasks: [{ id: 1, description: 'x', files: [], verify_commands: ['node --test'], codex: null }] };
  const { tasks } = prepareWave(st, pidx, 0, {}, {});
  assert.deepEqual(tasks[0].files, ['state-side.js']);
});

test('prepareWave throws when same-wave tasks COLLIDE on the resolved set — the keystone gap validatePlanIndex misses', () => {
  // Plan.index omits files for both tasks → validatePlanIndex's static lint passes (empty sets never
  // overlap). But prepareWave's resolved set falls back to state, which collides. Only a dispatch-time
  // recheck on the RESOLVED payload catches it.
  const st = {
    tasks: [
      { id: 1, wave: 0, status: 'pending', files: ['shared.js'] },
      { id: 2, wave: 0, status: 'pending', files: ['shared.js'] },
    ],
  };
  const pidx = {
    tasks: [
      { id: 1, description: 'a', files: [], verify_commands: ['node --test'], codex: null },
      { id: 2, description: 'b', files: [], verify_commands: ['node --test'], codex: null },
    ],
  };
  assert.throws(() => prepareWave(st, pidx, 0, {}, {}), /collide on shared file\(s\) at dispatch/);
});

// --- checkWaveDisjoint: the pure pairwise overlap check (composed into prepareWave) -------

test('checkWaveDisjoint: disjoint file sets → ok with no conflicts', () => {
  const r = checkWaveDisjoint([
    { id: 1, files: ['a.js'] },
    { id: 2, files: ['b.js'] },
    { id: 3, files: ['c.js', 'd.js'] },
  ]);
  assert.deepEqual(r, { ok: true, conflicts: [] });
});

test('checkWaveDisjoint: a shared file → ok:false with the colliding pair {a,b,shared}', () => {
  const r = checkWaveDisjoint([
    { id: 1, files: ['a.js', 'shared.js'] },
    { id: 2, files: ['b.js', 'shared.js'] },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, [{ a: 1, b: 2, shared: ['shared.js'] }]);
});

test('checkWaveDisjoint: reports EVERY colliding pair (full pairwise sweep)', () => {
  const r = checkWaveDisjoint([
    { id: 1, files: ['shared.js'] },
    { id: 2, files: ['shared.js'] },
    { id: 3, files: ['shared.js'] },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, [
    { a: 1, b: 2, shared: ['shared.js'] },
    { a: 1, b: 3, shared: ['shared.js'] },
    { a: 2, b: 3, shared: ['shared.js'] },
  ]);
});

test('checkWaveDisjoint: tolerates missing/empty files and an empty/absent list', () => {
  assert.deepEqual(checkWaveDisjoint([]), { ok: true, conflicts: [] });
  assert.deepEqual(checkWaveDisjoint(), { ok: true, conflicts: [] });
  const r = checkWaveDisjoint([
    { id: 1 },              // no files key
    { id: 2, files: [] },   // empty
    { id: 3, files: ['x.js'] },
  ]);
  assert.deepEqual(r, { ok: true, conflicts: [] });
});

// --- declaredScope: the allowed-dirty union (done included) -------------------------------

test('declaredScope unions ALL wave tasks files, done included', () => {
  assert.deepEqual(declaredScope(state(), 0).sort(), ['a.js', 'b.js', 'c.js']); // c.js is the done task's
  assert.deepEqual(declaredScope(state(), 1), ['d.js']);
});

test('declaredScope is state-only (the fallback) — it does NOT read plan.index, even if passed a third arg', () => {
  // declaredScope is the back-compat fallback for a run with no launch-time active_run.scope snapshot.
  // The plan-wins resolution now lives in prepareWave's `scope` (the immutable snapshot), NOT here:
  // re-reading the mutable plan.index post-barrier was the F-SCOPE tamper hole (Codex Round-2 MAJOR), so
  // declaredScope deliberately ignores any extra argument and reads only the frozen-at-seed state files.
  const st = { tasks: [{ id: 1, wave: 0, status: 'pending', files: ['state-side.js'] }] };
  const pidx = { tasks: [{ id: 1, files: ['plan-side.js'] }] };
  assert.deepEqual(declaredScope(st, 0), ['state-side.js']);
  assert.deepEqual(declaredScope(st, 0, pidx), ['state-side.js']); // extra arg ignored — no plan.index read
});

// --- prepareWave.scope: the IMMUTABLE launch-time F-SCOPE snapshot -------------------------

test('prepareWave returns a `scope` = the resolved file UNION across the wave (plan-wins, deduped)', () => {
  const st = {
    tasks: [
      { id: 1, wave: 0, status: 'pending', files: [] },         // state omits -> plan-side wins
      { id: 2, wave: 0, status: 'pending', files: ['shared.js'] },
    ],
  };
  const pidx = {
    tasks: [
      { id: 1, description: 'a', files: ['plan-1.js'] }, // plan-side wins (state omitted)
      { id: 2, description: 'b', files: ['shared.js'] }, // plan == state
    ],
  };
  const { scope } = prepareWave(st, pidx, 0, {}, {});
  assert.deepEqual(scope.sort(), ['plan-1.js', 'shared.js']); // exactly what each task was dispatched with
});

test('prepareWave.scope equals the union of the dispatched tasks[].files (dispatch === policed set)', () => {
  const { tasks, scope } = prepareWave(state(), planIndex(), 0, { routing: 'auto' }, {});
  const union = [...new Set(tasks.flatMap((t) => t.files))].sort();
  assert.deepEqual([...scope].sort(), union);
});

// --- verifyScope: (after - before) ⊆ declared ---------------------------------------------

test('verifyScope: touched within declared → ok', () => {
  const r = verifyScope(['a.js', 'b.js'], ['preexisting.txt'], ['preexisting.txt', 'a.js', 'b.js']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.touched.sort(), ['a.js', 'b.js']);
  assert.deepEqual(r.outOfScope, []);
});

test('verifyScope: a path touched outside declared scope → breach', () => {
  const r = verifyScope(['a.js'], [], ['a.js', 'rogue.js']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.outOfScope, ['rogue.js']);
});

test('verifyScope: a pre-existing dirty file is NOT a breach (baseline subtraction)', () => {
  const r = verifyScope(['a.js'], ['user-wip.js'], ['user-wip.js', 'a.js']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.touched, ['a.js']); // user-wip.js was already dirty → not "introduced"
});

test('verifyScope: a declared directory scope (trailing /) covers every path under it', () => {
  const r = verifyScope(['test/fixtures/'], [], ['test/fixtures/a.json', 'test/fixtures/sub/b.json']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.outOfScope, []);
});

test('verifyScope: a directory scope does NOT cover paths outside it', () => {
  const r = verifyScope(['test/fixtures/'], [], ['test/fixtures/a.json', 'lib/rogue.js']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.outOfScope, ['lib/rogue.js']);
});

test('verifyScope: a directory-name prefix without the slash is not a dir scope match', () => {
  // 'test/fixtures' (file entry) must not accidentally allow 'test/fixtures-evil.js'.
  const r = verifyScope(['test/fixtures/'], [], ['test/fixtures-evil.js']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.outOfScope, ['test/fixtures-evil.js']);
});

test('verifyScope: empty everything → vacuously ok', () => {
  assert.deepEqual(verifyScope([], [], []), { ok: true, touched: [], outOfScope: [] });
});

// --- prepareWave: the implementer-backend descriptor (resolveImplementerBackend) ---
// C6: the qctl seam attaches `backend` ONLY when config.implementer.qctl.enabled === true AND the
// task is qctl-eligible; {kind:'agent'} (the default) is OMITTED entirely — payloads and handoff
// keys stay byte-identical for tasks that don't select qctl.
test('prepareWave omits backend by default — {kind:agent} is never sent on the wire', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, {}, {});
  assert.ok(tasks.length >= 1);
  for (const t of tasks) assert.equal('backend' in t, false, 'default payload must not carry a backend key');
});

// Fixture allowlist that covers task 1 (files: ['a.js']) and task 4 (files: ['d.js']).
// The scope globs deliberately use "/**" form to exercise the glob matcher.
const fixtureAllowlist = {
  'test-repo': {
    scope: ['a.js', 'b.js', 'd.js/**', 'd.js'],
  },
};

test('prepareWave attaches a {kind:qctl} backend when implementer.qctl.enabled (scope == task.files)', () => {
  const { tasks } = prepareWave(
    state(), planIndex(), 0,
    { routing: 'auto', implementer: { qctl: { enabled: true } } }, {},
    fixtureAllowlist,
  );
  const t1 = tasks.find((t) => t.id === 1);
  assert.equal(t1.backend.kind, 'qctl');
  assert.deepEqual(t1.backend.scope, ['a.js']);          // task 1's plan.index files
  assert.deepEqual(t1.backend.verify, ['node --test']);  // task 1's verify_commands
  assert.equal(t1.backend.deliver, 'patch');
});

// --- qctlEligible: eligibility predicate tests -----------------------------------------------

// (a) Flag-off omits backend entirely — no allowlist needed, never consulted.
test('qctlEligible (a): flag-off backend is omitted — no allowlist passed, nothing consulted', () => {
  // Flag-off: no allowlist at all. Must NOT throw or deref allowlist.
  const { tasks } = prepareWave(
    state(), planIndex(), 0,
    { routing: 'auto', implementer: { qctl: { enabled: false } } }, {},
    // deliberately omit reposAllowlist — it must never be touched
  );
  for (const t of tasks) {
    assert.equal('backend' in t, false,
      `flag-off: task ${t.id} should carry no backend key but got ${JSON.stringify(t.backend)}`);
  }
});

test('qctlEligible (a): flag completely absent — backend omitted (byte-identical payload)', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, {}, {});
  for (const t of tasks) {
    assert.equal('backend' in t, false);
  }
});

// (b) Flag-on + fixture allowlist: infra task excluded, allowlisted bounded task eligible.
test('qctlEligible (b): infra/systemd file is excluded even with flag on', () => {
  const infraTask = {
    files: ['etc/systemd/system/foo.service'],
    verify_commands: ['node --test'],
    sensitive: false,
  };
  assert.equal(qctlEligible(infraTask, fixtureAllowlist), false,
    'systemd file must be ineligible regardless of allowlist');
});

test('qctlEligible (b): allowlisted bounded task is eligible', () => {
  const boundedTask = {
    files: ['a.js'],
    verify_commands: ['node --test'],
    sensitive: false,
  };
  assert.equal(qctlEligible(boundedTask, fixtureAllowlist), true,
    'allowlisted bounded task must be eligible');
});

test('qctlEligible (b): task not in allowlist is not eligible (flag on)', () => {
  const outsideTask = {
    files: ['some/other/repo/file.js'],
    verify_commands: ['node --test'],
    sensitive: false,
  };
  assert.equal(qctlEligible(outsideTask, fixtureAllowlist), false,
    'file outside any allowlist scope must be ineligible');
});

test('qctlEligible (b): prepareWave with flag-on + fixture allowlist — infra task omits backend (ineligible → field OMITTED)', () => {
  const infraState = {
    tasks: [
      { id: 1, wave: 0, status: 'pending', files: ['etc/systemd/system/foo.service'] },
    ],
  };
  const infraPlanIndex = {
    tasks: [
      {
        id: 1,
        description: 'Wire the systemd unit',
        files: ['etc/systemd/system/foo.service'],
        verify_commands: ['systemctl --version'],
        codex: null,
      },
    ],
  };
  const { tasks } = prepareWave(
    infraState, infraPlanIndex, 0,
    { routing: 'auto', implementer: { qctl: { enabled: true } } }, {},
    fixtureAllowlist,
  );
  // C6: an ineligible task's `backend` key is OMITTED entirely (never {kind:'agent'} on the wire).
  assert.equal('backend' in tasks[0], false,
    'infra/systemd task with flag-on must omit the backend key');
});

test('qctlEligible (b): sensitive task is excluded even with flag on and allowlisted files', () => {
  const sensitiveTask = {
    files: ['a.js'],
    verify_commands: ['node --test'],
    sensitive: true,
  };
  assert.equal(qctlEligible(sensitiveTask, fixtureAllowlist), false);
});

test('qctlEligible (b): no verify_commands → not eligible', () => {
  const noVerify = {
    files: ['a.js'],
    verify_commands: [],
    sensitive: false,
  };
  assert.equal(qctlEligible(noVerify, fixtureAllowlist), false);
});

test('qctlEligible (b): router/serving path is excluded (infra hard-block)', () => {
  const routerTask = {
    files: ['config/router/haproxy.cfg'],
    verify_commands: ['node --test'],
    sensitive: false,
  };
  assert.equal(qctlEligible(routerTask, fixtureAllowlist), false);
});

test('qctlEligible (b): .github/workflows/deploy.yml is excluded (infra hard-block)', () => {
  const ciTask = {
    files: ['.github/workflows/deploy.yml'],
    verify_commands: ['node --test'],
    sensitive: false,
  };
  assert.equal(qctlEligible(ciTask, fixtureAllowlist), false);
});

// (c) Cross-repo agreement test: shells to python3 to parse the REAL repos.yml and asserts
//     the predicate agrees petabit-sysadmin (P1 target) is eligible and an infra task is not.
//     Skip-gated cleanly when the sibling fabric file or python/pyyaml is absent.
{
  const REPOS_YML = '/srv/dev/petabit/skynet/scripts/qwen-fabric/config/repos.yml';

  // Probe whether python3 + pyyaml are available.
  let pythonAvail = false;
  try {
    execFileSync('python3', ['-c', 'import yaml,json'], { stdio: 'ignore' });
    pythonAvail = true;
  } catch (_) { /* pyyaml absent */ }

  const canRun = existsSync(REPOS_YML) && pythonAvail;

  test(
    'qctlEligible (c): cross-repo agreement — petabit-sysadmin eligible; infra task not',
    { skip: !canRun ? 'repos.yml absent or python/pyyaml unavailable' : false },
    () => {
      // Parse the REAL repos.yml via python3 (masterplan stays YAML-dependency-free in Node).
      // Path is a module-level constant — no user input, no injection risk.
      const raw = execFileSync(
        'python3',
        ['-c', `import yaml,json; print(json.dumps(yaml.safe_load(open('${REPOS_YML}'))))`],
        { encoding: 'utf8' },
      );
      const reposAllowlist = JSON.parse(raw);

      // Verify petabit-sysadmin is in the parsed allowlist.
      assert.ok('petabit-sysadmin' in reposAllowlist,
        'petabit-sysadmin must be present in repos.yml');

      // A bounded task within petabit-sysadmin's allowed scope should be eligible.
      const p1Task = {
        files: ['scripts/buildrack/mqm9700-health-report/health_report.py'],
        verify_commands: ['python3 -m pytest tests/test_mqm9700_health_report.py -q'],
        sensitive: false,
      };
      assert.equal(qctlEligible(p1Task, reposAllowlist), true,
        'petabit-sysadmin bounded task within scope must be eligible');

      // An infra/systemd task must be ineligible regardless of allowlist.
      const infraTask = {
        files: ['etc/systemd/system/myservice.service'],
        verify_commands: ['systemctl --version'],
        sensitive: false,
      };
      assert.equal(qctlEligible(infraTask, reposAllowlist), false,
        'infra/systemd task must be ineligible even against real repos.yml');
    },
  );
}

// --- handoff idempotency (spec §5.5): dispatchInputs wiring + captureInputFingerprint ------

// A valid launch-time capture, as captureInputFingerprint would return + the run id.
const dispatchInputs = () => ({
  runId: 'run-slug',
  head: 'a'.repeat(40),
  dirtyDigest: '',
  policyVersion: 'pol-v1',
  workerVersion: 'wrk-v1',
});

test('prepareWave with dispatchInputs attaches LEAN idempotency block per task + wave input_fingerprint', () => {
  const res = prepareWave(state(), planIndex(), 0, { routing: 'auto' }, {}, undefined, dispatchInputs());
  assert.match(res.input_fingerprint, /^[0-9a-f]{64}$/);
  for (const t of res.tasks) {
    assert.deepEqual(Object.keys(t.idempotency).sort(), ['handoff_key', 'input_fingerprint', 'task_spec_hash']);
    assert.match(t.idempotency.task_spec_hash, /^[0-9a-f]{64}$/);
    assert.equal(t.idempotency.input_fingerprint, res.input_fingerprint); // one fingerprint per wave
    assert.ok(t.idempotency.handoff_key.startsWith('fabric-idem-v1:run-slug:'));
    // The FULL key binds spec hash AND fingerprint (spec §5.5 — never spec-hash-only).
    assert.ok(t.idempotency.handoff_key.endsWith(`:${t.idempotency.task_spec_hash}:${res.input_fingerprint}`));
  }
  // Distinct task bodies → distinct spec hashes and keys.
  assert.notEqual(res.tasks[0].idempotency.task_spec_hash, res.tasks[1].idempotency.task_spec_hash);
  assert.notEqual(res.tasks[0].idempotency.handoff_key, res.tasks[1].idempotency.handoff_key);
});

test('prepareWave with dispatchInputs is deterministic (same inputs → same hashes/keys)', () => {
  const a = prepareWave(state(), planIndex(), 0, { routing: 'auto' }, {}, undefined, dispatchInputs());
  const b = prepareWave(state(), planIndex(), 0, { routing: 'auto' }, {}, undefined, dispatchInputs());
  assert.equal(a.input_fingerprint, b.input_fingerprint);
  assert.deepEqual(a.tasks.map((t) => t.idempotency), b.tasks.map((t) => t.idempotency));
  // Changed environmental facts → different fingerprint AND different handoff keys.
  const dirty = prepareWave(state(), planIndex(), 0, { routing: 'auto' }, {}, undefined,
    { ...dispatchInputs(), dirtyDigest: 'f'.repeat(64) });
  assert.notEqual(dirty.input_fingerprint, a.input_fingerprint);
  assert.notEqual(dirty.tasks[0].idempotency.handoff_key, a.tasks[0].idempotency.handoff_key);
  // Task spec hash covers only the task body/context, not the environment.
  assert.equal(dirty.tasks[0].idempotency.task_spec_hash, a.tasks[0].idempotency.task_spec_hash);
});

test('prepareWave WITHOUT dispatchInputs keeps the class-only payload shape (no idempotency keys)', () => {
  const res = prepareWave(state(), planIndex(), 0, {}, {});
  assert.deepEqual(Object.keys(res).sort(), ['scope', 'tasks', 'wave']);
  assert.deepEqual(
    Object.keys(res.tasks[0]).sort(),
    ['class', 'description', 'files', 'id', 'verify_commands'],
  );
});

// captureInputFingerprint: git faked via the injectable _exec — NO real git spawns here.
const fakeGit = (byCmd) => (cmd, args) => {
  // args = ['-C', dir, subcmd, ...]; key on the git subcommand.
  const key = args[2];
  const out = byCmd[key];
  if (out instanceof Error) throw out;
  return out ?? '';
};

test('captureInputFingerprint: clean tree → head + empty dirtyDigest, deterministic across calls', () => {
  const exec = fakeGit({ 'rev-parse': 'abc123\n', status: '' });
  const a = captureInputFingerprint('/wt', { policyVersion: 'p1', workerVersion: 'w1' }, exec);
  const b = captureInputFingerprint('/wt', { policyVersion: 'p1', workerVersion: 'w1' }, exec);
  assert.deepEqual(a, { head: 'abc123', dirtyDigest: '', policyVersion: 'p1', workerVersion: 'w1' });
  assert.deepEqual(a, b); // unchanged tree → identical capture
});

test('captureInputFingerprint: dirty tree → stable sha256 digest that changes when dirty state changes', () => {
  const dirty1 = fakeGit({ 'rev-parse': 'abc123', status: ' M a.js', diff: 'diff --git a/a.js\n-x\n+y' });
  const a = captureInputFingerprint('/wt', {}, dirty1);
  const b = captureInputFingerprint('/wt', {}, dirty1);
  assert.match(a.dirtyDigest, /^[0-9a-f]{64}$/);
  assert.equal(a.dirtyDigest, b.dirtyDigest); // unchanged dirty state → same digest
  const dirty2 = fakeGit({ 'rev-parse': 'abc123', status: ' M a.js', diff: 'diff --git a/a.js\n-x\n+z' });
  assert.notEqual(captureInputFingerprint('/wt', {}, dirty2).dirtyDigest, a.dirtyDigest);
  const clean = fakeGit({ 'rev-parse': 'abc123', status: '' });
  assert.equal(captureInputFingerprint('/wt', {}, clean).dirtyDigest, '');
});

test('captureInputFingerprint: git failure → fail-loud error naming the worktree and command', () => {
  const boom = Object.assign(new Error('spawn failed'), { stderr: 'fatal: not a git repository' });
  const exec = fakeGit({ 'rev-parse': boom });
  assert.throws(
    () => captureInputFingerprint('/nope', {}, exec),
    /captureInputFingerprint: git -C \/nope rev-parse HEAD failed: fatal: not a git repository/,
  );
});

// ---------------------------------------------------------------------------
// The mid-run goals reminder (wave task 5)
// ---------------------------------------------------------------------------

const V2_GOALS = [
  'topic: |',
  '  make the finish prove the deploy',
  '',
  '## Intent',
  'why: runs archive without proving anything was deployed',
  'outcome: a run archives complete only when the thing is live and the operator agrees',
  'anti_goals: a green test suite standing in for a deployment',
  'done_means: release, install and a live check',
  '',
  '## G1: The deploy stage runs',
  '## G2: The live check gates the archive',
  '## G3: The operator confirms intent',
  '',
].join('\n');

const V1_GOALS = [
  'topic: ship the widget',
  '',
  '## G1: the widget compiles',
  'signal: command',
  '',
  '## G2: the widget is documented',
  'signal: docs',
  '',
].join('\n');

test('a v2 reminder quotes the Intent outcome line VERBATIM', () => {
  const r = goalsReminder(V2_GOALS);
  assert.equal(r.version, 2);
  // Verbatim: a paraphrase is a different bar from the one the finish measures against.
  assert.equal(r.outcome, 'a run archives complete only when the thing is live and the operator agrees');
  // Asserted against the SOURCE document, not against the parsed value the implementation
  // also produced — comparing the reminder to its own input would prove nothing.
  const sourceLine = V2_GOALS.split('\n').find((l) => l.startsWith('outcome:'));
  assert.equal(r.line, sourceLine);
  assert.equal(r.goals.length, 3);
});

test('a v2 outcome line is quoted with its ORIGINAL spacing, not a normalized rebuild', () => {
  // The teeth of "verbatim": the parsed value is trimmed and split off its key, so a reminder
  // rebuilt from it silently reformats the operator's own words. Padded, this fixture differs
  // from any reconstruction.
  const padded = V2_GOALS.replace(
    /^outcome: .*$/m,
    'outcome:    the release is live   and the operator agrees   ',
  );
  const r = goalsReminder(padded);
  const sourceLine = padded.split('\n').find((l) => l.trimStart().startsWith('outcome:'));
  assert.equal(r.line, sourceLine, 'the source line survives byte for byte');
  assert.notEqual(r.line, `outcome: ${r.outcome}`, 'a rebuild from the parsed value would differ');
});

test('rawIntentOutcomeLine only reads INSIDE the Intent block', () => {
  // A goal further down the document may legitimately carry its own `outcome:` key. Picking
  // that up instead of the Intent's would quote the wrong bar entirely.
  const withGoalOutcome = [
    'topic: t', '',
    '## Intent',
    'why: w',
    'outcome: the intent outcome',
    'done_means: d', '',
    '## G1: a goal',
    'outcome: the GOAL outcome, which is not the intent',
    '## G2: another', '## G3: a third', '',
  ].join('\n');
  assert.equal(rawIntentOutcomeLine(withGoalOutcome), 'outcome: the intent outcome');
  // No Intent block at all → nothing to quote, even though the document has an outcome line.
  assert.equal(rawIntentOutcomeLine('## G1: g\noutcome: not an intent\n'), null);
  assert.equal(rawIntentOutcomeLine(null), null);
});

test('a v1 bundle with no Intent block falls back to its goals rather than erroring', () => {
  const r = goalsReminder(V1_GOALS);
  assert.equal(r.version, 1);
  assert.equal(r.outcome, null, 'there is no Intent block to quote');
  assert.match(r.line, /^goals: /);
  assert.match(r.line, /G1: the widget compiles/);
  assert.match(r.line, /G2: the widget is documented/);
});

test('an absent or empty goals document yields a reminder with no line', () => {
  for (const input of [null, undefined, '', '   ', 42]) {
    const r = goalsReminder(input);
    assert.equal(r.line, null, JSON.stringify(input));
    assert.equal(r.version, null);
    assert.deepEqual(r.goals, []);
  }
});

test('a NON-EMPTY malformed document is swallowed rather than taking down the wave', () => {
  // These reach parseGoals for real (the empty-input cases above are rejected before it), so
  // this is the case that actually exercises the catch. A reminder is a courtesy; the
  // finish-time goal check is what enforces the bar, and a summary must never fail a wave.
  const malformed = '## Intent\nwhy: only a why, no outcome and no goals at all\n';
  const r = goalsReminder(malformed);
  assert.equal(r.line, null);
  assert.deepEqual(r.goals, []);
});

test('a v2 document whose Intent carries no outcome still reminds with its goals', () => {
  const noOutcome = V2_GOALS.replace(/^outcome: .*$/m, 'why: only a why here');
  const r = goalsReminder(noOutcome);
  assert.equal(r.version, 2, 'the Intent block still makes it v2');
  assert.equal(r.outcome, null);
  assert.match(r.line, /^goals: /);
});

test('waveSummary is terse and carries the reminder', () => {
  const v2 = waveSummary({ wave: 3, recorded: [14, 25, 45], next: 'wave 4', goalsMd: V2_GOALS });
  assert.equal(v2.lines.length, 2, 'one summary line plus the reminder — never a flood');
  assert.match(v2.lines[0], /^wave 3: recorded tasks 14, 25, 45 — next: wave 4$/);
  assert.match(v2.lines[1], /^outcome: a run archives complete/);

  // A failed count is surfaced, and a bundle with no goals produces no second line.
  const failed = waveSummary({ wave: 4, recorded: [3], failed: [{ id: 9 }], goalsMd: null });
  assert.match(failed.lines[0], /1 failed/);
  assert.equal(failed.lines.length, 1);
});

test('bundleGoalsReminder reads the bundle and tolerates a bundle with no goals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wave-goals-'));
  try {
    assert.equal(bundleGoalsReminder(dir).line, null, 'no goals.md is not an error');
    fs.writeFileSync(path.join(dir, 'goals.md'), V2_GOALS);
    assert.match(bundleGoalsReminder(dir).line, /^outcome: a run archives complete/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- round-2 findings: the extractor must use the parser's own lexical rules -------------

test('a FENCED example outcome is never quoted as the run\'s intent', () => {
  // A goals document may quote markdown as an example — this project's own do. Quoting a
  // sample back to the operator as the bar the finish measures against is worse than quoting
  // nothing at all.
  const withFence = [
    'topic: t', '',
    '## Intent',
    'why: w',
    '```text',
    'outcome: EXAMPLE, do not use',
    '```',
    'outcome: the release is live',
    'done_means: d', '',
    '## G1: a', '## G2: b', '## G3: c', '',
  ].join('\n');
  assert.equal(rawIntentOutcomeLine(withFence), 'outcome: the release is live');

  // An INDENTED code block is code too.
  const indented = [
    'topic: t', '',
    '## Intent',
    'why: w',
    '',
    '    outcome: an indented example',
    '',
    'outcome: the real one',
    '', '## G1: a', '## G2: b', '## G3: c', '',
  ].join('\n');
  assert.equal(rawIntentOutcomeLine(indented), 'outcome: the real one');

  // ...and when the ONLY outcome-looking line is fenced, there is nothing to quote.
  const onlyFenced = ['## Intent', 'why: w', '```', 'outcome: example', '```', '', '## G1: a', ''].join('\n');
  assert.equal(rawIntentOutcomeLine(onlyFenced), null);
});

test('an H1 ends the Intent block; an H3 does not', () => {
  const afterH1 = [
    '## Intent', 'why: w', 'done_means: d', '',
    '# Notes',
    'outcome: this is NOT the intent outcome', '',
  ].join('\n');
  assert.equal(rawIntentOutcomeLine(afterH1), null, 'content past an H1 is outside the block');

  const underH3 = [
    '## Intent', 'why: w',
    '### Detail',
    'outcome: still inside the Intent block', '',
  ].join('\n');
  assert.equal(rawIntentOutcomeLine(underH3), 'outcome: still inside the Intent block');
});

test('a DUPLICATE Intent heading resolves the same way parseGoals does — the last one wins', () => {
  // parseGoals re-initialises its intent on every `## Intent`, so the later block is what its
  // verdict is judged against. A quotation that picked the earlier one would show the operator
  // a different bar from the one actually in force.
  const dup = [
    'topic: t', '',
    '## Intent', 'why: first', 'outcome: the FIRST outcome', '',
    '## Intent', 'why: second', 'outcome: the SECOND outcome', '',
    '## G1: a', '## G2: b', '## G3: c', '',
  ].join('\n');
  assert.equal(rawIntentOutcomeLine(dup), 'outcome: the SECOND outcome');
  assert.equal(parseGoals(dup).intent.outcome, 'the SECOND outcome', 'and the parser agrees');

  // ...including when the later block has none: the parser's reset means there is no outcome
  // in force, so there is nothing to quote either.
  const dupNoSecond = [
    'topic: t', '',
    '## Intent', 'why: first', 'outcome: the FIRST outcome', '',
    '## Intent', 'why: second', 'done_means: d', '',
    '## G1: a', '## G2: b', '## G3: c', '',
  ].join('\n');
  assert.equal(rawIntentOutcomeLine(dupNoSecond), null);
  assert.equal(parseGoals(dupNoSecond).intent.outcome, '');
});

test('a CRLF document yields a clean line — no stray carriage return', () => {
  // split('\n') alone strips the LF and leaves the CR ON the line: a control character in the
  // operator's summary, and only half the terminator removed.
  const crlf = V2_GOALS.replace(/\n/g, '\r\n');
  const r = goalsReminder(crlf);
  assert.equal(r.line.includes('\r'), false, JSON.stringify(r.line));
  assert.equal(r.line, 'outcome: a run archives complete only when the thing is live and the operator agrees');

  // Only the TERMINATOR is removed — real leading and trailing spaces still survive.
  const padded = V2_GOALS.replace(/^outcome: .*$/m, 'outcome:   padded and trailing   ').replace(/\n/g, '\r\n');
  assert.equal(goalsReminder(padded).line, 'outcome:   padded and trailing   ');
});

// ---- round-3: the quotation and the parse must describe the SAME document ----------------
//
// The reminder is now taken from the parser's own capture of the line it assigned, so the two
// cannot use different lexical rules. Each case below asserts BOTH sides agree — a divergence
// in either direction is the defect these close.

function agrees(doc, expectedLine, expectedValue) {
  const parsed = parseGoals(doc);
  assert.equal(rawIntentOutcomeLine(doc), expectedLine, 'raw line');
  assert.equal(parsed.intentOutcomeLine ?? null, expectedLine, 'the parser captured the same line');
  assert.equal(parsed.intent ? parsed.intent.outcome : '', expectedValue, 'and the value it assigned');
}

test('a fenced example is invisible to BOTH the parser and the quotation', () => {
  const onlyFenced = [
    'topic: t', '',
    '## Intent', 'why: w',
    '```text',
    'outcome: EXAMPLE, do not use',
    '```',
    'done_means: d', '',
    '## G1: a', '## G2: b', '## G3: c', '',
  ].join('\n');
  // Neither picks up the example: the reminder falls back to the goal list, and the verdict is
  // judged against a document with no declared outcome.
  agrees(onlyFenced, null, '');
});

test('a LONGER fence is not closed by a shorter fence-looking line inside it', () => {
  // The mask used to collapse every backtick fence to three, so a ```text line inside a
  // ````markdown block read as the closer and everything after it stopped being masked.
  const nested = [
    'topic: t', '',
    '## Intent', 'why: w',
    '````markdown',
    '```text',
    'outcome: EXAMPLE inside the four-backtick fence',
    '```',
    '````',
    'outcome: the real one',
    'done_means: d', '',
    '## G1: a', '## G2: b', '## G3: c', '',
  ].join('\n');
  agrees(nested, 'outcome: the real one', 'the real one');

  // A fence with a trailing word is not a closer either.
  const notAClose = [
    '## Intent', 'why: w',
    '```',
    'outcome: still inside',
    '``` and some prose',
    'outcome: also still inside',
    '```',
    'outcome: out at last', '',
  ].join('\n');
  agrees(notAClose, 'outcome: out at last', 'out at last');
});

test('an INDENTED H1 ends the Intent block, for the parser as well as the quotation', () => {
  // A heading may carry up to three leading spaces and still be a heading. Requiring `#` at
  // column zero let a validly-indented H1 be walked straight through.
  for (const indent of ['', ' ', '  ', '   ']) {
    const doc = [
      'topic: t', '',
      '## Intent', 'why: w', 'done_means: d', '',
      `${indent}# Notes`,
      'outcome: this is NOT the intent outcome', '',
      '## G1: a', '## G2: b', '## G3: c', '',
    ].join('\n');
    agrees(doc, null, '');
  }
  // Four spaces is an indented code block, not a heading — so the block never ends, and the
  // line after it is still inside Intent.
  const codeIndent = [
    'topic: t', '',
    '## Intent', 'why: w',
    '    # not a heading, this is code',
    'outcome: still inside the block', '',
    '## G1: a', '## G2: b', '## G3: c', '',
  ].join('\n');
  agrees(codeIndent, 'outcome: still inside the block', 'still inside the block');
});

test('DUPLICATE outcome lines in one block: the last wins on both sides', () => {
  // The extractor used to return the first eligible line while the parser's field assignment
  // kept the last — so the operator was shown wording the verdict was not judged against.
  const dup = [
    'topic: t', '',
    '## Intent', 'why: w',
    'outcome: obsolete wording',
    'outcome: final wording',
    'done_means: d', '',
    '## G1: a', '## G2: b', '## G3: c', '',
  ].join('\n');
  agrees(dup, 'outcome: final wording', 'final wording');
});

test('an Intent block AFTER the goals still wins, empty or not', () => {
  const afterGoals = [
    'topic: t', '',
    '## Intent', 'why: first', 'outcome: the first outcome', '',
    '## G1: a', '## G2: b', '## G3: c', '',
    '## Intent', 'why: last', 'outcome: the last outcome', '',
  ].join('\n');
  agrees(afterGoals, 'outcome: the last outcome', 'the last outcome');

  const afterGoalsEmpty = [
    'topic: t', '',
    '## Intent', 'why: first', 'outcome: the first outcome', '',
    '## G1: a', '## G2: b', '## G3: c', '',
    '## Intent', 'why: last', 'done_means: d', '',
  ].join('\n');
  agrees(afterGoalsEmpty, null, '');
});

test('CRLF: the parser captures a clean line, and the value still parses', () => {
  const doc = ['topic: t', '', '## Intent', 'why: w', 'outcome:  padded  ', 'done_means: d', '',
    '## G1: a', '## G2: b', '## G3: c', ''].join('\r\n');
  agrees(doc, 'outcome:  padded  ', 'padded');
  assert.equal(rawIntentOutcomeLine(doc).includes('\r'), false);
});

// ---- round-4: the code-aware parse is a NORMALIZATION CHANGE, and tabs indent code ---------

test('a TAB-indented example is code, so it can never become the declared outcome', () => {
  // Markdown measures indentation in COLUMNS and a tab is a full step, so a single leading tab
  // is an indented code block. Counting characters read it as one space of whitespace, leaving
  // the example as content — the exact escape the mask exists to close.
  const tabbed = ['topic: t', '', '## Intent', 'why: w',
    '\toutcome: EXAMPLE, not the intent', '', '## G1: a', '## G2: b', '## G3: c', ''].join('\n');
  agrees(tabbed, null, '');

  // A tab-indented fence marker is code too, not a fence opener — so it cannot close or open
  // a block and swallow the real outcome after it.
  const tabFence = ['topic: t', '', '## Intent', 'why: w',
    '\t```', 'outcome: the real one', '', '## G1: a', '## G2: b', '## G3: c', ''].join('\n');
  assert.equal(rawIntentOutcomeLine(tabFence), 'outcome: the real one');

  // Spaces then a tab still reaches four columns.
  const mixed = ['## Intent', 'why: w', '  \toutcome: also code', ''].join('\n');
  assert.equal(rawIntentOutcomeLine(mixed), null);
});

test('preCodeMaskGoalsHash detects a bundle whose stored hash predates the code mask', () => {
  // Masking code and ending Intent at an H1 are corrections, but they are ALSO a normalization
  // change: a goals.md that quotes parser-looking text hashed differently before. Re-deriving
  // its hash without noticing would void every goal_check and goal_waived receipt keyed to the
  // stored one — the same hazard legacyGoalsHash guards for the `topic: |` block form.
  const fenced = ['topic: t', '', '## Intent', 'why: w', 'outcome: the real outcome',
    '```text', 'outcome: an example', '```', 'done_means: d', '',
    '## G1: a', '## G2: b', '## G3: c', ''].join('\n');
  const before = preCodeMaskGoalsHash(fenced);
  assert.ok(before, 'a document quoting parser-looking text is a migration');
  assert.notEqual(before, goalsHash(parseGoals(fenced)), 'and the two hashes really differ');
  // The old parse took the fenced line (last assignment wins); the new one does not.
  assert.equal(parseGoals(fenced).intent.outcome, 'the real outcome');

  // A document with nothing to mask is NOT a migration — null, so no bundle is warned without
  // cause.
  const plain = ['topic: t', '', '## Intent', 'why: w', 'outcome: the real outcome', 'done_means: d', '',
    '## G1: a', '## G2: b', '## G3: c', ''].join('\n');
  assert.equal(preCodeMaskGoalsHash(plain), null);
  assert.equal(preCodeMaskGoalsHash(42), null);
});

test('this run\'s OWN frozen goals.md is not a migration', () => {
  // The change must not invalidate the bundle it is being developed in — checked directly
  // rather than assumed, because a re-hash here would void this run's own receipts.
  const live = fs.readFileSync(
    path.join('/srv/dev/ras/masterplan', 'docs', 'masterplan', 'intent-to-completion', 'goals.md'),
    'utf8',
  );
  assert.equal(preCodeMaskGoalsHash(live), null, 'the live bundle hashes identically under both parsers');
});