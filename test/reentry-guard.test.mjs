// Test of the unified re-entry guard (lib/reentry-guard.mjs).
// Preserves the behavioral contracts of test/gate-review.test.mjs
// (fail-soft artifact-hash gates) and test/review-companion.test.mjs
// (skip-ignored head-sha finish guard), and adds the NEW
// run+task+sha per-task kind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReentry, reentryEventTypes, buildTaskReviewEvent, KINDS, TASK_REVIEW_TYPES } from '../lib/reentry-guard.mjs';

const HASH = 'sha256:deadbeef';
const HEAD = 'aaaa111';
const ABSENT = { present: false, status: null, digest: null, count: null, base: null };
const lines = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

// ── artifact-hash kind (contracts from gate-review) ──

test('artifact-hash: present (done) at hash → {present, status:done, digest, count, base}', () => {
  const text = lines(
    { type: 'text' },
    {
      type: 'spec_adversary_review',
      ts: 't1',
      data: { hash: HASH, base: null, count: 2 },
      note: 'P2: dataflow gap; P3: naming',
    },
  );
  assert.deepEqual(
    selectReentry(text, { kind: 'artifact-hash', gate: 'spec', key: HASH }),
    {
      present: true,
      status: 'done',
      digest: 'P2: dataflow gap; P3: naming',
      count: 2,
      base: null,
    },
  );
});

test('artifact-hash: a *_skipped (degraded) record SATISFIES the gate (fail-soft polarity)', () => {
  const text = lines({
    type: 'plan_adversary_review_skipped',
    data: { hash: HASH },
    note: 'skipped: gateway down',
  });
  assert.deepEqual(
    selectReentry(text, { kind: 'artifact-hash', gate: 'plan', key: HASH }),
    {
      present: true,
      status: 'skipped',
      digest: 'skipped: gateway down',
      count: null,
      base: null,
    },
  );
});

test('artifact-hash: no record at this hash → absent (edited artifact re-arms the gate)', () => {
  const text = lines({
    type: 'spec_adversary_review',
    data: { hash: 'sha256:other', count: 1 },
    note: 'other',
  });
  assert.deepEqual(
    selectReentry(text, { kind: 'artifact-hash', gate: 'spec', key: HASH }),
    { ...ABSENT },
  );
});

test('artifact-hash: a clean zero-findings review is present (count:0, not absent)', () => {
  const text = lines({
    type: 'plan_adversary_review',
    data: { hash: HASH, count: 0 },
    note: 'no findings',
  });
  assert.deepEqual(
    selectReentry(text, { kind: 'artifact-hash', gate: 'plan', key: HASH }),
    {
      present: true,
      status: 'done',
      digest: 'no findings',
      count: 0,
      base: null,
    },
  );
});

test('artifact-hash: the gates are distinct — a spec record does NOT satisfy the plan gate', () => {
  const text = lines({
    type: 'spec_adversary_review',
    data: { hash: HASH, count: 1 },
    note: 'spec only',
  });
  assert.equal(
    selectReentry(text, { kind: 'artifact-hash', gate: 'spec', key: HASH }).present,
    true,
  );
  assert.equal(
    selectReentry(text, { kind: 'artifact-hash', gate: 'plan', key: HASH }).present,
    false,
  );
});

test('artifact-hash: last matching line at the hash wins (a re-review supersedes, skip can supersede done)', () => {
  const text = lines(
    {
      type: 'spec_adversary_review',
      data: { hash: HASH, count: 5 },
      note: 'first pass',
    },
    {
      type: 'spec_adversary_review_skipped',
      data: { hash: HASH },
      note: 'second pass (skip)',
    },
  );
  assert.deepEqual(
    selectReentry(text, { kind: 'artifact-hash', gate: 'spec', key: HASH }),
    {
      present: true,
      status: 'skipped',
      digest: 'second pass (skip)',
      count: null,
      base: null,
    },
  );
});

test('artifact-hash: blank + malformed lines are skipped, not fatal', () => {
  const text =
    '\n' +
    'not json at all\n' +
    JSON.stringify({
      type: 'plan_adversary_review',
      data: { hash: HASH, base: 'main', count: 3 },
      note: 'ok',
    }) +
    '\n\n';
  assert.deepEqual(
    selectReentry(text, { kind: 'artifact-hash', gate: 'plan', key: HASH }),
    {
      present: true,
      status: 'done',
      digest: 'ok',
      count: 3,
      base: 'main',
    },
  );
});

