// test/dispatch-wave.native.test.mjs — the native spawn path (the ONLY launch path).
//
// The native path's whole job is to hand the harness descriptors that carry the
// governed routing the repo-local routing policy resolves. So the tests that matter
// are: routing comes from the routing policy and never from a guess, the wave token
// is durable before any child starts and findable afterwards, concurrency stays
// bounded, and the two-phase native review seam stays fail-closed.

import { test, after } from 'node:test';
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
  writeWaveDispatchRecord,
  reviewNativeResult,
  reviewCommittedRecovery,
  disposeReviewEpisode,
} from '../lib/dispatch-wave.mjs';
import { continueRun } from '../lib/continue.mjs';
import { readState, writeState, appendEvent } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { recordWaveResult, authorizeRecording } from '../lib/wave-commit.mjs';
import { fingerprintReviewContext } from '../lib/recovery-controller.mjs';
const dispatchFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/dispatch-map.json', import.meta.url), 'utf8'));

test('native handoff keeps bounded-edit intent and never stamps a model', () => {
  const p = buildNativeSpawnPlan({
    tasks: [{ id: 1, class: 'bounded-edit', description: 'edit' }],
    descriptors: [{ repo: '/fixture', handoff_key: 'unchanged' }],
    token: 'fixture-wave', concurrency: 1, policy: dispatchFixture, host: 'pi',
  });
  assert.equal(p.tasks[0].usecase, 'bounded-edit');
  assert.equal(p.tasks[0].agent, dispatchFixture.usecases['bounded-edit'].agent);
  assert.equal(p.tasks[0].handoff_key, 'unchanged');
  assert.equal(Object.hasOwn(p.tasks[0], 'model'), false);
  assert.equal(Object.hasOwn(p.tasks[0].badge, 'model'), false);
});

// Every fixture here builds a tree under os.tmpdir(); without this they accumulate across
// runs and fill a shared /tmp. Registered on creation, removed once when the file finishes.
const FIXTURE_TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  FIXTURE_TMPDIRS.push(dir);
  return dir;
}
after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

// Historical policy fixture retained for older result-ingestion fixtures; C1 dispatch tests use dispatchFixture above.
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

const CONSTRAINTS = {
  stakes: 'critical', raiseTier: 'frontier', raiseEffort: 'xhigh',
  independentOf: { lineage: ['fixture-author'], required: true }, noSubstitute: true,
};
const absentDiscovery = { env: {}, homeDir: '/deliberately-absent',
  readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } };
function assertConstraints(descriptor, subject) {
  for (const [key, value] of Object.entries(CONSTRAINTS)) assert.deepEqual(descriptor[key], value, key);
  assert.equal(descriptor.subject, subject);
  assert.equal(descriptor.blocking, true);
  assert.equal(Object.hasOwn(descriptor, 'model'), false);
  assert.equal(Object.hasOwn(descriptor, 'chain'), false);
  assert.equal(Object.hasOwn(descriptor, 'raises'), false);
  assert.equal(Object.hasOwn(descriptor, 'independence'), false);
}

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

test('routing resolves fresh canonical C1 intent, without a model or cache', () => {
  const mutable = structuredClone(dispatchFixture);
  const first = resolveClassRouting('bounded-edit', { policy: mutable });
  assert.equal(first.agent, 'builder');
  assert.equal(first.usecase, 'bounded-edit');
  assert.equal(Object.hasOwn(first, 'model'), false);
  mutable.usecases['bounded-edit'].agent = 'judge';
  assert.equal(resolveClassRouting('bounded-edit', { policy: mutable }).agent, 'judge');
});

test('unsupported legacy class refuses migration instead of falling back to iterate', () => {
  assert.throws(() => resolveClassRouting('architecture', { policy: dispatchFixture }), /unsupported legacy class.*migrate/);
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
  policy: dispatchFixture,
  ...overrides,
});

test('each spawn descriptor carries model-free intent, scope, and badge', () => {
  const plan = planFixture();
  assert.equal(plan.tasks.length, 2);
  const s = plan.tasks[0];
  assert.equal(s.task_id, 3);
  assert.equal(s.usecase, 'bounded-edit');
  assert.equal(Object.hasOwn(s, 'model'), false);
  assert.equal(s.agent, 'builder');
  assert.deepEqual(s.files, ['lib/a.mjs']);
  assert.equal(s.cwd, '/repo/wt');
  assert.equal(s.branch, 'masterplan/demo');
  assert.equal(s.handoff_key, 'k3');
  assert.deepEqual(s.badge, { class: 'bounded-edit', backend: 'native' });
});

test('unconfigured host-native implement retains built-in agent without C1 claims', () => {
  for (const host of ['claude-code', 'codex']) {
    const p = buildNativeSpawnPlan({ tasks: [{ id: 1, class: 'bounded-edit' }],
      descriptors: [{ ...CONSTRAINTS, subject: 'fixture::episode', blocking: true }], token: 'fixture', host,
      _resolve: (klass) => resolveClassRouting(klass, { host, policy: null,
        discoveryOptions: absentDiscovery }),
    });
    const d = p.tasks[0];
    assert.equal(d.agent, 'builder');
    assert.equal(d.model_source, 'host-native');
    assert.deepEqual(d.routing_map, { status: 'unconfigured', path: null, schema: null });
    assert.equal(Object.hasOwn(d, 'usecase'), false);
    assert.equal(Object.hasOwn(d, 'vocabulary'), false);
    assertConstraints(d, 'fixture::episode');
  }
});

test('unsubmitted legacy model or chain descriptors demand explicit migration', () => {
  for (const pin of [{ model: 'synthetic-legacy-pin' }, { chain: ['synthetic-legacy-pin'] }]) {
    assert.throws(() => planFixture({ descriptors: [pin, {}] }), /legacy model\/chain.*migration/);
  }
});

test('Task 8 panel coordinator integration: C7 isolated counters exhaust the same subject', { skip: 'plan 04 Task 8 coordinator is not built; producer never expands a panel' }, () => {});

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

test('unresolved class refuses before a descriptor can reach the host', () => {
  assert.throws(() => planFixture({ tasks: [{ id: 3, class: 'architecture' }] }), /unsupported legacy class/);
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
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-native-'));
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
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  assert.equal(op.op, 'dispatch_fabric', `expected dispatch_fabric, got ${JSON.stringify(op)}`);
  fx.WT = op.cwd;
  return op;
}

test('native spawn record persists task review context for result ingestion', async () => {
  const fx = makeNativeFixture({ slug: 'native-ctx', review: { adversary: true } });
  launchNative(fx);
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture,
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
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  write(fx.WT, 'src/a.txt', 'native edit\n');
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const pending = await reviewNativeResult({
    statePath: fx.statePath, self: fx.self, result: nativeResult, policy: dispatchFixture, now: 3000,
  });
  assert.equal(pending.review_outcome, 'native-review-pending');
  assert.equal(pending.pending_reviews.length, 1);
  const d = pending.pending_reviews[0];
  assert.equal(d.class, 'adversary');
  assert.equal(d.agent, 'breaker');
  assert.equal(d.phase, 'challenge');
  assert.equal(d.usecase, dispatchFixture.phases.challenge);
  assert.equal(Object.hasOwn(d, 'model'), false);
  assert.equal(d.subject, readWaveDispatchRecord(fx.bundleDir, 1).review_context.episodes['1'].subject);
  assert.equal(d.repo, fx.WT);
  assert.match(d.job_id, /-t1-[0-9a-f]{12}$/);
  // Nothing recorded yet: the digest did not reach recordWaveResult.
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test('review episode keeps persisted project subject across artifact, token, reviewer and attempt changes', async () => {
  const fx = makeNativeFixture({ slug: 'stable-episode', review: { adversary: true } });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  write(fx.WT, 'src/a.txt', 'first edit\n');
  const result = { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }] };
  const first = (await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture })).pending_reviews[0];
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal(first.subject, record.review_context.episodes['1'].subject);
  assert.ok(first.subject.startsWith(`${fx.MAIN}::docs/masterplan/stable-episode/wave-1/task-1`));
  writeWaveDispatchRecord(fx.bundleDir, 1, { ...record, attempt: 4, wave_token: 'changed-token' });
  write(fx.WT, 'src/a.txt', 'second edit\n');
  const remap = structuredClone(dispatchFixture);
  remap.usecases['adversarial-assessment'].agent = 'judge';
  const second = (await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: remap })).pending_reviews[0];
  assert.equal(second.subject, first.subject);
  assert.equal(second.agent, 'judge');
  assert.notEqual(second.diff_sha, first.diff_sha);
  assert.notEqual(second.job_id, first.job_id);
  assert.equal(second.job_id, `stable-episode-w1-t1-${second.diff_sha.slice(0, 12)}`);
});

