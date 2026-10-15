import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoals, validateGoals, validateAmendment, goalsHash, legacyGoalsHash, INTENT_VERDICTS, validateUserApprovalReceipt, validateGoalCheckReceipt, INTERVIEW_EXITS, validateInterviewExit, specAssumptionIds, assumedIdsFromEnd, validateAssumptionsCoverage, validateGoalsLoadGate } from '../lib/goals.mjs';

// --- PARSE TESTS ---

test('parseGoals extracts verbatim topic seed and one section per goal', () => {
  const md = `topic: build a widget
that delights

## G1: Increase coverage
signal: test
evidence: npm test

## G2: Add CLI flag
signal: command
`;
  const { topicSeed, goals } = parseGoals(md);

  assert.equal(topicSeed, 'build a widget\nthat delights');
  assert.equal(goals.length, 2);

  assert.deepEqual(goals[0], {
    id: 'G1',
    text: 'Increase coverage',
    signal: 'test',
    evidence: 'npm test',
  });
  // 2026-08-05: this asserted evidence was `undefined` — the parser deliberately
  // dropped it, so goalsHash could not cover it and the acceptance criteria sat
  // outside goal identity. Now captured, and the hash covers it.
  assert.equal(goals[0].evidence, 'npm test');
  assert.equal(goals[0].tombstone, undefined);

  assert.equal(goals[1].id, 'G2');
  assert.equal(goals[1].signal, 'command');
});

test('parseGoals returns empty on non-string input', () => {
  const result = parseGoals(null);
  assert.deepEqual(result, { topicSeed: '', goals: [] });
});

test('parseGoals empty topicSeed when no topic line', () => {
  const md = `## G1: x
signal: test
`;
  const { topicSeed } = parseGoals(md);
  assert.equal(topicSeed, '');
});

test('parseGoals reads tombstoned goal', () => {
  const md = `## G3: old goal
tombstone_reason: superseded
tombstone_at: 2026-07-01T00:00:00Z
`;
  const { goals } = parseGoals(md);
  const g3 = goals[0];
  assert.equal(g3.id, 'G3');
  assert.deepEqual(g3.tombstone, {
    reason: 'superseded',
    amended_at: '2026-07-01T00:00:00Z',
  });
});

// --- VALIDATE TESTS ---
// G blocks are historical content: neither required nor validated. The operational
// content is the Intent block.

test('validateGoals accepts a document with historical G blocks (either call shape)', () => {
  const md = `## G1: Test
signal: test

## G2: Artifact
signal: artifact
`;
  const parsed = parseGoals(md);
  const res1 = validateGoals(parsed);
  assert.equal(res1.ok, true);

  const res2 = validateGoals(parsed.goals);
  assert.equal(res2.ok, true);
});

test('validateGoals accepts a zero-G document — goals are neither required nor counted', () => {
  const md = `topic: ship it

## Intent
why: w
outcome: o
anti_goals:
- a
done_means: d
`;
  const res = validateGoals(parseGoals(md));
  assert.equal(res.ok, true);
});

test('validateGoals does not validate historical G content — arbitrary ids/signals/tombstones pass', () => {
  // The G-block shape rules (unique ids, G<number> format, signal classes, tombstone
  // completeness) are retired with the goal-block machinery.
  const res = validateGoals([
    { id: 'G1', text: 'A', signal: 'vibes' },
    { id: 'G1', text: 'B', signal: 'test' },
    { id: 'X9', text: 'C', signal: 'test', tombstone: { reason: '' } },
  ]);
  assert.equal(res.ok, true);
});

test('validateGoals validates the Intent fields when an Intent block is present', () => {
  const md = `topic: t

## Intent
why: 
outcome: o
anti_goals:
- a
done_means: d
`;
  const res = validateGoals(parseGoals(md));
  assert.equal(res.ok, false);
  assert.match(res.error, /Intent\.why must be a non-empty string/);

  const badAnti = validateGoals({ topicSeed: 't', goals: [], intent: { why: 'w', outcome: 'o', done_means: 'd', anti_goals: 'nope' } });
  assert.equal(badAnti.ok, false);
  assert.match(badAnti.error, /anti_goals must be a list of strings/);
});

// --- AMENDMENT TESTS ---

test('validateAmendment accepts goal churn while the anchor and Intent hold', () => {
  const old = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G2', text: 'B', signal: 'command' },
  ];
  const newGoals = [
    { id: 'G1', text: 'A', signal: 'test' },
  ];
  // A bare deletion, a renumbered addition, a tombstone — all inert now: G content is
  // provenance, and the amendment's guarantees are the anchor and the Intent fields.
  assert.equal(validateAmendment(old, newGoals).ok, true);
  assert.equal(validateAmendment(old, [...newGoals, { id: 'G0', text: 'renumbered', signal: 'docs' }]).ok, true);
  assert.equal(validateAmendment(old, [...old, { id: 'G2', text: 'B', signal: 'command', tombstone: { reason: 'done', amended_at: '2026-01-01T00:00:00Z' } }]).ok, true);
});

test('validateAmendment propagates single-doc invalidity', () => {
  const old = { topicSeed: 't', goals: [], intent: { why: 'w', outcome: 'o', anti_goals: [], done_means: 'd' } };
  const broken = { topicSeed: 't', goals: [], intent: { why: ' ', outcome: 'o', anti_goals: [], done_means: 'd' } };
  const res = validateAmendment(old, broken);
  assert.equal(res.ok, false);
});

