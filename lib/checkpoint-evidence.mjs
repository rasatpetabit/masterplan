// lib/checkpoint-evidence.mjs — §5.5's receipt identity tuples, bound at the four
// checkpoints (task 56).
//
// Every receipt names what it authorizes, and any change to a member invalidates it
// (§5.5). The intent identity a receipt binds is:
//
//   intent_identity = { goals_hash, schema_snapshot_digest, skill_identity,
//                       reconciliation_digest }
//
// Carrying skill_identity inside it is what makes evidence unable to cross an identity
// boundary: two skills with identical schema bytes but different instructions produce
// different intent_identity values, so evidence earned under one cannot satisfy a
// checkpoint under the other. The finish tuple names §6.2's deploy fields explicitly
// rather than referring to them, so the tuple is the whole authorization:
//
//   finish tuple = { deploy_base_sha, deploy_chain_hash, live_check_digest }
//
// A LEGACY bundle (no schema_captured event) has no snapshot, no skill identity and no
// §6.3 reconciliation vocabulary. Its tuple carries goals_hash only, and every
// checkpoint reports that absence EXPLICITLY — the absence of legacy evidence is never
// read as a schema-backed pass (§5.5, draft §5).
//
// Two identities, never confused (§5.5): an ARTIFACT identity is the exact bytes of a
// file (the gate hash family — sha256 over the artifact bytes, what approval binds); an
// EVIDENCE identity is the canonical hash of parsed content (the goalsHash family), which
// is what the tuple members here bind. The schema snapshot is compared by exact bytes
// (artifact); goals_hash and reconciliation_digest are canonical (evidence). Both appear
// at the checkpoints and the verifier keeps them in distinct fields — a receipt that
// offers an artifact digest where an evidence member belongs is refused as mismatched,
// never adopted.
//
// The checked-section set is DATA-DRIVEN: it comes from the frozen snapshot's
// `checked_sections`, never from a copied list of today's headings (§5.5, §11). A
// snapshot with different sections drives different checkpoint behavior.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { goalsHash, parseGoals } from './goals.mjs';
import { readSchemaSnapshot, replaySchemaCapture, assertSkillIdentity } from './interview.mjs';
import { readRecordedReconciliation, REPO_INTENT_DIGEST_ABSENT, resolveReconciliationTarget, readTargetIntent, compareReconciliations } from './reconcile-intent.mjs';
import { resolveFormatPin, repairFormatPin } from './bundle.mjs';

// ---------------------------------------------------------------------------
// The vocabulary (§11's checkpoint tests mirror these statuses verbatim)
// ---------------------------------------------------------------------------

// Every way checkpoint evidence fails. All are UNAVAILABLE — never approval.
export const REJECTION_STATUSES = [
  'missing', // no tuple on the receipt at all
  'partial', // a tuple member that should exist is absent
  'unreadable', // the record exists but cannot be read (malformed, torn, unpinnable)
  'stale', // the receipt's tuple is well-formed but differs from the current one
  'mismatched', // the receipt names a different tuple (or family) than the checkpoint's
  'reviewer_unavailable', // the reviewer's identity cannot be resolved — never approval
];

// The four checkpoints (§5.5's table): each binds intent_identity; the finish tuple is
// named outright; spec review and the alignment audit additionally bind artifact hashes.
export const CHECKPOINTS = ['spec_review', 'alignment_audit', 'task_review', 'finish'];

// The intent-identity members, in the §5.5 order. The SHAPE is normative (spec §5.5
// names them); the VALUES all come from the bundle's own records.
export const INTENT_IDENTITY_MEMBERS = [
  'goals_hash',
  'schema_snapshot_digest',
  'skill_identity',
  'reconciliation_digest',
];

// The finish tuple's members, named outright — never referred to (§5.5: "the tuple is the
// whole authorization").
export const FINISH_TUPLE_MEMBERS = ['deploy_base_sha', 'deploy_chain_hash', 'live_check_digest'];

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Deterministic JSON: key order must not change an identity (canonical — evidence family).
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// The EXACT-BYTES digest — the artifact-identity family (§5.5 "two identities, never
// confused"). What §5.6 approval binds: no canonicalization, no trailing-newline
// tolerance. Exported so every checkpoint that binds artifact bytes uses ONE family.
export function artifactDigest(bytes) {
  return `sha256:${sha256Hex(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8'))}`;
}

// ---------------------------------------------------------------------------
// reconciliation_digest — canonical over the AUTHORIZATION half only (§6.3)
// ---------------------------------------------------------------------------

/**
 * The reconciliation_digest an intent_identity carries: a canonical digest over the
 * recorded reconciliation's AUTHORIZATION half {repository, remote, ref,
 * repo_intent_digest} — what the operator's approval was about. The observation half
 * {resolved_commit, resolved_at} is recorded beside it for auditing and NEVER
 * participates here, which is exactly what makes a benign re-resolution safe: a target
 * that moves with unchanged bytes does not change this digest and invalidates nothing,
 * while drift (changed bytes) and retarget (changed authorization) both do.
 */
