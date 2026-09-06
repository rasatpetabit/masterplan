// test/promotion-transaction.test.mjs — task 55: the §5.6 promotion transaction.
//
// A REAL bundle in a REAL git MAIN repo: the transaction's value is the exact ordering
// of the proof, the pin, the expected-revision check, the two writes, and the record —
// all under one bundle write lock — so every fixture drives the real module against a
// genuine repo, exactly the test/wave-commit.test.mjs style.
//
// The cases (§5.6 + the task):
//   - approval binding BOTH bases + diff + BOTH results in ONE transaction (happy path:
//     both applied, exactly one record, bases pinned by ref against gc)
//   - replay: the same transaction_id is a no-op, never a second write
//   - mid-flight edit: the expected-revision check aborts BEFORE any write — neither
//     artifact is touched
//   - torn state recovery: spec=result, goals=base -> classified, goals applied, no
//     double-apply of spec
//   - the symmetric refusal: an artifact matching NEITHER identity goes to the operator
//   - diff-does-not-reproduce: refused before anything is written
//   - the lock held across both writes + the record: a concurrent writer is refused
//     with zero writes; a torn recovery holds it the same way
//   - the satisfied artifact: an amendment that never changed a file never contributes
//     a torn state and is never rewritten
//   - the gate's combined binding: the goals lineage (goal_amended + goals_md_hash)
//     converges so the existing split-brain guard stays satisfied

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
const BIN = path.join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'masterplan.mjs');
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

import { writeState, readState, buildSeedState } from '../lib/bundle.mjs';
import { goalsHash } from '../lib/goals.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';
import { beginPromotion, commitPromotion, recoverPromotion, promotionDocPath, PROMOTION_REFS_PREFIX } from '../lib/promote.mjs';
import { promoteAmendment } from '../lib/wave-commit.mjs';

const TMPDIRS = [];
test.after(() => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});
const sha256Of = (t) => `sha256:${crypto.createHash('sha256').update(Buffer.from(String(t), 'utf8')).digest('hex')}`;

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
// RAW stdout — a pinned blob's trailing newline is part of its identity.
function gitRaw(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
const readEvents = (dir) => fs.existsSync(path.join(dir, 'events.jsonl'))
  ? fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];

// ---- the real-bundle fixture ------------------------------------------------------

const SPEC = [
  '# Spec',
  '',
  '## 1. Problem',
  '',
  'The old problem statement.',
  '',
  '## 2. Outcome',
  '',
  'The old outcome.',
].join('\n') + '\n';

const GOALS = [
  'topic: |',
  '  Promote an approved amendment durably.',
  '',
  '## G1: Works',
  'signal: test',
  '## G2: Fast',
  'signal: test',
  '## G3: Documented',
  'signal: docs',
].join('\n') + '\n';

function gitDiffText(fromDir, toDir) {
  // A REAL diff from git itself — the same diff machinery the amendment produced.
  try {
    return String(execFileSync('git', ['diff', '--no-index', '--', fromDir, toDir], { encoding: 'utf8' }));
  } catch (e) {
    return String(e.stdout ?? '');
  }
}

/**
 * A MAIN repo with a bundle dir carrying spec.md + goals.md at their BASE bytes, plus a
 * scratch pair holding the RESULT bytes. Returns everything the transaction needs.
 */
function mkbundle({ specBase = SPEC, goalsBase = GOALS } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-promo-'));
  TMPDIRS.push(tmp);
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '-q', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'docs/masterplan/promo/spec.md', specBase);
  write(MAIN, 'docs/masterplan/promo/goals.md', goalsBase);
  git(MAIN, 'add', '--all');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', 'promo');
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, buildSeedState({
    slug: 'promo', topic: 'Promote an approved amendment durably.',
    createdAt: '2026-01-01T00:00:00.000Z', complexity: 'low',
  }));
  // The scratch pair: the base bytes and the result bytes, diffed by git.
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'spec.md'), specBase);
  fs.writeFileSync(path.join(a, 'goals.md'), goalsBase);
  return { tmp, MAIN, bundleDir, statePath, scratch: { a, b } };
}

