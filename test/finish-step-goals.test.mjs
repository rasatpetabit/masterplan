// test/finish-step-goals.test.mjs — finishStep goal-completeness (goals_unmet) gating + spec-gate re-arm.
// REAL git temp repos (the finish-step.test.mjs pattern). Exercises: run_goal_check emitted between
// run_verify and write_retro on a goals_enabled bundle; all-achieved → silent auto-progress; partial →
// goals_unmet AUQ; waiver resolution; fix/abort stops; fail-closed manual gate on assessor failure;
// spec-gate re-arm refusal after a post-plan goals amendment; pre-feature bundles skip entirely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { finishStep } from '../lib/finish-step.mjs';
import { writeState, readState } from '../lib/bundle.mjs';
import { goalsHash } from '../lib/goals.mjs';

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function appendEvent(bundleDir, rec) {
  fs.appendFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify(rec)}\n`);
}
// Replicate the bin/finish-step spec-gate hash over spec.md + goals.md (relName + '\0' + bytes + '\0').
function specGateHash(bundleDir) {
  const h = createHash('sha256');
  for (const rel of ['spec.md', 'goals.md']) {
    h.update(rel); h.update('\0'); h.update(fs.readFileSync(path.join(bundleDir, rel))); h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}
// Record a spec adversary-review at the CURRENT spec+goals hash so the spec gate is satisfied.
function recordSpecReview(bundleDir) {
  appendEvent(bundleDir, {
    type: 'spec_adversary_review', ts: '2026-01-01T00:00:00Z',
    data: { hash: specGateHash(bundleDir), count: 0, base: 'main' },
  });
}

const GOALS_MD = `topic: goal tracking test

## G1: first goal
signal: test

## G2: second goal
signal: test
`;

// A MAIN repo on main, a linked worktree on masterplan/<slug> with one committed task file, and a
// goals_enabled bundle (owner lock off, adversary review off). goals.md + spec.md written into the
// bundle. By default a satisfying spec-gate review is recorded (pass recordReview:false to omit it).
function mkFixture({ slug = 'g14', recordReview = true, goalsMd = GOALS_MD } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-finishgoals-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const WT = path.join(MAIN, '.worktrees', slug);
  git(MAIN, 'worktree', 'add', '-q', '-b', `masterplan/${slug}`, WT);
  write(WT, 'src/a.txt', 'A\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'task 1');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8, slug, status: 'in-progress', phase: 'execute', worktree: WT,
    pending_gate: null, active_run: null, goals_enabled: true,
    review: { adversary: false }, concurrency: { owner_lock: 'off' },
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
  });
  write(bundleDir, 'goals.md', goalsMd);
  write(bundleDir, 'spec.md', '# spec\nbuild it\n');
  fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({ tasks: [{ id: 1, verify_commands: ['true'] }] }));
  if (recordReview) recordSpecReview(bundleDir);
  const head = git(WT, 'rev-parse', 'HEAD');
  const gHash = goalsHash(goalsMd);
  const step = (extra = {}) => finishStep({ statePath, now: 2000, ...extra });
  // Append a goal_check event at the current tuple with the given verdicts map.
  const recordCheck = (verdicts) => appendEvent(bundleDir, {
    type: 'goal_check', ts: '2026-01-01T00:00:01Z',
    data: { goals_hash: gHash, head_sha: head, base: 'main', diff_hash: 'sha256:diff', verify_output_hash: 'sha256:vo', provenance_kind: 'assessor', verdicts },
  });
  // Append a goal_waived event at the current tuple waiving the given ids (reason map).
  const recordWaiver = (reasons) => appendEvent(bundleDir, {
    type: 'goal_waived', ts: '2026-01-01T00:00:02Z',
    data: { goals_hash: gHash, head_sha: head, base: 'main', diff_hash: 'sha256:diff', reasons },
  });
  return { tmp, MAIN, WT, bundleDir, statePath, head, gHash, step, recordCheck, recordWaiver };
}

test('run_goal_check emitted after verify, before retro; all-achieved → silent → write_retro', () => {
  const fx = mkFixture();
  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'run_goal_check');
  assert.equal(op.goals_hash, fx.gHash);
  assert.equal(op.head, fx.head);
  fx.recordCheck({ G1: { verdict: 'achieved', evidence: 'e1' }, G2: { verdict: 'achieved', evidence: 'e2' } });
  op = fx.step();
  assert.equal(op.op, 'write_retro');
});

test('partial verdict opens the goals_unmet gate with a summary', () => {
  const fx = mkFixture();
  fx.step(); fx.step({ verify: 'pass' });
  fx.recordCheck({ G1: { verdict: 'achieved', evidence: 'e1' }, G2: { verdict: 'partial', evidence: 'half' } });
  const op = fx.step();
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'goals_unmet');
  assert.equal(op.mode, 'assess');
  assert.equal(op.summary, '1 achieved / 1 partial / 0 waived');
  assert.deepEqual(op.choices, ['fix', 'waiver', 'abort']);
  assert.ok(op.unmet.some((u) => u.id === 'G2'));
  assert.equal(readState(fx.statePath).pending_gate.id, 'goals_unmet');
});

test('waiver resolution clears the gate and proceeds to retro', () => {
  const fx = mkFixture();
  fx.step(); fx.step({ verify: 'pass' });
  fx.recordCheck({ G1: { verdict: 'achieved', evidence: 'e1' }, G2: { verdict: 'partial', evidence: 'half' } });
  let op = fx.step();
  assert.equal(op.gate, 'goals_unmet');
  fx.recordWaiver({ G2: 'accepted as good enough' });
  op = fx.step({ goalsChoice: 'waiver' });
  assert.equal(op.op, 'write_retro');
  assert.equal(readState(fx.statePath).pending_gate, null);
});

test('fix and abort stop the finish flow', () => {
  const fx = mkFixture();
  fx.step(); fx.step({ verify: 'pass' });
  fx.recordCheck({ G1: { verdict: 'achieved', evidence: 'e1' }, G2: { verdict: 'missed', evidence: 'no' } });
  fx.step(); // open the gate
  let op = fx.step({ goalsChoice: 'fix' });
  assert.equal(op.op, 'stop');
  assert.equal(op.reason, 'goals_unmet_fix');
  op = fx.step({ goalsChoice: 'abort' });
  assert.equal(op.op, 'stop');
  assert.equal(op.reason, 'finish_aborted_goals_unmet');
});

test('assessor-dispatch failure is FAIL-CLOSED → manual goals_unmet gate', () => {
  const fx = mkFixture();
  fx.step(); fx.step({ verify: 'pass' });
  const op = fx.step({ goalCheck: 'failed' });
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'goals_unmet');
  assert.equal(op.mode, 'manual');
  assert.match(op.reason, /fail-closed/);
  assert.equal(readState(fx.statePath).pending_gate.id, 'goals_unmet');
});

test('spec-gate re-arm: amend goals post-plan without re-running the gate → refused', () => {
  const fx = mkFixture();
  fx.step();
  let op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'run_goal_check'); // recorded review satisfies the spec gate
  // Amend goals.md post-plan (rewrites goals.md → spec-gate content hash changes → gate re-arms).
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), `${GOALS_MD}\n## G3: added goal\nsignal: test\n`);
  op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'spec_gate_rearmed');
  // Re-run the spec gate at the NEW hash → refusal clears, flow proceeds to the goal check again.
  recordSpecReview(fx.bundleDir);
  op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'run_goal_check');
});

