// test/plan-merge.test.mjs — regression suite for the deterministic plan merge core.
//
// This module owns the root-cause fix for two observed anomalies:
//   (1) codex field-shape drift — a drafter/assembler emitted `codex: {eligible,reason}`
//       (an object) but routing only honours the STRING enum "ok"|"no"|null; an object
//       silently falls through to the heuristic. Merge normalises; validate rejects.
//   (2) wave re-authoring / under-decomposition — an LLM re-waved disjoint tasks into
//       single-task waves. Here the LLM NEVER authors waves: deterministic JS layers them
//       from the dependency DAG + file-disjointness, packing each wave maximally.
//
// The single most load-bearing test is the cross-fragment FORWARD-REFERENCE dep case:
// parallel drafters emit fragments in arbitrary order, so a dependent task can carry a
// LOWER id than the task it depends on. Wave assignment must follow the dependency graph
// (topological order), never the id sequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergePlanFragments,
  validatePlanIndex,
  renderPlanMd,
  normalizeCodex,
} from '../lib/plan-merge.mjs';

// Fragment factory — one subsystem with its task list. Keeps tests terse.
const frag = (key, tasks) => ({ key, tasks });
const task = (key, over = {}) => ({
  key,
  description: `do ${key}`,
  files: [`${key}.js`],
  verify_commands: [`test ${key}`],
  ...over,
});

// Locate an emitted task by the source key carried through for provenance lookups.
// Emitted tasks are keyed by integer id; we match back via description (stable per key).
const byDesc = (index, key) => index.tasks.find((t) => t.description === `do ${key}`);

// ── normalizeCodex: the anomaly-1 normaliser ────────────────────────────────
test('normalizeCodex passes through the canonical string enum', () => {
  assert.equal(normalizeCodex('ok'), 'ok');
  assert.equal(normalizeCodex('no'), 'no');
  assert.equal(normalizeCodex(null), null);
  assert.equal(normalizeCodex(undefined), null);
});

test('normalizeCodex coerces booleans to the string enum', () => {
  assert.equal(normalizeCodex(true), 'ok');
  assert.equal(normalizeCodex(false), 'no');
});

test('normalizeCodex coerces the {eligible} object shape (anomaly 1)', () => {
  assert.equal(normalizeCodex({ eligible: true }), 'ok');
  assert.equal(normalizeCodex({ eligible: false }), 'no');
  assert.equal(normalizeCodex({ eligible: true, reason: 'has verify' }), 'ok');
});

test('normalizeCodex maps anything else to null (never leaks a non-enum)', () => {
  assert.equal(normalizeCodex('maybe'), null);
  assert.equal(normalizeCodex(0), null);
  assert.equal(normalizeCodex(1), null);
  assert.equal(normalizeCodex({}), null);
  assert.equal(normalizeCodex({ eligible: 'yes' }), null);
  assert.equal(normalizeCodex([]), null);
});

// ── id assignment ────────────────────────────────────────────────────────────
test('merge assigns 1-based integer ids in fragment-then-task order', () => {
  const index = mergePlanFragments([
    frag('auth', [task('a1'), task('a2')]),
    frag('api', [task('b1')]),
  ]);
  assert.deepEqual(index.tasks.map((t) => t.id), [1, 2, 3]);
  for (const t of index.tasks) assert.ok(Number.isInteger(t.id));
  assert.equal(index.schema_version, '6.0');
});

test('merge normalises every task codex to the string enum in output', () => {
  const index = mergePlanFragments([
    frag('s', [
      task('obj', { codex: { eligible: true, reason: 'x' } }),
      task('bool', { codex: false, files: ['bool.js'] }),
      task('str', { codex: 'ok', files: ['str.js'] }),
    ]),
  ]);
  assert.equal(byDesc(index, 'obj').codex, 'ok');
  assert.equal(byDesc(index, 'bool').codex, 'no');
  assert.equal(byDesc(index, 'str').codex, 'ok');
  // And the produced index passes its own validator.
  assert.deepEqual(validatePlanIndex(index), []);
});

// ── wave layering: the anomaly-2 guard ───────────────────────────────────────
test('N disjoint no-dep tasks all land in wave 0 (anti-under-decomposition)', () => {
  const tasks = ['t1', 't2', 't3', 't4', 't5'].map((k) => task(k)); // distinct files
  const index = mergePlanFragments([frag('s', tasks)]);
  assert.deepEqual(index.tasks.map((t) => t.wave), [0, 0, 0, 0, 0]);
});

test('tasks sharing a file are serialised into different waves', () => {
  const index = mergePlanFragments([
    frag('s', [
      task('a', { files: ['shared.js'] }),
      task('b', { files: ['shared.js'] }),
    ]),
  ]);
  assert.notEqual(byDesc(index, 'a').wave, byDesc(index, 'b').wave);
});

test('a dependency forces the dependent into a strictly higher wave', () => {
  const index = mergePlanFragments([
    frag('s', [
      task('base', { files: ['base.js'] }),
      task('dep', { files: ['dep.js'], deps: ['base'] }),
    ]),
  ]);
  assert.ok(byDesc(index, 'dep').wave > byDesc(index, 'base').wave);
});

