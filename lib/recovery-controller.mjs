// lib/recovery-controller.mjs — committed-recovery controller mode.
//
// The audit continuation HOLD (/home/ras/.pi-tmp/wave2-recovery/audit-continuation-hold.md)
// requires an explicit, opt-in path that reviews the RECOVERED COMMIT (frozen base →
// pinned head), not the (empty) working diff of a clean committed recovery. This module
// owns the deterministic capture, the Phase A identity manifest, and the Phase B receipt
// binding for that mode.
//
// Contract (from the judge design / parent acceptance):
//   1. Explicit selection — the caller supplies the expected repository identity and full
//      HEAD OID; base comes ONLY from the frozen review_context.base_sha. Absent/disabled
//      review context fails, never the legacy no-op.
//   2. Validate before capture — single edit locus, canonical repo identity agreement,
//      valid commit objects, exact HEAD equality, base ancestry, clean tree, nonempty delta.
//   3. Deterministic artifact — two-endpoint base→HEAD diff with external diff/textconv
//      disabled and stable binary/full-index formatting; format version + SHA-256 of exact
//      bytes; HEAD + cleanliness read before and after capture; fail on drift.
//   4. Phase A manifest — bundle/run, wave, attempt, frozen-context fingerprint, task,
//      repo, base, head, format, full diff SHA — carried in each review request.
//   5. Receipt binding — Phase B recomputes the expected identity and compares every field
//      before accepting a receipt. Missing bindings are never filled; caller-supplied
//      item.review/digest.review is never authority; legacy SHA-only events never satisfy.
//
// PURE + LOCAL git only (-C-qualified, the same git-in-bin seam as continue/record-result).
// The orchestration (wave-dispatch record reads, review event persistence, ownership) lives
// in lib/dispatch-wave.mjs / lib/task-review.mjs; this module holds the deterministic core.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { stableStringify, sha256hex, diagnosticStringify } from './canonical.mjs';

/** Bump when the capture command or identity schema changes (receipts must match). */
export const RECOVERY_CAPTURE_FORMAT = 'mp-recovery-diff-v1';

