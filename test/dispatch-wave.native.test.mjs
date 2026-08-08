// test/dispatch-wave.native.test.mjs — the native spawn path (spec §3, task 8).
//
// The native path's whole job is to hand the harness descriptors that carry the SAME
// governed routing the broker would have applied. So the tests that matter are: routing
// comes from agent-dispatch and never from a guess, the wave token is durable before any
// child starts and findable afterwards, concurrency stays bounded, and the host branch is
// explicit rather than sniffed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  composeWaveToken,
  WAVE_TOKEN_PREFIX,
  resolveClassRouting,
  buildNativeSpawnPlan,
  normalizeWaveConcurrency,
  selectLaunchPath,
  hostHasNativeSpawnApi,
  probeWaveToken,
  dispatchWaveViaFabric,
  readWaveDispatchRecord,
  reviewNativeResult,
} from '../lib/dispatch-wave.mjs';
import { continueRun } from '../lib/continue.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';

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

test('REGRESSION: a Pi host can reach the native branch — codexSuppressed is not a native-API veto', () => {
  // e2e finding 1 (test/e2e-native-wave-report.md): Pi sets PI_CODING_AGENT=true, so
  // shouldSuppressWorkflow returns true, so codexSuppressed vetoed the env flag — on the
  // ONE host with a native parallel spawn API. The native branch was unreachable in
  // production and the e2e could only enter it with PI_CODING_AGENT=false.
  const pi = { PI_CODING_AGENT: 'true' };
  assert.equal(hostHasNativeSpawnApi(pi), true, 'Pi has subagents even though it has no Workflow handle');
  assert.equal(hostHasNativeSpawnApi({}), false);

  assert.equal(
    selectLaunchPath({ codexSuppressed: true, env: { ...pi, MP_DISPATCH_NATIVE_SPAWN: '1' } }),
    'native-spawn',
    'the documented override reaches the native branch on Pi',
  );
  assert.equal(
    selectLaunchPath({ codexSuppressed: true, env: pi }),
    'native-spawn',
    'Pi defaults to native-spawn because hostHasNativeSpawnApi is true — no env flag needed',
  );
  assert.equal(
    selectLaunchPath({ codexSuppressed: true, env: { ...pi, MP_DISPATCH_NATIVE_SPAWN: '0' } }),
    'mcp-pool',
    'Pi can opt out of native-spawn with MP_DISPATCH_NATIVE_SPAWN=0',
  );
  assert.equal(
    selectLaunchPath({ codexSuppressed: true, env: { MP_DISPATCH_NATIVE_SPAWN: '1' } }),
    'mcp-pool',
    'a real Codex host still vetoes: it has no native API to spawn into',
  );
  assert.equal(
    selectLaunchPath({ nativeSpawn: false, env: { ...pi, MP_DISPATCH_NATIVE_SPAWN: '1' } }),
    'mcp-pool',
    'an explicit false still outranks everything',
  );
});

