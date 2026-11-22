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
import { createHash } from 'node:crypto';

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
import { recordWaveResult, authorizeRecording, assertEarlierTaskFilesUnchanged } from '../lib/wave-commit.mjs';
import { captureFullWorkingDiff, rebuildFullWorkingDiff } from '../lib/working-diff.mjs';
import { fingerprintReviewContext } from '../lib/recovery-controller.mjs';
import { worktreeBranchFor, worktreePathFor } from '../lib/worktree.mjs';
import { resolveTaskReviewAttempt, taskEpisodeEligibleForCompletion } from '../lib/review-episode.mjs';
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

const jointTest = (process.env.MASTERPLAN_STANDALONE_CI === '1' && !process.env.W) ? test.skip : test;

jointTest('Task 8 panel coordinator integration: C7 isolated counters exhaust the same subject', async () => {
  // Joint-checkout dependencies are deliberately external: never use installed
  // routing or silently skip when W is absent (plan 07's integration contract).
  const W = process.env.W;
  assert.ok(W && path.isAbsolute(W) && fs.statSync(W).isDirectory(), 'W must name the absolute joint integration checkout');
  const helper = new URL('./fixtures/task5-panel-integration.mjs', import.meta.url);
  const subagents = path.join(W, 'pi-subagents');
  const helperEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TSX_DISABLE_CACHE: '1' };
  delete helperEnv.NODE_TEST_CONTEXT;
  delete helperEnv.PYTHONOPTIMIZE;
  const ceiling = Number(execFileSync('python3', ['-c',
    'import sys; sys.path.insert(0, sys.argv[1]); from lib.review_circuit_config import load; print(load().max_rounds)',
    path.join(W, 'hooks')], { env: helperEnv, encoding: 'utf8' }).trim());
  assert.ok(Number.isInteger(ceiling) && ceiling > 1, 'read the accepted hook policy ceiling');
  const fx = makeNativeFixture({ slug: 'c7-panel-episode', review: { adversary: true, stakes: 'critical' } });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  const result = { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }] };
  const launches = [];
  for (let i = 0; i <= ceiling; i++) {
    const record = readWaveDispatchRecord(fx.bundleDir, 1);
    writeWaveDispatchRecord(fx.bundleDir, 1, { ...record, attempt: i + 1, wave_token: `c7-token-${i}` });
    write(fx.WT, 'src/a.txt', `panel edit ${i}\n`);
    // Alternate ordinary and committed-recovery producers, including changed
    // HEADs. The persisted episode, not any artifact/job/token, owns the budget.
    if (i % 2) {
      git(fx.WT, 'add', 'src/a.txt');
      git(fx.WT, 'commit', '-q', '-m', `disposable recovery ${i}`);
    }
    const out = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300,
      result, policy: dispatchFixture,
      ...(i % 2 ? { recoverySelector: { repo: fx.WT, head: git(fx.WT, 'rev-parse', 'HEAD') } } : {}),
    });
    assert.equal(out.pending_reviews.length, 1, 'masterplan emits one descriptor, never seats');
    const [descriptor] = out.pending_reviews;
    assert.equal(descriptor.stakes, 'critical');
    assert.equal(descriptor.subject, readWaveDispatchRecord(fx.bundleDir, 1).review_context.episodes['1'].subject);
    assert.equal(descriptor.diff_sha, out.tasks[0].review_input.sha);
    assert.equal(descriptor.job_id, `c7-panel-episode-w1-t1-${descriptor.diff_sha.slice(0, 12)}`);
    assert.equal(Object.hasOwn(descriptor, 'model'), false);
    if (i) {
      assert.equal(descriptor.subject, launches[0].descriptor.subject);
      assert.notEqual(descriptor.diff_sha, launches[i - 1].descriptor.diff_sha);
      assert.notEqual(descriptor.job_id, launches[i - 1].descriptor.job_id);
    }
    launches.push({ descriptor, head: git(fx.WT, 'rev-parse', 'HEAD'), attempt: i + 1, token: `c7-token-${i}` });
  }
  const summary = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', helper.pathname], {
    cwd: subagents, env: helperEnv, input: JSON.stringify({ W, launches, ceiling, map: dispatchFixture }),
    encoding: 'utf8', timeout: 60000,
  }));
  assert.equal(summary.admissions, ceiling);
  assert.equal(summary.denials, 1);
  assert.equal(summary.deniedChildren, 0);
  assert.equal(summary.complete, ceiling - 1);
  assert.equal(summary.incomplete, 1);
  assert.equal(summary.recoveryAttempts, 1);
  assert.equal(summary.subject, launches[0].descriptor.subject);
  console.log(`C7 panel evidence: ${JSON.stringify(summary)}`);
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

// Risk sizing is an orchestrator judgment, not description/file-count classification.
const sizing = {
  1: { stakes: 'routine', reason: 'Plan task 1: example-only typo; git revert restores it; no runtime, data or security effect.' },
  2: { stakes: 'consequential', reason: 'Plan task 2 changes what runs; revert the code commit to restore it.' },
  3: { stakes: 'critical', reason: 'Plan task 3 rewrites customer records; recovery requires restoring the backup.' },
};

for (const recovery of [false, true]) {
  test(`per-task review sizing survives ${recovery ? 'committed recovery' : 'working diff'} descriptors`, async () => {
    const fx = makeNativeFixture({ slug: 'task-sized-review', review: { adversary: true } });
    const tasks = [1, 2, 3, 4].map((id) => planEntry(id, 1, [`src/t${id}.txt`]));
    writeState(fx.statePath, { ...readState(fx.statePath), tasks: tasks.map((t) => ({
      id: t.id, wave: 1, status: 'pending', files: t.files,
    })) });
    write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks }));
    launchNative(fx);
    const launch = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000,
      policy: dispatchFixture, taskReviews: sizing });
    for (const id of [1, 2, 3, 4]) write(fx.WT, `src/t${id}.txt`, `edit ${id}\n`);
    if (recovery) {
      git(fx.WT, 'add', '.');
      git(fx.WT, 'commit', '-qm', 'recovered wave');
    }
    const result = { wave: 1, tasks: tasks.map((t) => ({ task_id: t.id, digest: workerDigest(t.id) })) };
    const args = { statePath: fx.statePath, self: fx.self, now: 3000, result, policy: dispatchFixture,
      ...(recovery ? { recoverySelector: { repo: fx.WT, head: git(fx.WT, 'rev-parse', 'HEAD') } } : {}) };
    const pending = await reviewNativeResult(args);
    assert.deepEqual(pending.pending_reviews.map((d) => d.stakes),
      ['routine', 'consequential', 'critical', 'consequential']);
    assert.equal(pending.pending_reviews.length, 4, 'sizing never bypasses a review');
    for (const d of pending.pending_reviews) {
      assert.equal(d.subject, launch.record.review_context.episodes[String(d.task_id)].subject);
      assert.equal(d.blocking, true);
      assert.equal(d.reason, sizing[d.task_id]?.reason);
    }
    // Frozen choice survives a new artifact and a changed run-wide default.
    writeState(fx.statePath, { ...readState(fx.statePath), review: { adversary: true, stakes: 'critical' } });
    const again = await reviewNativeResult(args);
    assert.deepEqual(again.pending_reviews.map((d) => d.stakes), pending.pending_reviews.map((d) => d.stakes));
    // Missing reviews still fail closed; lower-strength review is not a bypass.
    if (recovery) {
      await assert.rejects(() => reviewNativeResult({ ...args, providedReviews: {} }), /receipt binding failed/);
    } else {
      const ingested = await reviewNativeResult({ ...args, providedReviews: {} });
      assert.ok(ingested.tasks.every((t) => t.review.verdict === 'error'));
    }
  });
}

test('legacy run-wide routine stakes without a task rationale stay conservative', async () => {
  const fx = makeNativeFixture({ review: { adversary: true, stakes: 'routine' } });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  write(fx.WT, 'src/a.txt', 'edit\n');
  const out = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 3000,
    result: { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1) }] }, policy: dispatchFixture });
  assert.equal(out.pending_reviews[0].stakes, 'consequential');
});

test('retry retains frozen task sizing and the enabled wave block despite new inputs', async () => {
  const fx = makeNativeFixture();
  launchNative(fx);
  const args = { statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture };
  const first = await dispatchWaveViaFabric({ ...args, taskReviews: { 1: sizing[1] } });
  writeState(fx.statePath, { ...readState(fx.statePath), review: { adversary: false } });
  const retry = await dispatchWaveViaFabric({ ...args, takeover: true, taskReviews: { 1: sizing[3] } });
  assert.equal(retry.record.review_context.enabled, true);
  assert.deepEqual(retry.record.review_context.episodes['1'], first.record.review_context.episodes['1']);
});

test('explicit per-task sizing arms reviews even when the legacy bundle switch is off', async () => {
  const fx = makeNativeFixture({ review: { adversary: false, ...CONSTRAINTS } });
  launchNative(fx);
  const out = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000,
    policy: dispatchFixture, taskReviews: { 1: sizing[2] } });
  assert.equal(out.record.review_context.enabled, true);
  assert.equal(out.plan.tasks[0].review.adversary, true);
  write(fx.WT, 'src/a.txt', 'edit\n');
  const pending = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 3000,
    result: { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1) }] }, policy: dispatchFixture });
  const d = pending.pending_reviews[0];
  assert.equal(d.stakes, 'consequential');
  for (const key of ['raiseTier', 'raiseEffort', 'independentOf', 'noSubstitute'])
    assert.deepEqual(d[key], CONSTRAINTS[key]);
});

for (const taskReviews of [[], { 1: null }, { 1: { stakes: 'low', reason: 'bad enum' } },
  { 1: { stakes: 'routine', reason: ' ' } }, { 9: sizing[1] }, { 1: { ...sizing[1], model: 'invented' } }]) {
  test(`invalid task review sizing refuses before persisting a dispatch: ${JSON.stringify(taskReviews)}`, async () => {
    const fx = makeNativeFixture();
    launchNative(fx);
    await assert.rejects(() => dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000,
      policy: dispatchFixture, taskReviews }), /task review sizing/);
    assert.equal(readWaveDispatchRecord(fx.bundleDir, 1), null);
  });
}

test('CLI dispatch-wave reads per-task sizing from the existing reviews-file flag', () => {
  const fx = makeNativeFixture({ extra: { concurrency: { owner_lock: 'off' } } });
  launchNative(fx);
  const file = path.join(fx.tmp, 'sizing.json');
  fs.writeFileSync(file, JSON.stringify({ 1: sizing[1] }));
  const stdout = execFileSync(process.execPath, [new URL('../bin/masterplan.mjs', import.meta.url).pathname,
    'dispatch-wave', `--state=${fx.statePath}`, `--reviews-file=${file}`], { encoding: 'utf8' });
  assert.equal(JSON.parse(stdout).record.review_context.episodes['1'].stakes, 'routine');
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
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
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
      record.tasks.push({ task_id: 2 }); // dispatched membership, not just an episode
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

test('X22 R3 F3 newly submitted rejection leaves work pending on continue', async () => {
  const fx = await x22Fixture('x22-r3-new-reject-continue');
  const restart = disposeReviewEpisode(fx.args);
  const reviewed = await reviewNativeResult({ statePath: fx.statePath, self: fx.self, now: 2300,
    result: fx.result, providedReviews: { 1: { ...rejectRecord, episode_subject: restart.disposition.subject } }, policy: dispatchFixture });
  const res = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2400,
    worktree: fx.WT, result: reviewed });
  assert.equal(res.blocking_reviews[0]?.verdict, 'reject');
  assert.equal(res.cleared, false);
  assert.deepEqual(res.recorded, []);
  assert.deepEqual(res.next.tasks.map((t) => t.id), [1]);
  const next = continueRun({ statePath: fx.statePath, self: fx.self, now: 2500, routing: dispatchFixture });
  assert.equal(next.op, 'dispatch_fabric');
  assert.ok(fs.existsSync(path.join(fx.WT, 'src/a.txt')));
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
    assert.deepEqual(out.recorded, []);
    assert.equal(readState(fx.statePath).tasks[0].status, 'pending', 'canonical rejection defeats the submitted approval');
    assert.throws(() => recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2600, result: null }),
      /committed recovery still needs review/);
  });
}

