import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoals, validateGoals, validateAmendment, crossCheckGoals, amendmentDiff, goalsHash, legacyGoalsHash, GOAL_VERDICTS, waiverKey, validateUserApprovalReceipt, validateGoalCheckReceipt, validateGoalWaiver } from '../lib/goals.mjs';

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

test('validateGoals accepts a well-formed active set', () => {
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

test('validateGoals rejects empty / all-tombstone set', () => {
  const emptyRes = validateGoals({ topicSeed: '', goals: [] });
  assert.equal(emptyRes.ok, false);

  const tombstonedMd = `## G1: Old
tombstone_reason: done
tombstone_at: 2026-01-01T00:00:00Z
`;
  const tombstonedParsed = parseGoals(tombstonedMd);
  const tombRes = validateGoals(tombstonedParsed);
  assert.equal(tombRes.ok, false);
});

test('validateGoals rejects duplicate ids', () => {
  const goals = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G1', text: 'B', signal: 'test' },
  ];
  const res = validateGoals(goals);
  assert.equal(res.ok, false);
  assert.match(res.error, /[Dd]uplicate/);
});

test('validateGoals rejects bad signal class', () => {
  const goals = [
    { id: 'G1', text: 'A', signal: 'vibes' },
  ];
  const res = validateGoals(goals);
  assert.equal(res.ok, false);
  // Error should mention allowed classes or signal
  assert(res.error.includes('test') || res.error.includes('artifact') || res.error.match(/signal/i));
});

test('validateGoals rejects bad id format', () => {
  const goals = [
    { id: 'X1', text: 'A', signal: 'test' },
  ];
  const res = validateGoals(goals);
  assert.equal(res.ok, false);
});

test('validateGoals rejects tombstone missing reason/amended_at', () => {
  const goals = [
    { id: 'G1', text: 'Active', signal: 'test' },
    {
      id: 'G2',
      text: 'Tombstoned',
      signal: 'test',
      tombstone: { reason: '' },
    },
  ];
  const res = validateGoals(goals);
  assert.equal(res.ok, false);
});

// --- AMENDMENT TESTS ---

test('validateAmendment accepts stable ids with a new appended goal', () => {
  const old = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G2', text: 'B', signal: 'command' },
  ];
  const newGoals = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G2', text: 'B', signal: 'command' },
    { id: 'G3', text: 'C', signal: 'docs' },
  ];
  const res = validateAmendment(old, newGoals);
  assert.equal(res.ok, true);
});

test('validateAmendment rejects a hard deletion (must tombstone)', () => {
  const old = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G2', text: 'B', signal: 'command' },
  ];
  const newGoals = [
    { id: 'G1', text: 'A', signal: 'test' },
  ];
  const res = validateAmendment(old, newGoals);
  assert.equal(res.ok, false);
  assert(res.error.includes('G2') || res.error.match(/tombstone/i));
});

test('validateAmendment accepts a removal expressed as a tombstone', () => {
  const old = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G2', text: 'B', signal: 'command' },
  ];
  const newGoals = [
    { id: 'G1', text: 'A', signal: 'test' },
    {
      id: 'G2',
      text: 'B',
      signal: 'command',
      tombstone: { reason: 'done', amended_at: '2026-01-01T00:00:00Z' },
    },
  ];
  const res = validateAmendment(old, newGoals);
  assert.equal(res.ok, true);
});

test('validateAmendment rejects renumbering', () => {
  // Old max num is 3. New goal G2 has num 2 <= 3, so it's considered a renumber/reuse error.
  const old = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G3', text: 'C', signal: 'command' },
  ];
  const newGoals = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G3', text: 'C', signal: 'command' },
    { id: 'G2', text: 'B', signal: 'docs' },
  ];
  const res = validateAmendment(old, newGoals);
  assert.equal(res.ok, false);
  assert.match(res.error, /renumber/i);
});

test('validateAmendment propagates single-doc invalidity', () => {
  const old = [
    { id: 'G1', text: 'A', signal: 'test' },
  ];
  const newGoals = [];
  const res = validateAmendment(old, newGoals);
  assert.equal(res.ok, false);
});

