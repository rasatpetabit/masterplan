// test/github-coord.test.mjs — pure unit tests for lib/github-coord.mjs.
//
// Coverage:
//   A2: issueBodyForTask / parseIssueBody round-trip (happy + edge)
//   A3: validateClaimSettle — already-claimed rejection + same-assignee re-claim
//   A4: selectClaimableUnits — disjoint-file & wave-order selection (dep satisfaction)
//   A5: nextWaveToPublish — wave ordering + null-on-incomplete
//   A6: reconcileIntegration — idempotence as a pure-state property
//   All others: dedupKey, findDuplicates, canTransition, mergeBatchPlan
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  issueBodyForTask,
  parseIssueBody,
  dedupKey,
  findDuplicates,
  canTransition,
  validateClaimSettle,
  selectClaimableUnits,
  nextWaveToPublish,
  reconcileIntegration,
  mergeBatchPlan,
  isTerminalIssueStatus,
  isValidIssueStatus,
  ISSUE_MAP_STATUSES,
  refSafePlanHash,
  computeCoordDefaults,
} from '../lib/github-coord.mjs';

// ============================================================================
// A2 — issueBodyForTask / parseIssueBody round-trip
// ============================================================================

const TASK = {
  id: 7,
  description: 'Implement the coordinator',
  files: ['lib/github-coord.mjs', 'test/github-coord.test.mjs'],
  verify_commands: ['node --test test/github-coord.test.mjs'],
  deps: ['3', '4'],
};
const OPTS = {
  contractRef: 'mp-coord/my-run/abc123',
  integrationBranch: 'mp-int/my-run',
  baseSha: 'deadbeef',
  planHash: 'abc123',
  runSlug: 'my-run',
  wave: 2,
};

test('A2: round-trip — parseIssueBody(issueBodyForTask(task, opts)) recovers all fields', () => {
  const body = issueBodyForTask(TASK, OPTS);
  const meta = parseIssueBody(body);

  assert.equal(meta.run_slug, 'my-run');
  assert.equal(meta.task_id, '7');
  assert.equal(meta.plan_hash, 'abc123');
  assert.equal(meta.base_sha, 'deadbeef');
  assert.equal(meta.wave, 2);
  assert.deepEqual(meta.files, TASK.files);
  assert.deepEqual(meta.verify_commands, TASK.verify_commands);
  assert.deepEqual(meta.deps, TASK.deps);
  assert.equal(meta.contract_ref, 'mp-coord/my-run/abc123');
  assert.equal(meta.integration_branch, 'mp-int/my-run');
});

test('A2: body contains a human title line', () => {
  const body = issueBodyForTask(TASK, OPTS);
  assert.ok(body.includes('T7: Implement the coordinator'), 'should include human title');
});

test('A2: body contains metadata in HTML-comment sentinels (invisible in rendered markdown)', () => {
  const body = issueBodyForTask(TASK, OPTS);
  assert.ok(body.includes('<!-- mp-coord-meta'), 'should have open sentinel');
  assert.ok(body.includes('mp-coord-meta -->'), 'should have close sentinel');
});

test('A2: task with empty files/verify_commands round-trips correctly', () => {
  const minimal = { id: 1, description: 'minimal', files: [], verify_commands: [], deps: [] };
  const body = issueBodyForTask(minimal, OPTS);
  const meta = parseIssueBody(body);
  assert.deepEqual(meta.files, []);
  assert.deepEqual(meta.verify_commands, []);
  assert.deepEqual(meta.deps, []);
});

test('A2: task with nullish optional fields still round-trips', () => {
  const sparse = { id: 99 };
  const body = issueBodyForTask(sparse, { runSlug: 'slug' });
  const meta = parseIssueBody(body);
  assert.equal(meta.task_id, '99');
  assert.equal(meta.plan_hash, null);
  assert.equal(meta.base_sha, null);
  assert.equal(meta.wave, null);
  assert.deepEqual(meta.files, []);
});

test('A2: issueBodyForTask throws when task.id is missing', () => {
  assert.throws(() => issueBodyForTask({}, OPTS), /task\.id is required/);
});

test('A2: issueBodyForTask throws when runSlug is missing', () => {
  assert.throws(() => issueBodyForTask({ id: 1 }, {}), /runSlug is required/);
});

