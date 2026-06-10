// test/routing.test.mjs — Codex eligibility/routing truth table (pure; kills fragility #2).
// Ports v7's eligibility checklist + precedence (v7 parts/step-c-dispatch.md, deleted at the cutover; see tag v8.1.0-pre-cruft-removal) into deterministic
// code: same task -> same route, every run, fully testable. The v7 eligibility_cache dies;
// eligibility is computed here over the plan.index.json task at dispatch time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeTask, resolveImplementerBackend } from '../lib/dispatch/index.mjs';

// A task the heuristic should accept: <=3 files, unambiguous, has verify, not sensitive.
const clean = (over = {}) => ({
  files: ['a.js'],
  description: 'Add a null check to parseConfig',
  verify_commands: ['node --test'],
  ...over,
});

test('clean eligible task -> codex (auto)', () => {
  const d = routeTask(clean(), { routing: 'auto' }, {});
  assert.equal(d.target, 'codex');
  assert.equal(d.eligible, true);
  assert.equal(d.reason, 'heuristic');
});

// --- environmental hard-blocks override even an explicit `codex: ok` annotation ---
test('host suppression -> inline (overrides annotation ok)', () => {
  const d = routeTask(clean({ codex: 'ok' }), { routing: 'auto' }, { codexHostSuppressed: true });
  assert.equal(d.target, 'inline');
  assert.equal(d.reason, 'host-suppressed');
});
test('routing off -> inline (overrides annotation ok)', () => {
  const d = routeTask(clean({ codex: 'ok' }), { routing: 'off' }, {});
  assert.equal(d.target, 'inline');
  assert.equal(d.reason, 'routing-off');
});
test('linked worktree -> inline (overrides annotation ok; codex sandbox cannot commit there)', () => {
  const d = routeTask(clean({ codex: 'ok' }), { routing: 'auto' }, { linkedWorktree: true });
  assert.equal(d.target, 'inline');
  assert.equal(d.reason, 'linked-worktree');
});

// --- annotation overrides the heuristic ---
test('annotation no -> inline (even if the heuristic would pass)', () => {
  const d = routeTask(clean({ codex: 'no' }), { routing: 'auto' }, {});
  assert.equal(d.target, 'inline');
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'annotation-no');
});
test('annotation ok -> codex (even with >3 files)', () => {
  const d = routeTask(clean({ codex: 'ok', files: ['a', 'b', 'c', 'd', 'e'] }), { routing: 'auto' }, {});
  assert.equal(d.target, 'codex');
  assert.equal(d.reason, 'annotation-ok');
});

// --- heuristic rejections ---
test('heuristic: >3 files -> inline', () => {
  assert.equal(routeTask(clean({ files: ['a', 'b', 'c', 'd'] }), { routing: 'auto' }, {}).target, 'inline');
});
test('heuristic: design-judgment verbs -> inline', () => {
  assert.equal(routeTask(clean({ description: 'Choose between Redis and Memcached' }), { routing: 'auto' }, {}).target, 'inline');
  assert.equal(routeTask(clean({ description: 'Design the caching layer' }), { routing: 'auto' }, {}).target, 'inline');
  assert.equal(routeTask(clean({ description: 'Explore options for retries' }), { routing: 'auto' }, {}).target, 'inline');
});
test('heuristic: word "design" inside "designated" does NOT trip (word-boundary)', () => {
  assert.equal(routeTask(clean({ description: 'Update the designated owner field' }), { routing: 'auto' }, {}).target, 'codex');
});
test('heuristic: no verify commands -> inline', () => {
  assert.equal(routeTask(clean({ verify_commands: [] }), { routing: 'auto' }, {}).target, 'inline');
});
test('heuristic: sensitive flag or markers -> inline', () => {
  assert.equal(routeTask(clean({ sensitive: true }), { routing: 'auto' }, {}).target, 'inline');
  assert.equal(routeTask(clean({ description: 'Rotate the API secret' }), { routing: 'auto' }, {}).target, 'inline');
  assert.equal(routeTask(clean({ description: 'Run the schema migration' }), { routing: 'auto' }, {}).target, 'inline');
});
test('heuristic: conversational flag -> inline', () => {
  assert.equal(routeTask(clean({ conversational: true }), { routing: 'auto' }, {}).target, 'inline');
});

