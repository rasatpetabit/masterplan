# Centralized Wave Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove masterplan’s duplicate review engine and route every enabled wave-task review through agent-dispatch’s canonical `dispatch_review` interface while preserving payload-bound re-entry, structured blockers, D6 independence, and native/MCP execution parity.

**Architecture:** A new `lib/task-review.mjs` module owns only masterplan lifecycle concerns: projecting the canonical agent-dispatch record, deciding whether it blocks wave continuation, binding it to `{run, task, payload_sha}`, and persisting task-review events. Agent-dispatch remains the sole owner of chunking, retries, reviewer execution, reconciliation, and findings extraction. Both MCP-pool and native-result paths prepare full edit-locus payloads and call the same task-review module before `recordWaveResult`.

**Tech Stack:** Node.js ESM, `node:test`, filesystem-backed `events.jsonl`, MCP over the existing `agent-dispatch serve-mcp` client, local Git via existing `-C`-qualified helpers.

## Global Constraints

- Do not modify `/srv/dev/ai/agent-dispatch`; consume its current `dispatch_review` contract.
- Do not modify or stage the user-owned `AGENTS.md` or `WORKLOG.md` changes.
- Review remains config-gated by `state.review.adversary` with the legacy `state.codex.review` fallback.
- Review granularity is one explicit centralized call per completed task.
- Each call receives the full edit-locus working diff, including tracked, untracked, and undeclared writes.
- Agent-dispatch is the only owner of review chunking, retries, reconciliation, extraction, and verdict semantics.
- A mandatory execution review that returns `rework`, `reject`, `error`, malformed output, or incomplete harness coverage must surface in `blocking_reviews[]`.
- D6 scope verification and cross-locus watch integrity remain independent and authoritative.
- Preserve event names and key identity: `task_adversary_review`, `task_adversary_review_skipped`, and `data.{run,task,sha,base,count}`.
- Preserve old bundle and stored-result compatibility during re-drive.
- Use test-driven development: every production change follows a witnessed failing test.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/task-review.mjs` | Masterplan-owned lifecycle module: canonical projection, fail-closed blocker decision, payload-bound re-entry, event persistence, and centralized review calls. No review-engine logic. |
| `test/task-review.test.mjs` | Focused tests for projection, malformed/incomplete records, durable events, re-entry, and call arguments. |
| `lib/reentry-guard.mjs` | Extend the existing task-review event builder/reader to carry `data.review` while retaining legacy event compatibility. |
| `test/reentry-guard.test.mjs` | Round-trip tests for structured review data and legacy event behavior. |
| `lib/wave-commit.mjs` | Consume canonical review projections and construct structured `blocking_reviews[]`; retain legacy stored-result conversion. |
| `test/wave-commit.test.mjs` | Canonical approve/rework/reject/error/degraded blocker tests and legacy redrive compatibility. |
| `lib/dispatch-wave.mjs` | Keep full working-diff capture; invoke `dispatch_review` via the existing broker client; delete duplicate review-engine implementation. |
| `test/dispatch-wave.test.mjs` | MCP-pool orchestration tests only; remove tests for agent-dispatch-owned algorithms. |
| `bin/masterplan.mjs` | Make native `record-result` ingestion await centralized task review before the durable wave transaction. |
| `test/dispatch-wave.native.test.mjs` | Native review-context persistence and native/MCP review parity tests. |
| `docs/internals/wave-dispatch.md` | Describe review ownership and both execution paths. |
| `docs/internals/task-verification.md` | Document canonical verdicts, blockers, and D6 independence. |
| `docs/conventions/adversarial-review-failure-policy.md` | Point to agent-dispatch policy; replace stale fail-soft and duplicated engine rules. |
| `commands/masterplan.md` | Update the wave completion and native result-ingestion protocol. |
| `CHANGELOG.md` | Record ownership migration and fail-closed behavior. |

---

### Task 1: Canonical Task-Review Projection and Blocking Decision

**Files:**
- Create: `lib/task-review.mjs`
- Create: `test/task-review.test.mjs`

**Interfaces:**
- Produces: `projectReviewRecord(record: unknown): TaskReview`
- Produces: `taskReviewBlocksWave(review: TaskReview): boolean`
- Produces: `reviewCompletedTasks(options): Promise<Array<ReviewItem>>`
- `TaskReview` exact shape:

```js
{
  verdict: 'approve' | 'rework' | 'reject' | 'error',
  findings: Array<{ file: string|null, line: number|null, summary: string, severity: string }>,
  blocking_findings: Array<{ reviewer?: string, summary: string, proof?: string }>,
  summary: string,
  harness: {
    degraded: boolean,
    timed_out: boolean,
    stalled: boolean,
    deadline_exceeded: boolean,
    regions_unreviewed: number,
    extraction_degraded: boolean,
  },
}
```

- `ReviewItem` input/output shape:

```js
{
  task_id: string|number,
  digest: object,
  review_input: {
    repo: string,
    diff: string,
    sha: string,
    description: string,
    class: string,
  },
  review?: TaskReview,
}
```

- `reviewCompletedTasks({statePath, runId, wave, baseSha, items, callReview, now})` calls `callReview(args)` only for `digest.status === 'done'`; later tasks add event reuse and persistence.

- [ ] **Step 1: Write failing projection and blocker tests**

Create `test/task-review.test.mjs`:

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  projectReviewRecord,
  taskReviewBlocksWave,
} from '../lib/task-review.mjs';

const healthy = {
  degraded: false,
  timed_out: false,
  stalled: false,
  deadline_exceeded: false,
  regions_unreviewed: 0,
  extraction_degraded: false,
};

const record = (final_verdict, extra = {}) => ({
  final_verdict,
  findings: [{ file: 'src/a.mjs', line: 7, summary: 'finding', severity: 'major' }],
  blocking_findings: [],
  summary: `${final_verdict} summary`,
  harness: { ...healthy },
  ...extra,
});

describe('projectReviewRecord', () => {
  it('preserves the canonical structured record', () => {
    assert.deepEqual(projectReviewRecord(record('approve')), {
      verdict: 'approve',
      findings: [{ file: 'src/a.mjs', line: 7, summary: 'finding', severity: 'major' }],
      blocking_findings: [],
      summary: 'approve summary',
      harness: healthy,
    });
  });

  it('projects malformed records to fail-closed error', () => {
    const review = projectReviewRecord({ final_verdict: 'approve', findings: 'not-an-array' });
    assert.equal(review.verdict, 'error');
    assert.match(review.summary, /malformed review record/i);
  });
});

describe('taskReviewBlocksWave', () => {
  it('allows only a healthy approve', () => {
    assert.equal(taskReviewBlocksWave(projectReviewRecord(record('approve'))), false);
  });

  for (const verdict of ['rework', 'reject', 'error']) {
    it(`blocks ${verdict}`, () => {
      assert.equal(taskReviewBlocksWave(projectReviewRecord(record(verdict))), true);
    });
  }

  for (const [field, value] of [
    ['degraded', true],
    ['timed_out', true],
    ['stalled', true],
    ['deadline_exceeded', true],
    ['regions_unreviewed', 1],
    ['extraction_degraded', true],
  ]) {
    it(`blocks approve with harness.${field}`, () => {
      const review = projectReviewRecord(record('approve', {
        harness: { ...healthy, [field]: value },
      }));
      assert.equal(taskReviewBlocksWave(review), true);
    });
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/task-review.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/task-review.mjs`.