// --- CROSS-CHECK TESTS ---

test('crossCheckGoals ok when md, state, event agree', () => {
  const goals = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G2', text: 'B', signal: 'command' },
  ];
  const res = crossCheckGoals(goals, goals, goals);
  assert.equal(res.ok, true);
});

test('crossCheckGoals hard-errors on divergent text (never vacuous skip)', () => {
  const md = [{ id: 'G1', text: 'A', signal: 'test' }];
  const state = [{ id: 'G1', text: 'B', signal: 'test' }];
  const event = [{ id: 'G1', text: 'A', signal: 'test' }];
  const res = crossCheckGoals(md, state, event);
  assert.equal(res.ok, false);
  assert(res.error.includes('G1'));
});

test('crossCheckGoals hard-errors when a source is missing a goal', () => {
  const md = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G2', text: 'B', signal: 'command' },
  ];
  const state = [{ id: 'G1', text: 'A', signal: 'test' }];
  const event = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G2', text: 'B', signal: 'command' },
  ];
  const res = crossCheckGoals(md, state, event);
  assert.equal(res.ok, false);
  assert(res.error.includes('G2'));
});

test('crossCheckGoals treats null state as empty and still errors (no skip)', () => {
  const md = [{ id: 'G1', text: 'A', signal: 'test' }];
  const state = null;
  const event = [{ id: 'G1', text: 'A', signal: 'test' }];
  const res = crossCheckGoals(md, state, event);
  assert.equal(res.ok, false);
});

// --- AMEND-DIFF TESTS ---

test('amendmentDiff records added/modified/tombstoned and omits unchanged', () => {
  const old = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G2', text: 'B', signal: 'command' },
  ];
  const newGoals = [
    { id: 'G1', text: 'A', signal: 'test' },
    { id: 'G2', text: 'B2', signal: 'command' },
    { id: 'G3', text: 'C', signal: 'docs' },
  ];
  const diff = amendmentDiff(old, newGoals);

  const g2Entry = diff.find((d) => d.id === 'G2');
  assert.equal(g2Entry.change, 'modified');
  assert.equal(g2Entry.old.text, 'B');
  assert.equal(g2Entry.new.text, 'B2');

  const g3Entry = diff.find((d) => d.id === 'G3');
  assert.equal(g3Entry.change, 'added');
  assert.equal(g3Entry.old, null);
  assert.equal(g3Entry.new.text, 'C');

  const g1Entry = diff.find((d) => d.id === 'G1');
  assert.equal(g1Entry, undefined);
});

test('amendmentDiff records a tombstoning', () => {
  const old = [
    { id: 'G1', text: 'A', signal: 'test' },
  ];
  const newGoals = [
    {
      id: 'G1',
      text: 'A',
      signal: 'test',
      tombstone: { reason: 'done', amended_at: '2026-01-01T00:00:00Z' },
    },
  ];
  const diff = amendmentDiff(old, newGoals);

  const g1Entry = diff.find((d) => d.id === 'G1');
  assert.equal(g1Entry.change, 'tombstoned');
  assert(g1Entry.old);
  assert(g1Entry.new);
});

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

// --- WAIVER-KEY TESTS ---

test('waiverKey invalidates on any later commit or amendment', () => {
  const base = { goalsHash: 'sha256:aaa', headSha: 'head1', baseDiffHash: 'diff1' };
  const k0 = waiverKey(base);
  assert.equal(typeof k0, 'string');
  // later commit -> new head -> different key
  assert.notEqual(k0, waiverKey({ ...base, headSha: 'head2' }));
  // amendment -> new goals hash -> different key
  assert.notEqual(k0, waiverKey({ ...base, goalsHash: 'sha256:bbb' }));
  // changed diff -> different key
  assert.notEqual(k0, waiverKey({ ...base, baseDiffHash: 'diff2' }));
});

