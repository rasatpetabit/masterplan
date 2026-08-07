import fs from 'node:fs';
import path from 'node:path';
import { appendEvent } from './bundle.mjs';
import { buildTaskReviewEvent, selectReentry } from './reentry-guard.mjs';

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

const legacyVerdict = (v) => ({
  clean: 'approve', advisory: 'rework', blocking: 'reject', inconclusive: 'error',
}[v] ?? 'error');

export function readTaskReviewEvent(eventsText, key) {
  const hit = selectReentry(eventsText, { kind: 'run+task+sha', key });
  if (!hit.present || hit.status !== 'done') return { present: false, review: null, legacy: false };
  if (hit.review) {
    return {
      present: true,
      review: projectReviewRecord({
        final_verdict: hit.review.verdict,
        findings: hit.review.findings,
        blocking_findings: hit.review.blocking_findings,
        summary: hit.review.summary,
        harness: hit.review.harness,
      }),
      legacy: false,
    };
  }
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
      harness: {
        degraded: verdict === 'error',
        timed_out: false,
        stalled: false,
        deadline_exceeded: false,
        regions_unreviewed: verdict === 'error' ? 1 : 0,
        extraction_degraded: false,
      },
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
      const next = {
        ...item,
        review: prior.review,
        digest: { ...item.digest, review: prior.review },
      };
      output.push(next);
      continue;
    }
    let review;
    let status = 'done';
    try {
      review = projectReviewRecord(await callReview({
        class: 'adversary',
        mode: 'diff',
        intensity: 'standard',
        diff: input.diff,
        repo: input.repo,
        job_id: `${runId}-w${wave}-t${item.task_id}-${input.sha.slice(0, 12)}`,
      }));
      // rework/reject are completed reviews and may satisfy re-entry;
      // error and incomplete approve coverage use skipped and never satisfy re-entry.
      if (review.verdict === 'error' || (taskReviewBlocksWave(review) && review.verdict === 'approve')) {
        status = 'skipped';
      }
    } catch (err) {
      review = projectReviewRecord(null);
      review.summary = `review call failed: ${err?.message ?? err}`;
      review.blocking_findings = [{ summary: review.summary }];
      status = 'skipped';
    }
    const event = buildTaskReviewEvent({
      run: runId,
      task: item.task_id,
      sha: input.sha,
      status,
      count: review.findings.length,
      base: baseSha,
      review,
      digest: review.summary,
      ts: new Date(now).toISOString(),
    });
    appendEvent(statePath, event);
    eventsText += `${JSON.stringify(event)}\n`;
    output.push({ ...item, review, digest: { ...item.digest, review } });
  }
  return output;
}
