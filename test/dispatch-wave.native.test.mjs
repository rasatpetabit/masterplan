// test/dispatch-wave.native.test.mjs — the native spawn path (the ONLY launch path).
//
// The native path's whole job is to hand the harness descriptors that carry the
// governed routing the repo-local routing policy resolves. So the tests that matter
// are: routing comes from the routing policy and never from a guess, the wave token
// is durable before any child starts and findable afterwards, concurrency stays
// bounded, and the two-phase native review seam stays fail-closed.

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
  probeWaveToken,
  dispatchWaveViaFabric,
  readWaveDispatchRecord,
  reviewNativeResult,
} from '../lib/dispatch-wave.mjs';
import { continueRun } from '../lib/continue.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';

// A hermetic routing-policy fixture (same shape as policy/workflow-map.json).
const POLICY_FIXTURE = {
  lanes: {
    agentic: { model: 'litellm/grok-4.6', ctx: 500000, cost: 'medium' },
    frontier: { model: 'litellm/gpt-5.6-sol', ctx: 372000, cost: 'high' },
    broad: { model: 'litellm/qwen3.8-max', ctx: 983616, cost: 'medium' },
    longform: { model: 'litellm/gemini-3.1-pro-preview', ctx: 1048576, cost: 'medium' },
  },
  agents: {
    builder: { tier: 'medium', writes: true },
    breaker: { tier: 'big', writes: false },
  },
  classes: {
    'bounded-edit': { agent: 'builder', lane: 'agentic', cap: 'edit', effort: 'high' },
    adversary: { agent: 'breaker', lane: 'frontier', cap: 'review', effort: 'xhigh', panel: 'adversarial' },
    unknown: { agent: 'builder', lane: 'agentic', cap: 'chat', effort: 'high' },
  },
  tiers: { small: { lane: 'agentic' }, medium: { lane: 'agentic' }, big: { lane: 'frontier' } },
  panels: {
    adversarial: {
      members: [
        { lane: 'frontier', model: 'litellm/gpt-5.6-sol' },
        { lane: 'broad', model: 'litellm/qwen3.8-max' },
        { lane: 'longform', model: 'litellm/gemini-3.1-pro-preview' },
      ],
      quorum: 2,
    },
  },
  workflow: { defaultClass: 'unknown' },
};

const NATIVE_EDIT = {
  lane: 'agentic',
  model: 'litellm/grok-4.6',
  effort: 'high',
  capability: 'edit',
  agent: 'builder',
  writes: true,
  panel: null,
  resolved: true,
  reason: null,
};

// ── wave token ──────────────────────────────────────────────────────────────

test('the wave token is unique per (run, wave, attempt) and filename-safe', () => {
  const a = composeWaveToken('dispatch-consolidation', 1, 1);
  const b = composeWaveToken('dispatch-consolidation', 1, 2);
  const c = composeWaveToken('dispatch-consolidation', 2, 1);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith(WAVE_TOKEN_PREFIX));
  assert.ok(!/[^\w.-]/.test(a), 'filename-safe');
});

// ── routing provenance ──────────────────────────────────────────────────────

test('routing comes from the routing policy, never from a table copied into masterplan', () => {
  const r = resolveClassRouting('bounded-edit', { policy: POLICY_FIXTURE, _cache: new Map() });
  assert.equal(r.lane, 'agentic');
  assert.equal(r.model, 'litellm/grok-4.6');
  assert.equal(r.effort, 'high');
  assert.equal(r.capability, 'edit');
  assert.equal(r.agent, 'builder');
  assert.equal(r.writes, true);
  assert.equal(r.resolved, true);
});

test('an unresolvable class is reported, never guessed into a lane', () => {
  const noClasses = { ...POLICY_FIXTURE, classes: {}, workflow: {} };
  const r = resolveClassRouting('no-such-class', { policy: noClasses, _cache: new Map() });
  assert.equal(r.resolved, false);
  assert.equal(r.lane, null, 'no fabricated lane');
  assert.equal(r.model, null, 'no fabricated model');
  assert.match(r.reason, /routing policy resolution failed/);
});

