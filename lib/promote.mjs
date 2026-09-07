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

import { readState, writeState, appendEvent, resolveFormatPin, repairFormatPin } from './bundle.mjs';
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

// §6.1: the goals-lineage evidence hash under the bundle's DURABLE format pin — the
// same pin every goals-lineage consumer (committedGoalsHash through pinnedGoalsHash,
// the split-brain guard, the checkpoint identity's goals_hash) dispatches on. A missing
// pin with a capture event is REPAIRED from that history (the §6.1 sanctioned repair,
// idempotent); anything else fails closed — an UNPINNED hash is a DIFFERENT identity from
// the pinned one, and recording one breaks the lineage the consumers compare against.
export function pinnedGoalsEvidenceHash(statePath, goalsMdText) {
  let pin = resolveFormatPin(statePath);
  if (!pin.pin && pin.repairable) {
    try {
      repairFormatPin(statePath);
      pin = resolveFormatPin(statePath);
    } catch (e) {
      throw new Error(`beginPromotion: the durable format pin is missing and could not be repaired from the capture history (${e.message}) — the goals lineage cannot hash under it`);
    }
  }
  if (!pin.pin) {
    throw new Error(
      `the durable format pin could not be resolved (${pin.repairable ? 'the repair from the capture history failed' : (pin.error ?? 'unknown pin state')}) — the promotion's goals lineage must hash under the SAME pin every consumer dispatches on (§6.1), never an unpinned default`
    );
  }
  return goalsHash(goalsMdText, { formatPin: pin.pin });
}

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
// §5.6 revalidation — commit/recovery/replay REVALIDATE before any mutation
// ---------------------------------------------------------------------------

/**
 * Revalidate a durable transaction document before commit/recovery/replay mutates
 * anything. The doc was validated at BEGIN, but it is durable bytes on disk, and the
 * interval between begin and a later entry is unbounded — a tampered diff, a rewritten
 * result hash, or a swapped approval receipt must refuse (the symmetric refusal), never
 * proceed on the tampered fields. Everything the commit path relies on is re-derived
 * from the doc's own bytes and re-checked against BOTH the doc's recorded fields AND
 * the on-disk bases:
 *
 *   - the doc's own identity (transaction_id, base/result hashes, diff digest)
 *   - the APPROVAL BINDING: the approval receipt's base_hashes/result_hashes/diff_digest
 *     against the DOC's recorded fields — an approval for different bytes never
 *     authorizes this transaction (validatePromotionApproval, the same validator begin
 *     used, now over the durable doc's fields as the expected side)
 *   - the actual durable diff recomputes to the doc's diff_digest — a hand-edited diff
 *     cannot launder unapproved result bytes through a stale digest
 *   - the base pins still pin the approved bases (the ref's object still hashes to the
 *     recorded base hash — the pre-image is what recovery re-derives the results from)
 *
 * Throws (never returns a partial outcome): every failure is a refusal before mutation.
 */