test('old subjectless wave episode cannot acquire a fresh budget on recovery', async () => {
  const fx = makeNativeFixture({ slug: 'held-episode', review: { adversary: true } });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  delete record.review_context.episodes;
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  write(fx.WT, 'src/a.txt', 'new edit\n');
  const result = { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }] };
  await assert.rejects(() => reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture }), /no identifiable entry/);
});

test('submitted wave with a legacy pin is reused, never launched or migrated in place', async () => {
  const fx = makeNativeFixture({ slug: 'submitted-pin', review: { adversary: true } });
  launchNative(fx);
  const first = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  assert.equal(first.outcome, 'native-spawn-plan');
  const saved = readWaveDispatchRecord(fx.bundleDir, 1);
  saved.tasks[0].model = 'synthetic-legacy-pin';
  writeWaveDispatchRecord(fx.bundleDir, 1, saved);
  const again = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2100, policy: dispatchFixture });
  assert.equal(again.outcome, 'reused');
  assert.equal(again.dispatched, false);
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).tasks[0].model, 'synthetic-legacy-pin');
});

test('new task episode freezes C2 constraints; both host-native gates preserve them on re-emission', async () => {
  const fx = makeNativeFixture({ slug: 'c2-episode', review: { adversary: true, ...CONSTRAINTS } });
  launchNative(fx);
  const launch = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  assert.equal(launch.outcome, 'native-spawn-plan');
  const saved = readWaveDispatchRecord(fx.bundleDir, 1);
  assertConstraints({ ...saved.review_context.episodes['1'], blocking: true }, saved.review_context.episodes['1'].subject);
  write(fx.WT, 'src/a.txt', 'review me\n');
  const result = { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }] };
  for (const host of ['claude-code', 'codex']) {
    const [d] = (await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, host,
      discoveryOptions: absentDiscovery })).pending_reviews;
    assertConstraints(d, saved.review_context.episodes['1'].subject);
    assert.equal(d.model_source, 'host-native');
    assert.deepEqual(d.routing_map, { status: 'unconfigured', path: null, schema: null });
    assert.equal(d.agent, 'breaker');
    assert.equal(d.phase, 'challenge');
    assert.equal(Object.hasOwn(d, 'usecase'), false);
    assert.equal(Object.hasOwn(d, 'vocabulary'), false);
    assert.equal(d.diff_sha, (await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture })).pending_reviews[0].diff_sha);
  }
  // A rewrite must retain operation-owned constraints rather than defaulting them.
  writeWaveDispatchRecord(fx.bundleDir, 1, { ...saved, attempt: 2, wave_token: 'other-token' });
  const configured = (await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture })).pending_reviews[0];
  assertConstraints(configured, saved.review_context.episodes['1'].subject);
  assert.equal(configured.usecase, dispatchFixture.phases.challenge);
});

test('an existing persisted subjectless or held episode emits zero reviews', async () => {
  for (const episode of [{ stakes: 'critical' }, { hold: 'migration-pending', subject: 'legacy::subject' }]) {
    const fx = makeNativeFixture({ slug: 'held-episode-direct', review: { adversary: true } });
    launchNative(fx);
    const launch = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
    assert.equal(launch.outcome, 'native-spawn-plan');
    const saved = readWaveDispatchRecord(fx.bundleDir, 1);
    saved.review_context.episodes['1'] = episode;
    writeWaveDispatchRecord(fx.bundleDir, 1, saved);
    write(fx.WT, 'src/a.txt', 'review me\n');
    const result = { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }] };
    await assert.rejects(() => reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture }), /subjectless hold/);
    assert.deepEqual(readWaveDispatchRecord(fx.bundleDir, 1).review_context.episodes['1'], episode);
    assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
  }
});

test('operator dispositions are durable, idempotent, conflicting re-apply refused and retire is never review success', async () => {
  const fx = makeNativeFixture({ slug: 'disposition-retire' });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  record.review_context.episodes['1'] = { hold: 'historical' };
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  const args = { statePath: fx.statePath, wave: 1, taskId: 1, self: fx.self, now: 2200 };
  const first = disposeReviewEpisode({ ...args, disposition: 'retire', reason: 'unverifiable old review' });
  assert.equal(first.disposition.kind, 'retire');
  assert.equal(first.disposition.reviewed, false);
  const cli = execFileSync(process.execPath, [new URL('../bin/masterplan.mjs', import.meta.url).pathname,
    'episode-disposition', `--state=${fx.statePath}`, '--wave=1', '--task-id=1',
    '--disposition=retire', '--reason=unverifiable old review', '--session=sess-native',
    '--host=h1', '--now=2200'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(cli), first);
  assert.deepEqual(disposeReviewEpisode({ ...args, disposition: 'retire', reason: 'unverifiable old review' }), first);
  assert.throws(() => disposeReviewEpisode({ ...args, disposition: 'restart' }), /conflict/);
  write(fx.WT, 'src/a.txt', 'change\n');
  const result = { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1) }] };
  await assert.rejects(() => reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture }), /retired.*not reviewed/);
  await assert.rejects(() => reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, providedReviews: { 1: rejectRecord }, policy: dispatchFixture }), /retired.*not reviewed/);
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
});

test('restart records lineage, emits one new persisted subject, and refuses stale bundle copies', async () => {
  const fx = makeNativeFixture({ slug: 'disposition-restart' });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  record.review_context.episodes['1'] = { hold: 'historical' };
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  const args = { statePath: fx.statePath, wave: 1, taskId: 1, self: fx.self, now: 2200, disposition: 'restart' };
  const d = disposeReviewEpisode(args);
  assert.equal(d.disposition.kind, 'restart');
  assert.deepEqual(d.disposition.lineage, { wave: 1, task_id: 1 });
  assert.match(d.disposition.subject, /::docs\/masterplan\/disposition-restart\/wave-1\/task-1\/restart-1$/);
  assert.deepEqual(disposeReviewEpisode(args), d);
  assert.throws(() => disposeReviewEpisode({ ...args, disposition: 'retire', reason: 'other' }), /conflict/);
  write(fx.WT, 'src/a.txt', 'change\n');
  const result = { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1) }] };
  const one = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture });
  const two = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture });
  assert.equal(one.pending_reviews[0].subject, d.disposition.subject);
  assert.equal(two.pending_reviews[0].subject, d.disposition.subject);
  const stale = path.join(fx.MAIN, '.worktrees', 'stale', 'docs', 'masterplan', 'disposition-restart');
  fs.mkdirSync(stale, { recursive: true });
  fs.copyFileSync(fx.statePath, path.join(stale, 'state.yml'));
  fs.copyFileSync(path.join(fx.bundleDir, 'wave-1.dispatch.json'), path.join(stale, 'wave-1.dispatch.json'));
  assert.throws(() => disposeReviewEpisode({ ...args, statePath: path.join(stale, 'state.yml') }), /primary bundle/);
  await assert.rejects(() => reviewNativeResult({ statePath: path.join(stale, 'state.yml'), result, policy: dispatchFixture }), /primary bundle/);
});