function approvalReceipt({ txid, bases, results, diffDigest, withGoalsAmend = true }) {
  const receipt = {
    attested_by: 'user',
    purpose: 'promotion',
    transaction_id: txid,
    approval_receipt_id: `receipt-${txid}`,
    base_hashes: bases,
    result_hashes: results,
    diff_digest: diffDigest,
    question: `Promote the approved amendment ${txid}?`,
    answer: 'Approve promotion',
    ts: '2026-09-06T00:00:00.000Z',
  };
  if (withGoalsAmend && bases.goals !== results.goals) {
    receipt.goals_amend = {
      attested_by: 'user',
      purpose: 'goal_amend',
      goals_hash: results.goals,
      old_goals_hash: bases.goals,
      question: 'Approve the goals half of the amendment?',
      answer: 'Approve goals amendment',
      ts: '2026-09-06T00:00:00.000Z',
    };
  }
  return receipt;
}

// Build the amendment inputs: result bytes for both halves + the REAL git diff.
function amendmentInputs(fx, { specResult, goalsResult, txid }) {
  fs.writeFileSync(path.join(fx.scratch.b, 'spec.md'), specResult);
  fs.writeFileSync(path.join(fx.scratch.b, 'goals.md'), goalsResult);
  const diff = gitDiffText(fx.scratch.a, fx.scratch.b);
  const bases = { spec: sha256Of(SPEC), goals: sha256Of(GOALS) };
  const results = { spec: sha256Of(specResult), goals: sha256Of(goalsResult) };
  return {
    transactionId: txid,
    diff,
    resultSpec: specResult,
    resultGoals: goalsResult,
    approval: approvalReceipt({ txid, bases, results, diffDigest: sha256Of(diff) }),
  };
}

const self = (fx, session = 'sess-promo') => buildOwnerIdentity({ host: 'h1', session, slug: 'promo', now: 1000 });

// ---- the happy path ---------------------------------------------------------------

test('approval binds both bases + the diff + both results; both applied, one record, bases pinned', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: Promoted\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-happy' });
  const out = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 1000 });
  assert.equal(out.outcome, 'promoted', JSON.stringify(out));
  assert.deepEqual(out.writes.sort(), ['goals', 'spec']);
  // Both halves landed at the EXACT approved bytes.
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), specResult);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), goalsResult);
  // Exactly one promotion record, exactly one goal_amended.
  const events = readEvents(fx.bundleDir);
  const promo = events.filter((e) => e.type === 'spec_amended');
  assert.equal(promo.length, 1);
  assert.equal(promo[0].data.transaction_id, 'tx-happy');
  assert.equal(promo[0].data.base_hashes.spec, inputs.approval.base_hashes.spec);
  assert.equal(promo[0].data.base_hashes.goals, inputs.approval.base_hashes.goals);
  assert.equal(promo[0].data.result_hashes.spec, inputs.approval.result_hashes.spec);
  assert.equal(promo[0].data.result_hashes.goals, inputs.approval.result_hashes.goals);
  assert.equal(promo[0].data.diff_digest, inputs.approval.diff_digest);
  assert.equal(promo[0].data.approval_receipt_id, 'receipt-tx-happy');
  assert.equal(events.filter((e) => e.type === 'goal_amended').length, 1);
  // The bases are PINNED BY REF against gc: the refs exist and point at the base blobs.
  for (const role of ['spec', 'goals']) {
    const ref = `${PROMOTION_REFS_PREFIX}tx-happy/${role}-base`;
    const oid = git(fx.MAIN, 'for-each-ref', '--format=%(objectname)', ref);
    assert.match(oid, /^[0-9a-f]{40}$/);
    assert.equal(gitRaw(fx.MAIN, 'cat-file', 'blob', oid),
      role === 'spec' ? SPEC : GOALS);
  }
  // And the pin survives a real gc prune: the pre-image stays recoverable.
  git(fx.MAIN, '-c', 'gc.reflogExpire=now', '-c', 'gc.reflogExpireUnreachable=now', 'gc', '--prune=now', '--quiet');
  const specOid = git(fx.MAIN, 'for-each-ref', '--format=%(objectname)', `${PROMOTION_REFS_PREFIX}tx-happy/spec-base`);
  assert.equal(gitRaw(fx.MAIN, 'cat-file', 'blob', specOid), SPEC);
});

test('the goals lineage converges so the existing split-brain guard stays satisfied', () => {
  const fx = mkbundle();
  const goalsResult = GOALS + '## G4: Lineage\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult: SPEC, goalsResult, txid: 'tx-lineage' });
  const out = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 1000 });
  assert.equal(out.outcome, 'promoted');
  const state = readState(fx.statePath);
  assert.equal(state.goals_md_hash, goalsHash(goalsResult));
  const amended = readEvents(fx.bundleDir).find((e) => e.type === 'goal_amended');
  assert.equal(amended.data.new_goals_hash, goalsHash(goalsResult));
  assert.equal(amended.data.old_goals_hash, goalsHash(GOALS));
});