test('a bundle with NO recorded spec review is refused before any goal check', () => {
  const fx = mkFixture({ recordReview: false });
  fx.step();
  const op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'spec_gate_rearmed');
});

test('pre-feature bundle (no goals_enabled, no goal events) skips goal gating entirely', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-finishpre-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  git(MAIN, 'add', '.'); git(MAIN, 'commit', '-q', '-m', 'initial');
  const WT = path.join(MAIN, '.worktrees', 'pre');
  git(MAIN, 'worktree', 'add', '-q', '-b', 'masterplan/pre', WT);
  write(WT, 'src/a.txt', 'A\n'); git(WT, 'add', '.'); git(WT, 'commit', '-q', '-m', 'task 1');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', 'pre');
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8, slug: 'pre', status: 'in-progress', phase: 'execute', worktree: WT,
    pending_gate: null, active_run: null, review: { adversary: false }, concurrency: { owner_lock: 'off' },
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
  });
  const step = (extra = {}) => finishStep({ statePath, now: 2000, ...extra });
  let op = step();
  assert.equal(op.op, 'run_verify');
  op = step({ verify: 'pass' });
  assert.equal(op.op, 'write_retro'); // no run_goal_check, no spec-gate refusal
});

test('branch_finish payload folds in the goals summary (all achieved)', () => {
  const fx = mkFixture();
  fx.step(); fx.step({ verify: 'pass' });
  fx.recordCheck({ G1: { verdict: 'achieved', evidence: 'e1' }, G2: { verdict: 'achieved', evidence: 'e2' } });
  let op = fx.step();
  assert.equal(op.op, 'write_retro');
  fs.writeFileSync(op.path, '# retro\n');
  op = fx.step();
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'branch_finish');
  assert.equal(op.goals.summary, '2 achieved / 0 partial / 0 waived');
  assert.equal(op.goals.achieved, 2);
});