test('A2: parseIssueBody throws on body with no metadata block (fail-loud)', () => {
  assert.throws(() => parseIssueBody('just a plain issue body'), /no mp-coord-meta block/);
});

test('A2: parseIssueBody throws on malformed JSON in metadata block', () => {
  const broken = `## Title\n<!-- mp-coord-meta\n{broken json\nmp-coord-meta -->`;
  assert.throws(() => parseIssueBody(broken), /malformed JSON/);
});

test('A2: issueBodyForTask does not mutate its inputs', () => {
  const task = { id: 5, files: ['x.js'], verify_commands: ['npm test'], deps: [] };
  const opts = { runSlug: 'test-run', wave: 0 };
  const origFiles = [...task.files];
  issueBodyForTask(task, opts);
  assert.deepEqual(task.files, origFiles, 'task.files must not be mutated');
});

// ============================================================================
// A1 — dedupKey + findDuplicates
// ============================================================================

test('dedupKey returns "<run_slug>#<task_id>" for a parsed object', () => {
  assert.equal(dedupKey({ run_slug: 'my-run', task_id: '7' }), 'my-run#7');
});

test('dedupKey handles null/missing fields gracefully', () => {
  assert.equal(dedupKey({}), '#');
  assert.equal(dedupKey(null), '#');
});

test('findDuplicates returns empty array when no duplicates', () => {
  const body1 = issueBodyForTask({ id: 1 }, { runSlug: 'r' });
  const body2 = issueBodyForTask({ id: 2 }, { runSlug: 'r' });
  const result = findDuplicates([{ body: body1 }, { body: body2 }]);
  assert.deepEqual(result, []);
});

test('findDuplicates returns conflicting groups (same run_slug + task_id)', () => {
  const bodyA = issueBodyForTask({ id: 3 }, { runSlug: 'r' });
  const bodyB = issueBodyForTask({ id: 3 }, { runSlug: 'r' }); // duplicate
  const bodyC = issueBodyForTask({ id: 4 }, { runSlug: 'r' });
  const dupes = findDuplicates([{ body: bodyA, number: 10 }, { body: bodyB, number: 11 }, { body: bodyC, number: 12 }]);
  assert.equal(dupes.length, 1, 'one duplicate group');
  assert.equal(dupes[0].length, 2, 'group has two issues');
});

test('findDuplicates skips issues with non-masterplan bodies (no sentinel)', () => {
  const bodyOk = issueBodyForTask({ id: 1 }, { runSlug: 'r' });
  const result = findDuplicates([{ body: bodyOk }, { body: 'regular GitHub issue' }]);
  assert.deepEqual(result, []);
});

test('findDuplicates returns empty array on non-array input', () => {
  assert.deepEqual(findDuplicates(null), []);
  assert.deepEqual(findDuplicates({}), []);
});

// ============================================================================
// A2 — canTransition (label state machine)
// ============================================================================

test('canTransition: valid edges return true', () => {
  assert.ok(canTransition('open', 'claimed'), 'open → claimed');
  assert.ok(canTransition('claimed', 'open'), 'claimed → open (release)');
  assert.ok(canTransition('claimed', 'pr-open'), 'claimed → pr-open');
  assert.ok(canTransition('pr-open', 'closed'), 'pr-open → closed');
});

test('canTransition: invalid edges return false', () => {
  assert.equal(canTransition('open', 'closed'), false, 'open → closed not allowed');
  assert.equal(canTransition('open', 'pr-open'), false, 'open → pr-open not allowed');
  assert.equal(canTransition('pr-open', 'open'), false, 'pr-open → open not allowed');
  assert.equal(canTransition('pr-open', 'claimed'), false, 'pr-open → claimed not allowed');
  assert.equal(canTransition('closed', 'open'), false, 'closed is terminal');
  assert.equal(canTransition('closed', 'claimed'), false, 'closed is terminal');
  assert.equal(canTransition('claimed', 'closed'), false, 'claimed → closed not allowed directly');
});

test('canTransition: self-loops return false', () => {
  assert.equal(canTransition('open', 'open'), false);
  assert.equal(canTransition('claimed', 'claimed'), false);
});

test('canTransition: unknown states return false', () => {
  assert.equal(canTransition('unknown', 'open'), false);
  assert.equal(canTransition('open', 'unknown'), false);
});

// ============================================================================
// A2b — issue_map.status vocabulary (DISTINCT from the label machine above)
// ============================================================================