test('artifact-hash: empty text / empty key / non-string → absent (no throw)', () => {
  assert.deepEqual(
    selectReentry('', { kind: 'artifact-hash', gate: 'spec', key: HASH }),
    ABSENT,
  );
  const matching = lines({
    type: 'spec_adversary_review',
    data: { hash: HASH, count: 1 },
    note: 'x',
  });
  assert.deepEqual(
    selectReentry(matching, { kind: 'artifact-hash', gate: 'spec', key: '' }),
    ABSENT,
  );
  assert.deepEqual(
    selectReentry(null, { kind: 'artifact-hash', gate: 'spec', key: HASH }),
    ABSENT,
  );
  assert.deepEqual(
    selectReentry('{}', { kind: 'artifact-hash', gate: 'spec', key: HASH }),
    ABSENT,
  );
});

test('artifact-hash: record missing note/count/base normalizes to null (not undefined)', () => {
  const text = lines({
    type: 'spec_adversary_review',
    data: { hash: HASH },
  });
  assert.deepEqual(
    selectReentry(text, { kind: 'artifact-hash', gate: 'spec', key: HASH }),
    {
      present: true,
      status: 'done',
      digest: null,
      count: null,
      base: null,
    },
  );
});

test('artifact-hash: unknown gate throws (caller bug, not data)', () => {
  assert.throws(
    () => selectReentry('', { kind: 'artifact-hash', gate: 'finish', key: HASH }),
    /unknown gate/,
  );
  assert.throws(
    () => reentryEventTypes('artifact-hash', 'bogus'),
    /unknown gate/,
  );
});

// ── head-sha kind (contracts from review-companion) ──

test('head-sha: present (adversary_review) at HEAD → {present, status:done, digest, count, base}', () => {
  const text = lines(
    { type: 'verification' },
    {
      type: 'adversary_review',
      data: { sha: HEAD, base: 'main', count: 2 },
      note: 'P2: stale lock; P3: naming',
    },
  );
  assert.deepEqual(
    selectReentry(text, { kind: 'head-sha', key: HEAD }),
    {
      present: true,
      status: 'done',
      digest: 'P2: stale lock; P3: naming',
      count: 2,
      base: 'main',
    },
  );
});

test('head-sha: a LEGACY codex_review record still satisfies the guard (dual-family, in-flight bundles)', () => {
  const text = lines({
    type: 'codex_review',
    data: { sha: HEAD, base: 'main', count: 2 },
    note: 'legacy digest',
  });
  assert.deepEqual(
    selectReentry(text, { kind: 'head-sha', key: HEAD }),
    {
      present: true,
      status: 'done',
      digest: 'legacy digest',
      count: 2,
      base: 'main',
    },
  );
});

test('head-sha: no record for this sha → absent', () => {
  const text = lines({
    type: 'adversary_review',
    data: { sha: 'other999', count: 1 },
    note: 'other',
  });
  assert.deepEqual(
    selectReentry(text, { kind: 'head-sha', key: HEAD }),
    ABSENT,
  );
});

test('head-sha: a clean zero-findings review is still present (count:0, not absent)', () => {
  const text = lines({
    type: 'adversary_review',
    data: { sha: HEAD, count: 0 },
    note: 'no findings',
  });
  assert.deepEqual(
    selectReentry(text, { kind: 'head-sha', key: HEAD }),
    {
      present: true,
      status: 'done',
      digest: 'no findings',
      count: 0,
      base: null,
    },
  );
});

test('head-sha: *_review_skipped (degraded) records are IGNORED — both families (skip never masks a re-run)', () => {
  for (const type of ['adversary_review_skipped', 'codex_review_skipped']) {
    const text = lines({ type, data: { sha: HEAD } });
    assert.deepEqual(
      selectReentry(text, { kind: 'head-sha', key: HEAD }),
      ABSENT,
    );
  }
});

test('head-sha: a skipped line AFTER a done line does not unset it (skip-ignored ≠ last-match flip)', () => {
  const text = lines(
    {
      type: 'adversary_review',
      data: { sha: HEAD, count: 1 },
      note: 'done',
    },
    {
      type: 'adversary_review_skipped',
      data: { sha: HEAD },
      note: 'skip after',
    },
  );
  const result = selectReentry(text, { kind: 'head-sha', key: HEAD });
  assert.equal(result.present, true);
  assert.equal(result.status, 'done');
});

