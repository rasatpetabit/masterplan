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

import { writeState, readState, buildSeedState, appendEvent } from '../lib/bundle.mjs';
import { goalsHash } from '../lib/goals.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { acquireOwner } from '../lib/owner-fs.mjs';
import { beginPromotion, commitPromotion, recoverPromotion, promotionDocPath, PROMOTION_REFS_PREFIX, classifyArtifact, pinnedGoalsEvidenceHash } from '../lib/promote.mjs';
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

// ---- a DRIFTED unchanged artifact never bypasses drift detection (W14 finding 1) ------
//
// base == result must never waive the drift check: the unchanged artifact still has to
// BE its approved base on disk. Any other bytes classify `neither` — the symmetric
// refusal, in BOTH orientations (spec-only amendment with drifted goals.md; goals-only
// amendment with drifted spec.md), through BOTH the commit and the recovery paths.

test('spec-only amendment with a DRIFTED goals.md refuses on the COMMIT path (drifted satisfied is neither)', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const inputs = amendmentInputs(fx, { specResult, goalsResult: GOALS, txid: 'tx-f1-commit' });
  delete inputs.approval.goals_amend;
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  // An UNAPPROVED hand edit to the unchanged goals.md AFTER the begin: the approval
  // bound its exact base bytes, and unchanged never means "anything goes".
  const unapproved = GOALS + '## G9: UNAPPROVED\nsignal: never\n';
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), unapproved);
  const out = commitPromotion({ statePath: fx.statePath, transactionId: 'tx-f1-commit', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'base_drifted', JSON.stringify(out));
  assert.equal(out.artifact, 'goals');
  assert.deepEqual(out.writes, []);
  // NOTHING was written: the unapproved bytes stay on disk, no event, no record.
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), unapproved);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), SPEC);
  assert.deepEqual(readEvents(fx.bundleDir), []);
  // And the RECOVERY path refuses the same disk — the symmetric refusal.
  const rec = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-f1-commit', self: self(fx), now: 3000 });
  assert.equal(rec.outcome, 'refused');
  assert.equal(rec.refusal, 'intervening_edit');
  assert.equal(rec.artifact, 'goals');
  assert.deepEqual(rec.writes, []);
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended').length, 0);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), unapproved);
});

test('goals-only amendment with a DRIFTED spec.md refuses on the COMMIT path (the symmetric orientation)', () => {
  const fx = mkbundle();
  const goalsResult = GOALS + '## G4: GoalsOnly\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult: SPEC, goalsResult, txid: 'tx-f1-commit2' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  const unapproved = SPEC + '\n<!-- an unapproved spec edit -->\n';
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), unapproved);
  const out = commitPromotion({ statePath: fx.statePath, transactionId: 'tx-f1-commit2', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'base_drifted', JSON.stringify(out));
  assert.equal(out.artifact, 'spec');
  assert.deepEqual(out.writes, []);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), unapproved);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), GOALS);
  assert.deepEqual(readEvents(fx.bundleDir), []);
});

test('spec-only amendment with a DRIFTED goals.md refuses on the RECOVERY path (never blessed as satisfied)', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const inputs = amendmentInputs(fx, { specResult, goalsResult: GOALS, txid: 'tx-f1-rec' });
  delete inputs.approval.goals_amend;
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  // Crash shape + drift: the spec write landed, and goals.md carries UNAPPROVED bytes a
  // later hand edit wrote. The pre-fix bug classified goals as satisfied (base == result
  // bypassed the hash check) and blessed the drifted disk; it must refuse instead.
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), specResult);
  const unapproved = GOALS + '## G9: UNAPPROVED\nsignal: never\n';
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), unapproved);
  const out = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-f1-rec', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'refused', JSON.stringify(out));
  assert.equal(out.refusal, 'intervening_edit');
  assert.equal(out.artifact, 'goals');
  assert.deepEqual(out.classifications, { spec: 'result', goals: 'neither' });
  assert.deepEqual(out.writes, []);
  // The transaction never blesses drifted disk: no event, no record, and the unapproved
  // bytes stay EXACTLY as the operator left them.
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended').length, 0);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), unapproved);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), specResult);
});

test('goals-only amendment with a DRIFTED spec.md refuses on the RECOVERY path (never blessed as satisfied)', () => {
  const fx = mkbundle();
  const goalsResult = GOALS + '## G4: GoalsOnlyRec\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult: SPEC, goalsResult, txid: 'tx-f1-rec2' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), goalsResult); // the torn half landed
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), SPEC + '\n<!-- an unapproved spec edit -->\n');
  const out = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-f1-rec2', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'refused');
  assert.equal(out.refusal, 'intervening_edit');
  assert.equal(out.artifact, 'spec');
  assert.deepEqual(out.classifications, { spec: 'neither', goals: 'result' });
  assert.deepEqual(out.writes, []);
  assert.equal(readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended').length, 0);
});