// --- manual mode defers to the shell, carrying the recommendation ---
test('manual mode -> ask, carrying the eligibility recommendation', () => {
  const yes = routeTask(clean(), { routing: 'manual' }, {});
  assert.equal(yes.target, 'ask');
  assert.equal(yes.eligible, true);
  const no = routeTask(clean({ files: ['a', 'b', 'c', 'd'] }), { routing: 'manual' }, {});
  assert.equal(no.target, 'ask');
  assert.equal(no.eligible, false);
});

test('default config routing is auto', () => {
  assert.equal(routeTask(clean(), {}, {}).target, 'codex');
});

test('does not mutate inputs', () => {
  const task = clean({ codex: 'ok' });
  const frozen = JSON.stringify(task);
  routeTask(task, { routing: 'auto' }, {});
  assert.equal(JSON.stringify(task), frozen);
});

// --- resolveImplementerBackend: the dispatch-backend descriptor (sibling of routeTask) ---
// A tagged union: {kind:'agent'} reproduces shipping (agentType/model live in the
// execute.workflow.js seam, NOT here); {kind:'qctl'} only when the flag is strictly true.
test('resolveImplementerBackend: default (no implementer config) -> {kind:agent}', () => {
  assert.deepEqual(resolveImplementerBackend(clean(), {}, {}), { kind: 'agent' });
});

test('resolveImplementerBackend: qctl flag false -> {kind:agent}', () => {
  assert.deepEqual(
    resolveImplementerBackend(clean(), { implementer: { qctl: { enabled: false } } }, {}),
    { kind: 'agent' },
  );
});

test('resolveImplementerBackend: any non-true enabled value -> {kind:agent} (strict === true)', () => {
  for (const v of [undefined, null, 'true', 'on', 1, {}, 'enabled']) {
    assert.deepEqual(
      resolveImplementerBackend(clean(), { implementer: { qctl: { enabled: v } } }, {}),
      { kind: 'agent' },
      `enabled=${JSON.stringify(v)} must NOT activate qctl`,
    );
  }
});

test('resolveImplementerBackend: qctl flag === true -> {kind:qctl} with scope/verify/deliver', () => {
  const d = resolveImplementerBackend(clean(), { implementer: { qctl: { enabled: true } } }, {});
  assert.equal(d.kind, 'qctl');
  assert.deepEqual(d.scope, ['a.js']);          // == task.files
  assert.deepEqual(d.verify, ['node --test']);  // == task.verify_commands
  assert.equal(d.deliver, 'patch');
});

test('resolveImplementerBackend: qctl descriptor carries NO repo/base (binding-time fields, spec §4/B1)', () => {
  const d = resolveImplementerBackend(clean(), { implementer: { qctl: { enabled: true } } }, {});
  assert.equal('repo' in d, false, 'repo is stamped at binding time, not by the resolver');
  assert.equal('base' in d, false, 'base is stamped at binding time, not by the resolver');
});

test('resolveImplementerBackend: empty task -> scope/verify default to []', () => {
  const d = resolveImplementerBackend({}, { implementer: { qctl: { enabled: true } } }, {});
  assert.deepEqual(d.scope, []);
  assert.deepEqual(d.verify, []);
  assert.equal(d.deliver, 'patch');
});

test('resolveImplementerBackend: does not mutate inputs', () => {
  const task = clean();
  const config = { implementer: { qctl: { enabled: true } } };
  const ft = JSON.stringify(task);
  const fc = JSON.stringify(config);
  resolveImplementerBackend(task, config, {});
  assert.equal(JSON.stringify(task), ft);
  assert.equal(JSON.stringify(config), fc);
});