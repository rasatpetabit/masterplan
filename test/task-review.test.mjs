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