// (crossCheckGoals and amendmentDiff are retired with the goal-block machinery.)

// --- GOALS-HASH TESTS ---

test('goalsHash is stable across incidental whitespace but changes on real edits', () => {
  const a = `topic: build\n\n## G1: Alpha\nsignal: test\n`;
  // 2026-08-05: this used to read `evidence: ignored` and assert the hash was
  // UNCHANGED by it — the test pinned the defect in place, which is why the hole
  // survived review. Whitespace must still be incidental; evidence must not be.
  const b = `topic: build\n\n\n## G1: Alpha\nsignal: test\n`;
  assert.equal(goalsHash(a), goalsHash(b));

  const evidenceAdded = `topic: build\n\n## G1: Alpha\nsignal: test\nevidence: a real bar\n`;
  assert.notEqual(goalsHash(a), goalsHash(evidenceAdded), 'adding an acceptance criterion must change goal identity');
  assert.match(goalsHash(a), /^sha256:[0-9a-f]{64}$/);

  const changed = `topic: build\n\n## G1: Alpha CHANGED\nsignal: test\n`;
  assert.notEqual(goalsHash(a), goalsHash(changed));

  const added = `topic: build\n\n## G1: Alpha\nsignal: test\n\n## G2: Beta\nsignal: command\n`;
  assert.notEqual(goalsHash(a), goalsHash(added));
});

test('goalsHash accepts a parsed object and matches the raw-text form', () => {
  const md = `## G1: Alpha\nsignal: test\n`;
  assert.equal(goalsHash(md), goalsHash(parseGoals(md)));
});

// --- USER-APPROVAL-RECEIPT TESTS ---

