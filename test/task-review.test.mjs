import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  projectReviewRecord,
  reviewCompletedTasks,
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

const reviewInput = (sha = 'a'.repeat(64)) => ({
  repo: '/tmp/repo', diff: 'diff --git a/a b/a\n+change', sha,
  description: 'change a', class: 'masterplan-implementation',
});

describe('reviewCompletedTasks', () => {
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
});
