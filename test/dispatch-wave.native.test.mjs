// test/dispatch-wave.native.test.mjs — the native spawn path (spec §3, task 8).
//
// The native path's whole job is to hand the harness descriptors that carry the SAME
// governed routing the broker would have applied. So the tests that matter are: routing
// comes from agent-dispatch and never from a guess, the wave token is durable before any
// child starts and findable afterwards, concurrency stays bounded, and the host branch is
// explicit rather than sniffed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  composeWaveToken,
  WAVE_TOKEN_PREFIX,
  resolveClassRouting,
  buildNativeSpawnPlan,
  normalizeWaveConcurrency,
  selectLaunchPath,
  probeWaveToken,
} from '../lib/dispatch-wave.mjs';

// A stand-in for `agent-dispatch resolve`, shaped exactly like the real CLI's stdout.
const fakeResolve = (byClass, calls = []) => (bin, args) => {
  calls.push(args);
  if (args[0] === 'where') return '/nonexistent-agent-dispatch-root';
  const cls = args[args.indexOf('--class') + 1];
  if (!(cls in byClass)) throw new Error(`unknown class ${cls}`);
  return JSON.stringify(byClass[cls]);
};

const GATEWAY_EDIT = {
  decision: 'route',
  reason: 'healthy_chain_step',
  backend: 'dispatch-gateway',
  capability: 'edit',
  effort: 'high',
  model: 'dispatch-agentic-loop',
  transport: 'mcp',
  route: 'dispatch-agentic-loop',
  provider: 'grok-4.5',
};

// ── wave token ──────────────────────────────────────────────────────────────

test('the wave token is unique per (run, wave, attempt) and filename-safe', () => {
  const a = composeWaveToken('dispatch-consolidation', 1, 1);
  const b = composeWaveToken('dispatch-consolidation', 1, 2);
  const c = composeWaveToken('dispatch-consolidation', 2, 1);
  assert.notEqual(a, b, 'a retry gets its own token — its children must be distinguishable');
  assert.notEqual(a, c);
  assert.ok(a.startsWith(WAVE_TOKEN_PREFIX));
  assert.match(a, /^[A-Za-z0-9._-]+$/, 'safe to embed in labels and grep for');
  assert.equal(composeWaveToken('weird/slug name', 1, 1), `${WAVE_TOKEN_PREFIX}-weird-slug-name-w1-a1`);
});

// ── routing provenance ──────────────────────────────────────────────────────

test('routing comes from agent-dispatch resolve, not from a table in masterplan', () => {
  const calls = [];
  const r = resolveClassRouting('masterplan-implementation', {
    _exec: fakeResolve({ 'masterplan-implementation': GATEWAY_EDIT }, calls),
    _cache: new Map(),
  });
  assert.deepEqual(calls[0], ['resolve', '--class', 'masterplan-implementation']);
  assert.equal(r.lane, 'dispatch-agentic-loop');
  assert.equal(r.effort, 'high');
  assert.equal(r.provider, 'grok-4.5');
  assert.equal(r.backend, 'dispatch-gateway');
  assert.equal(r.resolved, true);
});

test('an unresolvable class is reported, never guessed into a lane', () => {
  const r = resolveClassRouting('no-such-class', {
    _exec: fakeResolve({}, []),
    _cache: new Map(),
  });
  assert.equal(r.resolved, false);
  assert.equal(r.lane, null, 'no fabricated lane');
  assert.match(r.reason, /resolve failed/);
});

test('resolution is cached per class (a wave shares few classes)', () => {
  const calls = [];
  const cache = new Map();
  const _exec = fakeResolve({ 'masterplan-implementation': GATEWAY_EDIT }, calls);
  resolveClassRouting('masterplan-implementation', { _exec, _cache: cache });
  resolveClassRouting('masterplan-implementation', { _exec, _cache: cache });
  assert.equal(calls.filter((c) => c[0] === 'resolve').length, 1);
});

// ── spawn plan ──────────────────────────────────────────────────────────────

const planFixture = (overrides = {}) => buildNativeSpawnPlan({
  tasks: [
    { id: 3, class: 'masterplan-implementation', description: 'do the thing', files: ['lib/a.mjs'], verify_commands: ['node --test test/a.test.mjs'] },
    { id: 4, class: 'masterplan-implementation', description: 'do the other thing', files: ['lib/b.mjs'], verify_commands: [] },
  ],
  descriptors: [
    { cwd: '/repo/wt', branch: 'masterplan/demo', files: ['lib/a.mjs'], verify_commands: ['node --test test/a.test.mjs'], handoff_key: 'k3', create_files: true },
    { cwd: '/repo/wt', branch: 'masterplan/demo', files: ['lib/b.mjs'], verify_commands: [], handoff_key: 'k4', create_files: true },
  ],
  token: 'mp-wave-demo-w1-a1',
  _resolve: () => ({ ...GATEWAY_EDIT, lane: 'dispatch-agentic-loop', agent: 'builder', resolved: true, reason: null }),
  ...overrides,
});

test('each spawn descriptor carries the lane pin, effort, agent role, scope, and badge', () => {
  const plan = planFixture();
  assert.equal(plan.tasks.length, 2);
  const s = plan.tasks[0];
  assert.equal(s.task_id, 3);
  assert.equal(s.model, 'litellm/dispatch-agentic-loop', 'lane pinned as litellm/dispatch-<class>');
  assert.equal(s.effort, 'high');
  assert.equal(s.agent, 'builder');
  assert.deepEqual(s.files, ['lib/a.mjs']);
  assert.equal(s.cwd, '/repo/wt');
  assert.equal(s.branch, 'masterplan/demo');
  assert.equal(s.handoff_key, 'k3');
  assert.deepEqual(s.badge, {
    class: 'masterplan-implementation',
    backend: 'gateway',
    model: 'grok-4.5',
    effort: 'high',
  }, 'DispatchBadgeDescriptor: class + backend + served model + effort');
});