test('head-sha: last matching line at the sha wins (a re-review supersedes)', () => {
  const text = lines(
    {
      type: 'adversary_review',
      data: { sha: HEAD, count: 5 },
      note: 'first pass',
    },
    {
      type: 'adversary_review',
      data: { sha: HEAD, count: 1 },
      note: 'second pass',
    },
  );
  assert.deepEqual(
    selectReentry(text, { kind: 'head-sha', key: HEAD }),
    {
      present: true,
      status: 'done',
      digest: 'second pass',
      count: 1,
      base: null,
    },
  );
});

test('head-sha: blank + malformed lines are skipped, not fatal', () => {
  const text =
    '\n' +
    'not json at all\n' +
    JSON.stringify({
      type: 'adversary_review',
      data: { sha: HEAD, base: 'main', count: 3 },
      note: 'ok',
    }) +
    '\n\n';
  assert.deepEqual(
    selectReentry(text, { kind: 'head-sha', key: HEAD }),
    {
      present: true,
      status: 'done',
      digest: 'ok',
      count: 3,
      base: 'main',
    },
  );
});

test('head-sha: empty text / empty sha / non-string → absent (no throw)', () => {
  assert.deepEqual(
    selectReentry('', { kind: 'head-sha', key: HEAD }),
    ABSENT,
  );
  const matching = lines({
    type: 'adversary_review',
    data: { sha: HEAD, count: 1 },
    note: 'x',
  });
  assert.deepEqual(
    selectReentry(matching, { kind: 'head-sha', key: '' }),
    ABSENT,
  );
  assert.deepEqual(
    selectReentry(null, { kind: 'head-sha', key: HEAD }),
    ABSENT,
  );
  assert.deepEqual(
    selectReentry('{}', { kind: 'head-sha', key: HEAD }),
    ABSENT,
  );
});

// ── run+task+sha kind (NEW vocabulary) ──

const RUN = 'simplify-dedup-2';
const TASK = 7;
const SHA = 'bbbb222';

test('run+task+sha: buildTaskReviewEvent → selectReentry round-trip (durable write then re-read)', () => {
  const ev = buildTaskReviewEvent({
    run: RUN,
    task: TASK,
    sha: SHA,
    count: 2,
    base: 'main',
    digest: 'P2: off-by-one',
    ts: '2026-07-15T00:00:00Z',
  });
  assert.equal(ev.type, TASK_REVIEW_TYPES.done);
  assert.deepEqual(ev.data, {
    run: RUN,
    task: TASK,
    sha: SHA,
    count: 2,
    base: 'main',
  });
  assert.deepEqual(
    selectReentry(lines(ev), {
      kind: 'run+task+sha',
      key: { run: RUN, task: TASK, sha: SHA },
    }),
    {
      present: true,
      status: 'done',
      digest: 'P2: off-by-one',
      count: 2,
      base: 'main',
    },
  );
});

test('run+task+sha: keyed on ALL THREE — wrong run / wrong task / wrong sha each → absent', () => {
  const ev = buildTaskReviewEvent({
    run: RUN,
    task: TASK,
    sha: SHA,
    count: 1,
    digest: 'ok',
  });
  const text = lines(ev);
  assert.deepEqual(
    selectReentry(text, {
      kind: 'run+task+sha',
      key: { run: 'other-run', task: TASK, sha: SHA },
    }),
    ABSENT,
  );
  assert.deepEqual(
    selectReentry(text, {
      kind: 'run+task+sha',
      key: { run: RUN, task: 99, sha: SHA },
    }),
    ABSENT,
  );
  assert.deepEqual(
    selectReentry(text, {
      kind: 'run+task+sha',
      key: { run: RUN, task: TASK, sha: 'cccc333' },
    }),
    ABSENT,
  );
});