export function reconciliationDigest(record) {
  if (!record || typeof record !== 'object' || !record.identity) {
    throw new Error('reconciliationDigest: a reconciliation record with an identity is required');
  }
  const id = record.identity;
  for (const k of ['repository', 'remote', 'ref']) {
    if (typeof id[k] !== 'string' || id[k].trim() === '') {
      throw new Error(`reconciliationDigest: the authorization member identity.${k} must be a non-empty string (§6.3)`);
    }
  }
  const digest = record.artifact_digest;
  if (digest !== REPO_INTENT_DIGEST_ABSENT && !/^sha256:[0-9a-f]{64}$/.test(String(digest))) {
    throw new Error(`reconciliationDigest: artifact_digest ${JSON.stringify(digest)} is neither the explicit absent value nor a sha256 digest (§6.3)`);
  }
  return `sha256:${sha256Hex(Buffer.from(stableStringify({
    repository: id.repository,
    remote: id.remote,
    ref: id.ref,
    repo_intent_digest: digest,
  }), 'utf8'))}`;
}

/**
 * The recorded reconciliation's authorization, surfaced for the finish tuple (§5.5:
 * the finish tuple carries repo_intent_digest and target_identity). The observation is
 * returned beside it for reading only — it never joins an equality check.
 */
export function recordedAuthorization({ statePath } = {}) {
  if (!statePath) throw new Error('recordedAuthorization: statePath is required');
  const rec = readRecordedReconciliation(statePath);
  if (!rec) {
    return {
      ok: false,
      status: 'missing',
      reason: 'no recorded reconciliation on this bundle — the finish tuple cannot carry repo_intent_digest or target_identity from nothing (§6.3: reconcile the integration target first)',
    };
  }
  const id = rec.identity;
  return {
    ok: true,
    repo_intent_digest: rec.artifact_digest,
    target_identity: { repository: id.repository, remote: id.remote, ref: id.ref },
    observation: { resolved_commit: id.resolved_commit, resolved_at: id.resolved_at },
  };
}

// ---------------------------------------------------------------------------
// buildIntentIdentity — the CURRENT tuple a checkpoint binds against
// ---------------------------------------------------------------------------

function bundleDirOf(statePath) {
  return path.dirname(path.resolve(statePath));
}

/**
 * The current intent identity of a bundle — the tuple every checkpoint binds its
 * receipts against. Dispatches on the bundle's own records, never on a caller's claim:
 *
 *   LEGACY family (no schema_captured event): {legacy: true, goals_hash} — goals_hash
 *     only, and `legacy: true` is the explicit marker that makes the absence of the
 *     schema-backed members visible, never a schema-backed pass. An absent goals.md is
 *     a legacy bundle's honest null (pre-goals bundles predate the artifact).
 *
 *   SCHEMA-BACKED family: all four members, fail-closed on every gap —
 *     goals.md read under the DURABLE format pin (§6.1: the pin selects the
 *     canonicalizer; a capture event with no pin is repaired from that history, never
 *     parsed as legacy), the frozen snapshot read through readSchemaSnapshot (never the
 *     live skill file), and the recorded §6.3 reconciliation's authorization digest.
 *
 * Returns {ok: true, family, identity} or {ok: false, status, reason} with status in
 * REJECTION_STATUSES. Never throws for a bundle-shaped input; throws only on caller
 * bugs (no statePath).
 */