// ---- replay (exactly-once by transaction_id) --------------------------------------

test('replay: the same transaction_id is a no-op — no second write, no second event', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old outcome.', 'The amended outcome.');
  const inputs = amendmentInputs(fx, { specResult, goalsResult: GOALS, txid: 'tx-replay' });
  const first = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 1000 });
  assert.equal(first.outcome, 'promoted');
  const before = readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended').length;
  const second = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 2000 });
  assert.equal(second.outcome, 'recorded');
  assert.equal(second.replay, true);
  assert.deepEqual(second.writes, []);
  const after = readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended').length;
  assert.equal(after, before);
  // This amendment never changed goals.md (base == result), so the goals lineage was
  // never entered — on the replay OR the first pass.
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'goal_amended').length, 0);
});

// ---- the expected-revision check ---------------------------------------------------

test('a mid-flight edit aborts BEFORE any write — neither artifact is touched', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old outcome.', 'The amended outcome.');
  const goalsResult = GOALS + '## G4: Guarded\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-midflight' });
  // Begin, then an intervening edit to SPEC before the commit — the approval's base no
  // longer matches the disk.
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), SPEC + '\n<!-- an intervening edit -->\n');
  const specBefore = fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8');
  const goalsBefore = fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8');
  const out = commitPromotion({ statePath: fx.statePath, transactionId: 'tx-midflight', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'base_drifted');
  assert.equal(out.artifact, 'spec');
  assert.deepEqual(out.writes, []);
  // Neither artifact changed: the expected-revision check fired BEFORE the mutation.
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), specBefore);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), goalsBefore);
  // No event, no record.
  assert.deepEqual(readEvents(fx.bundleDir), []);
});

// ---- torn state recovery ------------------------------------------------------------

test('torn recovery: spec=result, goals=base -> classified, goals applied, no double-apply', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: Torn\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-torn' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  // Simulate the crash AFTER the spec write and BEFORE the goals write: the spec on disk
  // is the approved result, goals is still the base, and the doc is still 'prepared'.
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), specResult);
  const out = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-torn', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'recovered', JSON.stringify(out));
  assert.deepEqual(out.classifications, { spec: 'result', goals: 'base' });
  // The torn half was completed; the already-written half was NOT rewritten.
  assert.deepEqual(out.writes, ['goals']);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), goalsResult);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), specResult);
  // Exactly one record.
  const events = readEvents(fx.bundleDir);
  assert.equal(events.filter((e) => e.type === 'spec_amended').length, 1);
  assert.equal(events.filter((e) => e.type === 'goal_amended').length, 1);
});

test('torn recovery, other order: spec=base, goals=result -> spec applied', () => {
  const fx = mkbundle();
  const specResult = SPEC + '\n## 3. Added\n\nA new section.\n';
  const goalsResult = GOALS + '## G4: OtherOrder\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-torn2' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), goalsResult);
  const out = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-torn2', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'recovered');
  assert.deepEqual(out.classifications, { spec: 'base', goals: 'result' });
  assert.deepEqual(out.writes, ['spec']);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), specResult);
});

test('crash before any write: both=base -> the diff is applied, then the record', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: BothBase\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-crashed-begin' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  const out = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-crashed-begin', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'recovered');
  assert.deepEqual(out.classifications, { spec: 'base', goals: 'base' });
  assert.deepEqual(out.writes.sort(), ['goals', 'spec']);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), specResult);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), goalsResult);
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended').length, 1);
});

test('crash after both writes: both=result -> only the record lands', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old outcome.', 'The amended outcome.');
  const goalsResult = GOALS + '## G4: AfterBoth\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-after-both' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), specResult);
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), goalsResult);
  const out = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-after-both', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'recovered');
  assert.deepEqual(out.classifications, { spec: 'result', goals: 'result' });
  assert.deepEqual(out.writes, []);
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended').length, 1);
});

// ---- the symmetric refusal -----------------------------------------------------------