- [ ] **Step 3: Implement the minimal canonical projection**

Create `lib/task-review.mjs` with no Git, child-process, chunking, retry, or verdict-merging code:

```js
const VERDICTS = new Set(['approve', 'rework', 'reject', 'error']);

const emptyHarness = () => ({
  degraded: true,
  timed_out: false,
  stalled: false,
  deadline_exceeded: false,
  regions_unreviewed: 1,
  extraction_degraded: false,
});

const malformed = (reason) => ({
  verdict: 'error',
  findings: [],
  blocking_findings: [{ summary: reason }],
  summary: `malformed review record: ${reason}`,
  harness: emptyHarness(),
});

export function projectReviewRecord(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return malformed('record must be an object');
  }
  if (!VERDICTS.has(record.final_verdict)) return malformed('invalid final_verdict');
  if (!Array.isArray(record.findings)) return malformed('findings must be an array');
  if (!Array.isArray(record.blocking_findings)) return malformed('blocking_findings must be an array');
  if (record.harness == null || typeof record.harness !== 'object' || Array.isArray(record.harness)) {
    return malformed('harness must be an object');
  }
  return {
    verdict: record.final_verdict,
    findings: record.findings.map((f) => ({
      file: typeof f?.file === 'string' ? f.file : null,
      line: Number.isFinite(f?.line) ? f.line : null,
      summary: String(f?.summary ?? ''),
      severity: String(f?.severity ?? 'info'),
    })),
    blocking_findings: record.blocking_findings.map((f) => ({
      ...(typeof f?.reviewer === 'string' ? { reviewer: f.reviewer } : {}),
      summary: String(f?.summary ?? ''),
      ...(typeof f?.proof === 'string' ? { proof: f.proof } : {}),
    })),
    summary: String(record.summary ?? ''),
    harness: {
      degraded: record.harness.degraded === true,
      timed_out: record.harness.timed_out === true,
      stalled: record.harness.stalled === true,
      deadline_exceeded: record.harness.deadline_exceeded === true,
      regions_unreviewed: Number.isFinite(record.harness.regions_unreviewed)
        ? record.harness.regions_unreviewed : 0,
      extraction_degraded: record.harness.extraction_degraded === true,
    },
  };
}

export function taskReviewBlocksWave(review) {
  if (review?.verdict !== 'approve') return true;
  const h = review.harness ?? emptyHarness();
  return h.degraded || h.timed_out || h.stalled || h.deadline_exceeded
    || h.regions_unreviewed > 0 || h.extraction_degraded;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test test/task-review.test.mjs
```

