// test/bundle.test.mjs — v8 run-bundle state read/write + pure transforms.
// Canonical v8 state.yml is flat: one `key: value` per line, complex values as inline
// JSON (valid YAML flow). Legacy v7 block-style is migrate.mjs's concern, not this module's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseState,
  serializeState,
  readState,
  writeState,
  openGate,
  clearGate,
  setActiveRun,
  clearActiveRun,
  setPhase,
  setStatus,
  markTask,
  loadPlanTasks,
  CORE_REQUIRED_FIELDS,
  validateCoreState,
  buildSeedState,
  appendEvent,
} from '../lib/bundle.mjs';

test('round-trips scalars with correct types', () => {
  const s = { schema_version: '6.0', slug: 'my-run', current_wave: 2, autonomy: 'loose', done: true, pending_gate: null };
  const out = parseState(serializeState(s));
  assert.deepEqual(out, s);
  assert.equal(typeof out.schema_version, 'string'); // "6.0" stays a string, not 6
  assert.equal(typeof out.current_wave, 'number');
});

test('round-trips nested objects and arrays via inline JSON', () => {
  const s = {
    active_run: { run_id: 'wf_x', task_id: 'k1', wave: 2 },
    tasks: [
      { id: 1, wave: 1, status: 'done', files: ['a.txt'] },
      { id: 2, wave: 2, status: 'pending', files: ['b.txt', 'c.txt'] },
    ],
    blockers: [],
  };
  assert.deepEqual(parseState(serializeState(s)), s);
});

test('preserves strings that look like numbers / bools / null by quoting them', () => {
  const s = { a: '6.0', b: 'true', c: 'null', d: '123', e: 'sha256:abc-DEF.0' };
  const out = parseState(serializeState(s));
  assert.deepEqual(out, s);
  assert.equal(typeof out.a, 'string');
  assert.equal(typeof out.d, 'string');
});

test('handles empty string and values needing quotes (spaces, colons, unicode)', () => {
  const s = { empty: '', spaced: 'has space', special: 'a: b # c', uni: 'em—dash', ts: '2026-05-16T16:00:00Z' };
  assert.deepEqual(parseState(serializeState(s)), s);
});

test('parse skips ---, comments, and blank lines', () => {
  assert.deepEqual(parseState('---\n# a comment\n\nslug: x\ncurrent_wave: 3\n'), { slug: 'x', current_wave: 3 });
});

