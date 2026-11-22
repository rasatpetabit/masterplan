import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reauthorizeScope } from '../lib/scope-authorization.mjs';
import { canonicalizeScopePaths } from '../lib/dispatch/multi-repo.mjs';
import { pathWithinDeclaredScope } from '../lib/declared-scope.mjs';

// existsSync is the per-path work inside canonicalizeScopePaths for a relative
// path (the sibling .git probe). Counting it measures canonicalization, not git.
function countingContext(bucket) {
  return {
    worktree: '/tmp/wt-scope',
    mainRoot: '/tmp/main-scope',
    slug: 'scope',
    existsSync: () => { bucket.count += 1; return false; },
  };
}

// The pre-hoist loop: frozen scope and every proof list are canonicalized again
// for every task. This is the oracle for the amendment result, and its call count
// is the uncached cost.
function naiveAmendments(state, events, context, wave) {
  const run = state.active_run;
  const cursor = run.scope_event_cursor;
  const amendments = [];
  for (const task of (state.tasks ?? []).filter((t) => t.wave === wave)) {
    const files = canonicalizeScopePaths(task.files ?? [], context);
    const frozen = canonicalizeScopePaths(run.scope, context);
    if (files.every((f) => pathWithinDeclaredScope(f, frozen))) continue;
    let match = null;
    for (let i = cursor; i < events.length; i++) {
      const event = events[i];
      if (!['plan_amended', 'tasks_amended'].includes(event?.type)) continue;
      const proof = event.task_files?.find((t) => String(t.id) === String(task.id) && t.wave === wave);
      if (proof && JSON.stringify(canonicalizeScopePaths(proof.files, context)) === JSON.stringify(files)) {
        match = { event_line: i + 1, type: event.type, ts: event.ts ?? null, task_id: task.id };
      }
    }
    if (!match) throw new Error('naive oracle found no amendment for task ' + task.id);
    amendments.push(match);
  }
  return amendments;
}

test('reauthorizeScope hoists frozen scope and memoizes repeated proof paths', () => {
  const lists = [
    ['src/new-a', 'src/new-b'],
    ['src/new-c'],
  ];
  const tasks = [{ id: 'inside', wave: 1, files: ['src/a'] }];
  const events = [];
  const taskCount = 8;
  const copies = 6;
  for (let t = 0; t < taskCount; t++) {
    const files = lists[t % lists.length];
    tasks.push({ id: t + 1, wave: 1, files });
    for (let m = 0; m < copies; m++) {
      events.push({
        type: m % 2 === 0 ? 'plan_amended' : 'tasks_amended',
        ts: 't' + t + '-m' + m,
        task_files: [{ id: t + 1, wave: 1, files }],
      });
    }
  }
  const state = {
    slug: 'scope',
    worktree: '/tmp/wt-scope',
    tasks,
    active_run: { kind: 'execute', wave: 1, scope: ['src/a'], scope_event_cursor: 0 },
  };
  const naiveBucket = { count: 0 };
  const expected = naiveAmendments(state, events, countingContext(naiveBucket), 1);
  const optimizedBucket = { count: 0 };
  const result = reauthorizeScope({
    statePath: '/tmp/does-not-matter',
    state,
    wave: 1,
    reason: 'recorded amendment',
    events,
    context: countingContext(optimizedBucket),
  });
  assert.deepEqual(result.event.amendments, expected);
  assert.equal(result.event.amendments.some((amendment) => amendment.task_id === 'inside'), false);
  assert.deepEqual(result.state.active_run.scope, ['src/a', 'src/new-a', 'src/new-b', 'src/new-c']);
  assert.ok(
    optimizedBucket.count < naiveBucket.count,
    optimizedBucket.count + ' canonical path checks, naive loop ' + naiveBucket.count,
  );
});
