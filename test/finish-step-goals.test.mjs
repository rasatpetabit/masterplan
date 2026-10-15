// test/finish-step-goals.test.mjs — the finish-time goal/Intent seam after the goal blocks
// were removed: the spec-gate re-arm over the Intent artifact, the verify_passed branch
// binding (git facts computed by the machine), the run_verify skip's binding-source
// requirement, and the retirement/rename of pre-upgrade goals gates. The retro
// completion/push-summary wiring that used to live behind the goal check is kept and
// exercised through the real lifecycle (task 30).
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

## Intent
why: keep the Intent artifact as the judged standard
outcome: the finish binds its final assessment to recorded branch facts
done_means: a green suite

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
  // finish-bindings-2: every pass answer carries its evidence file — the default stands in
  // for the verification output the real sequencer writes before re-invoking.
  const verifyOut = path.join(tmp, 'verify-output.txt');
  fs.writeFileSync(verifyOut, 'suite green\n');
  const step = (extra = {}) => finishStep({
    statePath, now: 2000,
    ...(extra.verify === 'pass' && extra.verifyOutputFile === undefined ? { verifyOutputFile: verifyOut } : {}),
    ...extra,
  });
  // The branch binding the verify pass records (verify_passed, git facts computed by the machine).
  const branchBinding = () => [...parseEventLines(bundleDir)].reverse().find((e) => e.type === 'verify_passed')?.data ?? null;
  // Record a FINAL goal_check receipt bound to the deployment the run_final_check op names.
  const recordFinalCheck = (finalOp, over = {}) => appendEvent(bundleDir, {
    type: 'goal_check', ts: '2026-01-01T00:00:09Z',
    data: {
      final: true,
      goals_hash: gHash,
      head_sha: branchBinding()?.head_sha ?? head,
      base_diff_hash: branchBinding()?.base_diff_hash ?? branchBinding()?.diff_hash ?? 'sha256:diff',
      verify_output_hash: branchBinding()?.verify_output_hash ?? 'sha256:vo',
      clean: true,
      deploy_base_sha: finalOp.deploy_base_sha,
      deploy_chain_hash: finalOp.deploy_chain_hash,
      live_check_digest: finalOp.live_digest,
      provenance_kind: 'assessor',
      provenance: { dispatch_id: 'disp-final-1', model: 'assessor', output_tokens: 256 },
      intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
      ...over,
    },
  });
  return { tmp, MAIN, WT, bundleDir, statePath, head, gHash, step, branchBinding, recordFinalCheck, origin };
}

// ---------------------------------------------------------------------------
// verify_passed — the mechanical branch-binding record (design regression case 7, git half)
// ---------------------------------------------------------------------------

test('a passing verify answer records a verify_passed whose git facts COME FROM the worktree', () => {
  const fx = mkFixture();
  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  const verifyOut = path.join(fx.tmp, 'verify-output.txt');
  fs.writeFileSync(verifyOut, '3 passing, 0 failing\n');
  op = fx.step({ verify: 'pass', verifyOutputFile: verifyOut });
  // The event is on the ledger, and every field is machine-derived:
  const rec = [...parseEventLines(fx.bundleDir)].reverse().find((e) => e.type === 'verify_passed');
  assert.ok(rec, 'the pass answer appended verify_passed');
  assert.equal(rec.data.head_sha, git(fx.WT, 'rev-parse', 'HEAD'), 'head_sha is the WT tip, never caller-claimed');
  assert.equal(rec.data.base, 'main');
  const expectedDiff = `sha256:${createHash('sha256').update(git(fx.WT, 'diff', 'main...HEAD')).digest('hex')}`;
  assert.equal(rec.data.base_diff_hash ?? rec.data.diff_hash, expectedDiff, 'diff_hash is the computed base...HEAD diff');
  assert.equal(rec.data.verify_output_hash, `sha256:${createHash('sha256').update('3 passing, 0 failing\n').digest('hex')}`, 'the --verify-output file is hashed into the event');
  // A run whose WT HEAD moved between op and answer records the NEW head — there is no
  // caller-claimed head to disagree with the worktree.
  const fx2 = mkFixture({ slug: 'g14-move' });
  fx2.step();
  write(fx2.WT, 'src/b.txt', 'B\n');
  git(fx2.WT, 'add', '.');
  git(fx2.WT, 'commit', '-q', '-m', 'moved after the op');
  fx2.step({ verify: 'pass' });
  const rec2 = [...parseEventLines(fx2.bundleDir)].reverse().find((e) => e.type === 'verify_passed');
  assert.equal(rec2.data.head_sha, git(fx2.WT, 'rev-parse', 'HEAD'), 'the event always binds the CURRENT worktree head');
  // No goal check is emitted anywhere in the new flow: the next op is the retro.
  op = fx.step();
  assert.equal(op.op, 'write_retro');
});

