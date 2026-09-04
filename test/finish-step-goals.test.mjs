// test/finish-step-goals.test.mjs — finishStep goal-completeness (goals_unmet) gating + spec-gate re-arm.
// REAL git temp repos (the finish-step.test.mjs pattern). Exercises: run_goal_check emitted between
// run_verify and write_retro on a goals_enabled bundle; all-achieved → silent auto-progress; partial →
// goals_unmet AUQ; waiver resolution; fix/abort stops; fail-closed manual gate on assessor failure;
// spec-gate re-arm refusal after a post-plan goals amendment; pre-feature bundles skip entirely.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { finishStep } from '../lib/finish-step.mjs';
import { writeState, readState } from '../lib/bundle.mjs';
import { goalsHash } from '../lib/goals.mjs';
import { renderRetroSummary, classifyCompletionForRetro, archivePushedState, upsertRetroCompletion } from '../lib/retro-goals.mjs';

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

// Read + parse the durable event ledger into an array of records (the same shape the retro
// renderer consumes). Tolerates an absent ledger (empty array).
function parseEventLines(bundleDir) {
  const p = path.join(bundleDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
function mkFixture({ slug = 'g14', recordReview = true, goalsMd = GOALS_MD, done = null, origin = false, autonomy = 'loose' } = {}) {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-finishgoals-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  if (done) write(MAIN, '.masterplan.yaml', done);
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  if (origin) {
    const bare = path.join(tmp, 'origin.git');
    git(MAIN, 'init', '--bare', '-q', bare);
    git(MAIN, 'remote', 'add', 'origin', bare);
    git(MAIN, 'push', '-q', 'origin', 'main');
  }
  const WT = path.join(MAIN, '.worktrees', slug);
  git(MAIN, 'worktree', 'add', '-q', '-b', `masterplan/${slug}`, WT);
  write(WT, 'src/a.txt', 'A\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'task 1');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8, slug, status: 'in-progress', phase: 'execute', worktree: WT,
    pending_gate: null, active_run: null, goals_enabled: true, autonomy,
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
  // Record a FINAL goal_check receipt bound to the deployment the run_final_check op names.
  const recordFinalCheck = (finalOp) => appendEvent(bundleDir, {
    type: 'goal_check', ts: '2026-01-01T00:00:09Z',
    data: {
      final: true,
      goals_hash: gHash,
      head_sha: head,
      base_diff_hash: 'sha256:diff',
      verify_output_hash: 'sha256:vo',
      clean: true,
      deploy_base_sha: finalOp.deploy_base_sha,
      deploy_chain_hash: finalOp.deploy_chain_hash,
      live_check_digest: finalOp.live_digest,
      provenance_kind: 'assessor',
      provenance: { dispatch_id: 'disp-final-1', model: 'assessor', output_tokens: 256 },
      verdicts: {
        G1: { verdict: 'achieved', evidence: 'the stage ran' },
        G2: { verdict: 'achieved', evidence: 'the live check gated the archive' },
      },
      intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
    },
  });
  return { tmp, MAIN, WT, bundleDir, statePath, head, gHash, step, recordCheck, recordWaiver, recordFinalCheck, origin };
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
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-finishpre-'));
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

// ---- retro completion/pushed summary wired into the REAL finish-step lifecycle (task 30) ----
//
// The renderer is pure; these tests prove the PRODUCTION wiring (adversary r1 finding 1): the
// `write_retro` op runs before disposition/completion/archive/push, so the retro the shell
// creates has no `## Completion` block — the machine must upsert it IN PLACE after archive
// (completion) and again after the push_archive answer (pushed). Each test drives REAL
// finish-step transitions, writes the retro.md at the write_retro op (as the shell would),
// and asserts on the ACTUAL generated retro.md.

// Walk a goals fixture to the point where the deploy stage is about to run: verify → goal_check
// → retro (written when the op asks) → branch_finish gate. Returns the pre-archive fixture.
function walkToBranchFinish(fx) {
  fx.recordCheck({ G1: { verdict: 'achieved', evidence: 'e1' }, G2: { verdict: 'achieved', evidence: 'e2' } });
  let op = fx.step();
  assert.equal(op.op, 'run_verify', JSON.stringify(op));
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') {
    fs.writeFileSync(op.path, '# Retro for the run\n\n## Goal verdicts\n\n(none yet)\n');
    op = fx.step();
  }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  return op;
}

test('a keep archives incomplete:kept and the retro.md gains the Completion block via the real flow', () => {
  const fx = mkFixture();
  walkToBranchFinish(fx);
  const op = fx.step({ choice: 'keep' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const st = readState(fx.statePath);
  assert.equal(st.completion, 'incomplete:kept');
  assert.equal(st.status, 'archived');
  // The production wiring updated the ACTUAL retro.md.
  const retro = fs.readFileSync(path.join(fx.bundleDir, 'retro.md'), 'utf8');
  assert.ok(retro.includes('## Completion'), 'retro.md gains the Completion block');
  assert.ok(retro.includes('**Completion:** incomplete:kept'));
  assert.ok(retro.includes('**Pushed to origin:** no'));
  // The goal verdicts content written at write_retro survives.
  assert.ok(retro.includes('## Goal verdicts'));
  // Idempotent: a re-entry does not duplicate the block.
  const again = fx.step();
  assert.equal(again.reason, 'archived');
  const retro2 = fs.readFileSync(path.join(fx.bundleDir, 'retro.md'), 'utf8');
  assert.equal(retro2.split('## Completion').length - 1, 1);
  assert.equal(retro2, retro, 're-entry leaves retro.md byte-identical');
});

test('a merge on done: none archives merged and the retro.md Completion block reflects it', () => {
  const fx = mkFixture({ done: 'done: none\n' });
  walkToBranchFinish(fx);
  const op = fx.step({ choice: 'merge' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  assert.equal(readState(fx.statePath).completion, 'merged');
  const retro = fs.readFileSync(path.join(fx.bundleDir, 'retro.md'), 'utf8');
  assert.ok(retro.includes('**Completion:** merged'));
  assert.ok(retro.includes('**Pushed to origin:** no'));
});

test('an install-pushed archive opens the push gate and the push answer updates the retro.md pushed line', () => {
  const fx = mkFixture({
    done: 'done:\n  install:\n    - run: /bin/true\n  live_check:\n    - run: /bin/true\n      check: /bin/true\n',
    origin: true,
  });
  fx.recordCheck({ G1: { verdict: 'achieved', evidence: 'e1' }, G2: { verdict: 'achieved', evidence: 'e2' } });
  let op = fx.step();
  assert.equal(op.op, 'run_verify', JSON.stringify(op));
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') {
    fs.writeFileSync(op.path, '# Retro for the run\n');
    op = fx.step();
  }
  // The merge resolves branch_finish and lands on the install deploy step.
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  op = fx.step({ choice: 'merge' });
  // Deploy stage: install (push origin/main like a real install), then live_check.
  assert.equal(op.group, 'install', JSON.stringify(op));
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  op = fx.step({ deployStepDone: { group: 'install', index: 0, exit: 0 } });
  assert.equal(op.group, 'live_check', JSON.stringify(op));
  // The live_check report carries the evidence file the final assessment binds to.
  const evidence = path.join(fx.tmp, 'evidence.txt');
  fs.writeFileSync(evidence, 'the deployment is live\n');
  op = fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0, digestFile: evidence } });
  // The final assessment runs; record its receipt, then confirm intent.
  assert.equal(op.op, 'run_final_check', JSON.stringify(op));
  fx.recordFinalCheck(op);
  op = fx.step();
  assert.equal(op.gate, 'intent_confirm', JSON.stringify(op));
  op = fx.step({ intentConfirmed: true });
  // The archive opens the push_archive gate (the install receipt proved pushed_base).
  assert.equal(op.gate, 'push_archive', JSON.stringify(op));
  // Before the answer, the retro Completion block (written at archive) says pushed: no.
  let retro = fs.readFileSync(path.join(fx.bundleDir, 'retro.md'), 'utf8');
  assert.ok(retro.includes('**Completion:** complete'));
  assert.ok(retro.includes('**Pushed to origin:** no'));
  // The operator pushes origin/main to the archive HEAD and answers.
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  const head = git(fx.MAIN, 'rev-parse', 'HEAD');
  op = fx.step({ archivePushed: { sha: head } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  retro = fs.readFileSync(path.join(fx.bundleDir, 'retro.md'), 'utf8');
  assert.ok(retro.includes('**Pushed to origin:** yes'), 'the push answer flips the pushed line: ' + retro);
  assert.ok(retro.includes('**Completion:** complete'));
  // Idempotent after the push answer too.
  const again = fx.step();
  assert.equal(again.reason, 'archived');
  const retro2 = fs.readFileSync(path.join(fx.bundleDir, 'retro.md'), 'utf8');
  assert.equal(retro2.split('## Completion').length - 1, 1);
});

test('an install-pushed archive declined via archive_push_skipped keeps pushed: no with the reason', () => {
  const fx = mkFixture({
    done: 'done:\n  install:\n    - run: /bin/true\n  live_check:\n    - run: /bin/true\n      check: /bin/true\n',
    origin: true,
  });
  fx.recordCheck({ G1: { verdict: 'achieved', evidence: 'e1' }, G2: { verdict: 'achieved', evidence: 'e2' } });
  let op = fx.step();
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') {
    fs.writeFileSync(op.path, '# Retro for the run\n');
    op = fx.step();
  }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  op = fx.step({ choice: 'merge' });
  assert.equal(op.group, 'install', JSON.stringify(op));
  git(fx.MAIN, 'push', '-q', 'origin', 'main');
  op = fx.step({ deployStepDone: { group: 'install', index: 0, exit: 0 } });
  assert.equal(op.group, 'live_check', JSON.stringify(op));
  const evidence = path.join(fx.tmp, 'evidence.txt');
  fs.writeFileSync(evidence, 'the deployment is live\n');
  op = fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0, digestFile: evidence } });
  assert.equal(op.op, 'run_final_check', JSON.stringify(op));
  fx.recordFinalCheck(op);
  op = fx.step();
  assert.equal(op.gate, 'intent_confirm', JSON.stringify(op));
  op = fx.step({ intentConfirmed: true });
  assert.equal(op.gate, 'push_archive', JSON.stringify(op));
  op = fx.step({ archivePushSkipped: { reason: 'keep local' } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const retro = fs.readFileSync(path.join(fx.bundleDir, 'retro.md'), 'utf8');
  assert.ok(retro.includes('**Pushed to origin:** no (declined: keep local)'), retro);
});

test('a pre-v10 archive with no completion field renders legacy from durable state', () => {
  const fx = mkFixture();
  // A pre-v10 archive is one that predates §7.4 — its state has no completion field. The
  // renderer's legacy branch is pure (asserted exhaustively in retro-goals.test.mjs); here we
  // prove the production path renders the SAME legacy line from a real completion-less state
  // through the upsert wiring. The keep/merge/install walks above prove the wiring end-to-end;
  // this case asserts the legacy rendering is reachable from a real bundle shape.
  writeState(fx.statePath, { ...readState(fx.statePath), status: 'archived' });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# Retro for the run\n');
  // The upsert helper is what finish-step calls; invoke it directly with the real state/events.
  const current = fs.readFileSync(path.join(fx.bundleDir, 'retro.md'), 'utf8');
  const next = upsertRetroCompletion(current, { state: readState(fx.statePath), events: parseEventLines(fx.bundleDir) });
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), next, 'utf8');
  const retro = fs.readFileSync(path.join(fx.bundleDir, 'retro.md'), 'utf8');
  assert.ok(retro.includes('**Completion:** legacy (pre-v10 archive with no completion class)'), retro);
  assert.equal(classifyCompletionForRetro(readState(fx.statePath)), 'legacy');
});
