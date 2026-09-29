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
} from '../lib/dispatch-wave.mjs';
import { continueRun } from '../lib/continue.mjs';
import { readState, writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';
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
    statePath: fx.statePath, result: nativeResult, policy: dispatchFixture, now: 3000,
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
  const first = (await reviewNativeResult({ statePath: fx.statePath, result, policy: dispatchFixture })).pending_reviews[0];
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal(first.subject, record.review_context.episodes['1'].subject);
  assert.ok(first.subject.startsWith(`${fx.MAIN}::docs/masterplan/stable-episode/wave-1/task-1`));
  writeWaveDispatchRecord(fx.bundleDir, 1, { ...record, attempt: 4, wave_token: 'changed-token' });
  write(fx.WT, 'src/a.txt', 'second edit\n');
  const remap = structuredClone(dispatchFixture);
  remap.usecases['adversarial-assessment'].agent = 'judge';
  const second = (await reviewNativeResult({ statePath: fx.statePath, result, policy: remap })).pending_reviews[0];
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
  await assert.rejects(() => reviewNativeResult({ statePath: fx.statePath, result, policy: dispatchFixture }), /no identifiable entry/);
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
    const [d] = (await reviewNativeResult({ statePath: fx.statePath, result, host,
      discoveryOptions: absentDiscovery })).pending_reviews;
    assertConstraints(d, saved.review_context.episodes['1'].subject);
    assert.equal(d.model_source, 'host-native');
    assert.deepEqual(d.routing_map, { status: 'unconfigured', path: null, schema: null });
    assert.equal(d.agent, 'breaker');
    assert.equal(d.phase, 'challenge');
    assert.equal(Object.hasOwn(d, 'usecase'), false);
    assert.equal(Object.hasOwn(d, 'vocabulary'), false);
    assert.equal(d.diff_sha, (await reviewNativeResult({ statePath: fx.statePath, result, policy: dispatchFixture })).pending_reviews[0].diff_sha);
  }
  // A rewrite must retain operation-owned constraints rather than defaulting them.
  writeWaveDispatchRecord(fx.bundleDir, 1, { ...saved, attempt: 2, wave_token: 'other-token' });
  const configured = (await reviewNativeResult({ statePath: fx.statePath, result, policy: dispatchFixture })).pending_reviews[0];
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
    await assert.rejects(() => reviewNativeResult({ statePath: fx.statePath, result, policy: dispatchFixture }), /subjectless hold/);
    assert.deepEqual(readWaveDispatchRecord(fx.bundleDir, 1).review_context.episodes['1'], episode);
    assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
  }
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
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
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
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath, result: nativeResult, providedReviews: { 1: rejectRecord }, now: 3000,
  });
  assert.equal(reviewed, nativeResult, 'disabled review context is a pure passthrough');
});