test('run+task+sha: task id is type-tolerant (number 3 matches string \'3\'), run and sha stay strict', () => {
  const withNum = lines(
    buildTaskReviewEvent({ run: RUN, task: 3, sha: SHA, count: 1, digest: 'n' }),
  );
  assert.equal(
    selectReentry(withNum, {
      kind: 'run+task+sha',
      key: { run: RUN, task: '3', sha: SHA },
    }).present,
    true,
  );
  const withStr = lines(
    buildTaskReviewEvent({ run: RUN, task: '3', sha: SHA, count: 1, digest: 's' }),
  );
  assert.equal(
    selectReentry(withStr, {
      kind: 'run+task+sha',
      key: { run: RUN, task: 3, sha: SHA },
    }).present,
    true,
  );
  assert.deepEqual(
    selectReentry(withNum, {
      kind: 'run+task+sha',
      key: { run: RUN.toUpperCase(), task: 3, sha: SHA },
    }),
    ABSENT,
  );
  assert.deepEqual(
    selectReentry(withNum, {
      kind: 'run+task+sha',
      key: { run: RUN, task: 3, sha: SHA.slice(0, 4) },
    }),
    ABSENT,
  );
});

test('run+task+sha: task_adversary_review_skipped is IGNORED (a durable skip never masks a later real review)', () => {
  const skipped = buildTaskReviewEvent({
    run: RUN,
    task: TASK,
    sha: SHA,
    status: 'skipped',
  });
  assert.deepEqual(
    selectReentry(lines(skipped), {
      kind: 'run+task+sha',
      key: { run: RUN, task: TASK, sha: SHA },
    }),
    ABSENT,
  );
  const done = buildTaskReviewEvent({
    run: RUN,
    task: TASK,
    sha: SHA,
    count: 1,
    digest: 'real',
  });
  assert.deepEqual(
    selectReentry(lines(skipped, done), {
      kind: 'run+task+sha',
      key: { run: RUN, task: TASK, sha: SHA },
    }),
    {
      present: true,
      status: 'done',
      digest: 'real',
      count: 1,
      base: null,
    },
  );
  assert.deepEqual(
    selectReentry(lines(done, skipped), {
      kind: 'run+task+sha',
      key: { run: RUN, task: TASK, sha: SHA },
    }),
    {
      present: true,
      status: 'done',
      digest: 'real',
      count: 1,
      base: null,
    },
  );
});

test('run+task+sha: a clean zero-findings per-task review is present (count:0, not absent)', () => {
  const ev = buildTaskReviewEvent({
    run: RUN,
    task: TASK,
    sha: SHA,
    count: 0,
    digest: 'no findings',
  });
  assert.deepEqual(
    selectReentry(lines(ev), {
      kind: 'run+task+sha',
      key: { run: RUN, task: TASK, sha: SHA },
    }),
    {
      present: true,
      status: 'done',
      digest: 'no findings',
      count: 0,
      base: null,
    },
  );
});

test('run+task+sha: last matching line wins (a per-task re-review supersedes)', () => {
  const first = buildTaskReviewEvent({
    run: RUN,
    task: TASK,
    sha: SHA,
    count: 4,
    digest: 'first',
  });
  const second = buildTaskReviewEvent({
    run: RUN,
    task: TASK,
    sha: SHA,
    count: 0,
    digest: 'second',
  });
  assert.deepEqual(
    selectReentry(lines(first, second), {
      kind: 'run+task+sha',
      key: { run: RUN, task: TASK, sha: SHA },
    }),
    {
      present: true,
      status: 'done',
      digest: 'second',
      count: 0,
      base: null,
    },
  );
});

test('run+task+sha: malformed key (missing run/task/sha, non-object) → absent, no throw', () => {
  const text = lines(
    buildTaskReviewEvent({
      run: RUN,
      task: TASK,
      sha: SHA,
      count: 1,
      digest: 'ok',
    }),
  );
  const opts = (key) => ({ kind: 'run+task+sha', key });
  assert.deepEqual(selectReentry(text, opts(null)), ABSENT);
  assert.deepEqual(selectReentry(text, opts({})), ABSENT);
  assert.deepEqual(
    selectReentry(text, opts({ run: RUN, sha: SHA })),
    ABSENT,
  );
  assert.deepEqual(
    selectReentry(text, opts({ run: '', task: 1, sha: SHA })),
    ABSENT,
  );
  assert.deepEqual(
    selectReentry(text, opts({ run: RUN, task: 1, sha: '' })),
    ABSENT,
  );
  assert.deepEqual(selectReentry(text, opts('x')), ABSENT);
});