test('classifyArtifact: a satisfied classification requires the disk to BE the approved base', () => {
  // The decision table's unit contract, proven directly: base == result + disk == base →
  // satisfied; base == result + drifted disk → neither (never satisfied).
  assert.equal(classifyArtifact(sha256Of(SPEC), sha256Of(SPEC), sha256Of(SPEC)), 'satisfied');
  assert.equal(classifyArtifact(sha256Of(SPEC + 'drift\n'), sha256Of(SPEC), sha256Of(SPEC)), 'neither');
  assert.equal(classifyArtifact(sha256Of(GOALS), sha256Of(GOALS), sha256Of(GOALS)), 'satisfied');
  assert.equal(classifyArtifact(sha256Of(GOALS + '## G9: X\n'), sha256Of(GOALS), sha256Of(GOALS)), 'neither');
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

// ---- a crash after the terminal event but before state convergence (W14 finding 2) --
//
// The exactly-once terminal event is the commit point; the goals-cache convergence
// (state.yml's goals_md_hash) is a DERIVED write that follows it. A crash between them
// must not strand the cache forever: the replay path completes the convergence under the
// held lock, from the event's data (the authority), and never double-appends.
// The crash is injected through the module's real state-write seam: writeState's
// tmp+rename (lib/bundle.mjs) targets a DETERMINISTIC `<statePath>.tmp` path, so a
// DIRECTORY planted there raises EISDIR exactly at the convergence write — the exact
// crash window under test, reached with the REAL entry path.

test('a crash between the terminal event and the state write: the replay CONVERGES the stranded goals cache, exactly-once', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: CrashConverge\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-crashconv' });
  // Inject the crash AT THE STATE WRITE: the tmp+rename seam's deterministic temp path
  // becomes a directory → EISDIR exactly at recordTransaction's convergence write, AFTER
  // both events have appended. The real entry path throws — the crash is simulated.
  const tmpSeam = `${fx.statePath}.tmp`;
  fs.mkdirSync(tmpSeam);
  assert.throws(
    () => promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 1000 }),
    /EISDIR|already exists and is not a file/
  );
  fs.rmSync(tmpSeam, { recursive: true, force: true });
  // The crash shape: both artifacts landed at their approved results, the terminal event
  // + goal_amended are recorded, but state.goals_md_hash was NEVER converged.
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), specResult);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), goalsResult);
  const events = readEvents(fx.bundleDir);
  assert.equal(events.filter((e) => e.type === 'spec_amended').length, 1);
  assert.equal(events.filter((e) => e.type === 'goal_amended').length, 1);
  const stateBefore = readState(fx.statePath);
  assert.equal(stateBefore.goals_md_hash, undefined);
  // The REPLAY (the real entry path, same transaction_id): the terminal event is already
  // recorded, so the replay detects the unconverged cache, completes the convergence
  // under the held lock, and reports recorded/replay — WITHOUT double-appending.
  const replay = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 2000 });
  assert.equal(replay.outcome, 'recorded', JSON.stringify(replay));
  assert.equal(replay.replay, true);
  assert.equal(replay.converged_goals_cache, true, 'the replay completed the stranded convergence');
  assert.deepEqual(replay.writes, []);
  assert.deepEqual(replay.appended, []);
  const stateAfter = readState(fx.statePath);
  assert.equal(stateAfter.goals_md_hash, goalsHash(goalsResult), 'the goals cache converged to the amended evidence hash');
  // Exactly-once held: the replay did NOT double-append either event.
  const after = readEvents(fx.bundleDir);
  assert.equal(after.filter((e) => e.type === 'spec_amended').length, 1);
  assert.equal(after.filter((e) => e.type === 'goal_amended').length, 1);
});

test('a converged replay stays a pure no-op — the converged-cache completion is not re-run', () => {
  const fx = mkbundle();
  const goalsResult = GOALS + '## G4: PureReplay\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult: SPEC, goalsResult, txid: 'tx-purereplay' });
  const first = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 1000 });
  assert.equal(first.outcome, 'promoted');
  const replay = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 2000 });
  assert.equal(replay.outcome, 'recorded');
  assert.equal(replay.replay, true);
  assert.equal(replay.converged_goals_cache, undefined, 'a converged cache is not re-converged');
});

