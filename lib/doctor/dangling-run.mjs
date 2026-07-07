// Doctor check: dangling-run
//
// Auto-discovered by bin/doctor.mjs (which globs lib/doctor/*.mjs) — there is NO
// registry to edit. Emits a WARN finding for each non-archived dangling run
// bundle across all discovery roots: either past the staleness threshold or a
// stale in-progress bundle still holding an owner-lock. Emits PASS when every
// discovered bundle is healthy, and SKIP when no run bundles are discovered at
// all. The resume command is repo-aware (qualifies with a `cd` when the bundle
// lives under a different canonical discovery root) and shell-quote-escaped so
// paths with spaces, quotes, or shell metacharacters paste safely. ALL
// threshold and staleness arithmetic is delegated to lib/runs.mjs via
// findDanglingRuns — nothing is duplicated here.

import fs from 'node:fs';

import { findDanglingRuns } from '../runs.mjs';

const ID = 'dangling-run';

/**
 * Resolve the dangling-days threshold from explicit opts first, then from argv.
 * Returns `undefined` so findDanglingRuns falls back to its own 7-day default.
 *
 * @param {object} opts
 * @returns {number | undefined}
 */
function resolveDanglingDays(opts) {
  if (Number.isFinite(opts.danglingDays)) return opts.danglingDays;
  if (Number.isFinite(opts.thresholdDays)) return opts.thresholdDays;

  const argv = Array.isArray(opts.argv) ? opts.argv : process.argv;
  for (const entry of argv) {
    if (typeof entry !== 'string') continue;
    const match = entry.match(/^--dangling-days=(\d+(?:\.\d+)?)$/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * POSIX single-quote escaping. The emitted resume command is a shell injection
 * surface, so EVERY interpolated path (both the repo path and the state path)
 * must pass through `shq` before reaching the shell — this makes a path
 * containing spaces, quotes, or shell metacharacters paste-safe.
 *
 * @param {string} s
 * @returns {string}
 */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Canonicalize a path via native realpath so we can compare the current MAIN
 * repo root against each bundle's record.repo. Falls back to the input path on
 * any error.
 *
 * @param {string} p
 * @returns {string}
 */
function canonical(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Synchronous doctor check entry point.
 *
 * @param {string} repoRoot
 * @param {object} [opts={}]
 * @returns {Finding[]}
 */
export function check(repoRoot, opts = {}) {
  const now = opts.now ?? Date.now();
  const thresholdDays = resolveDanglingDays(opts);
  const { dangling, runs } = findDanglingRuns({ repoRoot, now, thresholdDays });

  if (runs.length === 0) {
    return [
      {
        id: ID,
        severity: 'SKIP',
        summary: 'no run bundles discovered across any discovery root',
        fix: null,
      },
    ];
  }

  const mainRoot = canonical(repoRoot);

  /** @type {Finding[]} */
  const findings = [];

  for (const { record, reason } of dangling) {
    const statePath = shq(record.statePath);
    const sameRepo = canonical(record.repo) === mainRoot;
    const resume = sameRepo
      ? `/masterplan execute ${statePath}`
      : `cd ${shq(record.repo)} && /masterplan execute ${statePath}`;

    findings.push({
      id: ID,
      severity: 'WARN',
      summary: `dangling run ${record.slug} (${record.repo}): ${reason}`,
      fix: resume,
    });
  }

  if (findings.length === 0) {
    return [
      {
        id: ID,
        severity: 'PASS',
        summary: `${runs.length} run bundle(s) checked; none dangling`,
        fix: null,
      },
    ];
  }

  return findings;
}
