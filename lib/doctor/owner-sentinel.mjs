// lib/doctor/owner-sentinel.mjs — Guard D doctor check: stale / corrupt owner locks (and orphan
// heartbeat files) under docs/masterplan/*/.
//
// External surface: <repoRoot>/docs/masterplan/<slug>/.owner.lock + .owner.hb.<host>.<session>.
// The owner sentinel (lib/owner.mjs / lib/owner-fs.mjs) gives two NFS sessions mutual exclusion on a
// bundle. A crashed session can leave its `.owner.lock` behind; a live later session would then be
// BLOCKED until the TTL ages it out. This check surfaces those so an operator can clear them early:
//   - CORRUPT lock  (file present but unparseable)            → WARN, recommend release-owner --force.
//   - STALE  lock   (now − lastHeartbeat > TTL)               → WARN, recommend release-owner --force
//                                                                IF no live session holds it.
//   - ORPHAN hb     (.owner.hb.* with NO .owner.lock present) → WARN, safe to remove (leftover clutter).
// A fresh (within-TTL) lock is healthy and emits nothing. SKIP when no bundles exist; PASS when clean.
//
// opts.now / opts.ttlMs are injectable for deterministic tests (mirrors stale-lock's clock seam). Like
// stale-lock, staleness is mtime/recorded-ts based, so committed fixtures can't encode it — tests force
// the recorded heartbeat ts directly.
import fs from 'node:fs';
import path from 'node:path';
import { resolveRunsDir } from '../paths.mjs';
import { ownerLockPath, parseOwnerLock, OWNER_TTL_DEFAULT_MS } from '../owner.mjs';
import { readIncumbent, readLastHeartbeat } from '../owner-fs.mjs';

const ID = 'owner-sentinel';

export function check(repoRoot, opts = {}) {
  const now = opts.now ?? Date.now();
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : OWNER_TTL_DEFAULT_MS;
  const runsDir = resolveRunsDir(repoRoot, {});
  let slugs;
  try {
    slugs = fs
      .readdirSync(runsDir, { withFileTypes: true })
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
    const bundleDir = path.join(runsDir, slug);
    const lockPath = ownerLockPath(bundleDir);
    let lockText = null;
    try {
      lockText = fs.readFileSync(lockPath, 'utf8');
    } catch {
      lockText = null; // no lock
    }

    if (lockText !== null) {
      const incumbent = parseOwnerLock(lockText);
      if (!incumbent) {
        findings.push({
          id: ID,
          severity: 'WARN',
          summary: `bundle ${slug}: corrupt .owner.lock (unparseable) — blocks new sessions until cleared`,
          fix: `confirm no masterplan session is active for this bundle, then \`mp release-owner --state=${path.join(bundleDir, 'state.yml')} --force\``,
        });
      } else {
        const last = readLastHeartbeat(bundleDir, incumbent, fs);
        const ref = Number.isFinite(last) ? last : incumbent.acquiredAt;
        const ageMs = now - ref;
        if (ageMs > ttlMs) {
          const ageMin = Math.floor(ageMs / 60_000);
          findings.push({
            id: ID,
            severity: 'WARN',
            summary: `bundle ${slug}: stale .owner.lock (age ${ageMin}m > TTL) held by ${incumbent.host}/${incumbent.session} — a crashed session may have left it`,
            fix: `if no session is running on ${incumbent.host}, \`mp release-owner --state=${path.join(bundleDir, 'state.yml')} --force\` to free the bundle`,
          });
        }
      }
    } else {
      // No lock — flag any leftover heartbeat files as orphans (cheap clutter from a stolen-from session).
      let orphans = [];
      try {
        orphans = fs.readdirSync(bundleDir).filter((f) => f.startsWith('.owner.hb.'));
      } catch {
        orphans = [];
      }
      if (orphans.length > 0) {
        findings.push({
          id: ID,
          severity: 'WARN',
          summary: `bundle ${slug}: ${orphans.length} orphan heartbeat file(s) with no .owner.lock — leftover clutter`,
          fix: `safe to remove: ${orphans.map((f) => path.join(bundleDir, f)).join(', ')}`,
        });
      }
    }
  }

  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'no stale/corrupt owner locks', fix: null }];
  }
  return findings;
}
