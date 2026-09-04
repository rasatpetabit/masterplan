// test/intent-rejected.test.mjs — durable archive authorization and completion classes (wave task 28).
//
// Task 28's core: `state.completion` is written AT archive, derived from the ledger — never
// guessed. A run is `complete` only after the operator confirmed the deployed intent; `merged`
// only for a `done: none` deployment that was confirmed; `incomplete:<reason>` only when the
// matching `incomplete_authorized` is on the ledger (keep/discard, deploy skip, abort,
// no-definition abort-incomplete, attested mandatory steps, both intent-rejection classes); and
// nothing (legacy) otherwise. The archive REFUSES a class its ledger does not authorize.
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

const DONE_WITH_LIVE = [
  'done:',
  '  release:',
  '    - run: /bin/true',
  '  live_check:',
  '    - run: /bin/true',
  '      check: /bin/true',
  '',
].join('\n');

// A goals-enabled bundle whose `done:` block the caller chooses, walked to the point where the
// deploy stage is about to run. owner_lock=off so no Guard-D identity is needed.
function mkFixture({ slug = 'ir', done = DONE_WITH_LIVE, goalsMd = GOALS_MD } = {}) {
  const tmp = mkdtempTracked(path.join(os.tmpdir(), 'mp-intentreject-'));
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
  return { tmp, MAIN, WT, bundleDir, statePath, slug, step, gHash, headAtBuild, recordImplementationCheck };
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

// Walk the full chain for a DONE_WITH_LIVE fixture: release then live_check (with its digest).
// Returns the op the stage leaves behind.
function runDeployChain(fx, { liveDigestText = 'live check output\n' } = {}) {
  let op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.group, 'live_check', JSON.stringify(op));
  const digestFile = path.join(fx.tmp, 'live-digest.txt');
  fs.writeFileSync(digestFile, liveDigestText);
  return fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0, digestFile } });
}

// Record a final goal_check receipt bound to the deployment the op names.
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

// Walk to the open intent_confirm gate (met verdict).
function walkToFinalGate(fx, { verdict = 'met' } = {}) {
  walkToDeploy(fx);
  const chk = runDeployChain(fx);
  recordFinalCheck(fx, chk, { verdict, ...(verdict === 'met' ? {} : { evidence: 'the deployed thing does not do what was meant' }) });
  return fx.step();
}

// Step the machine until the run archives (bounded), returning the final op.
function walkToArchived(fx, max = 10) {
  let op = null;
  for (let i = 0; i < max && readState(fx.statePath).status !== 'archived'; i++) op = fx.step();
  return op;
}

function walkToArchivedOrThrow(fx, max = 10) {
  let op = null;
  // The machine may archive in the SAME call as the answer that resolves the final gate, so
  // an already-archived state on entry is a completed run, not a stuck one — return the last
  // op we have (or synthesize the terminal state) rather than asserting a loop that never ran.
  if (readState(fx.statePath).status === 'archived') return op ?? { reason: 'archived', slug: fx.slug, disposition: readState(fx.statePath).worktree_disposition ?? null };
  for (let i = 0; i < max && readState(fx.statePath).status !== 'archived'; i++) op = fx.step();
  assert.equal(readState(fx.statePath).status, 'archived', `never archived; stuck at: ${JSON.stringify(op)}`);
  return op;
}

// ---------------------------------------------------------------------------
// Completion class written at archive
// ---------------------------------------------------------------------------

test('a confirmed deployed run archives as complete', () => {
  const fx = mkFixture({ slug: 'ir-complete' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentConfirmed: true });
  const op = walkToArchivedOrThrow(fx);
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const st = readState(fx.statePath);
  assert.equal(st.status, 'archived');
  assert.equal(st.completion, 'complete');
});