function revalidateTransactionDoc(statePath, doc, { exec } = {}) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('the promotion transaction document is malformed (not an object) — refusing to act on it (§5.6)');
  }
  validateTransactionId(doc.transaction_id);
  if (typeof doc.diff !== 'string' || doc.diff.trim() === '') {
    throw new Error(`the durable transaction ${JSON.stringify(doc.transaction_id)} carries no diff — the pre-image cannot be re-proven, refusing (§5.6)`);
  }
  for (const role of ROLES) {
    if (!/^sha256:[0-9a-f]{64}$/.test(String(doc.base_hashes?.[role]))) {
      throw new Error(`the durable transaction ${JSON.stringify(doc.transaction_id)} carries a malformed base_hashes.${role} — refusing to act on it (§5.6)`);
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(String(doc.result_hashes?.[role]))) {
      throw new Error(`the durable transaction ${JSON.stringify(doc.transaction_id)} carries a malformed result_hashes.${role} — refusing to act on it (§5.6)`);
    }
  }
  // The durable diff is the transaction's own proof input: it must still digest to the
  // recorded diff_digest. A hand-edit here (rewriting the diff to produce UNAPPROVED
  // result bytes) refuses before anything is written.
  const actualDiffDigest = sha256Of(doc.diff);
  if (actualDiffDigest !== doc.diff_digest) {
    throw new Error(
      `the durable transaction ${JSON.stringify(doc.transaction_id)}'s diff does not match its recorded diff_digest (${actualDiffDigest} != ${doc.diff_digest}) — the diff was edited after begin, and the transaction refuses rather than applying tampered bytes (§5.6)`
    );
  }
  // The goals-lineage evidence hashes are a CACHE of the pinned hash of the approval-bound
  // bytes, never an independent claim (gate iteration 3's finding: a tamperer who rewrote ONLY
  // result_goals_evidence_hash — leaving the approval-bound result_hashes.goals intact —
  // laundered unapproved bytes through the supersession check, because nothing bound the
  // evidence-hash field to anything revalidateTransactionDoc verified). Both lineage halves
  // are RE-DERIVED from the durable pre-image + the diff, proven against the approval-bound
  // artifact hashes, and compared: the base evidence hash from the pinned base bytes, the
  // result evidence hash from the reconstructed approval-bound result bytes.
  if (typeof doc.base_goals_evidence_hash === 'string' || typeof doc.result_goals_evidence_hash === 'string') {
    if (typeof doc.base_goals_evidence_hash !== 'string' || typeof doc.result_goals_evidence_hash !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(doc.base_goals_evidence_hash) || !/^sha256:[0-9a-f]{64}$/.test(doc.result_goals_evidence_hash)) {
      throw new Error(`the durable transaction ${JSON.stringify(doc.transaction_id)} carries malformed goals-evidence hashes — refusing to act on it (§5.6)`);
    }
    const repoRoot = deriveRepoRoot(exec, statePath);
    const baseText = recoverBaseBytes(exec, repoRoot, 'goals', doc.base_pins?.goals, '', null);
    if (sha256Of(baseText) !== doc.base_hashes.goals) {
      throw new Error(`the durable transaction ${JSON.stringify(doc.transaction_id)}'s pinned base no longer reproduces its recorded base hash — the pre-image is unrecoverable, refusing (§5.6)`);
    }
    if (pinnedGoalsEvidenceHash(statePath, baseText) !== doc.base_goals_evidence_hash) {
      throw new Error(`the durable transaction ${JSON.stringify(doc.transaction_id)}'s base_goals_evidence_hash does not bind its pinned base bytes — the lineage cache was edited after begin, refusing (§5.6)`);
    }
    const res = applyUnifiedDiff(baseText, doc.diff, 'goals');
    if (!res.ok || sha256Of(res.text) !== doc.result_hashes.goals) {
      throw new Error(`the durable transaction ${JSON.stringify(doc.transaction_id)}'s diff does not reproduce its approval-bound result hash — refusing (§5.6)`);
    }
    if (pinnedGoalsEvidenceHash(statePath, res.text) !== doc.result_goals_evidence_hash) {
      throw new Error(`the durable transaction ${JSON.stringify(doc.transaction_id)}'s result_goals_evidence_hash does not bind its approval-bound result bytes — the lineage cache was edited after begin (the gate iteration-3 tamper), refusing (§5.6)`);
    }
  }
  // The approval binding, revalidated against the DOC's own recorded fields (and through
  // them the on-disk bases, which the decision table/classification checks separately):
  // an approval whose bases/results/diff_digest do not bind the durable transaction
  // never authorized it.
  const av = validatePromotionApproval(doc.approval, {
    transactionId: doc.transaction_id,
    baseHashes: doc.base_hashes,
    resultHashes: doc.result_hashes,
    diffDigest: doc.diff_digest,
  });
  if (!av.ok) {
    throw new Error(
      `the durable transaction ${JSON.stringify(doc.transaction_id)}'s approval receipt no longer binds its recorded fields — ${av.error}; refusing (the symmetric refusal, never a guess and never unapproved writes) (§5.6)`
    );
  }
  // The base pins: each pinned object must still BE the approved base (the recorded
  // base hash). A pin that moved (a rewritten object, a retargeted ref) leaves the
  // pre-image unrecoverable-as-approved — the reproduction proof below would then
  // produce bytes that are NOT the approved results, so refuse here.
  const repoRoot = deriveRepoRoot(exec, statePath);
  for (const role of ROLES) {
    const pin = doc.base_pins?.[role];
    if (!pin || typeof pin.ref !== 'string' || !/^[0-9a-f]{40}$/.test(String(pin.object_id))) {
      throw new Error(`the durable transaction ${JSON.stringify(doc.transaction_id)} carries no valid ${role}-base pin — the pre-image cannot be re-derived from the recorded base bytes (§5.6)`);
    }
    let pinnedBytes;
    try {
      pinnedBytes = readPinnedBase(exec, repoRoot, pin.object_id);
    } catch (e) {
      throw new Error(`the pinned base ${role}.md is unreadable (${e.message}) — the pre-image is unrecoverable and the transaction refuses (§5.6)`);
    }
    if (sha256Of(pinnedBytes) !== doc.base_hashes[role]) {
      throw new Error(
        `the pinned base ${role}.md does not match the recorded base hash — the ref no longer pins the approved pre-image, refusing (§5.6)`
      );
    }
  }
  return true;
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