test('A2b: ISSUE_MAP_STATUSES is the full local-status vocabulary', () => {
  assert.deepEqual(ISSUE_MAP_STATUSES, ['open', 'claimed', 'pr-open', 'merged', 'closed']);
});

test('A2b: isTerminalIssueStatus — BOTH merged and closed are terminal', () => {
  // The load-bearing invariant: the G9 reconcile write-back sets `merged`, and nothing
  // writes local `closed`, so treating only `closed` as terminal deadlocks publish↔follow.
  assert.ok(isTerminalIssueStatus('merged'), 'merged is terminal');
  assert.ok(isTerminalIssueStatus('closed'), 'closed is terminal');
});

test('A2b: isTerminalIssueStatus — non-terminal and unknown statuses are false', () => {
  assert.equal(isTerminalIssueStatus('open'), false);
  assert.equal(isTerminalIssueStatus('claimed'), false);
  assert.equal(isTerminalIssueStatus('pr-open'), false);
  assert.equal(isTerminalIssueStatus('merge'), false, 'typo is not terminal');
  assert.equal(isTerminalIssueStatus(undefined), false);
  assert.equal(isTerminalIssueStatus(null), false);
});

test('A2b: isValidIssueStatus — accepts every vocabulary member', () => {
  for (const s of ISSUE_MAP_STATUSES) {
    assert.ok(isValidIssueStatus(s), `${s} is valid`);
  }
});

test('A2b: isValidIssueStatus — rejects typos and off-vocabulary values', () => {
  assert.equal(isValidIssueStatus('merge'), false, 'merged typo');
  assert.equal(isValidIssueStatus('done'), false, 'local-task vocab, not issue_map vocab');
  assert.equal(isValidIssueStatus('OPEN'), false, 'case-sensitive');
  assert.equal(isValidIssueStatus(''), false);
  assert.equal(isValidIssueStatus(undefined), false);
});

// ============================================================================
// A3 — validateClaimSettle (won/lost + same-assignee re-claim)
// ============================================================================

const wonIssue = { assignees: ['alice'], labels: ['mp:claimed'], state: 'open' };

test('A3: validateClaimSettle returns won for sole assignee + claimed label + no existing PRs', () => {
  assert.equal(validateClaimSettle(wonIssue, 'alice', []), 'won');
});

test('A3: same-assignee re-claim (idempotent) also returns won', () => {
  // alice already assigned; this is a re-settle after a crash/retry — must win
  const reClaimIssue = { assignees: ['alice'], labels: ['mp:claimed'], state: 'open' };
  assert.equal(validateClaimSettle(reClaimIssue, 'alice', []), 'won',
    'same-assignee re-claim should return won, not lost');
});

test('A3: returns lost when another assignee holds the claim', () => {
  const otherClaimed = { assignees: ['bob'], labels: ['mp:claimed'] };
  assert.equal(validateClaimSettle(otherClaimed, 'alice', []), 'lost');
});

test('A3: returns lost when multiple assignees (race condition)', () => {
  const multiAssignee = { assignees: ['alice', 'bob'], labels: ['mp:claimed'] };
  assert.equal(validateClaimSettle(multiAssignee, 'alice', []), 'lost');
});

test('A3: returns lost when no assignees (claim was released already)', () => {
  const noAssignee = { assignees: [], labels: ['mp:claimed'] };
  assert.equal(validateClaimSettle(noAssignee, 'alice', []), 'lost');
});

test('A3: returns lost when label is mp:open (not yet claimed or released)', () => {
  const openIssue = { assignees: ['alice'], labels: ['mp:open'] };
  assert.equal(validateClaimSettle(openIssue, 'alice', []), 'lost');
});

test('A3: returns lost when mp:open and mp:claimed both present', () => {
  const mixed = { assignees: ['alice'], labels: ['mp:open', 'mp:claimed'] };
  assert.equal(validateClaimSettle(mixed, 'alice', []), 'lost');
});

test('A3: returns lost when an existing open PR exists for this task', () => {
  const existingPrs = [{ number: 42, state: 'open' }];
  assert.equal(validateClaimSettle(wonIssue, 'alice', existingPrs), 'lost');
});

test('A3: returns lost for null/missing issue or actor', () => {
  assert.equal(validateClaimSettle(null, 'alice', []), 'lost');
  assert.equal(validateClaimSettle(wonIssue, '', []), 'lost');
  assert.equal(validateClaimSettle(wonIssue, null, []), 'lost');
});