Expected: PASS; no warnings or skipped tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add lib/task-review.mjs test/task-review.test.mjs
git commit -m "feat(review): add canonical task review projection"
```

---

### Task 2: Structured Durable Events and Payload-Bound Re-entry

**Files:**
- Modify: `lib/task-review.mjs`
- Modify: `lib/reentry-guard.mjs:146-207`
- Modify: `test/task-review.test.mjs`
- Modify: `test/reentry-guard.test.mjs`

**Interfaces:**
- Consumes: `projectReviewRecord` and `taskReviewBlocksWave` from Task 1.
- Extends: `buildTaskReviewEvent({... review?: TaskReview })` stores a deep JSON-safe value at `event.data.review`.
- Produces: `readTaskReviewEvent(eventsText, key): {present:boolean, review:TaskReview|null, legacy:boolean}` in `lib/task-review.mjs`.
- Completes: `reviewCompletedTasks({statePath, runId, wave, baseSha, items, callReview, now})`.
- `callReview` exact arguments:

```js
{
  class: 'adversary',
  mode: 'diff',
  intensity: 'standard',
  diff: item.review_input.diff,
  repo: item.review_input.repo,
  job_id: `${runId}-w${wave}-t${item.task_id}-${item.review_input.sha.slice(0, 12)}`,
}
```

- [ ] **Step 1: Write failing structured-event tests**

Append to `test/reentry-guard.test.mjs`:

```js
it('round-trips a structured canonical task review', () => {
  const review = {
    verdict: 'reject',
    findings: [],
    blocking_findings: [{ summary: 'unsafe write' }],
    summary: 'reject summary',
    harness: {
      degraded: false, timed_out: false, stalled: false,
      deadline_exceeded: false, regions_unreviewed: 0,
      extraction_degraded: false,
    },
  };
  const ev = buildTaskReviewEvent({
    run: 'run-1', task: 3, sha: 'abc', status: 'done',
    count: 1, base: 'base-sha', review,
  });
  assert.deepEqual(ev.data.review, review);
  const hit = selectReentry(`${JSON.stringify(ev)}\n`, {
    kind: 'run+task+sha', key: { run: 'run-1', task: 3, sha: 'abc' },
  });
  assert.equal(hit.present, true);
  assert.deepEqual(hit.review, review);
});
```

Update the expected object in existing `selectReentry` absent/hit tests to include `review: null`.

- [ ] **Step 2: Write failing lifecycle and re-entry tests**

Append to `test/task-review.test.mjs` using a temporary bundle directory and `events.jsonl`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewCompletedTasks } from '../lib/task-review.mjs';

const reviewInput = (sha = 'a'.repeat(64)) => ({
  repo: '/tmp/repo', diff: 'diff --git a/a b/a\n+change', sha,
  description: 'change a', class: 'masterplan-implementation',
});

it('calls centralized review once and persists a satisfying structured event', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-task-review-'));
  const statePath = path.join(dir, 'state.yml');
  fs.writeFileSync(statePath, 'schema_version: 9.0.0\n');
  const calls = [];
  const items = await reviewCompletedTasks({
    statePath, runId: 'run-1', wave: 2, baseSha: 'base', now: 1000,
    items: [{ task_id: 7, digest: { task_id: 7, status: 'done' }, review_input: reviewInput() }],
    callReview: async (args) => { calls.push(args); return record('approve'); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].job_id, `run-1-w2-t7-${'a'.repeat(12)}`);
  assert.equal(calls[0].diff, reviewInput().diff);
  assert.equal(calls[0].repo, '/tmp/repo');
  assert.equal(items[0].review.verdict, 'approve');
  assert.deepEqual(items[0].digest.review, items[0].review);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  assert.match(events, /"type":"task_adversary_review"/);
  assert.match(events, /"review":\{"verdict":"approve"/);
});

it('reuses a completed event for the same run task and payload sha', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-task-review-reuse-'));
  const statePath = path.join(dir, 'state.yml');
  fs.writeFileSync(statePath, 'schema_version: 9.0.0\n');
  const item = { task_id: 7, digest: { task_id: 7, status: 'done' }, review_input: reviewInput() };
  await reviewCompletedTasks({
    statePath, runId: 'run-1', wave: 2, baseSha: 'base', now: 1000,
    items: [item], callReview: async () => record('approve'),
  });
  const second = await reviewCompletedTasks({
    statePath, runId: 'run-1', wave: 2, baseSha: 'base', now: 1001,
    items: [item], callReview: async () => assert.fail('completed event must satisfy re-entry'),
  });
  assert.equal(second[0].review.verdict, 'approve');
});

it('does not persist a satisfying done event when the review call throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-task-review-fail-'));
  const statePath = path.join(dir, 'state.yml');
  fs.writeFileSync(statePath, 'schema_version: 9.0.0\n');
  const item = { task_id: 7, digest: { task_id: 7, status: 'done' }, review_input: reviewInput() };
  const first = await reviewCompletedTasks({
    statePath, runId: 'run-1', wave: 2, baseSha: 'base', now: 1000,
    items: [item], callReview: async () => { throw new Error('lane down'); },
  });
  assert.equal(first[0].review.verdict, 'error');
  assert.match(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), /task_adversary_review_skipped/);
  let calls = 0;
  await reviewCompletedTasks({
    statePath, runId: 'run-1', wave: 2, baseSha: 'base', now: 1001,
    items: [item], callReview: async () => { calls += 1; return record('approve'); },
  });
  assert.equal(calls, 1, 'skipped event never satisfies re-entry');
});

it('changed payload sha at the same base re-arms review', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-task-review-rearm-'));
  const statePath = path.join(dir, 'state.yml');
  fs.writeFileSync(statePath, 'schema_version: 9.0.0\n');
  const itemA = { task_id: 7, digest: { task_id: 7, status: 'done' }, review_input: reviewInput('a'.repeat(64)) };
  await reviewCompletedTasks({
    statePath, runId: 'run-1', wave: 2, baseSha: 'same-base', now: 1000,
    items: [itemA], callReview: async () => record('approve'),
  });
  let calls = 0;
  const itemB = { task_id: 7, digest: { task_id: 7, status: 'done' }, review_input: reviewInput('b'.repeat(64)) };
  await reviewCompletedTasks({
    statePath, runId: 'run-1', wave: 2, baseSha: 'same-base', now: 1001,
    items: [itemB], callReview: async () => { calls += 1; return record('approve'); },
  });
  assert.equal(calls, 1);
});
```

- [ ] **Step 3: Run both focused tests and verify RED**

Run:

```bash
node --test test/reentry-guard.test.mjs test/task-review.test.mjs
```

Expected failures:

- `buildTaskReviewEvent` drops `review`.
- `selectReentry` does not return `review`.
- `reviewCompletedTasks` is not exported.

- [ ] **Step 4: Extend the re-entry guard minimally**

In `lib/reentry-guard.mjs`:

```js
const ABSENT = Object.freeze({
  present: false, status: null, digest: null, count: null, base: null, review: null,
});
```

Add `review` to the selected result:

```js
review: hit.data?.review && typeof hit.data.review === 'object'
  ? structuredClone(hit.data.review)
  : null,
```

Extend `buildTaskReviewEvent` parameters and data:

```js
export function buildTaskReviewEvent({
  run, task, sha, status = 'done', count = null, base = null,
  digest = null, summary = null, ts = null, review = null,
} = {}) {
  // existing validation
  const data = {
    run,
    task,
    sha,
    count: Number.isFinite(count) ? count : null,
    base: typeof base === 'string' ? base : null,
    ...(review && typeof review === 'object' && !Array.isArray(review)
      ? { review: structuredClone(review) } : {}),
  };
  // existing event construction
}
```

- [ ] **Step 5: Implement event reuse and centralized calls**

In `lib/task-review.mjs`, import existing durable helpers:

```js
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent } from './bundle.mjs';
import { buildTaskReviewEvent, selectReentry } from './reentry-guard.mjs';
```

Implement:

