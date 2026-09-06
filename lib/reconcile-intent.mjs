// lib/reconcile-intent.mjs — §6.3 repository INTENT.md reconciliation (task 55).
//
// The repository artifact resolves from the run's INTEGRATION TARGET, never from the
// working tree of whichever branch execution happens on. The target is an identity,
// and its two halves are never compared together:
//
//   authorization  {repository, remote, ref, repo_intent_digest} — what an approval was about
//   observation    {resolved_commit, resolved_at}               — where/when it was read
//
// Receipts and identity tuples bind the AUTHORIZATION only; the observation is recorded
// beside it for auditing and never participates in an equality check. A re-resolution
// that moves resolved_commit/resolved_at while the digest is unchanged invalidates
// nothing (moved-not-drift); a digest/ref/remote/repository change is an authorization
// change and invalidates everything bound to the prior record.
//
// Three states are named and never collapsed (§6.3):
//   resolved           — the target resolved and carries INTENT.md at the recorded commit
//   absent_source      — VERIFIED absence: the resolved commit demonstrably carries no
//                       INTENT.md. Reserved for a target with no INTENT.md at all.
//   unknown_unavailable— the target cannot be established (none selected, stale cache,
//                       repo unreachable, ref unresolvable, or the recorded commit
//                       unreadable). A named failure, never a verified absence.
//
// A detached HEAD is none of these by itself: resolution goes THROUGH the configured
// remote (git ls-remote), never a worktree path, so an executor with a detached worktree
// and a configured freshly-resolved target resolves normally. Reads use the recorded
// resolved_commit — never a ref that may have moved, never a working-tree path — and the
// recorded identity and the recorded bytes always come from the same resolution.
//
// A branch that lacks an artifact its target carries is DRIFT against the target, not an
// absent source; the absent-source state is reserved for a target with no INTENT.md at
// all. The record names that drift so a checkpoint can report it.
//
// One reconciliation row per repository INTENT.md section (the skill's `##` section
// grammar), each carrying the artifact path, the section-anchored digest, the whole-file
// artifact digest (the authorization member), the verdict (vocabulary from the pinned
// schema snapshot's plan_level.reconciliation_verdicts — the schema snapshot is the
// authority, never the live skill file), and the resolved identity. Rows are persisted
// as a bundle artifact (intent-reconciliation.json) so a later checkpoint compares
// against the record rather than re-deriving it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { readSchemaSnapshot } from './interview.mjs';

// The bundle artifact this module owns (beside state.yml, like schema-snapshot.json).
export const RECONCILIATION_FILENAME = 'intent-reconciliation.json';

// Verified absence is an explicit digest value, not a null (§6.3): absent-to-absent is
// unchanged, while absent-to-present and present-to-absent are both authorization changes.
export const REPO_INTENT_DIGEST_ABSENT = 'absent';