// ============================================================================
// A4 — selectClaimableUnits (dep satisfaction + label filter)
// ============================================================================

function makeIssue(taskId, labels, depsOverride) {
  // Build an issue whose body encodes the given taskId and deps
  const task = { id: taskId, deps: depsOverride ?? [] };
  return { body: issueBodyForTask(task, { runSlug: 'run' }), labels };
}

test('A4: returns all open issues when no deps and no merged tasks', () => {
  const issues = [
    makeIssue(1, ['mp:open']),
    makeIssue(2, ['mp:open']),
  ];
  const result = selectClaimableUnits(issues, [], null);
  assert.equal(result.length, 2);
});

test('A4: excludes claimed/pr-open/closed issues', () => {
  const issues = [
    makeIssue(1, ['mp:open']),
    makeIssue(2, ['mp:claimed']),
    makeIssue(3, ['mp:pr-open']),
    makeIssue(4, ['mp:closed']),
  ];
  const result = selectClaimableUnits(issues, [], null);
  assert.equal(result.length, 1);
  // Only task 1 (mp:open) is claimable
  const meta = parseIssueBody(result[0].body);
  assert.equal(meta.task_id, '1');
});

test('A4: excludes issues with unsatisfied deps', () => {
  const issues = [
    makeIssue(10, ['mp:open'], ['5', '6']), // deps 5 and 6 not yet merged
    makeIssue(11, ['mp:open'], ['5']),       // dep 5 not merged
    makeIssue(12, ['mp:open'], []),           // no deps → claimable
  ];
  const result = selectClaimableUnits(issues, [], null);
  assert.equal(result.length, 1);
  const meta = parseIssueBody(result[0].body);
  assert.equal(meta.task_id, '12');
});

test('A4: includes issues once their deps are satisfied', () => {
  const issues = [
    makeIssue(10, ['mp:open'], ['5', '6']),
    makeIssue(11, ['mp:open'], ['5']),
  ];
  const result = selectClaimableUnits(issues, ['5', '6'], null);
  // Both deps satisfied for 10; dep 5 satisfied for 11
  assert.equal(result.length, 2);
});

test('A4: numeric merged task IDs match string deps (type-insensitive)', () => {
  const issues = [makeIssue(20, ['mp:open'], ['3'])];
  const result = selectClaimableUnits(issues, [3], null); // number 3 vs string '3'
  assert.equal(result.length, 1);
});

test('A4: planIndexDeps overrides body deps when provided', () => {
  // Issue body says dep '99' (not merged), but planIndexDeps says no deps for task 30
  const issues = [makeIssue(30, ['mp:open'], ['99'])];
  const planDeps = new Map([['30', []]]); // override: no deps
  const result = selectClaimableUnits(issues, [], planDeps);
  assert.equal(result.length, 1, 'planIndexDeps override should make the issue claimable');
});

test('A4: skips issues with unparseable bodies silently', () => {
  const bad = { body: 'no metadata here', labels: ['mp:open'] };
  const good = makeIssue(1, ['mp:open']);
  const result = selectClaimableUnits([bad, good], [], null);
  assert.equal(result.length, 1);
});

test('A4: returns [] on non-array input', () => {
  assert.deepEqual(selectClaimableUnits(null, [], null), []);
});

// ============================================================================
// A5 — nextWaveToPublish
// ============================================================================

test('A5: returns 0 when no waves published yet', () => {
  assert.equal(nextWaveToPublish({}), 0);
});

test('A5: returns next wave when all published waves are fully merged', () => {
  const waves = {
    0: { issues: [], allMerged: true },
    1: { issues: [], allMerged: true },
  };
  assert.equal(nextWaveToPublish(waves), 2);
});

test('A5: returns null when current wave is not fully merged', () => {
  const waves = {
    0: { issues: [], allMerged: true },
    1: { issues: [], allMerged: false }, // incomplete
  };
  assert.equal(nextWaveToPublish(waves), null);
});

test('A5: returns null when wave 0 is not merged (nothing unblocked yet)', () => {
  const waves = {
    0: { issues: [], allMerged: false },
  };
  assert.equal(nextWaveToPublish(waves), null);
});