test('run+task+sha: blank + malformed lines are skipped, not fatal', () => {
  const good = buildTaskReviewEvent({
    run: RUN,
    task: TASK,
    sha: SHA,
    count: 1,
    digest: 'ok',
  });
  const text =
    '\n' +
    'not json at all\n' +
    JSON.stringify(good) +
    '\n\n';
  assert.deepEqual(
    selectReentry(text, {
      kind: 'run+task+sha',
      key: { run: RUN, task: TASK, sha: SHA },
    }),
    {
      present: true,
      status: 'done',
      digest: 'ok',
      count: 1,
      base: null,
    },
  );
});

test('buildTaskReviewEvent: validates inputs and omits ts/note unless provided', () => {
  assert.throws(
    () => buildTaskReviewEvent({ run: '', task: TASK, sha: SHA }),
    /reentry-guard/,
  );
  assert.throws(
    () => buildTaskReviewEvent({ run: RUN, task: TASK, sha: '' }),
    /reentry-guard/,
  );
  assert.throws(
    () => buildTaskReviewEvent({ run: RUN, task: null, sha: SHA }),
    /reentry-guard/,
  );
  assert.throws(
    () => buildTaskReviewEvent({ run: RUN, task: '', sha: SHA }),
    /reentry-guard/,
  );
  assert.throws(
    () =>
      buildTaskReviewEvent({
        run: RUN,
        task: TASK,
        sha: SHA,
        status: 'inconclusive',
      }),
    /reentry-guard/,
  );
  const ev = buildTaskReviewEvent({ run: RUN, task: TASK, sha: SHA });
  assert.equal('ts' in ev, false);
  assert.equal('note' in ev, false);
  assert.equal(ev.data.count, null);
  assert.equal(ev.data.base, null);
  assert.ok(typeof ev.summary === 'string' && ev.summary.length > 0);
});

// ── legacy inventory (PLAN-REVIEW FIX R2/R3) ──

