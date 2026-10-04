// Installed-style source copies and synthetic runners only: no installer, Pi
// process, provider request or production counter store participates in this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/dispatch-map.json', import.meta.url), 'utf8'));
const helper = fileURLToPath(new URL('./fixtures/task5-panel-integration.mjs', import.meta.url));

function jointRoot() {
  const W = process.env.W;
  assert.ok(W && path.isAbsolute(W) && fs.statSync(W).isDirectory(), 'W must name the absolute existing joint integration checkout');
  for (const rel of ['engine/standalone/resolve-dispatch.mjs', 'engine/runs/shared/review-admission.ts',
    'engine/runs/shared/dispatch-receipt.ts'])
    assert.ok(fs.existsSync(path.join(W, 'pi-subagents', rel)), `missing joint module: ${rel}`);
  return W;
}
function write(root, relative, bytes) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
async function sandbox(body) {
  jointRoot(); // Required even for entrypoints; never skip or use an installed default.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-consumer-integration-'));
  try {
    const home = path.join(root, 'home'); fs.mkdirSync(home);
    const install = path.join(root, 'install', 'releases', 'source');
    fs.mkdirSync(install, { recursive: true });
    for (const rel of ['lib', 'bin', 'agents', 'policy', 'package.json'])
      fs.cpSync(path.join(source, rel), path.join(install, rel), { recursive: true, dereference: true });
    assert.equal(fs.existsSync(path.join(install, 'policy/workflow-map.json')), false);
    assert.equal(fs.existsSync(path.join(install, 'policy/dispatch-map.json')), false);
    const load = rel => import(pathToFileURL(path.join(install, rel)).href);
    const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
      PYTHONDONTWRITEBYTECODE: '1', TSX_DISABLE_CACHE: '1' };
    for (const key of ['MP_ROUTING_POLICY', 'MP_DISPATCH_MAP', 'NODE_TEST_CONTEXT', 'PYTHONOPTIMIZE', 'AGENT_HOOKS_POLICY', 'PI_CODING_AGENT']) delete env[key];
    await body({ root, home, install, load, env });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function ceilingFromPolicy(env) {
  const value = Number(execFileSync('python3', ['-c',
    'import sys; sys.path.insert(0, sys.argv[1]); from lib.review_circuit_config import load; print(load().max_rounds)',
    path.join(jointRoot(), 'hooks')], { env, encoding: 'utf8' }).trim());
  assert.ok(Number.isInteger(value) && value > 1, 'accepted test policy must supply the ceiling');
  return value;
}
function nativePanels(launches, ceiling, env) {
  const W = jointRoot();
  const result = spawnSync(process.execPath, ['--import', 'tsx', helper], {
    cwd: path.join(W, 'pi-subagents'), env, encoding: 'utf8', timeout: 60000,
    input: JSON.stringify({ W, launches, ceiling, map: fixture }),
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary, { admissions: ceiling, denials: 1, deniedChildren: 0,
    complete: ceiling - 1, incomplete: 1, recoveryAttempts: 1, subject: launches[0].descriptor.subject });
  console.log(`native C3/C5/C7: ${JSON.stringify(summary)}`);
}
function reviewerPolicy(index) {
  const map = structuredClone(fixture);
  const pool = map.lists.frontier.models;
  // Reorder synthetic C1 identities, never name/pin a model in a descriptor.
  if (index % 2) pool.push(pool.shift());
  return map;
}
function modelFree(descriptor) {
  for (const key of ['model', 'ref', 'chain', 'candidates', 'seats', 'fallback_reviewers'])
    assert.equal(Object.hasOwn(descriptor, key), false, key);
}
function repository(root) {
  const main = path.join(root, 'main'); fs.mkdirSync(main);
  git(main, 'init', '-q', '--initial-branch=main');
  git(main, 'config', 'user.email', 'test@test'); git(main, 'config', 'user.name', 'test');
  git(main, 'config', 'commit.gpgsign', 'false');
  write(main, 'src/a.txt', 'seed\n'); write(main, '.gitignore', '.worktrees/\n');
  write(main, '.masterplan.yaml', 'done: none\n');
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'synthetic repository');
  return main;
}

test('installed-style configured and unconfigured entrypoints refresh intent and refuse without launches', () => sandbox(async ({ root, home, install, load, env }) => {
  const { discoverDispatchMap, resolvePhase, resolveUsecase } = await load('lib/dispatch/routing-policy.mjs');
  const { resolveClassRouting, reviewChallengeIntent } = await load('lib/dispatch-wave.mjs');
  const { finishReviewDispatch } = await load('lib/finish-step.mjs');
  const { buildPlanWorkItem } = await load('lib/continue.mjs');
  const main = repository(root);
  const mapPath = path.join(home, '.pi/workflows/dispatch-map.json');
  const records = [];
  let launches = 0;
  const entry = (host, options = {}) => {
    const discoveryOptions = { homeDir: home, env: {}, ...options };
    const discovery = discoverDispatchMap({ host, ...discoveryOptions });
    const plan = buildPlanWorkItem({ key: 'source' }, { roots: [main], specPath: '/synthetic/spec', repoRoot: main,
      host, policy: discovery.policy });
    const task = resolveClassRouting('bounded-edit', { host, discoveryOptions });
    const challenge = reviewChallengeIntent(null, host, discoveryOptions);
    const finish = finishReviewDispatch({ main, host, subject: `${main}::finish`, stakes: 'critical', discoveryOptions });
    for (const descriptor of [plan, task, challenge, finish]) modelFree(descriptor);
    records.push({ host, status: discovery.status, plan, task, challenge, finish });
    return records.at(-1);
  };
  // Planning's public producer discovers HOME itself. Isolate its environment too.
  const prior = { HOME: process.env.HOME, MP_DISPATCH_MAP: process.env.MP_DISPATCH_MAP, MP_ROUTING_POLICY: process.env.MP_ROUTING_POLICY, PI_CODING_AGENT: process.env.PI_CODING_AGENT };
  process.env.HOME = home; delete process.env.MP_DISPATCH_MAP; delete process.env.MP_ROUTING_POLICY;
  try {
    for (const host of ['claude-code', 'codex']) {
      const r = entry(host);
      assert.equal(r.status, 'unconfigured');
      for (const d of [r.plan, r.task, r.challenge, r.finish]) {
        assert.equal(d.model_source, 'host-native'); assert.equal(Object.hasOwn(d, 'usecase'), false);
      }
    }
    write(home, '.pi/workflows/dispatch-map.json', JSON.stringify(fixture));
    for (const replaced of [false, true]) {
      if (replaced) {
        const next = structuredClone(fixture);
        next.phases.challenge = 'plan'; next.phases.plan = 'decide';
        next.usecases['bounded-edit'].effort = 'high';
        const stamp = fs.statSync(mapPath);
        fs.writeFileSync(`${mapPath}.new`, JSON.stringify(next));
        fs.utimesSync(`${mapPath}.new`, stamp.atime, stamp.mtime); fs.renameSync(`${mapPath}.new`, mapPath);
      }
      for (const [host, flags] of [['pi', ['--agent-is-pi']], ['claude-code', []], ['codex', ['--agent-is-codex']]]) {
        const cli = spawnSync(process.execPath, [path.join(install, 'bin/masterplan.mjs'), 'detect-host', ...flags], { env, encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).kind, host);
        const r = entry(host);
        assert.equal(r.status, 'configured');
        assert.equal(r.plan.usecase, replaced ? 'decide' : 'plan');
        assert.equal(r.task.requestedEffort, replaced ? 'high' : 'low');
        assert.equal(r.challenge.usecase, replaced ? 'plan' : 'adversarial-assessment');
        assert.equal(r.finish.usecase, r.challenge.usecase);
        assert.equal(r.finish.model_source, host === 'pi' ? 'pi-governed' : 'host-native');
      }
    }
    const policy = discoverDispatchMap({ host: 'pi', homeDir: home, env: {} }).policy;
    const refuse = (code, action, pattern) => {
      try { action(); launches++; assert.fail('refusal launched'); }
      catch (error) {
        assert.match(error.message, pattern); if (error.code) assert.equal(error.code, code);
        records.push({ refusal: code, diagnostic: error.message, children: launches });
      }
      assert.equal(launches, 0);
    };
    refuse('UNKNOWN_PHASE', () => resolvePhase('unknown-phase', { policy }), /unknown phase "unknown-phase"/);
    refuse('UNKNOWN_USECASE', () => resolveUsecase('unknown-usecase', { policy }), /unknown use case "unknown-usecase"/);
    refuse('EXPLICIT_MAP_MISSING', () => entry('codex', { env: { MP_DISPATCH_MAP: path.join(home, 'absent') } }), /no such file/);
    fs.rmSync(mapPath);
    refuse('PI_MAP_MISSING', () => entry('pi'), /no such file/);
    refuse('MAP_PATH', () => entry('pi', { env: { MP_DISPATCH_MAP: '' } }), /nonempty string/);
    // A directory at the discovered path gives a real unreadable-file failure,
    // including under privileged test users (chmod alone would not).
    fs.mkdirSync(mapPath);
    refuse('MAP_UNREADABLE', () => entry('codex'), /directory/i);
    fs.rmdirSync(mapPath);
    for (const [bytes, code, pattern] of [['{', 'MAP_JSON', /invalid JSON/], ['{"schema":2}', 'MAP_SCHEMA', /expected schema 1/],
      [JSON.stringify({ ...fixture, defaultUsecase: 'absent' }), 'MAP_INVALID', /missing default use case/]]) {
      fs.writeFileSync(mapPath, bytes); refuse(code, () => entry('codex'), pattern);
    }
    refuse('RETIRED_ROUTING_POLICY', () => entry('pi', { env: { MP_ROUTING_POLICY: '/synthetic/retired' } }), /retired; unset/);
    const refused = records.filter(r => r.refusal);
    assert.equal(new Set(refused.map(r => r.refusal)).size, 10);
    assert.equal(new Set(refused.map(r => r.diagnostic)).size, 10);
    console.log(`entrypoint evidence: ${records.length - refused.length} fresh records; ${refused.length} distinct refusals; ${launches} launches`);
  } finally {
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}));

test('installed-style task and committed-recovery producers reach native C5 and exhaust one persisted C7 episode', () => sandbox(async ({ root, load, env }) => {
  const { writeState } = await load('lib/bundle.mjs');
  const { buildOwnerIdentity } = await load('lib/owner.mjs');
  const { continueRun } = await load('lib/continue.mjs');
  const { dispatchWaveViaFabric, readWaveDispatchRecord, writeWaveDispatchRecord, reviewNativeResult } = await load('lib/dispatch-wave.mjs');
  const main = repository(root), slug = 'task-cutover';
  const bundle = path.join(main, 'docs/masterplan', slug), statePath = path.join(bundle, 'state.yml');
  writeState(statePath, { schema_version: 8, slug, status: 'in-progress', phase: 'execute',
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }], active_run: null,
    dispatch: { fabric: true }, review: { adversary: true, stakes: 'critical' } });
  write(bundle, 'plan.index.json', JSON.stringify({ tasks: [{ id: 1, wave: 1, files: ['src/a.txt'], description: 'edit', verify_commands: [] }] }));
  const self = buildOwnerIdentity({ host: 'test', session: 'source-integration', slug, now: 1000 });
  const op = continueRun({ statePath, self, now: 2000, policy: fixture });
  assert.equal(op.op, 'dispatch_fabric');
  const wt = op.cwd;
  await dispatchWaveViaFabric({ statePath, self, now: 2000, policy: fixture });
  const ceiling = ceilingFromPolicy(env), launches = [];
  const result = { wave: 1, tasks: [{ task_id: 1, digest: { task_id: 1, status: 'done', start_sha: 'abc123', files_changed: [], verify: [], summary: 'edit', blockers: null } }] };
  for (let i = 0; i <= ceiling; i++) {
    const record = readWaveDispatchRecord(bundle, 1);
    const token = `cutover-task-${i}`;
    writeWaveDispatchRecord(bundle, 1, { ...record, attempt: i + 1, wave_token: token });
    write(wt, 'src/a.txt', `edit ${i}\n`);
    if (i % 2) { git(wt, 'add', 'src/a.txt'); git(wt, 'commit', '-qm', `recovery ${i}`); }
    const head = git(wt, 'rev-parse', 'HEAD');
    const out = await reviewNativeResult({ statePath, self, now: 2300, policy: fixture, result,
      ...(i % 2 ? { recoverySelector: { repo: wt, head } } : {}) });
    assert.equal(out.pending_reviews.length, 1, 'masterplan emits one descriptor, not panel seats');
    const [descriptor] = out.pending_reviews; modelFree(descriptor);
    assert.equal(descriptor.subject, readWaveDispatchRecord(bundle, 1).review_context.episodes['1'].subject);
    assert.equal(descriptor.diff_sha, out.tasks[0].review_input.sha);
    assert.equal(descriptor.stakes, 'critical');
    if (i) { assert.equal(descriptor.subject, launches[0].descriptor.subject); assert.notEqual(descriptor.diff_sha, launches[i - 1].descriptor.diff_sha); }
    launches.push({ descriptor, head, attempt: i + 1, token, map: reviewerPolicy(i) });
  }
  nativePanels(launches, ceiling, env);
}));