export function buildIntentIdentity({ statePath, skillRoot } = {}) {
  if (!statePath) throw new Error('buildIntentIdentity: statePath is required');
  const bundleDir = bundleDirOf(statePath);

  let ledger;
  try {
    ledger = replaySchemaCapture(statePath);
  } catch (e) {
    return { ok: false, status: 'unreadable', reason: `the schema-capture ledger is unreadable (${e.message}) — the checkpoint cannot establish which family it is in` };
  }

  // goals.md — read once; absent is honest on the legacy family and refused on the
  // schema-backed one.
  let goalsText = null;
  let goalsError = null;
  try {
    goalsText = fs.readFileSync(path.join(bundleDir, 'goals.md'), 'utf8');
  } catch (e) {
    goalsError = e;
  }

  if (!ledger.captured) {
    // LEGACY: the family marker makes the schema-backed members' absence EXPLICIT.
    let goals_hash = null;
    if (goalsText !== null) {
      try {
        goals_hash = goalsHash(goalsText);
      } catch (e) {
        return { ok: false, status: 'unreadable', reason: `goals.md cannot be hashed for the identity tuple (${e.message})` };
      }
    }
    return {
      ok: true,
      family: 'legacy',
      identity: { legacy: true, goals_hash },
      // The bundle path, so the checkpoint surfaces that need the bundle's own artifacts
      // (coverage derivation, artifact bindings) read them from the SAME bundle the
      // identity was built on — never a caller-pointed substitute.
      statePath: path.resolve(statePath),
      note: 'legacy bundle: no schema_captured event — the tuple carries goals_hash only, and the schema-backed members are explicitly absent, never a schema-backed pass',
    };
  }

  // SCHEMA-BACKED: the §5.5 identity-equality guard runs at THIS checkpoint boundary
  // (review round 2 — finding 3): the installed skill is resolved and its recomputed
  // identity must equal the recorded one, or the checkpoint stops with the guard's named
  // failure — never approval, never a schema-backed pass over an unguarded skill. Where
  // the installed skill is not resolvable at the operation (no skill root available to
  // the checkpoint), the checkpoint FAILS CLOSED with the named refusal.
  if (skillRoot === undefined || skillRoot === null || String(skillRoot).trim() === '') {
    return {
      ok: false,
      status: 'unreadable',
      reason: 'skill_absent: the installed skill root is not available to this schema-backed checkpoint — the §5.5 identity guard recomputes the installed skill\'s identity, and a checkpoint that cannot resolve it stops; there is no fallback to native questioning or a live schema',
    };
  }
  try {
    assertSkillIdentity({ statePath, skillRoot });
  } catch (e) {
    return {
      ok: false,
      status: 'unreadable',
      reason: `${e.message} — the §5.5 surface-and-stop: the checkpoint refuses on the skill-identity guard, never approves over it`,
    };
  }

  // SCHEMA-BACKED: goals.md is required and hashes under the DURABLE pin (§6.1).
  if (goalsText === null) {
    return { ok: false, status: 'missing', reason: `goals.md is required on a schema-backed bundle (${goalsError?.message ?? 'unreadable'}) — the tuple cannot carry goals_hash from nothing` };
  }
  const pinResult = resolveFormatPin(statePath);
  let pin;
  if (pinResult.pin) {
    pin = pinResult.pin;
  } else if (pinResult.repairable) {
    // §6.1's sanctioned repair: a capture event with no pin refuses to parse as legacy
    // and is repaired FROM that history. The repair is idempotent and writes only the pin.
    try {
      pin = repairFormatPin(statePath).format_pin;
    } catch (e) {
      return { ok: false, status: 'unreadable', reason: `the durable format pin is missing and could not be repaired from the capture history (${e.message})` };
    }
  } else {
    return { ok: false, status: 'unreadable', reason: pinResult.error };
  }
  if (pin !== 'schema_backed') {
    return {
      ok: false,
      status: 'unreadable',
      reason: `the durable pin says ${JSON.stringify(pin)} while a schema_captured event exists — a recorded pin changes through an explicit amendment, never a checkpoint's inference`,
    };
  }
  let goals_hash;
  try {
    goals_hash = goalsHash(goalsText, { formatPin: pin });
  } catch (e) {
    return { ok: false, status: 'unreadable', reason: `goals.md cannot be hashed under the durable pin (${e.message}) — a stripped representation is a rejected downgrade, not a legacy fall-back (§6.1)` };
  }

  // The frozen snapshot: exact bytes (artifact identity), never the live skill file.
  let snap;
  try {
    snap = readSchemaSnapshot({ statePath });
  } catch (e) {
    return { ok: false, status: 'unreadable', reason: `the frozen schema snapshot is unavailable (${e.message})` };
  }

  // The recorded reconciliation's authorization digest (§6.3) — under the Freshness
  // rule's mandatory target re-resolution: reading a commit recorded long ago cannot
  // discover drift, so the checkpoint RE-RESOLVES the target here, through the same
  // resolver the record was earned with, and compares the fresh resolution against the
  // recorded one with the four distinct outcomes (§6.3):
  //   stands    — same target, same INTENT.md bytes: the observation refreshes (recorded
  //               beside, never in the equality) and NOTHING invalidates;
  //   drift     — same target, changed bytes: the authorization moved and every receipt
  //               binding the prior digest is invalidated — the checkpoint refuses;
  //   retarget  — the authorization half changed: the prior reconciliation is
  //               invalidated outright — the checkpoint refuses;
  //   unknown_unavailable — the target cannot be established: a named failure that
  //               STOPS the checkpoint, never a verified absence, never a silent reuse
  //               of the last good resolution.
  let rec;
  try {
    rec = readRecordedReconciliation(statePath);
  } catch (e) {
    return { ok: false, status: 'unreadable', reason: `the recorded reconciliation is unreadable (${e.message}) — a checkpoint cannot compare against bytes it cannot parse` };
  }
  if (!rec) {
    return {
      ok: false,
      status: 'missing',
      reason: 'no recorded reconciliation on a schema-backed bundle — the reconciliation_digest cannot be earned from nothing; reconcile the integration target first (§6.3: missing rows are not a neutral outcome)',
    };
  }
  const fresh = resolveReconciliationTarget({
    repository: rec.identity.repository,
    remote: rec.identity.remote,
    ref: rec.identity.ref,
  });
  if (!fresh.ok) {
    return {
      ok: false,
      status: 'unreadable',
      reason: `the integration target could not be re-resolved at the checkpoint — ${fresh.reason} (§6.3: unknown/unavailable is a named failure that stops the checkpoint, never a silent reuse of the recorded resolution)`,
    };
  }
  const freshRead = readTargetIntent({
    repository: rec.identity.repository,
    remote: rec.identity.remote,
    ref: rec.identity.ref,
    resolvedCommit: fresh.identity.resolved_commit,
  });
  if (!freshRead.ok) {
    return {
      ok: false,
      status: 'unreadable',
      reason: `the repository INTENT.md could not be read at the freshly resolved commit — ${freshRead.reason} (§6.3: an unreadable resolution is unknown/unavailable, never a verified absence and never a silent reuse)`,
    };
  }
  const freshDigest = freshRead.status === 'resolved'
    ? `sha256:${freshRead.digest}`
    : REPO_INTENT_DIGEST_ABSENT;
  const freshRecord = {
    identity: fresh.identity,
    artifact_digest: freshDigest,
  };
  const cmp = compareReconciliations(rec, freshRecord);
  if (cmp.outcome === 'drift') {
    return {
      ok: false,
      status: 'stale',
      reason: `the integration target carries changed repository-intent bytes — the recorded reconciliation is drift and every receipt binding its digest is invalidated with it; re-earn the reconciliation (§6.3)`,
    };
  }
  if (cmp.outcome === 'retarget') {
    return {
      ok: false,
      status: 'stale',
      reason: `the recorded reconciliation is bound to a different target — retargeting invalidated it outright; earn a new reconciliation against the current target (§6.3)`,
    };
  }
  if (cmp.outcome !== 'stands') {
    // Only 'stands' (and the two refusals above) can come out of a successful fresh
    // resolution against a prior record; anything else is a comparison defect and
    // fails closed rather than guessing.
    return { ok: false, status: 'unreadable', reason: `the reconciliation freshness comparison returned ${JSON.stringify(cmp.outcome)} — the checkpoint refuses rather than guessing (§6.3)` };
  }
  let reconciliation_digest;
  try {
    reconciliation_digest = reconciliationDigest(rec);
  } catch (e) {
    return { ok: false, status: 'unreadable', reason: e.message };
  }

  return {
    ok: true,
    family: 'schema_backed',
    identity: {
      goals_hash,
      // The snapshot is compared by EXACT BYTES (§5.5): the digest the capture event
      // recorded, verbatim — artifact identity in the tuple's snapshot member.
      schema_snapshot_digest: snap.schema_sha256,
      skill_identity: snap.skill_identity,
      reconciliation_digest,
    },
    // The bundle path, so the checkpoint surfaces that need the bundle's own artifacts
    // (coverage derivation, artifact bindings) read them from the SAME bundle the
    // identity was built on — never a caller-pointed substitute.
    statePath: path.resolve(statePath),
  };
}

