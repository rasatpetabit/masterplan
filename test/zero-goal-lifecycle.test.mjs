// test/zero-goal-lifecycle.test.mjs — zero-G end-to-end lifecycle walk (design regression case 2).
//
// Regression case 2 of docs/design/remove-goal-blocks.md:
// A new bundle whose goals.md carries ONLY a topic: anchor and a ## Intent block (no '## G<n>:' blocks)
// walks capture -> spec gate -> plan -> execute -> finish -> final Intent assessment -> intent_confirm
// -> archive 'complete'.
//
// Assertions:
// 1. goals_frozen with an empty goal list at capture
// 2. no plan-gate goal coverage requirement
// 3. verify_passed recorded at finish
// 4. the final Intent receipt binds to it (refuses foreign branch facts, echoes ledger facts)
// 5. intent_confirm opens on met
// 6. archive completion class 'complete'
// 7. a partial verdict on the same fixture opens intent_unmet and can never archive 'complete'
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishStep } from '../lib/finish-step.mjs';
import { writeState, readState } from '../lib/bundle.mjs';
import { goalsHash } from '../lib/goals.mjs';
import { validatePlanIndex } from '../lib/plan-merge.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

// Track temp directories created across fixtures; remove on completion.
const FIXTURE_TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  FIXTURE_TMPDIRS.push(dir);
  return dir;
}
after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function run(args, opts = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', ...opts }),
      stderr: '',
    };
  } catch (e) {
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function readEvents(bundleDir) {
  try {
    return fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// A zero-G document: carries ONLY topic: anchor and ## Intent block. No '## G<n>:' blocks whatsoever.
const ZERO_G_GOALS = [
  'topic: |',
  '  walk a zero-goal run from capture to complete archive',
  '',
  '## Intent',
  'why: goal blocks are removed and only the run Intent block is kept',
  'outcome: a zero-G run completes the entire lifecycle and archives complete',
  'anti_goals:',
  '  - any G blocks in goals.md',
  'done_means: deploy and live check pass',
  '',
].join('\n');

const DONE_WITH_LIVE = [
  'done:',
  '  release:',
  '    - run: /bin/true',
  '  live_check:',
  '    - run: /bin/true',
  '      check: /bin/true',
  '',
].join('\n');

// Build a real git repo with a linked worktree and seeded masterplan bundle.
function mkZeroGoalFixture({ slug = 'zg', done = DONE_WITH_LIVE } = {}) {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-zerog-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  write(MAIN, '.gitignore', '.worktrees/\n');
  write(MAIN, '.masterplan.yaml', done);
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');

  const WT = path.join(MAIN, '.worktrees', slug);
  git(MAIN, 'worktree', 'add', '-q', '-b', `masterplan/${slug}`, WT);

  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8,
    slug,
    status: 'in-progress',
    phase: 'brainstorm',
    worktree: WT,
    pending_gate: null,
    active_run: null,
    goals_enabled: true,
    autonomy: 'loose',
    review: { adversary: false },
    concurrency: { owner_lock: 'off' },
    tasks: [],
  });
  write(bundleDir, 'goals.md', ZERO_G_GOALS);
  write(bundleDir, 'spec.md', '# spec\nprove zero-goal lifecycle\n');
  write(bundleDir, 'events.jsonl', '');

  const liveDigestFile = path.join(tmp, 'live-digest.txt');
  fs.writeFileSync(liveDigestFile, 'live check observed service healthy\n');

  const verifyOutputFile = path.join(tmp, 'verify-output.txt');
  fs.writeFileSync(verifyOutputFile, 'suite green 100%\n');

  return { tmp, MAIN, WT, bundleDir, statePath, slug, liveDigestFile, verifyOutputFile };
}

// Walk a zero-G fixture from capture through execution and deployment up to run_final_check.
function walkToFinalCheck(fx) {
  const { MAIN, WT, bundleDir, statePath, liveDigestFile, verifyOutputFile } = fx;

  // 1. Capture: pass spec gate review, then set-phase --phase=plan
  const ghSpec = run(['gate-hash', `--state=${statePath}`, '--gate=spec']);
  assert.equal(ghSpec.status, 0, `gate-hash spec failed: ${ghSpec.stderr}`);
  const { hash: sHash, artifacts: sArtifacts } = JSON.parse(ghSpec.stdout);
  assert.deepEqual(sArtifacts, ['spec.md', 'goals.md']);

  const specRecPath = path.join(bundleDir, 'gate-spec-receipt.json');
  fs.writeFileSync(specRecPath, JSON.stringify({
    gate: 'spec',
    hash: sHash,
    artifacts: sArtifacts,
    dispatch_id: 'disp-spec-1',
    provider: 'test',
    model: 'test-model',
    output_tokens: 10,
    status: 'done',
    ts: '2026-01-01T00:00:00Z',
    digest: 'spec review: approved',
  }));
  const rSpecRec = run([
    'record-gate-review',
    `--state=${statePath}`,
    '--gate=spec',
    '--status=done',
    `--receipt=${specRecPath}`,
  ]);
  assert.equal(rSpecRec.status, 0, `record-gate-review spec failed: ${rSpecRec.stderr}`);

  const rSetPlan = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.equal(rSetPlan.status, 0, `set-phase plan failed: ${rSetPlan.stderr}`);

  // Assertion: goals_frozen with an empty goal list at capture
  const evsCapture = readEvents(bundleDir);
  const frozen = evsCapture.find((e) => e.type === 'goals_frozen');
  assert.ok(frozen, 'goals_frozen event must be recorded at capture');
  assert.equal(frozen.data.goals_hash, goalsHash(ZERO_G_GOALS));
  assert.deepEqual(frozen.data.goals, [], 'goals_frozen must carry an empty goal list');
  assert.equal(readState(statePath).phase, 'plan');

  // 2. Plan gate: author plan.md and plan.index.json with NO goal coverage requirement
  write(bundleDir, 'plan.md', '# plan\n\n## Wave 1\nTask 1: implement feature\n');
  const planIdx = {
    schema_version: '6.0',
    tasks: [
      {
        id: 1,
        wave: 1,
        files: ['src/a.txt'],
        description: 'implement feature in src/a.txt',
        verify_commands: ['true'],
      },
    ],
  };
  const planIdxPath = path.join(bundleDir, 'plan.index.json');
  fs.writeFileSync(planIdxPath, JSON.stringify(planIdx, null, 2));

  // Assertion: no plan-gate goal coverage requirement
  const planErrors = validatePlanIndex(planIdx);
  assert.deepEqual(planErrors, [], 'validatePlanIndex must accept plan tasks with no goal fields');

  const rSeed = run(['seed-tasks', `--state=${statePath}`, `--plan-index=${planIdxPath}`]);
  assert.equal(rSeed.status, 0, `seed-tasks failed: ${rSeed.stderr}`);

  const ghPlan = run(['gate-hash', `--state=${statePath}`, '--gate=plan']);
  assert.equal(ghPlan.status, 0, `gate-hash plan failed: ${ghPlan.stderr}`);
  const { hash: pHash, artifacts: pArtifacts } = JSON.parse(ghPlan.stdout);
  assert.deepEqual(pArtifacts, ['spec.md', 'plan.md', 'plan.index.json']);

  const planRecPath = path.join(bundleDir, 'gate-plan-receipt.json');
  fs.writeFileSync(planRecPath, JSON.stringify({
    gate: 'plan',
    hash: pHash,
    artifacts: pArtifacts,
    dispatch_id: 'disp-plan-1',
    provider: 'test',
    model: 'test-model',
    output_tokens: 10,
    status: 'done',
    ts: '2026-01-01T00:00:00Z',
    digest: 'plan review: approved',
  }));
  const rPlanRec = run([
    'record-gate-review',
    `--state=${statePath}`,
    '--gate=plan',
    '--status=done',
    `--receipt=${planRecPath}`,
  ]);
  assert.equal(rPlanRec.status, 0, `record-gate-review plan failed: ${rPlanRec.stderr}`);

  const rSetExec = run(['set-phase', `--state=${statePath}`, '--phase=execute']);
  assert.equal(rSetExec.status, 0, `set-phase execute must advance without goal coverage: ${rSetExec.stderr}`);
  assert.equal(readState(statePath).phase, 'execute');

  // 3. Execute task 1 in WT
  write(WT, 'src/a.txt', 'Feature implemented\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'task 1: feature');
  const stExec = readState(statePath);
  stExec.tasks[0].status = 'done';
  writeState(statePath, stExec);

  // 4. Finish flow
  let op = finishStep({ statePath, now: 2000 });
  assert.equal(op.op, 'run_verify', JSON.stringify(op));

  // Answer verify with pass
  op = finishStep({ statePath, now: 2000, verify: 'pass', verifyOutputFile });

  // Assertion: verify_passed recorded at finish
  const evsVerify = readEvents(bundleDir);
  const vp = evsVerify.find((e) => e.type === 'verify_passed');
  assert.ok(vp, 'verify_passed must be recorded on the ledger at finish');
  assert.ok(vp.data.head_sha, 'verify_passed must carry head_sha computed from worktree');
  assert.ok(vp.data.diff_hash, 'verify_passed must carry diff_hash');
  assert.equal(vp.data.base, 'main');
  assert.ok(vp.data.verify_output_hash, 'verify_passed must carry verify_output_hash');

  if (op.op === 'write_retro') {
    fs.writeFileSync(op.path, '# retro\nall good\n');
    op = finishStep({ statePath, now: 2000 });
  }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));

  op = finishStep({ statePath, now: 2000, choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(op.group, 'release');

  op = finishStep({ statePath, now: 2000, deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(op.group, 'live_check');

  op = finishStep({ statePath, now: 2000, deployStepDone: { group: 'live_check', index: 0, exit: 0, digestFile: liveDigestFile } });
  assert.equal(op.op, 'run_final_check', JSON.stringify(op));

  return { op, vp };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('walk a zero-G document from capture to complete archive (design case 2 happy path)', () => {
  const fx = mkZeroGoalFixture({ slug: 'zg-complete' });
  const { bundleDir, statePath, liveDigestFile } = fx;
  const { op, vp } = walkToFinalCheck(fx);

  // Assertion: the final Intent receipt binds to verify_passed
  const finalReceipt = {
    goals_hash: goalsHash(ZERO_G_GOALS),
    head_sha: vp.data.head_sha,
    base_diff_hash: vp.data.base_diff_hash ?? vp.data.diff_hash,
    verify_output_hash: vp.data.verify_output_hash ?? 'sha256:vo',
    clean: true,
    deploy_base_sha: op.deploy_base_sha,
    deploy_chain_hash: op.deploy_chain_hash,
    live_check_digest: op.live_digest,
    intent_verdict: {
      verdict: 'met',
      evidence: 'the deployed service satisfies the zero-G intent block',
    },
    dispatch_id: 'disp-final-1',
    model: 'assessor',
    output_tokens: 128,
    ts: '2026-01-01T00:00:10Z',
  };

  // Anti-fabrication check: tampered branch facts are refused
  const tamperedReceipt = { ...finalReceipt, head_sha: 'deadbeef'.repeat(5) };
  const rTampered = run([
    'record-intent-check',
    `--state=${statePath}`,
    `--base-sha=${op.deploy_base_sha}`,
    `--deploy-chain-hash=${op.deploy_chain_hash}`,
    `--digest-file=${liveDigestFile}`,
    `--receipt=${JSON.stringify(tamperedReceipt)}`,
  ]);
  assert.equal(rTampered.status, 1, 'record-intent-check must refuse receipt with tampered head_sha');

  // Valid receipt bound to verify_passed records cleanly
  const rFin = run([
    'record-intent-check',
    `--state=${statePath}`,
    `--base-sha=${op.deploy_base_sha}`,
    `--deploy-chain-hash=${op.deploy_chain_hash}`,
    `--digest-file=${liveDigestFile}`,
    `--receipt=${JSON.stringify(finalReceipt)}`,
  ]);
  assert.equal(rFin.status, 0, `record-intent-check failed: ${rFin.stderr}`);

  const evsFinal = readEvents(bundleDir);
  const gcEvent = evsFinal.reverse().find((e) => e.type === 'goal_check' && e.data?.final === true);
  assert.ok(gcEvent, 'goal_check event with final: true must be recorded');
  assert.equal(gcEvent.data.head_sha, vp.data.head_sha);
  assert.equal(gcEvent.data.base_diff_hash, vp.data.base_diff_hash ?? vp.data.diff_hash);

  // Assertion: intent_confirm opens on met
  let nextOp = finishStep({ statePath, now: 2000 });
  assert.equal(nextOp.gate, 'intent_confirm', JSON.stringify(nextOp));
  assert.equal(readState(statePath).pending_gate?.id, 'intent_confirm');

  // Confirm intent
  nextOp = finishStep({ statePath, now: 2000, intentConfirmed: true });

  // Step until archived
  for (let i = 0; i < 10 && readState(statePath).status !== 'archived'; i++) {
    nextOp = finishStep({ statePath, now: 2000 });
  }

  // Assertion: archive completion class 'complete'
  const finalState = readState(statePath);
  assert.equal(finalState.status, 'archived');
  assert.equal(finalState.completion, 'complete');
});

test('a partial verdict on a zero-G run opens intent_unmet and can never archive complete', () => {
  const fx = mkZeroGoalFixture({ slug: 'zg-partial' });
  const { bundleDir, statePath, liveDigestFile } = fx;
  const { op, vp } = walkToFinalCheck(fx);

  // Record a partial verdict
  const partialReceipt = {
    goals_hash: goalsHash(ZERO_G_GOALS),
    head_sha: vp.data.head_sha,
    base_diff_hash: vp.data.base_diff_hash ?? vp.data.diff_hash,
    verify_output_hash: vp.data.verify_output_hash ?? 'sha256:vo',
    clean: true,
    deploy_base_sha: op.deploy_base_sha,
    deploy_chain_hash: op.deploy_chain_hash,
    live_check_digest: op.live_digest,
    intent_verdict: {
      verdict: 'partial',
      evidence: 'deployed service only partially met the intent block',
    },
    dispatch_id: 'disp-final-part',
    model: 'assessor',
    output_tokens: 128,
    ts: '2026-01-01T00:00:10Z',
  };

  const rFin = run([
    'record-intent-check',
    `--state=${statePath}`,
    `--base-sha=${op.deploy_base_sha}`,
    `--deploy-chain-hash=${op.deploy_chain_hash}`,
    `--digest-file=${liveDigestFile}`,
    `--receipt=${JSON.stringify(partialReceipt)}`,
  ]);
  assert.equal(rFin.status, 0, `record-intent-check failed: ${rFin.stderr}`);

  // Assertion: opens intent_unmet
  let nextOp = finishStep({ statePath, now: 2000 });
  assert.equal(nextOp.gate, 'intent_unmet', JSON.stringify(nextOp));
  assert.equal(nextOp.mode, 'final');
  assert.equal(readState(statePath).pending_gate?.id, 'intent_unmet');

  // Assertion: can never archive 'complete'
  // 1) Answering intentConfirmed: true is refused
  assert.throws(
    () => finishStep({ statePath, now: 2000, intentConfirmed: true }),
    /no open intent_confirm gate/
  );

  // 2) Resolving with waiver archives as incomplete:intent_waived, never 'complete'
  nextOp = finishStep({ statePath, now: 2000, intentChoice: 'waiver' });
  for (let i = 0; i < 10 && readState(statePath).status !== 'archived'; i++) {
    nextOp = finishStep({ statePath, now: 2000 });
  }
  const finalState = readState(statePath);
  assert.equal(finalState.status, 'archived');
  assert.equal(finalState.completion, 'incomplete:intent_waived');
  assert.notEqual(finalState.completion, 'complete');
});
