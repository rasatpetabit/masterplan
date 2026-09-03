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
  detectBaseAuto,
  EMPTY_TREE_SHA,
  collectVerifyCommands,
  isVerified,
  dispositionForChoice,
  summarizePr,
  orderDeployGroups,
  classifyStepOutcome,
  substituteVersionSafe,
  deployChainHash,
  classifyCompletion,
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

// ---- detectBaseAuto: expanded base resolution (spec §4.2-A) -------------------

test('detectBaseAuto: local main wins over any remote', () => {
  const local = 'main\nfeature/x';
  const remote = 'origin/main\norigin/master\nupstream/main';
  assert.deepEqual(detectBaseAuto(local, remote), { base: 'main', source: 'local' });
});

test('detectBaseAuto: falls back to origin/main when no local main/master', () => {
  assert.deepEqual(detectBaseAuto('feature/x\ndevelop', 'origin/main\nupstream/main'),
    { base: 'main', source: 'origin' });
});

test('detectBaseAuto: falls back to origin/master when no local main/master', () => {
  assert.deepEqual(detectBaseAuto('feature/x', 'origin/master\nupstream/main'),
    { base: 'master', source: 'origin' });
});

test('detectBaseAuto: falls back to ANY remote main when no origin', () => {
  const result = detectBaseAuto('feature/x', 'upstream/main\nfork/master');
  assert.equal(result.base, 'main');
  assert.equal(result.source, 'remote');
  assert.equal(result.ref, 'upstream/main');
});

test('detectBaseAuto: returns null when no local or remote main/master', () => {
  assert.equal(detectBaseAuto('feature/x', 'upstream/feature'), null);
  assert.equal(detectBaseAuto('', ''), null);
});

test('detectBaseAuto: tolerates empty inputs without throwing', () => {
  assert.equal(detectBaseAuto('', 'origin/main').base, 'main');
  assert.equal(detectBaseAuto('', 'origin/main').source, 'origin');
});