test('a crash after the event leaves the recovery-path REPLAY convergent too (commit re-entry)', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old outcome.', 'The amended outcome.');
  const goalsResult = GOALS + '## G4: RecConverge\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-recconv' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  const tmpSeam = `${fx.statePath}.tmp`;
  fs.mkdirSync(tmpSeam);
  assert.throws(
    () => commitPromotion({ statePath: fx.statePath, transactionId: 'tx-recconv', self: self(fx), now: 2000 }),
    /EISDIR|already exists and is not a file/
  );
  fs.rmSync(tmpSeam, { recursive: true, force: true });
  assert.equal(readState(fx.statePath).goals_md_hash, undefined);
  // Commit re-entry routes through the recovery table → the recorded event → the
  // convergent replay: same completion, same exactly-once.
  const out = commitPromotion({ statePath: fx.statePath, transactionId: 'tx-recconv', self: self(fx), now: 3000 });
  assert.equal(out.outcome, 'recorded', JSON.stringify(out));
  assert.equal(out.replay, true);
  assert.equal(out.converged_goals_cache, true);
  assert.equal(readState(fx.statePath).goals_md_hash, goalsHash(goalsResult));
  const events = readEvents(fx.bundleDir);
  assert.equal(events.filter((e) => e.type === 'spec_amended').length, 1);
  assert.equal(events.filter((e) => e.type === 'goal_amended').length, 1);
});

test('a crash before the terminal event never fakes convergence: recovery completes the torn write instead', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: TornNotFake\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-tornnotfake' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  // The artifact writes landed but the events did NOT: recovery classifies both=result,
  // appends exactly once, and converges the cache — the decision-table path, never the
  // replay path (there is no terminal event yet to have committed anything).
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), specResult);
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), goalsResult);
  const out = recoverPromotion({ statePath: fx.statePath, transactionId: 'tx-tornnotfake', self: self(fx), now: 2000 });
  assert.equal(out.outcome, 'recovered');
  assert.equal(readState(fx.statePath).goals_md_hash, goalsHash(goalsResult));
  const events = readEvents(fx.bundleDir);
  assert.equal(events.filter((e) => e.type === 'spec_amended').length, 1);
  assert.equal(events.filter((e) => e.type === 'goal_amended').length, 1);
});

test('a superseding goal_amended after the crash is NOT unconverged — the replay never rewinds a newer lineage hash', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old outcome.', 'The amended outcome.');
  const goalsResult = GOALS + '## G4: CrashSupersede\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-supersede' });
  const tmpSeam = `${fx.statePath}.tmp`;
  fs.mkdirSync(tmpSeam);
  assert.throws(
    () => promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 1000 }),
    /EISDIR|already exists and is not a file/
  );
  fs.rmSync(tmpSeam, { recursive: true, force: true });
  // A LATER amendment on top (the legitimate lineage continuation): its event carries a
  // new_goals_hash newer than this transaction's result, and the cache converged TO IT.
  // The supersession is recognized ONLY through its AUTHORIZATION (the re-review's finding
  // 1: hash claims alone prove nothing): this simulates the interview goals-amend verb's
  // REAL event shape — the approval receipt the verb validates at write time, replayed by
  // the same validateUserApprovalReceipt at read time (a stale or approval-less event is
  // not a supersession; see the re-review finding-1 regression).
  const later = goalsResult + '## G5: Later\nsignal: test\n';
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), later);
  appendEvent(fx.statePath, {
    type: 'goal_amended',
    ts: new Date(3000).toISOString(),
    data: {
      old_goals_hash: goalsHash(goalsResult),
      new_goals_hash: goalsHash(later),
      goals_hash: goalsHash(later),
      reason: 'a later amendment',
      approval: {
        attested_by: 'user',
        purpose: 'goal_amend',
        goals_hash: goalsHash(later),
        old_goals_hash: goalsHash(goalsResult),
        question: 'Approve the goals amendment?',
        answer: 'Approve',
        ts: new Date(3000).toISOString(),
      },
    },
    summary: 'goals amended (1 changed) by the approved interview amendment: a later amendment superseded the crashed one',
  });
  writeState(fx.statePath, { ...readState(fx.statePath), goals_md_hash: goalsHash(later) });
  // The replay recognizes the supersession and does NOT rewind the cache to the crashed
  // transaction's older result hash.
  const replay = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 4000 });
  assert.equal(replay.outcome, 'recorded', JSON.stringify(replay));
  assert.equal(replay.converged_goals_cache, undefined, 'a superseded lineage is not unconverged');
  assert.equal(readState(fx.statePath).goals_md_hash, goalsHash(later), 'the newer lineage hash stands');
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

// ---- successful crash recovery is a SUCCESS exit (W14 finding 4) --------------------