for (const carrier of ['input', 'stripped', 'digest']) {
  for (const phaseB of [false, true]) {
    test(`X22a F1 unchanged embedded evidence survives re-ingestion (${carrier}, phase B ${phaseB})`, async () => {
      const fx = await x22R4ReviewedFixture(`x22a-stable-${carrier}-${phaseB}`);
      const submitted = { ...fx.reviewed, tasks: fx.reviewed.tasks.map((item) => {
        if (carrier === 'stripped') { const { review_input, ...rest } = item; return rest; }
        if (carrier === 'digest') { const { review, ...rest } = item; return rest; }
        return item;
      }) };
      const original = JSON.stringify(submitted);
      const ingested = await reviewNativeResult({ statePath: fx.statePath, self: fx.self,
        now: 2500, result: submitted, policy: dispatchFixture,
        providedReviews: phaseB ? {} : null });
      assert.equal(JSON.stringify(submitted), original, 'preserve original evidence');
      assert.deepEqual(ingested.tasks[0].review_input, submitted.tasks[0].review_input,
        'never replace or invent the embedded carrier');
      const out = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2600,
        worktree: fx.WT, result: ingested });
      assert.equal(out.cleared, true, 'unchanged genuine approval remains usable');
      assert.deepEqual(out.blocking_reviews, []);
    });
  }
}

// X22a slice 2: judge-6 probe 2 validates A but commits an alternate linked B.
for (const entry of ['submitted', 'reconcile', 'CLI', 'CLI reconcile']) {
  test(`X22a F2 wrong worktree refuses before writes (${entry})`, async () => {
    const fx = await x22R4ReviewedFixture(`x22a-locus-${entry.replaceAll(' ', '-')}`);
    if (!entry.includes('reconcile')) {
      const state = readState(fx.statePath);
      state.tasks[0].status = 'pending';
      writeState(fx.statePath, state);
    }
    const other = path.join(fx.MAIN, '.worktrees', 'alternate');
    const base = readWaveDispatchRecord(fx.bundleDir, 1).review_context.base_sha;
    git(fx.MAIN, 'worktree', 'add', '--detach', other, base);
    write(other, 'src/a.txt', 'UNREVIEWED ALTERNATE LOCUS\n');
    assert.equal(git(other, 'rev-parse', '--git-common-dir'), git(fx.WT, 'rev-parse', '--git-common-dir'));
    const otherSnapshot = () => ({ head: git(other, 'rev-parse', 'HEAD'),
      status: git(other, 'status', '--porcelain'), bytes: fs.readFileSync(path.join(other, 'src/a.txt'), 'utf8') });
    const before = { reviewed: x22aSnapshot(fx), alternate: otherSnapshot(),
      dispatch: fs.readFileSync(path.join(fx.bundleDir, 'wave-1.dispatch.json'), 'utf8') };
    if (entry.startsWith('CLI')) {
      const resultFile = path.join(fx.tmp, 'reviewed-result.json');
      fs.writeFileSync(resultFile, JSON.stringify(fx.reviewed));
      assert.throws(() => execFileSync(process.execPath, [
        new URL('../bin/masterplan.mjs', import.meta.url).pathname, 'record-result',
        `--state=${fx.statePath}`, `--worktree=${other}`,
        ...(entry.includes('reconcile') ? ['--reconcile'] : [`--result-file=${resultFile}`]),
        `--session=${fx.self.session}`, `--host=${fx.self.host}`, '--now=2600',
      ], { encoding: 'utf8', stdio: 'pipe' }), (err) => {
        assert.match(String(err.stderr), /mutation locus.*mismatch/i);
        assert.notEqual(err.status, 0);
        return true;
      });
    } else {
      assert.throws(() => recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2600,
        worktree: other, result: entry === 'reconcile' ? null : fx.reviewed }), /mutation locus.*mismatch/i);
    }
    assert.deepEqual({ reviewed: x22aSnapshot(fx), alternate: otherSnapshot(),
      dispatch: fs.readFileSync(path.join(fx.bundleDir, 'wave-1.dispatch.json'), 'utf8') }, before,
    'refusal preserves both HEADs/dirty bytes, MAIN HEAD, state/events/heartbeat and dispatch record');
  });
}

for (const mixed of [false, true]) {
  test(`X22a F2 preserves frozen sibling mapping (mixed umbrella ${mixed})`, async () => {
    const fx = makeNativeFixture({ slug: `x22a-sibling-${mixed}` });
    const sibling = path.join(fx.MAIN, 'sibling');
    // Same initial base as the umbrella, so both frozen artifacts have a real
    // base commit without inventing a synthetic review carrier.
    execFileSync('git', ['clone', '-q', fx.MAIN, sibling], { stdio: 'pipe' });
    git(sibling, 'config', 'user.email', 'test@test');
    git(sibling, 'config', 'user.name', 'test');
    git(sibling, 'config', 'commit.gpgsign', 'false');
    fs.appendFileSync(path.join(fx.MAIN, '.git', 'info', 'exclude'), '\nsibling/\n');
    const state = readState(fx.statePath);
    state.tasks[0].files = ['sibling/src/a.txt'];
    if (mixed) state.tasks.push({ id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] });
    writeState(fx.statePath, state);
    write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks: state.tasks.map((t) => planEntry(t.id, 1, t.files)) }));
    launchNative(fx);
    await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
    const siblingWT = path.join(sibling, '.worktrees', state.slug);
    const frozen = readWaveDispatchRecord(fx.bundleDir, 1).review_context;
    assert.equal(frozen.tasks[0].repo, siblingWT);
    write(siblingWT, 'src/a.txt', 'REVIEWED SIBLING\n');
    if (mixed) write(fx.WT, 'src/b.txt', 'REVIEWED UMBRELLA\n');
    const result = { wave: 1, tasks: state.tasks.map((t) => ({ task_id: t.id, digest: workerDigest(t.id) })) };
    const manifest = await reviewNativeResult({ statePath: fx.statePath, self: fx.self,
      result, policy: dispatchFixture, now: 2300 });
    const { reviewCompletedTasks } = await import('../lib/task-review.mjs');
    const tasks = await reviewCompletedTasks({ statePath: fx.statePath, runId: state.slug, wave: 1,
      items: manifest.tasks, now: 2400,
      callReview: async (args) => ({ ...x22Approval, episode_subject: args.subject, intent_identity: args.intent_identity }) });
    const beforeUmbrella = git(fx.WT, 'rev-parse', 'HEAD');
    const beforeSibling = git(siblingWT, 'rev-parse', 'HEAD');
    const out = recordWaveResult({ statePath: fx.statePath, self: fx.self, worktree: fx.WT,
      result: { ...result, tasks }, now: 2600 });
    assert.equal(out.cleared, true);
    assert.equal(out.scope.ok, true);
    assert.equal(out.commits.code_by_repo[siblingWT], git(siblingWT, 'rev-parse', 'HEAD'));
    if (mixed) assert.equal(out.commits.code_by_repo[fx.WT], git(fx.WT, 'rev-parse', 'HEAD'));
    assert.equal(Object.keys(out.commits.code_by_repo).length, mixed ? 2 : 1);
    assert.notEqual(git(siblingWT, 'rev-parse', 'HEAD'), beforeSibling);
    assert.equal(git(siblingWT, 'show', 'HEAD:src/a.txt'), 'REVIEWED SIBLING');
    assert.equal(git(siblingWT, 'status', '--porcelain'), '');
    if (mixed) {
      assert.notEqual(git(fx.WT, 'rev-parse', 'HEAD'), beforeUmbrella);
      assert.equal(git(fx.WT, 'show', 'HEAD:src/b.txt'), 'REVIEWED UMBRELLA');
    } else assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), beforeUmbrella);
    assert.equal(git(fx.WT, 'status', '--porcelain'), '');
  });
}

test('X22a F2 accepts a physical alias of the frozen worktree', async () => {
  const fx = await x22R4ReviewedFixture('x22a-locus-alias');
  const alias = path.join(fx.tmp, 'worktree-alias');
  fs.symlinkSync(fx.WT, alias, 'dir');
  const out = recordWaveResult({ statePath: fx.statePath, self: fx.self,
    worktree: alias, result: fx.reviewed, now: 2600 });
  assert.equal(out.cleared, true);
  assert.equal(git(fx.WT, 'show', 'HEAD:src/a.txt'), 'change');
});

// Judge-8 exact reproduction: both edits precede task 1's genuine approval.
// No task is durably done; task 2 still needs a descriptor or a supplied receipt.
for (const restart of [false, true]) {
  for (const phaseB of [false, true]) {
    test(`J8 mixed batch restart=${restart} phaseB=${phaseB}`, async () => {
      const fx = makeNativeFixture({ slug: `j8-mixed-${restart}-${phaseB}` });
      const state = readState(fx.statePath);
      state.tasks.push({ id: 2, status: 'pending', wave: 1, files: ['src/b.txt'] });
      writeState(fx.statePath, state);
      write(fx.bundleDir, 'plan.index.json', JSON.stringify({
        tasks: state.tasks.map((t) => planEntry(t.id, 1, t.files)),
      }));
      launchNative(fx);
      await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
      if (restart) {
        const record = readWaveDispatchRecord(fx.bundleDir, 1);
        for (const id of [1, 2]) record.review_context.episodes[String(id)] = { hold: 'historical' };
        writeWaveDispatchRecord(fx.bundleDir, 1, record);
        for (const taskId of [1, 2]) disposeReviewEpisode({ statePath: fx.statePath,
          wave: 1, taskId, self: fx.self, now: 2200, disposition: 'restart' });
      }
      write(fx.WT, 'src/a.txt', 'reviewed a\n');
      write(fx.WT, 'src/b.txt', 'review b\n');
      const result = { wave: 1, tasks: state.tasks.map((t) => ({ task_id: t.id, digest: workerDigest(t.id) })) };
      const opts = { statePath: fx.statePath, self: fx.self, now: 2300, result, policy: dispatchFixture };
      const manifest = await reviewNativeResult(opts);
      const { reviewCompletedTasks } = await import('../lib/task-review.mjs');
      const approve = (args) => ({ ...x22Approval, episode_subject: args.subject, intent_identity: args.intent_identity });
      const reviewed = await reviewCompletedTasks({ statePath: fx.statePath, runId: state.slug,
        wave: 1, items: [manifest.tasks[0]], now: 2400, callReview: async (args) => approve(args) });
      let receipt;
      if (phaseB) await reviewCompletedTasks({ statePath: fx.statePath, runId: state.slug,
        wave: 1, items: [manifest.tasks[1]], now: 2401,
        callReview: async (args) => (receipt = approve(args)), onEvent: () => {} });
      const mixed = { ...result, tasks: [reviewed[0], result.tasks[1]] };
      const original = JSON.stringify(mixed);
      const ingest = () => reviewNativeResult({ ...opts, result: mixed, now: 2500,
        ...(phaseB ? { providedReviews: { 2: receipt } } : {}) });

      // Narrowing ingestion must not refresh stale embedded evidence, including
      // when drift is in the OTHER task's file in the same physical artifact.
      write(fx.WT, 'src/b.txt', 'UNREVIEWED drift\n');
      const stale = x22aSnapshot(fx);
      await assert.rejects(ingest, /artifact.*mismatch|fresh review/i);
      assert.deepEqual(x22aSnapshot(fx), stale, 'stale mixed refusal precedes heartbeat');
      write(fx.WT, 'src/b.txt', 'review b\n');
      const before = x22aSnapshot(fx);
      const out = await ingest();
      assert.equal(out.review_outcome, phaseB ? 'native-reviews-recorded' : 'native-review-pending');
      assert.equal(JSON.stringify(mixed), original, 'never relabel the submitted evidence');
      assert.deepEqual(out.tasks[0], reviewed[0], 'retain the original embedded carrier and judgment');
      assert.deepEqual(readState(fx.statePath).tasks.map((t) => t.status), ['pending', 'pending']);
      console.log('J8 MIXED', JSON.stringify({ restart, phaseB, outcome: out.review_outcome,
        pending: out.pending_reviews?.map((d) => d.task_id), verdicts: out.tasks.map((t) => t.review?.verdict) }));
      if (phaseB) {
        assert.deepEqual(out.tasks.map((t) => t.review.verdict), ['approve', 'approve']);
        const recorded = recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2600,
          worktree: fx.WT, result: out });
        assert.equal(recorded.cleared, true, 'complete batch passes final authorization');
        assert.deepEqual(recorded.blocking_reviews, []);
      } else {
        assert.deepEqual(out.pending_reviews.map((d) => d.task_id), [2]);
        assert.deepEqual(out.tasks[1].review_input, manifest.tasks[1].review_input);
        assert.equal(x22Events(fx), before.events, 'Phase A does not append a review');
        const partial = x22aSnapshot(fx);
        assert.throws(() => recordWaveResult({ statePath: fx.statePath, self: fx.self, now: 2600,
          worktree: fx.WT, result: mixed }), /artifact.*mismatch|episode subject mismatch|fresh review/i);
        assert.deepEqual(x22aSnapshot(fx), partial, 'final gate still refuses incomplete batch before writes');
      }
    });
  }
}

