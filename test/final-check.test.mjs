// test/final-check.test.mjs — the post-deploy FINAL assessment transition (wave task 27).
//
// The implementation assessment judges the branch diff before the disposition. This one judges
// what was actually DEPLOYED: it runs after the live check, binds its receipt to the deploy
// base, the deploy-event chain and the live-check digest, and gates the archive on the
// operator's own answer to "does this do what you meant?".
//
// Every fixture is a real git repo driven through the real finish-step machine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { finishStep } from '../lib/finish-step.mjs';
import { deployChainHash, liveCheckDigest } from '../lib/finish.mjs';
import { writeState, readState } from '../lib/bundle.mjs';
import { goalsHash } from '../lib/goals.mjs';

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
function readEvents(bundleDir) {
  try {
    return fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function appendEvent(bundleDir, rec) {
  fs.appendFileSync(path.join(bundleDir, 'events.jsonl'), `${JSON.stringify(rec)}\n`);
}
const latest = (fx, t) => [...readEvents(fx.bundleDir)].reverse().find((e) => e.type === t) ?? null;

const GOALS_MD = [
  'topic: |',
  '  prove the deploy actually happened',
  '',
  '## Intent',
  'why: runs archive without proving anything shipped',
  'outcome: a run archives complete only when the thing is live',
  'anti_goals: a green suite standing in for a deployment',
  'done_means: release and a live check',
  '',
  '## G1: the deploy stage runs',
  '## G2: the live check gates the archive',
  '## G3: the operator confirms intent',
  '',
].join('\n');

function specGateHash(bundleDir) {
  const h = createHash('sha256');
  for (const rel of ['spec.md', 'goals.md']) {
    h.update(rel); h.update('\0'); h.update(fs.readFileSync(path.join(bundleDir, rel))); h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

// A goals-enabled bundle whose `done:` block the caller chooses, walked to the point where the
// deploy stage is about to run.
const DONE_WITH_LIVE = [
  'done:',
  '  release:',
  '    - run: /bin/true',
  '  live_check:',
  '    - run: /bin/true',
  '      check: /bin/true',
  '',
].join('\n');

function mkFixture({ slug = 'fc', done = DONE_WITH_LIVE, goalsMd = GOALS_MD } = {}) {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-finalcheck-'));
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
  write(bundleDir, 'goals.md', goalsMd);
  write(bundleDir, 'spec.md', '# spec\nbuild it\n');
  fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({ tasks: [{ id: 1, verify_commands: ['true'] }] }));
  // Satisfy the spec gate at the CURRENT spec+goals hash.
  appendEvent(bundleDir, {
    type: 'spec_adversary_review', ts: '2026-01-01T00:00:00Z',
    data: { hash: specGateHash(bundleDir), count: 0, base: 'main' },
  });
  const gHash = goalsHash(goalsMd);
  const step = (extra = {}) => finishStep({ statePath, now: 2000, ...extra });

  // The implementation assessment, so the run reaches the deploy stage at all.
  const recordImplementationCheck = () => appendEvent(bundleDir, {
    type: 'goal_check', ts: '2026-01-01T00:00:01Z',
    data: {
      goals_hash: gHash, head_sha: git(WT, 'rev-parse', 'HEAD'), base: 'main',
      diff_hash: 'sha256:diff', verify_output_hash: 'sha256:vo', provenance_kind: 'assessor',
      verdicts: { G1: { verdict: 'achieved' }, G2: { verdict: 'achieved' }, G3: { verdict: 'achieved' } },
    },
  });

  // Captured now: the disposition tears the worktree down, so it cannot be read later.
  const headAtBuild = git(WT, 'rev-parse', 'HEAD');
  return { tmp, MAIN, WT, bundleDir, statePath, step, gHash, headAtBuild, recordImplementationCheck };
}

// verify -> retro -> branch_finish -> merge, landing in the deploy stage.
function walkToDeploy(fx) {
  fx.recordImplementationCheck();
  let op = fx.step();
  assert.equal(op.op, 'run_verify', JSON.stringify(op));
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') {
    fs.writeFileSync(op.path, '# retro\n');
    op = fx.step();
  }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  return fx.step({ choice: 'merge' });
}

// Run the whole deploy chain: the release step, then the live check WITH its digest — the
// evidence the final verdict is bound to. Returns the op the stage leaves behind.
function runDeployChain(fx, { liveDigestText = 'live check output\n' } = {}) {
  let op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.group, 'live_check', JSON.stringify(op));
  const digestFile = path.join(fx.tmp, 'live-digest.txt');
  fs.writeFileSync(digestFile, liveDigestText);
  return fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0, digestFile } });
}

// Record a final goal_check receipt bound to the deployment the op names.
// A COMPLETE final receipt — the shape a real recorder writes, because the machine hands each
// candidate to lib/goals.mjs's validator and a partial one is not a final assessment.
function recordFinalCheck(fx, op, { verdict = 'met', evidence = 'the deployed surface answers as intended', over = {} } = {}) {
  appendEvent(fx.bundleDir, {
    type: 'goal_check', ts: '2026-01-01T00:00:09Z',
    data: {
      final: true,
      goals_hash: fx.gHash,
      head_sha: fx.headAtBuild,
      base_diff_hash: 'sha256:diff',
      verify_output_hash: 'sha256:vo',
      clean: true,
      deploy_base_sha: op.deploy_base_sha,
      deploy_chain_hash: op.deploy_chain_hash,
      live_check_digest: op.live_digest,
      provenance_kind: 'assessor',
      provenance: { dispatch_id: 'disp-final-1', model: 'assessor', output_tokens: 256 },
      verdicts: {
        G1: { verdict: 'achieved', evidence: 'the stage ran' },
        G2: { verdict: 'achieved', evidence: 'the live check gated the archive' },
        G3: { verdict: 'achieved', evidence: 'the operator was asked' },
      },
      intent_verdict: { verdict, evidence },
      ...over,
    },
  });
}

