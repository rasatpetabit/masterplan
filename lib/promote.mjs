// lib/promote.mjs — §5.6 promotion of an approved amendment as a durable transaction (task 55).
//
// An amendment is approved as RESULTING BYTES, never as an instruction to edit. It ships
// three things whose digests the approval binds: the base spec.md and goals.md hashes it
// was produced against, a unified diff that applies cleanly to exactly those bases, and
// the resulting spec.md and goals.md hashes. Applying the diff to the bases must
// reproduce the resulting hashes; if it does not, the amendment is invalid and REFUSES
// BEFORE ANYTHING IS WRITTEN.
//
// The transaction (written before any mutation, as <bundle>/promotion-<txid>.json):
//   { transaction_id, base_hashes, result_hashes, diff_digest, approval_receipt_id, state }
// plus the git object ids of both bases, pinned by ref (refs/masterplan/promotion/<txid>/…)
// so they cannot be garbage-collected — the pre-image is recoverable from committed git
// objects plus the durable diff, never from hashes alone. States: prepared → written →
// recorded. The state field is advisory only: RECOVERY HASHES THE ARTIFACTS.
//
// The gate hash spans spec.md + goals.md, so the pair promotes together in ONE
// transaction: one approval, one lock held across BOTH writes and the record, one
// exactly-once event. A partial write is a named failure that refuses to advance; the
// goals half additionally carries its own exact-artifact goal_amend receipt (bound to
// both the prior and the resulting goals hash), and the goal_amended lineage event keeps
// the existing goals-lineage consumers (committed-hash guard, split-brain check) working.
//
// Recovery applies the decision table (§6.6/5.6), refusing symmetrically when EITHER
// artifact is neither its approved base nor its approved result, and treating an
// artifact whose base and result hashes are equal — the amendment never changed it — as
// `satisfied` ONLY while the disk bytes still ARE that approved base: the unchanged
// digest never waives the drift check. Recovery completes the approved promotion, never
// rolls one back, never re-asks the operator. Recording is exactly-once by
// transaction_id: a replay that finds the record already present completes any
// incomplete state convergence under the held lock (the event is the authority) and
// otherwise is a no-op — never a second write, never a double-append.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { readState, writeState, appendEvent } from './bundle.mjs';
import { parseGoals, goalsHash, validateAmendment, validateUserApprovalReceipt } from './goals.mjs';
import { acquireOwner } from './owner-fs.mjs';

// The durable transaction document lives beside state.yml, one per transaction_id
// (mirrors schema-snapshot.json: a bundle artifact, not CD-7 state).
export const PROMOTION_DOC_PREFIX = 'promotion-';
// The gc-proof ref namespace the pinned bases live under.
export const PROMOTION_REFS_PREFIX = 'refs/masterplan/promotion/';
// A transaction id interpolates into a ref name and a bundle filename: the bare-slug
// charset (lib/refs.mjs SLUG_RE precedent) keeps it path- and refname-safe.
export const TRANSACTION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sha256Of = (text) => `sha256:${sha256Hex(Buffer.from(String(text), 'utf8'))}`;

// The two artifacts the gate hash spans, and their bundle-relative names. The pair is
// fixed by §5.6; the transaction binds exactly these two.
const ROLES = ['spec', 'goals'];

// The bundle write lock's accepted acquisition outcomes on a mutating path — one home
// shared by every path that takes the lock (commit, recovery, the replay convergence).
const LOCK_OK_OUTCOMES = ['acquire', 'held-by-self', 'steal', 'force'];

// ---------------------------------------------------------------------------
// git (local, -C-qualified; injectable exec for tests)
// ---------------------------------------------------------------------------

function gitExec(exec, dir, args, { raw = false } = {}) {
  const run = exec
    ? (d, a) => exec('git', ['-C', d, ...a])
    : (d, a) => String(execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    const out = String(run(dir, args));
    // A trim is semantic for refname/oid reads; RAW keeps content bytes exact (a
    // trailing newline is part of a pinned blob's identity).
    return raw ? out : out.trim();
  } catch (err) {
    const stderr = String(err?.stderr ?? '').trim();
    throw new Error(`git -C ${dir} ${args.join(' ')} failed: ${stderr || err.message}`);
  }
}