// Cross-attempt regression: use the CLI recorder so the real attempt finalizer runs.
function crossAttemptRecord(fx, result, reviews = null, extraArgs = []) {
  const scratch = path.join(fx.tmp, '.recorder-inputs');
  const resultFile = path.join(scratch, 'result.json');
  write(scratch, 'result.json', JSON.stringify(result));
  const args = ['record-result', `--state=${fx.statePath}`, `--result-file=${resultFile}`, '--now=3000', ...extraArgs];
  if (reviews) {
    write(scratch, 'reviews.json', JSON.stringify(reviews));
    args.push(`--reviews-file=${path.join(scratch, 'reviews.json')}`);
  }
  return JSON.parse(execFileSync(process.execPath,
    [new URL('../bin/masterplan.mjs', import.meta.url).pathname, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

function wave23Fixture() {
  const wave = 23;
  const tasks = [67, 68, 93].map((id, i) => ({
    id, wave, status: 'pending',
    files: Array.from({ length: i === 2 ? 4 : 3 }, (_, n) => `src/task-${id}-${n}.txt`),
  }));
  const fx = makeNativeFixture({ slug: 'wave-23', extra: { tasks, concurrency: { owner_lock: 'off' } } });
  write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks: tasks.map((t) => planEntry(t.id, wave, t.files)) }));
  launchNative(fx);
  const dispatch = JSON.parse(execFileSync(process.execPath,
    [new URL('../bin/masterplan.mjs', import.meta.url).pathname, 'dispatch-wave',
      `--state=${fx.statePath}`, '--now=2000'], {
      cwd: fx.WT, encoding: 'utf8', env: { ...process.env,
        MP_DISPATCH_MAP: new URL('./fixtures/dispatch-map.json', import.meta.url).pathname },
    }));
  assert.equal(dispatch.outcome, 'native-spawn-plan');
  const recordPath = path.join(fx.bundleDir, 'wave-23.dispatch.json');
  const frozen = dispatch.record.review_context.base_sha;
  const bundleRel = path.relative(fx.MAIN, fx.bundleDir);
  git(fx.MAIN, 'add', '--', `${bundleRel}/state.yml`);
  git(fx.MAIN, 'commit', '-qm', 'persist launch state');
  git(fx.MAIN, 'add', '--', `${bundleRel}/.wave-23.watch.json`, `${bundleRel}/wave-23.dispatch.json`);
  git(fx.MAIN, 'commit', '-qm', 'persist dispatch and watch');
  const head = git(fx.MAIN, 'rev-parse', 'HEAD');
  git(fx.WT, 'merge', '--ff-only', head);
  assert.notEqual(head, frozen);
  assert.deepEqual(git(fx.WT, 'diff', '--name-only', frozen, head).split('\n').sort(),
    ['.wave-23.watch.json', 'state.yml', 'wave-23.dispatch.json'].map((file) => `${bundleRel}/${file}`).sort());
  for (const task of tasks) for (const file of task.files) write(fx.WT, file, `reviewed ${file}\n`);
  const result = { wave, tasks: tasks.map(({ id, files }) => ({
    task_id: id, digest: { ...workerDigest(id), start_sha: frozen, files_changed: files },
  })) };
  const snapshot = () => ({ events: x22Events(fx), state: fs.readFileSync(fx.statePath, 'utf8'),
    dispatch: fs.readFileSync(recordPath, 'utf8') });
  const start = () => {
    const phaseA = crossAttemptRecord(fx, result);
    assert.equal(phaseA.op, 'run_native_reviews');
    assert.deepEqual(phaseA.pending_reviews.map((r) => r.task_id), tasks.map((t) => t.id));
    return Object.fromEntries(phaseA.pending_reviews.map(({ task_id, diff_sha }) =>
      [task_id, { ...x22Approval, diff_sha }]));
  };
  return { fx, tasks, result, snapshot, start, frozen, head };
}

test('wave 23 CLI: bundle-only fast-forward still records all ten reviewed files', () => {
  const { fx, tasks, result, start, head, frozen } = wave23Fixture();
  const reviews = start();
  const shaAt = (base) => createHash('sha256').update(captureFullWorkingDiff(fx.WT, undefined, base)).digest('hex');
  assert.equal(reviews[67].diff_sha, shaAt(frozen));
  assert.notEqual(reviews[67].diff_sha, shaAt(head), 'the archived controller used this different HEAD-based digest');
  // The incident's existing host can omit diff_sha when the pinned artifact is unchanged.
  const out = crossAttemptRecord(fx, result, Object.fromEntries(tasks.map(({ id }) => [id, x22Approval])));
  assert.deepEqual(out.recorded, [67, 68, 93]);
  assert.deepEqual(out.blocking_reviews, []);
  assert.equal(out.cleared, true);
  assert.deepEqual(git(fx.WT, 'diff', '--name-only', head, 'HEAD').split('\n').sort(),
    tasks.flatMap((task) => task.files).sort());
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 23).status, 'recorded');
  const reviewEvents = x22Events(fx).trim().split('\n').map(JSON.parse)
    .filter((event) => event.type === 'task_adversary_review');
  assert.deepEqual(reviewEvents.map(({ data }) => [data.task, data.sha]),
    tasks.map(({ id }) => [id, reviews[id].diff_sha]));
});

test('wave 23 CLI: an edited task file requires fresh review without changing the bundle', () => {
  const { fx, tasks, result, snapshot, start } = wave23Fixture();
  const reviews = start();
  const unbound = Object.fromEntries(tasks.map(({ id }) => [id, x22Approval]));
  write(fx.WT, tasks[0].files[0], 'not the reviewed bytes\n');
  const before = snapshot();
  for (const stale of [reviews, unbound]) {
    assert.throws(() => crossAttemptRecord(fx, result, stale), /fresh review required/);
    assert.deepEqual(snapshot(), before);
  }
  const refreshed = start();
  assert.notEqual(refreshed[67].diff_sha, reviews[67].diff_sha);
  assert.throws(() => crossAttemptRecord(fx, result, unbound), /fresh review required/,
    'requesting a fresh review must not relabel a legacy receipt for the original bytes');
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(crossAttemptRecord(fx, result, refreshed).recorded, [67, 68, 93]);
});

test('wave 23 CLI: stale epoch refuses without appending any review or changing the bundle', () => {
  const { fx, result, snapshot } = wave23Fixture();
  const state = readState(fx.statePath);
  writeState(fx.statePath, { ...state, active_run: { ...state.active_run, epoch: 2 } });
  const current = { ...result, epoch: 2 };
  const phaseA = crossAttemptRecord(fx, current);
  assert.equal(phaseA.op, 'run_native_reviews');
  const reviews = Object.fromEntries(phaseA.pending_reviews.map(({ task_id, diff_sha }) =>
    [task_id, { ...x22Approval, diff_sha }]));
  const stale = { ...current, epoch: 1 };
  const before = snapshot();
  const outcome = crossAttemptRecord(fx, stale, reviews);
  assert.equal(outcome.outcome, 'stale-epoch');
  const after = snapshot();
  assert.equal(after.events.length, before.events.length, 'refused recording changed events.jsonl');
  assert.deepEqual(after, before);
  assert.equal(crossAttemptRecord(fx, stale).outcome, 'stale-epoch', 'Phase A must refuse before requesting reviews');
  assert.deepEqual(snapshot(), before);
});

test('wave 23 CLI: a late locus refusal leaves all three bundle files unchanged', () => {
  const { fx, result, start, snapshot } = wave23Fixture();
  const reviews = start();
  const alias = path.join(fx.tmp, 'different-checkout');
  git(fx.MAIN, 'worktree', 'add', '-q', '--detach', alias, 'HEAD');
  const before = snapshot();
  assert.throws(() => crossAttemptRecord(fx, result, reviews, [`--worktree=${alias}`]), /mutation locus mismatch/);
  assert.deepEqual(snapshot(), before, 'refused recording changed the bundle');
});

test('wave 23 CLI: a second bundle advance between phases refuses with recovery guidance', () => {
  const { fx, result, snapshot, start, frozen } = wave23Fixture();
  const reviews = start();
  const rel = path.relative(fx.MAIN, path.join(fx.bundleDir, 'wave-23.dispatch.json'));
  git(fx.MAIN, 'add', '--', rel);
  git(fx.MAIN, 'commit', '-qm', 'persist issued review hashes');
  const head = git(fx.MAIN, 'rev-parse', 'HEAD');
  git(fx.WT, 'merge', '--ff-only', head);
  const before = snapshot();
  assert.throws(() => crossAttemptRecord(fx, result, reviews), (err) => {
    const message = String(err.stderr);
    assert.ok(message.includes(head) && message.includes(frozen), message);
    assert.match(message, /preserve.*recovery/i);
    assert.doesNotMatch(message, /fresh review required/);
    return true;
  });
  assert.deepEqual(snapshot(), before);
});

test('wave 23 CLI: alternate history with a different tree refuses before requesting reviews', () => {
  const { fx, result, snapshot, frozen } = wave23Fixture();
  git(fx.WT, 'add', '--', 'src/task-67-0.txt');
  const head = git(fx.WT, 'commit-tree', git(fx.WT, 'write-tree'), '-m', 'unrelated history');
  git(fx.WT, 'reset', '--soft', head);
  const before = snapshot();
  assert.throws(() => crossAttemptRecord(fx, result), (err) => {
    const message = String(err.stderr);
    assert.ok(message.includes(head) && message.includes(frozen), message);
    assert.match(message, /preserve.*recovery/i);
    return true;
  });
  assert.deepEqual(snapshot(), before);
});

for (const [mixed, direct] of [[false, false], [true, false], [true, true]]) {
  const route = direct ? 'direct redispatch' : 'continue';
  test(`review rework: ${mixed ? 'mixed wave' : 'all blocked'} preserves work through ${route} and re-review`, async () => {
    const tasks = [
      ...(mixed ? [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }] : []),
      { id: 2, status: 'pending', wave: 1, files: ['src/seed.txt', 'src/b.txt'] },
    ];
    const slug = 'review-rework';
    const fx = makeNativeFixture({ slug, extra: { tasks, concurrency: { owner_lock: 'off' } } });
    write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks: tasks.map((t) => planEntry(t.id, 1, t.files)) }));
    const wt = worktreePathFor(fx.MAIN, slug);
    git(fx.MAIN, 'worktree', 'add', '-qb', worktreeBranchFor(slug), wt);
    write(wt, 'baseline.txt', 'staged before wave 1\n');
    git(wt, 'add', '--', 'baseline.txt');
    launchNative(fx);
    assert.deepEqual(readState(fx.statePath).active_run.baseline, ['baseline.txt']);
    await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
    const base = git(fx.WT, 'rev-parse', 'HEAD');
    if (mixed) write(fx.WT, 'src/a.txt', 'approved A\n');
    write(fx.WT, 'src/seed.txt', 'B tracked work\n');
    write(fx.WT, 'src/b.txt', 'B untracked work\n');
    git(fx.WT, 'add', '--', 'src/seed.txt');
    const result = { wave: 1, tasks: tasks.map(({ id }) => ({ task_id: id, digest: workerDigest(id) })) };
    const phaseA = crossAttemptRecord(fx, result);
    assert.equal(phaseA.op, 'run_native_reviews');
    assert.deepEqual(phaseA.pending_reviews.map((r) => r.task_id), tasks.map((t) => t.id));
    const first = crossAttemptRecord(fx, result, {
      ...(mixed ? { 1: x22Approval } : {}), 2: { ...rejectRecord, final_verdict: 'rework' },
    });
    assert.deepEqual(first.recorded, mixed ? [1] : []);
    assert.deepEqual(first.blocking_reviews.map(({ id, verdict }) => [id, verdict]), [[2, 'rework']]);
    assert.deepEqual(first.next.tasks.map((t) => t.id), [2]);
    assert.deepEqual(readState(fx.statePath).tasks.map((t) => t.status), mixed ? ['done', 'pending'] : ['pending']);
    const afterFirst = git(fx.WT, 'rev-parse', 'HEAD');
    assert.equal(git(fx.WT, 'diff', '--name-only', base, 'HEAD'), mixed ? 'src/a.txt' : '');
    assert.deepEqual(first.commits.code_by_repo, mixed ? { [fx.WT]: afterFirst } : {});
    const priorEvents = x22Events(fx);
    const readB = (p) => fs.readFileSync(path.join(fx.WT, p), 'utf8');
    write(fx.WT, 'user.txt', 'unrelated work between attempts\n');
    if (mixed) {
      write(fx.WT, 'src/a.txt', 'operator staged A\n');
      git(fx.WT, 'add', '--', 'src/a.txt');
      write(fx.WT, 'src/a.txt', 'operator unstaged A\n');
    }
    if (!direct) {
      const next = continueRun({ statePath: fx.statePath, self: fx.self, now: 3100, policy: dispatchFixture });
      assert.equal(next.op, 'dispatch_fabric');
    }
    assert.equal(readB('src/seed.txt'), 'B tracked work\n');
    assert.equal(readB('src/b.txt'), 'B untracked work\n');
    assert.equal(git(fx.WT, 'show', ':src/seed.txt'), 'B tracked work', 'preserve the index as well');
    const second = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 3200, policy: dispatchFixture });
    assert.equal(second.outcome, 'native-spawn-plan');
    assert.equal(second.record.attempt, 2);
    assert.deepEqual(second.record.tasks.map((t) => t.task_id), [2]);
    assert.deepEqual(second.record.history[0].record_outcome.recorded, mixed ? [1] : []);
    write(fx.WT, 'src/seed.txt', 'B fixes the review finding\n');
    const retry = { wave: 1, tasks: [result.tasks.at(-1)] };
    const fresh = crossAttemptRecord(fx, retry);
    assert.equal(fresh.op, 'run_native_reviews');
    assert.deepEqual(fresh.pending_reviews.map((r) => r.task_id), [2]);
    assert.notEqual(fresh.pending_reviews[0].diff_sha, phaseA.pending_reviews.at(-1).diff_sha);
    const final = crossAttemptRecord(fx, retry, { 2: x22Approval });
    assert.deepEqual(final.recorded, [2]);
    assert.deepEqual(final.blocking_reviews, []);
    assert.equal(final.cleared, true);
    assert.equal(final.next.action, 'complete');
    assert.equal(git(fx.WT, 'rev-parse', 'HEAD^'), afterFirst);
    assert.equal(git(fx.WT, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'src/b.txt\nsrc/seed.txt');
    assert.equal(git(fx.WT, 'status', '--porcelain'),
      `A  baseline.txt\n${mixed ? 'MM src/a.txt\n' : ''}?? user.txt`);
    assert.equal(git(fx.WT, 'show', ':baseline.txt'), 'staged before wave 1');
    assert.equal(readB('user.txt'), 'unrelated work between attempts\n');
    if (mixed) {
      assert.equal(git(fx.WT, 'show', 'HEAD:src/a.txt'), 'approved A');
      assert.equal(git(fx.WT, 'show', ':src/a.txt'), 'operator staged A');
      assert.equal(readB('src/a.txt'), 'operator unstaged A\n');
    }
    assert.ok(x22Events(fx).startsWith(priorEvents), 'retain prior receipts verbatim');
  });
}