test('missing disposition refuses an ambiguous prior emission; only a durable never-emitted marker permits new work', async () => {
  const fx = makeNativeFixture({ slug: 'never-emitted' });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  delete record.review_context.episodes['1'];
  delete record.review_context.emitted_reviews;
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  write(fx.WT, 'src/a.txt', 'change\n');
  const result = { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1) }] };
  await assert.rejects(() => reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture }), /no identifiable entry/);
  record.review_context.emitted_reviews = ['1'];
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  await assert.rejects(() => reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture }), /ambiguous prior emission/);
  record.review_context.emitted_reviews = [];
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  const first = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture });
  const second = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture });
  assert.equal(first.pending_reviews[0].subject, second.pending_reviews[0].subject);
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).review_context.emitted_reviews.filter((id) => id === '1').length, 1);
});

test('phase B: provided native reviews ingest through the centralized projection', async () => {
  const fx = makeNativeFixture({ slug: 'native-parity', review: { adversary: true } });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  write(fx.WT, 'src/a.txt', 'native edit\n');
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath, self: fx.self,
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
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  write(fx.WT, 'src/a.txt', 'native edit\n');
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath, self: fx.self, result: nativeResult, providedReviews: {}, now: 3000,
  });
  assert.equal(reviewed.tasks[0].review.verdict, 'error', 'an owed-but-absent review never passes silently');
  assert.match(reviewed.tasks[0].review.summary, /not provided/);
});

test('native review is a no-op when review_context is absent or disabled', async () => {
  const fx = makeNativeFixture({ slug: 'native-off', review: { adversary: false } });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath, self: fx.self, result: nativeResult, providedReviews: { 1: rejectRecord }, now: 3000,
  });
  assert.equal(reviewed, nativeResult, 'disabled review context is a pure passthrough');
});

// x22-auth-path: reproduce the judge's authorization and physical-path probes
// using disposable bundles only. Output records the actual boundary result.
async function x22Fixture(slug) {
  const fx = makeNativeFixture({ slug });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  record.review_context.episodes['1'] = { hold: 'historical' };
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  write(fx.WT, 'src/a.txt', 'change\n');
  fx.result = { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1) }] };
  fx.args = { statePath: fx.statePath, wave: 1, taskId: 1, self: fx.self, now: 2200, disposition: 'restart' };
  return fx;
}
async function x22Probe(label, call) {
  try {
    const value = await call();
    console.log(`PROBE ${label}: ACCEPTED`, JSON.stringify(value?.pending_reviews?.map((d) => d.subject) ?? value?.disposition?.kind ?? value?.review_outcome));
    return { value };
  } catch (error) {
    console.log(`PROBE ${label}: REFUSED`, error.message);
    return { error };
  }
}

for (const mode of ['foreign owner', 'missing owner', 'foreign phase B', 'foreign recovery', 'foreign direct recovery']) {
  test(`X22 F1 ${mode} cannot consume dispositions or mutate review events`, async () => {
    const fx = await x22Fixture(`x22-${mode.replaceAll(' ', '-')}`);
    disposeReviewEpisode(fx.args);
    if (mode.includes('recovery')) {
      git(fx.WT, 'add', 'src/a.txt');
      git(fx.WT, 'commit', '-q', '-m', 'disposable recovered work');
    }
    const foreign = buildOwnerIdentity({ host: 'h2', session: 'not-owner', slug: readState(fx.statePath).slug, now: 2200 });
    assert.throws(() => disposeReviewEpisode({ ...fx.args, self: foreign }), /owned by another/);
    const eventPath = path.join(fx.bundleDir, 'events.jsonl');
    const before = fs.existsSync(eventPath) ? fs.readFileSync(eventPath, 'utf8') : null;
    const record = readWaveDispatchRecord(fx.bundleDir, 1);
    const direct = mode === 'foreign direct recovery' ? {
      absState: fx.statePath, state: readState(fx.statePath), bundleDir: fx.bundleDir,
      record, ctx: record.review_context, runId: record.run_id, wave: 1,
      contextFingerprint: fingerprintReviewContext(record.review_context),
      selector: { repo: fx.WT, head: git(fx.WT, 'rev-parse', 'HEAD') },
    } : {};
    const consumer = mode === 'foreign direct recovery' ? reviewCommittedRecovery : reviewNativeResult;
    const out = await x22Probe(mode, () => consumer({
      ...direct,
      statePath: fx.statePath, result: fx.result, policy: dispatchFixture, now: 2300,
      self: mode === 'missing owner' ? null : foreign,
      ...(mode === 'foreign phase B' ? { providedReviews: { 1: rejectRecord } } : {}),
      ...(mode === 'foreign recovery' ? { recoverySelector: { repo: fx.WT, head: git(fx.WT, 'rev-parse', 'HEAD') } } : {}),
    }));
    assert.match(out.error?.message ?? '', /owned by another|owner identity required/);
    assert.equal(fs.existsSync(eventPath) ? fs.readFileSync(eventPath, 'utf8') : null, before);
    assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
  });
}

test('X22 F1 hand-edited restart subjects and nonexact lineage refuse both consumption and reapply', async () => {
  const fx = await x22Fixture('x22-forgery');
  const canonical = disposeReviewEpisode(fx.args).disposition;
  const cases = [
    { ...canonical, subject: 'forged-budget-A', lineage: {} },
    { ...canonical, subject: 'forged-budget-B', lineage: {} },
    { ...canonical, subject: 'forged-budget-C' },
    ...[undefined, null, [], {}, { wave: 2, task_id: 1 }, { wave: 1, task_id: 2 }, { wave: '1', task_id: 1 },
      { wave: 1, task_id: 1, extra: true }].map((lineage) => ({ ...canonical, lineage })),
  ];
  for (const disposition of cases) {
    const record = readWaveDispatchRecord(fx.bundleDir, 1);
    record.review_context.episodes['1'].disposition = disposition;
    writeWaveDispatchRecord(fx.bundleDir, 1, record);
    const out = await x22Probe(`hand-edited restart ${JSON.stringify(disposition)}`, () => reviewNativeResult({
      statePath: fx.statePath, result: fx.result, self: fx.self, now: 2300, policy: dispatchFixture,
    }));
    assert.match(out.error?.message ?? '', /invalid restart/);
    assert.throws(() => disposeReviewEpisode(fx.args), /invalid restart/);
    await assert.rejects(() => reviewNativeResult({ statePath: fx.statePath, result: fx.result,
      self: fx.self, now: 2300, providedReviews: { 1: rejectRecord }, policy: dispatchFixture }), /invalid restart/);
  }
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  record.review_context.episodes['1'].disposition = canonical;
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  assert.equal((await reviewNativeResult({ statePath: fx.statePath, result: fx.result,
    self: fx.self, now: 2300, policy: dispatchFixture })).pending_reviews[0].subject, canonical.subject);
});

for (const mode of ['primary symlink into stale worktree', 'state-file symlink', 'ordinary stale copy', 'relative primary path']) {
  test(`X22 F2 ${mode}`, async () => {
    const fx = await x22Fixture(`x22-${mode.replaceAll(' ', '-')}`);
    let statePath = fx.statePath;
    const stale = path.join(fx.WT, 'docs', 'masterplan', readState(fx.statePath).slug);
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    if (mode === 'primary symlink into stale worktree') {
      fs.renameSync(fx.bundleDir, stale);
      fs.symlinkSync(stale, fx.bundleDir, 'dir');
    } else if (mode === 'state-file symlink') {
      fs.mkdirSync(stale, { recursive: true });
      fs.renameSync(fx.statePath, path.join(stale, 'state.yml'));
      fs.symlinkSync(path.join(stale, 'state.yml'), fx.statePath);
    } else if (mode === 'ordinary stale copy') {
      fs.cpSync(fx.bundleDir, stale, { recursive: true });
      statePath = path.join(stale, 'state.yml');
    } else {
      statePath = path.relative(process.cwd(), fx.statePath);
    }
    const physicalBundle = mode === 'primary symlink into stale worktree' || mode === 'ordinary stale copy' ? stale : fx.bundleDir;
    const recordPath = path.join(physicalBundle, 'wave-1.dispatch.json');
    const lockPath = path.join(physicalBundle, '.owner.lock');
    const before = fs.readFileSync(recordPath, 'utf8');
    const lockBefore = fs.readFileSync(lockPath, 'utf8');
    const out = await x22Probe(mode, () => disposeReviewEpisode({ ...fx.args, statePath }));
    if (mode === 'relative primary path') {
      assert.equal(out.value?.disposition.kind, 'restart');
      const read = await reviewNativeResult({ statePath, result: fx.result, self: fx.self, now: 2300, policy: dispatchFixture });
      assert.equal(read.pending_reviews[0].subject, out.value.disposition.subject);
    } else {
      assert.match(out.error?.message ?? '', /primary bundle/);
      // Path refusal precedes even a missing-owner check, for writes and reads.
      assert.throws(() => disposeReviewEpisode({ ...fx.args, statePath, self: null }), /primary bundle/);
      await assert.rejects(() => reviewNativeResult({ statePath, result: fx.result, policy: dispatchFixture }), /primary bundle/);
      assert.equal(fs.readFileSync(recordPath, 'utf8'), before);
      assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBefore);
    }
  });
}