function goodApproval(overrides = {}) {
  return {
    attested_by: 'user',
    purpose: 'goal_load',
    goals_hash: 'sha256:aaa',
    question: 'Approve these goals?',
    answer: 'yes',
    ts: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

test('validateUserApprovalReceipt accepts a well-formed receipt bound to the hash', () => {
  const res = validateUserApprovalReceipt(goodApproval(), { goalsHash: 'sha256:aaa', purpose: 'goal_load' });
  assert.equal(res.ok, true);
  assert.equal(res.normalized.attested_by, 'user');
});

test('validateUserApprovalReceipt rejects replay against a different hash or purpose', () => {
  const wrongHash = validateUserApprovalReceipt(goodApproval(), { goalsHash: 'sha256:bbb', purpose: 'goal_load' });
  assert.equal(wrongHash.ok, false);
  assert.match(wrongHash.error, /goals_hash/);

  const wrongPurpose = validateUserApprovalReceipt(goodApproval(), { goalsHash: 'sha256:aaa', purpose: 'goal_waive' });
  assert.equal(wrongPurpose.ok, false);
  assert.match(wrongPurpose.error, /purpose/);
});

test('validateUserApprovalReceipt requires attested_by user and non-empty q/a/ts', () => {
  assert.equal(validateUserApprovalReceipt(goodApproval({ attested_by: 'agent' }), {}).ok, false);
  assert.equal(validateUserApprovalReceipt(goodApproval({ answer: '' }), {}).ok, false);
  assert.equal(validateUserApprovalReceipt(null, {}).ok, false);
});

test('validateUserApprovalReceipt binds old+new hash on amendment', () => {
  const amend = goodApproval({ purpose: 'goal_amend', goals_hash: 'sha256:new', old_goals_hash: 'sha256:old' });
  const ok = validateUserApprovalReceipt(amend, { goalsHash: 'sha256:new', purpose: 'goal_amend', oldGoalsHash: 'sha256:old' });
  assert.equal(ok.ok, true);
  const stale = validateUserApprovalReceipt(amend, { goalsHash: 'sha256:new', purpose: 'goal_amend', oldGoalsHash: 'sha256:different' });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /old_goals_hash/);
});

// --- FINAL-ASSESSMENT RECEIPT TESTS (validateGoalCheckReceipt, final mode) ---

function checkExpected(overrides = {}) {
  return {
    goalsHash: 'sha256:gh',
    headSha: 'headabc',
    baseDiffHash: 'sha256:diff',
    verifyOutputHash: 'sha256:vout',
    clean: true,
    final: true,
    deployBaseSha: 'deploybase1',
    deployChainHash: 'sha256:chain',
    liveCheckDigest: 'sha256:live',
    ...overrides,
  };
}

function goodFinalReceipt(overrides = {}) {
  return {
    goals_hash: 'sha256:gh',
    head_sha: 'headabc',
    base_diff_hash: 'sha256:diff',
    verify_output_hash: 'sha256:vout',
    clean: true,
    intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
    deploy_base_sha: 'deploybase1',
    deploy_chain_hash: 'sha256:chain',
    live_check_digest: 'sha256:live',
    dispatch_id: 'disp-1',
    model: 'gpt-5.5',
    output_tokens: 512,
    ts: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

test('validateGoalCheckReceipt accepts a valid final receipt', () => {
  const res = validateGoalCheckReceipt(goodFinalReceipt(), checkExpected());
  assert.equal(res.ok, true, res.error);
  assert.equal(res.provenance_kind, 'assessor');
  assert.equal(res.normalized.final, true);
  assert.equal(res.normalized.intent_verdict.verdict, 'met');
});

test('validateGoalCheckReceipt rejects stale goals hash / head / diff (re-arm)', () => {
  assert.equal(validateGoalCheckReceipt(goodFinalReceipt({ goals_hash: 'sha256:OTHER' }), checkExpected()).ok, false);
  assert.equal(validateGoalCheckReceipt(goodFinalReceipt({ head_sha: 'OTHER' }), checkExpected()).ok, false);
  assert.equal(validateGoalCheckReceipt(goodFinalReceipt({ base_diff_hash: 'OTHER' }), checkExpected()).ok, false);
});

test('branch facts are required fields even when no binding source supplied them', () => {
  // No expectation (the caller has no binding source): the FIELD is still required, so the
  // receipt cannot arrive with no branch facts at all — only an unbound-but-present shape.
  for (const drop of ['head_sha', 'base_diff_hash']) {
    const r = goodFinalReceipt();
    delete r[drop];
    assert.equal(validateGoalCheckReceipt(r, checkExpected({ [drop === 'head_sha' ? 'headSha' : 'baseDiffHash']: undefined })).ok, false, drop);
  }
});

test('validateGoalCheckReceipt rejects missing/mismatched verify_output_hash and clean status', () => {
  const noVout = goodFinalReceipt();
  delete noVout.verify_output_hash;
  assert.equal(validateGoalCheckReceipt(noVout, checkExpected()).ok, false);

  assert.equal(validateGoalCheckReceipt(goodFinalReceipt({ verify_output_hash: 'sha256:WRONG' }), checkExpected()).ok, false);
  // A binding source with NO verify output hash (a pass answer without --verify-output) does
  // not constrain the value — the receipt only needs a non-empty string.
  assert.equal(validateGoalCheckReceipt(goodFinalReceipt({ verify_output_hash: 'sha256:OTHER' }), checkExpected({ verifyOutputHash: undefined })).ok, true);

  assert.equal(validateGoalCheckReceipt(goodFinalReceipt({ clean: false }), checkExpected()).ok, false);
  // recorder recomputed clean=false but receipt says true -> mismatch
  assert.equal(validateGoalCheckReceipt(goodFinalReceipt(), checkExpected({ clean: false })).ok, false);
});

test('the final bindings must be present and echo the recorder', () => {
  for (const field of ['deploy_base_sha', 'deploy_chain_hash', 'live_check_digest']) {
    const r = goodFinalReceipt({ [field]: `${field === 'deploy_base_sha' ? 'x' : 'sha256:x'}` });
    assert.equal(validateGoalCheckReceipt(r, checkExpected()).ok, false, field);
  }
  // Unbound recorder expectations (missing flags) are refused, never defaulted.
  assert.equal(validateGoalCheckReceipt(goodFinalReceipt(), checkExpected({ deployBaseSha: undefined })).ok, false);
});

test('the intent verdict is validated: enum + non-empty evidence', () => {
  assert.equal(validateGoalCheckReceipt(goodFinalReceipt({ intent_verdict: { verdict: 'yes-ish', evidence: 'e' } }), checkExpected()).ok, false);
  assert.equal(validateGoalCheckReceipt(goodFinalReceipt({ intent_verdict: { verdict: 'met', evidence: '' } }), checkExpected()).ok, false);
  assert.equal(validateGoalCheckReceipt(goodFinalReceipt({ intent_verdict: undefined }), checkExpected()).ok, false);
  for (const v of INTENT_VERDICTS) {
    assert.equal(validateGoalCheckReceipt(goodFinalReceipt({ intent_verdict: { verdict: v, evidence: 'e' } }), checkExpected()).ok, true, v);
  }
});

test('a legacy per-goal verdict table is tolerated, not validated', () => {
  // Goal blocks are inert: historical receipts carry verdicts, new receipts omit them. Neither
  // is cross-checked against a goal list — the intent verdict is the assessment.
  const legacy = goodFinalReceipt({ verdicts: { G1: { verdict: 'achieved', evidence: 'x' } } });
  assert.equal(validateGoalCheckReceipt(legacy, checkExpected()).ok, true, legacy.evidence);
  assert.equal(legacy.verdicts.G1.verdict, 'achieved');
  const noVerdicts = goodFinalReceipt();
  delete noVerdicts.verdicts;
  assert.equal(validateGoalCheckReceipt(noVerdicts, checkExpected()).ok, true);
});

test('validateGoalCheckReceipt rejects missing assessor provenance', () => {
  const noTokens = goodFinalReceipt();
  delete noTokens.output_tokens;
  assert.equal(validateGoalCheckReceipt(noTokens, checkExpected()).ok, false);

  const noModel = goodFinalReceipt();
  delete noModel.model;
  assert.equal(validateGoalCheckReceipt(noModel, checkExpected()).ok, false);
});

test('validateGoalCheckReceipt accepts the user-attested variant only with a valid bound approval', () => {
  const userReceipt = {
    ...goodFinalReceipt(),
    attested_by: 'user',
    approval_receipt: {
      attested_by: 'user',
      purpose: 'goal_check',
      goals_hash: 'sha256:gh',
      question: 'Attest this verdict?',
      answer: 'yes',
      ts: '2026-07-01T00:00:00Z',
    },
  };
  delete userReceipt.dispatch_id;
  delete userReceipt.model;
  delete userReceipt.output_tokens;
  const ok = validateGoalCheckReceipt(userReceipt, checkExpected());
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.provenance_kind, 'user');

  // user-attested but approval bound to a different hash -> rejected (never silent)
  const bad = { ...userReceipt, approval_receipt: { ...userReceipt.approval_receipt, goals_hash: 'sha256:OTHER' } };
  assert.equal(validateGoalCheckReceipt(bad, checkExpected()).ok, false);

  // user-attested but no approval receipt -> rejected
  const noApproval = { ...userReceipt };
  delete noApproval.approval_receipt;
  assert.equal(validateGoalCheckReceipt(noApproval, checkExpected()).ok, false);
});

// --- evidence is INSIDE goal identity (2026-08-05) ---
//
// evidence was parsed-and-dropped, so goalsHash could not see it. Because that
// hash keys every goal_check receipt, every waiver and the spec-gate re-arm, an
// acceptance criterion could be rewritten or weakened while all of them stayed
// valid against the old bar. Reproduced live on the dispatch-consolidation
// bundle: amending a goal from "true" to "NOT MET" returned `idempotent` with an
// unchanged hash and no goal_amended event.

const _EV_BASE = `topic: seed
## G1: Ship the thing
signal: test
evidence: the strict suite passes AND a positive control proves it can fail
`;

test('parseGoals captures evidence instead of dropping it', () => {
  const g = parseGoals(_EV_BASE).goals[0];
  assert.equal(g.evidence, 'the strict suite passes AND a positive control proves it can fail');
});

test('goalsHash changes when ONLY the evidence changes', () => {
  const weakened = _EV_BASE.replace(
    'evidence: the strict suite passes AND a positive control proves it can fail',
    'evidence: the suite passes',
  );
  assert.notEqual(
    goalsHash(_EV_BASE),
    goalsHash(weakened),
    'weakening an acceptance criterion must advance the goals hash, or every receipt and waiver keyed to it silently survives a bar it was never issued against',
  );
});

test('goalsHash still ignores incidental evidence whitespace', () => {
  const respaced = _EV_BASE.replace(
    'evidence: the strict suite',
    'evidence:    the strict suite',
  );
  assert.equal(goalsHash(_EV_BASE), goalsHash(respaced));
});

test('goalsHash treats absent evidence and empty evidence alike', () => {
  const noEvidence = `topic: seed\n## G1: Ship the thing\nsignal: test\n`;
  const emptyEvidence = `topic: seed\n## G1: Ship the thing\nsignal: test\nevidence:\n`;
  assert.equal(goalsHash(noEvidence), goalsHash(emptyEvidence));
});

// --- ANCHOR TESTS (topic: | block form) ---
//
// The `topic:` seed is the run's ANCHOR: the user's original request, captured before the
// adversary review→fix rounds and covered by goalsHash. The bare form truncates at the first
// blank line and trim()s every line, which silently loses most of a multi-paragraph ask — so
// the block form exists. It is opt-in on an exact `|` precisely so the bare form stays
// byte-identical and no in-flight bundle's hash (and therefore no goal_check/goal_waived
// receipt keyed to it) moves.

test('topic: | keeps interior blank lines and relative indentation', () => {
  const md = [
    'topic: |',
    '  Add an alignment check at the end of planning.',
    '',
    '  Specifically:',
    '    - do not drift during review/fix turns',
    '    - stay aligned with the actual ask',
    '',
    '## G1: Ship the auditor',
    'signal: test',
    'evidence: npm test',
    '',
  ].join('\n');

  const { topicSeed, goals } = parseGoals(md);

  assert.equal(
    topicSeed,
    'Add an alignment check at the end of planning.\n'
      + '\n'
      + 'Specifically:\n'
      + '  - do not drift during review/fix turns\n'
      + '  - stay aligned with the actual ask',
  );
  // The block must not swallow the goals that follow it.
  assert.equal(goals.length, 1);
  assert.deepEqual(goals[0], { id: 'G1', text: 'Ship the auditor', signal: 'test', evidence: 'npm test' });
});

test('topic: | runs to the first goal heading, not to the first blank line', () => {
  const md = 'topic: |\n  first para\n\n  second para\n\n## G1: X\nsignal: test\n';
  // The bare form would stop at "first para"; losing everything after it is the defect.
  assert.equal(parseGoals(md).topicSeed, 'first para\n\nsecond para');
});

test('topic: | with no goals still captures the whole block', () => {
  const md = 'topic: |\n  just an ask\n\n  with two paragraphs\n';
  const { topicSeed, goals } = parseGoals(md);
  assert.equal(topicSeed, 'just an ask\n\nwith two paragraphs');
  assert.equal(goals.length, 0);
});

test('topic: | dedents by the common indent, so nesting in goals.md does not leak into the hash', () => {
  const shallow = 'topic: |\n  a\n    b\n\n## G1: X\nsignal: test\n';
  const deep = 'topic: |\n      a\n        b\n\n## G1: X\nsignal: test\n';
  assert.equal(parseGoals(shallow).topicSeed, 'a\n  b');
  // Same text, indented further in the file — same anchor, same hash.
  assert.equal(parseGoals(deep).topicSeed, 'a\n  b');
  assert.equal(goalsHash(shallow), goalsHash(deep));
});

test('bare topic: is byte-identical to before — still truncates at the blank line', () => {
  const md = 'topic: short seed\n\nstray prose that must stay dropped\n\n## G1: X\nsignal: test\n';
  assert.equal(parseGoals(md).topicSeed, 'short seed');
});

test('a `|` inside a bare topic: value does not trigger block mode', () => {
  // Only an exact `|` opts in; `a | b` is an ordinary seed.
  assert.equal(parseGoals('topic: a | b\n\n## G1: X\nsignal: test\n').topicSeed, 'a | b');
});

test('block and bare forms of the same seed hash identically', () => {
  const bare = 'topic: one line ask\n\n## G1: X\nsignal: test\n';
  const block = 'topic: |\n  one line ask\n\n## G1: X\nsignal: test\n';
  assert.equal(goalsHash(bare), goalsHash(block));
});

// --- ANCHOR IMMUTABILITY ---

const _A_OLD = { topicSeed: 'the original ask', goals: [{ id: 'G1', text: 'X', signal: 'test' }] };

test('validateAmendment rejects a changed topic seed', () => {
  const next = { topicSeed: 'a subtly restated ask', goals: _A_OLD.goals };
  const res = validateAmendment(_A_OLD, next);
  assert.equal(res.ok, false);
  assert.match(res.error, /topic seed/i);
});

test('validateAmendment allows goal changes while the seed holds', () => {
  const next = {
    topicSeed: 'the original ask',
    goals: [..._A_OLD.goals, { id: 'G2', text: 'Y', signal: 'test' }],
  };
  assert.equal(validateAmendment(_A_OLD, next).ok, true);
});

test('anchorSeed pins the amendment to the event-backed original, not the previous doc', () => {
  // The walk-it-one-amendment-at-a-time path: the previous doc already drifted, so comparing
  // against it would pass. Comparing against the anchor_captured seed catches it.
  const drifted = { topicSeed: 'drifted ask', goals: _A_OLD.goals };
  const next = { topicSeed: 'drifted ask', goals: _A_OLD.goals };
  assert.equal(validateAmendment(drifted, next).ok, true);
  const res = validateAmendment(drifted, next, { anchorSeed: 'the original ask' });
  assert.equal(res.ok, false);
  assert.match(res.error, /topic seed/i);
});

test('validateAmendment still accepts bare goal arrays (no seed to compare)', () => {
  const oldArr = [{ id: 'G1', text: 'X', signal: 'test' }];
  const newArr = [...oldArr, { id: 'G2', text: 'Y', signal: 'test' }];
  assert.equal(validateAmendment(oldArr, newArr).ok, true);
});

test('topic: | is line-ending agnostic — CRLF and LF produce the same anchor and hash', () => {
  // The bare form gets this free via trim(); the block form keeps raw lines, so without an
  // explicit strip the same ask would hash differently on a CRLF-authored goals.md.
  const lf = 'topic: |\n  a\n\n  b\n\n## G1: X\nsignal: test\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.equal(parseGoals(crlf).topicSeed, 'a\n\nb');
  assert.equal(parseGoals(lf).topicSeed, parseGoals(crlf).topicSeed);
  assert.equal(goalsHash(lf), goalsHash(crlf));
});

test('topic:| and `topic: | ` (no space / trailing space) still opt into block mode', () => {
  const seed = (md) => parseGoals(md).topicSeed;
  assert.equal(seed('topic:|\n  a\n\n  b\n\n## G1: X\nsignal: test\n'), 'a\n\nb');
  assert.equal(seed('topic: | \n  a\n\n  b\n\n## G1: X\nsignal: test\n'), 'a\n\nb');
});

test('topic: | is NOT terminated by an indented goal-heading lookalike inside the ask', () => {
  // A real `## G1:` is a markdown H2 at column 0. An indented one is quoted prose inside the
  // request — terminating on it would truncate the anchor AND leak a phantom goal.
  const md = [
    'topic: |',
    '  Rework how goals are written, e.g.',
    '',
    '    ## G1: an example heading the user quoted',
    '',
    '  and keep the numbering stable.',
    '',
    '## G1: Ship it',
    'signal: test',
    '',
  ].join('\n');
  const { topicSeed, goals } = parseGoals(md);
  assert.match(topicSeed, /an example heading the user quoted/);
  assert.match(topicSeed, /keep the numbering stable/);
  // Exactly one real goal — the quoted heading must not become a second one.
  assert.deepEqual(goals.map((g) => g.id), ['G1']);
  assert.equal(goals[0].text, 'Ship it');
});

test('legacyGoalsHash detects a bundle frozen under the pre-block reading of `topic: |`', () => {
  // `topic: |` was valid before the block form: the old parser read `|` as literal seed text.
  // Re-hashing such a bundle would void every receipt keyed to the stored hash, so it must be
  // detectable rather than silent.
  const md = 'topic: |\n  the ask\n\n## G1: X\nsignal: test\n';
  const legacy = legacyGoalsHash(md);
  assert.notEqual(legacy, null);
  assert.notEqual(legacy, goalsHash(md), 'legacy and block readings must differ, else nothing to guard');
  // The legacy reading keeps the bare-form semantics: seed is "|", truncated at the blank line.
  assert.equal(parseGoals(md, { legacy: true }).topicSeed, '|\nthe ask');
});

test('legacyGoalsHash returns null when the block form is not used', () => {
  assert.equal(legacyGoalsHash('topic: plain seed\n\n## G1: X\nsignal: test\n'), null);
  assert.equal(legacyGoalsHash('topic: a | b\n\n## G1: X\nsignal: test\n'), null);
});

// --- V2 INTENT BLOCK TESTS (wave task 13) ---

const V2_FIXTURE = `topic: |
  Build the thing

## Intent
why: the problem
outcome: the outcome
anti_goals:
- not this
- nor that
done_means: it is live

## G1: first
signal: test
evidence: e1

## G2: second

## G3: third
`;

const V1_FIXTURE = `topic: |
  Build the thing

## G1: first
signal: test
evidence: e1

## G2: second

## G3: third
`;

const V2_TWO = `topic: |
  Build the thing

## Intent
why: the problem
outcome: the outcome
anti_goals:
- not this
done_means: it is live

## G1: first
signal: test

## G2: second
`;

const V2_SIX = `topic: |
  Build the thing

## Intent
why: the problem
outcome: the outcome
anti_goals:
- not this
done_means: it is live

## G1: first
## G2: second
## G3: third
## G4: fourth
## G5: fifth
## G6: sixth
`;

const V2_EMPTY_WHY = `topic: |
  Build the thing

## Intent
why:
outcome: the outcome
anti_goals:
- not this
done_means: it is live

## G1: first
## G2: second
## G3: third
`;

const V2_NO_SIGNAL = `topic: |
  Build the thing

## Intent
why: the problem
outcome: the outcome
anti_goals:
- not this
done_means: it is live

## G1: first
## G2: second
## G3: third
`;

test('v2 parses intent block with why/outcome/anti_goals/done_means', () => {
  const parsed = parseGoals(V2_FIXTURE);
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.intent, {
    why: 'the problem',
    outcome: 'the outcome',
    anti_goals: ['not this', 'nor that'],
    done_means: 'it is live',
  });
  assert.equal(parsed.goals.length, 3);
});

test('v1 parses with intent null and version 1', () => {
  const parsed = parseGoals(V1_FIXTURE);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.intent, null);
  assert.equal(parsed.goals.length, 3);
});