test('cross-attempt: all-done staging excludes the earlier task even with review off', async () => {
  const tasks = [1, 2].map((id) => ({ id, status: 'pending', wave: 1, files: [`src/${id}.txt`] }));
  const fx = makeNativeFixture({ review: { adversary: false }, extra: { tasks, concurrency: { owner_lock: 'off' } } });
  write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks: tasks.map((t) => planEntry(t.id, 1, t.files)) }));
  const dispatch = () => dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  launchNative(fx);
  assert.equal((await dispatch()).outcome, 'native-spawn-plan');
  write(fx.WT, 'src/1.txt', 'A complete\n');
  const result = (digest) => ({ task_id: digest.task_id, digest });
  const first = crossAttemptRecord(fx, { wave: 1, tasks: [result(workerDigest(1)), result(workerDigest(2, 'blocked'))] });
  assert.deepEqual(first.recorded, [1]);
  assert.equal((await dispatch()).record.attempt, 2);
  // This edit is newer than all baseline captures, so baseline subtraction
  // alone cannot protect it. Only the retry's task set limits staging here.
  write(fx.WT, 'src/1.txt', 'operator staged A\n');
  git(fx.WT, 'add', '--', 'src/1.txt');
  write(fx.WT, 'src/1.txt', 'operator unstaged A\n');
  write(fx.WT, 'src/2.txt', 'B complete\n');
  const final = crossAttemptRecord(fx, { wave: 1, tasks: [result(workerDigest(2))] });
  assert.equal(final.cleared, true);
  assert.equal(git(fx.WT, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'src/2.txt');
  assert.equal(git(fx.WT, 'show', ':src/1.txt'), 'operator staged A');
  assert.equal(fs.readFileSync(path.join(fx.WT, 'src/1.txt'), 'utf8'), 'operator unstaged A\n');
});

async function interruptedRetryFixture({ shared = false } = {}) {
  const tasks = [1, 2].map((id) => ({ id, status: 'pending', wave: 1, files: [`src/${id}.txt`] }));
  const fx = makeNativeFixture({ review: { adversary: false }, extra: { tasks, concurrency: { owner_lock: 'off' } } });
  const index = path.join(fx.bundleDir, 'plan.index.json');
  const writePlan = (bFiles) => write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks: [
    planEntry(1, 1, tasks[0].files), planEntry(2, 1, bFiles),
  ] }));
  fx.amendB = (files) => {
    writePlan(files);
    execFileSync(process.execPath, [new URL('../bin/masterplan.mjs', import.meta.url).pathname,
      'amend-tasks', `--state=${fx.statePath}`, `--plan-index=${index}`]);
  };
  const slug = readState(fx.statePath).slug;
  const wt = worktreePathFor(fx.MAIN, slug);
  git(fx.MAIN, 'worktree', 'add', '-qb', worktreeBranchFor(slug), wt);
  write(wt, 'baseline.txt', 'staged before the wave\n');
  git(wt, 'add', '--', 'baseline.txt');
  writePlan(tasks[1].files);
  launchNative(fx);
  fx.dispatch = () => dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 3200, policy: dispatchFixture });
  assert.equal((await fx.dispatch()).outcome, 'native-spawn-plan');
  write(fx.WT, 'src/1.txt', 'accepted A\n');
  const result = (id, status) => ({ task_id: id, digest: workerDigest(id, status) });
  assert.deepEqual(crossAttemptRecord(fx, { wave: 1, tasks: [result(1), result(2, 'blocked')] }).recorded, [1]);
  if (shared) fx.amendB(['src/']);
  write(fx.WT, 'unrelated.txt', 'unrelated untracked work\n');
  fx.launch = readState(fx.statePath).active_run;
  fx.aCommit = git(fx.WT, 'rev-parse', 'HEAD');
  const retry = await fx.dispatch();
  assert.equal(retry.outcome, 'native-spawn-plan');
  assert.equal(retry.record.status, 'pending');
  assert.equal(retry.record.attempt, 2);
  assert.deepEqual(retry.record.payload.map((task) => task.files), [shared ? ['src/'] : ['src/2.txt']]);
  assert.ok(retry.record.retry_launch.preserved.some((p) => p.file === 'unrelated.txt' && p.fingerprint));
  assert.ok(retry.record.retry_launch.scope_event_cursor > fx.launch.scope_event_cursor);
  // Simulate the interruption immediately after durable publication, without launching a child.
  write(fx.WT, 'src/1.txt', 'operator staged A\n');
  git(fx.WT, 'add', '--', 'src/1.txt');
  write(fx.WT, 'src/1.txt', 'operator unstaged A\n');
  fx.resume = () => continueRun({ statePath: fx.statePath, self: fx.self, now: 3300 });
  fx.bResult = { wave: 1, tasks: [result(2)] };
  return fx;
}

function interruptedRetrySnapshot(fx) {
  return {
    aCommitted: git(fx.WT, 'show', 'HEAD:src/1.txt'),
    aIndex: git(fx.WT, 'show', ':src/1.txt'),
    aWorking: fs.readFileSync(path.join(fx.WT, 'src/1.txt'), 'utf8'),
    heads: [fx.MAIN, fx.WT].map((repo) => git(repo, 'rev-parse', 'HEAD')),
    status: git(fx.WT, 'status', '--porcelain'),
    bundle: Object.fromEntries(fs.readdirSync(fx.bundleDir).map((file) =>
      [file, fs.readFileSync(path.join(fx.bundleDir, file), 'utf8')])),
  };
}

test('interrupted native retry: continue refuses dirty A beneath B’s directory without touching work', async () => {
  const fx = await interruptedRetryFixture({ shared: true });
  const before = interruptedRetrySnapshot(fx);
  assert.equal(before.aCommitted, 'accepted A');
  assert.equal(before.aIndex, 'operator staged A');
  assert.equal(before.aWorking, 'operator unstaged A\n');
  const op = fx.resume();
  assert.equal(fs.readFileSync(path.join(fx.WT, 'src/1.txt'), 'utf8'), before.aWorking,
    'continue must not checkout A from the index');
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'dispatch-error');
  assert.match(op.error, /src\/1\.txt.*ownership cannot be established/);
  assert.deepEqual(interruptedRetrySnapshot(fx), before);
});

