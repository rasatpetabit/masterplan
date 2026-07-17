// lib/reentry-guard.mjs
//
// Unified pure re-entry guard over a bundle's events.jsonl text.
// Subsumes the read semantics of lib/gate-review.mjs (selectGateReview) and
// lib/review-companion.mjs (selectCodexReviewForHead), and adds one NEW
// per-task kind for fabric-dispatch. Reads the EXISTING durable vocabulary
// byte-for-byte — NO events.jsonl migration; old bundles still satisfy.
//
// Three kinds (key + skip polarity):
//   artifact-hash  — spec/plan pre-execute gates, keyed data.hash (a content
//                    hash recomputed by bin over the CURRENT artifact bytes so
//                    an edit re-arms the gate); skip SATISFIES (fail-soft —
//                    the STEP is mandatory, the review RESULT is advisory).
//   head-sha       — finish-gate whole-branch review, keyed data.sha; dual-
//                    family codex_review/adversary_review so a run resumed
//                    across the rename is not re-reviewed; skip IGNORED.
//   run+task+sha   — NEW per-task vocabulary for fabric-dispatch, keyed
//                    data.{run,task,sha}; skip IGNORED. A 2026-07-15 inventory
//                    of every event type written by lib/, bin/, workflows/ plus
//                    all 10 live bundles' events.jsonl proved NO pre-existing
//                    per-task review vocabulary, so this shape is genuinely
//                    new — no legacy dual-read needed, and old bundles simply
//                    never match it.
//
// PURE — events text + descriptor in, plain object out. No fs, no process,
// no clock (file reads/appends live in bin, CD-7).

export const KINDS = ['artifact-hash', 'head-sha', 'run+task+sha'];

export const TASK_REVIEW_TYPES = {
  done: 'task_adversary_review',
  skipped: 'task_adversary_review_skipped',
};

const ABSENT = Object.freeze({
  present: false,
  status: null,
  digest: null,
  count: null,
  base: null,
});

export function reentryEventTypes(kind, gate = null) {
  if (kind === 'artifact-hash') {
    if (gate !== 'spec' && gate !== 'plan') {
      throw new Error(
        `reentry-guard: unknown gate '${gate}' — expected 'spec' or 'plan'`,
      );
    }
    if (gate === 'spec') {
      return {
        done: ['spec_adversary_review'],
        skipped: ['spec_adversary_review_skipped'],
        skipSatisfies: true,
      };
    }
    return {
      done: ['plan_adversary_review'],
      skipped: ['plan_adversary_review_skipped'],
      skipSatisfies: true,
    };
  }
  if (kind === 'head-sha') {
    return {
      done: ['codex_review', 'adversary_review'],
      skipped: ['codex_review_skipped', 'adversary_review_skipped'],
      skipSatisfies: false,
    };
  }
  if (kind === 'run+task+sha') {
    return {
      done: [TASK_REVIEW_TYPES.done],
      skipped: [TASK_REVIEW_TYPES.skipped],
      skipSatisfies: false,
    };
  }
  throw new Error(
    `reentry-guard: unknown kind '${kind}' — expected one of artifact-hash, head-sha, run+task+sha`,
  );
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function selectReentry(eventsText, { kind, gate = null, key } = {}) {
  const { done, skipped, skipSatisfies } = reentryEventTypes(kind, gate);

  if (typeof eventsText !== 'string') {
    return { ...ABSENT };
  }

  if (kind === 'artifact-hash' || kind === 'head-sha') {
    if (!isNonEmptyString(key)) {
      return { ...ABSENT };
    }
  } else if (kind === 'run+task+sha') {
    if (
      !isPlainObject(key) ||
      !isNonEmptyString(key.run) ||
      !isNonEmptyString(key.sha) ||
      key.task === null ||
      key.task === undefined ||
      String(key.task) === ''
    ) {
      return { ...ABSENT };
    }
  }

  let hit = null;
  const lines = eventsText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec) continue;

    const typeOk = skipSatisfies
      ? done.includes(rec.type) || skipped.includes(rec.type)
      : done.includes(rec.type);
    if (!typeOk) continue;

    if (!rec.data) continue;

    let keyOk = false;
    if (kind === 'artifact-hash') {
      keyOk = rec.data.hash === key;
    } else if (kind === 'head-sha') {
      keyOk = rec.data.sha === key;
    } else if (kind === 'run+task+sha') {
      keyOk =
        rec.data.run === key.run &&
        rec.data.sha === key.sha &&
        rec.data.task != null &&
        String(rec.data.task) === String(key.task);
    }
    if (!keyOk) continue;

    hit = rec;
  }

  if (!hit) {
    return { ...ABSENT };
  }

  return {
    present: true,
    status: skipped.includes(hit.type) ? 'skipped' : 'done',
    digest: typeof hit.note === 'string' ? hit.note : null,
    count:
      hit.data && Number.isFinite(hit.data.count) ? hit.data.count : null,
    base:
      hit.data && typeof hit.data.base === 'string' ? hit.data.base : null,
  };
}