test('validateGoals: the goal-count rule is gone; an empty Intent field still refuses', () => {
  // G blocks are neither required nor counted — one, two, six or none all validate.
  assert.equal(validateGoals(parseGoals(V2_TWO)).ok, true);
  assert.equal(validateGoals(parseGoals(V2_SIX)).ok, true);
  assert.equal(validateGoals(parseGoals(V2_EMPTY_WHY)).ok, false);
});

test('goalsHash covers intent fields and stays deterministic', () => {
  assert.equal(goalsHash(V1_FIXTURE), goalsHash(V1_FIXTURE));
  assert.notEqual(goalsHash(V1_FIXTURE), goalsHash(V2_FIXTURE));
  const changedDone = V2_FIXTURE.replace('done_means: it is live', 'done_means: it is deployed');
  assert.notEqual(goalsHash(V2_FIXTURE), goalsHash(changedDone));
});

test('validateAmendment reports an intent-only change and no change for identical docs', () => {
  const changedOutcome = V2_FIXTURE.replace('outcome: the outcome', 'outcome: a different outcome');
  const res = validateAmendment(parseGoals(V2_FIXTURE), parseGoals(changedOutcome));
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.match(res.reason || '', /intent amended/);

  const sameRes = validateAmendment(parseGoals(V2_FIXTURE), parseGoals(V2_FIXTURE));
  assert.equal(sameRes.ok, true);
  assert.notEqual(sameRes.changed, true);
});

