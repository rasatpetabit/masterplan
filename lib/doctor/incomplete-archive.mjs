import { completionClass } from '../bundle.mjs';
import { getBundles } from './_bundles.mjs';

const ID = 'incomplete-archive';

export function check(repoRoot, opts = {}) {
  const bundles = getBundles(repoRoot, opts);
  if (!bundles.exists) {
    if (bundles.dirError) {
      return [{ id: ID, severity: 'WARN', summary: `cannot read ${bundles.runsDir}: ${bundles.dirError.message}`, fix: null }];
    }
    return [{ id: ID, severity: 'PASS', summary: 'no incomplete or merged archives', fix: null }];
  }
  const findings = [];
  for (const { slug, statePath, state, stateError } of bundles.list) {
    if (stateError) {
      findings.push({ id: ID, severity: 'WARN', summary: `unreadable state file ${statePath}`, fix: null });
      continue;
    }
    if (state.status !== 'archived') continue;
    const cls = completionClass(state);
    if (cls === 'merged' || cls.startsWith('incomplete:')) {
      findings.push({ id: ID, severity: 'PASS', summary: `${slug}: archived as ${cls}`, fix: null });
    }
  }
  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'no incomplete or merged archives', fix: null }];
  }
  return findings;
}