// ---------------------------------------------------------------------------
// run_final_check
// ---------------------------------------------------------------------------

test('the final check is requested after the deploy stage, bound to what was deployed', () => {
  const fx = mkFixture();
  let op = walkToDeploy(fx);
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  op = runDeployChain(fx);

  // The stage is complete, so the FINAL assessment is what comes next — not the archive.
  assert.equal(op.op, 'run_final_check', JSON.stringify(op));
  const base = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_base');
  assert.equal(op.deploy_base_sha, base.sha, 'bound to the base the stage ran on');
  // The chain is this base's receipts, and its hash is computed from them — not asserted from
  // the op's own value, which would prove nothing.
  assert.deepEqual(op.deploy_chain.map((c) => c.group), ['release', 'live_check']);
  assert.equal(op.deploy_chain_hash, deployChainHash(op.deploy_chain));
  // The live digest is the CONTENT of what the check observed, so the same output digests the
  // same however the operator routed it to a file.
  assert.equal(op.live_digest, liveCheckDigest(path.join(fx.tmp, 'live-digest.txt')));
  assert.equal(op.goals_path, path.join(fx.bundleDir, 'goals.md'));
  assert.match(op.next, /record-goal-check --final/);
  // Nothing is archived while the final answer is outstanding.
  assert.notEqual(readState(fx.statePath).status, 'archived');
});

test('re-entry re-requests the same final check and appends nothing', () => {
  const fx = mkFixture();
  walkToDeploy(fx);
  const first = runDeployChain(fx);
  assert.equal(first.op, 'run_final_check', JSON.stringify(first));
  const before = readEvents(fx.bundleDir).length;
  const again = fx.step();
  assert.equal(again.op, 'run_final_check');
  assert.equal(again.deploy_chain_hash, first.deploy_chain_hash, 'the same deployment');
  assert.equal(readEvents(fx.bundleDir).length, before, 're-entry appends nothing');
});

test('a receipt bound to a DIFFERENT deployment does not satisfy the final check', () => {
  const fx = mkFixture();
  walkToDeploy(fx);
  const op = runDeployChain(fx);
  // Right shape, wrong deployment: each binding is tried on its own.
  for (const wrong of [
    { deploy_base_sha: 'f'.repeat(40) },
    { deploy_chain_hash: 'sha256:some-other-chain' },
    { live_check_digest: 'sha256:some-other-live' },
  ]) {
    recordFinalCheck(fx, op, { over: wrong });
    assert.equal(fx.step().op, 'run_final_check', `${JSON.stringify(wrong)} must not satisfy the check`);
  }
});

// ---------------------------------------------------------------------------
// intent_confirm
// ---------------------------------------------------------------------------

test('a met intent verdict opens intent_confirm, carrying the verdict and the live digest', () => {
  const fx = mkFixture();
  walkToDeploy(fx);
  const op = runDeployChain(fx);
  recordFinalCheck(fx, op);
  const confirm = fx.step();
  assert.equal(confirm.gate, 'intent_confirm', JSON.stringify(confirm));
  assert.equal(confirm.intent_verdict.verdict, 'met');
  assert.equal(confirm.deploy_base_sha, op.deploy_base_sha);
  assert.equal(confirm.live_check_digest, op.live_digest);
  assert.deepEqual(confirm.choices, ['confirmed', 'rejected']);
  // The gate is DURABLE: the archive waits on the operator, not on this process.
  assert.equal(readState(fx.statePath).pending_gate.id, 'intent_confirm');
  assert.notEqual(readState(fx.statePath).status, 'archived');
  // ...and re-entry re-renders it rather than progressing.
  assert.equal(fx.step().gate, 'intent_confirm');
});

// ---------------------------------------------------------------------------
// A partial or missed final verdict
// ---------------------------------------------------------------------------

test('a partial or missed final verdict opens goals_unmet WITHOUT a fix option', () => {
  for (const verdict of ['partial', 'missed']) {
    const fx = mkFixture({ slug: `fc-${verdict}` });
    walkToDeploy(fx);
    const op = runDeployChain(fx);
    recordFinalCheck(fx, op, { verdict, evidence: 'the deployed thing does not do what was meant' });
    const gate = fx.step();
    assert.equal(gate.gate, 'goals_unmet', JSON.stringify(gate));
    assert.equal(gate.mode, 'final', 'the post-live mode, not the implementation one');
    // Post-live the worktree is gone, so `fix` is not on offer — only waiver, abort, or a
    // rejection that names a successor.
    assert.deepEqual(gate.choices, ['waiver', 'abort', 'reject-intent']);
    assert.equal(gate.choices.includes('fix'), false);
    assert.equal(gate.intent_verdict.verdict, verdict);
    assert.notEqual(readState(fx.statePath).status, 'archived');
  }
});