test('a pass answer without --verify-output is refused; with it the verify_passed carries the hashed evidence (finish-bindings-2)', () => {
  const fx = mkFixture();
  fx.step();
  // The engine refuses the pass answer BEFORE any state is written: no verified_sha, no
  // verify_passed, the run_verify op stays outstanding.
  assert.throws(
    () => fx.step({ verify: 'pass', verifyOutputFile: undefined }),
    /--verify-output=<file>/,
    'a pass answer with no output evidence is refused, naming the flag'
  );
  assert.equal(readState(fx.statePath).verified_sha, undefined, 'nothing was recorded');
  assert.equal(fx.branchBinding(), null, 'no verify_passed was appended');
  const verifyOut = path.join(fx.tmp, 'verify-output.txt');
  fs.writeFileSync(verifyOut, '2 passing, 0 failing\n');
  let op = fx.step({ verify: 'pass', verifyOutputFile: verifyOut });
  assert.equal(op.op, 'write_retro');
  const rec = fx.branchBinding();
  assert.ok(rec);
  assert.equal(
    rec.verify_output_hash,
    `sha256:${createHash('sha256').update('2 passing, 0 failing\n').digest('hex')}`,
    'the event ALWAYS carries the CLI-computed verify_output_hash — there is no incomplete binding'
  );
  // Idempotent: a replayed pass answer (with its evidence file) at the unchanged HEAD
  // appends nothing.
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  finishStep({ statePath: fx.statePath, now: 3000, verify: 'pass', verifyOutputFile: verifyOut });
  const after = parseEventLines(fx.bundleDir).filter((e) => e.type === 'verify_passed').length;
  assert.equal(after, 1, 'no second verify_passed at the same HEAD');
});

// ---------------------------------------------------------------------------
// The run_verify skip requires a binding source on a goals_enabled bundle (case 9)
// ---------------------------------------------------------------------------

test('verified_sha == HEAD with NO binding source re-runs verification; with one it skips', () => {
  const fx = mkFixture();
  // Simulate the upgraded run: it verified under the old flow (verified_sha == HEAD recorded)
  // but the ledger carries no verify_passed and no legacy goal_check.
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'), '');
  const st = readState(fx.statePath);
  writeState(fx.statePath, { ...st, verified_sha: fx.head });
  let op = fx.step();
  assert.equal(op.op, 'run_verify', 'no binding source for this HEAD → verification re-runs');
  op = fx.step({ verify: 'pass' });
  assert.ok(fx.branchBinding(), 'the re-run established the binding');
  assert.equal(op.op, 'write_retro');
  // With the binding recorded, a later entry at the same HEAD skips the re-run.
  fs.writeFileSync(path.join(fx.bundleDir, 'retro.md'), '# retro\n');
  op = fx.step();
  assert.notEqual(op.op, 'run_verify');
});

test('a legacy implementation goal_check for the HEAD is an acceptable binding source (in-flight bundles)', () => {
  const fx = mkFixture();
  const st = readState(fx.statePath);
  writeState(fx.statePath, { ...st, verified_sha: fx.head });
  appendEvent(fx.bundleDir, {
    type: 'goal_check', ts: '2026-01-01T00:00:01Z',
    data: { goals_hash: fx.gHash, head_sha: fx.head, base: 'main', diff_hash: 'sha256:diff', verify_output_hash: 'sha256:vo', provenance_kind: 'assessor', verdicts: { G1: { verdict: 'achieved' } } },
  });
  const op = fx.step();
  assert.notEqual(op.op, 'run_verify', 'a legacy binding source for the HEAD satisfies the skip rule');
  assert.equal(op.op, 'write_retro');
});

// ---------------------------------------------------------------------------
// Pre-upgrade pending goals gates (design regression case 4)
// ---------------------------------------------------------------------------

test('a pending implementation-mode goals_unmet gate is RETIRED with a gate_retired event and the flow continues', () => {
  const fx = mkFixture({ done: 'done:\n  release:\n    - run: /bin/true\n  live_check:\n    - run: /bin/true\n      check: /bin/true\n' });
  fx.step(); // run_verify op outstanding
  // The pre-upgrade bundle: it verified under the old flow (verified_sha == HEAD recorded
  // then, before verify_passed existed) and an implementation-mode gate is open (manual,
  // after an assessor dispatch failure) — no goal_check anywhere on the ledger.
  writeState(fx.statePath, { ...readState(fx.statePath), verified_sha: fx.head, pending_gate: { id: 'goals_unmet', opened_at: '2026-01-01T00:00:00Z', mode: 'manual' } });
  let op = fx.step();
  assert.equal(op.op, 'run_verify', 'retirement continues the flow; with no binding source verification re-runs');
  const retired = [...parseEventLines(fx.bundleDir)].reverse().find((e) => e.type === 'gate_retired');
  assert.ok(retired, 'the retirement is durable');
  assert.equal(retired.gate, 'goals_unmet');
  assert.equal(retired.mode, 'manual');
  assert.match(retired.reason, /retired/i);
  assert.equal(readState(fx.statePath).pending_gate, null, 'the gate is cleared');
  // The flow reaches a valid final assessment after deploy — not final_check_invalid.
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = fx.step(); }
  assert.equal(op.gate, 'branch_finish');
  op = fx.step({ choice: 'merge' });
  assert.equal(op.group, 'release');
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.group, 'live_check');
  const evidence = path.join(fx.tmp, 'evidence.txt');
  fs.writeFileSync(evidence, 'the deployment is live\n');
  op = fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0, digestFile: evidence } });
  assert.equal(op.op, 'run_final_check', JSON.stringify(op));
  fx.recordFinalCheck(op);
  op = fx.step();
  assert.equal(op.gate, 'intent_confirm', 'the retired run reaches a VALID final assessment');
});