/**
 * §5.6 (task 55, review round 2): a terminal `spec_amended` event counts as the COMMIT
 * POINT only when it is structurally valid and FULLY transaction-bound — the same field
 * set `recordTransaction` itself appends. A hand-appended `{type:'spec_amended',
 * data:{transaction_id}}` names the transaction and nothing else: it binds no bases, no
 * results, no diff digest, no approval receipt, and must NOT suppress the real
 * promotion — the transaction proceeds through its decision table instead. The
 * validated event must mirror, member for member, what the real recorder appends:
 *   - data.transaction_id, base_hashes, result_hashes, diff_digest,
 *     approval_receipt_id — each deep-equal the durable doc's recorded fields
 *   - data.state === 'recorded'
 */
function validatedPromotionEvent(events, doc) {
  for (const e of [...events].reverse()) {
    if (e?.type !== 'spec_amended' || e.data?.transaction_id !== doc.transaction_id) continue;
    const d = e.data ?? {};
    const binds =
      d.state === 'recorded' &&
      d.approval_receipt_id === doc.approval_receipt_id &&
      d.diff_digest === doc.diff_digest &&
      d.base_hashes?.spec === doc.base_hashes.spec &&
      d.base_hashes?.goals === doc.base_hashes.goals &&
      d.result_hashes?.spec === doc.result_hashes.spec &&
      d.result_hashes?.goals === doc.result_hashes.goals;
    if (binds) return e;
    // An event that names the transaction but binds none of it is ignored as a commit
    // point — a forged or incomplete event never completes an unfinished promotion.
  }
  return null;
}

/**
 * Whether the transaction's commit point is REALLY reached: a validated terminal event
 * AND the artifacts actually at their approved results (§5.6 — the cross-check that
 * makes a forged event inert even when its fields were copied from the durable doc: a
 * transaction whose spec.md is still at its BASE was never promoted, whatever the
 * ledger claims). EVERY covered artifact is inspected — the UNCHANGED half included
 * (pre-publish review finding 2): an unchanged artifact (base == result) whose bytes
 * no longer equal the approved base is DRIFT, not convergence — the base===result
 * shortcut previously skipped it entirely, so a mutated goals.md escaped detection and
 * the zero-write replay pass masked the symmetric drift refusal. An artifact that is
 * not at its approved result is accepted ONLY as a recorded supersession — a LATER
 * legitimate amendment event in the ledger names the current disk bytes as its own
 * recorded result — so a legitimate follow-on amendment never reads as an unfinished
 * promotion. Unreadable artifacts mean "not at the approved results"; the normal flow
 * owns the named unreadable-artifact failures.
 */