test('v2 goals without signal/evidence still validate', () => {
  const res = validateGoals(parseGoals(V2_NO_SIGNAL));
  assert.equal(res.ok, true);
});

test('validateAmendment reports a changed Intent even when G content churns alongside it', () => {
  // G-block mutation rules (tombstoning, renumbering) are retired; the intent change is
  // still a real, reported change that re-arms the spec gate.
  const variant = V2_FIXTURE
    .replace('outcome: the outcome', 'outcome: a different outcome')
    .replace('## G2: second', '## G9: second');
  const res = validateAmendment(parseGoals(V2_FIXTURE), parseGoals(variant));
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.match(res.reason || '', /intent amended/);
});

// --- GOALS-LOAD GATE: interview exit + Assumptions coverage (task 14) ---

const SPEC_WITH = `# Spec

## Assumptions & Open Decisions

| # | question | decision |
|---|---|---|
| A1 | first | yes |
| U3 | which storage? | assumed sqlite |
| C2 | conflicting deadlines | assumed the later one |

## Next Section

| # | not an assumption |
|---|---|
| M9 | this row is in another table |
`;

test('validateInterviewExit accepts each permitted exit and reports the reason', () => {
  for (const exit of ['converged', 'exhausted', 'critic_off']) {
    const r = validateInterviewExit({ terminal: exit, terminalReason: exit, reopened: false, events: [] });
    assert.equal(r.ok, true, `${exit}: ${r.error}`);
    assert.equal(r.exit, exit);
  }
  assert.deepEqual(INTERVIEW_EXITS, ['converged', 'exhausted', 'critic_off', 'waived']);
});