test('mp amend-promote: a torn transaction driven to recovery by the real bin exits 0 and reports recovered', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: Recovered\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-recover-exit' });
  // Begin the transaction, then TEAR it: the durable doc stays (state 'prepared'), the
  // spec write landed, goals did not. The next amend-promote call must route through
  // recovery, converge, print amend_promote: recovered, and EXIT 0 — a successful crash
  // recovery is a success, never a failure.
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), specResult);
  const art = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-bin-'));
  fs.writeFileSync(path.join(art, 'diff.patch'), inputs.diff);
  fs.writeFileSync(path.join(art, 'spec.md'), inputs.resultSpec);
  fs.writeFileSync(path.join(art, 'goals.md'), inputs.resultGoals);
  fs.writeFileSync(path.join(art, 'approval.json'), JSON.stringify(inputs.approval));
  const run = () => spawnSync(process.execPath, [
    BIN, 'amend-promote',
    `--state=${fx.statePath}`,
    '--transaction-id=tx-recover-exit',
    `--diff-file=${path.join(art, 'diff.patch')}`,
    `--result-spec-file=${path.join(art, 'spec.md')}`,
    `--result-goals-file=${path.join(art, 'goals.md')}`,
    `--approval-file=${path.join(art, 'approval.json')}`,
    `--self=${JSON.stringify(self(fx, 'sess-recover'))}`,
  ], { encoding: 'utf8' });
  const r = run();
  assert.equal(r.status, 0, `successful crash recovery must exit 0 — got ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.amend_promote, 'recovered', JSON.stringify(out));
  // The convergence is real: the torn half completed and the record landed exactly once.
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), goalsResult);
  const events = readEvents(fx.bundleDir);
  assert.equal(events.filter((e) => e.type === 'spec_amended').length, 1);
  assert.equal(events.filter((e) => e.type === 'goal_amended').length, 1);
  // And the idempotent re-entry (now recorded) still exits 0: recorded is a success too.
  const r2 = run();
  assert.equal(r2.status, 0);
  assert.equal(JSON.parse(r2.stdout).amend_promote, 'recorded');
});

test('mp amend-promote: the refusals keep exiting 1 (recovered never blesses a refusal)', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('The old problem statement.', 'The amended problem statement.');
  const goalsResult = GOALS + '## G4: RefuseExit\nsignal: test\n';
  const inputs = amendmentInputs(fx, { specResult, goalsResult, txid: 'tx-refuse-exit' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  // An intervening edit: recovery must refuse (exit 1), never recover.
  fs.writeFileSync(path.join(fx.bundleDir, 'spec.md'), SPEC + '\n<!-- an intervening edit -->\n');
  const art = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-bin-'));
  fs.writeFileSync(path.join(art, 'diff.patch'), inputs.diff);
  fs.writeFileSync(path.join(art, 'spec.md'), inputs.resultSpec);
  fs.writeFileSync(path.join(art, 'goals.md'), inputs.resultGoals);
  fs.writeFileSync(path.join(art, 'approval.json'), JSON.stringify(inputs.approval));
  const r = spawnSync(process.execPath, [
    BIN, 'amend-promote',
    `--state=${fx.statePath}`,
    '--transaction-id=tx-refuse-exit',
    `--diff-file=${path.join(art, 'diff.patch')}`,
    `--result-spec-file=${path.join(art, 'spec.md')}`,
    `--result-goals-file=${path.join(art, 'goals.md')}`,
    `--approval-file=${path.join(art, 'approval.json')}`,
    `--self=${JSON.stringify(self(fx, 'sess-refuse'))}`,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'a refusal must keep exiting 1');
  assert.match(r.stdout, /"amend_promote":"refused"/);
  assert.match(r.stdout + r.stderr, /intervening edit/);
});


// ---- the whole-scope review fix round (2026-09-07): findings 1, 6, 7 ----------------
//
// The reviewers left reproduction probes at /tmp/agent1-promotion-probe.mjs and
// /tmp/agent2-promotion.mjs; the regressions below mirror their exact scenarios.

// F1 [rework] — the promotion's goals lineage hashes under the bundle's DURABLE format
// pin (§6.1), the same pin every consumer (checkpoint identity, finish tuple, split-brain
// guard) dispatches on. The probe promoted a versioned goals amendment on a bundle whose
// pin said schema_backed and found state.goals_md_hash recorded UNPINNED — the legacy
// flavor — while buildIntentIdentity hashed under the pin: the lineage and the consumer
// never agreed. The regression is the probe's exact scenario, schema-backed end to end.
import { resolveFormatPin, repairFormatPin } from '../lib/bundle.mjs';
import { encodeIntentBlock, INTENT_CODEC_VERSION } from '../lib/goals.mjs';
import { buildIntentIdentity } from '../lib/checkpoint-evidence.mjs';
import { captureSchema, registerSchemaSnapshotModule } from '../lib/interview.mjs';
import { captureSchemaSnapshot, computeSkillIdentity } from '../lib/schema-snapshot.mjs';
import { readRecordedReconciliation, resolveReconciliationTarget, buildReconciliationRows, recordReconciliation, RECONCILIATION_FILENAME } from '../lib/reconcile-intent.mjs';

function versionedGoalsMdForPin() {
  const authoritative = {
    version: INTENT_CODEC_VERSION,
    schema: { identity: 'design-intent@fixture', format_version: 1 },
    sections: {
      purpose: { body: 'The promotion hashes under the durable pin.\n' },
      non_goals: { items: ['no second canonicalizer'] },
      top_invariant: { body: 'One pin, every hash family.' },
      direction: { body: 'The lineage and the consumers agree.' },
      posture: { body: 'Refuse unpinned hashes.' },
    },
    context: { outcome: { body: 'The lineage matches the checkpoint identity.' }, done_means: { body: 'release' } },
    evidence: [{ section: 'purpose', source: 'operator interview 2026-09-07' }],
    reconciliation: [{ target: 'repository INTENT.md §1', status: 'verified' }],
  };
  const enc = encodeIntentBlock(authoritative);
  assert.ok(enc.ok, JSON.stringify(enc));
  return `topic: |\n  Versioned promotion fixture.\n${enc.block}\n## G1: Works\nsignal: test\n## G2: Fast\nsignal: test\n## G3: Documented\nsignal: docs\n`;
}