function commitPointReached(statePath, doc, events) {
  const ev = validatedPromotionEvent(events, doc);
  if (!ev) return { reached: false, event: null };
  const evIndex = events.indexOf(ev);
  const bundleDir = path.dirname(path.resolve(statePath));
  for (const role of ROLES) {
    const unchanged = doc.base_hashes[role] === doc.result_hashes[role];
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(bundleDir, `${role}.md`), 'utf8');
    } catch {
      return { reached: false, event: ev, artifact: role, note: 'unreadable' };
    }
    // The artifact is at its approved result — the commit point holds for this role
    // (an unchanged artifact's base IS its result, so this is the same check either way).
    if (sha256Of(bytes) === doc.result_hashes[role]) continue;
    // Not at the approved result. For the unchanged half this IS the finding the
    // reviewer reproduced: base == result means the approval bound exactly these bytes,
    // so bytes that differ are an intervening edit — drift — never a satisfied artifact.
    // Both halves accept the same single excuse: a LATER RECORDED AND REVALIDATED
    // supersession — a later amendment event that is itself an approved, durable
    // transaction record naming the CURRENT disk bytes as its own approved result
    // (validatedSupersession below: ledger event + durable doc + F6 revalidation +
    // result binding, all cross-checked). A hand-appended amendment event without its
    // durable transaction (the re-review's forged goal_amended) is not a supersession.
    const supersededBy = validatedSupersession(statePath, events, evIndex, role,
      role === 'goals' ? pinnedGoalsEvidenceHash(statePath, bytes) : sha256Of(bytes));
    if (!supersededBy) {
      return {
        reached: false,
        event: ev,
        artifact: role,
        note: unchanged
          ? 'the unchanged artifact no longer equals its approved bytes (base == result) and no supersession names the current bytes — an intervening edit, not convergence'
          : 'not at its approved result and not superseded',
      };
    }
  }
  return { reached: true, event: ev };
}

const lastGoalAmended = (events) => {
  const amended = events.filter((e) => e.type === 'goal_amended');
  return amended[amended.length - 1] ?? null;
};

/**
 * A supersession is accepted ONLY when the later amendment event is itself an approved,
 * durable transaction record (the re-review's finding 1: the events-only hash match
 * accepted a hand-appended goal_amended naming the mutated bytes, and recovery replayed
 * with the unapproved goals still on disk). The proof standard is F6/F7's: the event's
 * summary names the transaction, the transaction's doc EXISTS on disk and REVALIDATES
 * (identity, diff digest, approval binding, base pins — a tampered doc throws and is NOT
 * a supersession), and its approved result for this role is exactly the CURRENT disk
 * bytes. Anything less is drift, and the drift refusal stands.
 */