test('a met verdict never opens goals_unmet', () => {
  const fx = mkFixture();
  walkToDeploy(fx);
  const op = runDeployChain(fx);
  recordFinalCheck(fx, op, { verdict: 'met' });
  assert.equal(fx.step().gate, 'intent_confirm');
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'gate_opened' && e.id === 'goals_unmet'), false);
});

// ---------------------------------------------------------------------------
// The boundary is re-audited before both the assessment and the confirmation
// ---------------------------------------------------------------------------

test('a base that moved is refused before the final assessment', () => {
  const fx = mkFixture();
  walkToDeploy(fx);
  runDeployChain(fx);
  // Something else commits on MAIN after the stage completed: the thing about to be assessed
  // is no longer the thing that was deployed.
  write(fx.MAIN, 'src/foreign.js', 'someone else\n');
  git(fx.MAIN, 'add', 'src/foreign.js');
  git(fx.MAIN, 'commit', '-q', '-m', 'foreign commit after the stage');
  assert.throws(() => fx.step(), /base moved/);
});

test('a base that moved between the assessment and the confirmation is refused', () => {
  const fx = mkFixture();
  walkToDeploy(fx);
  const op = runDeployChain(fx);
  recordFinalCheck(fx, op);
  // The receipt is in hand, but the base moves before the operator confirms.
  write(fx.MAIN, 'src/foreign.js', 'someone else\n');
  git(fx.MAIN, 'add', 'src/foreign.js');
  git(fx.MAIN, 'commit', '-q', '-m', 'foreign commit before the confirmation');
  assert.throws(() => fx.step(), /base moved/);
  assert.equal(readState(fx.statePath).pending_gate?.id !== 'intent_confirm', true, 'the gate never opened');
});

// ---------------------------------------------------------------------------
// done: none
// ---------------------------------------------------------------------------

test('done: none deploys nothing, so no final assessment is issued', () => {
  const fx = mkFixture({ slug: 'fc-none', done: 'done: none\n' });
  const op = walkToDeploy(fx);
  // Its chain is empty and it has no live evidence, so there is nothing for an intent verdict
  // to be bound to. Such a run archives `merged` (§7.1) — never `complete` — so the class
  // already records what happened; issuing an unbindable assessment would add nothing.
  assert.notEqual(op.op, 'run_final_check', JSON.stringify(op));
  assert.equal(deployChainHash([]), deployChainHash([]), 'the empty chain hash is well-defined');
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'deploy_step'), false, 'no group ran');
});

test('a deployed run whose live check recorded no digest is refused, not completed', () => {
  // The gap this closes: a null live digest must NOT read the same as `done: none`. A run that
  // declared a live check and produced no evidence has an unbindable verdict.
  const fx = mkFixture({
    slug: 'fc-nodigest',
    done: 'done:\n  release:\n    - run: /bin/true\n  live_check:\n    - run: /bin/true\n      check: /bin/true\n',
  });
  walkToDeploy(fx);
  let op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.group, 'live_check');
  // Reported WITHOUT a digest file.
  op = fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0 } });
  assert.equal(op.gate, 'live_check_evidence_missing', JSON.stringify(op));
  assert.match(op.reason, /recorded no digest/);
  assert.notEqual(readState(fx.statePath).status, 'archived');
});

test('a deployed definition that declares no live_check at all is refused', () => {
  const fx = mkFixture({ slug: 'fc-nolive', done: 'done:\n  release:\n    - run: /bin/true\n' });
  walkToDeploy(fx);
  const op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  // §7.1 makes live_check mandatory for a deployed run; without it there is no evidence to
  // bind an intent verdict to, and silently completing would claim one.
  assert.equal(op.gate, 'live_check_evidence_missing', JSON.stringify(op));
  assert.match(op.reason, /declares no live_check group/);
});

// ---------------------------------------------------------------------------
// A bundle without goals
// ---------------------------------------------------------------------------

test('a bundle with no goals has no intent to assess and archives as before', () => {
  const fx = mkFixture({ slug: 'fc-nogoals' });
  // Strip the goals capability: there is no intent statement to judge.
  const st = readState(fx.statePath);
  writeState(fx.statePath, { ...st, goals_enabled: false });
  fs.rmSync(path.join(fx.bundleDir, 'goals.md'));
  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = fx.step(); }
  assert.equal(op.gate, 'branch_finish');
  op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  op = runDeployChain(fx);
  // No final check is requested, and the run reaches its archive.
  assert.notEqual(op.op, 'run_final_check', JSON.stringify(op));
  assert.equal(op.reason, 'archived', JSON.stringify(op));
});