test('F1 regression: a versioned goals amendment promotes with its lineage hashed under the DURABLE pin — the checkpoint identity agrees', () => {
  const base = versionedGoalsMdForPin();
  const fx = mkbundle({ goalsBase: base });
  // A schema-backed bundle: capture the schema (stamps format_pin schema_backed), then a
  // recorded §6.3 reconciliation — the exact state the checkpoint identity requires.
  const skillRoot = path.join(fx.tmp, 'skill');
  const manifest = {
    manifest_version: 1, skill: 'fixture-intent', host_contract_version: 1, schema_format_version: 1,
    identity: { algorithm: 'sha256', closed_file_set: ['SKILL.md', 'manifest.json', 'schema.json'] },
  };
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fixture design-intent\n');
  fs.writeFileSync(path.join(skillRoot, 'schema.json'), `${JSON.stringify({
    version: 1,
    core: ['Purpose'],
    standard_extensions: ['Direction', 'Posture'],
    checked_sections: ['Purpose', 'Top invariant', 'Non-goals', 'Direction', 'Posture'],
    check_verdicts: ['serves', 'neutral', 'fights', 'unavailable'],
    plan_level: {
      anchor_key: 'topic',
      reconciliation: 'Reconciliation',
      reconciliation_unit: 'section',
      reconciliation_verdicts: ['serves', 'neutral', 'conflicts'],
      goal_heading_pattern: '^## G\\d+:',
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(skillRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  captureSchema({ statePath: fx.statePath, skillRoot });
  // §6.1's sanctioned repair: the capture stamps the pin into the history; the durable
  // state field is repaired from it (idempotent — the same repair every consumer performs).
  repairFormatPin(fx.statePath);
  assert.deepEqual(resolveFormatPin(fx.statePath), { pin: 'schema_backed' });
  // The §6.3 reconciliation the checkpoint identity's reconciliation_digest requires.
  const targetTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-f1-target-'));
  TMPDIRS.push(targetTmp);
  const target = path.join(targetTmp, 'target');
  write(target, 'INTENT.md', '# INTENT\n\n## Purpose\nPinned lineage.\n');
  git(target, 'init', '-q', '--initial-branch=main');
  git(target, 'config', 'user.email', 'test@test');
  git(target, 'config', 'user.name', 'test');
  git(target, 'config', 'commit.gpgsign', 'false');
  git(target, 'add', '--all');
  git(target, 'commit', '-q', '-m', 'init');
  execFileSync('git', ['clone', '-q', target, path.join(targetTmp, 'consumer')], { encoding: 'utf8' });
  const rr = resolveReconciliationTarget({ repository: path.join(targetTmp, 'consumer'), remote: 'origin', ref: 'main', now: 1757112000000 });
  assert.equal(rr.ok, true);
  const rows = buildReconciliationRows({ identity: rr.identity, statePath: fx.statePath, verdictBySection: { Purpose: 'serves' } });
  assert.equal(rows.ok, true, JSON.stringify(rows));
  recordReconciliation({ statePath: fx.statePath, record: rows.record, at: 1757112000001 });

  // The versioned goals amendment: only goals.md changes, by one word.
  const result = base.replace('## G1: Works', '## G1: Works better\nsignal: test');
  fs.writeFileSync(path.join(fx.scratch.b, 'spec.md'), SPEC);
  fs.writeFileSync(path.join(fx.scratch.b, 'goals.md'), result);
  const diff = gitDiffText(fx.scratch.a, fx.scratch.b);
  const approval = approvalReceipt({
    txid: 'f1-pin-seam',
    bases: { spec: sha256Of(SPEC), goals: sha256Of(base) },
    results: { spec: sha256Of(SPEC), goals: sha256Of(result) },
    diffDigest: sha256Of(diff),
  });
  const out = promoteAmendment({
    statePath: fx.statePath, transactionId: 'f1-pin-seam', diff,
    resultSpec: SPEC, resultGoals: result, approval, self: self(fx), now: 1000,
  });
  assert.equal(out.outcome, 'promoted', JSON.stringify(out));

  // THE SEAM: state.goals_md_hash, the goal_amended event, the recovery path, and the
  // checkpoint identity all hash under the SAME pin — the probe's expected hash, not the
  // unpinned legacy flavor it reproduced before the fix.
  const pinnedExpected = goalsHash(result, { formatPin: 'schema_backed' });
  const unpinnedLegacy = goalsHash(result);
  assert.notEqual(pinnedExpected, unpinnedLegacy, 'the two flavors must differ (the seam is real)');
  assert.equal(readState(fx.statePath).goals_md_hash, pinnedExpected,
    'the goals cache converges to the PINNED evidence hash, never the unpinned flavor');
  const amended = readEvents(fx.bundleDir).find((e) => e.type === 'goal_amended');
  assert.equal(amended.data.new_goals_hash, pinnedExpected);
  assert.equal(amitted_old(amended), pinnedEvidenceOf(base), 'the lineage old hash is the PINNED base hash');

  // The promotion->checkpoint regression the finding names: promote a versioned goals
  // amendment, then build the CHECKPOINT IDENTITY and assert the lineage hashes MATCH.
  const identity = buildIntentIdentity({ statePath: fx.statePath, skillRoot });
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.equal(identity.identity.goals_hash, pinnedExpected,
    'the checkpoint identity (the consumer) and the recorded lineage (the producer) agree under the pin');
  // And the REPLAY path repeats the pinned hash, never reverting to the unpinned one.
  const replay = promoteAmendment({
    statePath: fx.statePath, transactionId: 'f1-pin-seam', diff,
    resultSpec: SPEC, resultGoals: result, approval, self: self(fx), now: 2000,
  });
  assert.equal(replay.outcome, 'recorded');
  assert.equal(readState(fx.statePath).goals_md_hash, pinnedExpected);
});

// The pinned evidence hash of the BASE bytes (a local alias so the lineage assertion reads).
function amitted_old(ev) { return ev.data.old_goals_hash; }
function pinnedEvidenceOf(text) { return goalsHash(text, { formatPin: 'schema_backed' }); }

// F6 [rework] — commit/recovery/replay REVALIDATE the durable doc before any mutation: a
// tampered durable diff, a rewritten result_hashes.spec, or a swapped approval receipt all
// refuse with ZERO writes (the symmetric refusal), never write UNAPPROVED spec bytes.
for (const mode of ['rewritten-diff', 'rewritten-result', 'agent-attested-approval']) {
  test(`F6 regression: a tampered durable doc (${mode}) refuses before any mutation — no unapproved writes`, () => {
    const fx = mkbundle();
    const specResult = SPEC.replace('old problem', 'approved problem');
    const inputs = amendmentInputs(fx, { specResult, goalsResult: GOALS, txid: 'f6-tamper' });
    beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
    // The tamper: the durable doc's own fields are rewritten between begin and the commit.
    const dp = promotionDocPath(fx.statePath, 'f6-tamper');
    const doc = JSON.parse(fs.readFileSync(dp, 'utf8'));
    if (mode === 'rewritten-diff') {
      doc.diff = doc.diff.replace('approved problem', 'UNAPPROVED problem');
    } else if (mode === 'rewritten-result') {
      doc.result_hashes.spec = sha256Of(SPEC.replace('old problem', 'UNAPPROVED problem'));
    } else {
      doc.approval.attested_by = 'agent';
    }
    fs.writeFileSync(dp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    // The commit path revalidates and REFUSES: no artifact is touched, no event lands.
    let threw = null;
    try {
      commitPromotion({ statePath: fx.statePath, transactionId: 'f6-tamper', self: self(fx), now: 2000 });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'the tampered doc refuses (a throw, never a silent write)');
    assert.match(threw.message, /does not match its recorded diff_digest|no longer binds its recorded fields|attested_by must be 'user'/,
      `the refusal names the revalidation failure (${threw.message.slice(0, 80)})`);
    assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), SPEC,
      'spec.md stays at its approved base — UNAPPROVED bytes were never written');
    assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), GOALS);
    assert.deepEqual(readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended'), [],
      'no promotion record landed for a tampered transaction');
  });
}

// F7 [rework] — a forged terminal event does not suppress an unfinished promotion: a
// hand-appended {type:'spec_amended', data:{transaction_id}} binds nothing, is ignored as
// a commit point, and the transaction proceeds through its decision table (spec=base →
// the diff applies), never a silent zero-write "replay".
test('F7 regression: a forged terminal event is ignored as a commit point — the promotion completes through its decision table, never a zero-write pass', () => {
  const fx = mkbundle();
  const specResult = SPEC.replace('old problem', 'approved problem');
  const inputs = amendmentInputs(fx, { specResult, goalsResult: GOALS, txid: 'f7-forged' });
  beginPromotion({ statePath: fx.statePath, ...inputs, now: 1000 });
  // The forgery: the reviewers' exact hand-appended event — the transaction_id and nothing
  // else. It binds no bases, no results, no diff digest, no approval receipt.
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'spec_amended', data: { transaction_id: 'f7-forged' } })}\n`, 'utf8');
  const out = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 2000 });
  // The table classifies spec=base (not yet applied) and COMPLETES the promotion — the
  // forged event never turned an unfinished transaction into a no-op.
  assert.equal(out.outcome, 'recovered', JSON.stringify(out));
  assert.deepEqual(out.writes, ['spec'], 'the real write landed');
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'spec.md'), 'utf8'), specResult,
    'spec.md is at its APPROVED result — the promotion completed, never a silent zero-write pass');
  const events = readEvents(fx.bundleDir).filter((e) => e.type === 'spec_amended');
  assert.equal(events.length, 2, 'the forged event and the real record both stand; the real one is the fully-bound commit point');
  assert.ok(events.some((e) => e.data?.result_hashes?.spec === sha256Of(specResult) && e.data?.state === 'recorded'),
    'the FULLY transaction-bound record is what the replay recognizes');
  // And the idempotent re-entry now replays on the REAL commit point.
  const replay = promoteAmendment({ statePath: fx.statePath, ...inputs, self: self(fx), now: 3000 });
  assert.equal(replay.outcome, 'recorded');
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.writes, []);
});