// The repo root (MAIN) that owns the bundle dir — the same derivation recordWaveResult
// uses (the git-common-dir's parent), so linked worktrees resolve MAIN, not the WT.
function deriveRepoRoot(exec, statePath) {
  const bundleDir = path.dirname(path.resolve(statePath));
  return path.dirname(gitExec(exec, bundleDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

// ---------------------------------------------------------------------------
// Unified diff parsing + in-memory application (the §5.6 reproduction proof)
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a git-style unified diff into per-file sections. Refuses anything this
 * transaction cannot apply deterministically: rename/copy/new-file/delete-file
 * headers, binary patches, zero file sections, or a malformed hunk.
 */
export function parseUnifiedDiff(diffText) {
  if (typeof diffText !== 'string' || diffText.trim() === '') {
    return { ok: false, error: 'the amendment diff is empty — an approval binds a diff, not an instruction to edit' };
  }
  const lines = diffText.split('\n');
  // Drop a trailing empty element from the final newline — it is not a diff line.
  if (lines[lines.length - 1] === '') lines.pop();
  const files = [];
  let current = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      if (current) files.push(current);
      current = { oldPath: m[1], newPath: m[2], hunks: [] };
      i += 1;
      continue;
    }
    if (current === null) {
      return { ok: false, error: `the diff does not start with a \`diff --git\` header (got ${JSON.stringify(line.slice(0, 40))})` };
    }
    if (/^(old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files|GIT binary patch)/.test(line)) {
      return { ok: false, error: `the diff carries a header this transaction cannot apply deterministically (${JSON.stringify(line)}) — only standard text diffs apply` };
    }
    const oldHeader = /^--- a\/(.+)$/.exec(line);
    if (oldHeader) {
      const newHeader = /^\+\+\+ b\/(.+)$/.exec(lines[i + 1] ?? '');
      if (!newHeader) return { ok: false, error: `diff header \`--- a/${oldHeader[1]}\` has no matching \`+++ b/\` line` };
      if (oldHeader[1] !== current.oldPath || newHeader[1] !== current.newPath) {
        return { ok: false, error: `diff header paths (${oldHeader[1]} / ${newHeader[1]}) disagree with the diff --git line (${current.oldPath} / ${current.newPath})` };
      }
      i += 2;
      continue;
    }
    const hm = HUNK_HEADER_RE.exec(line);
    if (hm) {
      const oldStart = Number(hm[1]);
      const oldCount = hm[2] === undefined ? 1 : Number(hm[2]);
      const newStart = Number(hm[3]);
      const newCount = hm[4] === undefined ? 1 : Number(hm[4]);
      i += 1;
      const hunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],          // {op: ' '| '-' | '+', text}
        noNewlineOld: false,
        noNewlineNew: false,
      };
      let seenOld = 0;
      let seenNew = 0;
      while ((seenOld < oldCount || seenNew < newCount) && i < lines.length) {
        const body = lines[i];
        if (body.startsWith('\\')) {
          // "No newline at end of file": it qualifies the PREVIOUS line, for the side
          // that line belongs to.
          const prev = hunk.lines[hunk.lines.length - 1];
          if (!prev) return { ok: false, error: 'a hunk carries a no-newline marker before any line' };
          if (prev.op === '-') hunk.noNewlineOld = true;
          if (prev.op === '+') hunk.noNewlineNew = true;
          if (prev.op === ' ') { hunk.noNewlineOld = true; hunk.noNewlineNew = true; }
          i += 1;
          continue;
        }
        const op = body[0];
        if (op !== ' ' && op !== '-' && op !== '+') {
          return { ok: false, error: `hunk line ${JSON.stringify(body.slice(0, 40))} is not a context/added/removed line (expected ' ', '-', or '+')` };
        }
        if (op === '-' || op === ' ') {
          if (seenOld >= oldCount) return { ok: false, error: `hunk at -${oldStart} carries more old lines than its header declares` };
          seenOld += 1;
        }
        if (op === '+' || op === ' ') {
          if (seenNew >= newCount) return { ok: false, error: `hunk at -${oldStart} carries more new lines than its header declares` };
          seenNew += 1;
        }
        hunk.lines.push({ op, text: body.slice(1) });
        i += 1;
      }
      if (seenOld !== oldCount || seenNew !== newCount) {
        return { ok: false, error: `hunk at -${oldStart} is truncated: its header declares ${oldCount}/${newCount} lines but it carries ${seenOld}/${seenNew}` };
      }
      current.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('index ')) {
      i += 1;
      continue;
    }
    return { ok: false, error: `unrecognized diff line ${JSON.stringify(line.slice(0, 40))}` };
  }
  if (current) files.push(current);
  if (files.length === 0) return { ok: false, error: 'the diff carries no file sections' };
  return { ok: true, files };
}

/** Split text into lines (no terminators) and record whether the final line lacks '\n'. */
function toLines(text) {
  const noFinalNewline = !text.endsWith('\n');
  const body = noFinalNewline ? text : text.slice(0, -1);
  return { lines: body.split('\n'), noFinalNewline };
}

/**
 * Apply one file's hunks to a base text, in memory. Clean-apply semantics: each hunk's
 * old lines (context + removed, in order) must match the base exactly, at the declared
 * position or at a forward offset (git apply's offset rule); the ultimate arbiter is
 * the caller's result-hash comparison — a wrong application fails closed there.
 */
function applyHunks(baseText, hunks) {
  const { lines, noFinalNewline } = toLines(baseText);
  let out = [];
  let consumed = 0; // base lines already emitted to out
  let newNoFinalNewline = noFinalNewline;
  const oldSide = (h) => h.lines.filter((l) => l.op !== '+');
  const newSide = (h) => h.lines.filter((l) => l.op !== '-');

  for (const hunk of hunks) {
    const old = oldSide(hunk);
    const matchAt = (idx) => {
      for (let k = 0; k < old.length; k += 1) {
        if (idx + k >= lines.length || lines[idx + k] !== old[k].text) return false;
      }
      return true;
    };
    let at = -1;
    const declared = hunk.oldStart - 1;
    if (declared >= consumed && matchAt(declared)) {
      at = declared;
    } else {
      // Forward search from the last consumed position (git's offset application).
      for (let probe = consumed; probe + old.length <= lines.length; probe += 1) {
        if (matchAt(probe)) { at = probe; break; }
      }
    }
    if (at === -1) {
      return { ok: false, error: `the diff does not apply to the approved base: hunk at -${hunk.oldStart} matches nowhere from line ${consumed + 1} on` };
    }
    for (let k = consumed; k < at; k += 1) out.push(lines[k]);
    for (const l of newSide(hunk)) out.push(l.text);
    if (hunk.noNewlineNew) newNoFinalNewline = true;
    else if (newSide(hunk).length > 0) newNoFinalNewline = false;
    consumed = at + old.length;
  }
  for (let k = consumed; k < lines.length; k += 1) out.push(lines[k]);
  return { ok: true, text: out.join('\n') + (newNoFinalNewline ? '' : '\n') };
}

/**
 * Apply the unified diff to the bases, IN MEMORY, for one role ('spec' | 'goals').
 * The proof §5.6 demands: the caller hashes the result and compares against the
 * approved result hash — a diff that does not reproduce it is invalid, and NOTHING
 * is written.
 */
