// lib/qctl-artifact.mjs — pure artifact-integrity + digest projection for the §6.2 qctl results-contract.
//
// TWO exports, zero I/O (node:crypto only — no fs, no subprocess, no network):
//
//   verifyArtifact({ declaredSha256, bytes }) -> { ok, actualSha256, reason }
//     Compute sha256 over the provided patch bytes and compare against the
//     declared digest.  A sha256-mismatch result means: reject, do NOT git apply.
//     bytes may be a Buffer or a string (treated as UTF-8).
//     reason is null on match; a kebab-case code on any failure.
//
//   parseQctlDigest(raw) -> { task_id, status, files_changed, summary }
//     Extract the IMPL_DIGEST projection from a qctl JOB_RESULT.
//     raw may be a JSON string or an already-parsed object.
//     status is preserved AS-IS from the producer result — no mapping.
//     (Status mapping lives in lib/qctl-status.mjs, per spec §6.2 "kept separate fields".)
//
// Design note: both functions are deliberately fs/clock/randomness-free, mirroring
// lib/routing.mjs.  The shell (L1) owns file I/O; these modules are pure decision logic.

import { createHash } from 'node:crypto';

/**
 * Verify that the sha256 of the provided patch bytes matches the declared digest.
 *
 * @param {object} params
 * @param {string} params.declaredSha256 - The hex sha256 claimed by qctl (from JOB_RESULT).
 * @param {Buffer|string} params.bytes   - The raw patch bytes (read by the shell, passed in).
 * @returns {{ ok: boolean, actualSha256: string|null, reason: string|null }}
 */
export function verifyArtifact({ declaredSha256, bytes } = {}) {
  if (bytes == null || (typeof bytes !== 'string' && !Buffer.isBuffer(bytes))) {
    return { ok: false, actualSha256: null, reason: 'missing-bytes' };
  }
  if (!declaredSha256 || typeof declaredSha256 !== 'string') {
    return { ok: false, actualSha256: null, reason: 'missing-declared-sha256' };
  }

  const actualSha256 = createHash('sha256').update(bytes).digest('hex');

  // Compare case-insensitively: node emits lowercase hex, but a caller might
  // pass an uppercase digest from qctl — we must not false-mismatch on case.
  if (actualSha256.toLowerCase() !== declaredSha256.toLowerCase()) {
    return { ok: false, actualSha256, reason: 'sha256-mismatch' };
  }

  return { ok: true, actualSha256, reason: null };
}

/**
 * Extract the IMPL_DIGEST projection from a raw qctl JOB_RESULT.
 *
 * Pulls exactly { task_id, status, files_changed, summary } — the fields
 * masterplan consumes when recording a qctl task result.  All other JOB_RESULT
 * fields (job_id, idempotency_key, artifact_ref, patch_sha256, base, attempt)
 * are dropped here; they were consumed earlier by the L1 apply/verify loop.
 *
 * status is preserved verbatim from the producer ('accepted'|'review'|'dead-letter').
 * The accepted→done / review→done+flag / dead-letter→failed mapping is the sole
 * responsibility of lib/qctl-status.mjs, not this function (spec §6.2).
 *
 * @param {string|object} raw - A JSON string or already-parsed JOB_RESULT object.
 * @returns {{ task_id: *, status: string|null, files_changed: string[], summary: string }}
 */
export function parseQctlDigest(raw) {
  let obj;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { task_id: null, status: null, files_changed: [], summary: '' };
    }
  } else if (raw != null && typeof raw === 'object') {
    obj = raw;
  } else {
    return { task_id: null, status: null, files_changed: [], summary: '' };
  }

  return {
    task_id:       obj.task_id ?? null,
    status:        obj.status  ?? null,
    files_changed: Array.isArray(obj.files_changed) ? obj.files_changed : [],
    summary:       typeof obj.summary === 'string' ? obj.summary : '',
  };
}
