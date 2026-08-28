// test/fabric-dogfood-v1.test.mjs — V1 dogfood proof on the native seam.
//
// Executes a scratch bundle through ONE native wave with adversary review armed:
// spawn plan out, orchestrator-provided review records in, per-task review
// fields on digests, and a blocking verdict path through blocking_reviews[].

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  dispatchWaveViaFabric,
  reviewNativeResult,
} from '../lib/dispatch-wave.mjs';
import { continueRun } from '../lib/continue.mjs';
import { writeState, readState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { recordWaveResult } from '../lib/wave-commit.mjs';

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

function launch(fx) {
  const op = continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true });
  assert.equal(op.op, 'dispatch_fabric', `expected dispatch_fabric, got ${JSON.stringify(op)}`);
  return op;
}

const workerDigest = (id, files = []) => ({
  task_id: id, status: 'done', start_sha: 'abc', files_changed: files,
  verify: [], summary: `task ${id} done`, blockers: null,
});

// Run the native two-phase seam end to end: plan → harness edits + digests →
// provided review records → record transaction.
async function runNativeWave(fx, providedReviews) {
  const res = await dispatchWaveViaFabric({ statePath: fx.statePath, self: fx.self, now: 3000 });
  assert.equal(res.outcome, 'native-spawn-plan');
  const result = {
    wave: res.wave,
    tasks: res.plan.tasks.map((t) => ({ task_id: t.task_id, digest: workerDigest(t.task_id, t.files) })),
  };
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath, result, providedReviews, now: 3100,
  });
  const recorded = recordWaveResult({
    statePath: fx.statePath, result: reviewed, self: fx.self, now: 3200,
    worktree: res.plan.tasks[0].cwd,
  });
  return { res, reviewed, recorded };
}

test('V1 dogfood: native wave records per-task adversary review (verdict + findings) on digests', async () => {
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

  const approveRecord = {
    final_verdict: 'approve',
    findings: [],
    blocking_findings: [],
    summary: 'clean',
    harness: { degraded: false, timed_out: false, stalled: false, deadline_exceeded: false, regions_unreviewed: 0, extraction_degraded: false },
  };

  const { reviewed, recorded } = await runNativeWave(fx, { 1: approveRecord, 2: approveRecord });

  // Every done task carries the review projection on its digest.
  for (const t of reviewed.tasks) {
    assert.equal(t.review.verdict, 'approve', `task ${t.task_id} review verdict`);
    assert.ok(Array.isArray(t.digest.review.findings));
  }
  assert.deepEqual(recorded.blocking_reviews, []);
});

test('V1 dogfood: blocking adversary verdict surfaces via blocking_reviews[]', async () => {
  const fx = makeDogfoodFixture({
    tasks: [{ id: 1, status: 'pending', wave: 0, files: ['src/a.txt'] }],
    planIndex: [{ id: 1, wave: 0, files: ['src/a.txt'], description: 'edit a', verify_commands: [] }],
    slug: 'dogfood-block',
  });
  const op = launch(fx);
  write(op.cwd, 'src/a.txt', 'a-race\n');

  const rejectRecord = {
    final_verdict: 'reject',
    findings: [{ file: 'src/a.txt', line: 1, summary: 'introduces a data race', severity: 'major' }],
    blocking_findings: [{ summary: 'introduces a data race' }],
    summary: 'blocking data race',
    harness: { degraded: false, timed_out: false, stalled: false, deadline_exceeded: false, regions_unreviewed: 0, extraction_degraded: false },
  };

  const { reviewed, recorded } = await runNativeWave(fx, { 1: rejectRecord });

  assert.equal(reviewed.tasks[0].review.verdict, 'reject');
  assert.equal(recorded.blocking_reviews.length, 1);
  assert.equal(recorded.blocking_reviews[0].id, 1);
  assert.match(JSON.stringify(recorded.blocking_reviews[0].findings), /data race/);
  assert.equal(reviewed.tasks[0].digest.review.verdict, 'reject');
  assert.ok(Array.isArray(reviewed.tasks[0].digest.review.findings));
  // Task still records done; orchestrator acts on blocking_reviews[].
  assert.equal(readState(fx.statePath).tasks[0].status, 'done');
});