test('a confirmed done: none run archives as merged, never complete', () => {
  const fx = mkFixture({ slug: 'ir-merged', done: 'done: none\n' });
  // done: none runs no groups; the stage records deploy_base and the final assessment is
  // skipped (no deployment to assess). The run reaches its archive with a confirmation absent.
  walkToDeploy(fx);
  const op = walkToArchivedOrThrow(fx);
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const st = readState(fx.statePath);
  assert.equal(st.completion, 'merged', JSON.stringify(st));
});

test('keep archives incomplete:kept with the authorization on the ledger', () => {
  const fx = mkFixture({ slug: 'ir-keep', done: 'done: none\n' });
  fx.recordImplementationCheck();
  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = fx.step(); }
  assert.equal(op.gate, 'branch_finish');
  op = fx.step({ choice: 'keep' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const st = readState(fx.statePath);
  assert.equal(st.completion, 'incomplete:kept', JSON.stringify(st));
  const auth = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized' && e.reason === 'kept');
  assert.ok(auth, 'keep writes its authorization transactionally');
});

test('discard archives incomplete:discarded with the authorization on the ledger', () => {
  const fx = mkFixture({ slug: 'ir-discard', done: 'done: none\n' });
  fx.recordImplementationCheck();
  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = fx.step(); }
  assert.equal(op.gate, 'branch_finish');
  op = fx.step({ choice: 'discard' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const st = readState(fx.statePath);
  assert.equal(st.completion, 'incomplete:discarded', JSON.stringify(st));
  const auth = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized' && e.reason === 'discarded');
  assert.ok(auth, 'discard writes its authorization transactionally');
});

test('a discard NEVER enters the deploy stage, however real its done: surface looks', () => {
  // A discard records disposition removed_after_merge (the same value a merge lands), so with a
  // real release surface it would satisfy the deploy-stage entry condition and authorize+start
  // release/install commands on a run the operator retired as NOT-DONE (adversary r1 BLOCKER).
  // The stage must be skipped for a discard, straight to the incomplete:discarded archive.
  const fx = mkFixture({ slug: 'ir-discard-nodeploy', done: DONE_WITH_LIVE });
  fx.recordImplementationCheck();
  let op = fx.step();
  assert.equal(op.op, 'run_verify', JSON.stringify(op));
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = fx.step(); }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  op = fx.step({ choice: 'discard' });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  // No deploy events at all — no deploy_base, no run_deploy_step, no final assessment.
  const evs = readEvents(fx.bundleDir);
  assert.equal(evs.some((e) => e.type === 'deploy_base'), false, 'no deploy base was recorded for a discarded run');
  assert.equal(evs.some((e) => e.type === 'deploy_step' || e.type === 'deploy_step_started' || e.type === 'deploy_step_authorized'), false, 'no deploy step ever ran for a discarded run');
  const st = readState(fx.statePath);
  assert.equal(st.status, 'archived');
  assert.equal(st.completion, 'incomplete:discarded');
  assert.equal(st.worktree_disposition, 'removed_after_merge', 'the discard still tears the worktree down');
});

test('a skipped mandatory step archives incomplete:deploy_skip:<group>[<index>]', () => {
  const fx = mkFixture({ slug: 'ir-skip', done: 'done:\n  release:\n    - run: /bin/false\n' });
  walkToDeploy(fx);
  assert.equal(fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } }).gate, 'deploy_failed');
  const op = fx.step({ deploySkip: { group: 'release', index: 0 } });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const st = readState(fx.statePath);
  assert.equal(st.completion, 'incomplete:deploy_skip:release[0]', JSON.stringify(st));
});

test('an aborted deploy archives incomplete:deploy_abort', () => {
  const fx = mkFixture({ slug: 'ir-abort', done: 'done:\n  release:\n    - run: /bin/false\n' });
  walkToDeploy(fx);
  assert.equal(fx.step({ deployStepDone: { group: 'release', index: 0, exit: 1 } }).gate, 'deploy_failed');
  const op = fx.step({ deployAbort: true });
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const st = readState(fx.statePath);
  assert.equal(st.completion, 'incomplete:deploy_abort', JSON.stringify(st));
});