function validatedSupersession(statePath, events, evIndex, role, currentHash) {
  const kind = role === 'goals' ? 'goal_amended' : 'spec_amended';
  for (let i = evIndex + 1; i < events.length; i++) {
    const e = events[i];
    if (!e || e.type !== kind) continue;
    // Route (a) — a promotion-transaction record: the transaction is named in the event's
    // data (spec_amended carries transaction_id) or summary (goal_amended: 'goals amended
    // by promotion <id>'), its durable doc EXISTS on disk and REVALIDATES, and its approved
    // result for this role is exactly the CURRENT bytes.
    const tid = (e.data && typeof e.data.transaction_id === 'string' && e.data.transaction_id)
      || (/by (?:promotion|transaction) (\S+)/.exec(String(e.summary ?? '')) || [])[1];
    if (tid) {
      try {
        const doc = readDoc(statePath, tid);
        revalidateTransactionDoc(statePath, doc);
        const approved = role === 'goals'
          ? doc.result_goals_evidence_hash
          : doc.result_hashes?.spec;
        if (approved === currentHash) return true;
      } catch {
        // No durable record, or a tampered one — route (a) proves nothing; fall through.
      }
    }
    // Route (b) — the OTHER legitimate goal_amended writer: the interview's goals-amend
    // verb (no promotion transaction — its authorization is the operator-attested approval
    // receipt it records in data.approval). Accept it only by REPLAYING the same validation
    // the write-time gate applied (validateUserApprovalReceipt: attestation, purpose, and
    // the goals_hash binding the CURRENT bytes — a stale/replayed approval fails exactly as
    // the verb itself would refuse it). The event's hash claims alone prove nothing.
    if (role === 'goals' && e.data && typeof e.data.approval === 'object' && e.data.approval !== null) {
      const verdict = validateUserApprovalReceipt(e.data.approval, {
        goalsHash: currentHash,
        oldGoalsHash: typeof e.data.old_goals_hash === 'string' ? e.data.old_goals_hash : undefined,
        purpose: 'goal_amend',
      });
      if (verdict.ok) return true;
    }
  }
  return false;
}

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
    // speak the EXISTING family, never the artifact sha256 the approval binds. §6.1: both
    // lineage halves hash under the bundle's DURABLE format pin — the same pin the
    // consumers (split-brain guard, checkpoint identity) dispatch on, so the recorded
    // lineage and the consumer's recomputation never diverge on the canonicalizer.
    base_goals_evidence_hash: pinnedGoalsEvidenceHash(statePath, baseGoals),
    result_goals_evidence_hash: pinnedGoalsEvidenceHash(statePath, resultGoals),
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
  // §6.1: the lineage hashes under the bundle's DURABLE pin — the SAME pin the doc's
  // evidence hashes were recorded under and every consumer recomputes with. An unpinned
  // hash here records a lineage identity the consumers (split-brain guard, checkpoint
  // identity) never compare equal against.
  const goalsEvidenceHash = doc.goals_changed ? pinnedGoalsEvidenceHash(statePath, resultText) : null;
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
  // The promotion record: exactly-once by transaction_id — counted against the
  // VALIDATED commit-point events only (validatedPromotionEvent), so a forged or
  // incomplete spec_amended event never suppresses the real record.
  if (!validatedPromotionEvent(events, doc)) {
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
    // §6.1: the converged cache hashes under the DURABLE pin — the same identity the
    // doc's result_goals_evidence_hash carries and the consumers compare against.
    goals_md_hash: pinnedGoalsEvidenceHash(statePath, resultText),
  });
  return true;
}

// The shared exactly-once replay: the recorded transaction replays as a no-op — after
// completing any incomplete state convergence under the held lock. The terminal event is
// the commit point and already landed; the replay never re-writes an artifact and never
// double-appends, but a crash between the event and the state write (goals cache + doc)
// would otherwise strand the cache forever, so the replay is the completion path for it.
function replayRecorded({ statePath, doc, self, now, exec }) {
  // §5.6 revalidation BEFORE the replay reads the doc's fields (the convergence hashes
  // against the doc's recorded evidence hashes): a tampered durable doc refuses here,
// never converges a cache from tampered bytes.
  revalidateTransactionDoc(statePath, doc, { exec });
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

  // §5.6 revalidation BEFORE any mutation: the durable doc's identity, the approval
  // binding (the approval's bases/results/diff_digest against BOTH the doc's recorded
  // fields AND the pinned on-disk bases), the durable diff's own digest, and the base
  // pins are all re-proven — a tampered field refuses with zero writes.
  revalidateTransactionDoc(statePath, doc, { exec });

  // Exactly-once replay: a transaction whose COMMIT POINT is really reached (a
  // structurally valid, fully transaction-bound terminal event AND artifacts at their
  // approved results) is a no-op — never a second write — but a crash between the event
  // and the state convergence completes that convergence here, under the held lock (the
  // event's data is the authority). A FORGED terminal event does not count: the
  // transaction proceeds through its normal decision table below.
  if (commitPointReached(statePath, doc, loadEvents(statePath)).reached) {
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

  // §5.6 revalidation BEFORE any mutation: recovery TRUSTS NOTHING — the doc's identity,
  // the approval binding, the durable diff's digest, and the base pins are re-proven
  // before the decision table runs, so a tampered doc refuses (the symmetric refusal)
  // rather than writing UNAPPROVED bytes.
  revalidateTransactionDoc(statePath, doc, { exec });

  // Exactly-once: a transaction whose COMMIT POINT is really reached (a validated,
  // fully-bound terminal event + artifacts at their approved results) replays as a
  // no-op — completing any incomplete state convergence first (a crash after the event
  // but before the state write would otherwise strand the goals cache forever). A
  // FORGED terminal event does not count and falls through to the table.
  if (commitPointReached(statePath, doc, loadEvents(statePath)).reached) {
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