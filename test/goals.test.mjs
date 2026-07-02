import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoals, validateGoals, validateAmendment, crossCheckGoals, amendmentDiff, goalsHash, GOAL_VERDICTS, waiverKey, validateUserApprovalReceipt, validateGoalCheckReceipt, validateGoalWaiver } from '../lib/goals.mjs';

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
  });
  assert.equal(goals[0].evidence, undefined);
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
  const b = `topic: build\n\n\n## G1: Alpha\nsignal: test\nevidence: ignored\n`;
  assert.equal(goalsHash(a), goalsHash(b));
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
