import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoals, validateGoals, validateAmendment, crossCheckGoals, amendmentDiff } from '../lib/goals.mjs';

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