// The repository artifact this reconciliation is about. §6.3 names INTENT.md; the constant
// is one home so a future rename changes one line, not a grep.
const INTENT_ARTIFACT = 'INTENT.md';

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Local git only (-C-qualified). Throws with command context (mirrors watch-integrity's
// runGit) so a failed git surfaces as a named failure, never a silent half-resolution.
// RAW stdout — no trim: a trailing newline is content for the digest reads; callers trim
// where a trim is semantic (ls-remote line parsing).
function gitExec(exec, dir, args) {
  const run = exec
    ? (d, a) => exec('git', ['-C', d, ...a])
    : (d, a) => String(execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    return run(dir, args);
  } catch (err) {
    const stderr = String(err?.stderr ?? '').trim();
    throw new Error(`git -C ${dir} ${args.join(' ')} failed: ${stderr || err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Target resolution (§6.3: the identity, its two halves)
// ---------------------------------------------------------------------------

/**
 * Resolve the integration target as an identity: the ref resolved THROUGH the configured
 * remote (git ls-remote — a remote-ref query, never a worktree path, never a local
 * rev-parse of a possibly-moved ref), read at the resolution instant. The ref's object id
 * is PEELED to the underlying commit (an annotated tag resolves to the TAG object) and
 * the peeled object's type VERIFIED as commit — resolved_commit names a commit, never a
 * raw ref object; a target that does not peel to a commit is unknown/unavailable.
 *
 *   { repository, remote, ref }            — what to resolve
 *   { now }                                 — clock injection (resolved_at); no default Date() here
 *                                             when omitted it is stamped by the caller's world
 *
 * Returns:
 *   { ok: true, identity: {repository, remote, ref, resolved_commit, resolved_at} }
 *   { ok: false, status: 'unknown_unavailable', reason } — the target cannot be established.
 *     NEVER a verified absence: an unresolvable ref is a named failure.
 */
export function resolveReconciliationTarget({ repository, remote, ref, now, exec } = {}) {
  const fail = (reason) => ({ ok: false, status: 'unknown_unavailable', reason });
  if (typeof repository !== 'string' || repository.trim() === '') {
    return fail('repository is required — the target resolves through a configured checkout, never a bare name');
  }
  if (typeof remote !== 'string' || remote.trim() === '') {
    return fail(`remote is required for repository ${repository} — the ref resolves through the configured remote`);
  }
  if (typeof ref !== 'string' || ref.trim() === '') {
    return fail('ref is required — a target with no ref selected cannot be established (§6.3 unknown/unavailable)');
  }
  let out;
  try {
    out = gitExec(exec, repository, ['ls-remote', remote, ref]);
  } catch (e) {
    return fail(`the remote could not be queried: ${e.message}`);
  }
  // ls-remote exits 0 with no output for an unresolvable ref: zero candidates is
  // unknown/unavailable, never a resolution.
  const first = out.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (!first) {
    return fail(`ref ${JSON.stringify(ref)} does not resolve on remote ${JSON.stringify(remote)} — zero candidates`);
  }
  const sha = first.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return fail(`ls-remote returned a non-commit object id ${JSON.stringify(sha)} for ref ${JSON.stringify(ref)} — only a commit resolves a target`);
  }
  // The ref's object id is NOT the commit: an annotated tag resolves to the TAG object,
  // so resolved_commit must be the PEELED commit, not the ref's raw object. Peel in the
  // module's own execution context (local git, -C-qualified, same exec seam): first
  // fetch the object if the checkout does not hold it yet (the read later targets the
  // RECORDED commit, so the fetch mirrors the resolution exactly as readTargetIntent
  // does), then dereference to the commit and VERIFY the peeled object type — a target
  // that does not peel to a commit (a blob/tree/tag-of-a-blob) is rejected as
  // unknown/unavailable, never recorded as a bogus resolved_commit.
  const fetchObject = () => {
    try {
      // The plain REF fetch — the universally supported form (mirrors readTargetIntent's
      // fetch) — brings the ref's object and what it points at into the checkout; a sha
      // fetch is refused by servers without uploadpack.allowAnySHA1InWant.
      gitExec(exec, repository, ['fetch', '--quiet', remote, ref]);
      return null;
    } catch (e) {
      return `the ref's object ${sha.slice(0, 12)} could not be fetched from ${JSON.stringify(remote)}: ${e.message}`;
    }
  };
  const peel = () => {
    try {
      return gitExec(exec, repository, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).trim();
    } catch {
      return '';
    }
  };
  let commit = peel();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    const ferr = fetchObject();
    if (ferr) return fail(ferr);
    commit = peel();
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      return fail(`ref ${JSON.stringify(ref)} resolves to ${sha} which does not peel to a commit on remote ${JSON.stringify(remote)} — a target is a commit, never a tag or blob object (§6.3)`);
    }
  }
  // Verify the peeled object's type: `rev-parse ^{commit}` dereferences chains, so the
  // type check is what proves the recorded id IS a commit.
  let type;
  try {
    type = gitExec(exec, repository, ['cat-file', '-t', commit]).trim();
  } catch (e) {
    return fail(`the peeled object ${commit.slice(0, 12)} could not be type-checked: ${e.message}`);
  }
  if (type !== 'commit') {
    return fail(`ref ${JSON.stringify(ref)} peels to a ${type} object (${commit.slice(0, 12)}) on remote ${JSON.stringify(remote)} — only a commit resolves a target (§6.3)`);
  }
  const resolvedAt = now === undefined || now === null
    ? new Date().toISOString()
    : new Date(Number.isFinite(Number(now)) ? Number(now) : now).toISOString();
  return {
    ok: true,
    identity: {
      repository,
      remote,
      ref,
      resolved_commit: commit,
      resolved_at: resolvedAt,
    },
  };
}

/**
 * Read the repository INTENT.md at the RECORDED commit — never a moving ref, never a
 * worktree path. The commit object is first proven present (git cat-file -e …^{commit});
 * with the commit proven, `cat-file blob` reports the one absent-path class that IS a
 * verified absence, and every other failure stays unknown/unavailable — the two are
 * never collapsed (§6.3).
 *
 * Returns:
 *   { ok: true, status: 'resolved', bytes, digest }      — the artifact exists at the commit
 *   { ok: true, status: 'absent_source' }                — VERIFIED absence at the commit
 *   { ok: false, status: 'unknown_unavailable', reason } — the recorded commit cannot be read
 */