// ---------------------------------------------------------------------------
// buildFinishTuple — §6.2's deploy fields, named outright
// ---------------------------------------------------------------------------

/**
 * The finish tuple, named outright: {deploy_base_sha, deploy_chain_hash,
 * live_check_digest}. The members are never referred to indirectly — a caller passing
 * "the chain" or "the digest" as some other shape does not reach the tuple. Refuses
 * missing (no members at all), partial (a member that should exist is absent/empty) and
 * unreadable (a member present but not the shape its name claims) — fail-closed, with
 * statuses in REJECTION_STATUSES so the finish checkpoint reports them in the same
 * vocabulary as every other checkpoint.
 */
export function buildFinishTuple({ deployBaseSha, deployChainHash, liveCheckDigest } = {}) {
  const members = { deploy_base_sha: deployBaseSha, deploy_chain_hash: deployChainHash, live_check_digest: liveCheckDigest };
  const present = Object.entries(members).filter(([, v]) => v !== undefined && v !== null && String(v) !== '');
  if (present.length === 0) {
    return { ok: false, status: 'missing', reason: 'the finish tuple is absent — a final assessment binds {deploy_base_sha, deploy_chain_hash, live_check_digest}, and a receipt bound to nothing is exactly the unearned completion §7.1 exists to prevent' };
  }
  if (present.length < FINISH_TUPLE_MEMBERS.length) {
    const absent = FINISH_TUPLE_MEMBERS.filter((m) => !present.some(([k]) => k === m));
    return { ok: false, status: 'partial', reason: `the finish tuple is partial — ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} absent, and a tuple member that should exist is absent (§5.5: any change to a member invalidates the receipt, and so does a member that never arrived)` };
  }
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(String(members.deploy_base_sha)) || /^sha256:/.test(String(members.deploy_base_sha))) {
    return { ok: false, status: 'unreadable', reason: `deploy_base_sha ${JSON.stringify(String(members.deploy_base_sha))} is not a commit id — the finish tuple names the deployed base, never a digest in its place` };
  }
  // deploy_chain_hash: the digest deployChainHash produces (bare hex — the shape the
  // deploy stage records on the goal_check event); live_check_digest: the digest
  // liveCheckDigest produces (the sha256: form). Both are the REAL producers' own
  // outputs — the tuple binds what the stage recorded, not a parallel format.
  if (!/^[0-9a-f]{64}$/.test(String(members.deploy_chain_hash))) {
    return { ok: false, status: 'unreadable', reason: `deploy_chain_hash ${JSON.stringify(String(members.deploy_chain_hash).slice(0, 24))}… is not a chain digest — the member exists but cannot be read as what it claims to be` };
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(members.live_check_digest))) {
    return { ok: false, status: 'unreadable', reason: `live_check_digest ${JSON.stringify(String(members.live_check_digest).slice(0, 24))}… is not a sha256 digest — the member exists but cannot be read as what it claims to be` };
  }
  return { ok: true, tuple: members };
}

// ---------------------------------------------------------------------------
// The reviewer identity (§5.5: every tuple carries reviewer_identity)
// ---------------------------------------------------------------------------

/**
 * Resolve a receipt's reviewer identity: {dispatch_id, model, output_tokens} — real
 * lane-call provenance, the same family the gate and goal-check receipts validate. The
 * sources are read permissively (provenance, reviewer_identity, or the receipt itself
 * may carry the members) but VALIDATED strictly: a dispatch id or model that is absent
 * or blank, or a token count that is not a finite positive number, is
 * reviewer_unavailable — an unresolved reviewer identity is unavailable, never approval.
 */
