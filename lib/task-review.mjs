import fs from 'node:fs';
import path from 'node:path';
import { appendEvent } from './bundle.mjs';
import { buildTaskReviewEvent, selectReentry } from './reentry-guard.mjs';
import {
  buildIntentIdentity,
  resolveReviewerIdentity,
} from './checkpoint-evidence.mjs';

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
  // The reviewer identity rides the projection verbatim in shape (never adopted
  // unvalidated — resolveReviewerIdentity owns the strict read). Task 56: a review
  // record can carry the lane provenance that names WHICH reviewer produced it; the
  // projection keeps it so the event is identity-bound end to end.
  const reviewerSource = record.reviewer_identity ?? record.provenance ?? record.reviewer;
  const reviewer = reviewerSource && typeof reviewerSource === 'object' && !Array.isArray(reviewerSource)
    ? {
        dispatch_id: typeof reviewerSource.dispatch_id === 'string' ? reviewerSource.dispatch_id : '',
        model: typeof reviewerSource.model === 'string' ? reviewerSource.model : '',
        output_tokens: Number.isFinite(reviewerSource.output_tokens ?? reviewerSource.completion_tokens ?? reviewerSource.tokens)
          ? (reviewerSource.output_tokens ?? reviewerSource.completion_tokens ?? reviewerSource.tokens)
          : null,
      }
    : undefined;
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
    ...(reviewer !== undefined ? { reviewer_identity: reviewer } : {}),
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
  // An unresolved reviewer identity is UNAVAILABLE, never approval (§5.5): the review
  // may say approve, but evidence whose producer cannot be named never clears a wave.
  // The `reviewer_unavailable` flag is set by reviewCompletedTasks' checkpoint check
  // (required on the schema-backed family; explicitly-carried-but-unresolvable on either);
  // a record with no identity at all on a legacy bundle keeps the pre-task-56 behavior
  // (the legacy absence is explicit).
  if (review?.reviewer_unavailable === true) return true;
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
        ...(hit.review.reviewer_identity !== undefined ? { reviewer_identity: hit.review.reviewer_identity } : {}),
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

// The identity a prior review event was recorded under (task 56): the intent_identity
// the review bound at record time, read straight off the newest matching event — the
// same event selectReentry selected, so the staleness check judges the SAME record the
// re-entry check found. Local to this module because the reentry-guard's selector is
// deliberately field-narrow; the identity is a checkpoint-evidence concern.
function recordedIntentIdentity(eventsText, key) {
  if (typeof eventsText !== 'string') return { identity: null };
  let found = null;
  for (const raw of eventsText.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || rec.type !== 'task_adversary_review' || !rec.data) continue;
    if (rec.data.run !== key.run || rec.data.sha !== key.sha) continue;
    if (rec.data.task == null || String(rec.data.task) !== String(key.task)) continue;
    found = rec;
  }
  if (!found) return { identity: null };
  const id = found.data.intent_identity;
  return { identity: id && typeof id === 'object' && !Array.isArray(id) ? id : null };
}

// The task-review checkpoint's staleness check (§5.5): a prior review satisfies re-entry
// only when the identity it was recorded under matches the CURRENT tuple. Evidence
// cannot cross an identity boundary — a review earned under an older tuple (a changed
// goal set, a different schema snapshot, a different skill, a drifted reconciliation) is
// STALE and the review is unavailable, never approval; the task is re-reviewed.
function reviewIdentitySatisfies(priorIdentity, current) {
  if (!current || current.ok !== true) {
    // The current tuple cannot be established: a named failure that STOPS the
    // checkpoint (§6.3's resolution-fail row) — the caller throws on this.
    return { ok: false, stop: true, reason: current?.reason ?? 'the current intent identity could not be established' };
  }
  const cur = current.identity;
  if (cur.legacy === true) {
    if (priorIdentity === null) {
      // A pre-binding review on a legacy bundle: the absence is explicit — it keeps
      // satisfying re-entry as LEGACY, never as a schema-backed pass.
      return { ok: true, legacy: true };
    }
    if (priorIdentity.legacy === true) {
      if (cur.goals_hash !== null && priorIdentity.goals_hash !== undefined && priorIdentity.goals_hash !== cur.goals_hash) {
        return { ok: false, status: 'stale', reason: 'the prior review binds an older goals_hash — the goal set changed under it and evidence cannot cross that boundary' };
      }
      return { ok: true, legacy: true };
    }
    return { ok: false, status: 'mismatched', reason: 'the prior review carries a schema-backed identity on a legacy bundle — a tuple with no capture behind it is fabricated, not earned' };
  }
  if (priorIdentity === null) {
    return { ok: false, status: 'missing', reason: 'the prior review carries no intent_identity — a schema-backed checkpoint requires the tuple, and the absence of legacy evidence is not a new-format pass' };
  }
  if (priorIdentity.legacy === true) {
    return { ok: false, status: 'missing', reason: 'the prior review carries a LEGACY tuple against a schema-backed bundle — the schema-backed members are explicitly absent, which is not a pass' };
  }
  const members = ['goals_hash', 'schema_snapshot_digest', 'skill_identity', 'reconciliation_digest'];
  const partial = members.filter((m) => priorIdentity[m] === undefined || priorIdentity[m] === null || priorIdentity[m] === '');
  if (partial.length > 0) {
    return { ok: false, status: 'partial', reason: `the prior review's intent_identity is partial — ${partial.join(', ')} absent` };
  }
  const stale = members.filter((m) => priorIdentity[m] !== cur[m]);
  if (stale.length > 0) {
    return { ok: false, status: 'stale', reason: `the prior review's intent_identity differs on ${stale.join(', ')} — a task reviewed under an older tuple is stale and its review is unavailable, not passed` };
  }
  return { ok: true };
}