test('the intent_confirm ANSWER re-audits the base: a move refuses the confirmation', () => {
  // The gate is durable, so an operator can answer it minutes or days after it opened. Between
  // those two moments MAIN can move. Auditing only when the gate OPENS would let the answer
  // complete a run against a deployment that is no longer what is deployed — the confirmation
  // path has to re-audit for itself.
  const fx = mkFixture({ slug: 'fc-answer-race' });
  const op = walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { verdict: 'met' });
  const gate = fx.step();
  assert.equal(gate.gate, 'intent_confirm', JSON.stringify(gate));
  assert.equal(readState(fx.statePath).pending_gate?.id, 'intent_confirm');
  const before = readEvents(fx.bundleDir).length;

  // Someone else lands on MAIN while the gate sits open.
  write(fx.MAIN, 'src/foreign.js', 'landed while the gate was open\n');
  git(fx.MAIN, 'add', 'src/foreign.js');
  git(fx.MAIN, 'commit', '-q', '-m', 'foreign commit while intent_confirm was open');

  assert.throws(() => fx.step({ intentConfirmed: true }), /base moved/);
  const after = readEvents(fx.bundleDir);
  assert.equal(after.length, before, 'a refused confirmation appends nothing');
  assert.equal(after.some((e) => e.type === 'completion_confirmed'), false);
  assert.equal(readState(fx.statePath).pending_gate?.id, 'intent_confirm', 'the gate stays open');
  assert.notEqual(readState(fx.statePath).status, 'archived');
  assert.ok(op);
});

test('the intent_confirm answer completes the run when the base has NOT moved', () => {
  // The positive half of the pair above: the same path, nothing moved, so the confirmation is
  // recorded and the gate closes. Without this a refusal that fired unconditionally would pass.
  const fx = mkFixture({ slug: 'fc-answer-ok' });
  walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { verdict: 'met' });
  assert.equal(fx.step().gate, 'intent_confirm');

  fx.step({ intentConfirmed: true });
  const confirmed = readEvents(fx.bundleDir).filter((e) => e.type === 'completion_confirmed');
  assert.equal(confirmed.length, 1, JSON.stringify(readEvents(fx.bundleDir).map((e) => e.type)));
  assert.equal(confirmed[0].intent_verdict, 'met', 'the verdict travels with the confirmation');
  assert.equal(readState(fx.statePath).pending_gate, null, 'the gate is closed');
});

test('--intent-confirmed is refused when no intent_confirm gate is open', () => {
  // The flag must not be a back door around the assessment: without the gate there is no
  // receipt binding a verdict to a deployment, so there is nothing to confirm.
  const fx = mkFixture({ slug: 'fc-answer-nogate' });
  walkToDeploy(fx);
  runDeployChain(fx);
  assert.throws(() => fx.step({ intentConfirmed: true }), /intent_confirm/);
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false);
});

// ---------------------------------------------------------------------------
// Adversary round 1 — the findings each of these closes is named in its comment.
// ---------------------------------------------------------------------------

// Walk a fixture to the point where a final gate is open, and hand back its op.
function walkToFinalGate(fx, { verdict = 'met' } = {}) {
  walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { verdict, ...(verdict === 'met' ? {} : { evidence: 'the deployed thing does not do what was meant' }) });
  return fx.step();
}

test('a confirmed run terminates — it reaches its archive, carrying the authorization', () => {
  // Finding: the tests asserted the confirmation EVENT but never that the run terminates, so a
  // machine that recorded the confirmation and then stalled would have passed.
  //
  // SCOPE: the persisted `state.completion` class is task 28's ("Enforce durable archive
  // authorization and completion classes", wave 6). What this task owns, and what is asserted
  // here, is the AUTHORIZING EVENT task 28 reads to write that class — and that the run does
  // not stall short of its archive.
  const fx = mkFixture({ slug: 'fc-terminal' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentConfirmed: true });
  let op = null;
  for (let i = 0; i < 8 && readState(fx.statePath).status !== 'archived'; i++) op = fx.step();
  assert.equal(readState(fx.statePath).status, 'archived', JSON.stringify(op));
  const evs = readEvents(fx.bundleDir);
  assert.equal(evs.filter((e) => e.type === 'completion_confirmed').length, 1);
  // Nothing bound it for an incomplete archive: the only authorization present is the
  // confirmation itself.
  assert.equal(evs.some((e) => e.type === 'incomplete_authorized'), false);
});

test('done: none archives WITHOUT a completion confirmation', () => {
  // Finding: asserting only that no final check was issued left the terminal state unproven.
  // A run that deployed nothing has no intent verdict to confirm, so the confirmation that
  // task 28 turns into `complete` must be absent — which is what makes its class `merged`.
  const fx = mkFixture({ slug: 'fc-none-class', done: 'done: none\n' });
  walkToDeploy(fx);
  for (let i = 0; i < 8 && readState(fx.statePath).status !== 'archived'; i++) fx.step();
  assert.equal(readState(fx.statePath).status, 'archived');
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false);
});

test('a receipt bound to this deployment but MALFORMED is invalid, not absent', () => {
  // Finding: the adapter used to synthesize `clean` and assessor provenance, so a receipt
  // carrying neither validated anyway. It must now be refused — and refused DISTINGUISHABLY,
  // because collapsing "invalid" into "not recorded yet" re-asks forever without saying why.
  for (const [label, over] of [
    ['no provenance', { provenance_kind: undefined, provenance: undefined }],
    ['no clean', { clean: undefined }],
    ['a malformed intent verdict', { intent_verdict: { verdict: 'yes-ish', evidence: 'e' } }],
    ['a stale goals hash', { goals_hash: 'sha256:' + 'f'.repeat(64) }],
  ]) {
    const fx = mkFixture({ slug: `fc-bad-${label.replace(/\W+/g, '-')}` });
    walkToDeploy(fx);
    const chk = runDeployChain(fx);
    recordFinalCheck(fx, chk, { over });
    const op = fx.step();
    assert.equal(op.gate, 'final_check_invalid', `${label}: ${JSON.stringify(op)}`);
    assert.ok(op.error, `${label}: the reason the receipt is invalid is reported`);
    assert.equal(readState(fx.statePath).pending_gate?.id, 'final_check_invalid', label);
    // Never confirmable, and never silently re-requested as if nothing had been recorded.
    assert.throws(() => fx.step({ intentConfirmed: true }), /INVALID|no open intent_confirm/, label);
    assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false, label);
  }
});

