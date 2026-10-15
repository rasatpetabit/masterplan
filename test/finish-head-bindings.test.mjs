// test/finish-head-bindings.test.mjs — finish-bindings-1 (review blocker): the binding
// source is selected FOR THE FINISH HEAD everywhere, never "latest event regardless of HEAD".
//
// Regression: a run verifies at A, then at B, then RETURNS to A. The pass answer at A appends
// nothing (a binding for A already stands — appendVerifyPassed is idempotent per HEAD). The
// run then merges/retires at A, so the finish HEAD (resolveFinishHead: the retired
// branch_finish branch_tip) is A: the run_final_check briefing, record-intent-check and
// finalReceiptFor's validation must all bind to A's event, and a receipt carrying B's facts
// is refused.
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

function specGateHash(bundleDir) {
  const h = createHash('sha256');
  for (const rel of ['spec.md', 'goals.md']) {
    h.update(rel); h.update('\0'); h.update(fs.readFileSync(path.join(bundleDir, rel))); h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

const GOALS_MD = [
  'topic: |',
  '  bind every final assessment to the retired finish head',
  '',
  '## Intent',
  'why: latest-regardless-of-HEAD selection binds verdicts to facts of a different commit',
  'outcome: briefing, recording and validation all bind to the retired tip',
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

function mkFixture({ slug = 'fhb' } = {}) {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-finishhead-'));
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
  fs.appendFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify({
    type: 'spec_adversary_review', ts: '2026-01-01T00:00:00Z',
    data: { hash: specGateHash(bundleDir), count: 0, base: 'main' },
  })}\n`);
  const step = (extra = {}) => finishStep({ statePath, now: 2000, ...extra });
  const verifyOut = path.join(tmp, 'verify-output.txt');
  fs.writeFileSync(verifyOut, 'suite green\n');
  const liveDigestFile = path.join(tmp, 'live-digest.txt');
  fs.writeFileSync(liveDigestFile, 'the deployment is live\n');
  const verifyPassedEvents = () => readEvents(bundleDir).filter((e) => e.type === 'verify_passed');
  return { tmp, MAIN, WT, bundleDir, statePath, step, verifyOut, liveDigestFile, verifyPassedEvents };
}

test('verify at A, then B, then return to A: everything binds to A (finish-bindings-1)', () => {
  const fx = mkFixture({ slug: 'fhb-aba' });
  const { MAIN, WT, bundleDir, statePath, step, verifyOut, liveDigestFile } = fx;
  const headA = git(WT, 'rev-parse', 'HEAD');

  // 1. Verify at A: the pass answer (with its output file) records verify_passed@A.
  let op = step();
  assert.equal(op.op, 'run_verify', JSON.stringify(op));
  op = step({ verify: 'pass', verifyOutputFile: verifyOut });
  assert.equal(fx.verifyPassedEvents().length, 1);
  assert.equal(fx.verifyPassedEvents()[0].data.head_sha, headA);

  // 2. Move to B and verify there: a second verify_passed@B is recorded.
  write(WT, 'src/b.txt', 'B\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'commit B');
  const headB = git(WT, 'rev-parse', 'HEAD');
  op = step();
  assert.equal(op.op, 'run_verify', 'the moved HEAD re-arms verification');
  op = step({ verify: 'pass', verifyOutputFile: verifyOut });
  assert.equal(fx.verifyPassedEvents().length, 2);
  assert.equal(fx.verifyPassedEvents()[1].data.head_sha, headB);

  // 3. Return to A: the pass answer appends NOTHING (a binding for A already stands).
  git(WT, 'reset', '--hard', headA);
  op = step();
  assert.equal(op.op, 'run_verify', 'verified_sha was B; the return to A re-arms verification');
  op = step({ verify: 'pass', verifyOutputFile: verifyOut });
  assert.equal(fx.verifyPassedEvents().length, 2, 'the pass at A appends nothing — idempotent per HEAD');
  assert.equal(readState(statePath).verified_sha, headA);

  // 4. Retire at A (merge): the durable branch_finish record carries branch_tip = A.
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = step(); }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  op = step({ choice: 'merge' });
  const retire = readEvents(bundleDir).filter((e) => e.type === 'branch_finish').pop();
  assert.ok(retire, 'branch_finish recorded');
  assert.equal(retire.branch_tip, headA, 'the retirement tip is A — the finish HEAD');

  // 5. Deploy to the final assessment: the run_final_check BRIEFING binds to A.
  op = step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.group, 'live_check', JSON.stringify(op));
  op = step({ deployStepDone: { group: 'live_check', index: 0, exit: 0, digestFile: liveDigestFile } });
  assert.equal(op.op, 'run_final_check', JSON.stringify(op));
  assert.equal(op.branch_binding.head_sha, headA, 'the briefing carries A\'s binding — never B\'s (the latest event)');
  const bindingA = fx.verifyPassedEvents().find((e) => e.data.head_sha === headA).data;
  const bindingB = fx.verifyPassedEvents().find((e) => e.data.head_sha === headB).data;

  const receiptFor = (binding, over = {}) => JSON.stringify({
    goals_hash: goalsHash(GOALS_MD),
    head_sha: binding.head_sha,
    base_diff_hash: binding.base_diff_hash ?? binding.diff_hash,
    verify_output_hash: binding.verify_output_hash,
    clean: true,
    deploy_base_sha: op.deploy_base_sha,
    deploy_chain_hash: op.deploy_chain_hash,
    live_check_digest: op.live_digest,
    intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
    dispatch_id: 'disp-final-1',
    model: 'assessor',
    output_tokens: 256,
    ts: '2026-01-01T00:00:10Z',
    ...over,
  });
  const recorderFlags = [
    'record-intent-check', `--state=${statePath}`,
    `--base-sha=${op.deploy_base_sha}`, `--deploy-chain-hash=${op.deploy_chain_hash}`,
    `--digest-file=${liveDigestFile}`,
  ];

  // 6. RECORDING refuses a receipt carrying B's facts; accepts A's.
  const bFacts = run([...recorderFlags, `--receipt=${receiptFor(bindingB)}`]);
  assert.notEqual(bFacts.status, 0, 'a receipt carrying B\'s facts must be refused');
  assert.match(bFacts.stderr, /finish head|head_sha/);
  assert.equal(readEvents(bundleDir).some((e) => e.type === 'goal_check' && e.data?.final === true), false);
  const aFacts = run([...recorderFlags, `--receipt=${receiptFor(bindingA)}`]);
  assert.equal(aFacts.status, 0, aFacts.stderr);

  // 7. VALIDATION: the recorded A-bound receipt opens intent_confirm (finalReceiptFor
  //    re-derives the binding for the finish head on re-entry).
  op = step();
  assert.equal(op.gate, 'intent_confirm', JSON.stringify(op));
  const gc = readEvents(bundleDir).find((e) => e.type === 'goal_check' && e.data?.final === true);
  assert.equal(gc.data.head_sha, headA, 'the recorded final assessment binds to A');
});

test('a hashless verify_passed at the finish HEAD is repaired by re-verification, never stranded (finish-bindings-2 recovery)', () => {
  const fx = mkFixture({ slug: 'fhb-hashless' });
  const { WT, bundleDir, statePath, step, verifyOut } = fx;
  const head = git(WT, 'rev-parse', 'HEAD');

  // The exact shape the pre-fix revision (cc4ac9c) emitted for an output-less pass answer:
  // a verify_passed for this HEAD with no verify_output_hash, and verified_sha already at HEAD.
  fs.appendFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify({
    type: 'verify_passed', ts: '2026-01-01T00:00:01Z',
    data: { head_sha: head, base: 'main', diff_hash: 'sha256:legacy' },
  })}\n`);
  writeState(statePath, { ...readState(statePath), verified_sha: head });

  // The incomplete event is not a binding source, so the verified-at-SHA skip does NOT apply.
  let op = step();
  assert.equal(op.op, 'run_verify', `an incomplete binding must re-arm verification: ${JSON.stringify(op)}`);

  // Re-verification records a COMPLETE binding instead of being suppressed by the incomplete one.
  op = step({ verify: 'pass', verifyOutputFile: verifyOut });
  const complete = fx.verifyPassedEvents().filter((e) => e.data.head_sha === head
    && typeof e.data.verify_output_hash === 'string' && e.data.verify_output_hash !== '');
  assert.equal(complete.length, 1, 'a complete verify_passed for the finish HEAD is recorded');

  // And the run proceeds past verification (no further run_verify at an unchanged HEAD).
  op = step();
  assert.notEqual(op.op, 'run_verify', JSON.stringify(op));
});