test('waiverKey returns null when any part is missing', () => {
  assert.equal(waiverKey({ goalsHash: 'sha256:aaa', headSha: 'h' }), null);
  assert.equal(waiverKey({}), null);
  assert.equal(waiverKey(), null);
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

// --- GOAL-CHECK-RECEIPT TESTS ---

const CHECK_GOALS = [
  { id: 'G1', text: 'Alpha', signal: 'test' },
  { id: 'G2', text: 'Beta', signal: 'command' },
  { id: 'G3', text: 'Gamma', signal: 'docs', tombstone: { reason: 'done', amended_at: '2026-01-01T00:00:00Z' } },
];

function checkExpected(overrides = {}) {
  return {
    goalsHash: 'sha256:gh',
    headSha: 'headabc',
    baseDiffHash: 'sha256:diff',
    verifyOutputHash: 'sha256:vout',
    clean: true,
    goals: CHECK_GOALS,
    ...overrides,
  };
}

function goodCheckReceipt(overrides = {}) {
  return {
    goals_hash: 'sha256:gh',
    head_sha: 'headabc',
    base_diff_hash: 'sha256:diff',
    verify_output_hash: 'sha256:vout',
    clean: true,
    verdicts: {
      G1: { verdict: 'achieved', evidence: 'tests pass' },
      G2: { verdict: 'partial', evidence: 'flag added, docs pending' },
    },
    dispatch_id: 'disp-1',
    model: 'gpt-5.5',
    output_tokens: 512,
    ts: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

test('validateGoalCheckReceipt accepts a valid assessor receipt over all active goals', () => {
  const res = validateGoalCheckReceipt(goodCheckReceipt(), checkExpected());
  assert.equal(res.ok, true, res.error);
  assert.equal(res.provenance_kind, 'assessor');
});

test('validateGoalCheckReceipt rejects stale goals hash / head / diff (re-arm)', () => {
  assert.equal(validateGoalCheckReceipt(goodCheckReceipt({ goals_hash: 'sha256:OTHER' }), checkExpected()).ok, false);
  assert.equal(validateGoalCheckReceipt(goodCheckReceipt({ head_sha: 'OTHER' }), checkExpected()).ok, false);
  assert.equal(validateGoalCheckReceipt(goodCheckReceipt({ base_diff_hash: 'OTHER' }), checkExpected()).ok, false);
});

test('validateGoalCheckReceipt rejects missing/mismatched verify_output_hash and clean status', () => {
  const noVout = goodCheckReceipt();
  delete noVout.verify_output_hash;
  assert.equal(validateGoalCheckReceipt(noVout, checkExpected()).ok, false);

  assert.equal(validateGoalCheckReceipt(goodCheckReceipt({ verify_output_hash: 'sha256:WRONG' }), checkExpected()).ok, false);

  assert.equal(validateGoalCheckReceipt(goodCheckReceipt({ clean: false }), checkExpected()).ok, false);
  // recorder recomputed clean=false but receipt says true -> mismatch
  assert.equal(validateGoalCheckReceipt(goodCheckReceipt(), checkExpected({ clean: false })).ok, false);
});

test('validateGoalCheckReceipt requires a verdict over every non-tombstoned goal', () => {
  const missingG2 = goodCheckReceipt({ verdicts: { G1: { verdict: 'achieved', evidence: 'x' } } });
  const res = validateGoalCheckReceipt(missingG2, checkExpected());
  assert.equal(res.ok, false);
  assert.match(res.error, /G2/);
});

test('validateGoalCheckReceipt rejects bad verdict enum and empty evidence', () => {
  const badEnum = goodCheckReceipt({ verdicts: { G1: { verdict: 'vibes', evidence: 'x' }, G2: { verdict: 'missed', evidence: 'y' } } });
  assert.equal(validateGoalCheckReceipt(badEnum, checkExpected()).ok, false);

  const emptyEv = goodCheckReceipt({ verdicts: { G1: { verdict: 'achieved', evidence: '' }, G2: { verdict: 'missed', evidence: 'y' } } });
  assert.equal(validateGoalCheckReceipt(emptyEv, checkExpected()).ok, false);
});

test('validateGoalCheckReceipt rejects fabricated verdict for an unknown/tombstoned goal', () => {
  const fab = goodCheckReceipt({
    verdicts: {
      G1: { verdict: 'achieved', evidence: 'x' },
      G2: { verdict: 'missed', evidence: 'y' },
      G3: { verdict: 'achieved', evidence: 'tombstoned!' },
    },
  });
  const res = validateGoalCheckReceipt(fab, checkExpected());
  assert.equal(res.ok, false);
  assert.match(res.error, /G3/);
});

test('validateGoalCheckReceipt rejects missing assessor provenance', () => {
  const noTokens = goodCheckReceipt();
  delete noTokens.output_tokens;
  assert.equal(validateGoalCheckReceipt(noTokens, checkExpected()).ok, false);

  const noModel = goodCheckReceipt();
  delete noModel.model;
  assert.equal(validateGoalCheckReceipt(noModel, checkExpected()).ok, false);
});

test('validateGoalCheckReceipt accepts the user-attested variant only with a valid bound approval', () => {
  const userReceipt = {
    goals_hash: 'sha256:gh',
    head_sha: 'headabc',
    base_diff_hash: 'sha256:diff',
    verify_output_hash: 'sha256:vout',
    clean: true,
    verdicts: {
      G1: { verdict: 'achieved', evidence: 'x' },
      G2: { verdict: 'partial', evidence: 'y' },
    },
    attested_by: 'user',
    approval_receipt: {
      attested_by: 'user',
      purpose: 'goal_check',
      goals_hash: 'sha256:gh',
      question: 'Attest these verdicts?',
      answer: 'yes',
      ts: '2026-07-01T00:00:00Z',
    },
    ts: '2026-07-01T00:00:00Z',
  };
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

// --- GOAL-WAIVER TESTS ---

function goodWaiver(overrides = {}) {
  return {
    goals_hash: 'sha256:gh',
    head_sha: 'headabc',
    base: 'main',
    diff_hash: 'sha256:diff',
    reasons: { G2: 'accepted as out of scope this run' },
    approval: {
      attested_by: 'user',
      purpose: 'goal_waive',
      goals_hash: 'sha256:gh',
      question: 'Waive G2?',
      answer: 'yes',
      ts: '2026-07-01T00:00:00Z',
    },
    ...overrides,
  };
}

function waiverExpected(overrides = {}) {
  return { goalsHash: 'sha256:gh', headSha: 'headabc', base: 'main', diffHash: 'sha256:diff', goals: CHECK_GOALS, ...overrides };
}

test('validateGoalWaiver accepts a waiver bound to the full check tuple', () => {
  const res = validateGoalWaiver(goodWaiver(), waiverExpected());
  assert.equal(res.ok, true, res.error);
  assert.equal(typeof res.normalized.key, 'string');
});

test('validateGoalWaiver rejects a stale/replayed waiver after a commit or amendment', () => {
  assert.equal(validateGoalWaiver(goodWaiver(), waiverExpected({ headSha: 'head2' })).ok, false);
  assert.equal(validateGoalWaiver(goodWaiver(), waiverExpected({ goalsHash: 'sha256:new' })).ok, false);
  assert.equal(validateGoalWaiver(goodWaiver(), waiverExpected({ diffHash: 'sha256:diff2' })).ok, false);
});

test('validateGoalWaiver requires per-goal reasons and a valid user approval', () => {
  assert.equal(validateGoalWaiver(goodWaiver({ reasons: {} }), waiverExpected()).ok, false);
  assert.equal(validateGoalWaiver(goodWaiver({ reasons: { G2: '' } }), waiverExpected()).ok, false);
  assert.equal(validateGoalWaiver(goodWaiver({ reasons: { GZ: 'unknown goal' } }), waiverExpected()).ok, false);

  const noApproval = goodWaiver();
  delete noApproval.approval;
  assert.equal(validateGoalWaiver(noApproval, waiverExpected()).ok, false);
});

test('GOAL_VERDICTS enum is exactly achieved/partial/missed', () => {
  assert.deepEqual([...GOAL_VERDICTS].sort(), ['achieved', 'missed', 'partial']);
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
