// lib/canonical.mjs — tiny pure helpers shared by identity-bearing modules.
// Stable canonical JSON serialization (sorted keys) + SHA-256 hex. Kept separate from
// reentry-guard (which is deliberately PURE — no fs/process) and recovery-controller
// (which shells out to git) so both can share one definition of "same object".
import { createHash } from 'node:crypto';

/**
 * STRICT stable canonical JSON serialization (sorted keys).
 *
 * Identity/hash callers (context fingerprints, receipt binding, review-event identity
 * comparison) feed this REAL identities, so the output must be a faithful canonical JSON
 * text. Non-JSON values are REJECTED with a TypeError — they must fail closed, never be
 * rendered as colliding ordinary strings:
 *   - BigInt            → throw  (rendering "1n" collided with the literal string "1n")
 *   - circular ref      → throw  (rendering "<circular>" collided with the literal string)
 *   - undefined/fn/symbol → throw  (rendering "undefined" collided with the literal string)
 *   - NaN/±Infinity     → throw  (JSON.stringify silently emits null — a collision)
 *
 * For every well-formed JSON value the output is byte-identical to JSON.stringify with
 * sorted keys, so fingerprints and receipt comparisons are unchanged.
 *
 * Diagnostics over untrusted/invalid data must use diagnosticStringify instead — this
 * function must never receive a value it would reject.
 */
export function stableStringify(value, _seen) {
  const seen = _seen ?? new Set();
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`stableStringify: non-finite number ${value} is not JSON-serializable`);
    }
    return JSON.stringify(value);
  }
  if (t === 'bigint') {
    throw new TypeError(`stableStringify: BigInt ${value}n is not JSON-serializable`);
  }
  if (t !== 'object') {
    throw new TypeError(`stableStringify: ${t} is not JSON-serializable`);
  }
  if (seen.has(value)) {
    throw new TypeError('stableStringify: circular reference is not JSON-serializable');
  }
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = `[${value.map((v) => stableStringify(v, seen)).join(',')}]`;
  } else {
    out = `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], seen)}`)
      .join(',')}}`;
  }
  seen.delete(value);
  return out;
}

/**
 * NONTHROWING diagnostic serialization — for human-readable error messages ONLY.
 *
 * Unlike stableStringify, this never throws and is never used for identity/hash
 * comparisons. Invalid/circular/getter-throwing data is rendered with clearly-marked
 * placeholders so an error message can show what was actually seen without crashing the
 * guard. A throwing getter is contained to that one property; the rest of the object
 * still renders. Valid JSON renders byte-identical to stableStringify (sorted keys).
 */
export function diagnosticStringify(value) {
  try {
    return renderDiagnostic(value, new Set());
  } catch (err) {
    return `"<diagnostic error: ${String(err?.message ?? err)}>"`;
  }
}

function renderDiagnostic(value, seen) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return JSON.stringify(value);
  if (t === 'number') {
    if (Number.isNaN(value)) return '"<NaN>"';
    if (value === Infinity) return '"<Infinity>"';
    if (value === -Infinity) return '"<-Infinity>"';
    return JSON.stringify(value);
  }
  if (t === 'bigint') return `"<BigInt ${value}n>"`;
  if (t === 'undefined') return '"<undefined>"';
  if (t === 'function') return '"<function>"';
  if (t === 'symbol') return '"<symbol>"';
  if (seen.has(value)) return '"<circular>"';
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = `[${value.map((v) => renderDiagnostic(v, seen)).join(',')}]`;
  } else {
    out = `{${Object.keys(value)
      .sort()
      .map((k) => {
        let rendered;
        try {
          rendered = renderDiagnostic(value[k], seen);
        } catch (err) {
          rendered = `"<getter threw: ${String(err?.message ?? err)}>"`;
        }
        return `${JSON.stringify(k)}:${rendered}`;
      })
      .join(',')}}`;
  }
  seen.delete(value);
  return out;
}

export function sha256hex(data) {
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    return createHash('sha256').update(data).digest('hex');
  }
  return createHash('sha256').update(String(data), 'utf8').digest('hex');
}
