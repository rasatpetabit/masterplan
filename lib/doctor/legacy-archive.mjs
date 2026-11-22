// lib/doctor/legacy-archive.mjs — doctor check: archived bundles that predate v10 have no
// completion class and are therefore not complete. Collapse clean pre-v10 legacy archives into
// one summary PASS finding naming the count and slugs; keep individual WARN findings for
// unreadable state.yml. Exclude active bundles and archived bundles that carry a real
// completion class (complete, merged, incomplete:*).
import { completionClass } from '../bundle.mjs';
import { getBundles } from './_bundles.mjs';

const ID = 'legacy-archive';

export function check(repoRoot, opts = {}) {
  const bundles = getBundles(repoRoot, opts);
  if (!bundles.exists) {
    if (bundles.dirError) {
      return [{
        id: ID, severity: 'WARN',
        summary: `cannot read ${bundles.runsDir}: ${bundles.dirError.message}`,
        fix: null,
      }];
    }
    return [{ id: ID, severity: 'PASS', summary: 'no legacy archives', fix: null }];
  }

  const findings = [];
  const legacySlugs = [];

  for (const { slug, statePath, state, stateError } of bundles.list) {
    if (stateError) {
      findings.push({
        id: ID, severity: 'WARN',
        summary: `unreadable state file ${statePath}: ${stateError.message}`,
        fix: null,
      });
      continue;
    }

    if (state && state.status === 'archived' && completionClass(state) === 'legacy') {
      legacySlugs.push(slug);
    }
  }

  if (legacySlugs.length > 0) {
    findings.push({
      id: ID,
      severity: 'PASS',
      summary: `${legacySlugs.length} legacy archive(s) (pre-v10, no completion class — not complete): ${legacySlugs.join(', ')}`,
      fix: null,
    });
  } else if (findings.length === 0) {
    findings.push({ id: ID, severity: 'PASS', summary: 'no legacy archives', fix: null });
  }

  return findings;
}