test('a torn artifact matching NEITHER identity is refused — to the operator, never a guess', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: Refuse\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-neither-spec' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  // An intervening edit that is neither the base nor the result.
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), SPEC + '\n<!-- an intervening edit -->\n');
  const out = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-neither-spec', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'refused');
  assert.equal(out.refusal, 'intervening_edit');
  assert.equal(out.artifact, 'spec');
  assert.deepEqual(out.writes, []);
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended').length, 0);
});

test('the refusal is symmetric: the goals half matching neither refuses too', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: Symmetric\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-neither-goals' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), 'not the base, not the result\n');
  const out = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-neither-goals', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'refused');
  assert.equal(out.refusal, 'intervening_edit');
  assert.equal(out.artifact, 'goals');
});

// ---- the satisfied artifact ----------------------------------------------------------

test('an unchanged artifact is satisfied — never torn, never rewritten', () => {
  const fx = mkbundle();
  // The amendment touches ONLY spec.md; goals.md keeps its base bytes (base == result).
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const inputs = amendmentInputs(fx, { specResult, goalsResult: GOALS, txid: 'tx-satisfied' });
  // No goals_amend receipt is required: the amendment never changed goals.md.
  delete inputs.approval.goals_amend;
  const out = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 1000 });
  assert.equal(out.outcome, 'promoted');
  assert.deepEqual(out.writes, ['spec']);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), GOALS);
  // No goal_amended event for an unchanged goals.md — the lineage is untouched.
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'goal_amended').length, 0);
  // And the satisfied classification holds through recovery replay too.
  const again = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 2000 });
  assert.equal(again.outcome, 'recorded');
});

test('a satisfied artifact never contributes a torn state after a crash', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const inputs = amendmentInputs(fx, { specResult, goalsResult: GOALS, txid: 'tx-sat-crash' });
  delete inputs.approval.goals_amend;
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  // Crash simulation: spec was written; goals is UNTOUCHED — and untouched IS the
  // approved result, so recovery must classify it satisfied, not treat the pair as torn.
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), specResult);
  const out = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-sat-crash', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'recovered');
  assert.deepEqual(out.classifications, { spec: 'result', goals: 'satisfied' });
  assert.deepEqual(out.writes, []);
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended').length, 1);
});

// ---- the reproduction proof ----------------------------------------------------------

test('a diff that does not reproduce the approved result hashes is refused BEFORE anything is written', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: BadDiff\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-baddiff' });
  // Corrupt the diff so it no longer reproduces the approved spec result — and rebind
  // the digest so the failure being proven is the REPRODUCTION step, not the digest
  // binding (a digest mismatch is the same refusal class, proven by the stale-approval
  // case below).
  const tampered = inputs.diff.replace('The amended problem statement.', 'A DIFFERENT statement nobody approved');
  assert.notEqual(tampered, inputs.diff);
  const tamperedApproval = { ...inputs.approval, diff_digest: sha256Of(tampered) };
  const out = (() => {
    try {
      beginPromotion({
        statePath: fx.statePath,
        transactionId: 'tx-baddiff',
        diff: tampered,
        resultSpec: specResult,
        resultGoals: goalsResult,
        approval: tamperedApproval,
        now: 1000,
      });
      return { outcome: 'unexpectedly-began' };
    } catch (e) {
      return { outcome: 'refused', error: e.message };
    }
  })();
  assert.equal(out.outcome, 'refused');
  assert.match(out.error, /does not reproduce the approved resulting/);
  // NOTHING was written: no doc, no refs, no event, and both artifacts untouched.
  assert.equal(fs.existsSync(promotionDocPath(fx.statePath, 'tx-baddiff')), false);
  assert.equal(git(fx.MAIN, 'for-each-ref', `--format=%(refname)`, `${PROMOTION_REFS_PREFIX}tx-baddiff/`), '');
  assert.deepEqual(readEvents(fx.bundleDir), []);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), SPEC);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), GOALS);
});

test('an approval that does not bind the on-disk bases is refused (replay/stale)', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: Stale\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-stale' });
  // An approval produced against DIFFERENT bases than the disk holds.
  const foreignBases = { spec: sha256Of(SPEC + 'foreign\n'), goals: inputs.approval.base_hashes.goals };
  const stale = { ...inputs.approval, base_hashes: foreignBases };
  assert.throws(
    () => beginPromotion({
      statePath: fx.statePath,
      transactionId: 'tx-stale',
      diff: inputs.diff,
      resultSpec: specResult,
      resultGoals: goalsResult,
      approval: stale,
      now: 1000,
    }),
    /does not bind the base spec.md hash/
  );
  assert.equal(fs.existsSync(promotionDocPath(fx.statePath, 'tx-stale')), false);
});