```js
const legacyVerdict = (v) => ({
  clean: 'approve', advisory: 'rework', blocking: 'reject', inconclusive: 'error',
}[v] ?? 'error');

export function readTaskReviewEvent(eventsText, key) {
  const hit = selectReentry(eventsText, { kind: 'run+task+sha', key });
  if (!hit.present || hit.status !== 'done') return { present: false, review: null, legacy: false };
  if (hit.review) return { present: true, review: projectReviewRecord({
    final_verdict: hit.review.verdict,
    findings: hit.review.findings,
    blocking_findings: hit.review.blocking_findings,
    summary: hit.review.summary,
    harness: hit.review.harness,
  }), legacy: false };
  const match = /verdict:\s*(clean|advisory|blocking|inconclusive)/gi;
  let m;
  let last = null;
  while ((m = match.exec(String(hit.digest ?? ''))) !== null) last = m[1].toLowerCase();
  const verdict = legacyVerdict(last);
  return {
    present: true,
    legacy: true,
    review: projectReviewRecord({
      final_verdict: verdict,
      findings: [],
      blocking_findings: verdict === 'approve' ? [] : [{ summary: String(hit.digest ?? 'legacy review') }],
      summary: String(hit.digest ?? 'legacy task review'),
      harness: { degraded: verdict === 'error', timed_out: false, stalled: false,
        deadline_exceeded: false, regions_unreviewed: verdict === 'error' ? 1 : 0,
        extraction_degraded: false },
    }),
  };
}

export async function reviewCompletedTasks({
  statePath, runId, wave, baseSha, items, callReview, now = Date.now(),
} = {}) {
  const bundleDir = path.dirname(path.resolve(statePath));
  const eventsPath = path.join(bundleDir, 'events.jsonl');
  let eventsText = '';
  try { eventsText = fs.readFileSync(eventsPath, 'utf8'); } catch { /* no events yet */ }
  const output = [];
  for (const item of items ?? []) {
    if (item?.digest?.status !== 'done') { output.push(item); continue; }
    const input = item.review_input;
    const key = { run: runId, task: item.task_id, sha: input.sha };
    const prior = readTaskReviewEvent(eventsText, key);
    if (prior.present) {
      const next = { ...item, review: prior.review,
        digest: { ...item.digest, review: prior.review } };
      output.push(next);
      continue;
    }
    let review;
    let status = 'done';
    try {
      review = projectReviewRecord(await callReview({
        class: 'adversary', mode: 'diff', intensity: 'standard',
        diff: input.diff, repo: input.repo,
        job_id: `${runId}-w${wave}-t${item.task_id}-${input.sha.slice(0, 12)}`,
      }));
      if (review.verdict === 'error' || taskReviewBlocksWave(review) && review.verdict === 'approve') {
        status = 'skipped';
      }
    } catch (err) {
      review = projectReviewRecord(null);
      review.summary = `review call failed: ${err?.message ?? err}`;
      review.blocking_findings = [{ summary: review.summary }];
      status = 'skipped';
    }
    const event = buildTaskReviewEvent({
      run: runId, task: item.task_id, sha: input.sha, status,
      count: review.findings.length, base: baseSha, review,
      digest: review.summary, ts: new Date(now).toISOString(),
    });
    appendEvent(statePath, event);
    eventsText += `${JSON.stringify(event)}\n`;
    output.push({ ...item, review, digest: { ...item.digest, review } });
  }
  return output;
}
```

Keep the exact policy: `rework` and `reject` are completed reviews and may satisfy re-entry; `error`, thrown calls, and incomplete coverage use the skipped event and never satisfy re-entry.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
node --test test/reentry-guard.test.mjs test/task-review.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add lib/task-review.mjs lib/reentry-guard.mjs test/task-review.test.mjs test/reentry-guard.test.mjs
git commit -m "feat(review): persist structured task review events"
```

---

### Task 3: Canonical Wave-Completion Consumption

**Files:**
- Modify: `lib/wave-commit.mjs:82-95,610-655,909-925`
- Modify: `test/wave-commit.test.mjs:68-110`

**Interfaces:**
- Consumes: `taskReviewBlocksWave(review)` from `lib/task-review.mjs`.
- Consumes: canonical review shape from `item.review` and `digest.review`.
- Produces: `blocking_reviews: Array<{id:string|number, verdict:string, findings:Array<object>}>`.
- Compatibility: legacy `{verdict:'clean'|'advisory'|'blocking'|'inconclusive', findings}` stored results are normalized locally only for re-drive; no new result writes use that vocabulary.

- [ ] **Step 1: Replace the old blocker fixture with failing canonical cases**

In `test/wave-commit.test.mjs`, update the early mixed-result test and add table-driven cases:

```js
const healthyHarness = {
  degraded: false, timed_out: false, stalled: false,
  deadline_exceeded: false, regions_unreviewed: 0,
  extraction_degraded: false,
};

const canonicalReview = (verdict, extra = {}) => ({
  verdict,
  findings: [{ file: 'src/a.txt', line: 1, summary: `${verdict} finding`, severity: 'major' }],
  blocking_findings: verdict === 'approve' ? [] : [{ summary: `${verdict} blocker` }],
  summary: `${verdict} summary`,
  harness: { ...healthyHarness },
  ...extra,
});

for (const verdict of ['rework', 'reject', 'error']) {
  test(`record-result surfaces canonical ${verdict} in blocking_reviews`, () => {
    const fx = makeFixture({ /* one done task, existing helper shape */ });
    write(fx.WT, 'src/a.txt', 'A\n');
    const review = canonicalReview(verdict);
    const res = recordWaveResult({
      statePath: fx.statePath, self: fx.self, now: 2000,
      result: { wave: 1, baseline: [], tasks: [{
        task_id: 1,
        review,
        digest: { ...digest(1, 'done').digest, review },
      }] },
    });
    assert.equal(res.blocking_reviews.length, 1);
    assert.equal(res.blocking_reviews[0].id, 1);
    assert.equal(res.blocking_reviews[0].verdict, verdict);
    assert.ok(Array.isArray(res.blocking_reviews[0].findings));
  });
}

test('record-result blocks a degraded approve', () => {
  const fx = makeFixture({ tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }] });
  write(fx.WT, 'src/a.txt', 'A\n');
  const review = canonicalReview('approve', { harness: { ...healthyHarness, degraded: true } });
  const res = recordWaveResult({
    statePath: fx.statePath, self: fx.self, now: 2000,
    result: { wave: 1, baseline: [], tasks: [{
      task_id: 1, review, digest: { ...digest(1, 'done').digest, review },
    }] },
  });
  assert.equal(res.blocking_reviews[0].verdict, 'error');
});

test('record-result accepts a healthy canonical approve', () => {
  const fx = makeFixture({ tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }] });
  write(fx.WT, 'src/a.txt', 'A\n');
  const review = canonicalReview('approve');
  const res = recordWaveResult({
    statePath: fx.statePath, self: fx.self, now: 2000,
    result: { wave: 1, baseline: [], tasks: [{
      task_id: 1, review, digest: { ...digest(1, 'done').digest, review },
    }] },
  });
  assert.deepEqual(res.blocking_reviews, []);
});

