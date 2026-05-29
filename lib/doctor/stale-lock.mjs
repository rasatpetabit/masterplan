// lib/doctor/stale-lock.mjs — v8 doctor check (ports v7 #42, stale .lock file in bundle).
//
// External surface: <repoRoot>/docs/masterplan/*/.lock (filesystem mtime).
// Plan-scoped: for each bundle dir that contains a .lock file, compares the file's mtime
// against the injected clock (opts.now ?? Date.now()). Age > 3600000 ms (1 hour) → WARN —
// a crashed run may have left a stale lock file and its continued presence will block new
// writers. Fix: confirm no live run is active, then remove the lock file.
//
// SKIP when no run bundles exist. PASS when no stale locks are found.
// opts.now is injectable for deterministic tests (mirrors codex-auth's clock seam).
//
// FIXTURE NOTE: git does NOT preserve mtime, so committed fixtures cannot encode staleness
// via mtime. Tests use fs.utimesSync to force a known mtime after pointing at the fixture.
// The fixture only needs the .lock file to exist.
import fs from 'node:fs';
import path from 'node:path';
import { resolveRunsDir } from '../paths.mjs';

const ID = 'stale-lock';
const ONE_HOUR_MS = 3_600_000;

export function check(repoRoot, opts = {}) {
  const now = opts.now ?? Date.now();
  const runsDir = resolveRunsDir(repoRoot, {});
  let slugs;
  try {
    slugs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }
  if (slugs.length === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }

  const findings = [];
  for (const slug of slugs) {
    const lockPath = path.join(runsDir, slug, '.lock');
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(lockPath).mtimeMs;
    } catch {
      continue; // no .lock file — nothing to check
    }
    const ageMs = now - mtimeMs;
    if (ageMs > ONE_HOUR_MS) {
      const ageMin = Math.floor(ageMs / 60_000);
      findings.push({
        id: ID, severity: 'WARN',
        summary: `bundle ${slug}: stale .lock (age ${ageMin}m) — a crashed run may have left it; remove if no run is active`,
        fix: `remove ${lockPath} after confirming no masterplan run is currently active for this bundle`,
      });
    }
  }

  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'no stale bundle lock files', fix: null }];
  }
  return findings;
}
