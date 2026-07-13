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
  buildTasksFromPlanIndex,
  upsertTasks,
  rebasePaths,
  appendEvent,
  setCoordination,
  clearCoordination,
  CAPABILITY_EVENT_TYPE,
  GOAL_LIFECYCLE_EVENT_TYPES,
  buildCapabilityEvent,
  inferGoalsCapability,
  checkGoalsCapabilityAuthority,
  setRenderConfig,
  CURRENT_SCHEMA_VERSION,
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

  // rebasePaths: rewrite the absolute path fields under a new repo root (CD-7 writer for repo relocation).
  const relocated = rebasePaths(
    { ...base, spec_path: '/tmp/old-masterplan/docs/b/spec.md', plan_path: '/tmp/old-masterplan/docs/b/plan.md',
      plan_index_path: '/tmp/old-masterplan/docs/b/plan.index.json', worktree: '/tmp/old-masterplan/.worktrees/b',
      topic: 'unrelated' },
    '/tmp/old-masterplan', '/srv/dev/ras/masterplan',
  );
  assert.equal(relocated.spec_path, '/srv/dev/ras/masterplan/docs/b/spec.md');
  assert.equal(relocated.plan_path, '/srv/dev/ras/masterplan/docs/b/plan.md');
  assert.equal(relocated.plan_index_path, '/srv/dev/ras/masterplan/docs/b/plan.index.json');
  assert.equal(relocated.worktree, '/srv/dev/ras/masterplan/.worktrees/b');
  assert.equal(relocated._rebased, 4);
  assert.equal(relocated.topic, 'unrelated'); // unrelated field untouched

  // re-running with the same `from` is a no-op (the prefix no longer matches)
  const idempotent = rebasePaths(relocated, '/tmp/old-masterplan', '/srv/dev/ras/masterplan');
  assert.equal(idempotent._rebased, 0);
  assert.deepEqual(idempotent.spec_path, relocated.spec_path);

  // non-string / relative roots are rejected; identical roots is a no-op (not a throw)
  assert.throws(() => rebasePaths(base, null, '/x'), /must be strings/);
  assert.throws(() => rebasePaths(base, 'relative/from', '/srv/x'), /must be absolute paths/);
  assert.throws(() => rebasePaths(base, '/srv/x', 'relative/to'), /must be absolute paths/);
  const sameRoot = rebasePaths(base, '/tmp/old-masterplan', '/tmp/old-masterplan');
  assert.equal(sameRoot._rebased, 0);

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

test('markTask: blocked attaches block_reason; re-activation clears it', () => {
  const s = { tasks: [{ id: 1, wave: 1, status: 'pending', files: [] }] };
  // blocking with a reason records it so a returning operator can diagnose WHY the wave is gated
  const blocked = markTask(s, 1, 'blocked', { reason: 'HIL GPU offline' });
  assert.equal(blocked.tasks[0].status, 'blocked');
  assert.equal(blocked.tasks[0].block_reason, 'HIL GPU offline');
  // re-activating clears the reason — a stale block_reason on a runnable task would mislead
  const reactivated = markTask(blocked, 1, 'pending');
  assert.equal(reactivated.tasks[0].status, 'pending');
  assert.equal(reactivated.tasks[0].block_reason, undefined);
});

test('markTask: refuses status=waived (waived is waive-task-only)', () => {
  // waived carries semantics waive-task enforces (blocked-only + reason + waive_reason + event +
  // the active_run guard). markTask is exported, so refusing waived here protects every caller.
  const s = { tasks: [{ id: 1, wave: 1, status: 'blocked', files: [], block_reason: 'x' }] };
  assert.throws(() => markTask(s, 1, 'waived'), /waived.*waive-task/);
  // pending/in_progress/done/blocked remain accepted
  for (const ok of ['pending', 'in_progress', 'done', 'blocked']) {
    assert.equal(markTask(s, 1, ok).tasks[0].status, ok);
  }
});