test('the wave token rides in BOTH the label and the prompt (recovery greps for it)', () => {
  const plan = planFixture();
  for (const s of plan.tasks) {
    assert.ok(s.label.includes(plan.token), 'label carries the token');
    assert.ok(s.prompt.includes(plan.token), 'prompt carries the token');
    assert.equal(s.token, plan.token);
  }
  assert.notEqual(plan.tasks[0].label, plan.tasks[1].label, 'per-task labels stay distinct');
});

test('the prompt states the file scope and the verification bar', () => {
  const s = planFixture().tasks[0];
  assert.ok(s.prompt.includes('do the thing'));
  assert.ok(s.prompt.includes('lib/a.mjs'));
  assert.ok(s.prompt.includes('node --test test/a.test.mjs'));
  assert.ok(/edit NOTHING else/i.test(s.prompt), 'scope discipline is stated, not implied');
  const noVerify = planFixture().tasks[1];
  assert.ok(noVerify.prompt.includes('(none declared)'), 'an empty verify list is explicit, not blank');
});

test('an unresolved class is flagged on the descriptor so the caller can fail closed', () => {
  const plan = planFixture({
    _resolve: () => ({ lane: null, effort: null, capability: null, provider: null, backend: null, agent: null, resolved: false, reason: 'backend down' }),
  });
  assert.equal(plan.tasks[0].routing_resolved, false);
  assert.equal(plan.tasks[0].routing_reason, 'backend down');
});

// ── bounded concurrency ─────────────────────────────────────────────────────

test('concurrency defaults to 8, honours MP_DISPATCH_WAVE_CONCURRENCY, never exceeds task count', () => {
  const prior = process.env.MP_DISPATCH_WAVE_CONCURRENCY;
  delete process.env.MP_DISPATCH_WAVE_CONCURRENCY;
  try {
    assert.equal(normalizeWaveConcurrency(null, 100), 8, 'default');
    assert.equal(normalizeWaveConcurrency(null, 3), 3, 'never more workers than tasks');
    assert.equal(normalizeWaveConcurrency(null, 0), 1, 'never zero');

    process.env.MP_DISPATCH_WAVE_CONCURRENCY = '4';
    assert.equal(normalizeWaveConcurrency(null, 100), 4, 'env override');

    process.env.MP_DISPATCH_WAVE_CONCURRENCY = 'garbage';
    assert.equal(normalizeWaveConcurrency(null, 100), 8, 'a bad env value falls back, never NaN');

    process.env.MP_DISPATCH_WAVE_CONCURRENCY = '-3';
    assert.equal(normalizeWaveConcurrency(null, 100), 8, 'a negative env value falls back');
  } finally {
    if (prior === undefined) delete process.env.MP_DISPATCH_WAVE_CONCURRENCY;
    else process.env.MP_DISPATCH_WAVE_CONCURRENCY = prior;
  }
});

test('the plan carries its own concurrency bound', () => {
  assert.equal(planFixture().concurrency, 2, 'two tasks -> at most two workers');
});

// ── host branch ─────────────────────────────────────────────────────────────

test('Claude Code hosts keep the MCP pool; the branch is explicit, not sniffed', () => {
  assert.equal(selectLaunchPath({ env: {} }), 'mcp-pool', 'default is the MCP pool');
  assert.equal(selectLaunchPath({ nativeSpawn: true, env: {} }), 'native-spawn', 'explicit opt-in');
  assert.equal(selectLaunchPath({ nativeSpawn: false, env: { MP_DISPATCH_NATIVE_SPAWN: '1' } }), 'mcp-pool',
    'an explicit false outranks the env flag');
  assert.equal(selectLaunchPath({ env: { MP_DISPATCH_NATIVE_SPAWN: 'true' } }), 'native-spawn');
  assert.equal(selectLaunchPath({ codexSuppressed: true, env: { MP_DISPATCH_NATIVE_SPAWN: '1' } }), 'mcp-pool',
    'a Codex host has no native parallel API either');
});

// ── recovery probe ──────────────────────────────────────────────────────────

test('recovery finds live children by token before any re-dispatch decision', () => {
  const token = 'mp-wave-demo-w1-a1';
  const live = probeWaveToken(token, [
    { id: 'j1', label: `${token}/t3`, status: 'running' },
    { id: 'j2', label: 'unrelated', status: 'running' },
  ]);
  assert.equal(live.state, 'live');
  assert.equal(live.matches.length, 1);

  const done = probeWaveToken(token, [{ id: 'j1', label: `${token}/t3`, status: 'completed' }]);
  assert.equal(done.state, 'none', 'finished children do not block a retry');

  assert.equal(probeWaveToken(token, []).state, 'none');
});

test('an unavailable job list is UNKNOWN, never "no children"', () => {
  // The dangerous failure is reading a missing job list as "nothing is running" and
  // re-dispatching on top of live workers.
  assert.equal(probeWaveToken('tok', null).state, 'unknown');
  assert.equal(probeWaveToken('tok', undefined).state, 'unknown');
  assert.equal(probeWaveToken(null, []).state, 'unknown', 'a record with no token is also unknown');
});

test('the probe matches on prompt as well as label (labels can be rewritten)', () => {
  const token = 'mp-wave-demo-w1-a1';
  const r = probeWaveToken(token, [{ id: 'j9', label: 'renamed-by-harness', prompt: `[${token}] task 3`, status: 'running' }]);
  assert.equal(r.state, 'live');
});