// THE load-bearing test: cross-fragment dep where the dependent has a LOWER id than its
// dependency (fragment order places the dependent first). id-order wave assignment breaks
// here; topological-order assignment is correct.
test('cross-fragment forward-reference dep waves correctly (lower-id dependent)', () => {
  const index = mergePlanFragments([
    // fragment B drafted/ordered FIRST → its task gets the lower id…
    frag('B', [task('b-consumer', { files: ['b.js'], deps: ['a-producer'] })]),
    // …but it depends on a task in fragment A, drafted second → higher id.
    frag('A', [task('a-producer', { files: ['a.js'] })]),
  ]);
  const consumer = byDesc(index, 'b-consumer');
  const producer = byDesc(index, 'a-producer');
  assert.equal(producer.id, 2);          // assigned second
  assert.equal(consumer.id, 1);          // assigned first (lower id)
  assert.equal(producer.wave, 0);        // no deps
  assert.equal(consumer.wave, 1);        // strictly after its dependency despite lower id
});

test('a diamond of cross-fragment deps layers to the longest path', () => {
  // a (w0) → b,c (w1) → d (w2). b and c are disjoint so they share wave 1.
  const index = mergePlanFragments([
    frag('top', [task('a', { files: ['a.js'] })]),
    frag('mid', [
      task('b', { files: ['b.js'], deps: ['a'] }),
      task('c', { files: ['c.js'], deps: ['a'] }),
    ]),
    frag('bot', [task('d', { files: ['d.js'], deps: ['b', 'c'] })]),
  ]);
  assert.equal(byDesc(index, 'a').wave, 0);
  assert.equal(byDesc(index, 'b').wave, 1);
  assert.equal(byDesc(index, 'c').wave, 1);
  assert.equal(byDesc(index, 'd').wave, 2);
});

// ── fail-loud invariants ─────────────────────────────────────────────────────
test('a dependency cycle fails loud rather than hanging', () => {
  assert.throws(
    () => mergePlanFragments([
      frag('s', [
        task('a', { deps: ['b'] }),
        task('b', { deps: ['a'] }),
      ]),
    ]),
    /cycle/i,
  );
});

test('a dangling dep (unknown key) fails loud', () => {
  assert.throws(
    () => mergePlanFragments([frag('s', [task('a', { deps: ['ghost'] })])]),
    /unknown|ghost/i,
  );
});

test('a duplicate task key across fragments fails loud', () => {
  assert.throws(
    () => mergePlanFragments([
      frag('A', [task('dup')]),
      frag('B', [task('dup')]),
    ]),
    /duplicate/i,
  );
});

// ── determinism ──────────────────────────────────────────────────────────────
test('merge is deterministic — same input yields byte-identical output', () => {
  const build = () => mergePlanFragments([
    frag('A', [task('a1', { deps: [] }), task('a2', { files: ['a1.js'] })]),
    frag('B', [task('b1', { deps: ['a1'] })]),
  ]);
  assert.equal(JSON.stringify(build()), JSON.stringify(build()));
});

test('merge does not mutate its input fragments', () => {
  const input = [frag('s', [task('a', { codex: { eligible: true } })])];
  const snapshot = JSON.stringify(input);
  mergePlanFragments(input);
  assert.equal(JSON.stringify(input), snapshot);
});

// ── validatePlanIndex: strict gate (also guards hand-authored / serial-path indexes) ──
test('validatePlanIndex accepts a clean index', () => {
  const index = mergePlanFragments([frag('s', [task('a'), task('b', { files: ['b.js'] })])]);
  assert.deepEqual(validatePlanIndex(index), []);
});

test('validatePlanIndex rejects a non-string codex (the silent-fallthrough trap)', () => {
  const bad = { schema_version: '6.0', tasks: [
    { id: 1, description: 'x', wave: 0, files: [], verify_commands: [], codex: { eligible: true } },
  ] };
  const errors = validatePlanIndex(bad);
  assert.ok(errors.some((e) => /codex/i.test(e)));
});

test('validatePlanIndex rejects non-integer id and wave', () => {
  const bad = { schema_version: '6.0', tasks: [
    { id: '1', description: 'x', wave: 0, files: [], verify_commands: [], codex: null },
    { id: 2, description: 'y', wave: 1.5, files: [], verify_commands: [], codex: null },
  ] };
  const errors = validatePlanIndex(bad);
  assert.ok(errors.some((e) => /id/i.test(e)));
  assert.ok(errors.some((e) => /wave/i.test(e)));
});

test('validatePlanIndex rejects duplicate ids and empty descriptions', () => {
  const bad = { schema_version: '6.0', tasks: [
    { id: 1, description: 'x', wave: 0, files: [], verify_commands: [], codex: null },
    { id: 1, description: '   ', wave: 1, files: [], verify_commands: [], codex: null },
  ] };
  const errors = validatePlanIndex(bad);
  assert.ok(errors.some((e) => /duplicate/i.test(e)));
  assert.ok(errors.some((e) => /description/i.test(e)));
});

test('validatePlanIndex rejects same-wave file overlap', () => {
  const bad = { schema_version: '6.0', tasks: [
    { id: 1, description: 'x', wave: 0, files: ['shared.js'], verify_commands: [], codex: null },
    { id: 2, description: 'y', wave: 0, files: ['shared.js'], verify_commands: [], codex: null },
  ] };
  const errors = validatePlanIndex(bad);
  assert.ok(errors.some((e) => /shared\.js/.test(e) && /wave/i.test(e)));
});

// ── renderPlanMd: plan.md is a deterministic projection of the index ─────────
test('renderPlanMd is deterministic and contains every task', () => {
  const index = mergePlanFragments([
    frag('s', [task('a'), task('b', { files: ['b.js'] }), task('c', { files: ['c.js'], deps: ['a'] })]),
  ]);
  const md1 = renderPlanMd(index, { title: 'Test plan' });
  const md2 = renderPlanMd(index, { title: 'Test plan' });
  assert.equal(md1, md2);
  for (const t of index.tasks) assert.ok(md1.includes(t.description), `plan.md missing "${t.description}"`);
  assert.ok(md1.includes('# Test plan'));
});