test('record-result preserves legacy blocking review on redrive', () => {
  const fx = makeFixture({ tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }] });
  write(fx.WT, 'src/a.txt', 'A\n');
  const review = { verdict: 'blocking', findings: 'legacy blocker' };
  const res = recordWaveResult({
    statePath: fx.statePath, self: fx.self, now: 2000,
    result: { wave: 1, baseline: [], tasks: [{
      task_id: 1, review, digest: { ...digest(1, 'done').digest, review },
    }] },
  });
  assert.ok(Array.isArray(res.blocking_reviews[0].findings));
  assert.match(JSON.stringify(res.blocking_reviews[0].findings), /legacy blocker/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --test test/wave-commit.test.mjs
```

Expected: canonical `rework/reject/error` produce no blocker because current code recognizes only `blocking`; degraded approve also passes incorrectly.

- [ ] **Step 3: Implement canonical and legacy normalization**

At the top of `lib/wave-commit.mjs`:

```js
import { taskReviewBlocksWave } from './task-review.mjs';
```

Delete the duplicated `REVIEW_VERDICTS` set and `isVerdictShaped`. Add a narrow compatibility helper:

```js
function normalizeStoredReview(review) {
  if (review == null || typeof review !== 'object' || Array.isArray(review)) return null;
  if (['approve', 'rework', 'reject', 'error'].includes(review.verdict)) return review;
  const verdict = ({
    clean: 'approve', advisory: 'rework', blocking: 'reject', inconclusive: 'error',
  })[review.verdict];
  if (!verdict) return null;
  const findings = Array.isArray(review.findings)
    ? review.findings
    : review.findings == null ? [] : [{ summary: String(review.findings), severity: 'blocking' }];
  return {
    verdict,
    findings,
    blocking_findings: verdict === 'approve' ? [] : findings,
    summary: `legacy ${review.verdict} task review`,
    harness: {
      degraded: verdict === 'error', timed_out: false, stalled: false,
      deadline_exceeded: false, regions_unreviewed: verdict === 'error' ? 1 : 0,
      extraction_degraded: false,
    },
  };
}
```

Replace the old either-source blocking block with:

```js
const itemReview = normalizeStoredReview(item?.review);
const digestReview = normalizeStoredReview(digest?.review);
const reviews = [digestReview, itemReview].filter(Boolean);
const authoritative = digestReview ?? itemReview;
if (authoritative && taskReviewBlocksWave(authoritative)) {
  const verdict = authoritative.verdict === 'approve' ? 'error' : authoritative.verdict;
  const findings = [
    ...(authoritative.blocking_findings ?? []),
    ...(authoritative.findings ?? []),
  ];
  blocking_reviews.push({ id, verdict, findings });
}
```

Do not union contradictory duplicate sources. The digest projection is authoritative for new results; `item.review` is only the fallback for old/native payloads.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
node --test test/wave-commit.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run task-review and wave-commit tests together**

```bash
node --test test/task-review.test.mjs test/reentry-guard.test.mjs test/wave-commit.test.mjs
```

Expected: PASS; this proves the projection and transaction agree on the same shape.

- [ ] **Step 6: Commit Task 3**

```bash
git add lib/wave-commit.mjs test/wave-commit.test.mjs
git commit -m "feat(review): consume canonical reviews in wave completion"
```

---

### Task 4: Migrate MCP-Pool Review to `dispatch_review`

**Files:**
- Modify: `lib/dispatch-wave.mjs:88-117,535-849,850-895,1245-1470`
- Modify: `test/dispatch-wave.test.mjs:1-55,750-1475`

**Interfaces:**
- Consumes: `reviewCompletedTasks` from `lib/task-review.mjs`.
- Retains: `captureFullWorkingDiff(repo, _exec)` as masterplan’s payload-capture helper.
- Deletes exports: `segmentDiffPayload`, `mergeReviewVerdicts`, `mapAdversaryLaneVerdict`.
- Replaces injected seam `_reviewLane` with `_callReview`; production default uses the already initialized broker client.
- Production MCP call:

```js
client.callTool('dispatch_review', {
  class: 'adversary',
  mode: 'diff',
  intensity: 'standard',
  diff,
  repo,
  job_id,
});
```

- [ ] **Step 1: Rewrite review tests around caller-owned behavior**

Keep and adapt these behaviors in `test/dispatch-wave.test.mjs`:

1. Review ON sends one `dispatch_review` call per completed task.
2. The payload includes declared, undeclared, and untracked writes.
3. Review OFF sends no `dispatch_review` call and emits no review event.
4. Healthy approve creates no `blocking_reviews[]` entry.
5. Reject/rework/error and degraded approve create structured blockers.
6. Same payload reuses the completed event.
7. Changed payload at the same HEAD re-arms review.
8. Failed review writes a non-satisfying event and retries next attempt.
9. D6 still reverts undeclared writes after approve.
10. Multi-task waves retain task-specific calls/events.
11. The same injected broker client handles both `dispatch_task` and `dispatch_review` calls.

Use a broker stub that distinguishes tools:

```js
function brokerStub({ dispatchResult = routeResult, reviewResult = approveRecord } = {}) {
  const calls = [];
  return {
    calls,
    async initialize() {},
    async callTool(tool, args) {
      calls.push({ tool, args });
      if (tool === 'dispatch_task') return dispatchResult;
      if (tool === 'dispatch_review') return reviewResult;
      throw new Error(`unexpected tool ${tool}`);
    },
    close() {},
  };
}

const reviewCalls = (stub) => stub.calls.filter((c) => c.tool === 'dispatch_review');
```

Representative failing test:

```js
test('review ON delegates the full edit-locus diff to canonical dispatch_review', async () => {
  const fx = makeFixture({
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['src/a.txt'] }],
    planIndex: [planEntry(1, 1, ['src/a.txt'])],
    slug: 'dw-central-review',
    extra: { review: { adversary: true } },
  });
  const op = launchViaContinue(fx);
  write(op.cwd, 'src/a.txt', 'declared\n');
  write(op.cwd, 'src/oops.txt', 'undeclared\n');
  const stub = brokerStub();
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    _brokerClient: stub, _openCoord: disabledCoord,
  });
  const calls = reviewCalls(stub);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.class, 'adversary');
  assert.equal(calls[0].args.mode, 'diff');
  assert.equal(calls[0].args.intensity, 'standard');
  assert.match(calls[0].args.diff, /src\/a\.txt/);
  assert.match(calls[0].args.diff, /src\/oops\.txt/);
  assert.equal(res.tasks[0].review, 'approve');
});
```

- [ ] **Step 2: Delete tests for agent-dispatch-owned algorithms**

Remove tests whose subject is exclusively:

- segment byte limits and multibyte reconstruction;
- per-segment worst-wins merging;
- partial-segment failure;
- findings text truncation/capping;
- agent-dispatch lane-record-to-local-verdict mapping;
- free-text verdict spoof parsing.

Do not delete tests for payload SHA re-entry, structured event persistence, task attribution, D6 independence, or record redrive.

- [ ] **Step 3: Run the dispatch-wave test and verify RED**

```bash
node --test test/dispatch-wave.test.mjs
```

Expected: FAIL because production still invokes `_reviewLane`/CLI helpers and never calls `dispatch_review` through the stub.

- [ ] **Step 4: Delete duplicate review-engine implementation**

In `lib/dispatch-wave.mjs`:

- Remove `REVIEW_VERDICTS`, `REVIEW_DIFF_MAX_BYTES`, `splitOversizedChunk`, `segmentDiffPayload`, `VERDICT_SEVERITY`, `mergeReviewVerdicts`, findings rendering/capping helpers, `mapAdversaryLaneVerdict`, prose verdict extraction, stored structured verdict scanning, and `runAdversaryReviewLane`.
- Remove imports made dead by those deletions.
- Keep `createHash` and `captureFullWorkingDiff` for exact payload identity.
- Import `reviewCompletedTasks`.
- Remove `review` from work-item descriptors unless another test proves `dispatch_task` consumes it.

- [ ] **Step 5: Keep the broker alive through task review**

Refactor the broker block so writer dispatch, local verify, task review, result persistence, and record-result occur before the one outer `finally` closes the broker. Coord closure remains immediately paired with writer dispatch:

```js
const usingInjected = _brokerClient != null;
const client = usingInjected ? _brokerClient : createBrokerClient({ bin: brokerBin, env: { SKYNET_VERIFY_ALLOWLIST: effectiveAllowlist } });
try {
  if (!usingInjected) await client.initialize();
  digests = await dispatchDescriptors(client, descriptors, tasks);
  closeCoordHandles();
  applyLocalVerification(digests, descriptors, localVerifyCommands);

  if (reviewOn) {
    const diffCache = new Map();
    const reviewItems = digests.map((digest, i) => {
      const repo = descriptors[i]?.repo ?? WT;
      let payload = diffCache.get(repo);
      if (!payload) {
        const diff = captureFullWorkingDiff(repo);
        payload = { diff, sha: createHash('sha256').update(diff, 'utf8').digest('hex') };
        diffCache.set(repo, payload);
      }
      return {
        task_id: tasks[i].id,
        digest,
        review_input: {
          repo, diff: payload.diff, sha: payload.sha,
          description: tasks[i].description,
          class: tasks[i].class,
        },
      };
    });
    const reviewed = await reviewCompletedTasks({
      statePath: absState, runId, wave, baseSha: inputs.head,
      items: reviewItems,
      callReview: (args) => (_callReview ? _callReview(args) : client.callTool('dispatch_review', args)),
      now: now ?? Date.now(),
    });
    digests = reviewed.map((item) => item.digest);
  }

  // existing write dispatched result + recordWaveResult + finalize record
} finally {
  closeCoordHandles();
  if (!usingInjected) client.close();
}
```

Extract only private functions needed to prevent `dispatchWaveViaFabric` growing further. Do not introduce an exported adapter interface.

- [ ] **Step 6: Run dispatch-wave tests and verify GREEN**

```bash
node --test test/dispatch-wave.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Run focused integration tests**