export function resolveReviewerIdentity(source) {
  const fail = (reason) => ({ ok: false, status: 'reviewer_unavailable', reason });
  if (source === null || source === undefined) {
    return fail('the receipt carries no reviewer identity at all — the reviewer that produced the evidence cannot be named');
  }
  const candidates = [
    source.reviewer_identity,
    source.provenance,
    source.reviewer,
    source, // the members may sit at the top of the receipt (gate-receipt shape)
  ].filter((c) => c && typeof c === 'object' && !Array.isArray(c));
  if (candidates.length === 0) {
    return fail('the receipt carries no reviewer identity at all — the reviewer that produced the evidence cannot be named');
  }
  for (const c of candidates) {
    // The user-attested shape names its producer too: `attested_by: 'user'` plus a
    // non-empty purpose (its own field, or inside the approval receipt the sibling
    // validators validate in full) is a named human producer, not an anonymous lane.
    // A dispatch id and a model are what prove a LANE ran; the attestation names the
    // person whose judgment the receipt carries.
    const attestedPurpose = c.purpose ?? c.approval_receipt?.purpose;
    if (c.attested_by === 'user' && typeof attestedPurpose === 'string' && attestedPurpose.trim() !== '') {
      return { ok: true, identity: { attested_by: 'user', purpose: attestedPurpose.trim() } };
    }
    const dispatch_id = typeof c.dispatch_id === 'string' ? c.dispatch_id.trim() : '';
    const model = typeof c.model === 'string' ? c.model.trim() : '';
    const tokens = c.output_tokens ?? c.completion_tokens ?? c.tokens;
    if (dispatch_id && model && typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
      return { ok: true, identity: { dispatch_id, model, output_tokens: tokens } };
    }
  }
  return fail('the reviewer identity does not resolve — a dispatch id, a model and a positive token count are what prove a lane ran, and one of them is absent or malformed');
}

// ---------------------------------------------------------------------------
// The checked-section set (data-driven, from the frozen snapshot)
// ---------------------------------------------------------------------------

/**
 * The checked-section set a spec-review or alignment-audit receipt must cover: from the
 * FROZEN SNAPSHOT's checked_sections, never a copied list of today's headings. Alternate
 * snapshot content therefore drives different checkpoint behavior (§11).
 */
export function checkedSectionsOf(schema) {
  const declared = schema && Array.isArray(schema.checked_sections) ? schema.checked_sections : null;
  if (!declared || declared.length === 0 || declared.some((s) => typeof s !== 'string' || s.trim() === '')) {
    throw new Error('checkedSectionsOf: the snapshot declares no checked_sections — coverage has no target set (§5.5: the frozen snapshot is the authority)');
  }
  return [...declared];
}

// ---------------------------------------------------------------------------
// The spec/alignment artifact bindings — independently computed at the checkpoint
// ---------------------------------------------------------------------------