export function readTargetIntent({ repository, remote, ref, resolvedCommit, exec } = {}) {
  const fail = (reason) => ({ ok: false, status: 'unknown_unavailable', reason });
  if (typeof resolvedCommit !== 'string' || !/^[0-9a-f]{40}$/.test(resolvedCommit)) {
    return fail(`resolved_commit ${JSON.stringify(resolvedCommit)} is not a commit id — there is no recorded resolution to read`);
  }
  const hasObject = () => {
    try {
      gitExec(exec, repository, ['cat-file', '-e', `${resolvedCommit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  if (!hasObject()) {
    // The recorded commit is not present locally. Fetch the target's own REF (the fetch
    // mirrors the resolution; a plain ref fetch is the universally supported form) and
    // re-check: the read still targets the RECORDED commit, so a remote that moved past
    // it stays unreadable rather than silently reading a different resolution.
    try {
      gitExec(exec, repository, ['fetch', '--quiet', remote, typeof ref === 'string' && ref ? ref : resolvedCommit]);
    } catch (e) {
      return fail(`the recorded resolution ${resolvedCommit.slice(0, 12)} could not be fetched: ${e.message}`);
    }
    if (!hasObject()) {
      return fail(`the recorded commit ${resolvedCommit.slice(0, 12)} is not readable from remote ${JSON.stringify(remote)} — reads use the recorded commit only (§6.3)`);
    }
  }
  let bytes;
  try {
    bytes = gitExec(exec, repository, ['cat-file', 'blob', `${resolvedCommit}:${INTENT_ARTIFACT}`]);
  } catch (e) {
    const msg = String(e?.message ?? e);
    // git's absent-path message at a PRESENT commit: "path 'INTENT.md' does not exist in
    // '<sha>'". The commit was proven present above, so this is the one error class that
    // IS a verified absence — everything else stays unknown/unavailable.
    if (new RegExp(`path '${INTENT_ARTIFACT}' does not exist in`).test(msg)) {
      return { ok: true, status: 'absent_source' };
    }
    return fail(`the repository artifact is unreadable at ${resolvedCommit.slice(0, 12)}: ${msg}`);
  }
  const buf = Buffer.from(bytes, 'utf8');
  return { ok: true, status: 'resolved', bytes: buf, digest: sha256Hex(buf) };
}

/**
 * Resolve + read + build the reconciliation record for the run's integration target.
 *
 *   { identity }          — a resolveReconciliationTarget identity (resolved_commit pinned)
 *   { statePath }         — the bundle; the verdict vocabulary comes from the pinned
 *                           schema snapshot (§5.5 frozen read; no capture -> refuse)
 *   { verdictBySection }  — the skill's per-section verdicts; EVERY section needs one,
 *                           validated against the snapshot's reconciliation_verdicts
 *   { branchIntentBytes } — OPTIONAL branch observation. A branch that lacks an artifact
 *                           its target carries is DRIFT against the target, never an
 *                           absent source (§6.3).
 *   { exec }              — git injection for tests
 *
 * Returns the durable reconciliation record (shape RECONCILIATION_FILENAME persists):
 *   {
 *     status: 'resolved' | 'absent_source' | 'unknown_unavailable',
 *     identity, artifact_path, artifact_digest (sha256:<hex> | 'absent'),
 *     rows: [{ section, verdict, artifact_path, artifact_digest, resolved_ref }],
 *     branch: { observed: bool, present: bool, drift: bool, note } (when observed)
 *   }
 */
export function buildReconciliationRows({ identity, statePath, verdictBySection, branchIntentBytes, exec } = {}) {
  if (!identity || typeof identity !== 'object') {
    return { ok: false, status: 'unknown_unavailable', reason: 'a resolved target identity is required — resolve it first (§6.3)' };
  }
  const read = readTargetIntent({
    repository: identity.repository,
    remote: identity.remote,
    ref: identity.ref,
    resolvedCommit: identity.resolved_commit,
    exec,
  });
  if (!read.ok) return read;
  const record = {
    status: read.status,
    identity,
    artifact_path: INTENT_ARTIFACT,
    artifact_digest: read.status === 'resolved' ? `sha256:${read.digest}` : REPO_INTENT_DIGEST_ABSENT,
    rows: [],
  };
  if (read.status === 'absent_source') {
    // VERIFIED absence: explicit, and reserved for a target with no INTENT.md at all.
    // Nothing to reconcile against; a branch observation cannot turn this into drift
    // (the target itself carries nothing).
    return { ok: true, record };
  }
  // The verdict vocabulary comes from the PINNED SCHEMA SNAPSHOT (§5.5: the frozen read
  // is the authority; a bundle with no capture has no vocabulary and refuses loudly —
  // never the live skill file, never a built-in list).
  let verdicts;
  try {
    const snap = readSchemaSnapshot({ statePath });
    verdicts = snap.schema?.plan_level?.reconciliation_verdicts;
  } catch (e) {
    return { ok: false, status: 'unknown_unavailable', reason: `the pinned schema snapshot is unavailable: ${e.message}` };
  }
  if (!Array.isArray(verdicts) || verdicts.length === 0 || verdicts.some((v) => typeof v !== 'string' || v === '')) {
    return { ok: false, status: 'unknown_unavailable', reason: 'the pinned schema snapshot declares no reconciliation_verdicts — rows have no vocabulary to be judged in' };
  }
  const allowed = new Set(verdicts);
  const sectionDigest = (heading, body) => sha256Hex(Buffer.from(`## ${heading}\n${body}`, 'utf8'));
  for (const { name, body } of splitIntentSections(read.bytes.toString('utf8'))) {
    const verdict = verdictBySection ? verdictBySection[name] : undefined;
    if (verdict === undefined) {
      return { ok: false, status: 'unknown_unavailable', reason: `section ${JSON.stringify(name)} carries no verdict — every repository INTENT.md section needs one (§6.3: a missing row is not a neutral outcome)` };
    }
    if (!allowed.has(verdict)) {
      return {
        ok: false,
        status: 'unknown_unavailable',
        reason: `verdict ${JSON.stringify(verdict)} for section ${JSON.stringify(name)} is not in the pinned schema snapshot's reconciliation_verdicts (${verdicts.join(', ')}) — the snapshot is the vocabulary authority`,
      };
    }
    record.rows.push({
      section: name,
      verdict,
      artifact_path: INTENT_ARTIFACT,
      artifact_digest: `sha256:${sectionDigest(name, body)}`,
      resolved_ref: {
        repository: identity.repository,
        remote: identity.remote,
        ref: identity.ref,
        resolved_commit: identity.resolved_commit,
        resolved_at: identity.resolved_at,
      },
    });
  }
  if (record.rows.length === 0) {
    return { ok: false, status: 'unknown_unavailable', reason: `the target's ${INTENT_ARTIFACT} carries no ## sections — there is nothing to reconcile row-wise (§6.3)` };
  }
  if (branchIntentBytes !== undefined) {
    // A branch that lacks an artifact its target carries is DRIFT against the target, not
    // an absent source: the absent-source state was reserved for the TARGET above.
    const present = branchIntentBytes !== null
      && typeof branchIntentBytes === 'string'
      && branchIntentBytes.trim() !== '';
    record.branch = present
      ? { observed: true, present: true, drift: false, note: 'the branch carries the artifact the target does' }
      : {
        observed: true,
        present: false,
        drift: true,
        note: 'the branch lacks INTENT.md the target carries — drift against the target, not an absent source; not resolved by moving the branch base',
      };
  }
  return { ok: true, record };
}

// The skill's `##` section grammar (validate-intent.mjs splitSections): a heading line
// opens a section; everything after it to the next heading (or EOF) is its body.
function splitIntentSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = { name: m[1], body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return sections.map((s) => ({ name: s.name, body: s.body.join('\n').trim() }));
}

// ---------------------------------------------------------------------------
// Freshness (§6.3: the four outcomes are distinct)
// ---------------------------------------------------------------------------

const authorizationKey = (r) => {
  const id = r?.identity ?? {};
  return [id.repository, id.remote, id.ref].join('\u0000');
};

/**
 * Compare a freshly-earned reconciliation against the one it would replace. The four
 * outcomes are distinct (§6.3):
 *
 *   first              — no prior record; the fresh one is earned outright
 *   stands             — same target, same artifact bytes (a newer commit is an
 *                        observation refresh only: resolved_commit/resolved_at recorded
 *                        beside, NOTHING invalidated; absent-to-absent is also stands)
 *   drift              — same target, changed bytes (absent<->present included): the
 *                        prior reconciliation is invalidated and re-earned, and every
 *                        receipt binding its repo_intent_digest is invalidated with it
 *   retarget           — the authorization half changed (repository/remote/ref): the
 *                        previous target's reconciliation is invalidated outright
 *   unknown_unavailable— the fresh resolution failed: a named failure that stops the
 *                        checkpoint; never a verified absence, never a silent reuse
 */
export function compareReconciliations(prior, current) {
  if (current && current.status === 'unknown_unavailable') {
    return { outcome: 'unknown_unavailable', reason: current.reason ?? 'the target could not be established', prior_invalidated: false };
  }
  if (!prior) {
    return { outcome: 'first', prior_invalidated: false };
  }
  if (authorizationKey(prior) !== authorizationKey(current)) {
    return {
      outcome: 'retarget',
      prior_invalidated: true,
      prior_authorization: {
        repository: prior.identity.repository,
        remote: prior.identity.remote,
        ref: prior.identity.ref,
        repo_intent_digest: prior.artifact_digest,
      },
      note: 'retargeting invalidates the reconciliation bound to the previous target — stale rows cannot authorize work',
    };
  }
  if (prior.artifact_digest !== current.artifact_digest) {
    return {
      outcome: 'drift',
      prior_invalidated: true,
      prior_authorization: {
        repository: prior.identity.repository,
        remote: prior.identity.remote,
        ref: prior.identity.ref,
        repo_intent_digest: prior.artifact_digest,
      },
      note: 'the target carries changed repository-intent bytes — the reconciliation is re-earned and every receipt binding the prior digest is invalidated with it',
    };
  }
  // Same authorization, same bytes. A moved resolved_commit is an observation refresh:
  // recorded beside, participates in no equality check, invalidates nothing.
  const moved = prior.identity.resolved_commit !== current.identity.resolved_commit;
  return {
    outcome: 'stands',
    prior_invalidated: false,
    refresh_observation: moved,
    ...(moved ? { note: 'the target moved with unchanged bytes — not drift; the observation is refreshed and no receipt is invalidated' } : {}),
  };
}

// ---------------------------------------------------------------------------
// Persistence (the durable record a checkpoint compares against)
// ---------------------------------------------------------------------------

export function reconciliationPath(statePath) {
  return path.join(path.dirname(path.resolve(statePath)), RECONCILIATION_FILENAME);
}

/**
 * Persist a reconciliation record as the bundle artifact. Refuses to overwrite a prior
 * record whose comparison outcome is drift or retarget without the operator's `accepted`
 * flag — drift is a real decision for the owner, and recording it silently would
 * launder stale rows out of history (§6.3: unresolved drift is not a neutral outcome).
 * A `stands` refresh (moved target, unchanged bytes) records without ceremony: the
 * observation is refreshed and nothing is invalidated.
 */
export function recordReconciliation({ statePath, record, decision, accepted, at } = {}) {
  if (!statePath) throw new Error('recordReconciliation: statePath is required');
  if (!record || typeof record !== 'object') throw new Error('recordReconciliation: a reconciliation record is required');
  const filePath = reconciliationPath(statePath);
  let prior = null;
  if (fs.existsSync(filePath)) {
    try {
      prior = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      throw new Error(`recordReconciliation: the existing ${RECONCILIATION_FILENAME} is unreadable (${e.message}) — reconcile it before overwriting`);
    }
  }
  const cmp = decision ?? compareReconciliations(prior, record);
  if (cmp.outcome === 'unknown_unavailable') {
    throw new Error(`recordReconciliation: refusing to persist an unresolved target (${cmp.reason}) — a failed resolution is a named failure, never a recorded reconciliation`);
  }
  if ((cmp.outcome === 'drift' || cmp.outcome === 'retarget') && accepted !== true) {
    throw new Error(`recordReconciliation: refusing to overwrite a prior reconciliation without accepting the ${cmp.outcome} (${cmp.note ?? 'the prior record is invalidated outright'}) — drift is a real decision for the owner, not a silent overwrite`);
  }
  const doc = {
    ...record,
    recorded_at: at === undefined || at === null ? new Date().toISOString() : new Date(at).toISOString(),
    comparison: {
      outcome: cmp.outcome,
      prior_invalidated: cmp.prior_invalidated === true,
      ...(cmp.refresh_observation !== undefined ? { refresh_observation: cmp.refresh_observation } : {}),
      ...(cmp.prior_authorization ? { prior_authorization: cmp.prior_authorization } : {}),
      ...(cmp.note ? { note: cmp.note } : {}),
    },
  };
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  return { path: filePath, comparison: cmp, record: doc };
}

/**
 * Read the durable prior record (null when none exists yet). A malformed record fails
 * closed — a checkpoint cannot compare against bytes it cannot parse.
 */
export function readRecordedReconciliation(statePath) {
  const filePath = reconciliationPath(statePath);
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !parsed.identity) {
    throw new Error(`readRecordedReconciliation: ${RECONCILIATION_FILENAME} is malformed (no identity) — re-earn the reconciliation`);
  }
  return parsed;
}