```bash
node --test test/task-review.test.mjs test/reentry-guard.test.mjs test/wave-commit.test.mjs test/dispatch-wave.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add lib/dispatch-wave.mjs test/dispatch-wave.test.mjs
git commit -m "refactor(review): delegate wave reviews to agent-dispatch"
```

---

### Task 5: Native Result-Ingestion Parity

**Files:**
- Modify: `lib/dispatch-wave.mjs:242-320,1155-1235`
- Modify: `bin/masterplan.mjs:3155-3220`
- Modify: `test/dispatch-wave.native.test.mjs`
- Modify: `test/bin-masterplan.test.mjs` if CLI async behavior is covered there

**Interfaces:**
- Produces: persisted native review context in `wave-<N>.dispatch.json`:

```js
review_context: {
  enabled: boolean,
  tasks: [{ task_id, description, class, repo }],
  base_sha: string,
}
```

- Produces: `reviewNativeResult({statePath, result, brokerBin, _brokerClient, now}): Promise<object>` in `lib/dispatch-wave.mjs` or a private adjacent module if required to avoid a circular import.
- Consumes: `reviewCompletedTasks` from Task 2 and `captureFullWorkingDiff` from `lib/dispatch-wave.mjs`.
- CLI behavior: `record-result` awaits native review completion before calling `recordWaveResult`.

- [ ] **Step 1: Add failing native context-persistence test**

In `test/dispatch-wave.native.test.mjs`:

```js
test('native spawn record persists task review context for result ingestion', async () => {
  const fx = makeNativeFixture({ review: { adversary: true } });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000,
    nativeSpawn: true,
  });
  assert.equal(res.outcome, 'native-spawn-plan');
  const record = readWaveDispatchRecord(fx.bundleDir, 1);
  assert.equal(record.review_context.enabled, true);
  assert.equal(record.review_context.base_sha, git(res.plan.tasks[0].cwd, 'rev-parse', 'HEAD'));
  assert.deepEqual(record.review_context.tasks[0], {
    task_id: 1,
    description: 'task 1',
    class: 'masterplan-implementation',
    repo: res.plan.tasks[0].cwd,
  });
});
```

