// lib/migration-snapshot.mjs — the pre-migration snapshot both migration writers share.
//
// A tool keeps the snapshots it takes before a mutation in a directory it owns, never beside
// the original (/srv/workflows/policy/changes.md § "Backup copies"). masterplan's store is
// ~/.local/state/masterplan/rollback/<key>: one slot per state file, holding the newest KEEP
// copies of it as state.yml.v<version>.<UTC stamp>-<uuid>. Legacy sibling copies remain
// available at their old paths; neither capture nor prune touches them.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP = 3;
// <version> is what detectSchemaVersion read ('5.0') or 'unknown'. The stamp is ISO-8601 UTC
// without separators, so its code-unit order is chronological; the uuid keeps names unique.
const SNAPSHOT_NAME = /^state\.yml\.v(?:\d+(?:\.\d+)?|unknown)\.(\d{8}T\d{6}\.\d{3}Z)-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;

// Resolve the existing ancestors without creating an in-bundle directory through a symlink.
function resolveMissingTail(dir) {
  try {
    return fs.realpathSync(dir);
  } catch (error) {
    const parent = path.dirname(dir);
    if (error.code !== 'ENOENT' || parent === dir) throw error;
    return path.join(resolveMissingTail(parent), path.basename(dir));
  }
}

// Snapshot <statePath> before it is migrated, prune that state file's slot, and return the
// snapshot path for the caller's recovery message. The store is derived here from the state
// path and the home directory: callers pass nothing else, and nothing overrides it.
//
// A capture that cannot be taken throws, so the caller must not go on to rewrite the state
// file. Failures after the capture — listing, ordering, unlinking — only warn.
export function snapshotBeforeMigration(statePath, version) {
  let dir;
  let name;
  let snapshot;
  try {
    const source = path.resolve(statePath);
    // Key the slot by the bundle's real directory and the state file's own name, not the
    // slug: slugs repeat across repositories. The directory is resolved, never the file,
    // which the state writer replaces.
    const bundleDir = fs.realpathSync(path.dirname(source));
    const outsideBundle = (candidate) => {
      const rel = path.relative(bundleDir, candidate);
      if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
        throw new Error(`snapshot directory is inside the bundle directory: ${candidate}`);
      }
      return candidate;
    };
    const key = createHash('sha256').update(path.join(bundleDir, path.basename(source))).digest('hex');
    const home = outsideBundle(fs.realpathSync(os.homedir()));
    const store = path.join(home, '.local', 'state', 'masterplan', 'rollback', key);
    outsideBundle(resolveMissingTail(store));
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
    dir = outsideBundle(fs.realpathSync(store));
    const stamp = new Date().toISOString().replace(/[-:]/g, '');
    name = `state.yml.v${version ?? 'unknown'}.${stamp}-${randomUUID()}`;
    if (!SNAPSHOT_NAME.test(name)) throw new Error(`cannot name a snapshot for version '${version}'`);
    snapshot = path.join(dir, name);
    fs.copyFileSync(source, snapshot, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    throw new Error(`could not snapshot ${statePath} before migration: ${error.message}`, { cause: error });
  }

  // Keep this capture and the newest KEEP-1 others. Without a trustworthy order nothing is
  // deleted: a listing or ordering failure is reported and the slot stays as it is.
  let excess;
  try {
    const stampOf = (entry) => SNAPSHOT_NAME.exec(entry)[1];
    excess = fs.readdirSync(dir)
      .filter(entry => entry !== name && SNAPSHOT_NAME.test(entry))
      .sort((a, b) => (stampOf(a) < stampOf(b) ? -1 : stampOf(a) > stampOf(b) ? 1 : a < b ? -1 : a > b ? 1 : 0))
      .slice(0, -(KEEP - 1));
  } catch (error) {
    process.stderr.write(`masterplan: warning: could not list or order snapshots to prune in ${dir}: ${error.message}\n`);
    return snapshot;
  }
  for (const entry of excess) {
    const stale = path.join(dir, entry);
    try {
      fs.unlinkSync(stale);
    } catch (error) {
      process.stderr.write(`masterplan: warning: could not prune snapshot ${stale}: ${error.message}\n`);
    }
  }
  return snapshot;
}
