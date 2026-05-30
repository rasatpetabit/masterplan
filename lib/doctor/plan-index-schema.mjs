// lib/doctor/plan-index-schema.mjs — v8 doctor check (parallel-planning schema guard).
//
// External surface: <repoRoot>/docs/masterplan/*/plan.index.json.
// For each bundle that has a plan.index.json, runs the SAME strict validator the merge path
// uses (lib/plan-merge.validatePlanIndex) and surfaces every violation. This catches the two
// anomalies the feature was built to design out — a non-string `codex` (object/boolean) that
// silently falls through routing's heuristic, and same-wave file overlap from a hand edit or a
// re-waved index — even in bundles that were authored before / outside the deterministic merge.
//
// Auto-discovered by bin/doctor.mjs (any lib/doctor/*.mjs exporting check); no doctor edit needed.
// SKIP when no bundle has a plan.index.json. PASS when every index validates clean.
import fs from 'node:fs';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { validatePlanIndex } from '../plan-merge.mjs';

const ID = 'plan-index-schema';

export function check(repoRoot, opts = {}) {
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

  let anyIndex = false;
  const findings = [];

  for (const slug of slugs) {
    const artifacts = bundleArtifacts(repoRoot, slug, {});
    if (!fs.existsSync(artifacts.planIndex)) continue;

    let index;
    try {
      index = JSON.parse(fs.readFileSync(artifacts.planIndex, 'utf8'));
    } catch (e) {
      findings.push({
        id: ID, severity: 'WARN',
        summary: `bundle ${slug}: plan.index.json is not valid JSON (${String(e?.message ?? e)})`,
        fix: 'regenerate the plan index (merge-plan-fragments) or repair the JSON',
      });
      continue;
    }

    // Only the canonical schema (≥6.0) carries the integer-id / string-codex contract this
    // validator enforces. Pre-6 indexes use the legacy idx/parallel_group/boolean-codex shape
    // that applyPlanIndex bridges at read time — migrate's concern, not a schema violation here
    // (mirrors loadForWrite's `major < 6` guard and index-staleness's skip-when-not-indexed stance).
    const major = Number(String(index?.schema_version ?? '').split('.')[0]);
    if (!Number.isInteger(major) || major < 6) continue;

    anyIndex = true; // count only canonical indexes toward PASS/SKIP

    for (const err of validatePlanIndex(index)) {
      findings.push({
        id: ID, severity: 'WARN',
        summary: `bundle ${slug}: ${err}`,
        fix: 'regenerate via `masterplan merge-plan-fragments` (deterministic) or fix the offending field — a non-string codex / non-integer wave silently mis-routes',
      });
    }
  }

  // Findings first — a malformed-JSON WARN must surface even if no *canonical* index was seen.
  if (findings.length > 0) return findings;
  if (!anyIndex) {
    return [{ id: ID, severity: 'SKIP', summary: 'no bundle has a canonical (schema ≥6) plan.index.json', fix: null }];
  }
  return [{ id: ID, severity: 'PASS', summary: 'all plan.index.json validate (schema + same-wave disjointness)', fix: null }];
}