test('writeState/readState round-trip atomically on disk (auto-creates dirs, cleans tmp)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-bundle-'));
  try {
    const sp = path.join(dir, 'sub', 'state.yml');
    const state = { schema_version: '6.0', slug: 'r', tasks: [{ id: 1, wave: 1, status: 'pending', files: [] }], active_run: null };
    writeState(sp, state);
    assert.ok(fs.existsSync(sp));
    assert.ok(!fs.existsSync(sp + '.tmp'));
    assert.deepEqual(readState(sp), state);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('state transforms are pure and correct', () => {
  const base = {
    slug: 'r', pending_gate: null, active_run: null,
    tasks: [{ id: 1, wave: 1, status: 'pending', files: [] }, { id: 2, wave: 1, status: 'pending', files: [] }],
  };
  const frozen = JSON.stringify(base);

  const gate = { id: 'plan_approval', opened_at: '2026-01-01T00:00:00Z' };
  assert.deepEqual(openGate(base, gate).pending_gate, gate);
  assert.equal(clearGate(openGate(base, gate)).pending_gate, null);

  const run = { run_id: 'wf_1', task_id: 'k', wave: 1 };
  assert.deepEqual(setActiveRun(base, run).active_run, run);
  assert.equal(clearActiveRun(setActiveRun(base, run)).active_run, null);

  assert.equal(markTask(base, 2, 'done').tasks.find((t) => t.id === 2).status, 'done');
  assert.equal(markTask(base, 2, 'done').tasks.find((t) => t.id === 1).status, 'pending');

  assert.equal(setPhase(base, 'plan').phase, 'plan');
  assert.equal(setStatus(base, 'archived').status, 'archived');

  assert.equal(JSON.stringify(base), frozen); // never mutated
});

test('markTask throws on an unknown id (no silent no-op that fakes success)', () => {
  // MEDIUM regression: markTask used to return state UNCHANGED for an unknown id, so the bin
  // reported success and the shell believed a result was recorded — recovery would then re-dispatch
  // already-done work. The transform now refuses a phantom write.
  const s = { tasks: [{ id: 1, wave: 1, status: 'pending', files: [] }] };
  assert.throws(() => markTask(s, 99, 'done'), /no task with id 99/);
  assert.equal(markTask(s, 1, 'done').tasks[0].status, 'done'); // known id still works
});

test('loadPlanTasks: materializes {id,status,wave,files} + sets phase=execute in one object (the atomic seam)', () => {
  const base = { slug: 'x', phase: 'plan', tasks: [] };
  const idx = { tasks: [
    { id: '1', wave: 0, description: 'a', files: ['a.mjs'], verify_commands: ['true'], codex: null },
    { id: 2, parallel_group: undefined, wave: 1, description: 'b', files: ['b.mjs'], codex: 'ok' },
  ] };
  const next = loadPlanTasks(base, idx);
  assert.equal(next.phase, 'execute'); // phase + tasks land together (the bin writes this one object atomically)
  assert.deepEqual(next.tasks, [
    { id: 1, status: 'pending', wave: 0, files: ['a.mjs'] }, // numeric-string id → Number; codex/verify_commands dropped
    { id: 2, status: 'pending', wave: 1, files: ['b.mjs'] },
  ]);
});
test('loadPlanTasks: refuses a non-empty task list, an empty index, and a non-integer wave', () => {
  assert.throws(() => loadPlanTasks({ tasks: [{ id: 1 }] }, { tasks: [{ id: 1, wave: 0 }] }), /already has 1 task/);
  assert.throws(() => loadPlanTasks({ tasks: [] }, { tasks: [] }), /no tasks/);
  assert.throws(() => loadPlanTasks({ tasks: [] }, { tasks: [{ id: 1, wave: '0' }] }), /non-integer wave/);
});

test('validateCoreState: a well-formed v8 core (with tasks) is valid', () => {
  const ok = {
    schema_version: 6, slug: 'r', status: 'executing', phase: 'execute',
    tasks: [{ id: 1, wave: 1, status: 'pending', files: [] }],
    active_run: null, pending_gate: null,
  };
  assert.deepEqual(validateCoreState(ok), []);
});

test('validateCoreState: a pre-plan (brainstorm) bundle WITHOUT tasks is valid', () => {
  // tasks is intentionally NOT required-present — a brainstorm-phase bundle has none yet.
  const brainstorm = { schema_version: 6, slug: 'r', status: 'brainstorming', phase: 'brainstorm' };
  assert.deepEqual(validateCoreState(brainstorm), []);
});

test('validateCoreState: flags each missing required field', () => {
  const problems = validateCoreState({ schema_version: 6 }); // slug/status/phase absent
  assert.ok(problems.some((p) => /missing required field: slug/.test(p)));
  assert.ok(problems.some((p) => /missing required field: status/.test(p)));
  assert.ok(problems.some((p) => /missing required field: phase/.test(p)));
  assert.ok(!problems.some((p) => /schema_version/.test(p))); // present + valid -> not flagged
});

test('validateCoreState: schema_version < 6 and non-number are flagged', () => {
  const core = { slug: 'r', status: 's', phase: 'p' };
  assert.ok(validateCoreState({ ...core, schema_version: 3 }).some((p) => /schema_version must be a number >= 6/.test(p)));
  assert.ok(validateCoreState({ ...core, schema_version: '6' }).some((p) => /schema_version must be a number >= 6/.test(p)));
});

test('validateCoreState: tasks present-but-not-array, and bad active_run/pending_gate types', () => {
  const core = { schema_version: 6, slug: 'r', status: 's', phase: 'p' };
  assert.ok(validateCoreState({ ...core, tasks: {} }).some((p) => /tasks must be an array/.test(p)));
  assert.ok(validateCoreState({ ...core, active_run: 'wf_x' }).some((p) => /active_run must be an object or null/.test(p)));
  // pending_gate is the v8 one-marker object form (or null) — NOT the legacy string. Regression: the
  // old "string or null" rule contradicted openGate/migrate/`mp open-gate`, false-positiving doctor on
  // every gated bundle. A string/number is now flagged; the {id,…} object is accepted.
  assert.ok(validateCoreState({ ...core, pending_gate: 42 }).some((p) => /pending_gate must be null or an object with a string id/.test(p)));
  assert.ok(validateCoreState({ ...core, pending_gate: 'plan_approval' }).some((p) => /pending_gate must be null or an object/.test(p)));
  assert.ok(validateCoreState({ ...core, pending_gate: {} }).some((p) => /pending_gate must be null or an object/.test(p))); // object without an id
  assert.deepEqual(validateCoreState({ ...core, pending_gate: { id: 'plan_approval', opened_at: 't' } }), []); // the canonical open-gate form is valid
  assert.deepEqual(validateCoreState({ ...core, pending_gate: null }), []);
});

test('validateCoreState: non-object input is reported, never throws', () => {
  assert.deepEqual(validateCoreState(null), ['state is not an object']);
  assert.deepEqual(validateCoreState('nope'), ['state is not an object']);
  assert.deepEqual(validateCoreState(undefined), ['state is not an object']);
});

test('CORE_REQUIRED_FIELDS is the frozen v8 core key set', () => {
  assert.deepEqual(CORE_REQUIRED_FIELDS, ['schema_version', 'slug', 'status', 'phase']);
});

test('parseState∘serializeState round-trips a fuzz of scalar / object / array shapes', () => {
  const samples = [
    { k: 0 }, { k: -42 }, { k: 3.14 }, { k: true }, { k: false }, { k: null },
    { k: '' }, { k: 'plain' }, { k: 'has space' }, { k: 'a: b # c' }, { k: 'em—dash café' },
    { k: '123' }, { k: '6.0' }, { k: 'true' }, { k: 'null' }, { k: '~' },
    { k: 'sha256:ab-CD.0' }, { k: '2026-05-28T16:00:00Z' },
    { k: [] }, { k: [1, 2, 3] }, { k: ['a', 'b'] }, { k: {} }, { k: { a: 1, b: 'x', c: [true, null] } },
    { a: 1, b: 'two', c: { d: [3] }, e: null, f: '' },
  ];
  for (const s of samples) {
    assert.deepEqual(parseState(serializeState(s)), s, `round-trip failed for ${JSON.stringify(s)}`);
  }
});

test('buildSeedState: a minimal seed is a core-valid v8 brainstorm bundle with the right defaults', () => {
  const s = buildSeedState({ slug: 'demo', topic: 'a topic', createdAt: '2026-05-29T00:00:00Z' });
  assert.deepEqual(validateCoreState(s), []); // valid by construction (the builder also asserts this)
  assert.equal(s.schema_version, 8);
  assert.equal(s.phase, 'brainstorm');
  assert.equal(s.status, 'in-progress');
  assert.equal(s.slug, 'demo');
  assert.equal(s.topic, 'a topic');
  assert.equal(s.created_at, '2026-05-29T00:00:00Z');
  assert.deepEqual(s.tasks, []);
  assert.equal(s.active_run, null);
  assert.equal(s.pending_gate, null);
  assert.equal(s.complexity, null); // optional fields default to null, not undefined (round-trippable)
  assert.equal(s.planning_mode, 'auto');
  assert.deepEqual(parseState(serializeState(s)), s); // survives the on-disk format
});

test('buildSeedState: optional fields and overrides are carried through', () => {
  const s = buildSeedState({
    slug: 'r', topic: 't', createdAt: 'T', phase: 'plan', status: 'planning', schemaVersion: 9,
    complexity: 'high', complexitySource: 'interview', autonomy: 'loose', planningMode: 'serial',
    predecessorTranscript: '/p/x.jsonl', specPath: 'd/spec.md', planPath: 'd/plan.md', planIndexPath: 'd/plan.index.json',
  });
  assert.equal(s.phase, 'plan');
  assert.equal(s.status, 'planning');
  assert.equal(s.schema_version, 9);
  assert.equal(s.complexity, 'high');
  assert.equal(s.complexity_source, 'interview');
  assert.equal(s.autonomy, 'loose');
  assert.equal(s.planning_mode, 'serial');
  assert.equal(s.predecessor_transcript, '/p/x.jsonl');
  assert.equal(s.spec_path, 'd/spec.md');
  assert.equal(s.plan_index_path, 'd/plan.index.json');
});

test('buildSeedState: refuses an incomplete seed (slug/topic/createdAt all required)', () => {
  assert.throws(() => buildSeedState({ topic: 't', createdAt: 'T' }), /slug is required/);
  assert.throws(() => buildSeedState({ slug: 's', createdAt: 'T' }), /topic is required/);
  assert.throws(() => buildSeedState({ slug: 's', topic: 't' }), /createdAt is required/);
});

test('appendEvent: writes one JSON line per call, accumulating, into a sibling events.jsonl', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-events-'));
  try {
    const sp = path.join(dir, 'state.yml');
    const ep = appendEvent(sp, { type: 'seeded', ts: 'T1' });
    assert.equal(ep, path.join(dir, 'events.jsonl')); // derived as a sibling of state.yml
    appendEvent(sp, { type: 'gate_opened', ts: 'T2', data: { id: 'plan_approval' } });
    const lines = fs.readFileSync(ep, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { type: 'seeded', ts: 'T1' });
    assert.deepEqual(JSON.parse(lines[1]), { type: 'gate_opened', ts: 'T2', data: { id: 'plan_approval' } });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