// PLAN-REVIEW FIX R2/R3 — legacy per-task inventory EMPTY-PROOF (run 2026-07-15).
// Commands run against the live tree and live bundles, and their results:
//   (1) grep -rhoE "type: *['\"][a-z_]+['\"]" lib/ bin/ workflows/ | sort -u
//       → adversary_review, adversary_review_defensively_armed, adversary_review_skipped,
//         branch_finish, dispatch_degraded, dispatch_inline_designed, goal_amended, goal_check,
//         goals_capture_bypassed, goals_frozen, goal_waived, plan_amended, refs_added,
//         refs_removed, task_blocked_under_active_run, task_waived, text, wave_recorded
//         — NO per-task review event type is written anywhere in the repo.
//   (2) scan of all 10 live bundles under /srv/dev/ai/agent-dispatch/docs/masterplan/*/events.jsonl:
//       events whose type contains 'review' AND whose data carries any of {run, task, task_id, run_id}
//       → 0 matches. Review-family types actually present: spec_adversary_review ×8,
//         plan_adversary_review ×8, adversary_review ×4, adversary_review_skipped ×3,
//         spec_adversary_review_skipped ×2, plan_adversary_review_skipped ×2,
//         plan_delta_adversary_review ×2, plan_review_revision ×4, catchup_review_planned ×1,
//         catchup_review_disposition ×1 — none keyed per task.
//   (3) the per-task review path (workflows/dispatch-wave Stage 2 review()) returns
//       review:{verdict,findings} IN-MEMORY inside the wave digest; it writes NO durable event.
// Therefore run+task+sha is genuinely NEW vocabulary — there is no legacy per-task shape to
// dual-read. The fixtures below are VERBATIM (sanitized) lines from live bundles proving the
// old vocabulary (a) never spuriously satisfies per-task re-entry and (b) still satisfies the
// artifact-hash and head-sha kinds through this unified guard with NO events.jsonl migration.
test('legacy per-task inventory (2026-07-15) is EMPTY — old-bundle vocabulary neither satisfies nor breaks run+task+sha re-entry; existing kinds still read the same lines', () => {
  const LEGACY_LINES = [
    '{"type":"adversary_review","ts":"2026-06-27T21:44:27.931Z","summary":"adversary review complete (whole-branch, base unknown) — 0 findings","data":{"sha":"3a9ea4c613bb94a457bc94f8d49e565cf325134a","base":null,"count":0}}',
    '{"type":"adversary_review_skipped","ts":"2026-07-06T06:37:22.203Z","summary":"whole-branch adversary-review skipped (degraded) — unspecified","data":{"sha":"070ca52cd98c178267989f3f60884fc6db0a04d2"}}',
    '{"type":"spec_adversary_review","ts":"2026-07-01T20:56:17.001Z","data":{"hash":"sha256:2413ffcfb0e443e62d027599a9876b24e86f24f4e5b7d0c06c774009a4df453c","count":23,"base":""},"note":"<sanitized digest>","summary":"spec adversary review complete — 23 findings"}',
    '{"type":"wave_recorded","ts":"2026-07-01T22:05:20.729Z","phase":"execute","note":"wave 0 record: 0 done, 4 failed/blocked, 0 qctl"}',
    '{"type":"dispatch_degraded","ts":"2026-07-15T22:29:09.734Z","phase":"execute","task_id":3,"outcome":"escalate","reason":"<sanitized>","decision_id":null,"note":"task 3 dispatch escalate: <sanitized>"}',
  ];
  const legacyText = LEGACY_LINES.join('\n') + '\n';

  assert.deepEqual(
    selectReentry(legacyText, {
      kind: 'run+task+sha',
      key: {
        run: 'simplify-dedup-2',
        task: 3,
        sha: '3a9ea4c613bb94a457bc94f8d49e565cf325134a',
      },
    }),
    ABSENT,
  );
  assert.deepEqual(
    selectReentry(legacyText, {
      kind: 'run+task+sha',
      key: {
        run: 'wave-0',
        task: '3',
        sha: '070ca52cd98c178267989f3f60884fc6db0a04d2',
      },
    }),
    ABSENT,
  );

  assert.deepEqual(
    selectReentry(legacyText, {
      kind: 'head-sha',
      key: '3a9ea4c613bb94a457bc94f8d49e565cf325134a',
    }),
    {
      present: true,
      status: 'done',
      digest: null,
      count: 0,
      base: null,
    },
  );
  assert.deepEqual(
    selectReentry(legacyText, {
      kind: 'head-sha',
      key: '070ca52cd98c178267989f3f60884fc6db0a04d2',
    }),
    ABSENT,
  );

  assert.deepEqual(
    selectReentry(legacyText, {
      kind: 'artifact-hash',
      gate: 'spec',
      key: 'sha256:2413ffcfb0e443e62d027599a9876b24e86f24f4e5b7d0c06c774009a4df453c',
    }),
    {
      present: true,
      status: 'done',
      digest: '<sanitized digest>',
      count: 23,
      base: '',
    },
  );

  const withNew =
    legacyText +
    JSON.stringify(
      buildTaskReviewEvent({
        run: 'simplify-dedup-2',
        task: 3,
        sha: '3a9ea4c613bb94a457bc94f8d49e565cf325134a',
        count: 0,
        digest: 'no findings',
      }),
    ) +
    '\n';
  assert.deepEqual(
    selectReentry(withNew, {
      kind: 'run+task+sha',
      key: {
        run: 'simplify-dedup-2',
        task: 3,
        sha: '3a9ea4c613bb94a457bc94f8d49e565cf325134a',
      },
    }),
    {
      present: true,
      status: 'done',
      digest: 'no findings',
      count: 0,
      base: null,
    },
  );
});

// ── misc ──

test('unknown kind throws even on empty text (caller bug, not data)', () => {
  assert.throws(
    () => selectReentry('', { kind: 'bogus', key: 'x' }),
    /unknown kind/,
  );
  assert.throws(() => reentryEventTypes('bogus'), /unknown kind/);
  assert.deepEqual(KINDS, ['artifact-hash', 'head-sha', 'run+task+sha']);
});

test('reentryEventTypes: exact type families and skip polarity per kind', () => {
  assert.deepEqual(reentryEventTypes('artifact-hash', 'spec'), {
    done: ['spec_adversary_review'],
    skipped: ['spec_adversary_review_skipped'],
    skipSatisfies: true,
  });
  assert.deepEqual(reentryEventTypes('artifact-hash', 'plan'), {
    done: ['plan_adversary_review'],
    skipped: ['plan_adversary_review_skipped'],
    skipSatisfies: true,
  });
  assert.deepEqual(reentryEventTypes('head-sha'), {
    done: ['codex_review', 'adversary_review'],
    skipped: ['codex_review_skipped', 'adversary_review_skipped'],
    skipSatisfies: false,
  });
  assert.deepEqual(reentryEventTypes('run+task+sha'), {
    done: ['task_adversary_review'],
    skipped: ['task_adversary_review_skipped'],
    skipSatisfies: false,
  });
});