test('resolution is cached per class (a wave shares few classes)', () => {
  const cache = new Map();
  // The policy object MUTATES after the first resolution; a cached lookup must
  // return the first resolution, proving the record was memoized.
  const mutable = JSON.parse(JSON.stringify(POLICY_FIXTURE));
  const first = resolveClassRouting('bounded-edit', { policy: mutable, _cache: cache });
  mutable.classes['bounded-edit'].effort = 'low';
  const second = resolveClassRouting('bounded-edit', { policy: mutable, _cache: cache });
  assert.equal(first.effort, 'high');
  assert.equal(second.effort, 'high', 'the second read is the cached record, not a re-resolution');
});

// ── spawn plan ──────────────────────────────────────────────────────────────

const planFixture = (overrides = {}) => buildNativeSpawnPlan({
  tasks: [
    { id: 3, class: 'bounded-edit', description: 'do the thing', files: ['lib/a.mjs'], verify_commands: ['node --test test/a.test.mjs'] },
    { id: 4, class: 'bounded-edit', description: 'do the other thing', files: ['lib/b.mjs'], verify_commands: [] },
  ],
  descriptors: [
    { cwd: '/repo/wt', branch: 'masterplan/demo', files: ['lib/a.mjs'], verify_commands: ['node --test test/a.test.mjs'], handoff_key: 'k3', create_files: true },
    { cwd: '/repo/wt', branch: 'masterplan/demo', files: ['lib/b.mjs'], verify_commands: [], handoff_key: 'k4', create_files: true },
  ],
  token: 'mp-wave-demo-w1-a1',
  _resolve: () => ({ ...NATIVE_EDIT }),
  ...overrides,
});

test('each spawn descriptor carries the lane pin, effort, agent role, scope, and badge', () => {
  const plan = planFixture();
  assert.equal(plan.tasks.length, 2);
  const s = plan.tasks[0];
  assert.equal(s.task_id, 3);
  assert.equal(s.model, 'litellm/grok-4.6', 'the lane model ref rides the descriptor');
  assert.equal(s.effort, 'high');
  assert.equal(s.agent, 'builder');
  assert.deepEqual(s.files, ['lib/a.mjs']);
  assert.equal(s.cwd, '/repo/wt');
  assert.equal(s.branch, 'masterplan/demo');
  assert.equal(s.handoff_key, 'k3');
  assert.deepEqual(s.badge, {
    class: 'bounded-edit',
    backend: 'native',
    model: 'litellm/grok-4.6',
    effort: 'high',
  }, 'badge: class + native backend + lane model ref + effort');
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
    _resolve: () => ({ lane: null, model: null, effort: null, capability: null, agent: null, writes: null, panel: null, resolved: false, reason: 'policy unreadable' }),
  });
  assert.equal(plan.tasks[0].routing_resolved, false);
  assert.equal(plan.tasks[0].routing_reason, 'policy unreadable');
});

// ── bounded concurrency ─────────────────────────────────────────────────────

test('concurrency defaults to 8, honours MP_DISPATCH_WAVE_CONCURRENCY, never exceeds task count', () => {
  const prior = process.env.MP_DISPATCH_WAVE_CONCURRENCY;
  try {
    delete process.env.MP_DISPATCH_WAVE_CONCURRENCY;
    assert.equal(normalizeWaveConcurrency(undefined, 20), 8, 'default 8');
    assert.equal(normalizeWaveConcurrency(undefined, 3), 3, 'never more workers than tasks');
    process.env.MP_DISPATCH_WAVE_CONCURRENCY = '2';
    assert.equal(normalizeWaveConcurrency(undefined, 20), 2, 'env honoured');
    assert.equal(normalizeWaveConcurrency(4, 20), 4, 'explicit request wins');
    assert.equal(normalizeWaveConcurrency(0, 20), 2, 'a non-positive request falls back to the env value');
  } finally {
    if (prior === undefined) delete process.env.MP_DISPATCH_WAVE_CONCURRENCY;
    else process.env.MP_DISPATCH_WAVE_CONCURRENCY = prior;
  }
});

