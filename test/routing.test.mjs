// test/routing.test.mjs — implementer-backend resolution truth table (pure).
// C6 (fresh-eyes remediation 2026-08-30): the pre-resolved codex/inline/ask eligibility
// brain was deleted — routing now resolves through the governed routing-policy resolver
// (lib/dispatch/routing-policy.mjs) from the task's dispatch `class`. This file keeps the
// surviving pure decision: resolveImplementerBackend, the {kind:'agent'|'qctl'} tagged union.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveImplementerBackend } from '../lib/dispatch/index.mjs';

// A task the resolver reads files/verify_commands from.
const clean = (over = {}) => ({
  files: ['a.js'],
  description: 'Add a null check to parseConfig',
  verify_commands: ['node --test'],
  ...over,
});

// --- resolveImplementerBackend: the dispatch-backend descriptor ---
// A tagged union: {kind:'agent'} reproduces shipping (agentType/model live in the
// dispatch-wave seam, NOT here); {kind:'qctl'} only when the flag is strictly true.
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