test('A5: handles non-sequential wave numbers (gaps)', () => {
  // Wave 0 merged, wave 2 merged — the "next" is wave 3 (max+1)
  const waves = {
    0: { allMerged: true },
    2: { allMerged: true },
  };
  assert.equal(nextWaveToPublish(waves), 3);
});

test('A5: returns null on null/invalid input', () => {
  assert.equal(nextWaveToPublish(null), null);
  assert.equal(nextWaveToPublish('string'), null);
});

// ============================================================================
// A6 — reconcileIntegration (idempotence as a pure-state property)
// ============================================================================

function makeLocalState(tasks, issueMap) {
  return {
    tasks,
    coordination: { issue_map: issueMap },
  };
}

function makeGhIssue(taskId, merged, prNumber, mergeSha) {
  const body = issueBodyForTask({ id: taskId }, { runSlug: 'run' });
  return {
    number: 100 + Number(taskId),
    body,
    state: merged ? 'closed' : 'open',
    labels: merged ? ['mp:closed'] : ['mp:pr-open'],
    pr: merged ? { merged: true, number: prNumber, merge_sha: mergeSha } : { merged: false, number: prNumber },
  };
}

const localStateBase = makeLocalState(
  [
    { id: '1', status: 'pending' },
    { id: '2', status: 'pending' },
  ],
  {
    '1': { issue: 101, pr: 201, merge_sha: null, status: 'pr-open' },
    '2': { issue: 102, pr: 202, merge_sha: null, status: 'pr-open' },
  }
);

test('A6: merged-but-not-marked emits mark_done action', () => {
  const ghIssues = [
    makeGhIssue('1', true, 201, 'sha-abc'),
    makeGhIssue('2', false, 202, null),
  ];
  const actions = reconcileIntegration(localStateBase, ghIssues);
  const markDone = actions.filter((a) => a.action === 'mark_done');
  assert.equal(markDone.length, 1);
  assert.equal(markDone[0].task_id, '1');
  assert.equal(markDone[0].merge_sha, 'sha-abc');
});

test('A6: locally-done-but-not-merged emits surface action', () => {
  const localWithDone = makeLocalState(
    [
      { id: '1', status: 'done' }, // done locally
      { id: '2', status: 'pending' },
    ],
    {
      '1': { issue: 101, pr: 201, merge_sha: null, status: 'pr-open' },
      '2': { issue: 102, pr: 202, merge_sha: null, status: 'pr-open' },
    }
  );
  const ghIssues = [
    makeGhIssue('1', false, 201, null), // NOT merged on GitHub
    makeGhIssue('2', false, 202, null),
  ];
  const actions = reconcileIntegration(localWithDone, ghIssues);
  const surface = actions.filter((a) => a.action === 'surface');
  assert.equal(surface.length, 1);
  assert.equal(surface[0].task_id, '1');
  assert.equal(surface[0].reason, 'locally-done-but-not-merged');
});

test('A6: no actions when local and GitHub agree (both done)', () => {
  const localDone = makeLocalState(
    [{ id: '1', status: 'done' }],
    { '1': { issue: 101, pr: 201, merge_sha: 'sha-xyz', status: 'merged' } }
  );
  const ghIssues = [makeGhIssue('1', true, 201, 'sha-xyz')];
  const actions = reconcileIntegration(localDone, ghIssues);
  assert.equal(actions.length, 0);
});

test('A6: idempotence — applying mark_done actions then re-running yields zero new mark_done', () => {
  const ghIssues = [
    makeGhIssue('1', true, 201, 'sha-abc'),
    makeGhIssue('2', true, 202, 'sha-def'),
  ];
  const actions1 = reconcileIntegration(localStateBase, ghIssues);
  const markDone = actions1.filter((a) => a.action === 'mark_done');
  assert.equal(markDone.length, 2, 'both tasks need mark_done on first pass');

  // Simulate applying the mark_done actions: update local state to reflect done
  const updatedTasks = localStateBase.tasks.map((t) => {
    const applied = markDone.find((a) => a.task_id === String(t.id));
    return applied ? { ...t, status: 'done' } : t;
  });
  const stateAfter = { ...localStateBase, tasks: updatedTasks };

  // Second reconcile: same GitHub state, updated local state
  const actions2 = reconcileIntegration(stateAfter, ghIssues);
  const markDone2 = actions2.filter((a) => a.action === 'mark_done');
  assert.equal(markDone2.length, 0, 'idempotent: no new mark_done actions after applying them');
});