test('an approval missing the goals_amend receipt refuses when goals change', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: NoReceipt\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-noreceipt' });
  delete inputs.approval.goals_amend;
  assert.throws(
    () => beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 }),
    /requires its own exact-artifact goal_amend approval receipt/
  );
});

// ---- the lock ------------------------------------------------------------------------

test('a live foreign owner is refused with ZERO writes (the lock spans everything)', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old outcome.', 'The amended outcome.');
  const goalsResult = GOALS + '## G4: Locked\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-locked' });
  // A LIVE foreign owner holds the bundle write lock.
  const foreign = buildOwnerIdentity({ host: 'h1', session: 'sess-foreign', slug: 'promo', now: 1000 });
  const acq = acquireOwner(fx.bundleDir, foreign, { now: 1000 });
  assert.equal(acq.outcome, 'acquire');
  const out = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 1100 });
  assert.equal(out.outcome, 'lock_refused');
  assert.deepEqual(out.writes, []);
  // Nothing was written: no doc, no event, both artifacts untouched.
  assert.equal(fs.existsSync(promotionDocPath(fx.statePath, 'tx-locked')), false);
  assert.deepEqual(readEvents(fx.bundleDir), []);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), SPEC);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), GOALS);
  // And recovery — a mutating path — refuses the same way while the foreign owner holds it.
  assert.equal(git(fx.MAIN, 'for-each-ref', '--format=%(refname)', `${PROMOTION_REFS_PREFIX}tx-locked/`), '');
});

test('recovery holds the lock across the remaining write and the record', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: RecLock\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-reclock' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), specResult); // the torn half
  // A LIVE foreign owner: recovery must refuse with zero writes.
  const foreign = buildOwnerIdentity({ host: 'h1', session: 'sess-foreign2', slug: 'promo', now: 1000 });
  acquireOwner(fx.bundleDir, foreign, { now: 1000 });
  const refused = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-reclock', self: self(fx), now: 1100 });
  assert.equal(refused.outcome, 'lock_refused');
  assert.deepEqual(refused.writes, []);
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended').length, 0);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), GOALS);
});

// ---- the entry path's crash routing -----------------------------------------------------

test('the entry path routes an existing prepared transaction through recovery, never a second begin', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: RouteRecovery\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-route' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  // A second call with the SAME transaction_id converges the begun transaction (the
  // decision table) instead of beginning over it.
  const out = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'recovered');
  assert.equal(out.via, 'recover');
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), specResult);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), goalsResult);
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended').length, 1);
});

test('an unknown transaction id refuses (there is nothing to recover)', () => {
  const fx = mkbundle();
  assert.throws(
    () => recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-absent', self: self(fx), now: 1000 }),
    /no promotion transaction "tx-absent"/
  );
});

test('a malformed transaction id refuses before touching anything', () => {
  const fx = mkbundle();
  assert.throws(
    () => recoverPromotion({ statePath: fx.statePath, transactionId: '../evil', self: self(fx) }),
    /transaction_id must match/
  );
});
test('a direct re-begin over an existing transaction refuses (never overwrite the durable record)', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: ReBegin\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-rebegin' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  assert.throws(
    () => beginPromotion({ statePath: fx.statePath, ...inputs, now: 2000 }),
    /already exists .* never re-begin/
  );
});

test('recovery works from a linked worktree (MAIN derivation, not the worktree)', () => {
  const fx = mkbundle();
  // A linked worktree under MAIN — the bundle is edited there (the fleet shape), so the
  // pin and the read must derive MAIN (the common dir's parent), never the worktree.
  const WT = path.join(fx.MAIN, '.worktrees', 'promo');
  git(fx.MAIN, 'worktree', 'add', '-q', '-b', 'masterplan/promo', WT);
  const wtBundle = path.join(WT, 'docs', 'masterplan', 'promo');
  fs.mkdirSync(wtBundle, { recursive: true });
  fs.writeFileSync(path.join(wtBundle, 'spec.md'), SPEC);
  fs.writeFileSync(path.join(wtBundle, 'goals.md'), GOALS);
  const wtState = path.join(wtBundle, 'state.yml');
  writeState(wtState, buildSeedState({
    slug: 'promo', topic: 'Promote an approved amendment durably.',
    createdAt: '2026-01-01T00:00:00.000Z', complexity: 'low',
  }));
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: LinkedWT\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-wt' });
  const out = promoteAmendment({ statePath: wtState, ...inputs, self: buildOwnerIdentity({ host: 'h1', session: 'sess-wt', slug: 'promo', now: 1000 }), now: 1000 });
  assert.equal(out.outcome, 'promoted', JSON.stringify(out));
  // The pins landed in MAIN's object store (the common dir), readable from MAIN.
  const ref = `${PROMOTION_REFS_PREFIX}tx-wt/spec-base`;
  const oid = git(fx.MAIN, 'for-each-ref', '--format=%(objectname)', ref);
  assert.match(oid, /^[0-9a-f]{40}$/);
  assert.equal(gitRaw(fx.MAIN, 'cat-file', 'blob', oid), SPEC);
});