test('EMPTY_TREE_SHA: the universal-diff baseline is the well-known empty-tree constant', () => {
  // git's empty-tree SHA is a stable, documented constant — if this changes, every diff-against-empty
  // tool on Earth breaks. The assertion is the canonical hex SHA, not a derived value.
  assert.equal(EMPTY_TREE_SHA, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  assert.equal(EMPTY_TREE_SHA.length, 40); // SHA-1 hex
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

// ---- summarizePr: open-PR awareness (report-only) ----------------------------

test('summarizePr: a mergeable PR maps to the compact report shape', () => {
  const gh = JSON.stringify([
    { number: 42, title: 'feat: thing', mergeable: 'MERGEABLE', url: 'https://gh/pr/42' },
  ]);
  assert.deepEqual(summarizePr(gh), {
    hasPr: true,
    number: 42,
    title: 'feat: thing',
    url: 'https://gh/pr/42',
    mergeable: 'yes',
  });
});

test('summarizePr: CONFLICTING → mergeable "no"', () => {
  assert.equal(summarizePr(JSON.stringify([{ number: 1, mergeable: 'CONFLICTING' }])).mergeable, 'no');
});

test('summarizePr: GitHub\'s async UNKNOWN (or an absent field) → mergeable "unknown"', () => {
  assert.equal(summarizePr(JSON.stringify([{ number: 1, mergeable: 'UNKNOWN' }])).mergeable, 'unknown');
  assert.equal(summarizePr(JSON.stringify([{ number: 1 }])).mergeable, 'unknown');
});

test('summarizePr: the first PR wins when gh returns more than one for the head', () => {
  const gh = JSON.stringify([
    { number: 7, mergeable: 'MERGEABLE' },
    { number: 3, mergeable: 'CONFLICTING' },
  ]);
  assert.equal(summarizePr(gh).number, 7);
});

test('summarizePr: missing/empty/[] input (gh absent or no open PR) → { hasPr:false }', () => {
  assert.deepEqual(summarizePr(''), { hasPr: false });
  assert.deepEqual(summarizePr('   '), { hasPr: false });
  assert.deepEqual(summarizePr('[]'), { hasPr: false });
  assert.deepEqual(summarizePr(undefined), { hasPr: false });
});

test('summarizePr: malformed JSON or a non-array payload → { hasPr:false } (never throws)', () => {
  assert.deepEqual(summarizePr('not json {['), { hasPr: false });
  assert.deepEqual(summarizePr('{"number":1}'), { hasPr: false });
});

test('summarizePr: a PR with no usable number → { hasPr:false }', () => {
  assert.deepEqual(summarizePr(JSON.stringify([{ title: 'x' }])), { hasPr: false });
  assert.deepEqual(summarizePr(JSON.stringify(['not-an-object'])), { hasPr: false });
});

// ---- orderDeployGroups: canonical §7.1 group order ----------------------------

test('orderDeployGroups: returns groups in fixed order regardless of declaration order', () => {
  const done = {
    live_check: [{ run: 'x' }],
    release: [{ run: 'r' }],
    user_only: [{ text: 't', check: 'c' }],
    install: [{ run: 'i' }],
  };
  assert.deepEqual(orderDeployGroups(done), ['release', 'install', 'user_only', 'live_check']);
});

test('orderDeployGroups: a partial object definition yields only the present groups, still in fixed order', () => {
  assert.deepEqual(orderDeployGroups({ install: [{ run: 'i' }], release: [{ run: 'r' }] }),
    ['release', 'install']);
});

test('orderDeployGroups: `done: none` → no groups', () => {
  assert.deepEqual(orderDeployGroups('none'), []);
});

test('orderDeployGroups: an absent definition → no groups', () => {
  assert.deepEqual(orderDeployGroups(undefined), []);
  assert.deepEqual(orderDeployGroups(null), []);
});

test('orderDeployGroups: accepts a bare array of group names', () => {
  assert.deepEqual(orderDeployGroups(['live_check', 'release']), ['release', 'live_check']);
});

// ---- classifyStepOutcome: exit-status-only classification ---------------------

test('classifyStepOutcome: run 0 + check 0 → done', () => {
  assert.equal(classifyStepOutcome({ runExit: 0, checkExit: 0 }), 'done');
});

test('classifyStepOutcome: run 0 with no check → done', () => {
  assert.equal(classifyStepOutcome({ runExit: 0 }), 'done');
  assert.equal(classifyStepOutcome({ runExit: 0, checkExit: undefined }), 'done');
});

test('classifyStepOutcome: run 0 + check 1 → failed (effect absent)', () => {
  assert.equal(classifyStepOutcome({ runExit: 0, checkExit: 1 }), 'failed');
});

test('classifyStepOutcome: run 0 + check other exit → indeterminate', () => {
  assert.equal(classifyStepOutcome({ runExit: 0, checkExit: 2 }), 'indeterminate');
  assert.equal(classifyStepOutcome({ runExit: 0, checkExit: 127 }), 'indeterminate');
});

test('classifyStepOutcome: run non-zero → failed, check is ignored', () => {
  assert.equal(classifyStepOutcome({ runExit: 1, checkExit: 0 }), 'failed');
  assert.equal(classifyStepOutcome({ runExit: 2, checkExit: 1 }), 'failed');
  assert.equal(classifyStepOutcome({ runExit: 1 }), 'failed');
});

test('classifyStepOutcome: command output never affects classification', () => {
  // The function takes only exit codes — there is no output parameter at all. A step
  // whose run prints anything still classifies purely on the two exit codes.
  assert.equal(classifyStepOutcome({ runExit: 0, checkExit: 0 }), 'done');
  assert.equal(classifyStepOutcome({ runExit: 0, checkExit: 1 }), 'failed');
  assert.equal(classifyStepOutcome({ runExit: 0, checkExit: 3 }), 'indeterminate');
});

test('classifyStepOutcome: non-integer runExit → indeterminate', () => {
  assert.equal(classifyStepOutcome({ runExit: null }), 'indeterminate');
  assert.equal(classifyStepOutcome({ runExit: '0' }), 'indeterminate');
});

test('classifyStepOutcome: non-integer checkExit → indeterminate', () => {
  assert.equal(classifyStepOutcome({ runExit: 0, checkExit: '' }), 'indeterminate');
});

// ---- substituteVersionSafe: validated ${version} substitution -----------------

test('substituteVersionSafe: substitutes a valid version single-quoted into the command', () => {
  assert.equal(
    substituteVersionSafe('node scripts/release.mjs --version=${version}', '1.2.3'),
    "node scripts/release.mjs --version='1.2.3'"
  );
});

test('substituteVersionSafe: accepts a valid prerelease version', () => {
  assert.equal(
    substituteVersionSafe('git tag v${version}', '1.2.3-beta.1'),
    "git tag v'1.2.3-beta.1'"
  );
});

test('substituteVersionSafe: substitutes every occurrence', () => {
  assert.equal(
    substituteVersionSafe('a=${version} b=${version}', '2.0.0'),
    "a='2.0.0' b='2.0.0'"
  );
});

test('substituteVersionSafe: a hostile/absent version → null (refuse, never interpolate)', () => {
  assert.equal(substituteVersionSafe('x ${version}', '1.2; rm -rf /'), null);
  assert.equal(substituteVersionSafe('x ${version}', 'v1.2.3'), null);
  assert.equal(substituteVersionSafe('x ${version}', '1.2'), null);
  assert.equal(substituteVersionSafe('x ${version}', ''), null);
  assert.equal(substituteVersionSafe('x ${version}', undefined), null);
});

// ---- deployChainHash: deterministic deploy-chain digest -----------------------

test('deployChainHash: same chain → same hash; different chain → different hash', () => {
  const a = [{ group: 'release', index: 0, exit: 0 }];
  const b = [{ group: 'release', index: 0, exit: 0 }];
  const c = [{ group: 'release', index: 0, exit: 1 }];
  assert.equal(deployChainHash(a), deployChainHash(b));
  assert.notEqual(deployChainHash(a), deployChainHash(c));
});

test('deployChainHash: is a 64-char sha256 hex digest', () => {
  const h = deployChainHash([{ group: 'install', index: 0, exit: 0 }]);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('deployChainHash: an empty chain hashes deterministically', () => {
  assert.equal(deployChainHash([]), deployChainHash([]));
  assert.equal(deployChainHash(undefined), deployChainHash([]));
});

test('deployChainHash: key order does not change the hash', () => {
  const a = [{ group: 'release', index: 0, exit: 0 }];
  const b = [{ exit: 0, index: 0, group: 'release' }];
  assert.equal(deployChainHash(a), deployChainHash(b));
  const c = [{ group: 'release', index: 0, exit: 1 }];
  assert.notEqual(deployChainHash(a), deployChainHash(c));
});

// ---- classifyCompletion: complete / incomplete / merged / legacy --------------

test('classifyCompletion: complete stays complete', () => {
  assert.equal(classifyCompletion({ completion: 'complete' }), 'complete');
});

test('classifyCompletion: incomplete:<reason> is preserved', () => {
  assert.equal(classifyCompletion({ completion: 'incomplete:attested' }), 'incomplete:attested');
  assert.equal(classifyCompletion({ completion: 'incomplete:version_not_bumped' }), 'incomplete:version_not_bumped');
});

test('classifyCompletion: merged (done: none) stays merged', () => {
  assert.equal(classifyCompletion({ completion: 'merged' }), 'merged');
});

test('classifyCompletion: no completion field → legacy (never complete)', () => {
  assert.equal(classifyCompletion({}), 'legacy');
  assert.equal(classifyCompletion(undefined), 'legacy');
  assert.equal(classifyCompletion({ completion: null }), 'legacy');
  assert.equal(classifyCompletion({ completion: '' }), 'legacy');
  assert.equal(classifyCompletion({ completion: 'incomplete:' }), 'legacy');
});

test('classifyCompletion: an unknown completion value → legacy (defensive)', () => {
  assert.equal(classifyCompletion({ completion: 'bogus' }), 'legacy');
});
