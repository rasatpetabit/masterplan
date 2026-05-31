// test/finish.test.mjs — the finalization-flow compute core (the `finish` verb / end-of-execute path).
// Pure functions behind `mp finish-status`: turn the shell's git facts into the JSON the §2 `complete`
// handler sequences on. No git, no fs, no state writing here — every input is a plain string/array, so
// the deterministic finish decisions (dirty? base? already-verified-at-this-SHA? which verify commands?)
// are testable without a repo fixture. Mirrors lib/finish.mjs's boundaries (see its header).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDirt,
  detectBase,
  collectVerifyCommands,
  isVerified,
  dispositionForChoice,
} from '../lib/finish.mjs';

// ---- classifyDirt: task-scope vs user-owned dirt -----------------------------

test('classifyDirt: a clean tree is dirty in neither bucket', () => {
  const d = classifyDirt('', ['src/a.mjs']);
  assert.equal(d.taskScopeDirty, false);
  assert.equal(d.unrelatedDirty, false);
  assert.deepEqual(d.taskScopePaths, []);
  assert.deepEqual(d.unrelatedPaths, []);
});

test('classifyDirt: a modified declared file is task-scope dirt', () => {
  const d = classifyDirt(' M src/a.mjs', ['src/a.mjs', 'src/b.mjs']);
  assert.equal(d.taskScopeDirty, true);
  assert.equal(d.unrelatedDirty, false);
  assert.deepEqual(d.taskScopePaths, ['src/a.mjs']);
});

test('classifyDirt: a file outside the declared scope is unrelated (user-owned) dirt', () => {
  const d = classifyDirt(' M WORKLOG.md', ['src/a.mjs']);
  assert.equal(d.taskScopeDirty, false);
  assert.equal(d.unrelatedDirty, true);
  assert.deepEqual(d.unrelatedPaths, ['WORKLOG.md']);
});

test('classifyDirt: a mixed tree splits into both buckets', () => {
  const porcelain = [' M src/a.mjs', '?? src/new.mjs', ' M WORKLOG.md', '?? scratch.txt'].join('\n');
  const d = classifyDirt(porcelain, ['src/a.mjs', 'src/new.mjs']);
  assert.equal(d.taskScopeDirty, true);
  assert.equal(d.unrelatedDirty, true);
  assert.deepEqual(d.taskScopePaths, ['src/a.mjs', 'src/new.mjs']);
  assert.deepEqual(d.unrelatedPaths, ['WORKLOG.md', 'scratch.txt']);
});

test('classifyDirt: a rename line classifies on the NEW path', () => {
  // porcelain rename: "R  old -> new" — the affected (and possibly declared) path is the new one.
  const d = classifyDirt('R  src/old.mjs -> src/new.mjs', ['src/new.mjs']);
  assert.equal(d.taskScopeDirty, true);
  assert.deepEqual(d.taskScopePaths, ['src/new.mjs']);
});

test('classifyDirt: a quoted (special-char) path is unquoted before matching', () => {
  // git quotes paths with spaces/specials: "XY \"a b.mjs\"".
  const d = classifyDirt(' M "src/a b.mjs"', ['src/a b.mjs']);
  assert.equal(d.taskScopeDirty, true);
  assert.deepEqual(d.taskScopePaths, ['src/a b.mjs']);
});

test('classifyDirt: tolerates a CRLF snapshot and blank lines', () => {
  const d = classifyDirt(' M src/a.mjs\r\n\r\n?? x.txt\r\n', ['src/a.mjs']);
  assert.deepEqual(d.taskScopePaths, ['src/a.mjs']);
  assert.deepEqual(d.unrelatedPaths, ['x.txt']);
});

test('classifyDirt: missing/empty taskFiles → everything dirty is unrelated', () => {
  const d = classifyDirt(' M src/a.mjs', undefined);
  assert.equal(d.taskScopeDirty, false);
  assert.equal(d.unrelatedDirty, true);
  assert.deepEqual(d.unrelatedPaths, ['src/a.mjs']);
});

// ---- detectBase: integration-base heuristic ----------------------------------