test('interrupted native retry: review-off continue preserves the launch and commits only B', async () => {
  const fx = await interruptedRetryFixture();
  const before = interruptedRetrySnapshot(fx);
  assert.equal(fx.resume().op, 'dispatch_fabric');
  const launch = readState(fx.statePath).active_run;
  const fromDisk = await fx.dispatch();
  assert.equal(fromDisk.outcome, 'reused');
  assert.equal(fromDisk.dispatched, false);
  assert.equal(fromDisk.record.attempt, 2);
  const afterResume = interruptedRetrySnapshot(fx);
  write(fx.WT, 'src/2.txt', 'B complete\n');
  const final = crossAttemptRecord(fx, fx.bResult);
  assert.equal(final.cleared, true, JSON.stringify({ launch, outcome: final.outcome, reason: final.reason,
    ask: final.ask, violations: final.violations }));
  assert.deepEqual(afterResume, before, 'continue must not recapture retry fingerprints or rewrite launch evidence');
  assert.deepEqual(final.recorded, [2]);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD^'), fx.aCommit);
  assert.equal(git(fx.WT, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'src/2.txt');
  assert.equal(git(fx.WT, 'show', ':src/1.txt'), before.aIndex);
  assert.equal(fs.readFileSync(path.join(fx.WT, 'src/1.txt'), 'utf8'), before.aWorking);
  assert.equal(git(fx.WT, 'show', ':baseline.txt'), 'staged before the wave');
  assert.equal(fs.readFileSync(path.join(fx.WT, 'unrelated.txt'), 'utf8'), 'unrelated untracked work\n');
  assert.equal(git(fx.WT, 'status', '--porcelain'), 'A  baseline.txt\nMM src/1.txt\n?? unrelated.txt');
  for (const field of ['scope', 'baseline', 'scope_event_cursor', 'wsBaseline']) {
    assert.deepEqual(launch[field], fx.launch[field], `original launch ${field}`);
  }
});

test('interrupted native retry: continue refuses missing or inconsistent launch proof before resetting B', async () => {
  const fx = await interruptedRetryFixture();
  write(fx.WT, 'src/2.txt', 'B work to preserve on refusal\n');
  const state = readState(fx.statePath);
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  const expectRefusal = (reason) => {
    const before = interruptedRetrySnapshot(fx);
    const op = fx.resume();
    assert.equal(op.ask, 'dispatch-error');
    assert.match(op.error, reason);
    assert.deepEqual(interruptedRetrySnapshot(fx), before);
    assert.equal(fs.readFileSync(path.join(fx.WT, 'src/2.txt'), 'utf8'), 'B work to preserve on refusal\n');
  };
  const withoutProof = { ...record };
  delete withoutProof.retry_launch;
  writeWaveDispatchRecord(fx.bundleDir, 1, withoutProof);
  expectRefusal(/missing published retry launch proof/);
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  writeState(fx.statePath, { ...state, active_run: { ...state.active_run, scope_event_cursor: undefined } });
  expectRefusal(/missing or inconsistent original retry launch scope, baseline, or cursor/);
  writeState(fx.statePath, { ...state, active_run: { ...state.active_run, baseline: [] } });
  expectRefusal(/missing or inconsistent published retry launch proof/);
  writeState(fx.statePath, { ...state, active_run: { ...state.active_run, scope: ['src/2.txt'] } });
  expectRefusal(/current scope does not match the published retry launch/);
});

test('interrupted native retry: continue preserves an audited extension to the published scope', async () => {
  const fx = await interruptedRetryFixture();
  fx.amendB(['src/2.txt', 'src/new.txt']);
  const before = interruptedRetrySnapshot(fx);
  assert.equal(fx.resume().op, 'dispatch_fabric');
  assert.deepEqual(readState(fx.statePath).active_run.scope, [...fx.launch.scope, 'src/new.txt']);
  assert.deepEqual(interruptedRetrySnapshot(fx), before);
});

test('interrupted first native attempt: continue still resets disposable work and dispatch reuses the pending record', async () => {
  const fx = makeNativeFixture({ review: { adversary: false }, extra: { concurrency: { owner_lock: 'off' } } });
  launchNative(fx);
  const dispatch = () => dispatchWaveViaFabric({ statePath: fx.statePath, now: 3200, policy: dispatchFixture });
  const first = await dispatch();
  assert.equal(first.outcome, 'native-spawn-plan');
  assert.equal(first.record.status, 'pending');
  assert.equal(first.record.attempt, 1);
  assert.equal(first.record.retry_launch, undefined);
  write(fx.WT, 'src/a.txt', 'disposable first-attempt residue\n');
  write(fx.WT, 'unrelated.txt', 'unrelated work\n');
  const resume = continueRun({ statePath: fx.statePath, now: 3300 });
  assert.equal(resume.op, 'dispatch_fabric');
  assert.deepEqual(resume.baseline, ['unrelated.txt']);
  assert.equal(fs.existsSync(path.join(fx.WT, 'src/a.txt')), false);
  assert.equal(fs.readFileSync(path.join(fx.WT, 'unrelated.txt'), 'utf8'), 'unrelated work\n');
  const reused = await dispatch();
  assert.equal(reused.outcome, 'reused');
  assert.deepEqual(reused.record, first.record);
});

test('review rework: committed recovery stays pinned and fails closed on a changed MAIN watch baseline', async () => {
  const fx = makeNativeFixture({ slug: 'review-rework-recovery', extra: { concurrency: { owner_lock: 'off' } } });
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  write(fx.WT, 'src/a.txt', 'recovered work\n');
  git(fx.WT, 'add', '--', 'src/a.txt');
  git(fx.WT, 'commit', '-qm', 'recovered work');
  const head = git(fx.WT, 'rev-parse', 'HEAD');
  const selectors = (oid) => [`--recovery-repo=${fx.WT}`, `--recovery-head=${oid}`];
  const result = { wave: 1, tasks: [{ task_id: 1, digest: workerDigest(1) }] };
  const phaseA = crossAttemptRecord(fx, result, null, selectors(head));
  assert.equal(phaseA.recovery, true);
  const { identity } = phaseA.pending_reviews[0];
  const first = crossAttemptRecord(fx, result, { 1: { ...rejectRecord, identity } }, selectors(head));
  assert.equal(first.outcome, 'recorded', JSON.stringify(first));
  assert.deepEqual(first.recorded, []);
  assert.deepEqual(first.commits.code_by_repo, {});
  assert.equal(first.commits.code, head, 'the recovered HEAD is reported for audit only');
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), head);
  assert.equal(git(fx.WT, 'status', '--porcelain'), '');
  const next = continueRun({ statePath: fx.statePath, self: fx.self, now: 3100, policy: dispatchFixture });
  assert.equal(next.ask, 'blocking-reviews');
  assert.match(next.reason, /own MAIN state commit.*cause refusal/);
  assert.equal((await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 3200, policy: dispatchFixture })).dispatched, false);
  assert.throws(() => crossAttemptRecord(fx, result), /committed recovery/i);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), head);
  const priorEvents = x22Events(fx);
  write(fx.WT, 'src/a.txt', 'revised recovered work\n');
  git(fx.WT, 'commit', '-qam', 'address review');
  const revisedHead = git(fx.WT, 'rev-parse', 'HEAD');
  const revised = crossAttemptRecord(fx, result, null, selectors(revisedHead));
  assert.equal(revised.pending_reviews[0].base, phaseA.pending_reviews[0].base);
  assert.notEqual(revised.pending_reviews[0].diff_sha, phaseA.pending_reviews[0].diff_sha);
  assert.throws(() => crossAttemptRecord(fx, result, { 1: { ...x22Approval, identity } }, selectors(revisedHead)), /receipt binding failed/);
  const final = crossAttemptRecord(fx, result, { 1: { ...x22Approval, identity: revised.pending_reviews[0].identity } }, selectors(revisedHead));
  // The first recording committed its state in MAIN. Do not weaken the
  // committed-recovery watch guard to make a subsequent attempt succeed.
  assert.equal(final.outcome, 'recovery-preservation-violation');
  assert.match(final.violations.join('\n'), /watch-list violation .*\(HEAD\): watched repo HEAD moved/);
  assert.equal(readState(fx.statePath).tasks[0].status, 'pending');
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), revisedHead);
  assert.equal(git(fx.WT, 'status', '--porcelain'), '');
  assert.equal(x22Events(fx), priorEvents, 'refused re-review appends no approval');
});

async function crossAttemptFixture({ external = false, shared = false, extraScope = false, committedDrift = false, mixedArtifact = false, reviewPartial = false, wrongParent = false, noEditA = false, workerCommittedA = false, committedScopeOnly = false, beforeFirstRecord = null, beforeRetry = null } = {}) {
  const fx = makeNativeFixture({ slug: 'cross-attempt', extra: {
    concurrency: { owner_lock: 'off' },
    tasks: [1, 2].map((id) => ({ id, status: 'pending', wave: 1, files: [`src/${id}.txt`] })),
  } });
  const state = readState(fx.statePath);
  if (mixedArtifact) state.tasks[0].files.push('src/seed.txt');
  if (external) {
    // A repository beside MAIN, not a directory inside the run worktree.
    const sibling = path.join(fx.tmp, 'sibling');
    execFileSync('git', ['clone', '-q', fx.MAIN, sibling], { stdio: 'pipe' });
    git(sibling, 'config', 'user.email', 'test@test');
    git(sibling, 'config', 'user.name', 'test');
    git(sibling, 'config', 'commit.gpgsign', 'false');
    state.tasks[0].files = state.tasks[0].files.map((f) => path.join(sibling, f));
  }
  writeState(fx.statePath, state);
  write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks: state.tasks.map((t) => planEntry(t.id, 1, t.files)) }));
  launchNative(fx);
  await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 2000, policy: dispatchFixture });
  fx.aRepo = readWaveDispatchRecord(fx.bundleDir, 1).review_context.tasks[0].repo;
  if (wrongParent) {
    // Same tree but disconnected ancestry: the reviewed bytes still match B..C,
    // so only the explicit parent check can prevent adopting this new root.
    const base = git(fx.aRepo, 'rev-parse', 'HEAD');
    const unrelated = git(fx.aRepo, 'commit-tree', base + '^{tree}', '-m', 'unrelated root');
    git(fx.aRepo, 'reset', '--soft', unrelated);
  }
  if (!noEditA) write(fx.aRepo, 'src/1.txt', 'A complete\n');
  if (workerCommittedA) {
    git(fx.aRepo, 'add', '--', 'src/1.txt');
    git(fx.aRepo, 'commit', '-qm', 'worker committed reviewed A');
  }
  fx.acceptedA = git(fx.aRepo, 'rev-parse', 'HEAD');
  if (mixedArtifact) write(fx.aRepo, 'src/seed.txt', 'A tracked modification\n');
  if (reviewPartial) write(fx.WT, 'src/2.txt', 'B partial at A review\n');
  const firstResult = { wave: 1, tasks: [
    { task_id: 1, digest: workerDigest(1) }, { task_id: 2, digest: workerDigest(2, 'blocked') },
  ] };
  const phaseA = crossAttemptRecord(fx, firstResult);
  assert.equal(phaseA.op, 'run_native_reviews');
  assert.deepEqual(phaseA.pending_reviews.map((r) => r.task_id), [1]);
  if (beforeFirstRecord) await beforeFirstRecord(fx, firstResult);
  const first = crossAttemptRecord(fx, firstResult, { 1: x22Approval });
  assert.deepEqual(first.recorded, [1]);
  assert.deepEqual(first.failed.map((r) => r.id), [2]);
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).status, 'recorded');
  fx.aCommit = git(fx.aRepo, 'rev-parse', 'HEAD');
  if (committedDrift) {
    write(fx.aRepo, 'src/1.txt', 'UNREVIEWED committed A drift\n');
    git(fx.aRepo, 'add', '--', 'src/1.txt');
    git(fx.aRepo, 'commit', '-qm', 'unreviewed change before redispatch');
  }
  // Direct redispatch keeps the whole-wave scope from attempt 1. An amendment
  // can add A's file to B now that A is done (only B is routed in attempt 2).
  if (shared || extraScope) {
    const amended = readState(fx.statePath);
    if (shared) amended.tasks[1].files.push(shared === 'directory' ? 'src/' : 'src/1.txt');
    if (extraScope) amended.active_run.scope.push(path.join(fx.tmp, 'sibling/src/unassigned.txt'));
    writeState(fx.statePath, amended);
    write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks: amended.tasks.map((t) => planEntry(t.id, 1, t.files)) }));
  }
  if (committedScopeOnly) {
    write(fx.WT, 'scope-only.txt', 'trusted boundary bytes\n');
    git(fx.WT, 'add', '--', 'scope-only.txt');
    git(fx.WT, 'commit', '-qm', 'scope-only before frozen base');
    const amended = readState(fx.statePath);
    amended.tasks[1].files = ['src/'];
    amended.active_run.scope.push('scope-only.txt');
    writeState(fx.statePath, amended);
    write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks: amended.tasks.map((t) => planEntry(t.id, 1, t.files)) }));
  }
  if ((await beforeRetry?.(fx)) === false) return fx;
  const second = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 3000, policy: dispatchFixture });
  assert.equal(second.outcome, 'native-spawn-plan');
  assert.equal(second.record.attempt, 2);
  assert.deepEqual(second.record.tasks.map((t) => t.task_id), [2]);
  assert.deepEqual(Object.keys(second.record.review_context.episodes), ['2']);
  write(fx.WT, 'src/2.txt', 'B complete\n');
  fx.secondResult = { wave: 1, tasks: [{ task_id: 2, digest: workerDigest(2) }] };
  return fx;
}

test('cross-attempt: phase B retry records only B and completion retains A', async () => {
  const fx = await crossAttemptFixture();
  const phaseA = crossAttemptRecord(fx, fx.secondResult);
  assert.equal(phaseA.op, 'run_native_reviews');
  assert.deepEqual(phaseA.pending_reviews.map((r) => r.task_id), [2]);
  // Force a Phase B authorization refusal after native projection, then
  // restore the historical entry. The blocked recording must not leave B's event.
  const saved = readWaveDispatchRecord(fx.bundleDir, 1);
  const damaged = structuredClone(saved);
  delete damaged.history[0].review_context.episodes['1'];
  writeWaveDispatchRecord(fx.bundleDir, 1, damaged);
  const beforeState = fs.readFileSync(fx.statePath, 'utf8');
  const beforeEvents = x22Events(fx);
  assert.throws(() => crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval }), (err) => {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /task 1: no identifiable entry in active-episode receipt/);
    return true;
  });
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), beforeState);
  assert.equal(x22Events(fx), beforeEvents);
  writeWaveDispatchRecord(fx.bundleDir, 1, saved);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.aCommit);
  assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).status, 'pending');
  const second = crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval });
  assert.deepEqual(second.recorded, [2]);
  assert.equal(second.cleared, true);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD^'), fx.aCommit);
  assert.equal(git(fx.WT, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'src/2.txt');
  assert.equal(git(fx.WT, 'log', '-1', '--format=%H', '--', 'src/1.txt'), fx.aCommit);
  assert.equal(fs.readFileSync(path.join(fx.WT, 'src/1.txt'), 'utf8'), 'A complete\n');
  assert.equal(x22Events(fx).split('\n').filter(Boolean).map(JSON.parse)
    .filter((e) => e.type === 'task_adversary_review').length, 2, 'retry never duplicates B review');
  const state = readState(fx.statePath);
  assert.equal(taskEpisodeEligibleForCompletion(fx.statePath, state, state.tasks[0]), true);
  const next = continueRun({ statePath: fx.statePath, self: fx.self, now: 4000, policy: dispatchFixture });
  assert.equal(next.op, 'run_skill');
  assert.equal(next.skill, 'finish');
  assert.equal(git(fx.WT, 'rev-list', '--count', `${fx.aCommit}..HEAD`), '1', 'no duplicate code commit');
});