Use the file’s real fixture helper names and expected task description/class.

- [ ] **Step 2: Add failing native review parity test**

Add a test that:

1. Creates a native spawn plan with review enabled.
2. Writes a task edit into the persisted task repo.
3. Supplies a `done` native result.
4. Injects a broker stub whose `dispatch_review` returns canonical `reject`.
5. Calls `reviewNativeResult`.
6. Asserts the returned result has the same canonical `digest.review` shape used by the MCP-pool path.
7. Calls `recordWaveResult` and asserts `blocking_reviews[0].verdict === 'reject'`.

```js
test('native result uses the same centralized task review projection as MCP pool', async () => {
  const fx = makeNativeFixture({ review: { adversary: true } });
  await dispatchWaveViaFabric({
    statePath: fx.statePath, self: fx.self, now: 2000, nativeSpawn: true,
  });
  write(fx.WT, 'src/a.txt', 'native edit\n');
  const nativeResult = {
    wave: 1,
    tasks: [{ task_id: 1, digest: workerDigest(1, 'done') }],
  };
  const reviewed = await reviewNativeResult({
    statePath: fx.statePath,
    result: nativeResult,
    _brokerClient: brokerStub({ reviewResult: rejectRecord }),
    now: 3000,
  });
  assert.equal(reviewed.tasks[0].digest.review.verdict, 'reject');
  const recorded = recordWaveResult({
    statePath: fx.statePath, result: reviewed,
    self: fx.self, now: 3000, worktree: fx.WT,
  });
  assert.equal(recorded.blocking_reviews[0].verdict, 'reject');
});
```

- [ ] **Step 3: Add failing CLI ordering test**

In the appropriate bin test, invoke `record-result` against a native record and an injected/test broker executable. Assert the state transaction observes `digest.review`; a test implementation may expose `_reviewNativeResult` through a narrow main seam rather than performing a live review.

The assertion must prove ordering, not just that both functions ran:

```js
assert.equal(recordedResult.record.blocking_reviews[0].verdict, 'reject');
assert.equal(readState(statePath).tasks[0].status, 'done');
```

- [ ] **Step 4: Run native/bin tests and verify RED**

```bash
node --test test/dispatch-wave.native.test.mjs test/bin-masterplan.test.mjs
```

Expected failures: no `review_context`, no `reviewNativeResult`, and `record-result` calls `recordWaveResult` synchronously without review.

- [ ] **Step 5: Persist review context before returning the native plan**

When creating the pending wave-dispatch record, add:

```js
review_context: {
  enabled: reviewOn,
  base_sha: inputs.head,
  tasks: tasks.map((task, i) => ({
    task_id: task.id,
    description: task.description,
    class: task.class,
    repo: descriptors[i]?.repo ?? WT,
  })),
},
```

Old records lacking `review_context` remain valid. When absent, native ingestion leaves results unchanged and emits no fabricated review.

- [ ] **Step 6: Implement native review ingestion**

`reviewNativeResult` must:

1. Read the current wave record.
2. Return unchanged when review context is absent or disabled.
3. Match result tasks by string-coerced task id.
4. Capture/cache one full working diff per repo.
5. Build `review_input` objects and call `reviewCompletedTasks`.
6. Reuse an injected client or create/initialize/close one broker client.
7. Return a new result object; never mutate the caller’s object.

Minimal structure:

```js
export async function reviewNativeResult({
  statePath, result, brokerBin, _brokerClient = null, now = Date.now(),
} = {}) {
  const state = readState(statePath);
  const wave = result?.wave ?? state.active_run?.wave;
  const record = readWaveDispatchRecord(path.dirname(path.resolve(statePath)), wave);
  const ctx = record?.review_context;
  if (!ctx?.enabled) return result;
  const usingInjected = _brokerClient != null;
  const client = usingInjected ? _brokerClient : createBrokerClient({ bin: brokerBin });
  try {
    if (!usingInjected) await client.initialize();
    const diffCache = new Map();
    const items = (result.tasks ?? []).map((item) => {
      const task = ctx.tasks.find((t) => String(t.task_id) === String(item.task_id ?? item.digest?.task_id));
      if (!task) return item;
      let payload = diffCache.get(task.repo);
      if (!payload) {
        const diff = captureFullWorkingDiff(task.repo);
        payload = { diff, sha: createHash('sha256').update(diff, 'utf8').digest('hex') };
        diffCache.set(task.repo, payload);
      }
      return { ...item, task_id: task.task_id, review_input: { ...task, ...payload } };
    });
    const reviewed = await reviewCompletedTasks({
      statePath, runId: String(state.slug), wave, baseSha: ctx.base_sha,
      items, callReview: (args) => client.callTool('dispatch_review', args), now,
    });
    return { ...result, tasks: reviewed.map(({ review_input, ...item }) => item) };
  } finally {
    if (!usingInjected) client.close();
  }
}
```

- [ ] **Step 7: Make `record-result` await native review first**

Convert only the `record-result` case to promise chaining or make `main` async consistently. Preserve existing synchronous error formatting:

```js
reviewNativeResult({
  statePath,
  result,
  brokerBin: typeof flags['broker-bin'] === 'string' ? flags['broker-bin'] : undefined,
  now,
})
  .then((reviewedResult) => recordWaveResult({
    statePath,
    result: reviewedResult,
    self,
    now,
    worktree: typeof flags.worktree === 'string' ? flags.worktree : undefined,
  }))
  .then(out)
  .catch((e) => die(e.message));
```

For `--reconcile` (`result === null`), skip `reviewNativeResult` and retain the existing synchronous transaction.

- [ ] **Step 8: Run native/bin tests and verify GREEN**

```bash
node --test test/dispatch-wave.native.test.mjs test/bin-masterplan.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Run all focused review tests**

```bash
node --test \
  test/task-review.test.mjs \
  test/reentry-guard.test.mjs \
  test/wave-commit.test.mjs \
  test/dispatch-wave.test.mjs \
  test/dispatch-wave.native.test.mjs \
  test/bin-masterplan.test.mjs
