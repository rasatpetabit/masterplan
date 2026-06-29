// lib/gate-review.mjs — the pure re-entry guard for the two PRE-EXECUTE adversary-review gates:
// the spec gate (brainstorm→plan) and the plan gate (plan→execute). Sibling to
// lib/review-companion.mjs (the finish-gate whole-branch guard), with two deliberate differences:
//
//   • KEYED ON A CONTENT HASH (data.hash), not a git sha. These gates review files that live in the
//     bundle (spec.md; plan.md + plan.index.json + spec.md) — not a committed tree. The bin layer
//     recomputes the hash over the CURRENT artifact bytes at guard time, so editing any reviewed
//     artifact changes the hash, the stored event no longer matches, and the gate RE-ARMS. This is
//     the self-attestation fix: we never trust a hash stamped INSIDE a mutable artifact (e.g.
//     plan.index.json's own plan_hash) — bin recomputes it over the bytes actually being gated.
//
//   • A SKIP RECORD SATISFIES THE GATE (present:true, status:'skipped'). This is a FAIL-SOFT gate:
//     a degraded/unavailable cross-vendor lane records a *_skipped event and the flow ADVANCES —
//     the adversary lane never hard-blocks (docs/policy/dispatch.md). This is the OPPOSITE of the
//     finish guard, which IGNORES skips so a later resume can still attempt the real review. Here
//     the STEP (run-and-record) is mandatory; the review RESULT is advisory.
//
// PURE: events.jsonl text + gate + hash in, a plain {present,status,digest,count,base} out. No fs,
// no process, no clock. The file reads (events.jsonl; the artifact bytes that produce `hash`) live
// in bin — the sole fs boundary (CD-7).

const GATE_TYPES = {
  spec: { done: 'spec_adversary_review', skipped: 'spec_adversary_review_skipped' },
  plan: { done: 'plan_adversary_review', skipped: 'plan_adversary_review_skipped' },
};

// The success/skip event-type pair for a gate. Throws on an unknown gate (a caller bug, not data).
export function gateEventTypes(gate) {
  const pair = GATE_TYPES[gate];
  if (!pair) throw new Error(`gate-review: unknown gate '${gate}' — expected 'spec' or 'plan'`);
  return pair;
}

const ABSENT = { present: false, status: null, digest: null, count: null, base: null };

// Scan events.jsonl text for a gate-review record (done OR skipped) at `hash`. The LAST match at the
// hash wins (a re-review supersedes). A recorded skip is PRESENT (fail-soft). Blank/malformed lines
// are skipped; empty/non-string inputs return absent without throwing.
export function selectGateReview(eventsText, gate, hash) {
  const { done, skipped } = gateEventTypes(gate); // validates the gate first (throws on bad gate)
  if (typeof eventsText !== 'string' || typeof hash !== 'string' || hash === '') {
    return { ...ABSENT };
  }
  let hit = null;
  for (const line of eventsText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!rec || (rec.type !== done && rec.type !== skipped)) continue;
    if (!rec.data || rec.data.hash !== hash) continue;
    hit = rec; // last match at this hash wins
  }
  if (!hit) return { ...ABSENT };
  return {
    present: true,
    status: hit.type === done ? 'done' : 'skipped',
    digest: typeof hit.note === 'string' ? hit.note : null,
    count: hit.data && Number.isFinite(hit.data.count) ? hit.data.count : null,
    base: hit.data && typeof hit.data.base === 'string' ? hit.data.base : null,
  };
}

// Validate a structured `done` receipt for record-gate-review. PURE: a receipt object + the bin-computed
// {gate, hash, artifacts} in, a {ok, error?|normalized?} out. The point of the receipt is to make a
// fabricated `done` cost more than a real review: the recorder must echo the EXACT hash the guard
// recomputed (so it cannot stamp `done` against stale/other artifacts) and the EXACT artifact set, and
// must carry real lane-call provenance (dispatch_id/provider/model) and a positive token count (a lane
// that ran produced tokens). This is honest about its ceiling — the same agent runs the lane AND writes
// the record, so it raises the friction of a lazy skip, it does not make forgery cryptographically
// impossible. A degraded lane uses --status=skipped (reason + digest-file), which needs no receipt.
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
