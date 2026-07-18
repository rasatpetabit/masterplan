// test/wave.test.mjs — wave preparation + post-barrier scope verification (build step 4).
// These are the L1 helpers that bracket the L2 Workflow engine; the engine itself is a dumb
// dispatch pipe (syntax-checked only), so ALL the decidable logic that CAN be tested lives
// here and is asserted directly — deterministic, no LLM, no fs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { prepareWave, declaredScope, verifyScope, qctlEligible, checkWaveDisjoint, captureInputFingerprint } from '../lib/wave.mjs';

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

// --- prepareWave: the pending set + the merge + routing -----------------------------------

test('prepareWave routes only the wave\'s NOT-done tasks (mirrors dispatch_wave)', () => {
  const { wave, tasks } = prepareWave(state(), planIndex(), 0, { routing: 'auto' }, {});
  assert.equal(wave, 0);
  assert.deepEqual(tasks.map((t) => t.id), [1, 2]); // task 3 is done → excluded
});

test('prepareWave merges plan.index fields and runs the heuristic per task', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, { routing: 'auto' }, {});
  const [t1, t2] = tasks;
  assert.equal(t1.description, 'Add a null check to parseConfig');
  assert.deepEqual(t1.verify_commands, ['node --test']);
  assert.equal(t1.target, 'codex'); // clean → heuristic eligible
  assert.equal(t2.target, 'inline'); // "Design …" is a judgment verb → ineligible
  assert.equal(t2.reason, 'heuristic-rejected');
});

test('prepareWave honors annotation + env overrides via routeTask', () => {
  const okAnno = prepareWave(state(), planIndex(), 1, { routing: 'auto' }, {});
  assert.equal(okAnno.tasks[0].target, 'codex'); // task 4 codex:'ok'
  assert.equal(okAnno.tasks[0].reason, 'annotation-ok');
  const suppressed = prepareWave(state(), planIndex(), 1, { routing: 'auto' }, { codexHostSuppressed: true });
  assert.equal(suppressed.tasks[0].target, 'inline');
  assert.equal(suppressed.tasks[0].reason, 'host-suppressed');
});

test('prepareWave emits ONLY the lean payload keys (goal 3 — nothing heavy transits context)', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, {}, {});
  assert.deepEqual(
    Object.keys(tasks[0]).sort(),
    ['backend', 'description', 'eligible', 'files', 'id', 'reason', 'target', 'verify_commands'],
  );
});

// --- prepareWave: fabric phase flag routes through core resolve/guard via the seam ---------

test('prepareWave (fabric via state.dispatch.fabric) defers routing to the seam: class-only payload, NO target/backend', () => {
  const st = state();
  st.dispatch = { fabric: true };
  const { tasks } = prepareWave(st, planIndex(), 0, { routing: 'auto' }, {});
  // Model selection is deferred to core resolve/guard — masterplan no longer pre-bakes a route.
  assert.deepEqual(
    Object.keys(tasks[0]).sort(),
    ['class', 'description', 'files', 'id', 'verify_commands'],
  );
  assert.equal(tasks[0].class, 'masterplan-implementation'); // worker default
  assert.equal(tasks[0].target, undefined);
  assert.equal(tasks[0].backend, undefined);
  assert.equal(tasks[0].eligible, undefined);
});

test('prepareWave (fabric via config.fabric) is the SAME strangler flag as the wave dispatch op', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, { routing: 'auto', fabric: true }, {});
  assert.equal(tasks[0].class, 'masterplan-implementation');
  assert.equal(tasks[0].target, undefined);
});

test('prepareWave (fabric) honors a plan-pinned task class', () => {
  const pidx = planIndex();
  pidx.tasks[0].class = 'architecture';
  const { tasks } = prepareWave(state(), pidx, 0, { fabric: true }, {});
  assert.equal(tasks[0].class, 'architecture');
});

test('prepareWave (fabric off) is byte-identical to the legacy routeTask/resolveTaskBackend payload', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, { routing: 'auto' }, {});
  assert.equal(tasks[0].target, 'codex'); // legacy routing brain still runs when the flag is off
  assert.equal(tasks[0].class, undefined);
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
test('prepareWave attaches a {kind:agent} backend to every task by default (flag off)', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, { routing: 'auto' }, {});
  assert.ok(tasks.length >= 1);
  for (const t of tasks) assert.deepEqual(t.backend, { kind: 'agent' });
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

// (a) Flag-off routes byte-identically to {kind:'agent'} — no allowlist needed, never consulted.
test('qctlEligible (a): flag-off backend is byte-identical {kind:agent} with NO allowlist passed', () => {
  // Flag-off: no allowlist at all. Must NOT throw or deref allowlist.
  const { tasks } = prepareWave(
    state(), planIndex(), 0,
    { routing: 'auto', implementer: { qctl: { enabled: false } } }, {},
    // deliberately omit reposAllowlist — it must never be touched
  );
  for (const t of tasks) {
    assert.deepEqual(t.backend, { kind: 'agent' },
      `flag-off: task ${t.id} should be {kind:'agent'} but got ${JSON.stringify(t.backend)}`);
  }
});

test('qctlEligible (a): flag completely absent backend is byte-identical {kind:agent}', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, {}, {});
  for (const t of tasks) {
    assert.deepEqual(t.backend, { kind: 'agent' });
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

test('qctlEligible (b): prepareWave with flag-on + fixture allowlist — infra task downgrades to {kind:agent}', () => {
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
  assert.equal(tasks[0].backend.kind, 'agent',
    'infra/systemd task with flag-on must downgrade to {kind:agent}');
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
    assert.ok(t.idempotency.handoff_key.startsWith('adsp-idem-v1:run-slug:'));
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

test('prepareWave WITHOUT dispatchInputs keeps the legacy shape byte-identical (no idempotency keys)', () => {
  const res = prepareWave(state(), planIndex(), 0, {}, {});
  assert.deepEqual(Object.keys(res).sort(), ['scope', 'tasks', 'wave']);
  assert.deepEqual(
    Object.keys(res.tasks[0]).sort(),
    ['backend', 'description', 'eligible', 'files', 'id', 'reason', 'target', 'verify_commands'],
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