test('rejecting the intent at intent_confirm archives incomplete and names its successor', () => {
  // Finding: --intent-rejected was accepted as a parameter but had no handler at all, so the
  // `rejected` choice the gate advertised did nothing.
  const fx = mkFixture({ slug: 'fc-reject-confirm' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentRejected: { class: 'intent', reason: 'the goal was misread: it needed the CLI, not the library', successor: 'fc-successor' } });
  const rej = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized' && String(e.reason).startsWith('intent_rejected'));
  assert.ok(rej, JSON.stringify(readEvents(fx.bundleDir).map((e) => e.type)));
  assert.equal(rej.class, 'intent');
  assert.equal(rej.successor, 'fc-successor');
  // An intent-class rejection carries the correction the successor's interview starts from.
  assert.match(rej.correction, /needed the CLI/);
  assert.equal(readState(fx.statePath).pending_gate, null, 'the gate is closed');
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false);
  for (let i = 0; i < 8 && readState(fx.statePath).status !== 'archived'; i++) fx.step();
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false,
    'a rejected run carries no confirmation, so task 28 can never class it complete');
});

test('an implementation-class rejection carries no interview correction', () => {
  // "The build was wrong" is not "the goal was misunderstood": projecting its reason as a
  // correction would steer the successor's interview off a defect report.
  const fx = mkFixture({ slug: 'fc-reject-impl' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentRejected: { class: 'implementation', reason: 'the release script published the wrong artifact', successor: 'fc-successor-2' } });
  const rej = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized' && String(e.reason).startsWith('intent_rejected'));
  assert.equal(rej.class, 'implementation');
  assert.equal(rej.correction, undefined);
  assert.match(rej.rejection_reason, /wrong artifact/, 'the reason is still recorded');
});

test('the final goals_unmet gate accepts reject-intent and REFUSES fix', () => {
  // Finding: omitting `fix` from the rendered choices is not enforcement — a caller can submit
  // any flag, and post-live there is no worktree to fix in.
  const fx = mkFixture({ slug: 'fc-unmet-final' });
  const gate = walkToFinalGate(fx, { verdict: 'partial' });
  assert.equal(gate.gate, 'goals_unmet');
  assert.equal(gate.mode, 'final');
  assert.ok(!gate.choices.includes('fix'));
  const before = readEvents(fx.bundleDir).length;
  assert.throws(() => fx.step({ goalsChoice: 'fix' }), /not available on the final goals_unmet gate/);
  assert.equal(readEvents(fx.bundleDir).length, before, 'a refused answer writes nothing');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'goals_unmet', 'and leaves the gate open');

  fx.step({ intentRejected: { class: 'intent', reason: 'partial is not what was meant', successor: 'fc-successor-3' } });
  assert.ok(readEvents(fx.bundleDir).some((e) => e.type === 'incomplete_authorized' && String(e.reason).startsWith('intent_rejected')));
});

test('--intent-rejected requires a named successor and an open final gate', () => {
  const fx = mkFixture({ slug: 'fc-reject-guards' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  const before = readEvents(fx.bundleDir).length;
  assert.throws(
    () => fx.step({ intentRejected: { class: 'intent', reason: 'r', successor: '' } }),
    /named successor/,
  );
  assert.equal(readEvents(fx.bundleDir).length, before);

  // No open final gate at all.
  const clean = mkFixture({ slug: 'fc-reject-nogate' });
  walkToDeploy(clean);
  runDeployChain(clean);
  assert.throws(
    () => clean.step({ intentRejected: { class: 'intent', reason: 'r', successor: 's' } }),
    /no open intent_confirm or final goals_unmet gate/,
  );
});

test('the missing-live-evidence gate is DURABLE and its abort archives incomplete', () => {
  // Finding: the gate was a returned shape only — nothing was persisted, so a fresh process
  // found no pending_gate and no answer could reach it. It also offered `retry`, which no
  // transition could execute against an already-`done` step.
  const fx = mkFixture({ slug: 'fc-eviction' });
  walkToDeploy(fx);
  let op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.group, 'live_check');
  op = fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0 } }); // no digest
  assert.equal(op.gate, 'live_check_evidence_missing');
  assert.equal(op.cause, 'digest_missing');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'live_check_evidence_missing', 'durable');
  // Re-entry finds the same gate rather than re-deriving a different op.
  assert.equal(fx.step().gate, 'live_check_evidence_missing');
  // Only an answer the machine can execute is offered.
  assert.deepEqual(op.choices, ['abort']);
  fx.step({ deployAbort: true });
  // The abort names the CAUSE, so the archive class records why the evidence was missing.
  const auth = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized');
  assert.equal(auth.reason, 'deploy_abort:digest_missing', JSON.stringify(auth));
  assert.equal(readState(fx.statePath).pending_gate, null, 'the gate is closed by its answer');
  for (let i = 0; i < 8 && readState(fx.statePath).status !== 'archived'; i++) fx.step();
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false);
});