// ---- the black-box ENTRY PATH (advisor: the real seam, not the library) ----------------

test('mp amend-promote: the bin verb drives the transaction end-to-end, exactly-once, refusing a stale approval', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: BlackBox\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-bin' });
  // The four artifacts as files (the verb owns the fs reads):
  const art = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-bin-'));
  fs.writeFileSync(path.join(art, 'diff.patch'), inputs.diff);
  fs.writeFileSync(path.join(art, 'spec.md'), inputs.resultSpec);
  fs.writeFileSync(path.join(art, 'goals.md'), inputs.resultGoals);
  fs.writeFileSync(path.join(art, 'approval.json'), JSON.stringify(inputs.approval));
  const owner = JSON.stringify(self(fx, 'sess-bin'));
  const argv = [
    BIN, 'amend-promote',
    `--state=${fx.statePath}`,
    '--transaction-id=tx-bin',
    `--diff-file=${path.join(art, 'diff.patch')}`,
    `--result-spec-file=${path.join(art, 'spec.md')}`,
    `--result-goals-file=${path.join(art, 'goals.md')}`,
    `--approval-file=${path.join(art, 'approval.json')}`,
    `--self=${owner}`,
  ];
  const run = () => {
    const r = spawnSync(process.execPath, argv, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`amend-promote exited ${r.status}: ${r.stderr}`);
    return r.stdout;
  };
  const first = JSON.parse(run());
  assert.equal(first.amend_promote, 'promoted', JSON.stringify(first));
  assert.ok(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8').includes('The amended problem statement.'));
  assert.ok(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8').includes('## G4: BlackBox'));
  // Exactly-once: the same transaction replays as a no-op (recovery finds both artifacts at
  // their approved results), never a second record:
  const second = JSON.parse(run());
  assert.equal(second.amend_promote, 'recorded', JSON.stringify(second));
  assert.equal(second.replay, true, 'the replay is recognized, never a second write');
  // A stale approval (the bases moved since approval) is refused BEFORE any write, exit 1:
  const fx2 = mkbundle();
  const staleSpec = specResult.replace('The amended problem statement.', 'A DIFFERENT amendment.');
  const stale = amendmentInputs(fx2, { specResult: staleSpec, goalsResult, txid: 'tx-stale' });
  // The approval bound fx2's ORIGINAL spec base; drift it by hand BEFORE the verb runs:
  fs.writeFileSync(path.join(fx2.bundleDir, 'spec.md'), SPEC + '\n<!-- a late hand edit -->\n');
  fs.writeFileSync(path.join(art, 'diff2.patch'), stale.diff);
  fs.writeFileSync(path.join(art, 'spec2.md'), stale.resultSpec);
  fs.writeFileSync(path.join(art, 'goals2.md'), stale.resultGoals);
  fs.writeFileSync(path.join(art, 'approval2.json'), JSON.stringify(stale.approval));
  const staleRun = spawnSync(process.execPath, [
    BIN, 'amend-promote',
    `--state=${fx2.statePath}`,
    '--transaction-id=tx-stale',
    `--diff-file=${path.join(art, 'diff2.patch')}`,
    `--result-spec-file=${path.join(art, 'spec2.md')}`,
    `--result-goals-file=${path.join(art, 'goals2.md')}`,
    `--approval-file=${path.join(art, 'approval2.json')}`,
    `--self=${owner}`,
  ], { encoding: 'utf8' });
  assert.notEqual(staleRun.status, 0, 'a stale approval must exit non-zero');
  assert.match(staleRun.stderr, /base_hashes|invalid promotion approval/);
});

