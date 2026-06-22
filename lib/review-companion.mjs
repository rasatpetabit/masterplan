// lib/review-companion.mjs — the durable whole-branch adversary-review re-entry guard (pure core).
//
// This module is NOT adversary/codex-specific machinery — it is the events.jsonl scan that lets a
// resumed finish flow recognise "this exact tree was already reviewed" and skip the (expensive,
// network-bound) re-run while rehydrating the findings digest into the re-rendered gate AUQ.
//
// History: this used to live in lib/codex-companion.mjs alongside plugin-path resolvers for the
// retired codex-companion script. The adversary review now runs through the agent-dispatch control
// plane (`agent-dispatch review --class adversary`), so the path resolvers are gone; only this
// re-entry guard survives, renamed model-generic.

// Scan a bundle's events.jsonl text for a durable whole-branch review SUCCESS record at a given HEAD.
//
// The §2c finish-gate writes a success event (type:'adversary_review', data:{sha,base,count},
// note:<digest>) AFTER the review runs but BEFORE `open-gate` — so a death anywhere after the review
// completes still leaves this durable marker. On resume, step-7's guard reads this back: a present
// record for the CURRENT HEAD means "already reviewed at this exact tree" → skip the re-run AND
// rehydrate the findings digest into the re-rendered gate AUQ.
//
// DUAL-FAMILY MATCH (live-in-flight bundles): records written before the codex→adversary rename use
// type 'codex_review'; new records use 'adversary_review'. The guard matches BOTH so a run resumed
// across the rename is not re-reviewed. A SKIP record (codex_review_skipped / adversary_review_skipped,
// the degraded path) is deliberately ignored — a prior skip never masks a real re-run opportunity.
//
// PURE: events-text + sha in, plain object out (the file read lives in the `adversary-review-status`
// subcommand — bin is the sole fs boundary). `present` keys on the record's EXISTENCE at this sha
// (NOT count > 0): a clean zero-findings review still counts as reviewed. Returns the LAST matching
// line (a re-review at the same sha wins). Malformed/blank lines are skipped.
const REVIEW_SUCCESS_TYPES = new Set(['codex_review', 'adversary_review']);

export function selectCodexReviewForHead(eventsText, sha) {
  const absent = { present: false, digest: null, count: null, base: null };
  if (typeof eventsText !== 'string' || typeof sha !== 'string' || sha === '') return absent;
  let hit = null;
  for (const line of eventsText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (!rec || !REVIEW_SUCCESS_TYPES.has(rec.type)) continue;
    if (!rec.data || rec.data.sha !== sha) continue;
    hit = rec; // keep scanning — last match at this sha wins
  }
  if (!hit) return absent;
  return {
    present: true,
    digest: typeof hit.note === 'string' ? hit.note : null,
    count: hit.data && Number.isFinite(hit.data.count) ? hit.data.count : null,
    base: hit.data && typeof hit.data.base === 'string' ? hit.data.base : null,
  };
}