// Expectations come from the episodes: A's old approval cannot authorize new
// bytes outside B's declarations, even if B's full same-repo diff includes them.
for (const external of [false, true]) {
  for (const drift of ['working tree', 'index only', 'index masked by working tree']) {
    test(`cross-attempt: changed A refuses phase B (${external ? 'external sibling' : 'run repo'}, ${drift})`, async () => {
      const fx = await crossAttemptFixture({ external });
      const beforeRun = git(fx.WT, 'rev-parse', 'HEAD');
      const beforeMain = git(fx.MAIN, 'rev-parse', 'HEAD');
      write(fx.aRepo, 'src/1.txt', 'UNREVIEWED A drift\n');
      if (drift !== 'working tree') git(fx.aRepo, 'add', '--', 'src/1.txt');
      if (drift === 'index masked by working tree') write(fx.aRepo, 'src/1.txt', 'A complete\n');
      const beforeStatus = git(fx.aRepo, 'status', '--porcelain');
      const beforeState = fs.readFileSync(fx.statePath, 'utf8');
      const phaseA = crossAttemptRecord(fx, fx.secondResult);
      assert.equal(phaseA.op, 'run_native_reviews');
      assert.deepEqual(phaseA.pending_reviews.map((r) => r.task_id), [2]);
      assert.throws(() => crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval }), (err) => {
        assert.equal(err.status, 2);
        assert.match(String(err.stderr), /review episode task 1:.*src\/1\.txt.*fresh review of (this|that) task's episode is required/);
        return true;
      });
      assert.equal(git(fx.aRepo, 'rev-parse', 'HEAD'), fx.aCommit, 'A commit is untouched');
      assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), beforeRun, 'no run commit');
      assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD'), beforeMain, 'no bundle commit');
      assert.equal(git(fx.aRepo, 'status', '--porcelain'), beforeStatus, 'index/working changes preserved');
      assert.equal(fs.readFileSync(fx.statePath, 'utf8'), beforeState, 'no done marks');
      assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).status, 'pending');
    });
  }
}

for (const external of [true, false]) {
  test(`cross-attempt: committed A drift refuses (${external ? 'external sibling after redispatch' : 'run repo before redispatch'})`, async () => {
    const fx = await crossAttemptFixture({ external, committedDrift: !external });
    if (external) {
      write(fx.aRepo, 'src/1.txt', 'UNREVIEWED committed A drift\n');
      git(fx.aRepo, 'add', '--', 'src/1.txt');
      git(fx.aRepo, 'commit', '-qm', 'unreviewed change after redispatch');
      assert.equal(git(fx.aRepo, 'status', '--porcelain'), '', 'committed sibling drift is clean');
    } else {
      assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).review_context.tasks[0].base_sha,
        git(fx.WT, 'rev-parse', 'HEAD'), 'redispatch froze the drifted tip, not a trusted baseline');
    }
    const beforeRun = git(fx.WT, 'rev-parse', 'HEAD');
    const beforeA = git(fx.aRepo, 'rev-parse', 'HEAD');
    const beforeMain = git(fx.MAIN, 'rev-parse', 'HEAD');
    const beforeStatus = git(fx.aRepo, 'status', '--porcelain');
    assert.equal(crossAttemptRecord(fx, fx.secondResult).op, 'run_native_reviews');
    const beforeState = fs.readFileSync(fx.statePath, 'utf8');
    const beforeRecord = fs.readFileSync(path.join(fx.bundleDir, 'wave-1.dispatch.json'), 'utf8');
    const beforeEvents = x22Events(fx);
    assert.throws(() => crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval }), (err) => {
      assert.equal(err.status, 2);
      assert.match(String(err.stderr), /task 1:.*repository .*src\/1\.txt.*fresh review of this task's episode is required/);
      assert.ok(String(err.stderr).includes(fx.aRepo), 'names the repository locus');
      return true;
    });
    assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), beforeRun);
    assert.equal(git(fx.aRepo, 'rev-parse', 'HEAD'), beforeA);
    assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD'), beforeMain);
    assert.equal(git(fx.aRepo, 'status', '--porcelain'), beforeStatus);
    assert.equal(fs.readFileSync(fx.statePath, 'utf8'), beforeState);
    assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'wave-1.dispatch.json'), 'utf8'), beforeRecord);
    assert.equal(x22Events(fx), beforeEvents, 'refused Phase B appends no events');
  });
}

for (const external of [false, true]) {
  test(`cross-attempt: stored code baseline survives archive (${external ? 'external sibling' : 'run repo'})`, async () => {
    const fx = await crossAttemptFixture({ external });
    const owner = readWaveDispatchRecord(fx.bundleDir, 1).history[0];
    assert.equal(owner.record_outcome.commits.code_by_repo[fx.aRepo], fx.aCommit);
    assert.deepEqual(Object.keys(owner.record_outcome.commits.code_by_repo), [fx.aRepo]);
    const base = owner.review_context.tasks[0].base_sha;
    assert.equal(git(fx.aRepo, 'rev-parse', fx.aCommit + '^'), base);
    assert.equal(crossAttemptRecord(fx, fx.secondResult).op, 'run_native_reviews');
    const out = crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval });
    assert.deepEqual(out.recorded, [2]);
    const record = readWaveDispatchRecord(fx.bundleDir, 1);
    assert.equal(record.history[0].record_outcome.commits.code_by_repo[fx.aRepo], fx.aCommit);
    assert.equal(record.record_outcome.commits.code_by_repo[fx.WT], git(fx.WT, 'rev-parse', 'HEAD'));
  });
}

test('cross-attempt: missing trusted baseline refuses legacy record with actionable message', async () => {
  const fx = await crossAttemptFixture({ external: true });
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  const owner = record.history[0];
  // Same legacy outcome fields as the live example; retain the genuine frozen
  // base, durable review and state commit, but substitute an unreviewed child.
  delete owner.record_outcome.commits;
  // A substituted direct child has one byte beyond the durable review.
  write(fx.aRepo, 'src/1.txt', 'A complete\n!');
  git(fx.aRepo, 'add', '--', 'src/1.txt');
  git(fx.aRepo, 'commit', '--amend', '--no-edit', '-q');
  fx.aCommit = git(fx.aRepo, 'rev-parse', 'HEAD');
  assert.deepEqual(Object.keys(owner.record_outcome).sort(), ['cleared', 'failed', 'recorded']);
  assert.equal(git(fx.aRepo, 'rev-parse', fx.aCommit + '^'), owner.review_context.tasks[0].base_sha);
  assert.ok(x22Events(fx).includes('task_adversary_review'));
  assert.match(git(fx.MAIN, 'log', '-1', '--format=%s'), /wave 1 state/);
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  assert.equal(crossAttemptRecord(fx, fx.secondResult).op, 'run_native_reviews');
  const beforeState = fs.readFileSync(fx.statePath, 'utf8');
  const beforeMain = git(fx.MAIN, 'rev-parse', 'HEAD');
  const beforeRun = git(fx.WT, 'rev-parse', 'HEAD');
  assert.throws(() => crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval }), (err) => {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /task 1:.*repository .*src\/1\.txt.*missing trusted recorded code baseline.*fresh review of this task's episode is required/);
    assert.ok(String(err.stderr).includes(fx.aRepo));
    return true;
  });
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), beforeState);
  assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD'), beforeMain);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), beforeRun);
  assert.equal(git(fx.aRepo, 'rev-parse', 'HEAD'), fx.aCommit);
});

test('cross-attempt: object rebuild equals capture on replay with unusual additions and deletion', () => {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-artifact-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@test');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  // Pin rename detection on, not off: deleted tracked + identical untracked
  // must NOT be paired, unlike an ordinary combined committed diff.
  git(repo, 'config', 'diff.renames', 'true');
  write(repo, 'z modified.txt', 'before\n');
  write(repo, 'deleted.txt', 'identical content for potential rename\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  write(repo, 'z modified.txt', 'after\n');
  fs.unlinkSync(path.join(repo, 'deleted.txt'));
  const additions = ['a new with spaces.txt', 'tab\tname', 'new\nline', 'quote"name',
    'nonascii-é', '[glob].txt', ':(magic).txt'];
  for (const f of additions) write(repo, f, 'addition\n');
  write(repo, 'a renamed.txt', 'identical content for potential rename\n');
  const original = captureFullWorkingDiff(repo, undefined, base);
  assert.ok(original.indexOf('z modified.txt') < original.indexOf('a new with spaces.txt'), 'tracked before additions, not commit order');
  assert.match(original, /deleted file mode/);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'recorded');
  const candidate = git(repo, 'rev-parse', 'HEAD');
  const replay = path.join(tmp, 'replay');
  git(repo, 'worktree', 'add', '-q', '--detach', replay, candidate);
  git(replay, 'reset', '--mixed', '-q', base); // Recreate reviewed layout; additions untracked.
  const replayed = captureFullWorkingDiff(replay, undefined, base);
  assert.equal(replayed, original);
  const indexPath = git(replay, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  const beforeIndex = fs.readFileSync(indexPath);
  const beforeStatus = git(replay, '--no-optional-locks', 'status', '--porcelain=v2', '-z');
  const calls = [];
  const rebuilt = rebuildFullWorkingDiff(replay, base, candidate, (command, args, opts) => {
    calls.push(args);
    assert.equal(command, 'git');
    assert.deepEqual(args.slice(0, 4), ['-C', replay, '-c', 'core.quotePath=false']);
    assert.equal(args[4] === '--literal-pathspecs' ? args[5] : args[4], 'diff', 'object plumbing only');
    return execFileSync(command, args, opts);
  });
  assert.equal(Buffer.compare(Buffer.from(rebuilt), Buffer.from(replayed)), 0, 'same artifact bytes');
  assert.equal(calls.length, additions.length + 4); // classification x2, tracked, each addition (+rename-like).
  assert.deepEqual(fs.readFileSync(indexPath), beforeIndex, 'no index write');
  assert.equal(git(replay, 'rev-parse', 'HEAD'), base, 'no ref write');
  assert.equal(git(replay, '--no-optional-locks', 'status', '--porcelain=v2', '-z'), beforeStatus);
});

// Legacy baselines must be proven from the owning episode's durable artifact,
// not inferred from the new dispatch base or from a clean current checkout.
function makeLegacy(fx) {
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  delete record.history[0].record_outcome.commits;
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  return record;
}
for (const external of [false, true]) {
  test(`cross-attempt: legacy exact artifact records; A unchanged (${external ? 'sibling' : 'run repo'})`, async () => {
    const fx = await crossAttemptFixture({ external, mixedArtifact: true });
    makeLegacy(fx);
    const out = crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval });
    assert.deepEqual(out.recorded, [2]);
    assert.equal(out.cleared, true);
    assert.equal(git(fx.aRepo, 'log', '-1', '--format=%H', '--', 'src/1.txt', 'src/seed.txt'), fx.aCommit);
    assert.equal(fs.readFileSync(path.join(fx.aRepo, 'src/1.txt'), 'utf8'), 'A complete\n');
    assert.equal(fs.readFileSync(path.join(fx.aRepo, 'src/seed.txt'), 'utf8'), 'A tracked modification\n');
  });
}
for (const scenario of ['blocked partial in artifact', 'parent is not frozen base', 'committed drift after C']) {
  test(`cross-attempt: legacy refuses ${scenario}`, async () => {
    const fx = await crossAttemptFixture({ reviewPartial: scenario === 'blocked partial in artifact',
      wrongParent: scenario === 'parent is not frozen base' });
    makeLegacy(fx);
    if (scenario === 'committed drift after C') {
      write(fx.aRepo, 'src/1.txt', 'A unreviewed after C\n');
      git(fx.aRepo, 'add', '--', 'src/1.txt');
      git(fx.aRepo, 'commit', '-qm', 'drift after C');
    }
    const beforeState = fs.readFileSync(fx.statePath, 'utf8');
    const beforeMain = git(fx.MAIN, 'rev-parse', 'HEAD');
    const beforeHead = git(fx.aRepo, 'rev-parse', 'HEAD');
    const beforeStatus = git(fx.aRepo, 'status', '--porcelain');
    assert.throws(() => crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval }), (err) => {
      assert.equal(err.status, 2);
      assert.match(String(err.stderr), scenario === 'committed drift after C'
        ? /task 1:.*changed files src\/1\.txt.*fresh review/
        : /task 1:.*missing trusted recorded code baseline.*fresh review/);
      return true;
    });
    assert.equal(fs.readFileSync(fx.statePath, 'utf8'), beforeState);
    assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD'), beforeMain);
    assert.equal(git(fx.aRepo, 'rev-parse', 'HEAD'), beforeHead);
    assert.equal(git(fx.aRepo, 'status', '--porcelain'), beforeStatus);
  });
}