test('a definition with no live_check group names its own distinct cause', () => {
  const fx = mkFixture({ slug: 'fc-nolive-cause', done: 'done:\n  release:\n    - run: /bin/true\n' });
  walkToDeploy(fx);
  const op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.gate, 'live_check_evidence_missing');
  assert.equal(op.cause, 'no_live_check_group', 'distinguishable from a missing digest');
  assert.equal(readState(fx.statePath).pending_gate?.cause, 'no_live_check_group');
});

test('an ABORTED deploy stage is never intercepted by the live-evidence gate', () => {
  // Finding: evaluateFinalAssessment ran for any deploy base, so a run the operator had
  // already aborted — bound for an incomplete archive — was caught by a live-evidence gate it
  // could never satisfy, deadlocking exactly the runs whose point is that they did not finish.
  const fx = mkFixture({ slug: 'fc-aborted' });
  walkToDeploy(fx);
  const op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } });
  assert.equal(op.gate, 'deploy_failed', JSON.stringify(op));
  fx.step({ deployAbort: true });
  let last = null;
  for (let i = 0; i < 8 && readState(fx.statePath).status !== 'archived'; i++) last = fx.step();
  assert.notEqual(last?.gate, 'live_check_evidence_missing', 'the abort is not re-gated');
  assert.equal(readState(fx.statePath).status, 'archived', JSON.stringify(last));
  assert.ok(readEvents(fx.bundleDir).some((e) => e.type === 'incomplete_authorized' && e.reason === 'deploy_abort'));
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false);
});

test('the live digest is a hash of CONTENT: same bytes agree, different bytes differ', () => {
  // Asserted against an independently computed sha256 rather than against liveCheckDigest on
  // both sides, which would only prove the function equals itself.
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'mp-digest-'));
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt'); // same content, different path
  const c = path.join(dir, 'c.txt');
  fs.writeFileSync(a, 'observed output\n');
  fs.writeFileSync(b, 'observed output\n');
  fs.writeFileSync(c, 'different output\n');
  const expected = `sha256:${createHash('sha256').update('observed output\n').digest('hex')}`;
  assert.equal(liveCheckDigest(a), expected);
  assert.equal(liveCheckDigest(b), expected, 'the path is not part of the evidence');
  assert.notEqual(liveCheckDigest(c), expected);

  const empty = path.join(dir, 'empty.txt');
  fs.writeFileSync(empty, '   \n');
  assert.throws(() => liveCheckDigest(empty), /empty/);
  assert.throws(() => liveCheckDigest(path.join(dir, 'nope.txt')), /unreadable/);
});

test('an unreadable evidence file appends NO event and leaves the step reportable', () => {
  // The digest is computed before anything is appended, so a bad evidence file must not leave
  // a half-recorded step behind.
  const fx = mkFixture({ slug: 'fc-bad-evidence' });
  walkToDeploy(fx);
  fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  const before = readEvents(fx.bundleDir).length;
  assert.throws(
    () => fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0, digestFile: path.join(fx.tmp, 'absent.txt') } }),
    /unreadable/,
  );
  assert.equal(readEvents(fx.bundleDir).length, before, 'nothing was appended');
  // The step is still the current one, so a correct report still lands.
  const good = path.join(fx.tmp, 'good.txt');
  fs.writeFileSync(good, 'live\n');
  const op = fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0, digestFile: good } });
  assert.equal(op.op, 'run_final_check', JSON.stringify(op));
});

test('the deploy chain hash covers evidence and commits, not just exit statuses', () => {
  // Finding: the chain was projected to {group,index,status,exit,check_exit}, so two releases
  // that exited 0 at the same index but produced different evidence hashed identically — a
  // verdict could not then be bound to one of them.
  const base = { group: 'release', index: 0, status: 'done', exit: 0, check_exit: null, digest: 'sha256:aaa', commits: ['c1'], head_after: 'h1' };
  const h = deployChainHash([base]);
  for (const field of ['digest', 'commits', 'head_after']) {
    const changed = { ...base, [field]: field === 'commits' ? ['c2'] : `${base[field]}-different` };
    assert.notEqual(deployChainHash([changed]), h, `${field} must change the chain hash`);
  }
});

test('run_final_check names a readable evidence FILE, not a digest, in its recorder command', () => {
  // Finding: `next` rendered `--digest-file=<live digest>`, but --digest-file now hashes the
  // file it opens — following that command verbatim fails with "digest-file unreadable".
  const fx = mkFixture({ slug: 'fc-next-cmd' });
  walkToDeploy(fx);
  const op = runDeployChain(fx);
  assert.equal(op.op, 'run_final_check');
  assert.ok(op.live_digest_path, 'the evidence path is durable, so a fresh process can find it');
  assert.equal(liveCheckDigest(op.live_digest_path), op.live_digest, 'and it hashes to the recorded digest');
  const flag = op.next.match(/--digest-file=(\S+)/)[1];
  assert.equal(flag, op.live_digest_path);
  assert.ok(fs.existsSync(flag), 'the command names a file that exists');
});

// ---------------------------------------------------------------------------
// Adversary round 2 — the finding each of these closes is named in its comment.
// ---------------------------------------------------------------------------

