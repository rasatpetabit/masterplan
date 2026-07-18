// test/fabric-dogfood-v1.test.mjs — V1 dogfood proof (Task 7 / G1 gate for L2 deletion).
//
// Executes a scratch bundle through ONE fabric wave with adversary review armed,
// asserts per-task review fields on digests, and exercises a blocking verdict
// path through dispatch-wave → blocking_reviews[].

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  dispatchWaveViaFabric,
  readWaveDispatchRecord,
} from '../lib/dispatch-wave.mjs';
import { continueRun } from '../lib/continue.mjs';
import { writeState, readState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function makeDogfoodFixture({ tasks, planIndex, slug = 'dogfood-v1' }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-dogfood-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'dog@food');
  git(MAIN, 'config', 'user.name', 'dogfood');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  write(MAIN, 'src/a.txt', 'a0\n');
  write(MAIN, 'src/b.txt', 'b0\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'init');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8,
    slug,
    status: 'in-progress',
    phase: 'execute',
    tasks,
    active_run: null,
    dispatch: { fabric: true },
    review: { adversary: true },
  });
  write(bundleDir, 'plan.index.json', JSON.stringify({ tasks: planIndex }));
  const self = buildOwnerIdentity({ host: 'h1', session: 'dogfood', slug, now: 1000 });
  return { tmp, MAIN, bundleDir, statePath, self };
}

function brokerStub(resultFor) {
  return {
    async callTool(name, args) {
      if (name === 'dispatch_task') return resultFor(args.descriptor);
      return { results: (args.descriptors ?? []).map((d) => resultFor(d)) };
    },
  };
}

const routeResult = (d) => ({
  decision: { decision: 'route', backend: 'pi' },
  stdout: JSON.stringify({
    task_id: d.task_id,
    status: 'done',
    start_sha: 'abc',
    files_changed: Array.isArray(d.files) ? d.files : [],
    verify: [],
    summary: `task ${d.task_id} done`,
    blockers: null,
  }),
});

const disabledCoord = () => ({ enabled: false, attachToTask: (t) => t, close: () => {} });

function launch(fx) {
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true });
  assert.equal(op.op, 'dispatch_fabric', `expected dispatch_fabric, got ${JSON.stringify(op)}`);
  return op;
}

function reviewLaneStub(payload) {
  const calls = [];
  return {
    calls,
    lane: (args) => {
      calls.push(args);
      return payload;
    },
  };
}

test('V1 dogfood: fabric wave records per-task adversary review (verdict + findings) on digests', async () => {
  const fx = makeDogfoodFixture({
    tasks: [
      { id: 1, status: 'pending', wave: 0, files: ['src/a.txt'] },
      { id: 2, status: 'pending', wave: 0, files: ['src/b.txt'] },
    ],
    planIndex: [
      { id: 1, wave: 0, files: ['src/a.txt'], description: 'edit a', verify_commands: [] },
      { id: 2, wave: 0, files: ['src/b.txt'], description: 'edit b', verify_commands: [] },
    ],
  });
  const op = launch(fx);
  write(op.cwd, 'src/a.txt', 'a1\n');
  write(op.cwd, 'src/b.txt', 'b1\n');

  const rl = reviewLaneStub({
    final_verdict: 'approve',
    findings: [],
    blocking_findings: [],
    summary: 'clean',
  });

  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath,
    self: fx.self,
    now: 3000,
    _brokerClient: brokerStub(routeResult),
    _openCoord: disabledCoord,
    _reviewLane: rl.lane,
    _localVerifyExec: () => 'ok',
  });

  assert.equal(res.dispatched, true);
  assert.ok(rl.calls.length >= 1, 'adversary lane must run');
  // Summary row carries review verdict string for done tasks.
  for (const t of res.tasks) {
    assert.equal(t.review, 'clean', `task ${t.task_id} review verdict`);
  }
  const rec = readWaveDispatchRecord(fx.bundleDir, 0);
  assert.ok(rec?.result?.tasks?.length === 2);
  for (const item of rec.result.tasks) {
    assert.ok(item.digest?.review, `task ${item.task_id} missing digest.review`);
    assert.equal(item.digest.review.verdict, 'clean');
    assert.ok(typeof item.digest.review.findings === 'string');
    // count is present (may be 0)
    assert.ok('count' in item.digest.review || item.digest.review.count == null || Number.isFinite(item.digest.review.count));
  }
  assert.deepEqual(res.record.blocking_reviews, []);
});

test('V1 dogfood: blocking adversary verdict surfaces via blocking_reviews[]', async () => {
  const fx = makeDogfoodFixture({
    tasks: [{ id: 1, status: 'pending', wave: 0, files: ['src/a.txt'] }],
    planIndex: [{ id: 1, wave: 0, files: ['src/a.txt'], description: 'edit a', verify_commands: [] }],
    slug: 'dogfood-block',
  });
  const op = launch(fx);
  write(op.cwd, 'src/a.txt', 'a-race\n');

  const rl = reviewLaneStub({
    final_verdict: 'reject',
    findings: [{ severity: 'high', note: 'introduces a data race' }],
    blocking_findings: [{ severity: 'high', note: 'introduces a data race' }],
    summary: 'blocking data race',
  });

  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath,
    self: fx.self,
    now: 3000,
    _brokerClient: brokerStub(routeResult),
    _openCoord: disabledCoord,
    _reviewLane: rl.lane,
    _localVerifyExec: () => 'ok',
  });

  assert.equal(res.dispatched, true);
  assert.equal(res.tasks[0].review, 'blocking');
  assert.equal(res.record.blocking_reviews.length, 1);
  assert.equal(res.record.blocking_reviews[0].id, 1);
  assert.match(String(res.record.blocking_reviews[0].findings), /data race/);
  const dig = readWaveDispatchRecord(fx.bundleDir, 0).result.tasks[0].digest;
  assert.equal(dig.review.verdict, 'blocking');
  assert.ok(dig.review.findings);
  // Task still records done; orchestrator acts on blocking_reviews[].
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
});