export function applyUnifiedDiff(baseText, diffText, role) {
  const parsed = parseUnifiedDiff(diffText);
  if (!parsed.ok) return parsed;
  const section = parsed.files.find((f) => rolePathMatches(f.newPath, role) || rolePathMatches(f.oldPath, role));
  if (!section) {
    // A diff naturally carries no section for an unchanged file: applying it there is
    // the identity. The caller's hash comparison is the arbiter — a file whose RESULT
    // differs while the diff never touches it fails there, fail-closed.
    return { ok: true, text: baseText };
  }
  return applyHunks(baseText, section.hunks);
}

// A diff section targets the bundle artifact when its path ends with the artifact name
// (git emits repo-relative paths; the bundle artifacts are <bundle>/spec.md and
// <bundle>/goals.md, and the hash binding — not the path text — is the authority).
function rolePathMatches(p, role) {
  return p === `${role}.md` || p.endsWith(`/${role}.md`);
}

// ---------------------------------------------------------------------------
// Approval validation (exact-artifact, user-attested, binding every hash)
// ---------------------------------------------------------------------------

/**
 * Validate the promotion approval: user-attested, purpose 'promotion', bound to THIS
 * transaction's bases, results and diff digest (an approval for anything else is a
// replay/stale refusal, never a guess). When the goals hash CHANGES, the goals half
 * requires its own exact-artifact goal_amend receipt (§5.6) binding both the prior and
 * the resulting goals hash — validated through the existing
 * lib/goals.mjs validateUserApprovalReceipt, the same validator `mp goals-amend` uses.
 */
export function validatePromotionApproval(approval, expected = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
    return fail('the promotion approval receipt must be a JSON object');
  }
  if (approval.attested_by !== 'user') return fail("approval.attested_by must be 'user' — an operator approval, never autonomous");
  if (approval.purpose !== 'promotion') return fail("approval.purpose must be 'promotion' (§5.6)");
  for (const k of ['question', 'answer', 'ts']) {
    if (typeof approval[k] !== 'string' || approval[k].trim() === '') return fail(`approval.${k} must be a non-empty string`);
  }
  if (typeof approval.approval_receipt_id !== 'string' || approval.approval_receipt_id.trim() === '') {
    return fail('approval.approval_receipt_id must be a non-empty string — the transaction record names what authorized it');
  }
  if (expected.transactionId !== undefined && approval.transaction_id !== expected.transactionId) {
    return fail(`approval.transaction_id ${JSON.stringify(approval.transaction_id)} does not bind this transaction (${JSON.stringify(expected.transactionId)}) — a replay/stale approval`);
  }
  for (const role of ROLES) {
    if (expected.baseHashes?.[role] !== undefined && approval.base_hashes?.[role] !== expected.baseHashes[role]) {
      return fail(`approval.base_hashes.${role} does not bind the base ${role}.md hash (replay/stale approval)`);
    }
    if (expected.resultHashes?.[role] !== undefined && approval.result_hashes?.[role] !== expected.resultHashes[role]) {
      return fail(`approval.result_hashes.${role} does not bind the resulting ${role}.md hash (replay/stale approval)`);
    }
  }
  if (expected.diffDigest !== undefined && approval.diff_digest !== expected.diffDigest) {
    return fail(`approval.diff_digest does not bind the approved diff (${expected.diffDigest})`);
  }
  const normalized = {
    attested_by: 'user',
    purpose: 'promotion',
    transaction_id: approval.transaction_id ?? null,
    approval_receipt_id: approval.approval_receipt_id,
    base_hashes: { ...approval.base_hashes },
    result_hashes: { ...approval.result_hashes },
    diff_digest: approval.diff_digest ?? null,
    question: approval.question,
    answer: approval.answer,
    ts: approval.ts,
  };
  // The goals half: only when the amendment changes goals.md does §5.6's own goal_amend
  // receipt apply (bound to both the prior and the resulting goals hash).
  if (expected.resultHashes?.goals !== undefined && expected.baseHashes?.goals !== undefined
    && expected.resultHashes.goals !== expected.baseHashes.goals) {
    if (!approval.goals_amend || typeof approval.goals_amend !== 'object') {
      return fail('the amendment changes goals.md and therefore requires its own exact-artifact goal_amend approval receipt (§5.6), carried as approval.goals_amend');
    }
    const gr = validateUserApprovalReceipt(approval.goals_amend, {
      goalsHash: expected.resultHashes.goals,
      oldGoalsHash: expected.baseHashes.goals,
      purpose: 'goal_amend',
    });
    if (!gr.ok) return fail(`approval.goals_amend is invalid — ${gr.error}`);
    normalized.goals_amend = gr.normalized;
  }
  return { ok: true, normalized };
}

// ---------------------------------------------------------------------------
// Transaction document
// ---------------------------------------------------------------------------

export function promotionDocPath(statePath, transactionId) {
  return path.join(
    path.dirname(path.resolve(statePath)),
    `${PROMOTION_DOC_PREFIX}${transactionId}.json`
  );
}

function validateTransactionId(transactionId) {
  if (typeof transactionId !== 'string' || !TRANSACTION_ID_RE.test(transactionId)) {
    throw new Error(`transaction_id must match ${TRANSACTION_ID_RE} (got ${JSON.stringify(transactionId)}) — it interpolates into a ref name and a bundle filename`);
  }
  return transactionId;
}

function readDoc(statePath, transactionId) {
  const docPath = promotionDocPath(statePath, transactionId);
  if (!fs.existsSync(docPath)) {
    throw new Error(`no promotion transaction ${JSON.stringify(transactionId)} on this bundle (expected ${docPath}) — begin one first, or recover an existing one`);
  }
  return JSON.parse(fs.readFileSync(docPath, 'utf8'));
}