test('confirmation is bound to the receipt the operator SAW, not the newest one', () => {
  // Finding: the gate recorded only {id, opened_at}, so the confirmation re-selected "the
  // newest valid receipt". A receipt appended while the durable gate sat open would be
  // confirmed as though the operator had agreed to it — including a partial one.
  const fx = mkFixture({ slug: 'fc-swap' });
  walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { verdict: 'met' });
  const gate = fx.step();
  assert.equal(gate.gate, 'intent_confirm');
  const bound = readState(fx.statePath).pending_gate?.receipt;
  assert.ok(bound, 'the gate names the receipt it is showing');

  // A DIFFERENT assessment lands while the gate is open.
  recordFinalCheck(fx, chk, { verdict: 'partial', evidence: 'actually it only half works' });
  const before = readEvents(fx.bundleDir).length;
  assert.throws(() => fx.step({ intentConfirmed: true }), /changed since the gate opened|only a met assessment/);
  assert.equal(readEvents(fx.bundleDir).length, before, 'nothing is appended');
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false);
});

test('the completion_confirmed event carries the full binding it authorized', () => {
  const fx = mkFixture({ slug: 'fc-binding' });
  walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { verdict: 'met' });
  fx.step();
  fx.step({ intentConfirmed: true });
  const ev = readEvents(fx.bundleDir).find((e) => e.type === 'completion_confirmed');
  assert.equal(ev.deploy_chain_hash, chk.deploy_chain_hash);
  assert.equal(ev.live_check_digest, chk.live_digest);
  assert.ok(ev.receipt?.startsWith('sha256:'), 'the authorization stays auditable without re-deriving it');
});

test('a final assessment with NO implementation receipt is refused, not unconstrained', () => {
  // Finding: with impl null, undefined expectations were handed to the validator, so the final
  // receipt's branch bindings would be checked against nothing — self-validation by omission.
  const fx = mkFixture({ slug: 'fc-noimpl' });
  // walkToDeploy normally records the implementation check; drive the same walk without it by
  // removing it from the ledger once the deploy stage is under way.
  walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { verdict: 'met' });
  const kept = readEvents(fx.bundleDir).filter((e) => !(e.type === 'goal_check' && e.data?.final !== true));
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), kept.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const op = fx.step();
  assert.equal(op.gate, 'final_check_invalid', JSON.stringify(op));
  assert.match(op.error, /no implementation goal_check receipt/);
});

test('an unknown provenance_kind is invalid, not silently read as assessor provenance', () => {
  // Finding: everything that was not exactly `user` was mapped to assessor provenance, which
  // repaired a malformed discriminator into a shape the validator accepts.
  const fx = mkFixture({ slug: 'fc-prov' });
  walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { over: { provenance_kind: 'manual-ish' } });
  const op = fx.step();
  assert.equal(op.gate, 'final_check_invalid', JSON.stringify(op));
});

test('final_check_invalid carries everything a replacement receipt needs', () => {
  // Finding: it advertised `re-record` while returning only a base sha and an error string, so
  // a fresh process could not produce a replacement at all.
  const fx = mkFixture({ slug: 'fc-invalid-inputs' });
  walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { over: { clean: undefined } });
  const op = fx.step();
  assert.equal(op.gate, 'final_check_invalid');
  assert.equal(op.deploy_chain_hash, chk.deploy_chain_hash);
  assert.equal(op.live_digest, chk.live_digest);
  assert.ok(fs.existsSync(op.live_digest_path), 'the evidence is readable');
  assert.match(op.next, /record-goal-check --final/);
  assert.ok(!op.next.includes('<deploy base>'), 'the command carries real values');

  // ...and recording a VALID receipt is the transition: re-entry picks it up.
  recordFinalCheck(fx, chk, { verdict: 'met' });
  assert.equal(fx.step().gate, 'intent_confirm');
});

test('abort answers EVERY final gate, and each names the gate it stopped at', () => {
  // Finding: --deploy-abort bypassed the halted-step guard only for live_check_evidence_missing,
  // so `abort` on final_check_invalid and on the final goals_unmet was refused — the same
  // dead-end shape the evidence gate had.
  for (const [slug, arrange, expected] of [
    ['fc-abort-invalid', (fx, chk) => recordFinalCheck(fx, chk, { over: { clean: undefined } }), 'deploy_abort:final_check_invalid'],
    ['fc-abort-unmet', (fx, chk) => recordFinalCheck(fx, chk, { verdict: 'missed', evidence: 'it does not do what was meant' }), 'deploy_abort:goals_unmet'],
  ]) {
    const fx = mkFixture({ slug });
    walkToDeploy(fx);
    const chk = runDeployChain(fx);
    arrange(fx, chk);
    const gate = fx.step();
    assert.ok(gate.choices.includes('abort'), `${slug}: ${JSON.stringify(gate)}`);
    fx.step({ deployAbort: true });
    const auth = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized');
    assert.equal(auth.reason, expected, slug);
    assert.equal(readState(fx.statePath).pending_gate, null, `${slug}: the gate is closed`);
    for (let i = 0; i < 8 && readState(fx.statePath).status !== 'archived'; i++) fx.step();
    assert.equal(readState(fx.statePath).status, 'archived', slug);
    assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false, slug);
  }
});