/** Canonical repo identity: resolved worktree top-level + common-dir + basename. */
export function canonicalRepoIdentity(repo, _exec = execFileSync) {
  const git = (args) =>
    String(_exec('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  const top = path.resolve(git(['rev-parse', '--show-toplevel']));
  const common = path.resolve(git(['rev-parse', '--git-common-dir']));
  return { root: top, commonDir: common, name: path.basename(top) };
}

/**
 * Deterministic binary full-index base→HEAD diff with external diff/textconv disabled.
 * The two-endpoint form (base..head) is chosen because it is byte-stable across configs:
 * a symmetric `base head` diff can reorder hunks when the endpoints are reversed. -c
 * diff.external= + --no-ext-diff both suppress an external driver; --no-textconv disables
 * textconv; --no-renames, --no-color, --full-index, --binary keep hunk/index lines stable.
 * Returns the EXACT bytes that are SHA-256'd (no trimming).
 */
export function captureCommittedDiff(repo, baseSha, headSha, _exec = execFileSync) {
  const args = [
    '-c', 'core.quotePath=false',
    '-c', 'diff.external=',
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
    '--full-index', '--binary',
    `${baseSha}..${headSha}`,
  ];
  try {
    return String(_exec('git', ['-C', repo, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (err) {
    const stderr = String(err?.stderr ?? '').trim();
    throw new Error(`recovery: git -C ${repo} ${args.join(' ')} failed: ${stderr || err.message}`);
  }
}

/** Clean-tree probe: index + tracked + untracked all clean (porcelain empty). */
export function probeCleanTree(repo, _exec = execFileSync) {
  const out = String(_exec('git', ['-C', repo, '-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  return out.trim() === '';
}

/** Resolve an OID to its full 40-hex commit form; throws if the object is not a commit. */
export function resolveCommitOid(repo, oid, _exec = execFileSync) {
  try {
    const full = String(_exec('git', ['-C', repo, 'rev-parse', '--verify', `${oid}^{commit}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })).trim();
    if (!/^[0-9a-f]{40}$/.test(full)) throw new Error(`recovery: invalid commit OID ${oid}`);
    return full;
  } catch (err) {
    throw new Error(`recovery: ${oid} is not a valid commit in ${repo}: ${String(err?.stderr ?? err.message).trim()}`);
  }
}

export function isAncestor(repo, ancestor, descendant, _exec = execFileSync) {
  try {
    _exec('git', ['-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Frozen-context fingerprint: SHA-256 over the canonical JSON of {enabled, base_sha, tasks}.
 * Binds every recovery identity to the EXACT frozen review_context (task set, repos, base),
 * so a context change between Phase A and Phase B is detected before persistence.
 */
export function fingerprintReviewContext(ctx) {
  const canonical = {
    enabled: ctx?.enabled === true,
    base_sha: typeof ctx?.base_sha === 'string' ? ctx.base_sha : null,
    tasks: Array.isArray(ctx?.tasks)
      ? ctx.tasks.map((t) => ({
          task_id: t?.task_id,
          description: t?.description ?? null,
          class: t?.class ?? null,
          repo: t?.repo ?? null,
        }))
      : [],
  };
  return sha256hex(stableStringify(canonical));
}

/**
 * Reject unknown/duplicate tasks and item↔digest task-id disagreement in the result batch.
 * Throws on the first problem; the whole recovery batch must be validated before any append.
 */
export function validateRecoveryTaskSet(ctx, items) {
  const known = new Map((ctx?.tasks ?? []).map((t) => [String(t.task_id), t]));
  const seen = new Set();
  const errors = [];
  for (const item of items ?? []) {
    const itemId = item?.task_id;
    const digestId = item?.digest?.task_id;
    // Compare via stableStringify (never String()): a Symbol task_id would throw on
    // String(), and an object would read as "[object Object]" — both must fail the
    // scalar check below, not throw a misleading TypeError first. strict stableStringify
    // THROWS on non-JSON candidates (BigInt/circular/symbol/...), so guard the comparison:
    // a non-JSON candidate is not a valid scalar identity and must fail the scalar check
    // with a clear message, not crash the batch.
    if (itemId !== undefined && digestId !== undefined) {
      let disagree = false;
      try {
        disagree = stableStringify(itemId) !== stableStringify(digestId);
      } catch {
        // Non-JSON candidate — fall through to the scalar check below (fail closed).
      }
      if (disagree) {
        errors.push(`task ${diagnosticStringify(itemId)}: item.task_id (${diagnosticStringify(itemId)}) disagrees with digest.task_id (${diagnosticStringify(digestId)})`);
      }
    }
    const id = itemId ?? digestId;
    if (id === undefined || id === null) {
      errors.push('a result item carries no task_id (item or digest)');
      continue;
    }
    // Scalar validation: false/[]/{}/whitespace are NOT valid task ids — they would
    // coerce to bogus keys and could bind a null-echoing receipt. Same positive-integer
    // contract as the identity builder (see validateScalarTaskId).
    const scalarErr = validateScalarTaskId(id, `task ${diagnosticStringify(id)}`);
    if (scalarErr) {
      errors.push(scalarErr);
      continue;
    }
    const key = String(id);
    if (seen.has(key)) errors.push(`task ${key} appears more than once in the result`);
    seen.add(key);
    if (!known.has(key)) errors.push(`task ${key} is not in the frozen review_context task set`);
  }
  if (errors.length) {
    throw new Error(`recovery: task-set validation failed — ${errors.join('; ')}`);
  }
  return true;
}

/**
 * Mandatory identity-field validation (review finding: the builder/receipt could
 * previously compare two nulls as equal — a nullable incomplete expected identity
 * built from a missing upstream field would bind a null-echoing receipt).
 *
 * Real-schema guarantees traced upstream (lib/dispatch-wave.mjs writeRecord / gate):
 *   - bundle/run_id: state.slug / record.run_id (non-empty string)
 *   - wave: state.active_run.wave / result.wave (integer; 0 is LEGITIMATE — never reject)
 *   - attempt: record.attempt (positive integer, set at dispatch: existing? N+1 : 1)
 *   - base/head: full 40-hex commit OIDs (resolved by resolveCommitOid)
 *   - diff_sha / context_fingerprint: sha256 hex (64 hex)
 *   - format: exactly RECOVERY_CAPTURE_FORMAT
 *   - repo: non-empty path
 *   - task_id: the plan's 1-based integer task id (number, or its numeric-string form)
 *
 * Returns an array of human-readable errors; empty means the identity is complete.
 */
export function validateIdentityMandatory(identity) {
  const errors = [];
  const nonEmptyString = (f, v) => {
    if (typeof v !== 'string' || v.trim() === '') errors.push(`identity.${f} must be a non-empty string (got ${diagnosticStringify(v)})`);
  };
  const hex = (f, v, len) => {
    if (typeof v !== 'string' || !new RegExp(`^[0-9a-f]{${len}}$`).test(v)) errors.push(`identity.${f} must be ${len}-hex (got ${diagnosticStringify(v)})`);
  };
  nonEmptyString('bundle', identity?.bundle);
  nonEmptyString('run_id', identity?.run_id);
  if (!Number.isInteger(identity?.wave) || identity.wave < 0) {
    errors.push(`identity.wave must be a non-negative integer (got ${diagnosticStringify(identity?.wave)})`);
  }
  if (!Number.isInteger(identity?.attempt) || identity.attempt < 1) {
    errors.push(`identity.attempt must be a positive integer (got ${diagnosticStringify(identity?.attempt)})`);
  }
  hex('context_fingerprint', identity?.context_fingerprint, 64);
  const taskIdErr = validateScalarTaskId(identity?.task_id, 'identity.task_id');
  if (taskIdErr) errors.push(taskIdErr);
  nonEmptyString('repo', identity?.repo);
  hex('base', identity?.base, 40);
  hex('head', identity?.head, 40);
  if (identity?.format !== RECOVERY_CAPTURE_FORMAT) {
    errors.push(`identity.format must equal ${RECOVERY_CAPTURE_FORMAT} (got ${diagnosticStringify(identity?.format)})`);
  }
  hex('diff_sha', identity?.diff_sha, 64);
  return errors;
}

/**
 * Scalar task-id validation shared by the identity builder, the task-set validator and the
 * receipt comparison (every place a task_id crosses the recovery boundary).
 *
 * CONTRACT (derived, not invented): plan task ids are 1-based POSITIVE integers
 * (docs/conventions/plan-annotations.md — `id` is "integer, 1-based, unique", assigned by
 * lib/plan-merge.mjs as 1..N; validatePlanIndex rejects any non-integer id). The id
 * propagates verbatim into state.yml and the wave-dispatch review_context.task_id
 * (lib/dispatch-wave.mjs). The wave-commit seam additionally accepts a NUMERIC STRING and
 * coerces it via coerceId (lib/wave-commit.mjs) so a string result can match an integer
 * marker — that tolerance is preserved here.
 *
 * A task id must therefore be a SCALAR that denotes a positive integer: a JS number that is
 * a positive integer, or a non-whitespace string of digits that round-trips to one (so
 * "01" is rejected as inconsistent). Everything else — false, [], {}, whitespace, NaN,
 * Infinity, 0, negatives, booleans, objects, floats — is invalid and fails closed.
 */
export function validateScalarTaskId(value, label = 'task_id') {
  const err = (v) => `${label} must be a positive integer (got ${diagnosticStringify(v)})`;
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return null;
    return err(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    // Numeric-string tolerance (mirrors wave-commit coerceId): a string of digits that
    // round-trips to a positive integer is accepted as the SAME scalar id. Reject any
    // leading/trailing whitespace — coerceId does NOT trim, so '1 ' would never match an
    // integer marker and must not be accepted here either.
    if (value === value.trim() && /^[0-9]+$/.test(value)) {
      const n = Number(value);
      if (Number.isSafeInteger(n) && n > 0 && String(n) === value) {
        return null;
      }
    }
    return err(value);
  }
  return err(value);
}

/** Build the Phase A identity manifest for one task (also the expected Phase B receipt identity). */
export function buildRecoveryIdentity({
  bundle, runId, wave, attempt, contextFingerprint, taskId, repo, base, head, diffSha,
}) {
  const identity = {
    bundle,
    run_id: runId,
    wave,
    attempt,
    context_fingerprint: contextFingerprint,
    task_id: taskId,
    repo,
    base,
    head,
    format: RECOVERY_CAPTURE_FORMAT,
    diff_sha: diffSha,
  };
  const errors = validateIdentityMandatory(identity);
  if (errors.length) {
    throw new Error(`recovery: cannot build a complete identity — ${errors.join('; ')}`);
  }
  return identity;
}

/**
 * Phase B receipt binding: every field of the receipt's identity must equal the expected
 * identity recomputed over the CURRENT artifact. Missing bindings are never filled — a
 * receipt without `identity` fails (the reviewer must echo what it actually reviewed).
 */
export function validateRecoveryReceipt(receipt, expected) {
  const fail = (error) => ({ ok: false, error });
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return fail('receipt must be a JSON object');
  }
  const got = receipt.identity;
  if (!got || typeof got !== 'object' || Array.isArray(got)) {
    return fail(`receipt.identity is missing — the review did not bind the artifact it reviewed (expected ${RECOVERY_CAPTURE_FORMAT} identity)`);
  }
  // Mandatory binding: a null/typed-wrong value on EITHER side is a failed binding,
  // never an equal-null pass. The expected identity must be complete (a builder that
  // saw a missing upstream field fails, not null-fills) and the receipt must echo the
  // exact same non-null values.
  const expectedErrors = validateIdentityMandatory(expected);
  if (expectedErrors.length) {
    return fail(`expected identity is incomplete — ${expectedErrors.join('; ')}`);
  }
  const gotErrors = validateIdentityMandatory(got);
  if (gotErrors.length) {
    return fail(`receipt.identity is incomplete — ${gotErrors.join('; ')}`);
  }
  const fields = [
    'bundle', 'run_id', 'wave', 'attempt', 'context_fingerprint', 'task_id',
    'repo', 'base', 'head', 'format', 'diff_sha',
  ];
  for (const f of fields) {
    if (!(f in got)) return fail(`receipt.identity.${f} is missing`);
    if (stableStringify(got[f]) !== stableStringify(expected[f])) {
      return fail(`receipt.identity.${f} ${diagnosticStringify(got[f])} != expected ${diagnosticStringify(expected[f])}`);
    }
  }
  return { ok: true };
}