test('X22 F1 recovery consumers refuse a forged restart subject and lineage', async () => {
  const fx = await x22Fixture('x22-recovery-forgery');
  disposeReviewEpisode(fx.args);
  git(fx.WT, 'add', 'src/a.txt');
  git(fx.WT, 'commit', '-q', '-m', 'disposable recovery forgery probe');
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  record.review_context.episodes['1'].disposition = { kind: 'restart', subject: 'forged-budget-A', lineage: {} };
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  for (const providedReviews of [null, { 1: rejectRecord }]) {
    const out = await x22Probe(`recovery forged restart ${providedReviews ? 'phase B' : 'phase A'}`, () => reviewNativeResult({
      statePath: fx.statePath, result: fx.result, self: fx.self, now: 2300, policy: dispatchFixture,
      recoverySelector: { repo: fx.WT, head: git(fx.WT, 'rev-parse', 'HEAD') }, providedReviews,
    }));
    assert.match(out.error?.message ?? '', /invalid restart/);
  }
});

// x22-evidence: reproduce all-path eligibility and restart re-entry probes.
const x22Approval = { final_verdict: 'approve', findings: [], blocking_findings: [],
  summary: 'OLD EPISODE APPROVAL', harness: healthyHarness() };
const x22ProjectedApproval = { verdict: 'approve', findings: [], blocking_findings: [],
  summary: 'synthetic approve', harness: healthyHarness() };
const x22Events = (fx) => {
  const p = path.join(fx.bundleDir, 'events.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

for (const phase of ['A', 'B']) {
  test(`X22 F3 held with embedded approval refused in phase ${phase}`, async () => {
    const fx = await x22Fixture(`x22-held-embedded-${phase}`);
    const before = x22Events(fx);
    const result = { ...fx.result, tasks: fx.result.tasks.map((it) => ({ ...it, review: x22ProjectedApproval,
      digest: { ...it.digest, review: x22ProjectedApproval } })) };
    const out = await x22Probe(`held with embedded review phase ${phase}`, () => reviewNativeResult({
      statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture,
      ...(phase === 'B' ? { providedReviews: { 1: x22Approval } } : {}),
    }));
    assert.match(out.error?.message ?? '', /subjectless hold/);
    assert.equal(x22Events(fx), before);
    assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
  });
}

for (const mode of ['held', 'retired', 'retired reconcile']) {
  test(`X22 F3 ${mode} direct recorder refused before completion evidence`, async () => {
    const fx = await x22Fixture(`x22-direct-${mode.replaceAll(' ', '-')}`);
    if (mode.startsWith('retired')) disposeReviewEpisode({ ...fx.args, disposition: 'retire', reason: 'not reviewed' });
    if (mode.endsWith('reconcile')) {
      // A crash-reconcile must not finalize an already-marked unsafe episode.
      const state = readState(fx.statePath);
      state.tasks[0].status = 'done';
      writeState(fx.statePath, state);
    }
    const beforeState = fs.readFileSync(fx.statePath, 'utf8');
    const before = x22Events(fx);
    let error;
    try {
      const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2300, worktree: fx.WT,
        result: mode.endsWith('reconcile') ? null : { ...fx.result, tasks: fx.result.tasks.map((it) => ({ ...it,
          review: x22ProjectedApproval, digest: { ...it.digest, review: x22ProjectedApproval } })) } });
      console.log(`PROBE ${mode} direct recorder:`, JSON.stringify({ outcome: recorded.outcome,
        blocking: recorded.blocking_reviews, status: readState(fx.statePath).tasks[0].status }));
    } catch (err) { error = err; console.log(`PROBE ${mode} direct recorder: REFUSED`, err.message); }
    assert.match(error?.message ?? '', /subjectless hold|retired.*not reviewed/);
    assert.equal(fs.readFileSync(fx.statePath, 'utf8'), beforeState);
    assert.equal(x22Events(fx), before);
    assert.ok(readState(fx.statePath).active_run);
  });
}

test('X22 F4 restart consumes fresh reject, never old same-diff approval', async () => {
  const fx = makeNativeFixture({ slug: 'x22-old-approval' });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  write(fx.WT, 'src/a.txt', 'change\n');
  const result = { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1) }] };
  const old = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2100,
    result, providedReviews: { 1: x22Approval }, policy: dispatchFixture });
  assert.equal(old.tasks[0].review.verdict, 'approve');
  const before = x22Events(fx);
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  record.review_context.episodes['1'] = { hold: 'historical' };
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  const restart = disposeReviewEpisode({ statePath: fx.statePath, self: fx.self, now: 2200, wave: 1, taskId: 1, disposition: 'restart' });
  const out = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300,
    result, providedReviews: { 1: { ...rejectRecord, episode_subject: restart.disposition.subject } }, policy: dispatchFixture });
  console.log('PROBE restart NEW reject supplied, consumed verdict:', out.tasks[0].review.verdict,
    'summary:', out.tasks[0].review.summary);
  assert.equal(out.tasks[0].review.verdict, 'reject');
  assert.equal(out.tasks[0].review.episode_subject, restart.disposition.subject);
  assert.ok(x22Events(fx).startsWith(before), 'historical events unchanged');
  const latest = x22Events(fx).trim().split('\n').map(JSON.parse).filter((ev) => ev.type === 'task_adversary_review').at(-1);
  assert.equal(latest.data.episode_subject, restart.disposition.subject);
  // Same new episode re-entry remains idempotent and reuses its reject, not an old approval.
  const again = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2400,
    result, providedReviews: { 1: { ...x22Approval, episode_subject: restart.disposition.subject } }, policy: dispatchFixture });
  assert.equal(again.tasks[0].review.verdict, 'reject');
  const bytes = x22Events(fx);
  await assert.rejects(() => reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2400,
    result: old, policy: dispatchFixture }), /episode.*mismatch/);
  assert.throws(() => recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2400,
    result: old, worktree: fx.WT }), /episode.*mismatch/);
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
  assert.equal(x22Events(fx), bytes);
  const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2500,
    result: out, worktree: fx.WT });
  assert.equal(recorded.blocking_reviews[0].verdict, 'reject');
});