export async function reviewCompletedTasks({
  statePath, runId, wave, baseSha, items, callReview, now = Date.now(),
} = {}) {
  const bundleDir = path.dirname(path.resolve(statePath));
  const eventsPath = path.join(bundleDir, 'events.jsonl');
  let eventsText = '';
  try { eventsText = fs.readFileSync(eventsPath, 'utf8'); } catch { /* no events yet */ }
  // The checkpoint's CURRENT identity (task 56): built once per call from the bundle's
  // own records — never accepted from the caller, never re-derived per task. A bundle
  // whose identity cannot be established is a NAMED FAILURE that stops the checkpoint:
  // a review recorded against no tuple at all would be evidence bound to nothing.
  const identity = buildIntentIdentity({ statePath });
  if (!identity.ok) {
    throw new Error(`reviewCompletedTasks: the task-review checkpoint cannot establish the run's intent identity — ${identity.reason}`);
  }
  const output = [];
  for (const item of items ?? []) {
    if (item?.digest?.status !== 'done') { output.push(item); continue; }
    const input = item.review_input;
    const key = { run: runId, task: item.task_id, sha: input.sha };
    const prior = readTaskReviewEvent(eventsText, key);
    if (prior.present) {
      // The identity the prior review bound at record time (§5.5): evidence cannot
      // cross an identity boundary, so a prior event whose tuple differs from the
      // CURRENT one is stale/mismatched/missing and does NOT satisfy re-entry — the
      // review is re-run, unavailable rather than approved by the old receipt.
      const recorded = recordedIntentIdentity(eventsText, key);
      const identityCheck = reviewIdentitySatisfies(recorded.identity, identity);
      if (identityCheck.stop) {
        throw new Error(`reviewCompletedTasks: ${identityCheck.reason}`);
      }
      if (identityCheck.ok) {
        const next = {
          ...item,
          review: prior.review,
          digest: { ...item.digest, review: prior.review },
        };
        output.push(next);
        continue;
      }
      // Fall through to a fresh review: the stale receipt never suppresses one.
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
      // The reviewer identity (§5.5 reviewer_identity): unresolved is UNAVAILABLE,
      // never approval. Required on the schema-backed family; on the legacy family the
      // absence is the explicit legacy report — but a record that EXPLICITLY carries an
      // identity that does not resolve is refused on both families (a named identity
      // that names nothing is worse than none).
      const reviewer = resolveReviewerIdentity(review.reviewer_identity ?? review);
      const schemaBacked = identity.family === 'schema_backed';
      const carriedExplicitly = review.reviewer_identity !== undefined;
      if ((schemaBacked || carriedExplicitly) && !reviewer.ok) {
        review = {
          ...review,
          reviewer_unavailable: true,
          summary: review.verdict === 'approve'
            ? `reviewer identity unresolved — ${reviewer.reason}`
            : review.summary,
          ...(review.verdict === 'approve'
            ? { blocking_findings: [{ summary: `reviewer identity unresolved — ${reviewer.reason}` }, ...review.blocking_findings] }
            : {}),
        };
        status = 'skipped';
      }
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
    // The identity binding (§5.5): the recorded event names the tuple the review was
    // judged under — the receipt cannot cross an identity boundary, and a later
    // re-entry compares this tuple against the CURRENT one.
    event.data.intent_identity = identity.family === 'legacy'
      ? { legacy: true, goals_hash: identity.identity.goals_hash }
      : {
          goals_hash: identity.identity.goals_hash,
          schema_snapshot_digest: identity.identity.schema_snapshot_digest,
          skill_identity: identity.identity.skill_identity,
          reconciliation_digest: identity.identity.reconciliation_digest,
        };
    appendEvent(statePath, event);
    eventsText += `${JSON.stringify(event)}\n`;
    output.push({ ...item, review, digest: { ...item.digest, review } });
  }
  return output;
}