test('a pending FINAL-mode goals_unmet gate is honored as intent_unmet (same failure, same answers)', () => {
  const fx = mkFixture();
  fx.step();
  writeState(fx.statePath, { ...readState(fx.statePath), verified_sha: fx.head, pending_gate: { id: 'goals_unmet', opened_at: '2026-01-01T00:00:00Z', mode: 'final' } });
  const op = fx.step();
  assert.equal(op.gate, 'intent_unmet', JSON.stringify(op));
  assert.equal(op.mode, 'final');
  assert.deepEqual(op.choices, ['waiver', 'abort', 'reject-intent']);
  assert.equal(readState(fx.statePath).pending_gate?.id, 'intent_unmet', 'renamed in place, same unresolved disposition');
  // Never silently cleared: the gate takes an explicit answer (this fixture has no deployment,
  // so the waiver/rejection executors legitimately refuse — the terminal-waiver path is
  // exercised against a real deployment in test/final-check.test.mjs). Abort answers it.
  const aborted = fx.step({ intentChoice: 'abort' });
  assert.equal(aborted.reason, 'finish_aborted_intent_unmet');
  assert.equal(readState(fx.statePath).pending_gate, null, 'the answer cleared the gate');
});

// ---------------------------------------------------------------------------
// Spec-gate re-arm over the Intent artifact
// ---------------------------------------------------------------------------

test('spec-gate re-arm: amend goals.md post-plan without re-running the gate → refused', () => {
  const fx = mkFixture();
  fx.step();
  let op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'write_retro'); // recorded review satisfies the spec gate
  // Amend goals.md post-plan (rewrites goals.md → spec-gate content hash changes → gate re-arms).
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), `${GOALS_MD}\n## G3: added goal\nsignal: test\n`);
  op = fx.step();
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'spec_gate_rearmed');
  // Re-run the spec gate at the NEW hash → refusal clears, flow proceeds.
  recordSpecReview(fx.bundleDir);
  op = fx.step();
  assert.equal(op.op, 'write_retro');
});

test('a bundle with NO recorded spec review is refused before the finish proceeds', () => {
  const fx = mkFixture({ recordReview: false });
  fx.step();
  const op = fx.step({ verify: 'pass' });
  assert.equal(op.op, 'ask');
  assert.equal(op.ask, 'spec_gate_rearmed');
});

test('pre-feature bundle (no goals_enabled, no goal events) skips the binding rule entirely', () => {
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
  // A pre-verified entry (verified under the old flow, no binding source): the binding rule
  // is goals_enabled-scoped, so this bundle skips straight to the retro.
  const head = git(WT, 'rev-parse', 'HEAD');
  writeState(statePath, { ...readState(statePath), verified_sha: head });
  // finish-bindings-2: every pass answer carries its evidence file — the default stands in
  // for the verification output the real sequencer writes before re-invoking.
  const verifyOut = path.join(tmp, 'verify-output.txt');
  fs.writeFileSync(verifyOut, 'suite green\n');
  const step = (extra = {}) => finishStep({
    statePath, now: 2000,
    ...(extra.verify === 'pass' && extra.verifyOutputFile === undefined ? { verifyOutputFile: verifyOut } : {}),
    ...extra,
  });
  let op = step();
  assert.equal(op.op, 'write_retro', 'no re-run demanded: no goals, no final assessment to bind');
  op = step({ verify: 'pass' });
  assert.equal(op.op, 'write_retro'); // no goal gate, no spec-gate refusal
});

test('branch_finish payload carries no goal summary', () => {
  const fx = mkFixture();
  fx.step(); fx.step({ verify: 'pass' });
  let op = fx.step();
  assert.equal(op.op, 'write_retro');
  fs.writeFileSync(op.path, '# retro\n');
  op = fx.step();
  assert.equal(op.op, 'ask');
  assert.equal(op.gate, 'branch_finish');
  assert.equal(op.goals, undefined, 'the per-goal summary is gone from the AUQ payload');
});

// ---- retro completion/pushed summary wired into the REAL finish-step lifecycle (task 30) ----
//
// The renderer is pure; these tests prove the PRODUCTION wiring (adversary r1 finding 1): the
// `write_retro` op runs before disposition/completion/archive/push, so the retro the shell
// creates has no `## Completion` block — the machine must upsert it IN PLACE after archive
// (completion) and again after the push_archive answer (pushed). Each test drives REAL
// finish-step transitions, writes the retro.md at the write_retro op (as the shell would),
// and asserts on the ACTUAL generated retro.md.

// Walk a fixture to the branch_finish gate (verify pass recorded the binding along the way).
function walkToBranchFinish(fx) {
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
  // The content written at write_retro survives.
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
  assert.equal(op.group, 'live_check');
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