// ---- the pre-publish review fix round (2026-09-08): finding 2 — the commit-point shortcut
// bypassed the symmetric drift refusal for an amendment's unchanged half --------------
//
// The reviewer's probe (/tmp/agent1-promotion-probe.mjs): a spec-only promotion completes;
// the unchanged goals.md is mutated from Works to WRONG; recoverPromotion returned
// {outcome:'recorded', replay:true, writes:[]} with the unapproved bytes present — because
// commitPointReached skipped the base===result half entirely, so the mutated unchanged
// artifact never marked the commit point unreached and the decision table never ran.
test('finding 2 regression: a mutated UNCHANGED half is drift at the commit point — the decision table runs, never a zero-write replay pass', () => {
  const fx = mkbundle();
  const inputs = amendmentInputs(fx, {
    specResult: SPEC.replace('old problem', 'approved problem'),
    goalsResult: GOALS, // the goals half is UNCHANGED (base == result)
    txid: 'f2-unchanged-drift',
  });
  beginPromotion({ statePath: fx.statePath, ...inputs });
  const committed = commitPromotion({ statePath: fx.statePath, transactionId: inputs.transactionId, self: self(fx), now: 1000 });
  assert.equal(committed.outcome, 'promoted');
  assert.deepEqual(committed.writes, ['spec'], 'a spec-only promotion writes the spec half only');
  assert.equal(committed.classifications.goals, 'satisfied', 'the goals half is unchanged');

  // The reviewer's mutation: change the UNCHANGED goals.md from Works to WRONG.
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), GOALS.replace('Works', 'WRONG'));

  // The commit-point shortcut must NOT accept this state: the unchanged half no longer
  // equals its approved bytes, so the commit point is unreached and the decision table
  // runs — the symmetric refusal (goals = neither), never a zero-write replay pass.
  const out = recoverPromotion({ statePath: fx.statePath, transactionId: inputs.transactionId, self: self(fx), now: 1001 });
  assert.equal(out.outcome, 'refused', JSON.stringify(out));
  assert.equal(out.refusal, 'intervening_edit');
  assert.equal(out.artifact, 'goals', 'the mutated unchanged half is the named artifact');
  assert.equal(out.classifications.goals, 'neither', 'the mutated bytes classify as neither — drift, not convergence');
  assert.deepEqual(out.writes, [], 'a refusal writes nothing');
  // The unapproved bytes remain on disk UNTOUCHED — a refusal never guesses, never rewrites.
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), GOALS.replace('Works', 'WRONG'),
    'the refused recovery left the (drifted) disk bytes alone — the operator decides');

  // The shortcut still fires for a genuinely clean replay: with the drift reverted, the
  // same re-entry is the zero-write idempotent replay the commit point exists for.
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), GOALS);
  const clean = recoverPromotion({ statePath: fx.statePath, transactionId: inputs.transactionId, self: self(fx), now: 1002 });
  assert.equal(clean.outcome, 'recorded', JSON.stringify(clean));
  assert.equal(clean.replay, true, 'a clean re-entry still replays as a no-op');
  assert.deepEqual(clean.writes, []);
});