test('validateInterviewExit refuses an open interview and a reopened one, with distinct codes', () => {
  const open = validateInterviewExit({ terminal: null, terminalReason: null, reopened: false, events: [] });
  assert.equal(open.ok, false);
  assert.equal(open.code, 'interview_open');
  // A reopen clears `terminal`; the refusal must name the reopen, not report a generic open state.
  const reopened = validateInterviewExit({ terminal: null, terminalReason: null, reopened: true, events: [] });
  assert.equal(reopened.ok, false);
  assert.equal(reopened.code, 'interview_reopened');
  // Ended again after the reopen → allowed.
  assert.equal(validateInterviewExit({ terminal: 'converged', reopened: false, events: [] }).ok, true);
});

test('validateInterviewExit admits waived only as a durable ledger event', () => {
  const durable = validateInterviewExit({ terminal: 'waived', terminalReason: 'operator call', events: [{ type: 'interview_waived', reason: 'operator call' }] });
  assert.equal(durable.ok, true, durable.error);
  assert.equal(durable.exit, 'waived');
  // A caller asserting a waiver the ledger does not carry is refused like an open interview.
  const claimed = validateInterviewExit({ terminal: 'waived', events: [{ type: 'interview_end', reason: 'converged' }] });
  assert.equal(claimed.ok, false);
  assert.equal(claimed.code, 'interview_waiver_not_durable');
});

