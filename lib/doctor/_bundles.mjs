// lib/doctor/_bundles.mjs — read-only shared bundle snapshot helper for doctor checks.
//
// Leading underscore keeps bin/doctor.mjs (no check() export) and test/doctor.test.mjs's
// on-disk module count check (!f.startsWith('_')) from treating this helper as a check.
//
// Scans <repoRoot>/docs/masterplan/*/state.yml once per doctor invocation when populated
// lazily on opts.bundles by bin/doctor.mjs:runChecks, and falls back to standalone
// scanning when opts.bundles is omitted (e.g., direct unit-test calls to a check module).
import fs from 'node:fs';
import path from 'node:path';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { parseState } from '../bundle.mjs';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

export function loadBundlesSnapshot(repoRoot) {
  const runsDir = resolveRunsDir(repoRoot, {});
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch (err) {
    return Object.freeze({
      runsDir,
      exists: false,
      dirError: err && err.code === 'ENOENT' ? null : err,
      list: Object.freeze([]),
      bySlug: Object.freeze(Object.create(null)),
    });
  }

  const bySlug = Object.create(null);
  const list = [];

  for (const d of entries) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const slug = d.name;
    const artifacts = Object.freeze(bundleArtifacts(repoRoot, slug, {}));
    const statePath = artifacts.state;

    let rawState = null;
    let state = null;
    let stateError = null;
    try {
      rawState = fs.readFileSync(statePath, 'utf8');
      state = deepFreeze(parseState(rawState));
    } catch (err) {
      stateError = err;
    }

    const entry = Object.freeze({
      slug,
      dir: artifacts.dir,
      statePath,
      artifacts,
      rawState,
      state,
      stateError,
    });
    list.push(entry);
    bySlug[slug] = entry;
  }

  return Object.freeze({
    runsDir,
    exists: true,
    dirError: null,
    list: Object.freeze(list),
    bySlug: Object.freeze(bySlug),
  });
}

export function getBundles(repoRoot, opts = {}) {
  if (opts && opts.bundles) return opts.bundles;
  return loadBundlesSnapshot(repoRoot);
}