test('REGRESSION: the child brief forbids committing — the wave owns the code-side commit', () => {
  // e2e finding 3 / A3: the brief said "Commit locally in your locus", while the
  // cross-locus watch fails the wave on any child HEAD move. An obedient child produced
  // commits.code:null plus a HEAD-move violation. The two contracts must agree.
  for (const s of planFixture().tasks) {
    assert.ok(!/commit locally/i.test(s.prompt), 'the brief must not tell a child to commit');
    assert.ok(/never commit or push/i.test(s.prompt), 'the prohibition is explicit, not implied');
    assert.ok(/leave your work uncommitted/i.test(s.prompt), 'and it says who does commit it');
  }
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

// ---------------------------------------------------------------------------
// Native result-ingestion parity (centralized review)
// ---------------------------------------------------------------------------

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
const planEntry = (id, wave, files) => ({
  id, wave, files, description: `task ${id}`, verify_commands: [],
});
const workerDigest = (id, status = 'done', files = []) => ({
  task_id: id, status, start_sha: 'abc123', files_changed: files,
  verify: [], summary: `task ${id} ${status}`, blockers: null,
});
const healthyHarness = () => ({
  degraded: false, timed_out: false, stalled: false,
  deadline_exceeded: false, regions_unreviewed: 0, extraction_degraded: false,
});
const rejectRecord = {
  final_verdict: 'reject',
  findings: [{ severity: 'high', summary: 'introduces a data race' }],
  blocking_findings: [{ summary: 'introduces a data race', proof: 'data race' }],
  summary: 'blocking data race',
  harness: healthyHarness(),
};

function makeNativeFixture({ slug = 'native-review', review = { adversary: true }, extra = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-native-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8,
    slug,
    status: 'in-progress',
    phase: 'execute',
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    active_run: null,
    dispatch: { fabric: true },
    review,
    ...extra,
  });
  write(bundleDir, 'plan.index.json', JSON.stringify({
    tasks: [planEntry(1, 1, ['src/a.txt'])],
  }));
  const self = buildOwnerIdentity({ host: 'h1', session: 'sess-native', slug, now: 1000 });
  return { tmp, MAIN, bundleDir, statePath, self, WT: null };
}

function launchNative(fx) {
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000 });
  assert.equal(op.op, 'dispatch_fabric', `expected dispatch_fabric, got ${JSON.stringify(op)}`);
  fx.WT = op.cwd;
  return op;
}

function brokerStub({ reviewResult = rejectRecord } = {}) {
  const calls = [];
  return {
    calls,
    async initialize() {},
    async callTool(tool, args) {
      calls.push({ tool, args });
      if (tool === 'dispatch_review') {
        if (reviewResult instanceof Error) throw reviewResult;
        return typeof reviewResult === 'function' ? reviewResult(args) : reviewResult;
      }
      throw new Error(`unexpected tool ${tool}`);
    },
    close() {},
  };
}

test('native spawn record persists task review context for result ingestion', async () => {
  const fx = makeNativeFixture({ slug: 'native-ctx', review: { adversary: true } });
  launchNative(fx);
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    nativeSpawn: true,
  });
  assert.equal(res.outcome, 'native-spawn-plan');
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal(record.review_context.enabled, true);
  assert.equal(record.review_context.base_sha, git(res.plan.tasks[0].cwd, 'rev-parse', 'HEAD'));
  assert.deepEqual(record.review_context.tasks[0], {
    task_id: 1,
    description: 'task 1',
    class: 'masterplan-implementation',
    repo: res.plan.tasks[0].cwd,
  });
});

test('native result uses the same centralized task review projection as MCP pool', async () => {
  const fx = makeNativeFixture({ slug: 'native-parity', review: { adversary: true } });
  launchNative(fx);
  const planRes = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000, nativeSpawn: true,
  });
  assert.equal(planRes.outcome, 'native-spawn-plan');
  write(fx.WT, 'src/a.txt', 'native edit\n');
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const stub = brokerStub({ reviewResult: rejectRecord });
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath,
    result: nativeResult,
    _brokerClient: stub,
    now: 3000,
  });
  assert.equal(reviewed.tasks[0].digest.review.verdict, 'reject');
  assert.equal(reviewed.tasks[0].review.verdict, 'reject');
  assert.ok(stub.calls.some((c) => c.tool === 'dispatch_review'));
  const recorded = recordWaveResult({
    statePath: fx.statePath, result: reviewed,
    self: fx.self, now: 3000, worktree: fx.WT,
  });
  assert.equal(recorded.blocking_reviews[0].verdict, 'reject');
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
});

test('native review is a no-op when review_context is absent or disabled', async () => {
  const fx = makeNativeFixture({ slug: 'native-off', review: { adversary: false } });
  launchNative(fx);
  await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000, nativeSpawn: true,
  });
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const stub = brokerStub({ reviewResult: () => assert.fail('review must not run when disabled') });
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath, result: nativeResult, _brokerClient: stub, now: 3000,
  });
  assert.equal(reviewed, nativeResult);
  assert.equal(stub.calls.length, 0);
});