test('loadPlanTasks: materializes {id,status,wave,files} + sets phase=execute in one object (the atomic seam)', () => {
  const base = { slug: 'x', phase: 'plan', tasks: [] };
  const idx = { tasks: [
    { id: 1, wave: 0, description: 'a', files: ['a.mjs'], verify_commands: ['true'], codex: null },
    { id: 2, parallel_group: undefined, wave: 1, description: 'b', files: ['b.mjs'], codex: 'ok' },
  ] };
  const next = loadPlanTasks(base, idx);
  assert.equal(next.phase, 'execute'); // phase + tasks land together (the bin writes this one object atomically)
  assert.deepEqual(next.tasks, [
    { id: 1, status: 'pending', wave: 0, files: ['a.mjs'] }, // only {id,status,wave,files} kept; codex/verify_commands dropped
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
  assert.equal(s.schema_version, CURRENT_SCHEMA_VERSION); // 8->9 bump owned in lib/bundle.mjs
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
  // Spec §4.1: default-on at seed arms finish-time adversary review via the nested state.review key
  // the finish-step gate reads. The vestigial state.codex.routing default is no longer written.
  assert.deepEqual(s.review, { adversary: true });
  assert.ok(!('codex' in s), 'vestigial state.codex (routing) is no longer seeded');
  assert.equal(s.goals_enabled, true); // bundle-level capability marker (post-feature)
  assert.deepEqual(s.goals, []); // derived cache starts empty
  assert.deepEqual(parseState(serializeState(s)), s); // survives the on-disk format
});

test('buildSeedState: codexReview opt-out omits the nested review field (A9 absent-field style)', () => {
  const s = buildSeedState({
    slug: 'r', topic: 't', createdAt: 'T', codexReview: false,
  });
  assert.ok(!('review' in s), 'explicit opt-out leaves state.review absent (A9 absent-field style)');
  // Round-trip: the absent field stays absent through serialize/parse.
  assert.deepEqual(parseState(serializeState(s)), s);
});

test('buildSeedState: codexReview explicit true is identical to default true', () => {
  const def = buildSeedState({ slug: 'r', topic: 't', createdAt: 'T' });
  const explicit = buildSeedState({ slug: 'r', topic: 't', createdAt: 'T', codexReview: true });
  assert.deepEqual(def.review, explicit.review);
  assert.deepEqual(def.review, { adversary: true });
});

test('buildSeedState: fabricDispatch defaults on (dispatch.fabric true)', () => {
  const s = buildSeedState({ slug: 'r', topic: 't', createdAt: 'T' });
  assert.deepEqual(s.dispatch, { fabric: true });
  assert.deepEqual(parseState(serializeState(s)), s);
});

test('buildSeedState: fabricDispatch false omits dispatch (A9 absent-field style)', () => {
  const s = buildSeedState({ slug: 'r', topic: 't', createdAt: 'T', fabricDispatch: false });
  assert.ok(!('dispatch' in s), 'opt-out must leave state.dispatch absent');
  assert.deepEqual(parseState(serializeState(s)), s);
});

test('buildSeedState: fabricDispatch explicit true matches default', () => {
  const def = buildSeedState({ slug: 'r', topic: 't', createdAt: 'T' });
  const explicit = buildSeedState({ slug: 'r', topic: 't', createdAt: 'T', fabricDispatch: true });
  assert.deepEqual(def.dispatch, explicit.dispatch);
  assert.deepEqual(def.dispatch, { fabric: true });
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

test('buildTasksFromPlanIndex: plan.index -> minimal {id,status,wave,files}; numeric-string id->Number; idx/parallel_group aliases', () => {
  // The fresh-plan writer behind `mp seed-tasks`: plan.index.json -> state.tasks. Only the four
  // shell-owned fields land in state; the rich routing fields (description/verify_commands/codex/…)
  // stay in plan.index (prepareWave reads them THERE — one source of truth). This is what populated a
  // freshly-planned run was missing, forcing a CD-7 hand-rewrite of state.yml.
  const planIndex = { tasks: [
    { id: 1, wave: 0, files: ['a.txt'], description: 'do a', verify_commands: ['t'], codex: 'no', sensitive: true },
    { id: '2', parallel_group: 1, files: ['b.txt'] }, // numeric-string id -> Number; parallel_group -> wave
    { idx: 3, wave: 1 },                              // idx alias for id; files default to []
  ] };
  assert.deepEqual(buildTasksFromPlanIndex(planIndex), [
    { id: 1, status: 'pending', wave: 0, files: ['a.txt'] },
    { id: 2, status: 'pending', wave: 1, files: ['b.txt'] },
    { id: 3, status: 'pending', wave: 1, files: [] },
  ]);
  // the rich routing fields are intentionally NOT duplicated into state
  const t0 = buildTasksFromPlanIndex(planIndex)[0];
  assert.ok(!('description' in t0) && !('verify_commands' in t0) && !('codex' in t0) && !('sensitive' in t0));
});

test('buildTasksFromPlanIndex: bare array accepted; a missing wave passes through as null (never coerced to 0); empty -> []', () => {
  // wave is NEVER Number()-coerced: Number(null) === 0 would silently bucket a wave-less task into
  // wave 0. Passed through raw so the bin's integer-wave stuck-guard catches it instead.
  const tasks = buildTasksFromPlanIndex([{ id: 1, files: [] }]);
  assert.equal(tasks[0].wave, null);
  assert.deepEqual(buildTasksFromPlanIndex({}), []);   // no tasks -> empty, not a throw
  assert.deepEqual(buildTasksFromPlanIndex([]), []);
});

test('buildTasksFromPlanIndex: a task with no id fails loud (mark-task could never address it)', () => {
  assert.throws(() => buildTasksFromPlanIndex([{ wave: 0, files: [] }]), /has no id/);
  assert.throws(() => buildTasksFromPlanIndex([{ id: '', wave: 0 }]), /has no id/);
  assert.throws(() => buildTasksFromPlanIndex([{ id: null, wave: 0 }]), /has no id/);
});

// ---- upsertTasks (D4): status-preserving task injection for `mp amend-tasks` ----
test('upsertTasks: refreshes {wave,files} for existing ids while PRESERVING status + reasons', () => {
  const state = {
    tasks: [
      { id: 1, status: 'done', wave: 0, files: ['old1.txt'] },
      { id: 2, status: 'blocked', wave: 1, files: ['old2.txt'], block_reason: 'HIL down' },
      { id: 3, status: 'waived', wave: 2, files: [], waive_reason: 'decommissioned' },
      { id: 4, status: 'in_progress', wave: 1, files: ['old4.txt'] },
    ],
  };
  const idx = { tasks: [
    { id: 1, wave: 5, files: ['new1.txt'] },
    { id: 2, wave: 6, files: ['new2.txt'] },
    { id: 3, wave: 7, files: ['new3.txt'] },
    { id: 4, wave: 8, files: ['new4.txt'] },
  ] };
  const r = upsertTasks(state, idx);
  assert.deepEqual(r.refreshed, [1, 2, 3, 4]);
  assert.deepEqual(r.appended, []);
  assert.deepEqual(r.pruned, []);
  const t = (id) => r.state.tasks.find((x) => x.id === id);
  assert.equal(t(1).status, 'done');                                 // preserved
  assert.equal(t(1).wave, 5); assert.deepEqual(t(1).files, ['new1.txt']); // refreshed
  assert.equal(t(2).status, 'blocked'); assert.equal(t(2).block_reason, 'HIL down'); // preserved
  assert.equal(t(2).wave, 6); assert.deepEqual(t(2).files, ['new2.txt']);
  assert.equal(t(3).status, 'waived'); assert.equal(t(3).waive_reason, 'decommissioned'); // preserved
  assert.equal(t(3).wave, 7); assert.deepEqual(t(3).files, ['new3.txt']);
  assert.equal(t(4).status, 'in_progress'); assert.equal(t(4).wave, 8);  // preserved + refreshed
});

test('upsertTasks: appends new index ids as pending with wave/files (non-numeric id preserved)', () => {
  const state = { tasks: [{ id: 1, status: 'done', wave: 0, files: ['a.txt'] }] };
  const idx = { tasks: [
    { id: 1, wave: 0, files: ['a.txt'] },
    { id: 5, wave: 3, files: ['c.mjs'] },
    { id: 'lint', wave: 4, files: ['d.mjs'] }, // non-numeric id NOT coerced away
  ] };
  const r = upsertTasks(state, idx);
  assert.deepEqual(r.appended, [5, 'lint']); // index order preserved
  assert.deepEqual(r.refreshed, [1]);
  const app5 = r.state.tasks.find((x) => x.id === 5);
  assert.equal(app5.status, 'pending'); assert.equal(app5.wave, 3); assert.deepEqual(app5.files, ['c.mjs']);
  const appLint = r.state.tasks.find((x) => x.id === 'lint');
  assert.equal(appLint.status, 'pending'); assert.equal(appLint.wave, 4);
});

test('upsertTasks: ids absent from the index are kept verbatim by default (never silently dropped)', () => {
  const state = { tasks: [
    { id: 1, status: 'done', wave: 0, files: [] },
    { id: 2, status: 'pending', wave: 1, files: [] },
  ] };
  const idx = { tasks: [{ id: 1, wave: 0, files: [] }] }; // id 2 absent
  const r = upsertTasks(state, idx); // no --prune
  assert.equal(r.state.tasks.find((x) => x.id === 2).status, 'pending'); // kept verbatim
  assert.deepEqual(r.pruned, []);
});

test('upsertTasks --prune: drops BARE pending absent ids, reports pruned', () => {
  const state = { tasks: [
    { id: 1, status: 'done', wave: 0, files: [] },
    { id: 2, status: 'pending', wave: 1, files: ['x.txt'] }, // bare pending -> droppable
  ] };
  const idx = { tasks: [{ id: 1, wave: 0, files: [] }] }; // id 2 absent
  const r = upsertTasks(state, idx, { prune: true });
  assert.deepEqual(r.pruned, [2]);
  assert.equal(r.state.tasks.find((x) => x.id === 2), undefined); // dropped
});

test('upsertTasks --prune: REFUSES accumulated-state absent ids without --prune-non-pending', () => {
  const state = { tasks: [
    { id: 1, status: 'done', wave: 0, files: [] },                         // accumulated
    { id: 2, status: 'blocked', wave: 1, files: [], block_reason: 'x' },    // accumulated
  ] };
  const idx = { tasks: [] }; // both absent
  assert.throws(() => upsertTasks(state, idx, { prune: true }), /refuses to drop 2 task.*--prune-non-pending/s);
  const r = upsertTasks(state, idx, { prune: true, pruneNonPending: true });
  assert.deepEqual(r.pruned, [1, 2]);
  assert.equal(r.state.tasks.length, 0);
});

test('upsertTasks: rejects a duplicate index id (1 and "1" collide after String normalization)', () => {
  const state = { tasks: [] };
  const idx = { tasks: [
    { id: 1, wave: 0, files: [] },
    { id: '1', wave: 1, files: ['dup.txt'] }, // collides with 1 after String()
    { id: 2, wave: 2, files: [] },
  ] };
  assert.throws(() => upsertTasks(state, idx), /duplicate task id.*1/);
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

// A5 — coordination state object (§6 schema, spec §7.4): round-trip + single-agent path unchanged.
test('A5: setCoordination round-trips the full §6 schema through state.yml (write→read→deepEqual)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-coord-'));
  try {
    const sp = path.join(dir, 'state.yml');
    const base = {
      schema_version: 8, slug: 'demo', status: 'in-progress', phase: 'execute',
      tasks: [{ id: 1, wave: 0, status: 'pending', files: ['a.mjs'] }],
      active_run: null, pending_gate: null,
    };
    // Full §6 coordination object (all eight fields populated)
    const fullCoord = {
      mode: 'github',
      contract_ref: 'mp-coord/demo/abc123',
      integration_branch: 'mp-int/demo',
      local_run_branch: 'mp-run/demo',
      current_wave: 0,
      published_waves: [0],
      base_sha_by_wave: { 0: 'sha0abc' },
      issue_map: {
        1: { issue: 42, pr: null, merge_sha: null, status: 'open' },
      },
    };
    const coordinated = setCoordination(base, fullCoord);

    // 1. The §6 fields survive a write→read round-trip (the load-bearing assertion)
    writeState(sp, coordinated);
    const roundTripped = readState(sp);
    assert.deepEqual(roundTripped, coordinated);

    // 2. All eight coordination fields are present and deep-equal (not collapsed/mangled)
    assert.deepEqual(roundTripped.coordination, fullCoord);
    assert.equal(roundTripped.coordination.mode, 'github');
    assert.equal(roundTripped.coordination.contract_ref, 'mp-coord/demo/abc123');
    assert.equal(roundTripped.coordination.integration_branch, 'mp-int/demo');
    assert.equal(roundTripped.coordination.local_run_branch, 'mp-run/demo');
    assert.equal(roundTripped.coordination.current_wave, 0);
    assert.deepEqual(roundTripped.coordination.published_waves, [0]);
    assert.deepEqual(roundTripped.coordination.base_sha_by_wave, { 0: 'sha0abc' });
    assert.deepEqual(roundTripped.coordination.issue_map, {
      1: { issue: 42, pr: null, merge_sha: null, status: 'open' },
    });

    // 3. Pure serialize→parse also round-trips (no disk required)
    assert.deepEqual(parseState(serializeState(coordinated)), coordinated);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('A5: setCoordination is a pure merge-update — partial patch preserves existing fields', () => {
  const base = { slug: 'r', coordination: { mode: 'github', current_wave: 0, published_waves: [] } };
  const frozen = JSON.stringify(base);

  // Partial patch: only update current_wave; other fields survive
  const updated = setCoordination(base, { current_wave: 1, published_waves: [0] });
  assert.equal(updated.coordination.mode, 'github');          // preserved
  assert.equal(updated.coordination.current_wave, 1);         // updated
  assert.deepEqual(updated.coordination.published_waves, [0]); // updated
  assert.equal(JSON.stringify(base), frozen);                  // base not mutated
});

test('A5: single-agent path unchanged — buildSeedState emits no coordination key (A9 invariant)', () => {
  // A9: all new behaviour is gated behind the presence of the `coordination` state object;
  // the local single-agent seed must stay byte-identical — no `coordination` key.
  const seed = buildSeedState({ slug: 'r', topic: 't', createdAt: 'T' });
  assert.ok(!('coordination' in seed), 'buildSeedState must not emit coordination for single-agent runs');
  assert.deepEqual(parseState(serializeState(seed)), seed); // seed still round-trips cleanly
});

test('A5: clearCoordination removes the coordination key entirely', () => {
  const coordinated = setCoordination(
    { slug: 'r', phase: 'execute' },
    { mode: 'github', current_wave: 0, published_waves: [], base_sha_by_wave: {}, issue_map: {} }
  );
  assert.ok('coordination' in coordinated);
  const cleared = clearCoordination(coordinated);
  assert.ok(!('coordination' in cleared));
  assert.deepEqual(cleared, { slug: 'r', phase: 'execute' }); // only coordination removed
});

test('validateCoreState: well-formed goals entries are valid', () => {
  const core = buildSeedState({ slug: 'g', topic: 't', createdAt: 'T' });
  const withGoals = {
    ...core,
    goals: [
      { id: 'G1', text: 'ship it', signal: 'test' },
      { id: 'G2', text: 'document it', signal: 'docs', tombstone: { reason: 'merged into G1', amended_at: '2026-07-01T00:00:00Z' } },
    ],
  };
  assert.deepEqual(validateCoreState(withGoals), []);
});

test('validateCoreState: goals is optional-when-present (pre-feature bundle with no goals field is exempt)', () => {
  const core = buildSeedState({ slug: 'g', topic: 't', createdAt: 'T' });
  const preFeature = { ...core };
  delete preFeature.goals;
  delete preFeature.goals_enabled;
  assert.deepEqual(validateCoreState(preFeature), []);
});

test('validateCoreState: flags malformed goals entries and a mutable status field', () => {
  const core = buildSeedState({ slug: 'g', topic: 't', createdAt: 'T' });
  assert.ok(validateCoreState({ ...core, goals: {} }).some((p) => /goals must be an array/.test(p)));
  assert.ok(validateCoreState({ ...core, goals: [{ text: 'x', signal: 's' }] }).some((p) => /goals\[0\] must have a non-empty string id/.test(p)));
  assert.ok(validateCoreState({ ...core, goals: [{ id: 'G1', signal: 's' }] }).some((p) => /goals\[0\] must have a non-empty string text/.test(p)));
  assert.ok(validateCoreState({ ...core, goals: [{ id: 'G1', text: 'x' }] }).some((p) => /goals\[0\] must have a non-empty string signal/.test(p)));
  assert.ok(validateCoreState({ ...core, goals: [{ id: 'G1', text: 'x', signal: 's', status: 'achieved' }] }).some((p) => /must not carry a mutable status field/.test(p)));
  assert.ok(validateCoreState({ ...core, goals: [{ id: 'G1', text: 'x', signal: 's', tombstone: { reason: 'r' } }] }).some((p) => /tombstone\.amended_at must be a non-empty string/.test(p)));
});

test('buildCapabilityEvent: builds the event-backed capability record carrying goals_enabled', () => {
  const ev = buildCapabilityEvent({ createdAt: '2026-07-01T00:00:00Z' });
  assert.equal(ev.type, CAPABILITY_EVENT_TYPE);
  assert.equal(ev.ts, '2026-07-01T00:00:00Z');
  assert.deepEqual(ev.data, { goals_enabled: true });
  assert.throws(() => buildCapabilityEvent({}), /createdAt is required/);
});

test('inferGoalsCapability: post-feature inferred from capability OR goal lifecycle events', () => {
  assert.equal(inferGoalsCapability([]).enabled, false);
  assert.equal(inferGoalsCapability([{ type: 'note' }]).enabled, false);
  assert.equal(inferGoalsCapability([buildCapabilityEvent({ createdAt: 'T' })]).enabled, true);
  for (const type of GOAL_LIFECYCLE_EVENT_TYPES) {
    assert.equal(inferGoalsCapability([{ type }]).enabled, true, `${type} should imply post-feature`);
  }
});

test('checkGoalsCapabilityAuthority: missing marker + present capability/goal events is a hard error', () => {
  const core = buildSeedState({ slug: 'g', topic: 't', createdAt: 'T' });
  // Consistent: marker present, capability event present.
  assert.deepEqual(checkGoalsCapabilityAuthority(core, [buildCapabilityEvent({ createdAt: 'T' })]), []);
  // Genuinely pre-feature: no marker, no events.
  const preFeature = { ...core };
  delete preFeature.goals_enabled;
  assert.deepEqual(checkGoalsCapabilityAuthority(preFeature, []), []);
  // Hard error: state.yml lost the marker but the event log proves post-feature.
  const problems = checkGoalsCapabilityAuthority(preFeature, [{ type: 'goals_frozen' }]);
  assert.ok(problems.some((p) => /missing the goals_enabled marker/.test(p)));
});

test('setRenderConfig: round-trips state.render.images through the on-disk format and is a pure merge-update', () => {
  const base = { slug: 'r', pending_gate: null, active_run: null };
  const frozen = JSON.stringify(base);

  // Set images on
  const on = setRenderConfig(base, { images: 'on' });
  assert.deepEqual(on.render, { images: 'on' });
  assert.equal(JSON.stringify(base), frozen); // base not mutated

  // Round-trips through serialize/parse (the on-disk format)
  assert.deepEqual(parseState(serializeState(on)), on);

  // Merge-update: a partial set preserves other facets of state.render
  const withExtra = { ...base, render: { images: 'off', foo: 'keep' } };
  const flipped = setRenderConfig(withExtra, { images: 'on' });
  assert.equal(flipped.render.images, 'on');
  assert.equal(flipped.render.foo, 'keep'); // sibling facet preserved

  // An empty patch preserves the existing render object
  assert.deepEqual(setRenderConfig(withExtra, {}).render, { images: 'off', foo: 'keep' });
});

test('buildSeedState: state.render.images defaults off; renderImages:on opts it on; CURRENT_SCHEMA_VERSION is 9', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 9); // the 8->9 bump lives here, once

  const def = buildSeedState({ slug: 'r', topic: 't', createdAt: 'T' });
  assert.deepEqual(def.render, { images: 'off' }); // default off unless seeded on
  assert.equal(def.schema_version, 9);             // stamped with CURRENT_SCHEMA_VERSION
  assert.deepEqual(parseState(serializeState(def)), def); // survives the on-disk format

  const on = buildSeedState({ slug: 'r', topic: 't', createdAt: 'T', renderImages: 'on' });
  assert.deepEqual(on.render, { images: 'on' }); // explicit opt-in

  // Any non-'on' value normalizes to 'off'
  const junk = buildSeedState({ slug: 'r', topic: 't', createdAt: 'T', renderImages: 'nonsense' });
  assert.deepEqual(junk.render, { images: 'off' });
});

test('field-preservation: state.render survives an unrelated state mutation untouched', () => {
  // Mirrors the refs/render preservation contract: every existing {...state} writer round-trips the
  // new render key untouched — only setRenderConfig / the seed default ever write it.
  const seeded = setRenderConfig(
    { slug: 'r', phase: 'plan', status: 'planning', tasks: [{ id: 1, wave: 0, status: 'pending', files: [] }] },
    { images: 'on' }
  );
  assert.deepEqual(seeded.render, { images: 'on' });

  // Unrelated mutations must not disturb state.render
  assert.deepEqual(setPhase(seeded, 'execute').render, { images: 'on' });
  assert.deepEqual(setStatus(seeded, 'archived').render, { images: 'on' });
  assert.deepEqual(markTask(seeded, 1, 'done').render, { images: 'on' });
  assert.deepEqual(setActiveRun(seeded, { run_id: 'w', task_id: 'k', wave: 0 }).render, { images: 'on' });

  // And it survives a full write->read round-trip alongside the mutation
  assert.deepEqual(parseState(serializeState(markTask(seeded, 1, 'done'))).render, { images: 'on' });
});
