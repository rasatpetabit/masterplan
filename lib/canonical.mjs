// lib/canonical.mjs — tiny pure helpers shared by identity-bearing modules.
// Stable canonical JSON serialization (sorted keys) + SHA-256 hex. Kept separate from
// reentry-guard (which is deliberately PURE — no fs/process) and recovery-controller
// (which shells out to git) so both can share one definition of "same object".
import { createHash } from 'node:crypto';

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}