// Round-trip guarantee: selectReentry(JSON.stringify(buildTaskReviewEvent(
//   {run,task,sha,status:'done',...})) + '\n', { kind: 'run+task+sha',
//   key: {run,task,sha} }) is present:true/status:'done'.
export function buildTaskReviewEvent({
  run,
  task,
  sha,
  status = 'done',
  count = null,
  base = null,
  digest = null,
  summary = null,
  ts = null,
} = {}) {
  if (!isNonEmptyString(run)) {
    throw new Error('reentry-guard: run must be a non-empty string');
  }
  if (!isNonEmptyString(sha)) {
    throw new Error('reentry-guard: sha must be a non-empty string');
  }
  if (task === null || task === undefined || String(task) === '') {
    throw new Error(
      'reentry-guard: task must not be null/undefined and String(task) must be non-empty',
    );
  }
  if (status !== 'done' && status !== 'skipped') {
    throw new Error("reentry-guard: status must be 'done' or 'skipped'");
  }

  const type =
    status === 'done' ? TASK_REVIEW_TYPES.done : TASK_REVIEW_TYPES.skipped;

  const data = {
    run,
    task,
    sha,
    count: Number.isFinite(count) ? count : null,
    base: typeof base === 'string' ? base : null,
  };

  let resolvedSummary;
  if (isNonEmptyString(summary)) {
    resolvedSummary = summary;
  } else if (status === 'done') {
    const findings = Number.isFinite(count) ? count : '?';
    resolvedSummary = `task ${task} adversary review complete — ${findings} findings (run ${run})`;
  } else {
    resolvedSummary = `task ${task} adversary review skipped (degraded) (run ${run})`;
  }

  const event = {
    type,
    summary: resolvedSummary,
    data,
  };

  if (isNonEmptyString(ts)) {
    event.ts = ts;
  }
  if (isNonEmptyString(digest)) {
    event.note = digest;
  }

  return event;
}

// Validate a structured `done` receipt for record-gate-review. PURE: a receipt object + the bin-computed
// {gate, hash, artifacts} in, a {ok, error?|normalized?} out. The point of the receipt is to make a
// fabricated `done` cost more than a real review: the recorder must echo the EXACT hash the guard
// recomputed (so it cannot stamp `done` against stale/other artifacts) and the EXACT artifact set, and
// must carry real lane-call provenance (dispatch_id/provider/model) and a positive token count (a lane
// that ran produced tokens). This is honest about its ceiling — the same agent runs the lane AND writes
// the record, so it raises the friction of a lazy skip, it does not make forgery cryptographically
// impossible. A degraded lane uses --status=skipped (reason + digest-file), which needs no receipt.
// (Relocated verbatim from the retired lib/gate-review.mjs.)
export function validateGateReceipt(receipt, { gate, hash, artifacts }) {
  const fail = (error) => ({ ok: false, error });
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return fail('receipt must be a JSON object');
  }
  if (receipt.status !== 'done') {
    return fail(`receipt.status must be 'done' (got ${JSON.stringify(receipt.status)})`);
  }
  if (receipt.gate !== gate) {
    return fail(`receipt.gate ${JSON.stringify(receipt.gate)} != gate ${JSON.stringify(gate)}`);
  }
  if (receipt.hash !== hash) {
    return fail(
      `receipt.hash does not echo the current artifact hash — the reviewed artifacts have changed, ` +
        `or the receipt is for a different bundle. Re-run the review over the CURRENT artifacts.`
    );
  }
  if (!Array.isArray(receipt.artifacts)) {
    return fail('receipt.artifacts must be an array of relative artifact names');
  }
  const got = new Set(receipt.artifacts.map((x) => String(x)));
  const want = new Set(artifacts.map((x) => String(x)));
  if (got.size !== want.size || [...want].some((x) => !got.has(x))) {
    return fail(
      `receipt.artifacts ${JSON.stringify([...got].sort())} != gated artifacts ${JSON.stringify([...want].sort())}`
    );
  }
  for (const k of ['dispatch_id', 'provider', 'model']) {
    if (typeof receipt[k] !== 'string' || receipt[k].trim() === '') {
      return fail(`receipt.${k} must be a non-empty string (lane-call provenance)`);
    }
  }
  const tokens = receipt.output_tokens ?? receipt.completion_tokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
    return fail('receipt.output_tokens (or completion_tokens) must be a finite number > 0');
  }
  if (typeof receipt.ts !== 'string' || receipt.ts.trim() === '') {
    return fail('receipt.ts must be a non-empty string');
  }
  if (typeof receipt.digest !== 'string' || receipt.digest.trim() === '') {
    return fail('receipt.digest must be a non-empty findings string');
  }
  return {
    ok: true,
    normalized: {
      gate,
      hash,
      artifacts: [...want].sort(),
      dispatch_id: receipt.dispatch_id,
      provider: receipt.provider,
      model: receipt.model,
      output_tokens: tokens,
      ts: receipt.ts,
      digest: receipt.digest,
      base: typeof receipt.base === 'string' ? receipt.base : null,
    },
  };
}