test('a WAIVER on the final goals_unmet gate is terminal — the gate does not reopen', () => {
  // Finding: the implementation-phase waiver is deliberately not stage-terminal, so reusing it
  // here cleared the gate while leaving the same partial receipt in place, and the very next
  // evaluation reopened the identical gate forever.
  const fx = mkFixture({ slug: 'fc-waive-final' });
  walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { verdict: 'partial', evidence: 'half of it works' });
  assert.equal(fx.step().gate, 'goals_unmet');
  fx.step({ goalsChoice: 'waiver' });
  assert.ok(readEvents(fx.bundleDir).some((e) => e.type === 'incomplete_authorized' && e.reason === 'intent_waived'));
  let last = null;
  for (let i = 0; i < 8 && readState(fx.statePath).status !== 'archived'; i++) last = fx.step();
  assert.notEqual(last?.gate, 'goals_unmet', 'the waived gate does not reopen');
  assert.equal(readState(fx.statePath).status, 'archived', JSON.stringify(last));
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false);
});

test('conflicting gate answers are refused BEFORE anything is written', () => {
  // Finding: answers were applied in sequence, so a conflicting pair recorded the first and
  // then threw on the second — the caller saw a failure while completion_confirmed was durable.
  const fx = mkFixture({ slug: 'fc-conflict' });
  walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { verdict: 'met' });
  fx.step();
  const before = readEvents(fx.bundleDir).length;
  assert.throws(
    () => fx.step({ intentConfirmed: true, intentRejected: { class: 'intent', reason: 'no', successor: 'later-run' } }),
    /exactly one answer/,
  );
  assert.equal(readEvents(fx.bundleDir).length, before, 'no partial write');
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false);
  assert.equal(readState(fx.statePath).pending_gate?.id, 'intent_confirm', 'the gate is untouched');
});

test('a rejection validates its class, reason and successor rather than truthiness', () => {
  // Finding: every `intent_rejected:` reason is stage-terminal, so a typo'd class permanently
  // ends the run under a label no reader understands.
  const fx = mkFixture({ slug: 'fc-reject-validate' });
  walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { verdict: 'met' });
  fx.step();
  const before = readEvents(fx.bundleDir).length;
  for (const [bad, re] of [
    [{ class: 'implmentation', reason: 'r', successor: 'later-run' }, /is not one of intent\/implementation/],
    [{ class: 'intent', reason: '   ', successor: 'later-run' }, /non-empty reason/],
    [{ class: 'intent', reason: 'r', successor: '   ' }, /is not a bundle slug/],
    [{ class: 'intent', reason: 'r', successor: 'Not A Slug' }, /is not a bundle slug/],
  ]) {
    assert.throws(() => fx.step({ intentRejected: bad }), re, JSON.stringify(bad));
  }
  assert.equal(readEvents(fx.bundleDir).length, before, 'no refused rejection wrote anything');
});

test('the live evidence is INGESTED into the bundle, so it survives the temp file', () => {
  // Finding: the event stored an absolute path to a caller-owned temp file. It can be deleted,
  // overwritten, or simply absent on the host that resumes the finish days later — a durable
  // ledger pointing at /tmp records a promise it cannot keep.
  const fx = mkFixture({ slug: 'fc-evidence-durable' });
  walkToDeploy(fx);
  const op = runDeployChain(fx);
  const stored = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_step' && e.group === 'live_check');
  assert.ok(!path.isAbsolute(stored.digest_path), `bundle-relative, got ${stored.digest_path}`);
  assert.ok(op.live_digest_path.startsWith(fx.bundleDir), 'and it resolves inside the bundle');

  // The operator's temp file goes away; the assessment still has its evidence.
  fs.rmSync(path.join(fx.tmp, 'live-digest.txt'));
  const again = fx.step();
  assert.equal(again.op, 'run_final_check');
  assert.ok(fs.existsSync(again.live_digest_path));
  assert.equal(liveCheckDigest(again.live_digest_path), again.live_digest);
});

test('ingested evidence that no longer hashes to its digest is not offered as evidence', () => {
  const fx = mkFixture({ slug: 'fc-evidence-tampered' });
  walkToDeploy(fx);
  const op = runDeployChain(fx);
  fs.writeFileSync(op.live_digest_path, 'something else entirely\n');
  const again = fx.step();
  assert.equal(again.op, 'run_final_check');
  assert.equal(again.live_digest_path, null, 'a changed artifact is not the evidence this verdict binds to');
  assert.equal(again.live_digest, op.live_digest, 'but the recorded digest is unchanged');
});

test('the digest hashes BYTES: two different invalid-UTF-8 files do not collide', () => {
  // Finding: reading as utf8 maps every invalid sequence onto U+FFFD, so different evidence
  // could hash identically — the one property a content digest must not have.
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'mp-bytes-'));
  const a = path.join(dir, 'a.bin');
  const b = path.join(dir, 'b.bin');
  fs.writeFileSync(a, Buffer.from([0x6f, 0x6b, 0xff, 0xfe, 0x0a]));
  fs.writeFileSync(b, Buffer.from([0x6f, 0x6b, 0xfe, 0xff, 0x0a]));
  assert.notEqual(liveCheckDigest(a), liveCheckDigest(b), 'different bytes, different digests');
  assert.equal(liveCheckDigest(a), `sha256:${createHash('sha256').update(fs.readFileSync(a)).digest('hex')}`);
});