test('an attested mandatory step archives incomplete:attested even after intent_confirm', () => {
  // §7.2/§11 S3: an attestation is a signed "did not happen" record — never complete, whatever
  // the operator confirms later. The task requires the authorization at the attestation itself.
  const fx = mkFixture({ slug: 'ir-attested', done: 'done:\n  release:\n    - run: /bin/true\n' });
  walkToDeploy(fx);
  assert.equal(fx.step().gate, 'deploy_indeterminate'); // check-less step started but never reported
  assert.equal(fx.step({ deployAttest: { group: 'release', index: 0 } }).reason, 'archived');
  const st = readState(fx.statePath);
  assert.equal(st.completion, 'incomplete:attested', JSON.stringify(st));
  const auth = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized' && e.reason === 'attested');
  assert.ok(auth, 'the attestation writes its authorization');
});

test('an intent-class rejection archives incomplete:intent_rejected:intent', () => {
  const fx = mkFixture({ slug: 'ir-reject-intent' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentRejected: { class: 'intent', reason: 'the goal was misread: it needed the CLI, not the library', successor: 'ir-succ-intent' } });
  const op = walkToArchivedOrThrow(fx);
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const st = readState(fx.statePath);
  assert.equal(st.completion, 'incomplete:intent_rejected:intent', JSON.stringify(st));
});

test('an implementation-class rejection archives incomplete:intent_rejected:implementation', () => {
  const fx = mkFixture({ slug: 'ir-reject-impl' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentRejected: { class: 'implementation', reason: 'the release script published the wrong artifact', successor: 'ir-succ-impl' } });
  const op = walkToArchivedOrThrow(fx);
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const st = readState(fx.statePath);
  assert.equal(st.completion, 'incomplete:intent_rejected:implementation', JSON.stringify(st));
});

test('an archive with NO authorization writes no completion field (legacy)', () => {
  // A deployed run with no goals (so no final assessment, no intent_confirm) and no failure:
  // it archives, but state.completion stays absent so every consumer reads `legacy` — the
  // pre-v10 shape. (done: none is NOT this case — a completed done: none run is `merged`.)
  const fx = mkFixture({ slug: 'ir-legacy', done: DONE_WITH_LIVE });
  const st0 = readState(fx.statePath);
  writeState(fx.statePath, { ...st0, goals_enabled: false });
  fs.rmSync(path.join(fx.bundleDir, 'goals.md'), { force: true });
  let op = fx.step();
  assert.equal(op.op, 'run_verify');
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = fx.step(); }
  assert.equal(op.gate, 'branch_finish');
  op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step');
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  const op2 = walkToArchivedOrThrow(fx);
  assert.equal(op2.reason, 'archived', JSON.stringify(op2));
  const st = readState(fx.statePath);
  assert.equal(st.status, 'archived');
  assert.equal(st.completion, undefined, 'legacy archive carries no completion field');
});

// ---------------------------------------------------------------------------
// Archive authorization guard
// ---------------------------------------------------------------------------