test('installed-style finish producer reaches native C5 and exhausts its unchanged episode across changed heads and retries', () => sandbox(async ({ root, home, install, load, env }) => {
  const { writeState, readState } = await load('lib/bundle.mjs');
  const { buildOwnerIdentity } = await load('lib/owner.mjs');
  const { acquireOwner } = await load('lib/owner-fs.mjs');
  const { finishStep } = await load('lib/finish-step.mjs');
  const main = repository(root), slug = 'finish-cutover';
  const wt = path.join(main, '.worktrees', slug);
  git(main, 'worktree', 'add', '-q', '-b', `masterplan/${slug}`, wt);
  write(wt, 'src/a.txt', 'finish task\n'); git(wt, 'add', 'src/a.txt'); git(wt, 'commit', '-qm', 'task');
  const bundle = path.join(main, 'docs/masterplan', slug), statePath = path.join(bundle, 'state.yml');
  writeState(statePath, { schema_version: 8, slug, status: 'in-progress', phase: 'execute', worktree: wt,
    pending_gate: null, active_run: null, finish_review_new: true, review: { adversary: true },
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }] });
  const self = buildOwnerIdentity({ host: 'test', session: 'source-integration', slug, now: 1000 });
  assert.equal(acquireOwner(bundle, self, { now: 1000 }).outcome, 'acquire');
  const step = extra => finishStep({ statePath, self, now: 2000, host: 'pi', policy: fixture, stakes: 'critical', ...extra });
  assert.equal(step({ verify: 'pass' }).op, 'write_retro');
  write(bundle, 'retro.md', '# synthetic retro\n');
  const ceiling = ceilingFromPolicy(env), launches = [];
  for (let i = 0; i <= ceiling; i++) {
    if (i) {
      write(wt, 'src/a.txt', `finish repair ${i}\n`); git(wt, 'add', 'src/a.txt'); git(wt, 'commit', '-qm', `finish retry ${i}`);
      step({ verify: 'pass' });
    }
    const descriptor = step({});
    assert.equal(descriptor.op, 'run_adversary_review'); modelFree(descriptor);
    assert.equal(descriptor.subject, readState(statePath).finish_review_subject);
    assert.equal(descriptor.stakes, 'critical');
    if (i) { assert.equal(descriptor.subject, launches[0].descriptor.subject); assert.notEqual(descriptor.head, launches[i - 1].head); }
    // The harness adapter uses finish's wt/head/base rather than task-review's repo/diff_sha.
    const diff = git(wt, 'diff', descriptor.base, descriptor.head);
    launches.push({ descriptor: { ...descriptor, repo: descriptor.wt, diff_sha: createHash('sha256').update(diff).digest('hex') },
      head: descriptor.head, attempt: i + 1, token: `cutover-finish-${i}`, map: reviewerPolicy(i) });
  }
  nativePanels(launches, ceiling, env);
  const mapPath = write(home, '.pi/workflows/dispatch-map.json', JSON.stringify(fixture));
  for (const configured of [true, false]) {
    if (!configured) fs.rmSync(mapPath);
    for (const [host, flags] of [['pi', ['--agent-is-pi']], ['claude-code', []], ['codex', ['--agent-is-codex']]]) {
      const result = spawnSync(process.execPath, [path.join(install, 'bin/masterplan.mjs'), 'finish-step',
        `--state=${statePath}`, '--session=source-integration', '--host=test', '--now=2000', ...flags], { env, encoding: 'utf8' });
      if (!configured && host === 'pi') {
        assert.notEqual(result.status, 0); assert.match(result.stderr, /no such file/); continue;
      }
      assert.equal(result.status, 0, result.stderr);
      const descriptor = JSON.parse(result.stdout); modelFree(descriptor);
      assert.equal(descriptor.op, 'run_adversary_review'); assert.equal(descriptor.host, host);
      assert.equal(descriptor.subject, launches[0].descriptor.subject);
      assert.equal(descriptor.routing_map.status, configured ? 'configured' : 'unconfigured');
      assert.equal(descriptor.model_source, host === 'pi' ? 'pi-governed' : 'host-native');
      assert.equal(Object.hasOwn(descriptor, 'usecase'), configured);
    }
  }
}));