test('cross-attempt: legacy refuses ambiguous direct children even with a matching preferred base', async () => {
  const fx = await crossAttemptFixture();
  const record = makeLegacy(fx);
  const base = record.history[0].review_context.tasks[0].base_sha;
  assert.equal(record.review_context.tasks[0].base_sha, fx.aCommit);
  const other = git(fx.aRepo, 'commit-tree', base + '^{tree}', '-p', base, '-m', 'other direct child');
  const merged = git(fx.aRepo, 'commit-tree', fx.aCommit + '^{tree}', '-p', fx.aCommit, '-p', other, '-m', 'merge children');
  git(fx.aRepo, 'reset', '--soft', merged);
  assert.throws(() => crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval }), (err) => {
    assert.match(String(err.stderr), /task 1:.*missing trusted recorded code baseline/);
    return true;
  });
  assert.equal(git(fx.aRepo, 'rev-parse', 'HEAD'), merged);
});

test('cross-attempt: legacy refuses declared files outside the owning review repository', async () => {
  const fx = await crossAttemptFixture();
  makeLegacy(fx);
  // Even the exact same objects in another locus do not make it the reviewed repo.
  const other = path.join(fx.tmp, 'other');
  execFileSync('git', ['clone', '-q', '--no-checkout', fx.aRepo, other], { stdio: 'pipe' });
  git(other, 'checkout', '-q', fx.aCommit);
  const state = readState(fx.statePath);
  state.tasks[0].files.push(path.join(other, 'src/1.txt'));
  writeState(fx.statePath, state);
  assert.throws(() => crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval }), (err) => {
    assert.match(String(err.stderr), /task 1:.*missing trusted recorded code baseline/);
    assert.ok(String(err.stderr).includes(other));
    return true;
  });
});

test('cross-attempt: blocked B-only partial edits record and remain uncommitted', async () => {
  const fx = await crossAttemptFixture();
  const result = { wave: 1, tasks: [{ task_id: 2, digest: workerDigest(2, 'blocked') }] };
  write(fx.WT, 'src/2.txt', 'B partial unreviewed\n');
  const out = crossAttemptRecord(fx, result);
  assert.equal(out.outcome, 'recorded');
  assert.deepEqual(out.recorded, []);
  assert.deepEqual(out.failed.map((r) => r.id), [2]);
  assert.equal(out.cleared, false);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.aCommit);
  assert.equal(git(fx.WT, 'diff', '--cached', '--name-only'), '');
  assert.equal(fs.readFileSync(path.join(fx.WT, 'src/2.txt'), 'utf8'), 'B partial unreviewed\n');
  assert.match(git(fx.WT, 'status', '--porcelain'), /src\/2\.txt/);
  assert.equal(readState(fx.statePath).tasks[1].status, 'pending');
  assert.equal(x22Events(fx).split('\n').filter(Boolean).map(JSON.parse)
    .filter((e) => e.type === 'task_adversary_review').length, 1, 'no review fabricated for B');
});

test('cross-attempt: B review covers shared declared file and commits it', async () => {
  const fx = await crossAttemptFixture({ shared: true });
  write(fx.WT, 'src/1.txt', 'A and B shared update\n');
  const phaseA = crossAttemptRecord(fx, fx.secondResult);
  assert.equal(phaseA.op, 'run_native_reviews');
  assert.deepEqual(phaseA.pending_reviews.map((r) => r.task_id), [2]);
  const out = crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval });
  assert.deepEqual(out.recorded, [2]);
  assert.equal(out.cleared, true);
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD^'), fx.aCommit);
  assert.equal(git(fx.WT, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'src/1.txt\nsrc/2.txt');
  assert.equal(git(fx.WT, 'show', 'HEAD:src/1.txt'), 'A and B shared update');
  assert.equal(git(fx.WT, 'status', '--porcelain'), '');
});

test('cross-attempt: an audited retry amendment can authorize new and shared files', async () => {
  const fx = await crossAttemptFixture();
  const state = readState(fx.statePath);
  const index = path.join(fx.bundleDir, 'plan.index.json');
  const added = ['src/1.txt', 'src/new.txt'];
  write(fx.bundleDir, 'plan.index.json', JSON.stringify({ tasks: state.tasks.map((t) =>
    planEntry(t.id, 1, t.id === 2 ? [...t.files, ...added] : t.files)) }));
  execFileSync(process.execPath, [new URL('../bin/masterplan.mjs', import.meta.url).pathname,
    'amend-tasks', `--state=${fx.statePath}`, `--plan-index=${index}`]);
  for (const file of added) write(fx.WT, file, 'B amended work\n');
  assert.equal(crossAttemptRecord(fx, fx.secondResult).op, 'run_native_reviews');
  const out = crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval });
  assert.deepEqual(out.recorded, [2]);
  assert.equal(out.cleared, true);
  assert.equal(git(fx.WT, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'src/1.txt\nsrc/2.txt\nsrc/new.txt');
});

for (const direct of [false, true]) {
  test(`cross-attempt: dirty shared file refuses retry without touching it (${direct ? 'direct' : 'continue'})`, async () => {
    await crossAttemptFixture({ shared: 'directory', beforeRetry: async (fx) => {
      write(fx.WT, 'src/1.txt', 'ambiguous staged work\n');
      git(fx.WT, 'add', '--', 'src/1.txt');
      write(fx.WT, 'src/1.txt', 'ambiguous unstaged work\n');
      if (!direct) assert.equal(continueRun({ statePath: fx.statePath, self: fx.self, now: 3100 }).op, 'dispatch_fabric');
      const attempt = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 3200, policy: dispatchFixture });
      assert.equal(attempt.outcome, 'precheck-failed');
      assert.match(attempt.violations.map((v) => v.reason).join('\n'), /ownership cannot be established/);
      assert.equal(readWaveDispatchRecord(fx.bundleDir, 1).attempt, 1);
      assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.aCommit);
      assert.equal(git(fx.WT, 'show', ':src/1.txt'), 'ambiguous staged work');
      assert.equal(fs.readFileSync(path.join(fx.WT, 'src/1.txt'), 'utf8'), 'ambiguous unstaged work\n');
      return false;
    } });
  });
}

test('cross-attempt: changed index bytes on a preserved A path still refuse recording', async () => {
  const fx = await crossAttemptFixture({ beforeRetry: (fx) => {
    write(fx.WT, 'src/1.txt', 'first index version\n');
    git(fx.WT, 'add', '--', 'src/1.txt');
    write(fx.WT, 'src/1.txt', 'operator working copy\n');
  } });
  write(fx.WT, 'src/1.txt', 'different index version\n');
  git(fx.WT, 'add', '--', 'src/1.txt');
  write(fx.WT, 'src/1.txt', 'operator working copy\n');
  assert.equal(crossAttemptRecord(fx, fx.secondResult).op, 'run_native_reviews');
  assert.throws(() => crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval }), (err) => {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /task 1:.*changed files src\/1\.txt/);
    return true;
  });
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.aCommit);
  assert.equal(git(fx.WT, 'show', ':src/1.txt'), 'different index version');
  assert.equal(fs.readFileSync(path.join(fx.WT, 'src/1.txt'), 'utf8'), 'operator working copy\n');
});

for (const shared of [true, 'directory']) {
  test(`cross-attempt: shared file drift in B frozen base refuses (${shared})`, async () => {
    const fx = await crossAttemptFixture({ shared, committedDrift: true });
    const record = readWaveDispatchRecord(fx.bundleDir, 1);
    const frozen = record.review_context.tasks[0].base_sha;
    assert.notEqual(frozen, fx.aCommit);
    assert.equal(git(fx.WT, 'show', `${frozen}:src/1.txt`), 'UNREVIEWED committed A drift');
    const before = { state: fs.readFileSync(fx.statePath, 'utf8'), head: git(fx.WT, 'rev-parse', 'HEAD') };
    assert.throws(() => crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval }), (err) => {
      assert.match(String(err.stderr), /task 1:.*repository .*src\/1\.txt.*fresh review/);
      return true;
    });
    assert.equal(fs.readFileSync(fx.statePath, 'utf8'), before.state);
    assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), before.head);
  });
}

for (const external of [false, true]) {
  for (const workerCommittedA of [false, true]) {
    test(`cross-attempt: clean A baseline persists (${external ? 'sibling' : 'run repo'}, ${workerCommittedA ? 'worker commit' : 'no edit'})`, async () => {
      const fx = await crossAttemptFixture({ external, noEditA: !workerCommittedA, workerCommittedA });
      const record = readWaveDispatchRecord(fx.bundleDir, 1);
      assert.equal(fx.aCommit, fx.acceptedA, 'recording made no code commit in clean locus');
      assert.deepEqual(record.history[0].record_outcome.commits.code_by_repo, { [fx.aRepo]: fx.acceptedA });
      const ownerBefore = structuredClone(record.history[0].record_outcome);
      const out = crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval });
      assert.deepEqual(out.recorded, [2]);
      assert.equal(out.cleared, true);
      assert.equal(out.commits.code_by_repo[fx.WT], git(fx.WT, 'rev-parse', 'HEAD'));
      assert.equal(out.commits.code_by_repo[fx.aRepo], external ? fx.acceptedA : out.commits.code_by_repo[fx.WT]);
      assert.deepEqual(readWaveDispatchRecord(fx.bundleDir, 1).history[0].record_outcome, ownerBefore,
        'never repair a historical outcome from today HEAD');
    });
  }
}

test('cross-attempt: scope-only boundary refuses uncommitted but accepts pre-base committed bytes', async () => {
  const fx = await crossAttemptFixture({ committedScopeOnly: true });
  const frozen = readWaveDispatchRecord(fx.bundleDir, 1).review_context.tasks[0].base_sha;
  assert.equal(git(fx.WT, 'show', `${frozen}:scope-only.txt`), 'trusted boundary bytes');
  assert.deepEqual(readState(fx.statePath).tasks.map((t) => t.files), [['src/1.txt'], ['src/']]);
  write(fx.WT, 'scope-only.txt', 'uncommitted scope-only bytes\n');
  assert.throws(() => crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval }), (err) => {
    assert.match(String(err.stderr), /in-scope files outside task declarations scope-only\.txt/);
    return true;
  });
  write(fx.WT, 'scope-only.txt', 'trusted boundary bytes\n');
  const out = crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval });
  assert.deepEqual(out.recorded, [2]);
  assert.equal(out.cleared, true);
  assert.equal(git(fx.WT, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'src/2.txt');
  assert.equal(git(fx.WT, 'show', 'HEAD:scope-only.txt'), 'trusted boundary bytes');
});

// Exercise continuity independently of the earlier mutation-locus guard. The
// authorized B artifact is genuine; a later sibling declaration cannot extend it.
function checkEarlierFiles(fx, state, record, reviewIds = new Set(['2'])) {
  const data = x22Events(fx).split('\n').filter(Boolean).map(JSON.parse)
    .find((e) => e.type === 'task_adversary_review' && e.data.task === 1).data;
  return assertEarlierTaskFilesUnchanged(state, record,
    new Map([['1', { owner: record.history[0], data }]]), reviewIds,
    { worktree: fx.WT, mainRoot: fx.MAIN, slug: state.slug });
}
for (const committed of [false, true]) {
  test(`cross-attempt: foreign declaration cannot cover sibling A (${committed ? 'committed' : 'uncommitted'})`, async () => {
    const fx = await crossAttemptFixture({ external: true });
    const reviewed = await reviewNativeResult({ statePath: fx.statePath, self: fx.self,
      result: fx.secondResult, providedReviews: { 2: x22Approval }, policy: dispatchFixture, now: 3000 });
    const state = readState(fx.statePath);
    state.tasks[1].files.push(path.join(fx.tmp, 'sibling/src/1.txt'));
    const record = readWaveDispatchRecord(fx.bundleDir, 1);
    assert.equal(record.review_context.tasks[0].repo, fx.WT);
    assert.notEqual(fx.aRepo, fx.WT);
    assert.doesNotThrow(() => checkEarlierFiles(fx, state, record));
    write(fx.aRepo, 'src/1.txt', 'UNREVIEWED sibling drift\n');
    if (committed) {
      git(fx.aRepo, 'add', '--', 'src/1.txt');
      git(fx.aRepo, 'commit', '-qm', 'foreign declaration is not coverage');
    }
    assert.throws(() => checkEarlierFiles(fx, state, record), (err) => {
      assert.match(err.message, /task 1:.*repository .*src\/1\.txt.*fresh review/);
      assert.ok(err.message.includes(fx.aRepo));
      return true;
    });
    assert.throws(() => authorizeRecording({ statePath: fx.statePath, state, result: reviewed,
      worktree: fx.WT }), /mutation locus mismatch/, 'outer guard stays intact too');
  });
}