test('A6: reconcileIntegration does not mutate inputs', () => {
  const ghIssues = [makeGhIssue('1', true, 201, 'sha-abc')];
  const origTasks = JSON.stringify(localStateBase.tasks);
  reconcileIntegration(localStateBase, ghIssues);
  assert.equal(JSON.stringify(localStateBase.tasks), origTasks, 'localState must not be mutated');
});

test('A6: returns [] on bad inputs', () => {
  assert.deepEqual(reconcileIntegration(null, []), []);
  assert.deepEqual(reconcileIntegration({}, null), []);
});

// ============================================================================
// A7 — mergeBatchPlan
// ============================================================================

test('mergeBatchPlan: returns [] for empty input', () => {
  assert.deepEqual(mergeBatchPlan([]), []);
  assert.deepEqual(mergeBatchPlan(null), []);
});

test('mergeBatchPlan: single PR has recheckBefore=false', () => {
  const plan = mergeBatchPlan([{ task_id: '3', number: 42 }]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].recheckBefore, false);
  assert.equal(plan[0].pr.number, 42);
});

test('mergeBatchPlan: first PR no re-check, subsequent PRs get re-check', () => {
  const prs = [
    { task_id: '2', number: 20 },
    { task_id: '5', number: 50 },
    { task_id: '1', number: 10 },
  ];
  const plan = mergeBatchPlan(prs);
  assert.equal(plan.length, 3);
  // Sorted by task_id: 1, 2, 5
  assert.equal(plan[0].pr.task_id, '1');
  assert.equal(plan[0].recheckBefore, false);
  assert.equal(plan[1].pr.task_id, '2');
  assert.equal(plan[1].recheckBefore, true);
  assert.equal(plan[2].pr.task_id, '5');
  assert.equal(plan[2].recheckBefore, true);
});

test('mergeBatchPlan: does not mutate input array', () => {
  const prs = [{ task_id: '2', number: 20 }, { task_id: '1', number: 10 }];
  const origFirst = prs[0].task_id;
  mergeBatchPlan(prs);
  assert.equal(prs[0].task_id, origFirst, 'input array must not be mutated');
});

// ============================================================================
// A8 — refSafePlanHash / computeCoordDefaults (publish bootstrap, §7.1)
// ============================================================================

test('refSafePlanHash: strips a leading sha256: prefix (git refs forbid colon)', () => {
  const hex = 'a'.repeat(64);
  assert.equal(refSafePlanHash('sha256:' + hex), hex);
  assert.ok(!refSafePlanHash('sha256:' + hex).includes(':'));
});

test('refSafePlanHash: passes through an already-bare hash unchanged', () => {
  assert.equal(refSafePlanHash('abc123'), 'abc123');
});

test('refSafePlanHash: strips any algorithm prefix, not just sha256', () => {
  assert.equal(refSafePlanHash('sha1:deadbeef'), 'deadbeef');
});

test('refSafePlanHash: returns null for null/undefined/empty', () => {
  assert.equal(refSafePlanHash(null), null);
  assert.equal(refSafePlanHash(undefined), null);
  assert.equal(refSafePlanHash(''), null);
  assert.equal(refSafePlanHash('   '), null);
});

test('computeCoordDefaults: derives both refs from slug + plan_hash (colon-free contract_ref)', () => {
  const hex = 'b'.repeat(64);
  const d = computeCoordDefaults('myrun', 'sha256:' + hex);
  assert.equal(d.contract_ref, `mp-coord/myrun/${hex}`);
  assert.equal(d.integration_branch, 'mp-int/myrun');
  assert.ok(!d.contract_ref.includes(':'), 'contract_ref must be a valid git ref');
});

test('computeCoordDefaults: contract_ref is null when plan_hash is absent (not bootstrappable)', () => {
  const d = computeCoordDefaults('myrun', null);
  assert.equal(d.contract_ref, null);
  // integration_branch does not depend on the hash, so it is still derivable
  assert.equal(d.integration_branch, 'mp-int/myrun');
});

test('computeCoordDefaults: throws when slug is missing', () => {
  assert.throws(() => computeCoordDefaults('', 'sha256:abc'), /slug is required/);
  assert.throws(() => computeCoordDefaults(undefined, 'sha256:abc'), /slug is required/);
});