test('the archive refuses a stale completion:complete that the ledger does not authorize', () => {
  // The concealed gap (adversary r1 finding 6): if state carries completion:complete but the
  // ledger has no confirmation, the legacy (completion === null) branch used to preserve that
  // field while setting status archived — silently claiming an unconfirmed completion. The
  // archive must now refuse and leave the run unarchived.
  const fx = mkFixture({ slug: 'ir-guard-noconfirm' });
  // Drive to the open intent_confirm gate (real done surface, live check recorded).
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  // Construct the unauthorized state: strip ONLY the confirmation (keep the deploy_base) so
  // deriveCompletionClass derives null (legacy — a deployed-but-unconfirmed run), disable goals
  // so the final assessment cannot re-open the intent_confirm gate, and pre-seed a stale
  // completion:complete that the ledger no longer supports.
  const eventsPath = path.join(fx.bundleDir, 'events.jsonl');
  const kept = readEvents(fx.bundleDir).filter((e) => e.type !== 'completion_confirmed');
  fs.writeFileSync(eventsPath, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const st = readState(fx.statePath);
  fs.rmSync(path.join(fx.bundleDir, 'goals.md'), { force: true });
  writeState(fx.statePath, { ...st, status: 'in-progress', completion: 'complete', worktree_disposition: 'removed_after_merge', pending_gate: null, goals_enabled: false });
  // The ledger derives no completion (no base, no confirmation), but state claims complete — the
  // archive must refuse rather than preserve the stale class through the legacy branch.
  assert.throws(() => fx.step(), /refusing to archive.*stale/);
  assert.notEqual(readState(fx.statePath).status, 'archived', 'the refusal leaves the run unarchived');
  assert.equal(readState(fx.statePath).completion, 'complete', 'the stale field is left for the operator to clear');
});

test('a completion_confirmed bound to a STALE deploy base cannot authorize a complete archive', () => {
  // Adversary r1 finding 5: the completion must be validated against the LATEST deploy base.
  // A confirmation bound to an EARLIER base must not derive `complete` — the run derives null
  // (legacy) instead, and archives as legacy, never `complete`.
  const fx = mkFixture({ slug: 'ir-wrongbase' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  const firstBase = readEvents(fx.bundleDir).find((e) => e.type === 'deploy_base');
  // Append a SECOND deploy_base (a re-deploy) and a completion_confirmed bound to the FIRST base
  // only — a receipt that predates the latest deployment.
  appendEvent(fx.bundleDir, { type: 'deploy_base', ts: '2026-01-01T00:00:20Z', sha: 'b'.repeat(40), branch_tip: firstBase.branch_tip, done_sha256: firstBase.done_sha256 });
  appendEvent(fx.bundleDir, {
    type: 'completion_confirmed', ts: '2026-01-01T00:00:21Z', deploy_base_sha: firstBase.sha,
    intent_verdict: 'met', receipt: 'rec-old', deploy_chain_hash: 'sha256:chain', live_check_digest: 'sha256:live',
  });
  const st = readState(fx.statePath);
  writeState(fx.statePath, { ...st, status: 'in-progress', worktree_disposition: 'removed_after_merge', pending_gate: null });
  // The stale-bound confirmation derives null, not complete: the run archives as legacy and
  // never claims a complete it has no latest-base authorization for.
  const op = fx.step();
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const st2 = readState(fx.statePath);
  assert.notEqual(st2.completion, 'complete', 'a stale-bound confirmation never yields complete');
});

test('a truncated attestation ledger is healed on re-entry, never refused into a stuck run', () => {
  // An attestation is a TWO-append transaction (the signed deploy_step {status:attested}, then its
  // incomplete_authorized {reason:attested}). A crash between them leaves a completed attested step
  // whose authorization never landed — the step cannot be re-attested (it is no longer
  // indeterminate) and would otherwise strand the run. The §0.6 recovery re-derives the missing
  // authorization deterministically from the attested step record, so re-entry heals the ledger and
  // archives incomplete:attested rather than refusing (adversary r1 finding 4).
  const fx = mkFixture({ slug: 'ir-guard-noauth', done: 'done:\n  release:\n    - run: /bin/true\n' });
  // goals-disabled so no final assessment intervenes: the attestation must drive straight to
  // the archive, and the re-enter must hit the recovery rather than a goal gate.
  const stInit = readState(fx.statePath);
  writeState(fx.statePath, { ...stInit, goals_enabled: false });
  fs.rmSync(path.join(fx.bundleDir, 'goals.md'), { force: true });
  // Drive the machine by hand (walkToDeploy records a goal_check, which needs goals.md).
  let op = fx.step();
  assert.equal(op.op, 'run_verify', JSON.stringify(op));
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = fx.step(); }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  assert.equal(fx.step().gate, 'deploy_indeterminate'); // check-less step started but never reported
  const opAttest = fx.step({ deployAttest: { group: 'release', index: 0 } });
  assert.equal(opAttest.reason, 'archived', JSON.stringify(opAttest));
  // The attestation recorded BOTH the signed deploy_step and its authorization. Now simulate the
  // crash window: drop the authorization event and reset the archive so the machine re-archives.
  const eventsPath = path.join(fx.bundleDir, 'events.jsonl');
  const kept = readEvents(fx.bundleDir).filter((e) => !(e.type === 'incomplete_authorized' && e.reason === 'attested'));
  fs.writeFileSync(eventsPath, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const st = readState(fx.statePath);
  writeState(fx.statePath, { ...st, status: 'in-progress' });
  // Re-entry heals: the missing authorization is recovered from the attested step, and the run
  // archives incomplete:attested with its authorization present on the ledger.
  const op2 = fx.step();
  assert.equal(op2.reason, 'archived', JSON.stringify(op2));
  const healed = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized' && e.reason === 'attested');
  assert.ok(healed, 'the missing authorization is recovered');
  assert.equal(healed.recovered, true, 'the recovery marks the reconstructed authorization');
  assert.equal(readState(fx.statePath).status, 'archived');
  assert.equal(readState(fx.statePath).completion, 'incomplete:attested');
});

test('the archive refuses an incomplete:<reason> claim with no authorization AND no recoverable source', () => {
  // The refusal path still exists for classes with NO recoverable source: a manually-seeded
  // incomplete:kept completion with no kept event and no signed step to reconstruct from must
  // REFUSE, not archive (adversary r1 finding 6's gap).
  const fx = mkFixture({ slug: 'ir-guard-nosource', done: 'done: none\n' });
  // A keep writes its own authorization; construct the corrupt opposite instead: state carries a
  // completion the ledger does not authorize.
  const stInit = readState(fx.statePath);
  writeState(fx.statePath, { ...stInit, status: 'in-progress', completion: 'incomplete:kept', worktree_disposition: 'kept_by_user' });
  // No kept event on the ledger and no attested step — the recovery has nothing to reconstruct.
  assert.throws(() => fx.step(), /refusing to archive/);
  assert.notEqual(readState(fx.statePath).status, 'archived', 'the refusal leaves the run unarchived');
});

// ---------------------------------------------------------------------------
// required_successor emission
// ---------------------------------------------------------------------------

test('an intent-class rejection emits required_successor carrying the correction as the remediation', () => {
  const fx = mkFixture({ slug: 'ir-succ-intent' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentRejected: { class: 'intent', reason: 'the goal was misread: it needed the CLI, not the library', successor: 'ir-target' } });
  const rs = latest(fx, 'required_successor');
  assert.ok(rs, 'the rejection emits required_successor');
  assert.equal(rs.slug, 'ir-target');
  assert.match(rs.reason, /rejected on intent/);
  assert.match(rs.reason, /needed the CLI/);
  assert.equal(rs.class, 'intent');
  assert.equal(rs.source, fx.slug);
  // The incomplete_authorized still carries the correction for the seed's projection.
  const auth = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized' && String(e.reason).startsWith('intent_rejected'));
  assert.match(auth.correction, /needed the CLI/);
});

test('an implementation-class rejection emits required_successor naming the build defect', () => {
  const fx = mkFixture({ slug: 'ir-succ-impl' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentRejected: { class: 'implementation', reason: 'the release script published the wrong artifact', successor: 'ir-target-2' } });
  const rs = latest(fx, 'required_successor');
  assert.ok(rs);
  assert.equal(rs.slug, 'ir-target-2');
  assert.match(rs.reason, /rejected on implementation/);
  assert.equal(rs.class, 'implementation');
  // No correction text: the build was wrong, not the goal.
  const auth = readEvents(fx.bundleDir).find((e) => e.type === 'incomplete_authorized' && String(e.reason).startsWith('intent_rejected'));
  assert.equal(auth.correction, undefined);
});

test('a rejection without a successor is refused before any event is written', () => {
  const fx = mkFixture({ slug: 'ir-succ-guard' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  const before = readEvents(fx.bundleDir).length;
  assert.throws(() => fx.step({ intentRejected: { class: 'intent', reason: 'r', successor: '' } }), /named successor/);
  assert.equal(readEvents(fx.bundleDir).length, before, 'a refused rejection writes nothing');
  assert.equal(readState(fx.statePath).pending_gate?.id, 'intent_confirm', 'the gate stays open');
});

test('a crash between the rejection appends is healed on re-entry, so the archive never strands the successor', () => {
  // An intent rejection is TWO appends: the canonical incomplete_authorized, then the
  // required_successor projection. A death between them leaves a terminal authorization with no
  // successor obligation — and once archived, appendEvent refuses everything but archive_pushed,
  // so the handoff would be permanently lost (adversary r1 BLOCKER). The §0.6 recovery re-derives
  // the obligation from the authorization record and re-emits it, and the archive guard refuses if
  // it somehow still cannot.
  const fx = mkFixture({ slug: 'ir-crash-succ' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  // Record the rejection but CUT the crash window: keep the incomplete_authorized, drop the
  // required_successor (simulating a death after the first append). The gate is cleared by the
  // rejection handler; reset status so re-entry reaches the machine evaluation.
  fx.step({ intentRejected: { class: 'implementation', reason: 'wrong artifact', successor: 'ir-crash-succ-target' } });
  const eventsPath = path.join(fx.bundleDir, 'events.jsonl');
  const kept = readEvents(fx.bundleDir).filter((e) => e.type !== 'required_successor');
  fs.writeFileSync(eventsPath, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const st = readState(fx.statePath);
  writeState(fx.statePath, { ...st, status: 'in-progress' });
  // Re-entry heals: the obligation is recovered from the authorization record, then archives.
  const op = fx.step();
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  const rs = readEvents(fx.bundleDir).find((e) => e.type === 'required_successor');
  assert.ok(rs, 'the successor obligation is recovered');
  assert.equal(rs.slug, 'ir-crash-succ-target');
  assert.equal(rs.class, 'implementation');
  assert.equal(rs.source, fx.slug);
  assert.equal(readState(fx.statePath).status, 'archived');
  assert.equal(readState(fx.statePath).completion, 'incomplete:intent_rejected:implementation');
});

test('the archive refuses an intent-rejected completion with no recoverable successor obligation', () => {
  // If the authorization record itself lost its successor slug (a corrupt ledger the recovery
  // cannot reconstruct), the archive must refuse rather than strand a nameless handoff.
  const fx = mkFixture({ slug: 'ir-no-succ-refuse' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentRejected: { class: 'implementation', reason: 'wrong artifact', successor: 'ir-no-succ-refuse-target' } });
  // Corrupt BOTH: drop the required_successor AND the authorization's successor field, so the
  // recovery has nothing to project.
  const eventsPath = path.join(fx.bundleDir, 'events.jsonl');
  const evs = readEvents(fx.bundleDir).map((e) => {
    if (e.type === 'incomplete_authorized' && String(e.reason ?? '').startsWith('intent_rejected')) {
      const { successor, ...rest } = e;
      return rest;
    }
    return e;
  }).filter((e) => e.type !== 'required_successor');
  fs.writeFileSync(eventsPath, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const st = readState(fx.statePath);
  writeState(fx.statePath, { ...st, status: 'in-progress' });
  assert.throws(() => fx.step(), /refusing to archive.*intent_rejected/);
  assert.notEqual(readState(fx.statePath).status, 'archived', 'the refusal leaves the run unarchived');
});

test('a re-issued --intent-confirmed after a crash appends nothing and still archives complete', () => {
  // Adversary r1 finding 3 crash window: a death after the completion_confirmed append but before
  // the gate-clear/archive must not let a re-issued confirmation append a SECOND event (the first
  // ledger answer is authoritative), and re-entry must still archive complete on the existing one.
  const fx = mkFixture({ slug: 'ir-confirm-replay' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  // Issue the confirmation (lands completion_confirmed + clears the gate + archives).
  fx.step({ intentConfirmed: true });
  const confirmsAfterFirst = readEvents(fx.bundleDir).filter((e) => e.type === 'completion_confirmed').length;
  assert.equal(confirmsAfterFirst, 1);
  // Simulate the crash window: re-open the gate by hand (the answer landed, the clear didn't) and
  // re-issue the same answer.
  const st = readState(fx.statePath);
  writeState(fx.statePath, { ...st, status: 'in-progress', pending_gate: { id: 'intent_confirm' } });
  const op = fx.step({ intentConfirmed: true });
  // No second append — the replay is idempotent.
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'completion_confirmed').length, 1, 'no second confirmation on replay');
  // The machine archives complete on the existing confirmation.
  assert.equal(op.reason, 'archived', JSON.stringify(op));
  assert.equal(readState(fx.statePath).completion, 'complete');
});

test('a confirmation after a rejection is refused, and a rejection after a confirmation is refused', () => {
  // The first ledger answer for a bound gate/base is authoritative (adversary r1 finding 3): a
  // later, contradictory answer must not be able to override the durable one.
  const fx = mkFixture({ slug: 'ir-contradict' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentRejected: { class: 'implementation', reason: 'wrong artifact', successor: 'ir-contradict-succ' } });
  // Re-open the gate state by hand (a crash/foreign write) and try to confirm the same base.
  const st = readState(fx.statePath);
  writeState(fx.statePath, { ...st, status: 'in-progress', pending_gate: { id: 'intent_confirm' } });
  assert.throws(() => fx.step({ intentConfirmed: true }), /already rejected/);
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false, 'no confirmation was written');

  // And the mirror: a confirmation already on the ledger refuses a later rejection.
  const fx2 = mkFixture({ slug: 'ir-contradict2' });
  assert.equal(walkToFinalGate(fx2).gate, 'intent_confirm');
  fx2.step({ intentConfirmed: true });
  const st2 = readState(fx2.statePath);
  writeState(fx2.statePath, { ...st2, status: 'in-progress', pending_gate: { id: 'intent_confirm' } });
  assert.throws(() => fx2.step({ intentRejected: { class: 'implementation', reason: 'r', successor: 'ir-contradict2-succ' } }), /already confirmed/);
});

// ---------------------------------------------------------------------------
// Receipt isolation
// ---------------------------------------------------------------------------

test('a rejected run carries no completion_confirmed, so it can never be classed complete', () => {
  const fx = mkFixture({ slug: 'ir-isolated' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentRejected: { class: 'implementation', reason: 'wrong artifact', successor: 'ir-isolated-succ' } });
  const op = walkToArchivedOrThrow(fx);
  assert.equal(op.reason, 'archived');
  assert.equal(readEvents(fx.bundleDir).some((e) => e.type === 'completion_confirmed'), false);
  const st = readState(fx.statePath);
  assert.equal(st.completion, 'incomplete:intent_rejected:implementation');
});

test('a confirmed run archives complete only bound to the confirmation event', () => {
  const fx = mkFixture({ slug: 'ir-bound' });
  assert.equal(walkToFinalGate(fx).gate, 'intent_confirm');
  fx.step({ intentConfirmed: true });
  const op = walkToArchivedOrThrow(fx);
  assert.equal(op.reason, 'archived');
  const confirmed = readEvents(fx.bundleDir).filter((e) => e.type === 'completion_confirmed');
  assert.equal(confirmed.length, 1);
  assert.equal(typeof confirmed[0].deploy_base_sha, 'string');
  const st = readState(fx.statePath);
  assert.equal(st.completion, 'complete');
});