test('cross-attempt: every covering frozen base must preserve A, even beneath directories', async () => {
  const fx = await crossAttemptFixture({ shared: 'directory' });
  const state = readState(fx.statePath);
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  // A second review of the same path starts at a later, drifted boundary.
  write(fx.WT, 'src/1.txt', 'drift before second covering base\n');
  git(fx.WT, 'add', '--', 'src/1.txt');
  git(fx.WT, 'commit', '-qm', 'second frozen boundary');
  const laterBase = git(fx.WT, 'rev-parse', 'HEAD');
  state.tasks.push({ id: 3, wave: 1, status: 'pending', files: ['src/1.txt'] });
  record.tasks.push({ task_id: 3 });
  record.review_context.tasks.push({ task_id: 3, repo: fx.WT, base_sha: laterBase });
  // B's own frozen base is clean, but the other covering base is not.
  assert.equal(record.review_context.tasks[0].base_sha, fx.aCommit);
  assert.throws(() => checkEarlierFiles(fx, state, record, new Set(['2', '3'])), /task 1:.*src\/1\.txt.*fresh review/);
});

test('cross-attempt: fully covered declaration still needs its trusted baseline', async () => {
  const fx = await crossAttemptFixture({ shared: true });
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  record.history[0].record_outcome.commits.code_by_repo[fx.aRepo] = null;
  assert.throws(() => checkEarlierFiles(fx, readState(fx.statePath), record),
    /task 1:.*src\/1\.txt.*missing trusted recorded code baseline/);
});

for (const workerCommittedA of [false, true]) {
  test(`cross-attempt: crash re-drive revalidates clean loci (${workerCommittedA ? 'worker commit' : 'no edit'})`, async () => {
    const fx = await crossAttemptFixture({ external: true, noEditA: !workerCommittedA, workerCommittedA,
      beforeFirstRecord: async (firstFx, result) => {
        const hooks = path.join(firstFx.tmp, 'crash-hooks');
        write(hooks, 'pre-commit', '#!/bin/sh\necho injected-state-commit-crash >&2\nexit 1\n');
        fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
        git(firstFx.MAIN, 'config', 'core.hooksPath', hooks);
        assert.throws(() => crossAttemptRecord(firstFx, result, { 1: x22Approval }), (err) => {
          assert.match(String(err.stderr), /injected-state-commit-crash/);
          return true;
        });
        git(firstFx.MAIN, 'config', '--unset', 'core.hooksPath');
        assert.equal(readState(firstFx.statePath).tasks[0].status, 'done', 'leading state write survived');
        const pending = readWaveDispatchRecord(firstFx.bundleDir, 1);
        assert.equal(pending.status, 'pending');
        assert.equal(pending.record_outcome, undefined, 'no outcome or baseline persisted by failed transaction');
        assert.equal(git(firstFx.aRepo, 'rev-parse', 'HEAD'), firstFx.acceptedA);
        const priorBytes = workerCommittedA ? 'A complete\n' : null;
        write(firstFx.aRepo, 'src/1.txt', 'unvalidated bytes after crash\n');
        const before = fs.readFileSync(firstFx.statePath, 'utf8');
        assert.throws(() => recordWaveResult({ statePath: firstFx.statePath, worktree: firstFx.WT,
          self: firstFx.self, now: 3000, result: null }), /artifact episode evidence mismatch/);
        assert.equal(fs.readFileSync(firstFx.statePath, 'utf8'), before);
        assert.deepEqual(readWaveDispatchRecord(firstFx.bundleDir, 1), pending);
        if (priorBytes == null) fs.unlinkSync(path.join(firstFx.aRepo, 'src/1.txt'));
        else write(firstFx.aRepo, 'src/1.txt', priorBytes);
        // The fixture now re-drives the original transaction through the CLI,
        // reusing the original review only after authorization succeeds again.
      },
    });
    const owner = readWaveDispatchRecord(fx.bundleDir, 1).history[0];
    assert.deepEqual(owner.record_outcome.commits.code_by_repo, { [fx.aRepo]: fx.acceptedA });
    assert.equal(x22Events(fx).split('\n').filter(Boolean).map(JSON.parse)
      .filter((e) => e.type === 'task_adversary_review' && e.data.task === 1).length, 1);
    const out = crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval });
    assert.equal(out.cleared, true);
    assert.equal(out.commits.code_by_repo[fx.aRepo], fx.acceptedA);
  });
}

test('review rework: an earlier approval does not commit a blocked retry’s shared edits', async () => {
  const fx = await crossAttemptFixture({ shared: true });
  write(fx.WT, 'src/1.txt', 'B update to a previously approved path\n');
  assert.equal(crossAttemptRecord(fx, fx.secondResult).op, 'run_native_reviews');
  const out = crossAttemptRecord(fx, fx.secondResult, { 2: rejectRecord });
  assert.deepEqual(out.recorded, []);
  assert.deepEqual(out.next.tasks.map((t) => t.id), [2]);
  assert.equal(out.commits.code, null);
  assert.deepEqual(out.commits.code_by_repo, {});
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.aCommit);
  assert.equal(git(fx.WT, 'show', 'HEAD:src/1.txt'), 'A complete');
  assert.equal(fs.readFileSync(path.join(fx.WT, 'src/1.txt'), 'utf8'), 'B update to a previously approved path\n');
});

test('cross-attempt: blocked B cannot cover shared file without a review', async () => {
  const fx = await crossAttemptFixture({ shared: true });
  write(fx.WT, 'src/1.txt', 'UNREVIEWED shared update\n');
  const result = { wave: 1, tasks: [{ task_id: 2, digest: workerDigest(2, 'blocked') }] };
  assert.throws(() => crossAttemptRecord(fx, result), (err) => {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /task 1:.*src\/1\.txt.*fresh review of this task's episode is required/);
    return true;
  });
  assert.equal(git(fx.WT, 'rev-parse', 'HEAD'), fx.aCommit);
  assert.equal(readState(fx.statePath).tasks[1].status, 'pending');
});

test('cross-attempt: unassigned in-scope sibling file refuses phase B', async () => {
  const fx = await crossAttemptFixture({ external: true, extraScope: true });
  write(fx.aRepo, 'src/unassigned.txt', 'UNREVIEWED scope-only file\n');
  assert.equal(crossAttemptRecord(fx, fx.secondResult).op, 'run_native_reviews');
  const beforeMain = git(fx.MAIN, 'rev-parse', 'HEAD');
  assert.throws(() => crossAttemptRecord(fx, fx.secondResult, { 2: x22Approval }), (err) => {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /src\/unassigned\.txt.*fresh review.*episode.*required/);
    return true;
  });
  assert.equal(git(fx.aRepo, 'rev-parse', 'HEAD'), fx.aCommit);
  assert.equal(git(fx.MAIN, 'rev-parse', 'HEAD'), beforeMain);
  assert.equal(readState(fx.statePath).tasks[1].status, 'pending');
});

function crossAttemptAuthorize(fx, options = {}) {
  return authorizeRecording({ statePath: fx.statePath, state: readState(fx.statePath),
    worktree: fx.WT, result: null, ...options });
}

test('cross-attempt: current dispatched task with missing episode still refuses', async () => {
  const fx = await crossAttemptFixture();
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  delete record.review_context.episodes['2'];
  writeWaveDispatchRecord(fx.bundleDir, 1, record);
  assert.throws(() => crossAttemptAuthorize(fx, { result: fx.secondResult }), /task 2: no identifiable entry/);
});

for (const kind of ['retire', 'hold', 'invalid restart']) {
  test('cross-attempt: owning attempt ' + kind + ' refuses recording and completion', async () => {
    const fx = await crossAttemptFixture();
    const record = readWaveDispatchRecord(fx.bundleDir, 1);
    const episode = record.history[0].review_context.episodes['1'];
    if (kind === 'retire') episode.disposition = { kind: 'retire' };
    if (kind === 'hold') episode.hold = 'migration-pending';
    if (kind === 'invalid restart') episode.disposition = { kind: 'restart', subject: 'invalid', lineage: {} };
    writeWaveDispatchRecord(fx.bundleDir, 1, record);
    assert.throws(() => crossAttemptAuthorize(fx), /retired|hold|invalid restart/);
    const state = readState(fx.statePath);
    assert.equal(taskEpisodeEligibleForCompletion(fx.statePath, state, state.tasks[0]), false);
  });
}

test('cross-attempt: no-owner state-done task is not exempt and is ineligible', async () => {
  const fx = await crossAttemptFixture();
  const state = readState(fx.statePath);
  state.tasks.push({ id: 3, wave: 1, status: 'done', files: [] });
  writeState(fx.statePath, state);
  assert.throws(() => crossAttemptAuthorize(fx), /task 3: no identifiable owning dispatch attempt/);
  assert.equal(taskEpisodeEligibleForCompletion(fx.statePath, state, state.tasks[2]), false);
});

for (const missing of ['recorded status', 'recorded task', 'durable event', 'eligible review']) {
  test('cross-attempt: state-done task without ' + missing + ' cannot be exempt', async () => {
    const fx = await crossAttemptFixture();
    const record = readWaveDispatchRecord(fx.bundleDir, 1);
    const owner = record.history[0];
    if (missing === 'recorded status') owner.status = 'superseded';
    if (missing === 'recorded task') owner.record_outcome.recorded = [];
    if (missing === 'durable event') owner.review_context.tasks[0].base_sha = 'unreviewed-base';
    if (missing === 'eligible review') {
      const event = x22Events(fx).split('\n').filter(Boolean).map(JSON.parse)
        .find((e) => e.type === 'task_adversary_review' && e.data.task === 1);
      event.data.review.verdict = 'reject';
      appendEvent(fx.statePath, event);
    }
    writeWaveDispatchRecord(fx.bundleDir, 1, record);
    assert.throws(() => crossAttemptAuthorize(fx), /task 1: owning attempt lacks recorded durable completion evidence/);
  });
}

for (const damage of ['missing context', 'missing episode', 'retire', 'hold', 'invalid restart']) {
  test('cross-attempt: no-fallback when newer dispatch has ' + damage, async () => {
    const fx = await crossAttemptFixture();
    const record = readWaveDispatchRecord(fx.bundleDir, 1);
    // The newer dispatch included A even though its context/episode is damaged.
    record.tasks.push({ task_id: 1 });
    record.payload.push({ id: 1 });
    if (damage === 'missing context') delete record.review_context;
    else if (damage !== 'missing episode') {
      const episode = { subject: 'newer-episode' };
      if (damage === 'retire') episode.disposition = { kind: 'retire' };
      if (damage === 'hold') episode.hold = 'migration-pending';
      if (damage === 'invalid restart') episode.disposition = { kind: 'restart', subject: 'invalid', lineage: {} };
      record.review_context.episodes['1'] = episode;
    }
    writeWaveDispatchRecord(fx.bundleDir, 1, record);
    assert.throws(() => crossAttemptAuthorize(fx), /no enabled review context|no identifiable entry|retired|hold|invalid restart/);
    const state = readState(fx.statePath);
    assert.equal(taskEpisodeEligibleForCompletion(fx.statePath, state, state.tasks[0]), false);
  });
}

test('cross-attempt: three attempts select newest dispatch membership, never an older valid episode', () => {
  const slot = { main: '/fixture', bundleDir: '/fixture/docs/masterplan/run', wave: 1 };
  const first = { attempt: 1, tasks: [{ task_id: 1 }], review_context: {
    enabled: true, episodes: { 1: { subject: 'first-approved-episode' } },
  } };
  const second = { attempt: 2, tasks: [{ task_id: 1 }], review_context: {
    enabled: true, episodes: { 1: { subject: 'second-episode' } },
  } };
  const third = { attempt: 3, tasks: [{ task_id: 2 }], review_context: {
    enabled: true, episodes: { 2: { subject: 'third-episode' } },
  }, history: [first, second] };
  assert.equal(resolveTaskReviewAttempt(third, 1, slot).record.attempt, 2);
  for (const episode of [{ subject: 'second', hold: 'blocked' },
    { subject: 'second', disposition: { kind: 'retire' } },
    { disposition: { kind: 'restart', subject: 'invalid', lineage: {} } }, null]) {
    second.review_context.episodes['1'] = episode;
    assert.throws(() => resolveTaskReviewAttempt(third, 1, slot), /hold|retired|invalid restart|no identifiable entry/);
  }
  // Payload fallback is only for records without descriptor membership. An empty
  // descriptor set must not be widened by stale payload/context membership.
  delete second.tasks;
  second.payload = [{ id: 1 }];
  second.review_context.episodes['1'] = { subject: 'second' };
  assert.equal(resolveTaskReviewAttempt(third, 1, slot).record.attempt, 2);
  second.tasks = [];
  assert.equal(resolveTaskReviewAttempt(third, 1, slot).record.attempt, 1);
  third.tasks.push({ task_id: 1 });
  assert.throws(() => resolveTaskReviewAttempt(third, 1, slot), /no identifiable entry/);
});
