// lib/doctor/spec-assumptions.mjs — v9 doctor check: run-bundle spec.md missing an Assumptions section.
//
// The spec authoring flow (schema_version >= CURRENT_SCHEMA_VERSION) grew a required `## Assumptions`
// section. This check surfaces post-feature bundles whose spec.md omits it, so plan assumptions get
// documented rather than left implicit. It is deliberately VERSION-SCOPED: the WARN only fires for
// bundles stamped at or after this feature's schema version, so legacy/pre-feature bundles pass
// doctor byte-identically (grandfathered). The threshold is sourced from the single shared
// bundle/migrate schema-version constant CURRENT_SCHEMA_VERSION — never a divergent hard-coded
// literal — so it always tracks the version the render/refs migrate edits stamp.
//
// Per-bundle semantics (non-archived, in-scope bundles only):
//   - spec.md present, has `## Assumptions` heading  -> contributes PASS (no finding line)
//   - spec.md present, lacks the heading             -> WARN
//   - spec.md absent                                 -> SKIP (contributes nothing)
// Archived bundles are exempt (their spec is a frozen historical record). Aggregate result:
// any WARN -> WARN findings; else if >=1 in-scope spec.md was inspected -> single PASS; else SKIP.
import fs from 'node:fs';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { parseState, CURRENT_SCHEMA_VERSION } from '../bundle.mjs';

const ID = 'spec-assumptions';
// Match a level-2 `## Assumptions` heading anywhere in the doc (multiline, case-insensitive).
const ASSUMPTIONS_RE = /^##\s+Assumptions/mi;

export function check(repoRoot, opts = {}) {
  const runsDir = resolveRunsDir(repoRoot, {});

  let slugs = [];
  try {
    slugs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles directory', fix: null }];
  }

  const findings = [];
  let inspected = 0; // in-scope, non-archived bundles that had a readable spec.md

  for (const slug of slugs) {
    const art = bundleArtifacts(repoRoot, slug, {});
    let state;
    try {
      state = parseState(fs.readFileSync(art.state, 'utf8'));
    } catch {
      continue; // unreadable state.yml — state-schema owns that signal
    }
    // Version-scope: grandfather anything below the current feature floor.
    const sv = typeof state.schema_version === 'number' ? state.schema_version : NaN;
    if (Number.isNaN(sv) || sv < CURRENT_SCHEMA_VERSION) continue;
    if (state.status === 'archived') continue; // frozen historical spec — exempt

    let spec;
    try {
      spec = fs.readFileSync(art.spec, 'utf8');
    } catch {
      continue; // no spec.md — SKIP this bundle (contributes nothing)
    }
    inspected += 1;
    if (!ASSUMPTIONS_RE.test(spec)) {
      findings.push({
        id: ID, severity: 'WARN',
        summary: `bundle ${slug}: spec.md lacks an '## Assumptions' section`,
        fix: 'add an `## Assumptions` heading to this run bundle\'s spec.md documenting the plan\'s assumptions',
      });
    }
  }

  if (findings.length > 0) return findings;
  if (inspected === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no in-scope bundle spec.md to check', fix: null }];
  }
  return [{ id: ID, severity: 'PASS', summary: `all ${inspected} in-scope bundle spec.md file(s) carry an '## Assumptions' section`, fix: null }];
}