function writeDoc(statePath, transactionId, doc) {
  const docPath = promotionDocPath(statePath, transactionId);
  const tmp = `${docPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, docPath);
}

// ---------------------------------------------------------------------------
// Exactly-once recording (transaction_id-keyed)
// ---------------------------------------------------------------------------

function loadEvents(statePath) {
  const eventsPath = path.join(path.dirname(path.resolve(statePath)), 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

const promotionEvent = (events, transactionId) =>
  events.find((e) => e.type === 'spec_amended' && e.data?.transaction_id === transactionId) ?? null;

const lastGoalAmended = (events) => {
  const amended = events.filter((e) => e.type === 'goal_amended');
  return amended[amended.length - 1] ?? null;
};

// ---------------------------------------------------------------------------
// Base pinning (§5.6: the pre-image is recoverable, not merely identified)
// ---------------------------------------------------------------------------

function pinBase(exec, repoRoot, transactionId, role, artifactPath) {
  // `hash-object -w` writes the base bytes as a git object; `update-ref` pins it against
  // gc. A base pinned this way survives `git gc --prune=now` — the ref keeps the object
  // reachable, so the diff can always be re-applied to the true base.
  const oid = gitExec(exec, repoRoot, ['hash-object', '-w', '--', artifactPath]);
  if (!/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`pinning base ${role}.md failed: ${JSON.stringify(oid)} is not an object id`);
  }
  const ref = `${PROMOTION_REFS_PREFIX}${transactionId}/${role}-base`;
  gitExec(exec, repoRoot, ['update-ref', ref, oid]);
  return { ref, object_id: oid };
}

function readPinnedBase(exec, repoRoot, objectId) {
  // RAW: the pinned base is exact bytes — a trailing newline is part of the artifact
  // identity the approval bound, and a trimmed read would break the reproduction proof.
  return gitExec(exec, repoRoot, ['cat-file', 'blob', objectId], { raw: true });
}

// ---------------------------------------------------------------------------
// The §5.6 amendment structural guards, reused from the existing machinery
// ---------------------------------------------------------------------------

// validateAmendment over the goals half: stable ids, tombstoned removals, immutable
// anchor — the same structural rules `mp goals-amend` enforces, so the transaction is
// not a weaker side door into the goal set.
function checkGoalsAmendment(baseGoalsText, resultGoalsText) {
  const oldDoc = parseGoals(baseGoalsText);
  const newDoc = parseGoals(resultGoalsText);
  const v = validateAmendment(oldDoc.goals, newDoc.goals, { anchorSeed: oldDoc.topicSeed });
  if (!v.ok) return v;
  return { ok: true, newDoc };
}

// ---------------------------------------------------------------------------
// begin — validate, prove, pin, and durably record the transaction (before any mutation)
// ---------------------------------------------------------------------------

/**
 * Begin the promotion transaction: verify the bases on disk are the ones the approval
 * was produced against, PROVE the diff reproduces both approved result hashes in memory
 * (before anything is written), validate the goals amendment's structure and its own
 * goal_amend receipt, pin both bases by ref against gc, and write the durable
 * transaction document (state 'prepared'). Nothing else is written — spec.md and
 * goals.md are untouched until commitPromotion.
 */
export function beginPromotion({
  statePath, transactionId, diff, resultSpec, resultGoals, approval, reason, now, exec,
} = {}) {
  if (!statePath) throw new Error('beginPromotion: statePath is required');
  validateTransactionId(transactionId);
  if (typeof diff !== 'string') throw new Error('beginPromotion: the amendment diff is required');
  if (typeof resultSpec !== 'string') throw new Error('beginPromotion: the resulting spec.md bytes are required');
  if (typeof resultGoals !== 'string') throw new Error('beginPromotion: the resulting goals.md bytes are required');
  const bundleDir = path.dirname(path.resolve(statePath));
  // Fail-closed re-begin: an existing document for this transaction_id is a begun
  // (or half-completed) transaction — the entry path routes it through recovery, and a
  // direct begin must never overwrite the durable record of a prior attempt.
  const existingDocPath = promotionDocPath(statePath, transactionId);
  if (fs.existsSync(existingDocPath)) {
    throw new Error(`beginPromotion: a promotion transaction ${JSON.stringify(transactionId)} already exists (${existingDocPath}) — promoteAmendment routes it through recovery; never re-begin over a durable transaction`);
  }
  const readArtifact = (role) => {
    try {
      return fs.readFileSync(path.join(bundleDir, `${role}.md`), 'utf8');
    } catch (e) {
      throw new Error(`beginPromotion: base ${role}.md is unreadable (${e.message}) — an approval binds bytes that must be present to bind`);
    }
  };
  const baseSpec = readArtifact('spec');
  const baseGoals = readArtifact('goals');
  const baseHashes = { spec: sha256Of(baseSpec), goals: sha256Of(baseGoals) };
  const resultHashes = { spec: sha256Of(resultSpec), goals: sha256Of(resultGoals) };
  const diffDigest = sha256Of(diff);

  // The bases on disk must BE the approved bases; a drifted disk needs a fresh approval.
  const av = validatePromotionApproval(approval, { transactionId, baseHashes, resultHashes, diffDigest });
  if (!av.ok) throw new Error(`beginPromotion: invalid promotion approval — ${av.error}`);

  // The reproduction proof: apply the diff to the bases IN MEMORY and compare against
  // both approved result hashes. A diff that does not reproduce them is invalid and
  // refuses before anything is written.
  const applied = {};
  for (const role of ROLES) {
    const res = applyUnifiedDiff(role === 'spec' ? baseSpec : baseGoals, diff, role);
    if (!res.ok) throw new Error(`beginPromotion: the diff does not apply to the approved base ${role}.md — ${res.error}`);
    if (sha256Of(res.text) !== resultHashes[role]) {
      throw new Error(
        `beginPromotion: applying the diff to the bases does not reproduce the approved resulting ${role}.md hash ` +
        `(${sha256Of(res.text)} != ${resultHashes[role]}) — the amendment is invalid and refuses before anything is written (§5.6)`
      );
    }
    applied[role] = res.text;
  }

  // Every file the diff touches must be one of the pair; a diff reaching outside the
  // bound artifacts would launder an unapproved edit through the transaction.
  const parsed = parseUnifiedDiff(diff);
  for (const f of parsed.files) {
    if (!ROLES.some((r) => rolePathMatches(f.newPath, r) || rolePathMatches(f.oldPath, r))) {
      throw new Error(`beginPromotion: the diff touches ${JSON.stringify(f.newPath)}, which is neither spec.md nor goals.md — the transaction binds the pair only`);
    }
  }

  // The goals half keeps the existing amend machinery's structural guarantees.
  const goalsChanged = resultHashes.goals !== baseHashes.goals;
  const goalsCheck = checkGoalsAmendment(baseGoals, resultGoals);
  if (!goalsCheck.ok) throw new Error(`beginPromotion: invalid goals amendment — ${goalsCheck.error}`);

  // Pin both bases by ref against gc (the bases' bytes are on disk and verified equal
  // to the approved bases — pin exactly those bytes).
  const repoRoot = deriveRepoRoot(exec, statePath);
  const pins = {};
  for (const role of ROLES) {
    pins[role] = pinBase(exec, repoRoot, transactionId, role, path.join(bundleDir, `${role}.md`));
  }

  const doc = {
    transaction_id: transactionId,
    state: 'prepared',
    created_at: now === undefined || now === null ? new Date().toISOString() : new Date(now).toISOString(),
    reason: typeof reason === 'string' && reason.trim() !== '' ? reason : null,
    base_hashes: baseHashes,
    result_hashes: resultHashes,
    base_pins: pins,
    diff_digest: diffDigest,
    diff,
    approval_receipt_id: av.normalized.approval_receipt_id,
    approval: av.normalized,
    goals_changed: goalsChanged,
    // The goals-lineage evidence hash (goalsHash of the base) the existing consumers
    // compare with — recorded so the goal_amended event and the invalidated-receipt count
    // speak the EXISTING family, never the artifact sha256 the approval binds.
    base_goals_evidence_hash: goalsHash(baseGoals),
    result_goals_evidence_hash: goalsHash(resultGoals),
  };
  writeDoc(statePath, transactionId, doc);
  return {
    ok: true,
    transaction_id: transactionId,
    state: 'prepared',
    base_hashes: baseHashes,
    result_hashes: resultHashes,
    diff_digest: diffDigest,
    base_pins: pins,
    doc_path: promotionDocPath(statePath, transactionId),
  };
}

// ---------------------------------------------------------------------------
// The shared completion tail (recovery and commit converge here)
// ---------------------------------------------------------------------------

// The decision table's classification for one artifact. An unchanged artifact (base ==
// result) is `satisfied` ONLY while the disk still BE its approved base — the unchanged
// digest never waives the drift check: disk bytes that are neither the base nor the
// result are `neither` (the symmetric refusal), whatever the diff touches.
function classifyArtifact(diskDigest, base, result) {
  if (base === result) return diskDigest === base ? 'satisfied' : 'neither';
  if (diskDigest === base) return 'base';
  if (diskDigest === result) return 'result';
  return 'neither';
}

// Exported for the decision-table unit contract in tests.
export { classifyArtifact };

// Read the recoverable base bytes: the pinned git object first (the durable pre-image),
// the disk bytes second — valid only where the disk already classifies as that base
// ('satisfied' implies diskDigest === base, so it qualifies identically).
function recoverBaseBytes(exec, repoRoot, role, pin, diskBytes, diskClass) {
  try {
    return readPinnedBase(exec, repoRoot, pin.object_id);
  } catch (e) {
    if (diskClass === 'base' || diskClass === 'satisfied') return diskBytes;
    throw new Error(`the pinned base ${role}.md is unreadable (${e.message}) and the disk bytes are not the base — the pre-image is unrecoverable`);
  }
}

// Append the goal_amended + spec_amended records (exactly-once) and converge the goals
// cache. Returns what it appended.
//
// TWO HASH FAMILIES, never confused (§5.5): the transaction binds ARTIFACT identity
// (exact bytes — sha256, what the approval bound), while the goals lineage (goal_amended
// data.goals_hash and state.goals_md_hash) is the EXISTING evidence identity
// (lib/goals.mjs goalsHash — the canonical hash mp goals-amend writes). The lineage
// consumers — committedGoalsHash, the split-brain guard, goals-status — compare with
// goalsHash, so the promotion keeps that family intact.
function recordTransaction({ statePath, doc, resultGoalsText, now }) {
  const events = loadEvents(statePath);
  const appended = [];
  // The result goals.md BYTES this record converges from: the applied bytes when the
  // caller has them, else the on-disk artifact — valid only where recovery already
  // classified it as the approved result.
  const resultText = resultGoalsText ?? readGoalsResult(statePath);
  const goalsEvidenceHash = doc.goals_changed ? goalsHash(resultText) : null;
  const newGoalsDoc = doc.goals_changed ? parseGoals(resultText) : null;
  // goal_amended: only when the amendment changes goals.md, and only once (the
  // idempotent roll-forward: the lineage's latest hash already at the result hash means
  // the event landed before the crash).
  if (doc.goals_changed) {
    const last = lastGoalAmended(events);
    const alreadyRecorded = last?.data?.new_goals_hash === goalsEvidenceHash;
    if (!alreadyRecorded) {
      const invalidated = events.filter(
        (e) =>
          (e.type === 'goal_check' || e.type === 'goal_waived') &&
          (e.data?.goals_hash === doc.base_goals_evidence_hash ||
            e.data?.receipt?.goals_hash === doc.base_goals_evidence_hash ||
            e.data?.waiver?.goals_hash === doc.base_goals_evidence_hash)
      ).length;
      appendEvent(statePath, {
        type: 'goal_amended',
        ts: new Date(now ?? Date.now()).toISOString(),
        data: {
          old_goals_hash: doc.base_goals_evidence_hash,
          new_goals_hash: goalsEvidenceHash,
          goals_hash: goalsEvidenceHash,
          reason: doc.reason ?? doc.approval_receipt_id,
          changes: [],
          invalidated_receipts: invalidated,
          approval: doc.approval.goals_amend ?? null,
        },
        summary: `goals amended by promotion ${doc.transaction_id} ${doc.base_goals_evidence_hash} -> ${goalsEvidenceHash}`,
      });
      appended.push('goal_amended');
    }
  }
  // The promotion record: exactly-once by transaction_id.
  if (!promotionEvent(events, doc.transaction_id)) {
    appendEvent(statePath, {
      type: 'spec_amended',
      ts: new Date(now ?? Date.now()).toISOString(),
      data: {
        transaction_id: doc.transaction_id,
        base_hashes: doc.base_hashes,
        result_hashes: doc.result_hashes,
        diff_digest: doc.diff_digest,
        approval_receipt_id: doc.approval_receipt_id,
        state: 'recorded',
      },
      summary: `spec+goals promoted by transaction ${doc.transaction_id} (${doc.base_hashes.spec} / ${doc.base_hashes.goals} -> ${doc.result_hashes.spec} / ${doc.result_hashes.goals})`,
    });
    appended.push('spec_amended');
  }
  // Converge the derived goals cache + the durable hash (mirrors mp goals-amend's
  // writeState; no-op when the amendment left goals.md unchanged).
  const state = readState(statePath);
  writeState(statePath, {
    ...state,
    ...(newGoalsDoc ? { goals: newGoalsDoc.goals, goals_md_hash: goalsEvidenceHash } : {}),
  });
  return appended;
}

// The on-disk result goals.md — the crash-recovery path's result bytes (the disk
// artifact already classified as the approved result there).
function readGoalsResult(statePath) {
  const bundleDir = path.dirname(path.resolve(statePath));
  return fs.readFileSync(path.join(bundleDir, 'goals.md'), 'utf8');
}

// Whether the derived goals cache (state.goals_md_hash) already converged to this
// transaction's result. The REPLAY path's only incomplete-convergence test (§5.6):
// a crash after the exactly-once terminal event but before the state write leaves the
// cache stranded — the event's data, not the doc's state field, is the authority.
// A LATER goal_amended (a subsequent amendment on top of this one) supersedes the
// result hash legitimately and is NOT unconverged — convergence must never rewind
// a newer lineage hash to this transaction's older one.
function goalsCacheUnconverged({ statePath, doc, events }) {
  if (!doc.goals_changed) return false;
  const state = readState(statePath);
  if (state.goals_md_hash === doc.result_goals_evidence_hash) return false;
  const last = lastGoalAmended(events);
  if (last?.data?.new_goals_hash === doc.result_goals_evidence_hash) return true;
  // A newer lineage hash on top: legitimate supersession, not stranded convergence.
  return false;
}

// Complete the replay path's incomplete state convergence under the held lock: the
// recorded event's data is the authority. The result bytes come from the disk artifact
// when it is the approved result (the usual crash shape), else re-proved from the pinned
// base + the durable diff — never a guess. Appends NOTHING (the event is the commit
// point and it already landed); only the derived cache converges.
function replayConvergeGoalsCache({ statePath, doc, exec }) {
  const bundleDir = path.dirname(path.resolve(statePath));
  let resultText;
  try {
    resultText = readGoalsResult(statePath);
  } catch {
    resultText = null;
  }
  if (resultText === null || sha256Of(resultText) !== doc.result_hashes.goals) {
    // The disk is not the approved result: reconstruct it from the durable pre-image +
    // the diff, proven against the approved result hash exactly as recovery does.
    const repoRoot = deriveRepoRoot(exec, statePath);
    const base = recoverBaseBytes(exec, repoRoot, 'goals', doc.base_pins.goals, resultText ?? '', null);
    const res = applyUnifiedDiff(base, doc.diff, 'goals');
    if (!res.ok || sha256Of(res.text) !== doc.result_hashes.goals) {
      throw new Error(`the goals cache is unconverged for promotion ${doc.transaction_id} and the durable diff no longer reproduces the approved result — the operator decides (§5.6)`);
    }
    resultText = res.text;
  }
  const state = readState(statePath);
  writeState(statePath, {
    ...state,
    goals: parseGoals(resultText).goals,
    goals_md_hash: goalsHash(resultText),
  });
  return true;
}

// The shared exactly-once replay: the recorded transaction replays as a no-op — after
// completing any incomplete state convergence under the held lock. The terminal event is
// the commit point and already landed; the replay never re-writes an artifact and never
// double-appends, but a crash between the event and the state write (goals cache + doc)
// would otherwise strand the cache forever, so the replay is the completion path for it.
function replayRecorded({ statePath, doc, self, now, exec }) {
  const transactionId = doc.transaction_id;
  const events = loadEvents(statePath);
  const unconverged = goalsCacheUnconverged({ statePath, doc, events });
  let converged = false;
  if (unconverged) {
    const bundleDir = path.dirname(path.resolve(statePath));
    const lock = guardOwnerLock(bundleDir, self, now);
    if (lock.refused) {
      return {
        outcome: 'lock_refused',
        reason: lock.reason ?? lock.outcome,
        incumbent: lock.incumbent,
        writes: [],
        appended: [],
        note: 'the goals cache is unconverged and the bundle write lock is held across the convergence — a live foreign owner is refused with zero writes',
      };
    }
    converged = replayConvergeGoalsCache({ statePath, doc, exec });
  }
  if (doc.state !== 'recorded') {
    writeDoc(statePath, transactionId, { ...doc, state: 'recorded' });
  }
  return {
    outcome: 'recorded',
    replay: true,
    transaction_id: transactionId,
    writes: [],
    appended: [],
    ...(converged ? { converged_goals_cache: true } : {}),
  };
}

// The Guard D acquisition every mutating path performs: held-across-both-writes-and-
// the-record, ZERO writes on refusal. Returns the acquisition outcome or null on refusal.
function guardOwnerLock(bundleDir, self, now) {
  if (!self) {
    throw new Error('the promotion transaction requires an owner identity (self) — the bundle write lock is held across both writes and the record');
  }
  const acq = acquireOwner(bundleDir, self, { now: Number.isFinite(Number(now)) ? Number(now) : Date.now() });
  if (!LOCK_OK_OUTCOMES.includes(acq.outcome)) {
    return { refused: true, outcome: acq.outcome, reason: acq.reason, incumbent: acq.incumbent ?? null };
  }
  return { refused: false, outcome: acq.outcome };
}

// ---------------------------------------------------------------------------
// commit — the expected-revision check, both writes, and the record, under one lock
// ---------------------------------------------------------------------------

/**
 * Commit a begun promotion: the bundle write lock held ACROSS BOTH WRITES AND THE
 * RECORD (a competing writer is serialized, a live foreign owner refused with zero
 * writes); the expected-revision check immediately before mutation (re-read both
 * artifacts, confirm digests still equal the approved bases — a mid-flight edit aborts
 * before any write); the reproduction proof re-proven in memory; then spec.md and
 * goals.md written (tmp+rename), the doc advanced, the goals cache converged, and the
 * exactly-once records appended.
 */
export function commitPromotion({ statePath, transactionId, self, now, exec } = {}) {
  if (!statePath) throw new Error('commitPromotion: statePath is required');
  validateTransactionId(transactionId);
  const doc = readDoc(statePath, transactionId);
  const bundleDir = path.dirname(path.resolve(statePath));

  // Exactly-once replay: a transaction whose record already landed is a no-op — never
  // a second write — but a crash between the event and the state convergence completes
  // that convergence here, under the held lock (the event's data is the authority).
  if (promotionEvent(loadEvents(statePath), transactionId)) {
    return replayRecorded({ statePath, doc, self, now, exec });
  }

  // Guard D: the bundle write lock, held across both writes and the record.
  const lock = guardOwnerLock(bundleDir, self, now);
  if (lock.refused) {
    return {
      outcome: 'lock_refused',
      reason: lock.reason ?? lock.outcome,
      incumbent: lock.incumbent,
      writes: [],
      note: 'the bundle write lock is held across both writes and the record — a live foreign owner is refused with zero writes',
    };
  }

  // Expected-revision check, immediately before mutation: re-read both artifacts and
  // confirm they are still the approved bases. A mid-flight edit aborts; neither file
  // is touched.
  const disk = {};
  const classifications = {};
  for (const role of ROLES) {
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(bundleDir, `${role}.md`), 'utf8');
    } catch (e) {
      return { outcome: 'base_unreadable', artifact: role, reason: e.message, writes: [], note: 'the expected-revision check could not read the base — nothing was written' };
    }
    disk[role] = bytes;
    classifications[role] = classifyArtifact(sha256Of(bytes), doc.base_hashes[role], doc.result_hashes[role]);
    if (classifications[role] === 'neither') {
      return {
        outcome: 'base_drifted',
        artifact: role,
        expected: doc.base_hashes[role],
        actual: sha256Of(bytes),
        writes: [],
        note: 'the expected-revision check found an artifact that is neither the approved base nor the approved result — an intervening edit invalidates the approval; a fresh one is required',
      };
    }
    if (classifications[role] !== 'base' && classifications[role] !== 'satisfied') {
      // The disk already holds the approved result (a prior attempt's write, or a torn
      // commit): leave recovery's decision table to complete it — a commit re-entry is
      // the same transaction, and recoverPromotion is the convergent path.
      return recoverFromDoc({ statePath, doc, self, now, exec, via: 'commit-recovery' });
    }
  }

  // The reproduction proof, re-proven in memory before anything is written (closes the
  // begin→commit TOCTOU: the durable diff must still reproduce both approved results).
  const repoRoot = deriveRepoRoot(exec, statePath);
  const applied = {};
  for (const role of ROLES) {
    const baseBytes = recoverBaseBytes(exec, repoRoot, role, doc.base_pins[role], disk[role], classifications[role]);
    const res = applyUnifiedDiff(baseBytes, doc.diff, role);
    if (!res.ok) {
      return { outcome: 'diff_mismatch', artifact: role, reason: res.error, writes: [], note: 'the durable diff no longer reproduces the approved result — refusing before anything is written' };
    }
    if (sha256Of(res.text) !== doc.result_hashes[role]) {
      return {
        outcome: 'diff_mismatch',
        artifact: role,
        writes: [],
        note: `applying the diff does not reproduce the approved resulting ${role}.md hash — the amendment is invalid and refuses before anything is written (§5.6)`,
      };
    }
    applied[role] = res.text;
  }

  // Both writes, tmp+rename (atomic per artifact), then the doc advances.
  const wrote = [];
  for (const role of ROLES) {
    if (classifications[role] === 'satisfied') continue; // the amendment never changed this file
    const target = path.join(bundleDir, `${role}.md`);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, applied[role], 'utf8');
    fs.renameSync(tmp, target);
    wrote.push(role);
  }
  writeDoc(statePath, transactionId, { ...doc, state: 'written' });

  const appended = recordTransaction({
    statePath,
    doc,
    resultGoalsText: applied.goals ?? disk.goals,
    now,
  });
  writeDoc(statePath, transactionId, { ...doc, state: 'recorded' });
  return {
    outcome: 'promoted',
    transaction_id: transactionId,
    writes: wrote,
    appended,
    lock: lock.outcome,
    classifications,
  };
}

// ---------------------------------------------------------------------------
// recover — classify each artifact against its approved identities, apply the table
// ---------------------------------------------------------------------------

function recoverFromDoc({ statePath, doc, self, now, exec, via }) {
  const bundleDir = path.dirname(path.resolve(statePath));
  const transactionId = doc.transaction_id;

  // Exactly-once: a recorded transaction replays as a no-op — completing any
  // incomplete state convergence first (a crash after the event but before the state
  // write would otherwise strand the goals cache forever).
  if (promotionEvent(loadEvents(statePath), transactionId)) {
    return replayRecorded({ statePath, doc, self, now, exec });
  }

  // Guard D — recovery is a mutating path (it writes the remaining artifact and the
  // record), so the lock is held across them exactly as on the commit path.
  const lock = guardOwnerLock(bundleDir, self, now);
  if (lock.refused) {
    return { outcome: 'lock_refused', reason: lock.reason ?? lock.outcome, incumbent: lock.incumbent, writes: [], note: 'recovery holds the bundle write lock across the remaining write and the record' };
  }

  // Hash each artifact on disk and classify it against its OWN approved identities —
  // the state field is advisory; the bytes decide.
  const disk = {};
  const classes = {};
  for (const role of ROLES) {
    try {
      disk[role] = fs.readFileSync(path.join(bundleDir, `${role}.md`), 'utf8');
    } catch (e) {
      return { outcome: 'artifact_unreadable', artifact: role, reason: e.message, writes: [], note: 'recovery cannot classify an unreadable artifact' };
    }
    classes[role] = classifyArtifact(sha256Of(disk[role]), doc.base_hashes[role], doc.result_hashes[role]);
  }

  // The decision table, evaluated top to bottom: the two refusals take precedence and
  // no combination matches twice (§5.6).
  //   neither | any        → refuse (an intervening edit, not a transaction write)
  //   any | neither        → refuse (the same, symmetric)
  if (classes.spec === 'neither') {
    return {
      outcome: 'refused',
      refusal: 'intervening_edit',
      artifact: 'spec',
      classifications: classes,
      writes: [],
      note: 'spec.md matches neither its approved base nor its approved result — an intervening edit, not a transaction write; recovery completes the approved promotion, never rolls one back, and never guesses (§5.6)',
    };
  }
  if (classes.goals === 'neither') {
    return {
      outcome: 'refused',
      refusal: 'intervening_edit',
      artifact: 'goals',
      classifications: classes,
      writes: [],
      note: 'goals.md matches neither its approved base nor its approved result — the same refusal, symmetric; a partial/torn state that is not decidable goes to the operator, never a guess',
    };
  }

  // Reconstruct the durable pre-image: the pinned bases, re-diffed in memory, so the
  // remaining write is the APPROVED bytes, not a re-derived guess.
  const repoRoot = deriveRepoRoot(exec, statePath);
  const baseBytes = {};
  const applied = {};
  for (const role of ROLES) {
    baseBytes[role] = recoverBaseBytes(exec, repoRoot, role, doc.base_pins[role], disk[role], classes[role]);
    const res = applyUnifiedDiff(baseBytes[role], doc.diff, role);
    if (!res.ok || sha256Of(res.text) !== doc.result_hashes[role]) {
      return {
        outcome: 'diff_mismatch',
        artifact: role,
        reason: res.ok ? undefined : res.error,
        writes: [],
        note: 'the durable diff no longer reproduces the approved result — recovery refuses rather than writing derived bytes',
      };
    }
    applied[role] = res.text;
  }

  // Table rows 3-6:
  //   base/satisfied | base/satisfied       → no writes landed — apply the diff, then record
  //   result/satisfied | base/satisfied     → torn — write the remaining file, then record
  //   base/satisfied | result/satisfied      → torn, other order — write the remaining file
  //   result/satisfied | result/satisfied   → writes completed — record
  const isUnwritten = (c) => c === 'base' || c === 'satisfied';
  const wrote = [];
  for (const role of ROLES) {
    if (isUnwritten(classes[role])) {
      // 'satisfied' never contributes: an unchanged artifact is never rewritten.
      if (classes[role] === 'satisfied') continue;
      const target = path.join(bundleDir, `${role}.md`);
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, applied[role], 'utf8');
      fs.renameSync(tmp, target);
      wrote.push(role);
    }
  }
  writeDoc(statePath, transactionId, { ...doc, state: 'written' });
  const appended = recordTransaction({
    statePath,
    doc,
    resultGoalsText: applied.goals ?? disk.goals,
    now,
  });
  writeDoc(statePath, transactionId, { ...doc, state: 'recorded' });
  return {
    outcome: 'recovered',
    via,
    transaction_id: transactionId,
    classifications: classes,
    writes: wrote,
    appended,
    lock: lock.outcome,
  };
}

/**
 * Recover a promotion transaction. Recovery does not trust the doc's state field
 * alone: it hashes each artifact on disk and classifies it against its approved
 * identities, applies the decision table, and REFUSES symmetrically when either
 * artifact is neither its base nor its result — a partial/torn state that is not
 * decidable goes to the operator, never a guess. An unchanged artifact (base hash ==
 * result hash) is `satisfied` and never contributes a torn state.
 */
export function recoverPromotion({ statePath, transactionId, self, now, exec } = {}) {
  if (!statePath) throw new Error('recoverPromotion: statePath is required');
  validateTransactionId(transactionId);
  const doc = readDoc(statePath, transactionId);
  return recoverFromDoc({ statePath, doc, self, now, exec, via: 'recover' });
}