test('re-review finding 1: a hand-appended amendment event is NOT a supersession — only a revalidated durable transaction record is', () => {
  const fx = mkbundle();
  const inputs = amendmentInputs(fx, {
    specResult: SPEC.replace('old problem', 'approved problem'),
    goalsResult: GOALS, // unchanged half
    txid: 'rr1-forged-supersession',
  });
  beginPromotion({ statePath: fx.statePath, ...inputs });
  const committed = commitPromotion({ statePath: fx.statePath, transactionId: inputs.transactionId, self: self(fx), now: 2000 });
  assert.equal(committed.outcome, 'promoted');

  // The drift: the unchanged goals half is mutated on disk.
  const mutated = GOALS.replace('Works', 'WRONG');
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), mutated);

  // The reviewer's exact bypass: a hand-appended goal_amended event naming the mutated
  // bytes' pinned hash as new_goals_hash — no summary, no transaction, no approval. The
  // OLD events-only supersession match accepted it and recovery replayed with the
  // unapproved goals still on disk. The fix demands the supersession be a DURABLE
  // transaction record: event -> named transaction -> doc on disk -> F6 revalidation ->
  // approved result binding the CURRENT bytes.
  const forgedHash = pinnedGoalsEvidenceHash(fx.statePath, mutated);
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'goal_amended', ts: '2026-09-07T00:00:00.000Z', data: { new_goals_hash: forgedHash, goals_hash: forgedHash, reason: 'forged' } })}\n`);
  const refused = recoverPromotion({ statePath: fx.statePath, transactionId: inputs.transactionId, self: self(fx), now: 2001 });
  assert.equal(refused.outcome, 'refused', JSON.stringify(refused));
  assert.equal(refused.refusal, 'intervening_edit');
  assert.equal(refused.artifact, 'goals', 'the forged supersession does not excuse the drifted half');
  assert.equal(refused.classifications.goals, 'neither');
  assert.deepEqual(refused.writes, []);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), mutated,
    'the refused recovery left the (drifted) disk bytes alone');

  // A forged event WITH a transaction-naming summary whose doc does not exist is equally
  // refused (the durable record is the proof, not the summary's claim).
  fs.appendFileSync(path.join(fx.bundleDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'goal_amended', ts: '2026-09-07T00:00:01.000Z', summary: 'goals amended by promotion rr1-no-such-transaction x -> y', data: { new_goals_hash: forgedHash } })}\n`);
  const refused2 = recoverPromotion({ statePath: fx.statePath, transactionId: inputs.transactionId, self: self(fx), now: 2002 });
  assert.equal(refused2.outcome, 'refused', JSON.stringify(refused2));

  // The LEGITIMATE supersession: a second approved promotion that AMENDS the goals half
  // from the drifted bytes onward (its base binds the CURRENT disk — the drifted goals
  // and the already-amended spec — and its approved result is where the goals legitimately
  // stand next). After it commits, recovering the FIRST transaction reads the drifted half
  // as superseded through the SECOND's durable doc + its goal_amended lineage event — the
  // commit point holds, the replay is a no-op, never a rewind.
  const currentSpec = SPEC.replace('old problem', 'approved problem');
  const mutatedV2 = mutated + '## G9: LegitimateFollowOn\nsignal: test\n';
  fs.writeFileSync(path.join(fx.scratch.a, 'spec.md'), currentSpec);
  fs.writeFileSync(path.join(fx.scratch.a, 'goals.md'), mutated);
  fs.writeFileSync(path.join(fx.scratch.b, 'spec.md'), currentSpec);
  fs.writeFileSync(path.join(fx.scratch.b, 'goals.md'), mutatedV2);
  const diff2 = gitDiffText(fx.scratch.a, fx.scratch.b);
  const bases2 = { spec: sha256Of(currentSpec), goals: sha256Of(mutated) };
  const results2 = { spec: sha256Of(currentSpec), goals: sha256Of(mutatedV2) };
  const second = {
    transactionId: 'rr1-second-legitimate',
    diff: diff2,
    resultSpec: currentSpec,
    resultGoals: mutatedV2,
    approval: approvalReceipt({ txid: 'rr1-second-legitimate', bases: bases2, results: results2, diffDigest: sha256Of(diff2) }),
  };
  beginPromotion({ statePath: fx.statePath, ...second });
  const secondCommit = commitPromotion({ statePath: fx.statePath, transactionId: second.transactionId, self: self(fx), now: 2003 });
  assert.equal(secondCommit.outcome, 'promoted', JSON.stringify(secondCommit));
  const superseded = recoverPromotion({ statePath: fx.statePath, transactionId: inputs.transactionId, self: self(fx), now: 2004 });
  assert.equal(superseded.outcome, 'recorded', JSON.stringify(superseded));
  assert.equal(superseded.replay, true, 'a validated supersession lets the earlier transaction replay as a no-op');
  assert.deepEqual(superseded.writes, []);
  assert.equal(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), mutatedV2,
    'the replay never rewinds the superseding transaction\'s approved bytes');
});