test('X22 F4 recovery re-entry and recorder exclude old deferred episode evidence', async () => {
  const fx = await x22Fixture('x22-recovery-evidence');
  const saved = readWaveDispatchRecord(fx.bundleDir, 1);
  saved.review_context.episodes['1'] = { subject: 'fixture-active-episode' };
  writeWaveDispatchRecord(fx.bundleDir, 1, saved);
  git(fx.WT, 'add', 'src/a.txt');
  git(fx.WT, 'commit', '-q', '-m', 'disposable recovered work');
  const recoverySelector = { repo: fx.WT, head: git(fx.WT, 'rev-parse', 'HEAD') };
  const opts = { statePath: fx.statePath, self: fx.self, now: 2300,
    result: fx.result, recoverySelector, policy: dispatchFixture };
  const manifest = await reviewNativeResult(opts);
  const identity = manifest.pending_reviews[0].identity;
  const old = await reviewNativeResult({ ...opts, providedReviews: { 1: { ...x22Approval, identity } } });
  assert.equal(old.tasks[0].review.verdict, 'approve');
  for (const { event } of old.deferred_review_events) appendEvent(fx.statePath, event);
  const before = x22Events(fx);
  const held = readWaveDispatchRecord(fx.bundleDir, 1);
  held.review_context.episodes['1'] = { hold: 'historical' };
  writeWaveDispatchRecord(fx.bundleDir, 1, held);
  const restart = disposeReviewEpisode(fx.args);
  const freshManifest = await reviewNativeResult(opts);
  assert.equal(freshManifest.pending_reviews[0].subject, restart.disposition.subject);
  // No receipt schema/binding change: the event's new episode key is independent
  // of the existing committed-diff receipt identity, which stays untouched.
  assert.deepEqual(freshManifest.pending_reviews[0].identity, identity);
  const fresh = await reviewNativeResult({ ...opts, providedReviews: { 1: { ...rejectRecord, identity,
    episode_subject: freshManifest.pending_reviews[0].subject } } });
  console.log('PROBE recovery restart NEW reject supplied, consumed verdict:', fresh.tasks[0].review.verdict,
    'summary:', fresh.tasks[0].review.summary);
  assert.equal(fresh.tasks[0].review.verdict, 'reject');
  assert.equal(fresh.deferred_review_events.length, 1);
  assert.equal(fresh.deferred_review_events[0].event.data.episode_subject, restart.disposition.subject);
  assert.equal(fresh.tasks[0].digest.review.episode_subject, restart.disposition.subject);
  assert.equal(x22Events(fx), before, 'recovery review append remains deferred');
  const stateBefore = fs.readFileSync(fx.statePath, 'utf8');
  assert.throws(() => recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2400,
    worktree: fx.WT, result: fresh, deferredEvents: old.deferred_review_events,
    recovery: true, recoverySelector }), /episode.*mismatch/);
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), stateBefore);
  assert.equal(x22Events(fx), before);
  const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2500,
    worktree: fx.WT, result: fresh, deferredEvents: fresh.deferred_review_events,
    recovery: true, recoverySelector });
  assert.equal(recorded.blocking_reviews[0].verdict, 'reject');
  assert.ok(x22Events(fx).startsWith(before));
});

for (const episode of [{}, null]) {
  test(`X22 F3 unlinked ${JSON.stringify(episode)} direct recorder refuses`, async () => {
    const fx = await x22Fixture('x22-unlinked-recorder');
    const record = readWaveDispatchRecord(fx.bundleDir, 1);
    if (episode) record.review_context.episodes['1'] = episode;
    else delete record.review_context.episodes['1'];
    writeWaveDispatchRecord(fx.bundleDir, 1, record);
    const before = fs.readFileSync(fx.statePath, 'utf8');
    assert.throws(() => recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2300,
      worktree: fx.WT, result: fx.result }), /subjectless hold|no identifiable entry/);
    assert.equal(fs.readFileSync(fx.statePath, 'utf8'), before);
    assert.equal(x22Events(fx), '');
  });
}

// x22-r3-recorder: judge-2 findings 1 and 3, disposable bundles only.
for (const partial of [false, true]) {
  test(`X22 R3 F1 ${partial ? 'partial' : 'empty'} result refuses omitted retired done task`, async () => {
    const fx = await x22Fixture(`x22-r3-retired-${partial}`);
    const state = readState(fx.statePath);
    state.tasks[0].status = 'done';
    if (partial) state.tasks.push({ id: 2, wave: 1, status: 'done', files: [] });
    writeState(fx.statePath, state);
    disposeReviewEpisode({ ...fx.args, disposition: 'retire', reason: 'not reviewed' });
    if (partial) {
      const record = readWaveDispatchRecord(fx.bundleDir, 1);
      record.review_context.episodes['2'] = { subject: 'disposable-new-slot' };
      writeWaveDispatchRecord(fx.bundleDir, 1, record);
    }
    const before = fs.readFileSync(fx.statePath, 'utf8');
    const events = x22Events(fx);
    const out = await x22Probe(`R3 ${partial ? 'partial' : 'empty'} retired recorder`, () => recordWaveResult({
      statePath: fx.statePath, self: fx.self, now: 2300, worktree: fx.WT,
      result: { wave: 1, tasks: partial ? [{ task_id: 2, digest: workerDigest(2), review: x22ProjectedApproval }] : [] },
    }));
    const status = JSON.parse(execFileSync(process.execPath, [new URL('../bin/masterplan.mjs', import.meta.url).pathname,
      'status', `--state=${fx.statePath}`], { encoding: 'utf8' }));
    const next = await x22Probe('R3 retired continue', () => continueRun({ statePath: fx.statePath,
      self: fx.self, now: 2400, routing: dispatchFixture, fabricDispatch: true }));
    console.log('PROBE R3 retired status/continue:', JSON.stringify({ tasks: status.tasks, next: next.value ?? next.error?.message }));
    assert.match(out.error?.message ?? '', /retired.*not reviewed/);
    assert.equal(status.tasks.done, partial ? 1 : 0, 'retirement is not done-reviewed');
    assert.notEqual(next.value?.skill, 'finish');
    assert.equal(fs.readFileSync(fx.statePath, 'utf8'), before);
    assert.equal(x22Events(fx), events);
  });
}

for (const viaContinue of [false, true]) {
  test(`X22 R3 F3 fresh reject crash restores blocking via ${viaContinue ? 'continue' : 'reconcile'}`, async () => {
    const fx = await x22Fixture(`x22-r3-crash-reject-${viaContinue}`);
    const restart = disposeReviewEpisode(fx.args);
    const fresh = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300,
      result: fx.result, providedReviews: { 1: { ...rejectRecord, episode_subject: restart.disposition.subject } }, policy: dispatchFixture });
    assert.equal(fresh.tasks[0].review.verdict, 'reject');
    // Actual step-1 crash window: status is durable, the marker and artifact remain.
    const state = readState(fx.statePath);
    state.tasks[0].status = 'done';
    writeState(fx.statePath, state);
    const history = x22Events(fx);
    const res = viaContinue ? null : recordWaveResult({ statePath: fx.statePath, self: fx.self,
      now: 2400, worktree: fx.WT, result: null });
    const next = continueRun({ statePath: fx.statePath, self: fx.self, now: 2500, routing: dispatchFixture });
    console.log('PROBE R3 fresh reject crash:', JSON.stringify({ blocking: res?.blocking_reviews, next }));
    if (res) {
      assert.equal(res.blocking_reviews[0]?.verdict, 'reject');
      assert.match(JSON.stringify(res.blocking_reviews[0].findings), /introduces a data race/);
      assert.equal(res.cleared, false);
    }
    assert.equal(next.op, 'ask');
    assert.equal(next.ask, 'blocking-reviews');
    assert.equal(next.blocking_reviews[0]?.verdict, 'reject');
    assert.ok(readState(fx.statePath).active_run);
    assert.ok(x22Events(fx).startsWith(history), 'historical event bytes preserved');
  });
}

test('X22 R3 F3 wrong-diff reject event does not satisfy reconcile evidence', async () => {
  const fx = await x22Fixture('x22-r3-wrong-diff');
  const restart = disposeReviewEpisode(fx.args);
  const state = readState(fx.statePath);
  state.tasks[0].status = 'done';
  writeState(fx.statePath, state);
  appendEvent(fx.statePath, { type: 'task_adversary_review', data: { run: state.slug, task: 1,
    sha: 'not-the-current-diff', episode_subject: restart.disposition.subject,
    review: { ...x22ProjectedApproval, verdict: 'reject', blocking_findings: [{ summary: 'unrelated reject' }] } } });
  const before = fs.readFileSync(fx.statePath, 'utf8');
  const events = x22Events(fx);
  const out = await x22Probe('R3 wrong diff reconcile', () => recordWaveResult({ statePath: fx.statePath,
    self: fx.self, now: 2300, worktree: fx.WT, result: null }));
  assert.match(out.error?.message ?? '', /evidence.*mismatch/);
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), before);
  assert.equal(x22Events(fx), events);
});