test('the plan carries its own concurrency bound', () => {
  assert.equal(planFixture().concurrency, 2, 'two tasks -> at most two workers');
});

// ── brief contracts ─────────────────────────────────────────────────────────

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
// Two-phase native review seam (descriptors out, provided records in)
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

test('native spawn record persists task review context for result ingestion', async () => {
  const fx = makeNativeFixture({ slug: 'native-ctx', review: { adversary: true } });
  launchNative(fx);
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
  });
  assert.equal(res.outcome, 'native-spawn-plan');
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal(record.review_context.enabled, true);
  assert.equal(record.review_context.base_sha, git(res.plan.tasks[0].cwd, 'rev-parse', 'HEAD'));
  assert.equal(record.review_context.tasks[0].task_id, 1);
  assert.equal(record.review_context.tasks[0].description, 'task 1');
  assert.equal(record.review_context.tasks[0].class, res.plan.tasks[0].class);
  assert.equal(record.review_context.tasks[0].repo, res.plan.tasks[0].cwd);
});

test('phase A: owed reviews emit pending descriptors and record NOTHING', async () => {
  const fx = makeNativeFixture({ slug: 'native-pending', review: { adversary: true } });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000 });
  write(fx.WT, 'src/a.txt', 'native edit\n');
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const pending = await reviewNativeResult({
    statePath: fx.statePath, result: nativeResult, policy: POLICY_FIXTURE, now: 3000,
  });
  assert.equal(pending.review_outcome, 'native-review-pending');
  assert.equal(pending.pending_reviews.length, 1);
  const d = pending.pending_reviews[0];
  assert.equal(d.class, 'adversary');
  assert.equal(d.agent, 'breaker');
  assert.equal(d.model, 'litellm/gpt-5.6-sol');
  assert.equal(d.repo, fx.WT);
  assert.match(d.job_id, /-t1-[0-9a-f]{12}$/);
  // Nothing recorded yet: the digest did not reach recordWaveResult.
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test('phase B: provided native reviews ingest through the centralized projection', async () => {
  const fx = makeNativeFixture({ slug: 'native-parity', review: { adversary: true } });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000 });
  write(fx.WT, 'src/a.txt', 'native edit\n');
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath,
    result: nativeResult,
    providedReviews: { 1: rejectRecord },
    now: 3000,
  });
  assert.equal(reviewed.review_outcome, 'native-reviews-recorded');
  assert.equal(reviewed.tasks[0].digest.review.verdict, 'reject');
  assert.equal(reviewed.tasks[0].review.verdict, 'reject');
  const recorded = recordWaveResult({
    statePath: fx.statePath, result: reviewed,
    self: fx.self, now: 3000, worktree: fx.WT,
  });
  assert.equal(recorded.blocking_reviews[0].verdict, 'reject');
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
});

test('phase B: a missing provided review fails closed as an error review', async () => {
  const fx = makeNativeFixture({ slug: 'native-missing', review: { adversary: true } });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000 });
  write(fx.WT, 'src/a.txt', 'native edit\n');
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath, result: nativeResult, providedReviews: {}, now: 3000,
  });
  assert.equal(reviewed.tasks[0].review.verdict, 'error', 'an owed-but-absent review never passes silently');
  assert.match(reviewed.tasks[0].review.summary, /not provided/);
});

test('native review is a no-op when review_context is absent or disabled', async () => {
  const fx = makeNativeFixture({ slug: 'native-off', review: { adversary: false } });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000 });
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath, result: nativeResult, providedReviews: { 1: rejectRecord }, now: 3000,
  });
  assert.equal(reviewed, nativeResult, 'disabled review context is a pure passthrough');
});