// The ARTIFACT bindings a spec_review or alignment_audit receipt must carry (§5.5):
// spec review binds the §5.6 gate-hash family (the exact bytes of the gate's artifacts,
// computed by the SAME hash the gate's own recorder uses); the alignment audit binds the
// anchor (the run's `topic:` seed — the verbatim ask the audit measures drift against) and
// the plan (the exact bytes of plan.md at the time of the audit). Both are ARTIFACT
// identity — exact bytes — and stay distinct from the canonical evidence identity the
// tuple members carry. Each is computed HERE at the checkpoint from the bundle's own
// artifacts, never caller-asserted: a receipt comparing against a caller-supplied hash
// validates the caller's claim rather than the artifact.
export function specGateArtifactHash({ statePath, specPath, goalsPath } = {}) {
  if (!statePath) throw new Error('specGateArtifactHash: statePath is required');
  const bundleDir = bundleDirOf(statePath);
  const read = (p) => {
    try {
      return fs.readFileSync(p);
    } catch (e) {
      throw new Error(`specGateArtifactHash: the gate artifact ${p} is unreadable (${e.message}) — the spec-review checkpoint cannot bind artifact bytes it cannot read`);
    }
  };
  // The SAME descriptor family resolveGateArtifacts + computeGateHash use on the spec
  // gate (bin/masterplan.mjs): relName \0 bytes \0, spec.md first, goals.md appended on a
  // goals-enabled bundle. Re-derived here from the bundle alone so a recorded receipt is
  // compared against the CURRENT artifact bytes — an edit re-arms the binding exactly as
  // it re-arms the gate.
  const parts = [['spec.md', read(specPath ?? path.join(bundleDir, 'spec.md'))]];
  const goals = goalsPath ?? path.join(bundleDir, 'goals.md');
  try {
    parts.push(['goals.md', read(goals)]);
  } catch {
    // A bundle with no goals.md is the pre-goals shape: the spec-only hash, exactly the
    // gate's own behavior (the descriptor set follows the bundle, never a fixed list).
  }
  const h = crypto.createHash('sha256');
  for (const [rel, bytes] of parts) {
    h.update(rel);
    h.update('\0');
    h.update(bytes);
    h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

// The alignment audit's anchor identity: the EXACT BYTES of the run's verbatim ask —
// the `topic:` anchor the audit measures drift against. Read from goals.md's anchor
// (parseGoals's topicSeed), hashed as ARTIFACT bytes over the seed text so an amendment
// that edits the anchor moves the binding even when the goal list does not change.
export function anchorArtifactHash({ statePath } = {}) {
  if (!statePath) throw new Error('anchorArtifactHash: statePath is required');
  const bundleDir = bundleDirOf(statePath);
  let goalsText;
  try {
    goalsText = fs.readFileSync(path.join(bundleDir, 'goals.md'), 'utf8');
  } catch (e) {
    throw new Error(`anchorArtifactHash: goals.md is unreadable (${e.message}) — the alignment audit cannot bind an anchor it cannot read`);
  }
  const seed = parseGoals(goalsText).topicSeed;
  if (String(seed ?? '').trim() === '') {
    throw new Error('anchorArtifactHash: the run carries no `topic:` anchor — the alignment audit has no ask to measure drift against, and a receipt bound to nothing is the unassessed audit §3c exists to prevent');
  }
  return artifactDigest(Buffer.from(seed, 'utf8'));
}

// The alignment audit's plan identity: the EXACT BYTES of plan.md — the artifact the
// audit judges. Read from the bundle; a missing plan.md is a refused binding (an audit
// with no plan under judgment is an audit of nothing).
export function planArtifactHash({ statePath, planPath } = {}) {
  if (!statePath) throw new Error('planArtifactHash: statePath is required');
  const bundleDir = bundleDirOf(statePath);
  const p = planPath ?? path.join(bundleDir, 'plan.md');
  let bytes;
  try {
    bytes = fs.readFileSync(p);
  } catch (e) {
    throw new Error(`planArtifactHash: the plan artifact ${p} is unreadable (${e.message}) — the alignment audit cannot bind a plan it cannot read`);
  }
  return artifactDigest(bytes);
}

// The required per-section coverage set for a schema-backed spec/alignment checkpoint,
// derived from the FROZEN SNAPSHOT (§5.5's data-driven set). Exported so the checkpoint
// surfaces bind ONE derivation; never pass a copied list of today's headings.
export function requiredCoverageSections(statePath) {
  if (!statePath) throw new Error('requiredCoverageSections: statePath is required');
  const snap = readSchemaSnapshot({ statePath });
  return checkedSectionsOf(snap.schema);
}

// ---------------------------------------------------------------------------
// verifyCheckpointEvidence — the shared fail-closed verifier
// ---------------------------------------------------------------------------

const plain = (v) => (typeof v === 'string' && v.trim() !== '');

function identityOfReceipt(receipt) {
  const id = receipt?.intent_identity ?? receipt?.identity;
  return id && typeof id === 'object' && !Array.isArray(id) ? id : null;
}

// Compare a receipt's identity against the CURRENT one. Family-aware: the two families
// never satisfy each other — a schema-backed tuple offered to a legacy bundle (or the
// reverse) is mismatched, a legacy receipt's absence on a schema-backed checkpoint is
// the explicit legacy report, never a pass.
function compareIntentIdentity(receiptIdentity, current) {
  if (!current || current.ok !== true) {
    return { ok: false, status: current?.status ?? 'unreadable', reason: current?.reason ?? 'the current intent identity could not be established' };
  }
  const cur = current.identity;
  if (cur.legacy === true) {
    if (receiptIdentity === null) {
      // LEGACY family, no tuple on the receipt: the absence is reported EXPLICITLY —
      // legacy evidence satisfies a legacy checkpoint as legacy, never as a pass of the
      // schema-backed contract.
      return { ok: true, legacy: true, note: 'legacy evidence: the receipt predates identity binding and the bundle has no schema capture — the absence is explicit, not a schema-backed pass' };
    }
    if (receiptIdentity.legacy === true) {
      if (cur.goals_hash !== null && receiptIdentity.goals_hash !== undefined && receiptIdentity.goals_hash !== cur.goals_hash) {
        return { ok: false, status: 'stale', reason: `the receipt's goals_hash ${String(receiptIdentity.goals_hash).slice(0, 16)}… differs from the current ${String(cur.goals_hash).slice(0, 16)}… — the goal set changed under this review and evidence cannot cross that boundary` };
      }
      return { ok: true, legacy: true, note: 'legacy tuple: goals_hash only, matched' };
    }
    return { ok: false, status: 'mismatched', reason: 'the receipt carries a schema-backed identity tuple on a legacy bundle — a tuple with no capture behind it is fabricated, not earned' };
  }
  // SCHEMA-BACKED current.
  if (receiptIdentity === null) {
    return { ok: false, status: 'missing', reason: 'the receipt carries no intent_identity — a schema-backed checkpoint requires the tuple, and the absence of legacy evidence is not a new-format pass' };
  }
  if (receiptIdentity.legacy === true) {
    return { ok: false, status: 'missing', reason: 'the receipt carries a LEGACY tuple (goals_hash only) against a schema-backed checkpoint — the absence of the schema-backed members is explicit and does not pass as one' };
  }
  const problems = [];
  for (const member of INTENT_IDENTITY_MEMBERS) {
    const v = receiptIdentity[member];
    if (v === undefined || v === null || String(v) === '') {
      problems.push(member);
    }
  }
  if (problems.length > 0) {
    return { ok: false, status: 'partial', reason: `the receipt's intent_identity is partial — ${problems.join(', ')} ${problems.length === 1 ? 'is' : 'are'} absent, and a tuple member that should exist is absent (§5.5)` };
  }
  const stale = INTENT_IDENTITY_MEMBERS.filter((m) => receiptIdentity[m] !== cur[m]);
  if (stale.length > 0) {
    return { ok: false, status: 'stale', reason: `the receipt's intent_identity differs from the current one on ${stale.join(', ')} — evidence earned under one tuple cannot satisfy a checkpoint under another (§5.5)` };
  }
  return { ok: true };
}

// The artifact-vs-evidence confusion check: the goals_hash member is CANONICAL (the
// goalsHash family); a receipt offering the raw-bytes digest of goals.md in that
// position has confused artifact identity with evidence identity (§5.5 "two identities,
// never confused") and is refused as mismatched, never adopted.
function artifactEvidenceConfusion(receiptIdentity, current, goalsArtifactDigest) {
  if (!receiptIdentity || receiptIdentity.legacy === true || receiptIdentity.goals_hash === undefined) return null;
  if (goalsArtifactDigest && receiptIdentity.goals_hash === goalsArtifactDigest && current?.identity?.goals_hash !== goalsArtifactDigest) {
    return {
      ok: false,
      status: 'mismatched',
      reason: `the receipt's goals_hash is the ARTIFACT digest of goals.md (exact bytes, ${goalsArtifactDigest.slice(0, 16)}…) offered where the CANONICAL evidence identity belongs — artifact identity and evidence identity are never confused (§5.5)`,
    };
  }
  return null;
}

/**
 * Verify a checkpoint receipt against the current tuple. Fail-closed; every failure is
 * UNAVAILABLE, never approval, and reports a status from REJECTION_STATUSES.
 *
 *   receipt — the recorded receipt (event data or the review record)
 *   current — the result of buildIntentIdentity for the bundle RIGHT NOW
 *   finishTuple — for checkpoint 'finish': the result of buildFinishTuple
 *   checkedSections — for spec_review / alignment_audit: the snapshot's declared set
 *     (checkedSectionsOf) — the coverage requirement is data-driven
 *   goalsArtifactDigest — optional: the exact-bytes digest of goals.md, so a receipt
 *     that offers artifact identity in an evidence slot is refused as mismatched
 *
 * Legacy bundles: a receipt with no tuple verifies as {ok: true, legacy: true} — the
 * legacy absence reported explicitly, never as a schema-backed pass.
 */
export function verifyCheckpointEvidence({
  checkpoint, receipt, current, finishTuple, checkedSections, goalsArtifactDigest,
} = {}) {
  if (!CHECKPOINTS.includes(checkpoint)) {
    throw new Error(`verifyCheckpointEvidence: unknown checkpoint ${JSON.stringify(checkpoint)} — expected one of ${CHECKPOINTS.join(', ')}`);
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, status: 'missing', reason: 'the receipt is absent — no evidence exists to verify' };
  }

  // 1. The identity tuple (every checkpoint binds it).
  const receiptIdentity = identityOfReceipt(receipt);
  const confusion = artifactEvidenceConfusion(receiptIdentity, current, goalsArtifactDigest);
  if (confusion) return confusion;
  const idCheck = compareIntentIdentity(receiptIdentity, current);
  if (!idCheck.ok) return idCheck;
  const legacy = idCheck.legacy === true;

  // 2. The reviewer identity. On the schema-backed family it is REQUIRED — an
  //    unresolved reviewer identity is unavailable, never approval. On the legacy
  //    family its absence is the explicit legacy report (a receipt that DOES carry one
  //    must still resolve).
  const reviewer = resolveReviewerIdentity(receipt);
  if (!legacy && !reviewer.ok) return reviewer;
  if (legacy && receipt.reviewer_identity !== undefined && !reviewer.ok) return reviewer;

  // 3. The finish tuple, named outright (checkpoint 'finish' only).
  if (checkpoint === 'finish') {
    if (!finishTuple || finishTuple.ok !== true) {
      return {
        ok: false,
        status: finishTuple?.status ?? 'missing',
        reason: finishTuple?.reason ?? 'the current finish tuple could not be established — a final assessment cannot be verified against nothing',
      };
    }
    const want = finishTuple.tuple;
    // A receipt may carry the three members flat (the goal_check shape) or under
    // finish_tuple; both name the members outright.
    const flat = receipt.finish_tuple && typeof receipt.finish_tuple === 'object' && !Array.isArray(receipt.finish_tuple);
    const get = (name) => (flat ? receipt.finish_tuple[name] : receipt[name]);
    const presentMembers = FINISH_TUPLE_MEMBERS.filter((m) => {
      const v = get(m);
      return v !== undefined && v !== null && String(v) !== '';
    });
    if (presentMembers.length === 0) {
      return { ok: false, status: 'missing', reason: 'the receipt names none of the finish tuple members — a final assessment binds {deploy_base_sha, deploy_chain_hash, live_check_digest} outright, and a receipt bound to nothing is the unearned completion §7.1 exists to prevent' };
    }
    if (presentMembers.length < FINISH_TUPLE_MEMBERS.length) {
      const absent = FINISH_TUPLE_MEMBERS.filter((m) => !presentMembers.includes(m));
      return { ok: false, status: 'partial', reason: `the receipt's finish tuple is partial — ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} absent, and a tuple member that should exist is absent` };
    }
    const differing = FINISH_TUPLE_MEMBERS.filter((m) => get(m) !== want[m]);
    if (differing.length > 0) {
      return { ok: false, status: 'stale', reason: `the receipt's finish tuple differs from the current one on ${differing.join(', ')} — it is a receipt about a different deployment, and the tuple is the whole authorization (§5.5)` };
    }
  }

  // 4. The checked-section coverage (spec_review / alignment_audit): the set comes from
  //    the FROZEN SNAPSHOT, so alternate snapshot content changes what the checkpoint
  //    requires — no copied list of today's headings controls behavior. On the
  //    SCHEMA-BACKED family coverage is REQUIRED (§5.3): the snapshot declares its
  //    checked sections, and a receipt that covers none of them is a relabeled judgment,
  //    not an assessed one. The set is derived HERE from the bundle's frozen snapshot
  //    when the caller does not supply it — the requirement follows the bundle, never a
  //    caller's choice to skip it. A LEGACY bundle has no snapshot, so there is no set
  //    to demand: the legacy absence is explicit, never a pass.
  if (checkpoint === 'spec_review' || checkpoint === 'alignment_audit') {
    let sections = checkedSections;
    if (sections === undefined && !legacy && current?.statePath) {
      try {
        sections = requiredCoverageSections(current.statePath);
      } catch (e) {
        return { ok: false, status: 'unreadable', reason: `the frozen snapshot's checked sections are unavailable (${e.message}) — coverage has no target set and cannot be judged from nothing (§5.5)` };
      }
    }
    if (sections !== undefined) {
      const cov = receipt.sections;
      if (cov === undefined || cov === null) {
        return { ok: false, status: 'missing', reason: 'the receipt carries no per-section evidence — a spec review names its section verdicts, and coverage cannot be judged from nothing' };
      }
      if (typeof cov !== 'object' || Array.isArray(cov)) {
        return { ok: false, status: 'unreadable', reason: "the receipt's section evidence is not a section→verdict object — the record exists but cannot be read as coverage" };
      }
      // The undeclared-evidence check runs FIRST: a receipt carrying foreign-section
      // evidence is evidence for a DIFFERENT SCHEMA regardless of what it covers of this
      // one — the families never satisfy each other.
      const undeclared = Object.keys(cov).filter((s) => !sections.includes(s));
      if (undeclared.length > 0) {
        return { ok: false, status: 'mismatched', reason: `the receipt carries evidence for ${undeclared.map((s) => JSON.stringify(s)).join(', ')} — sections the snapshot does not declare checked; evidence for a different schema cannot satisfy this one` };
      }
      for (const want of sections) {
        if (!(want in cov)) {
          return { ok: false, status: 'partial', reason: `the receipt covers no verdict for checked section ${JSON.stringify(want)} — the snapshot declares it checked, so evidence for it should exist (§5.3: coverage of every checked section)` };
        }
        if (!plain(cov[want])) {
          return { ok: false, status: 'unreadable', reason: `the receipt's verdict for checked section ${JSON.stringify(want)} is blank — a member that exists but says nothing is not evidence` };
        }
      }
    }
  }

  // 5. The ARTIFACT bindings (§5.6's two families side by side): a schema-backed
  //    spec_review receipt binds the gate artifact hash (the exact bytes of the gated
  //    artifacts — the same family and the same FIELD the gate's own recorder stamps on
  //    its `spec_adversary_review` event), and a schema-backed alignment_audit receipt
  //    binds the anchor (the verbatim ask) and the plan (the exact bytes the audit
  //    judged). Each is computed HERE at the checkpoint from the bundle's own artifacts,
  //    never accepted from the caller: a receipt compared against a caller-supplied
  //    hash validates the caller's claim, not the artifact. A receipt MISSING a binding
  //    is partial; one naming different bytes is stale — the artifact moved under the
  //    review, and its evidence is about other bytes.
  if (!legacy && current?.statePath) {
    const bindings = [];
    if (checkpoint === 'spec_review') {
      bindings.push(['hash', () => specGateArtifactHash({ statePath: current.statePath, ...(current.specPath ? { specPath: current.specPath } : {}) })]);
    }
    if (checkpoint === 'alignment_audit') {
      bindings.push(['anchor_hash', () => anchorArtifactHash({ statePath: current.statePath })]);
      bindings.push(['plan_hash', () => planArtifactHash({ statePath: current.statePath, ...(current.planPath ? { planPath: current.planPath } : {}) })]);
    }
    for (const [field, compute] of bindings) {
      let want;
      try {
        want = compute();
      } catch (e) {
        return { ok: false, status: 'unreadable', reason: `${e.message} — the checkpoint cannot bind its artifacts, so a receipt naming them cannot be verified (§5.5)` };
      }
      const got = receipt[field];
      if (got === undefined || got === null || String(got) === '') {
        return { ok: false, status: 'partial', reason: `the receipt carries no ${field} — the checkpoint independently computes the artifact binding (${field} ${want.slice(0, 19)}… over the current bytes), and a receipt missing it is partial: the artifact bytes it judged were never named (§5.5)` };
      }
      if (String(got) !== want) {
        return { ok: false, status: 'stale', reason: `the receipt's ${field} is ${String(got).slice(0, 19)}… but the checkpoint's independently computed binding is ${want.slice(0, 19)}… — the artifact changed under the review, or the receipt names different bytes; its evidence cannot cover the current ones (§5.5)` };
      }
    }
  }

  return {
    ok: true,
    ...(legacy ? { legacy: true, note: idCheck.note ?? 'legacy evidence — the absence of schema-backed evidence is explicit, never a schema-backed pass' } : {}),
    normalized: {
      checkpoint,
      intent_identity: receiptIdentity,
      ...(reviewer.ok ? { reviewer_identity: reviewer.identity } : {}),
      ...(checkpoint === 'finish' && finishTuple?.ok ? { finish_tuple: finishTuple.tuple } : {}),
    },
  };
}