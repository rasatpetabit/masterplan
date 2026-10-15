// test/assessor-outage.test.mjs — B1 (review blocker): an mp-intent-assessor outage at the
// FIRST final assessment is reachable. The old prompt said a manual (user-attested) receipt
// is recorded "only at the intent_unmet gate" — but intent_unmet only OPENS over a recorded
// partial/missed receipt, so an assessor outage at the first assessment deadlocked the run.
//
// The settled path: after one retry, the operator's own verdict (met|partial|missed) with
// evidence is recorded via `mp record-intent-check` with the EXISTING user-attested
// provenance (attested_by:'user' + approval_receipt), and a bare finish-step re-entry opens
// the correct gate: met -> intent_confirm, partial|missed -> intent_unmet. No fabricated
// assessor receipt is needed — and an assessor-shaped receipt without dispatch provenance is
// still refused.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { finishStep } from '../lib/finish-step.mjs';
import { writeState, readState } from '../lib/bundle.mjs';
import { goalsHash } from '../lib/goals.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

const FIXTURE_TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  FIXTURE_TMPDIRS.push(dir);
  return dir;
}
after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
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
function readEvents(bundleDir) {
  try {
    return fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function run(args) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8' }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const GOALS_MD = [
  'topic: |',
  '  the first final assessment is reachable without a fabricated receipt',
  '',
  '## Intent',
  'why: an assessor outage deadlocked the finish when no receipt existed to open any gate',
  'outcome: the operator attested verdict opens the correct gate',
  'done_means: release and a live check',
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

function mkFixture({ slug = 'ao' } = {}) {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-assessorout-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  write(MAIN, '.gitignore', '.worktrees/\n');
  write(MAIN, '.masterplan.yaml', DONE_WITH_LIVE);
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
    pending_gate: null, active_run: null, goals_enabled: true, autonomy: 'loose',
    review: { adversary: false }, concurrency: { owner_lock: 'off' },
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
  });
  write(bundleDir, 'goals.md', GOALS_MD);
  write(bundleDir, 'spec.md', '# spec\nbuild it\n');
  fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({ tasks: [{ id: 1, verify_commands: ['true'] }] }));
  const h = createHash('sha256');
  for (const rel of ['spec.md', 'goals.md']) {
    h.update(rel); h.update('\0'); h.update(fs.readFileSync(path.join(bundleDir, rel))); h.update('\0');
  }
  fs.appendFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify({
    type: 'spec_adversary_review', ts: '2026-01-01T00:00:00Z',
    data: { hash: `sha256:${h.digest('hex')}`, count: 0, base: 'main' },
  })}\n`);
  const verifyOut = path.join(tmp, 'verify-output.txt');
  fs.writeFileSync(verifyOut, 'suite green\n');
  const liveDigestFile = path.join(tmp, 'live-digest.txt');
  fs.writeFileSync(liveDigestFile, 'the deployment is live\n');
  const step = (extra = {}) => finishStep({ statePath, now: 2000, ...extra });
  const branchBinding = () => [...readEvents(bundleDir)].reverse().find((e) => e.type === 'verify_passed')?.data ?? null;
  return { tmp, MAIN, WT, bundleDir, statePath, step, verifyOut, liveDigestFile, branchBinding };
}

// Walk to run_final_check — the point where the sequencer would dispatch mp-intent-assessor.
function walkToFinalCheck(fx) {
  let op = fx.step();
  assert.equal(op.op, 'run_verify', JSON.stringify(op));
  op = fx.step({ verify: 'pass', verifyOutputFile: fx.verifyOut });
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = fx.step(); }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  op = fx.step({ choice: 'merge' });
  assert.equal(op.group, 'release', JSON.stringify(op));
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.group, 'live_check', JSON.stringify(op));
  op = fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0, digestFile: fx.liveDigestFile } });
  assert.equal(op.op, 'run_final_check', JSON.stringify(op));
  return op;
}

// The USER-ATTESTED receipt the settled outage path records: the same final receipt shape,
// with provenance in the user-attested half only (attested_by:'user' + approval_receipt).
function userAttestedReceipt(fx, op, verdict, evidence) {
  const binding = fx.branchBinding();
  assert.ok(binding, 'the walk recorded the verify_passed branch binding');
  return JSON.stringify({
    goals_hash: goalsHash(GOALS_MD),
    head_sha: binding.head_sha,
    base_diff_hash: binding.base_diff_hash ?? binding.diff_hash,
    verify_output_hash: binding.verify_output_hash,
    clean: true,
    deploy_base_sha: op.deploy_base_sha,
    deploy_chain_hash: op.deploy_chain_hash,
    live_check_digest: op.live_digest,
    intent_verdict: { verdict, evidence },
    attested_by: 'user',
    approval_receipt: {
      attested_by: 'user',
      purpose: 'goal_check',
      goals_hash: goalsHash(GOALS_MD),
      question: 'The intent assessor is unavailable (dispatch failed twice). What is the Intent verdict for this deployment?',
      answer: `${verdict} — ${evidence}`,
      ts: '2026-01-01T00:00:10Z',
    },
    ts: '2026-01-01T00:00:10Z',
  });
}

test('first final assessment unavailable: the operator-attested met verdict opens intent_confirm (B1)', () => {
  const fx = mkFixture({ slug: 'ao-met' });
  const op = walkToFinalCheck(fx);
  // The dispatch failed twice; the sequencer AUQed the operator and records her verdict.
  const r = run([
    'record-intent-check', `--state=${fx.statePath}`,
    `--base-sha=${op.deploy_base_sha}`, `--deploy-chain-hash=${op.deploy_chain_hash}`,
    `--digest-file=${fx.liveDigestFile}`,
    `--receipt=${userAttestedReceipt(fx, op, 'met', 'the live check shows the deployed surface answering the intended outcome (operator-attested)')}`,
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).provenance_kind, 'user', 'the receipt is recorded as user-attested, never as assessor provenance');
  // A bare re-entry opens the CORRECT gate for a met verdict.
  const next = fx.step();
  assert.equal(next.gate, 'intent_confirm', JSON.stringify(next));
  assert.equal(readState(fx.statePath).pending_gate?.id, 'intent_confirm');
});

test('first final assessment unavailable: the operator-attested partial verdict opens intent_unmet (B1)', () => {
  const fx = mkFixture({ slug: 'ao-partial' });
  const op = walkToFinalCheck(fx);
  const r = run([
    'record-intent-check', `--state=${fx.statePath}`,
    `--base-sha=${op.deploy_base_sha}`, `--deploy-chain-hash=${op.deploy_chain_hash}`,
    `--digest-file=${fx.liveDigestFile}`,
    `--receipt=${userAttestedReceipt(fx, op, 'partial', 'the deployment covers half the intended outcome (operator-attested)')}`,
  ]);
  assert.equal(r.status, 0, r.stderr);
  // No fabricated receipt was needed to OPEN intent_unmet: the operator's own attestation did.
  const next = fx.step();
  assert.equal(next.gate, 'intent_unmet', JSON.stringify(next));
  assert.equal(next.mode, 'final');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'intent_unmet');
});

test('an assessor-shaped receipt without dispatch provenance is still refused (B1)', () => {
  const fx = mkFixture({ slug: 'ao-fake' });
  const op = walkToFinalCheck(fx);
  const binding = fx.branchBinding();
  // The fabrication attempt: provenance_kind/data shaped like the assessor record, but no
  // flat dispatch_id/model/output_tokens — the validator's exactly-one-shape rule refuses it.
  const fake = JSON.stringify({
    goals_hash: goalsHash(GOALS_MD),
    head_sha: binding.head_sha,
    base_diff_hash: binding.base_diff_hash ?? binding.diff_hash,
    verify_output_hash: binding.verify_output_hash,
    clean: true,
    deploy_base_sha: op.deploy_base_sha,
    deploy_chain_hash: op.deploy_chain_hash,
    live_check_digest: op.live_digest,
    intent_verdict: { verdict: 'met', evidence: 'fabricated assessor availability' },
    provenance_kind: 'assessor',
    provenance: { dispatch_id: 'disp-fake', model: 'assessor', output_tokens: 256 },
    ts: '2026-01-01T00:00:10Z',
  });
  const r = run([
    'record-intent-check', `--state=${fx.statePath}`,
    `--base-sha=${op.deploy_base_sha}`, `--deploy-chain-hash=${op.deploy_chain_hash}`,
    `--digest-file=${fx.liveDigestFile}`,
    `--receipt=${fake}`,
  ]);
  assert.notEqual(r.status, 0, 'a receipt claiming assessor provenance without dispatch members is refused');
  assert.match(r.stderr, /dispatch_id|provenance/);
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'goal_check' && e.data?.final === true), false,
    'the fabricated receipt never reached the ledger');
});