test('a waived exit with no readable ledger is refused — absence is not evidence of a waiver', () => {
  // Treating a missing/malformed event list as "nothing to check" would make durability opt-out.
  for (const events of [undefined, null, 'interview_waived', {}, 0]) {
    const r = validateInterviewExit({ terminal: 'waived', terminalReason: 'x', events });
    assert.equal(r.ok, false, `events=${JSON.stringify(events)} must be refused`);
    assert.equal(r.code, 'interview_waiver_not_durable');
  }
  // An empty ledger is readable and simply carries no waiver.
  assert.equal(validateInterviewExit({ terminal: 'waived', events: [] }).code, 'interview_waiver_not_durable');
  // The other exits do not need the ledger at all.
  assert.equal(validateInterviewExit({ terminal: 'converged' }).ok, true);
});

test('a reopened interview is refused even when it also claims a terminal exit', () => {
  // In a real replay an interview_end after the reopen clears the flag, so both cannot be set —
  // but trusting `terminal` over `reopened` here would let a reopened interview load goals.
  for (const terminal of ['converged', 'exhausted', 'critic_off', 'waived']) {
    const r = validateInterviewExit({ terminal, reopened: true, events: [{ type: 'interview_waived' }] });
    assert.equal(r.ok, false, `${terminal} + reopened must be refused`);
    assert.equal(r.code, 'interview_reopened');
    assert.match(r.error, /claims terminal/);
  }
});

test('validateInterviewExit rejects an unknown terminal value and a non-object replay', () => {
  assert.equal(validateInterviewExit({ terminal: 'finished' }).code, 'interview_exit_invalid');
  assert.equal(validateInterviewExit(null).code, 'interview_replay_invalid');
  assert.equal(validateInterviewExit([]).code, 'interview_replay_invalid');
});

test('specAssumptionIds reads the first Assumptions table only, skipping header and separator rows', () => {
  const ids = specAssumptionIds(SPEC_WITH);
  assert.deepEqual([...ids].sort(), ['A1', 'C2', 'U3']);
  assert.equal(ids.has('#'), false, 'the header row is not an assumption id');
  // A table under a LATER heading is not the Assumptions table.
  assert.equal(ids.has('M9'), false);
  assert.deepEqual([...specAssumptionIds(null)], []);
});

test('assumedIdsFromEnd handles object and string entries and counts the id-less ones', () => {
  const r = assumedIdsFromEnd({
    unknowns: [{ id: 'U3', question: 'which storage?' }],
    contradictions: ['C2'],
    misclassified: ['M9', 'M9'],
  });
  assert.deepEqual(r.ids, ['U3', 'C2', 'M9']);
  assert.equal(r.unidentified, 0);
  assert.equal(assumedIdsFromEnd({ unknowns: [{ question: 'no id' }] }).unidentified, 1);
});

test('validateAssumptionsCoverage refuses assumed_row_missing and names every missing id', () => {
  const endEvent = {
    type: 'interview_end', reason: 'exhausted',
    unknowns: [{ id: 'U3' }], contradictions: ['C2'], misclassified: ['M9'],
  };
  const r = validateAssumptionsCoverage({ endEvent, specText: SPEC_WITH });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'assumed_row_missing');
  assert.deepEqual(r.missing, ['M9']); // U3 and C2 have rows; M9's row is in another table
  assert.deepEqual(r.required.sort(), ['C2', 'M9', 'U3']);
  // Once the row exists the gate passes.
  const withRow = SPEC_WITH.replace('| C2 | conflicting deadlines | assumed the later one |', '| C2 | conflicting deadlines | assumed the later one |\n| M9 | misclassified pick | assumed a design question |');
  const ok = validateAssumptionsCoverage({ endEvent, specText: withRow });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.missing, []);
});

test('validateAssumptionsCoverage owes nothing on a non-exhausted exit, and fails closed without a spec', () => {
  assert.equal(validateAssumptionsCoverage({ endEvent: { reason: 'converged' }, specText: '' }).ok, true);
  assert.equal(validateAssumptionsCoverage({ exit: 'converged', endEvent: null }).ok, true);
  // exhausted with no event to check against is a refusal, never a silent pass
  assert.equal(validateAssumptionsCoverage({ exit: 'exhausted', endEvent: null }).code, 'interview_end_missing');
  // exhausted with ids but an unreadable spec is a refusal too
  const r = validateAssumptionsCoverage({ endEvent: { reason: 'exhausted', unknowns: [{ id: 'U1' }] }, specText: '' });
  assert.equal(r.code, 'spec_unreadable');
  assert.deepEqual(r.required, ['U1']);
  // an unresolved item with no id cannot be checked — refused rather than dropped
  assert.equal(validateAssumptionsCoverage({ endEvent: { reason: 'exhausted', unknowns: [{ question: 'x' }] }, specText: SPEC_WITH }).code, 'assumed_id_missing');
});

