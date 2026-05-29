// lib/doctor/legacy-bundle.mjs — v8 doctor check (ports v7 #1, legacy plan not migrated).
//
// External surface: <repoRoot>/docs/masterplan/*/state.yml + <repoRoot>/docs/superpowers/.
// Two legacy signals:
//   (a) any bundle with schema_version < 6 (numeric) → WARN (not migrated to v8).
//   (b) docs/superpowers/ directory exists under repoRoot → WARN (unmigrated legacy artifacts).
//
// SKIP only when there are zero run bundles AND docs/superpowers/ does not exist. When there
// are no bundles but docs/superpowers/ IS present, we still emit a WARN for signal (b).
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

  if (superExists) {
    findings.push({
      id: ID, severity: 'WARN',
      summary: 'docs/superpowers/ exists — unmigrated legacy planning artifacts present',
      fix: 'run `/masterplan import` to migrate legacy artifacts, then remove docs/superpowers/ when done',
    });
  }

  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'no legacy bundles or unmigrated artifacts', fix: null }];
  }
  return findings;
}
