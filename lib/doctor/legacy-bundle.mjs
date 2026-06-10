// lib/doctor/legacy-bundle.mjs — v8 doctor check (ports v7 #1, legacy plan not migrated).
//
// External surface: <repoRoot>/docs/masterplan/*/state.yml + <repoRoot>/docs/superpowers/.
// Two legacy signals:
//   (a) any bundle with schema_version < 6 (numeric) → WARN (not migrated to v8).
//   (b) docs/superpowers/ directory contains ACTUAL legacy artifacts → WARN (unmigrated).
//       An empty docs/superpowers/, or one holding only README files / empty container
//       subdirs, does NOT warn (resolves to PASS or SKIP as appropriate).
//
// SKIP only when there are zero run bundles AND docs/superpowers/ does not exist. When there
// are no bundles but docs/superpowers/ IS present, we still check for artifacts (signal b).
// Note: parseState is tolerant — a missing or unreadable state.yml is silently skipped (the
// slug dir will produce no finding here, but may be picked up by state-schema).
import fs from 'node:fs';
import path from 'node:path';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { parseState } from '../bundle.mjs';

const ID = 'legacy-bundle';

export function check(repoRoot, opts = {}) {
  const runsDir = resolveRunsDir(repoRoot, {});
  const superpowersDir = path.join(repoRoot, 'docs', 'superpowers');

  let slugs = [];
  try {
    slugs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // runsDir absent — fall through to superpowers check.
  }

  const superExists = (() => {
    try { return fs.statSync(superpowersDir).isDirectory(); } catch { return false; }
  })();

  if (slugs.length === 0 && !superExists) {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles and no docs/superpowers directory', fix: null }];
  }

  // Detect actual legacy artifacts within docs/superpowers/ (not just an empty container dir).
  // Artifact signals: any .md file except README.md (a container dir holding only README
  // pointers is not an unmigrated artifact — per the contract above).
  const hasLegacyArtifacts = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md') && e.name.toLowerCase() !== 'readme.md') return true;
      if (e.isDirectory() && hasLegacyArtifacts(path.join(dir, e.name))) return true;
    }
    return false;
  };

  const findings = [];

  for (const slug of slugs) {
    let state;
    try {
      state = parseState(fs.readFileSync(bundleArtifacts(repoRoot, slug, {}).state, 'utf8'));
    } catch {
      continue;
    }
    const sv = state.schema_version;
    // Normalise: v7 bundles sometimes stored schema_version as a YAML-quoted string ('5.1', "5.0").
    const svNum = typeof sv === 'number' ? sv
      : typeof sv === 'string' ? parseFloat(sv.replace(/^['"]|['"]$/g, ''))
      : NaN;
    if (!Number.isNaN(svNum) && svNum < 6) {
      // Display the raw value for clarity.
      const display = typeof sv === 'string' ? sv : String(sv);
      findings.push({
        id: ID, severity: 'WARN',
        summary: `bundle ${slug}: legacy schema_version ${display} not migrated to v8 (>=6)`,
        fix: 'run `/masterplan import` to migrate this bundle to the v8 flat-state format',
      });
    }
  }

  if (superExists && hasLegacyArtifacts(superpowersDir)) {
    findings.push({
      id: ID, severity: 'WARN',
      summary: 'docs/superpowers/ contains unmigrated legacy planning artifacts',
      fix: 'run `/masterplan import` to migrate legacy artifacts, then remove docs/superpowers/ when done',
    });
  }

  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'no legacy bundles or unmigrated artifacts', fix: null }];
  }
  return findings;
}