test('validateGoalsLoadGate takes the terminal event from the ledger — a caller cannot supply one', () => {
  const events = [
    { type: 'interview_end', reason: 'exhausted', unknowns: [{ id: 'U3' }], contradictions: [], misclassified: ['M9'] },
  ];
  const replay = { terminal: 'exhausted', reopened: false, events };
  // An emptied or stale event passed alongside the replay must not mask the ids the durable
  // event lists — the override is not part of the API at all.
  const spoofed = validateGoalsLoadGate({ replay, specText: SPEC_WITH, endEvent: { type: 'interview_end', reason: 'exhausted', unknowns: [], contradictions: [], misclassified: [] } });
  assert.equal(spoofed.ok, false);
  assert.equal(spoofed.code, 'assumed_row_missing');
  assert.deepEqual(spoofed.missing, ['M9']);
  // An exhausted exit with no readable ledger has no event to check against: refused, not passed.
  const noLedger = validateGoalsLoadGate({ replay: { terminal: 'exhausted', reopened: false }, specText: SPEC_WITH });
  assert.equal(noLedger.ok, false);
  assert.equal(noLedger.code, 'interview_end_missing');
});

test('validateGoalsLoadGate finds the interview_end in the replay and enforces both halves', () => {
  const events = [
    { type: 'interview_end', reason: 'exhausted', unknowns: [{ id: 'U3' }], contradictions: [], misclassified: ['M9'] },
  ];
  const replay = { terminal: 'exhausted', terminalReason: 'exhausted', reopened: false, events };
  const bad = validateGoalsLoadGate({ replay, specText: SPEC_WITH });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'assumed_row_missing');
  // the exit gate runs first: an open interview is refused before the table is consulted
  const open = validateGoalsLoadGate({ replay: { terminal: null, events }, specText: SPEC_WITH });
  assert.equal(open.code, 'interview_open');
  // a converged run owes no rows
  const good = validateGoalsLoadGate({ replay: { terminal: 'converged', events: [{ type: 'interview_end', reason: 'converged' }] }, specText: SPEC_WITH });
  assert.equal(good.ok, true, good.error);
  assert.deepEqual(good.assumed, []);
});

test('an id must appear in a real Assumptions TABLE — prose and a second table do not count', () => {
  // A lone pipe-prefixed line under the heading is not a table row.
  const prose = `# Spec

## Assumptions

No table is present yet.
| U1 | merely mentioned in prose |

## Next
`;
  assert.deepEqual([...specAssumptionIds(prose)], [], 'a pipe line with no header/delimiter is not a table');
  const endEvent = { type: 'interview_end', reason: 'exhausted', unknowns: [{ id: 'U1' }] };
  assert.equal(validateAssumptionsCoverage({ endEvent, specText: prose }).code, 'assumed_row_missing');

  // A second table in the same section is not the Assumptions table.
  const twoTables = `# Spec

## Assumptions

| # | question |
|---|---|
| A1 | first |

Some prose between the tables.

| # | something else |
|---|---|
| U1 | in the second table |

## Next
`;
  assert.deepEqual([...specAssumptionIds(twoTables)], ['A1']);
  assert.equal(validateAssumptionsCoverage({ endEvent, specText: twoTables }).code, 'assumed_row_missing');

  // And the real thing still resolves: header, delimiter, data rows, stopping at the blank line.
  const good = twoTables.replace('| A1 | first |', '| A1 | first |\n| U1 | which storage? |');
  assert.deepEqual([...specAssumptionIds(good)].sort(), ['A1', 'U1']);
  assert.equal(validateAssumptionsCoverage({ endEvent, specText: good }).ok, true);
});

test('table syntax inside a code block is an EXAMPLE, not the Assumptions table', () => {
  // This spec quotes markdown in several places; Markdown renders a fenced block as code,
  // so reading it as a table would let an example satisfy the coverage gate.
  const fenced = [
    '# Spec',
    '',
    '## Assumptions',
    '',
    'The table format is:',
    '',
    '```markdown',
    '| # | question | decision |',
    '|---|---|---|',
    '| U1 | example only | not a real row |',
    '```',
    '',
    '## Next',
    '',
  ].join('\n');
  assert.deepEqual([...specAssumptionIds(fenced)], [], 'a fenced example is not the Assumptions table');
  const endEvent = { type: 'interview_end', reason: 'exhausted', unknowns: [{ id: 'U1' }] };
  assert.equal(validateAssumptionsCoverage({ endEvent, specText: fenced }).code, 'assumed_row_missing');

  // Four-space-indented code is the same story.
  const indented = [
    '# Spec',
    '',
    '## Assumptions',
    '',
    'For example:',
    '',
    '    | # | question |',
    '    |---|---|',
    '    | U1 | example only |',
    '',
    '## Next',
    '',
  ].join('\n');
  assert.deepEqual([...specAssumptionIds(indented)], []);
  assert.equal(validateAssumptionsCoverage({ endEvent, specText: indented }).code, 'assumed_row_missing');

  // A REAL table after the fenced example is still found, and satisfies the gate.
  const both = fenced.replace('## Next', [
    '| # | question | decision |',
    '|---|---|---|',
    '| U1 | which storage? | assumed sqlite |',
    '',
    '## Next',
  ].join('\n'));
  assert.deepEqual([...specAssumptionIds(both)], ['U1']);
  assert.equal(validateAssumptionsCoverage({ endEvent, specText: both }).ok, true);

  // A tilde fence behaves like a backtick fence.
  const tilde = fenced.replace(/```markdown/, '~~~markdown').replace(/```/, '~~~');
  assert.deepEqual([...specAssumptionIds(tilde)], []);
});