for (const verdict of ['approve', 'reject']) {
  for (const committedRecovery of [false, true]) {
    test(`X22 R3 F3 ${verdict} reconciles after code commit (${committedRecovery ? 'recovery' : 'ordinary'})`, async () => {
      const fx = await x22Fixture(`x22-r3-after-code-${verdict}-${committedRecovery}`);
      const restart = disposeReviewEpisode(fx.args);
      let options = {};
      if (committedRecovery) {
        git(fx.WT, 'add', 'src/a.txt');
        git(fx.WT, 'commit', '-q', '-m', 'disposable recovered work');
        const recoverySelector = { repo: fx.WT, head: git(fx.WT, 'rev-parse', 'HEAD') };
        const manifest = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300,
          result: fx.result, recoverySelector, policy: dispatchFixture });
        options = { recoverySelector, identity: manifest.pending_reviews[0].identity };
      }
      const supplied = verdict === 'approve' ? x22Approval : rejectRecord;
      const reviewed = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2400,
        result: fx.result, providedReviews: { 1: { ...supplied, episode_subject: restart.disposition.subject,
          ...(options.identity ? { identity: options.identity } : {}) } },
        ...(options.recoverySelector ? { recoverySelector: options.recoverySelector } : {}), policy: dispatchFixture });
      for (const { event } of reviewed.deferred_review_events ?? []) appendEvent(fx.statePath, event);
      if (!committedRecovery) {
        git(fx.WT, 'add', 'src/a.txt');
        git(fx.WT, 'commit', '-q', '-m', 'simulate recorder step 4');
      }
      const state = readState(fx.statePath);
      state.tasks[0].status = 'done';
      writeState(fx.statePath, state);
      const res = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2500, worktree: fx.WT, result: null });
      console.log('PROBE R3 after code commit:', JSON.stringify({ verdict, committedRecovery,
        blocking: res.blocking_reviews, cleared: res.cleared }));
      assert.equal(res.cleared, verdict === 'approve');
      assert.equal(res.blocking_reviews.length, verdict === 'approve' ? 0 : 1);
      if (verdict === 'reject') assert.equal(res.blocking_reviews[0].verdict, 'reject');
    });
  }
}

test('X22 R3 F3 partial result restores omitted fresh rejection', async () => {
  const fx = await x22Fixture('x22-r3-omitted-reject');
  const restart = disposeReviewEpisode(fx.args);
  await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300,
    result: fx.result, providedReviews: { 1: { ...rejectRecord, episode_subject: restart.disposition.subject } }, policy: dispatchFixture });
  const state = readState(fx.statePath);
  state.tasks[0].status = 'done';
  writeState(fx.statePath, state);
  const out = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2400,
    worktree: fx.WT, result: { wave: 1, tasks: [] } });
  assert.equal(out.blocking_reviews[0]?.verdict, 'reject');
  assert.equal(out.cleared, false);
});

for (const partial of [false, true]) {
  test(`X22 R3 F1 omitted done HOLD/unlinked task refuses (${partial})`, async () => {
    const fx = await x22Fixture(`x22-r3-omitted-hold-${partial}`);
    const state = readState(fx.statePath);
    state.tasks[0].status = 'done';
    writeState(fx.statePath, state);
    if (partial) {
      const record = readWaveDispatchRecord(fx.bundleDir, 1);
      delete record.review_context.episodes['1'];
      writeWaveDispatchRecord(fx.bundleDir, 1, record);
    }
    const before = fs.readFileSync(fx.statePath, 'utf8');
    assert.throws(() => recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2300,
      worktree: fx.WT, result: { wave: 1, tasks: [] } }), /subjectless hold|no identifiable entry/);
    assert.equal(fs.readFileSync(fx.statePath, 'utf8'), before);
  });
}

test('X22 R3 F3 newly submitted rejection remains blocking on continue', async () => {
  const fx = await x22Fixture('x22-r3-new-reject-continue');
  const restart = disposeReviewEpisode(fx.args);
  const reviewed = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300,
    result: fx.result, providedReviews: { 1: { ...rejectRecord, episode_subject: restart.disposition.subject } }, policy: dispatchFixture });
  const res = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2400,
    worktree: fx.WT, result: reviewed });
  assert.equal(res.blocking_reviews[0]?.verdict, 'reject');
  assert.equal(res.cleared, false);
  const next = continueRun({ statePath: fx.statePath, self: fx.self, now: 2500, routing: dispatchFixture });
  assert.equal(next.ask, 'blocking-reviews');
  assert.equal(next.blocking_reviews[0]?.verdict, 'reject');
});

test('X22 R3 F1 retired done task without marker cannot hand off to finish', async () => {
  const fx = await x22Fixture('x22-r3-retired-no-marker');
  disposeReviewEpisode({ ...fx.args, disposition: 'retire', reason: 'not reviewed' });
  const state = readState(fx.statePath);
  state.tasks[0].status = 'done';
  state.active_run = null;
  writeState(fx.statePath, state);
  const next = continueRun({ statePath: fx.statePath, self: fx.self, now: 2300, routing: dispatchFixture });
  assert.equal(next.ask, 'review-episode-ineligible');
  assert.deepEqual(next.tasks, [1]);
});

// x22-r3-ingest: raw receipt replay and exported-consumer stale context.
for (const echo of [undefined, 'old-episode']) {
  test(`X22 R3 F2 normal supplied ${echo ?? 'missing'} episode refuses`, async () => {
    const fx = await x22Fixture(`x22-r3-raw-normal-${echo ?? 'missing'}`);
    disposeReviewEpisode(fx.args);
    const before = x22Events(fx);
    const stateBefore = fs.readFileSync(fx.statePath, 'utf8');
    const out = await x22Probe(`R3 raw normal ${echo ?? 'missing'} subject`, () => reviewNativeResult({
      statePath: fx.statePath, self: fx.self, now: 2300, result: fx.result, policy: dispatchFixture,
      providedReviews: { 1: { ...x22Approval, ...(echo ? { episode_subject: echo } : {}) } },
    }));
    assert.match(out.error?.message ?? '', /episode.*mismatch/);
    assert.equal(x22Events(fx), before);
    assert.equal(fs.readFileSync(fx.statePath, 'utf8'), stateBefore);
  });
}

test('X22 R3 F2 replay actual old recovery receipt after restart refuses', async () => {
  const fx = await x22Fixture('x22-r3-raw-recovery-replay');
  const active = readWaveDispatchRecord(fx.bundleDir, 1);
  active.review_context.episodes['1'] = { subject: 'fixture-active-episode' };
  writeWaveDispatchRecord(fx.bundleDir, 1, active);
  git(fx.WT, 'add', 'src/a.txt');
  git(fx.WT, 'commit', '-q', '-m', 'disposable recovery replay');
  const opts = { statePath: fx.statePath, self: fx.self, now: 2300, result: fx.result,
    recoverySelector: { repo: fx.WT, head: git(fx.WT, 'rev-parse', 'HEAD') }, policy: dispatchFixture };
  const manifest = await reviewNativeResult(opts);
  const receipt = { ...x22Approval, identity: manifest.pending_reviews[0].identity };
  const historicalBytes = JSON.stringify(receipt);
  const old = await reviewNativeResult({ ...opts, providedReviews: { 1: receipt } });
  assert.equal(old.tasks[0].review.verdict, 'approve');
  for (const { event } of old.deferred_review_events) appendEvent(fx.statePath, event);
  const held = readWaveDispatchRecord(fx.bundleDir, 1);
  held.review_context.episodes['1'] = { hold: 'historical' };
  writeWaveDispatchRecord(fx.bundleDir, 1, held);
  const restart = disposeReviewEpisode(fx.args);
  const before = x22Events(fx);
  const out = await x22Probe('R3 replay actual old recovery receipt', () => reviewNativeResult({
    ...opts, providedReviews: { 1: receipt },
  }));
  assert.match(out.error?.message ?? '', /episode.*mismatch/);
  assert.equal(x22Events(fx), before);
  assert.equal(JSON.stringify(receipt), historicalBytes, 'historical receipt bytes untouched');
  for (const episode_subject of ['old-episode', restart.disposition.subject]) {
    const call = () => reviewNativeResult({ ...opts, providedReviews: { 1: { ...receipt, episode_subject } } });
    if (episode_subject === 'old-episode') await assert.rejects(call, /episode.*mismatch/);
    else {
      const fresh = await call();
      assert.equal(fresh.tasks[0].review.verdict, 'approve');
      assert.equal(fresh.tasks[0].review.episode_subject, episode_subject);
    }
  }
  assert.equal(x22Events(fx), before, 'fresh recovery events still deferred');
});

