// test/wave.test.mjs — wave preparation + post-barrier scope verification (build step 4).
// These are the L1 helpers that bracket the L2 Workflow engine; the engine itself is a dumb
// dispatch pipe (syntax-checked only), so ALL the decidable logic that CAN be tested lives
// here and is asserted directly — deterministic, no LLM, no fs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareWave, declaredScope, verifyScope } from '../lib/wave.mjs';

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

// --- declaredScope: the allowed-dirty union (done included) -------------------------------

test('declaredScope unions ALL wave tasks files, done included', () => {
  assert.deepEqual(declaredScope(state(), 0).sort(), ['a.js', 'b.js', 'c.js']); // c.js is the done task's
  assert.deepEqual(declaredScope(state(), 1), ['d.js']);
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

test('verifyScope: empty everything → vacuously ok', () => {
  assert.deepEqual(verifyScope([], [], []), { ok: true, touched: [], outOfScope: [] });
});

// --- prepareWave: the implementer-backend descriptor (resolveImplementerBackend) ---
test('prepareWave attaches a {kind:agent} backend to every task by default (flag off)', () => {
  const { tasks } = prepareWave(state(), planIndex(), 0, { routing: 'auto' }, {});
  assert.ok(tasks.length >= 1);
  for (const t of tasks) assert.deepEqual(t.backend, { kind: 'agent' });
});

test('prepareWave attaches a {kind:qctl} backend when implementer.qctl.enabled (scope == task.files)', () => {
  const { tasks } = prepareWave(
    state(), planIndex(), 0,
    { routing: 'auto', implementer: { qctl: { enabled: true } } }, {},
  );
  const t1 = tasks.find((t) => t.id === 1);
  assert.equal(t1.backend.kind, 'qctl');
  assert.deepEqual(t1.backend.scope, ['a.js']);          // task 1's plan.index files
  assert.deepEqual(t1.backend.verify, ['node --test']);  // task 1's verify_commands
  assert.equal(t1.backend.deliver, 'patch');
});