```

Expected: PASS.

- [ ] **Step 10: Commit Task 5**

```bash
git add lib/dispatch-wave.mjs bin/masterplan.mjs test/dispatch-wave.native.test.mjs test/bin-masterplan.test.mjs
git commit -m "feat(review): add native wave review parity"
```

---

### Task 6: Documentation, Cleanup, and Full Verification

**Files:**
- Modify: `docs/internals/wave-dispatch.md`
- Modify: `docs/internals/task-verification.md`
- Modify: `docs/conventions/adversarial-review-failure-policy.md`
- Modify: `commands/masterplan.md`
- Modify: `CHANGELOG.md`
- Verify: `lib/dispatch-wave.mjs`, `lib/wave-commit.mjs`, tests

**Interfaces:**
- Documents: `dispatch_review` is the sole review engine interface.
- Documents: `blocking_reviews[]` is the same-turn fail-closed wave gate.
- Removes: masterplan-owned chunk sizes, retries, roster assumptions, local verdict vocabulary, and fail-soft execution-review language.

- [ ] **Step 1: Add a failing stale-language guard**

Add a focused test to the repository’s documentation/prompt structure test file:

```js
test('wave review docs point to agent-dispatch and contain no local review-engine contract', () => {
  const files = [
    'docs/internals/wave-dispatch.md',
    'docs/internals/task-verification.md',
    'docs/conventions/adversarial-review-failure-policy.md',
    'commands/masterplan.md',
  ];
  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.match(text, /dispatch_review/);
  assert.doesNotMatch(text, /REVIEW_DIFF_MAX_BYTES|segmentDiffPayload|reviewer count is 1 \(not a panel\)/);
  assert.doesNotMatch(text, /review unavailable .* proceed with a logged caveat/i);
});
```

Place it in `test/prompt-structure.test.mjs` or the existing documentation-contract test that already reads these files.

- [ ] **Step 2: Run the documentation-contract test and verify RED**

```bash
node --test test/prompt-structure.test.mjs
```

Expected: FAIL on stale fail-soft or duplicated review-engine text.

- [ ] **Step 3: Update documentation**

Make these exact content changes:

- `docs/internals/wave-dispatch.md`
  - Replace local review mapping/chunking description with: capture full edit-locus diff, hash it, call `dispatch_review`, persist canonical projection.
  - Explain MCP-pool client reuse and native result-ingestion parity.
- `docs/internals/task-verification.md`
  - Replace `clean/advisory/blocking/inconclusive` with `approve/rework/reject/error`.
  - State that `rework`, `reject`, `error`, and incomplete harness coverage populate `blocking_reviews[]`.
  - Reaffirm D6 independence.
- `docs/conventions/adversarial-review-failure-policy.md`
  - Remove stale fail-soft execution-review behavior.
  - Point review engine behavior to `/srv/dev/ai/agent-dispatch/docs/policy/dispatch.md` and `references/review-findings.schema.json` without copying their rules.
  - State that mandatory execution-review failure blocks the wave gate.
- `commands/masterplan.md`
  - Update `dispatch_fabric` and `record-result` rows for centralized review and native ingestion.
  - Retain the existing AUQ handling for non-empty `blocking_reviews[]`.
- `CHANGELOG.md`
  - Add an unreleased entry naming the ownership move, deleted duplicate implementation, canonical structured record, and fail-closed native/MCP parity.

- [ ] **Step 4: Run documentation and focused tests**

```bash
node --test test/prompt-structure.test.mjs
node --test test/task-review.test.mjs
node --test test/wave-commit.test.mjs
node --test test/dispatch-wave.test.mjs test/dispatch-wave.native.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run stale-symbol and duplicate-policy scans**

```bash
! rg -n 'segmentDiffPayload|mergeReviewVerdicts|mapAdversaryLaneVerdict|REVIEW_DIFF_MAX_BYTES' lib test
! rg -n 'clean.*advisory.*blocking.*inconclusive|reviewer count is 1 \(not a panel\)' \
  docs/internals docs/conventions commands/masterplan.md
rg -n 'dispatch_review' lib/task-review.mjs lib/dispatch-wave.mjs docs/internals/wave-dispatch.md
```

Expected:

- Both negated scans exit 0 with no matches.
- The positive scan finds centralized review references in code and docs.

- [ ] **Step 6: Run the full repository suite**

```bash
npm test
```

Expected: exit 0; all tests pass.

- [ ] **Step 7: Run repository doctor**

```bash
npm run doctor
```

Expected: exit 0 with no FATAL findings.

- [ ] **Step 8: Inspect the final diff and protected files**

```bash
git diff --stat HEAD~5..HEAD
git status --short
git diff -- AGENTS.md WORKLOG.md
```

Expected:

- Diff is limited to the plan’s production, test, and documentation files.
- `AGENTS.md` and `WORKLOG.md` remain user-owned and unstaged.
- No generated or temporary files are present.

- [ ] **Step 9: Commit Task 6**

```bash
git add \
  docs/internals/wave-dispatch.md \
  docs/internals/task-verification.md \
  docs/conventions/adversarial-review-failure-policy.md \
  commands/masterplan.md \
  CHANGELOG.md \
  test/prompt-structure.test.mjs
git commit -m "docs(review): document centralized wave review"
```

---

## Final Acceptance Check

Before declaring implementation complete, verify every criterion from `docs/design/centralized-wave-review.md`:

- [ ] No masterplan code implements review chunking, retries, reconciliation, findings extraction, or verdict semantics.
- [ ] Enabled review makes one explicit centralized call per completed task.
- [ ] The call uses the exact full edit-locus diff.
- [ ] Durable identity is SHA-256 of the exact review payload plus run and task.
- [ ] New events persist canonical structured findings and harness metadata.
- [ ] New code never parses prose to determine canonical verdicts.
- [ ] Legacy events/results still re-drive conservatively.
- [ ] `rework`, `reject`, `error`, malformed records, and incomplete harness coverage populate `blocking_reviews[]`.
- [ ] Failed reviews never satisfy re-entry.
- [ ] D6 independently reverts undeclared writes after review approval.
- [ ] MCP-pool and native paths produce identical review projections and blockers.
- [ ] One broker process serves the MCP-pool writer and review calls for a wave.
- [ ] Agent-dispatch repository is unchanged.
- [ ] User-owned `AGENTS.md` and `WORKLOG.md` are untouched and unstaged.
- [ ] Focused tests, `npm test`, and `npm run doctor` exit 0.