for (const disposition of ['retire', 'restart']) {
  test(`X22 R3 F4 cached context after ${disposition} refuses direct recovery`, async () => {
    const fx = await x22Fixture(`x22-r3-cached-${disposition}`);
    const active = readWaveDispatchRecord(fx.bundleDir, 1);
    active.review_context.episodes['1'] = { subject: 'old-episode' };
    writeWaveDispatchRecord(fx.bundleDir, 1, active);
    git(fx.WT, 'add', 'src/a.txt');
    git(fx.WT, 'commit', '-q', '-m', 'disposable cached-context probe');
    const cached = readWaveDispatchRecord(fx.bundleDir, 1);
    const args = { absState: fx.statePath, state: readState(fx.statePath), bundleDir: fx.bundleDir,
      record: cached, ctx: cached.review_context, contextFingerprint: fingerprintReviewContext(cached.review_context),
      runId: cached.run_id, wave: 1, self: fx.self, now: 2300, result: fx.result,
      selector: { repo: fx.WT, head: git(fx.WT, 'rev-parse', 'HEAD') }, policy: dispatchFixture };
    const held = readWaveDispatchRecord(fx.bundleDir, 1);
    held.review_context.episodes['1'] = { hold: 'historical' };
    writeWaveDispatchRecord(fx.bundleDir, 1, held);
    disposeReviewEpisode({ ...fx.args, disposition, ...(disposition === 'retire' ? { reason: 'not reviewed' } : {}) });
    const before = x22Events(fx);
    const out = await x22Probe(`R3 cached ${disposition} recovery`, () => reviewCommittedRecovery(args));
    assert.match(out.error?.message ?? '', /stale|retired.*not reviewed/);
    assert.equal(x22Events(fx), before);
    assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
    const freshRecord = readWaveDispatchRecord(fx.bundleDir, 1);
    const freshArgs = { ...args, record: freshRecord, ctx: freshRecord.review_context,
      contextFingerprint: fingerprintReviewContext(freshRecord.review_context) };
    if (disposition === 'retire') await assert.rejects(() => reviewCommittedRecovery(freshArgs), /retired.*not reviewed/);
    else {
      const fresh = await reviewCommittedRecovery(freshArgs);
      assert.match(fresh.pending_reviews[0].subject, /restart-1$/);
      await assert.rejects(() => reviewCommittedRecovery({ ...freshArgs, contextFingerprint: 'stale' }), /stale/);
      // No caller snapshots are needed: every identity field comes from disk.
      const derived = await reviewCommittedRecovery({ ...freshArgs,
        record: undefined, ctx: undefined, runId: undefined, contextFingerprint: undefined });
      assert.deepEqual(derived.pending_reviews, fresh.pending_reviews);
    }
  });
}

// X22 round 4: actual checkpoint approvals, then crash-before-finalize.
async function x22R4ReviewedFixture(slug, committed = false) {
  const fx = await x22Fixture(slug);
  disposeReviewEpisode(fx.args);
  let recoverySelector;
  if (committed) {
    git(fx.WT, 'add', 'src/a.txt');
    git(fx.WT, 'commit', '-q', '-m', 'reviewed committed work');
    recoverySelector = { repo: fx.WT, head: git(fx.WT, 'rev-parse', 'HEAD') };
  }
  const manifest = await reviewNativeResult({ statePath: fx.statePath, self: fx.self,
    result: fx.result, policy: dispatchFixture, recoverySelector, now: 2300 });
  const { reviewCompletedTasks } = await import('../lib/task-review.mjs');
  const reviewed = await reviewCompletedTasks({ statePath: fx.statePath,
    runId: readState(fx.statePath).slug, wave: 1, items: manifest.tasks,
    requireIdentity: committed, expectedIdentity: manifest.pending_reviews[0].identity,
    callReview: async (args) => ({ ...x22Approval, episode_subject: args.subject,
      intent_identity: args.intent_identity }), now: 2400 });
  fx.reviewed = { ...fx.result, tasks: reviewed };
  fx.manifest = manifest;
  const state = readState(fx.statePath);
  state.tasks[0].status = 'done';
  writeState(fx.statePath, state);
  return fx;
}
function x22R4RefusedUnchanged(fx, pattern, options = {}) {
  const before = { head: git(fx.WT, 'rev-parse', 'HEAD'), main: git(fx.MAIN, 'rev-parse', 'HEAD'),
    state: fs.readFileSync(fx.statePath, 'utf8'), events: x22Events(fx),
    status: git(fx.WT, 'status', '--porcelain'),
    heartbeat: fs.readdirSync(fx.bundleDir).filter((p) => p.startsWith('.owner.hb.'))
      .map((p) => [p, fs.readFileSync(path.join(fx.bundleDir, p), 'utf8')]) };
  assert.throws(() => recordWaveResult({ statePath: fx.statePath, self: fx.self,
    worktree: fx.WT, result: null, now: 2500, ...options }), pattern);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), before.head);
  assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD'), before.main);
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), before.state);
  assert.equal(x22Events(fx), before.events);
  assert.equal(git(fx.WT, 'status', '--porcelain'), before.status);
  for (const [p, bytes] of before.heartbeat) assert.equal(fs.readFileSync(path.join(fx.bundleDir, p), 'utf8'), bytes);
}
for (const residue of ['tracked', 'staged', 'untracked']) {
  test(`X22 R4 F1 committed receipt refuses ${residue} residue before recorder mutation`, async () => {
    const fx = await x22R4ReviewedFixture(`x22-r4-${residue}`, true);
    // Track the reviewed file first for tracked/staged variants; it is now committed.
    write(fx.WT, residue === 'untracked' ? 'src/residue.txt' : 'src/a.txt', 'UNREVIEWED new bytes\n');
    if (residue === 'staged') git(fx.WT, 'add', 'src/a.txt');
    x22R4RefusedUnchanged(fx, /clean|dirty|drift/i);
  });
}
for (const committed of [false, true]) {
  test(`X22 R4 F2 stale goals require fresh review, never reconcile (${committed})`, async () => {
    const fx = await x22R4ReviewedFixture(`x22-r4-goals-${committed}`, committed);
    write(fx.bundleDir, 'goals.md', 'topic: Updated purpose\n\n## G1: A different goal for this run\nsignal: new proof\n');
    const { reviewCompletedTasks } = await import('../lib/task-review.mjs');
    let calls = 0;
    const check = await reviewCompletedTasks({ statePath: fx.statePath,
      runId: readState(fx.statePath).slug, wave: 1, items: fx.manifest.tasks,
      requireIdentity: committed, expectedIdentity: fx.manifest.pending_reviews[0].identity,
      onEvent: () => {}, callReview: async (args) => {
        calls++;
        return { ...rejectRecord, episode_subject: args.subject, intent_identity: args.intent_identity };
      } });
    assert.equal(calls, 1, 'normal checkpoint refuses the old approval');
    assert.equal(check[0].review.verdict, 'reject');
    x22R4RefusedUnchanged(fx, /evidence|intent|fresh review/i);
  });
}
test('X22 R4 adjacent explicitly unavailable reviewer cannot clear reconciliation', async () => {
  const fx = await x22R4ReviewedFixture('x22-r4-reviewer');
  const event = JSON.parse(x22Events(fx).trim().split('\n').at(-1));
  event.data.review.reviewer_identity = { dispatch_id: '', model: '', output_tokens: null };
  appendEvent(fx.statePath, event);
  x22R4RefusedUnchanged(fx, /evidence|reviewer|fresh review/i);
});
test('X22 R4 adjacent submitted stale approval cannot bypass checkpoint eligibility', async () => {
  const fx = await x22R4ReviewedFixture('x22-r4-submitted-stale');
  write(fx.bundleDir, 'goals.md', 'topic: Changed purpose\n\n## G1: Changed goal\nsignal: new proof\n');
  x22R4RefusedUnchanged(fx, /evidence|intent|fresh review/i, { result: fx.reviewed });
});