test('detectBase: prefers main when present', () => {
  assert.equal(detectBase('main\nfeature/x\ndevelop'), 'main');
});

test('detectBase: falls back to master when there is no main', () => {
  assert.equal(detectBase('master\nfeature/x'), 'master');
});

test('detectBase: main wins over master when both exist', () => {
  assert.equal(detectBase('master\nmain'), 'main');
});

test('detectBase: null when neither main nor master is present', () => {
  assert.equal(detectBase('develop\nfeature/x'), null);
});

test('detectBase: strips the `* ` current-branch marker from plain `git branch` output', () => {
  assert.equal(detectBase('  feature/x\n* main\n  develop'), 'main');
});

test('detectBase: empty/blank input → null', () => {
  assert.equal(detectBase(''), null);
  assert.equal(detectBase('   \n  '), null);
});

// ---- collectVerifyCommands: the finish-time verification source ---------------

test('collectVerifyCommands: order-preserving de-duplicated union across tasks', () => {
  const index = {
    tasks: [
      { id: 1, verify_commands: ['node --test test/a.test.mjs', 'npm run lint'] },
      { id: 2, verify_commands: ['npm run lint', 'node --test test/b.test.mjs'] },
    ],
  };
  assert.deepEqual(collectVerifyCommands(index), [
    'node --test test/a.test.mjs',
    'npm run lint',
    'node --test test/b.test.mjs',
  ]);
});

test('collectVerifyCommands: accepts a bare task array (not just {tasks})', () => {
  const arr = [{ id: 1, verify_commands: ['x'] }, { id: 2, verify_commands: ['y'] }];
  assert.deepEqual(collectVerifyCommands(arr), ['x', 'y']);
});

test('collectVerifyCommands: tasks with no/empty/non-array verify_commands contribute nothing', () => {
  const index = {
    tasks: [
      { id: 1 },
      { id: 2, verify_commands: [] },
      { id: 3, verify_commands: null },
      { id: 4, verify_commands: '  ' },
      { id: 5, verify_commands: ['real'] },
    ],
  };
  assert.deepEqual(collectVerifyCommands(index), ['real']);
});

test('collectVerifyCommands: tolerates a stray bare-string verify_commands', () => {
  assert.deepEqual(collectVerifyCommands({ tasks: [{ id: 1, verify_commands: 'node --test' }] }), [
    'node --test',
  ]);
});

test('collectVerifyCommands: empty/garbage index → []', () => {
  assert.deepEqual(collectVerifyCommands(null), []);
  assert.deepEqual(collectVerifyCommands({}), []);
  assert.deepEqual(collectVerifyCommands({ tasks: [] }), []);
});

// ---- isVerified: the verified-at-SHA skip ------------------------------------

test('isVerified: true only when a recorded SHA equals the current HEAD', () => {
  assert.equal(isVerified('abc123', 'abc123'), true);
});

test('isVerified: a moved HEAD (new commit) is not verified', () => {
  assert.equal(isVerified('abc123', 'def456'), false);
});

test('isVerified: a null/absent marker or HEAD is not verified', () => {
  assert.equal(isVerified(null, 'abc123'), false);
  assert.equal(isVerified('abc123', null), false);
  assert.equal(isVerified(null, null), false);
  assert.equal(isVerified('', ''), false);
});

// ---- dispositionForChoice: branch_finish choice → worktree disposition --------

test('dispositionForChoice: merge and discard both remove the worktree', () => {
  assert.equal(dispositionForChoice('merge'), 'removed_after_merge');
  assert.equal(dispositionForChoice('discard'), 'removed_after_merge');
});

test('dispositionForChoice: pr and keep retain the worktree', () => {
  assert.equal(dispositionForChoice('pr'), 'kept_by_user');
  assert.equal(dispositionForChoice('keep'), 'kept_by_user');
});

test('dispositionForChoice: an unknown choice → null (caller leaves disposition untouched)', () => {
  assert.equal(dispositionForChoice('bogus'), null);
  assert.equal(dispositionForChoice(undefined), null);
});