test('X22 R5 submitted ordinary approval refuses changed unreviewed bytes', async () => {
  const fx = await x22R4ReviewedFixture('x22-r5-submitted-drift');
  const state = readState(fx.statePath);
  state.tasks[0].status = 'pending';
  writeState(fx.statePath, state);
  write(fx.WT, 'src/a.txt', 'UNREVIEWED AFTER APPROVAL\n');
  x22R4RefusedUnchanged(fx, /artifact.*mismatch|drift/i, { result: fx.reviewed });
});

test('X22 R5 submitted stripped ordinary Phase B refuses changed bytes', async () => {
  const fx = await x22R4ReviewedFixture('x22-r5-stripped-drift');
  const reviewed = { ...fx.reviewed, tasks: fx.reviewed.tasks.map(({ review_input, ...item }) => item) };
  write(fx.WT, 'src/a.txt', 'UNREVIEWED STRIPPED RESULT\n');
  x22R4RefusedUnchanged(fx, /artifact.*mismatch|drift/i, { result: reviewed });
});

test('X22 R5 submitted ordinary artifact cannot carry committed identity', async () => {
  const fx = await x22R4ReviewedFixture('x22-r5-ordinary-identity');
  fx.reviewed.tasks[0].review_input.identity = { head: git(fx.WT, 'rev-parse', 'HEAD') };
  x22R4RefusedUnchanged(fx, /artifact.*mismatch/i, { result: fx.reviewed });
});

// X22a slice 1: judge-6 provenance probes, using genuine checkpoint evidence.
function x22aSnapshot(fx) {
  return { head: git(fx.WT, 'rev-parse', 'HEAD'), main: git(fx.MAIN, 'rev-parse', 'HEAD'),
    state: fs.readFileSync(fx.statePath, 'utf8'), events: x22Events(fx),
    status: git(fx.WT, 'status', '--porcelain'),
    heartbeat: fs.readdirSync(fx.bundleDir).filter((p) => p.startsWith('.owner.hb.'))
      .map((p) => [p, fs.readFileSync(path.join(fx.bundleDir, p), 'utf8')]) };
}
for (const carrier of ['input', 'stripped', 'digest']) {
  test(`X22a F1 native re-ingestion cannot refresh embedded approval (${carrier})`, async () => {
    const fx = await x22R4ReviewedFixture(`x22a-refresh-${carrier}`);
    const state = readState(fx.statePath);
    state.tasks[0].status = 'pending';
    writeState(fx.statePath, state);
    const tasks = fx.reviewed.tasks.map((item) => {
      if (carrier === 'stripped') { const { review_input, ...rest } = item; return rest; }
      if (carrier === 'digest') { const { review, ...rest } = item; return rest; }
      return item;
    });
    const submitted = { ...fx.reviewed, tasks };
    const original = JSON.stringify(submitted);
    write(fx.WT, 'src/a.txt', 'UNREVIEWED NATIVE REFRESH\n');
    const before = x22aSnapshot(fx);
    await assert.rejects(async () => {
      const ingested = await reviewNativeResult({ statePath: fx.statePath, self: fx.self,
        now: 2500, result: submitted, policy: dispatchFixture });
      recordWaveResult({ statePath: fx.statePath, self: fx.self,
        now: 2600, worktree: fx.WT, result: ingested });
    }, /artifact.*mismatch|fresh review/i);
    assert.deepEqual(x22aSnapshot(fx), before, 'refusal preserves HEAD/state/events/heartbeat');
    assert.equal(JSON.stringify(submitted), original, 'original evidence is not relabelled');
  });
}

test('X22a F1 actual record-result CLI refuses unchanged approval after artifact drift', async () => {
  const fx = await x22R4ReviewedFixture('x22a-cli-refresh');
  const state = readState(fx.statePath);
  state.tasks[0].status = 'pending';
  writeState(fx.statePath, state);
  const resultFile = path.join(fx.tmp, 'reviewed-result.json');
  fs.writeFileSync(resultFile, JSON.stringify(fx.reviewed));
  write(fx.WT, 'src/a.txt', 'UNREVIEWED VIA ACTUAL CLI\n');
  const before = x22aSnapshot(fx);
  assert.throws(() => execFileSync(process.execPath, [
    new URL('../bin/masterplan.mjs', import.meta.url).pathname, 'record-result',
    `--state=${fx.statePath}`, `--result-file=${resultFile}`, `--worktree=${fx.WT}`,
    `--session=${fx.self.session}`, `--host=${fx.self.host}`, '--now=2600',
  ], { encoding: 'utf8', stdio: 'pipe' }), (err) => {
    assert.match(String(err.stderr), /artifact.*mismatch|fresh review/i);
    assert.notEqual(err.status, 0);
    return true;
  });
  assert.deepEqual(x22aSnapshot(fx), before, 'CLI refusal preserves HEAD/state/events/heartbeat');
});

for (const carrier of ['stripped', 'input']) {
  test(`X22a F3 genuine deferred rejection overrides submitted approval (${carrier})`, async () => {
    const fx = await x22Fixture(`x22a-contradictory-${carrier}`);
    disposeReviewEpisode(fx.args);
    git(fx.WT, 'add', 'src/a.txt');
    git(fx.WT, 'commit', '-q', '-m', 'committed artifact for both genuine reviews');
    const recoverySelector = { repo: fx.WT, head: git(fx.WT, 'rev-parse', 'HEAD') };
    const opts = { statePath: fx.statePath, self: fx.self, result: fx.result,
      policy: dispatchFixture, recoverySelector, now: 2300 };
    const manifest = await reviewNativeResult(opts);
    const { identity, subject } = manifest.pending_reviews[0];
    const approved = await reviewNativeResult({ ...opts, now: 2400,
      providedReviews: { 1: { ...x22Approval, identity, episode_subject: subject } } });
    const rejected = await reviewNativeResult({ ...opts, now: 2450,
      providedReviews: { 1: { ...rejectRecord, identity, episode_subject: subject } } });
    assert.equal(approved.tasks[0].review.verdict, 'approve');
    assert.equal(rejected.tasks[0].review.verdict, 'reject');
    if (carrier === 'input') approved.tasks[0].review_input = manifest.tasks[0].review_input;
    const beforeEvents = x22Events(fx);
    const head = git(fx.WT, 'rev-parse', 'HEAD');
    const out = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2500,
      worktree: fx.WT, result: approved, deferredEvents: rejected.deferred_review_events,
      recovery: true, recoverySelector });
    assert.equal(out.cleared, false, 'submitted approval never clears genuine rejection');
    assert.equal(out.blocking_reviews[0]?.verdict, 'reject');
    assert.match(JSON.stringify(out.blocking_reviews), /data race/);
    assert.ok(readState(fx.statePath).active_run);
    assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), head);
    assert.ok(x22Events(fx).startsWith(beforeEvents), 'preserve earlier events');
    assert.match(x22Events(fx), /"verdict":"reject"/);
    const reconciled = authorizeRecording({ statePath: fx.statePath, state: readState(fx.statePath), result: null });
    assert.equal(reconciled.reconciledReviews.get(1)?.verdict, 'reject', 'reconciliation selects the same rejecting event');
  });
}
